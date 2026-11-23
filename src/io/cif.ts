/**
 * mmCIF (PDBx) reader.
 *
 * A small, fast CIF 1.1 tokenizer (data blocks, loop_, quoted strings, ;-delimited text fields,
 * '.'/'?' nulls, # comments) feeding a column store that keeps value offsets into the source text,
 * so a 100k-atom _atom_site loop never materializes millions of strings at once.
 *
 * Molecule extraction:
 * - _atom_site (first data block, first model, first altLoc) with auth_* identifiers preferred;
 * - _struct_conf (HELX*) / _struct_sheet_range → atom.ss;
 * - _entry.id → meta.externalId, _struct.title → meta.title;
 * - chemical-component files (_chem_comp_atom / _chem_comp_bond, e.g. RCSB ligand downloads)
 *   are read with ideal coordinates and bond orders.
 */
import type { BondOrder, Molecule, MoleculeMeta } from '../core/types';
import { buildMolecule, type AtomInput, type BondInput } from '../core/molecule';
import { exactElement, normalizeElement } from './elementSymbols';
import { AltLocFilter, applySecondaryStructure, collapseSpaces, pickName, type SsRange } from './common';
import { inferPdbElement, resolveSingleAtomIons } from './pdb';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const enum Tok {
  EOF,
  Value,
  /** '.' — inapplicable */
  Null,
  /** '?' — unknown */
  Unknown,
  Tag,
  Loop,
  Data,
  Save,
  Other,
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

class CifTokenizer {
  pos = 0;
  /** Value start / end offsets (exclusive) of the last token, without quotes / delimiters. */
  start = 0;
  end = 0;
  private readonly len: number;

  constructor(private readonly text: string) {
    this.len = text.length;
  }

  str(): string {
    return this.text.substring(this.start, this.end);
  }

  next(): Tok {
    const t = this.text;
    const len = this.len;
    let p = this.pos;
    for (;;) {
      while (p < len && isWs(t.charCodeAt(p))) p++;
      if (p >= len) {
        this.pos = p;
        return Tok.EOF;
      }
      const c = t.charCodeAt(p);
      if (c === 35 /* # */) {
        while (p < len && t.charCodeAt(p) !== 10 && t.charCodeAt(p) !== 13) p++;
        continue;
      }
      const atLineStart = p === 0 || t.charCodeAt(p - 1) === 10 || t.charCodeAt(p - 1) === 13;
      if (c === 59 /* ; */ && atLineStart) {
        // Text field: runs to the next line that starts with ';'.
        let q = p + 1;
        let close = -1;
        while (q < len) {
          const nl = t.indexOf('\n', q);
          if (nl < 0) break;
          if (t.charCodeAt(nl + 1) === 59) {
            close = nl;
            break;
          }
          q = nl + 1;
        }
        if (close < 0) throw new Error('Invalid mmCIF: a ;-delimited text field is not terminated.');
        this.start = p + 1;
        this.end = close > 0 && t.charCodeAt(close - 1) === 13 ? close - 1 : close;
        this.pos = close + 2;
        return Tok.Value;
      }
      if (c === 39 /* ' */ || c === 34 /* " */) {
        // Quoted string: the quote only closes when followed by whitespace (or EOF).
        let q = p + 1;
        while (q < len) {
          const d = t.charCodeAt(q);
          if (d === c && (q + 1 >= len || isWs(t.charCodeAt(q + 1)))) break;
          if (d === 10 || d === 13) break; // unterminated on this line: tolerate
          q++;
        }
        this.start = p + 1;
        this.end = q;
        this.pos = q < len && t.charCodeAt(q) === c ? q + 1 : q;
        return Tok.Value;
      }
      // Unquoted token.
      let q = p + 1;
      while (q < len && !isWs(t.charCodeAt(q))) q++;
      this.start = p;
      this.end = q;
      this.pos = q;
      if (c === 95 /* _ */) return Tok.Tag;
      const n = q - p;
      if (n === 1) {
        if (c === 46 /* . */) return Tok.Null;
        if (c === 63 /* ? */) return Tok.Unknown;
      }
      if (n >= 5) {
        const head = t.substring(p, p + 5).toLowerCase();
        if (head === 'data_') return Tok.Data;
        if (head === 'loop_' && n === 5) return Tok.Loop;
        if (head === 'save_') return Tok.Save;
        if ((head === 'stop_' && n === 5) || (head === 'globa' && t.substring(p, q).toLowerCase() === 'global_')) return Tok.Other;
      }
      return Tok.Value;
    }
  }
}

// ---------------------------------------------------------------------------
// Column store
// ---------------------------------------------------------------------------

const KIND_VALUE = 0;
const KIND_NULL = 1;

class ValueStore {
  starts = new Int32Array(1024);
  ends = new Int32Array(1024);
  kinds = new Uint8Array(1024);
  length = 0;

  push(start: number, end: number, kind: number): void {
    if (this.length === this.starts.length) {
      const cap = this.length * 2;
      const s = new Int32Array(cap);
      s.set(this.starts);
      const e = new Int32Array(cap);
      e.set(this.ends);
      const k = new Uint8Array(cap);
      k.set(this.kinds);
      this.starts = s;
      this.ends = e;
      this.kinds = k;
    }
    this.starts[this.length] = start;
    this.ends[this.length] = end;
    this.kinds[this.length] = kind;
    this.length++;
  }
}

/** One CIF category (a loop or a set of key–value pairs) of a data block. */
export class CifCategory {
  readonly fieldIndex = new Map<string, number>();
  /** loops: value index = base + row * ncols + col; pairs: value index = pairIndex[col] */
  base = 0;
  pairIndex: number[] | null = null;
  rowCount = 0;

  constructor(
    readonly name: string,
    readonly fields: string[],
    private readonly store: ValueStore,
    private readonly text: string,
  ) {
    fields.forEach((f, i) => this.fieldIndex.set(f, i));
  }

  /** Column index of a field (case-insensitive), or -1. */
  column(field: string): number {
    return this.fieldIndex.get(field.toLowerCase()) ?? -1;
  }

  has(field: string): boolean {
    return this.column(field) >= 0;
  }

  private index(row: number, col: number): number {
    if (col < 0 || row < 0 || row >= this.rowCount) return -1;
    if (this.pairIndex) return this.pairIndex[col] ?? -1;
    return this.base + row * this.fields.length + col;
  }

  /** String value, or null for '.', '?' and missing columns. */
  str(row: number, col: number): string | null {
    const i = this.index(row, col);
    if (i < 0 || this.store.kinds[i] === KIND_NULL) return null;
    return this.text.substring(this.store.starts[i], this.store.ends[i]);
  }

  /** Numeric value, NaN for null / missing / invalid. */
  float(row: number, col: number): number {
    const i = this.index(row, col);
    if (i < 0 || this.store.kinds[i] === KIND_NULL) return NaN;
    return parseFloat(this.text.substring(this.store.starts[i], this.store.ends[i]));
  }

  /** Integer value, NaN for null / missing / invalid. */
  int(row: number, col: number): number {
    const i = this.index(row, col);
    if (i < 0 || this.store.kinds[i] === KIND_NULL) return NaN;
    return parseInt(this.text.substring(this.store.starts[i], this.store.ends[i]), 10);
  }

  /** Convenience: value of a named field in a row. */
  get(row: number, field: string): string | null {
    return this.str(row, this.column(field));
  }
}

export interface CifBlock {
  /** Block name (text after 'data_'). */
  name: string;
  categories: Map<string, CifCategory>;
  category(name: string): CifCategory | undefined;
  /**
   * Look up a column by its full tag in either dialect: '_atom_site.Cartn_x' (DDL2 / mmCIF) and
   * '_atom_site_fract_x' (DDL1 / small-molecule CIF) are both accepted; case-insensitive.
   */
  find(tag: string): { category: CifCategory; column: number } | undefined;
}

function splitTag(tag: string): [string, string] {
  const dot = tag.indexOf('.');
  if (dot < 0) return [tag.slice(1).toLowerCase(), ''];
  return [tag.slice(1, dot).toLowerCase(), tag.slice(dot + 1).toLowerCase()];
}

/** Normalized full tag name used by CifBlock.find: lower case, no leading '_', '.' → '_'. */
function normalizeTag(tag: string): string {
  return tag.replace(/^_/, '').toLowerCase().replace('.', '_');
}

/**
 * Category and field names of a loop. DDL2 tags ('_cat.field') split at the dot; DDL1 tags
 * ('_atom_site_fract_x', …) use the longest common '_'-delimited prefix as the category.
 */
function loopNames(rawTags: string[]): [string, string[]] {
  const tags = rawTags.map((t) => t.slice(1).toLowerCase());
  if (tags.every((t) => t.includes('.'))) {
    return [tags[0].slice(0, tags[0].indexOf('.')), tags.map((t) => t.slice(t.indexOf('.') + 1))];
  }
  let prefix = tags[0];
  for (const t of tags) {
    let k = 0;
    while (k < prefix.length && k < t.length && prefix[k] === t[k]) k++;
    prefix = prefix.slice(0, k);
  }
  prefix = prefix.slice(0, prefix.lastIndexOf('_') + 1); // cut back to a word boundary
  return [prefix.replace(/_$/, ''), tags.map((t) => t.slice(prefix.length))];
}

function isValueTok(t: Tok): boolean {
  return t === Tok.Value || t === Tok.Null || t === Tok.Unknown;
}

/** Parse the FIRST data block of a CIF file. */
export function parseCif(text: string): CifBlock {
  const tk = new CifTokenizer(text);
  const store = new ValueStore();
  const categories = new Map<string, CifCategory>();
  let blockName = '';
  let seenBlock = false;

  let t = tk.next();
  while (t !== Tok.EOF) {
    if (t === Tok.Data) {
      if (seenBlock) break;
      seenBlock = true;
      blockName = tk.str().slice(5);
      t = tk.next();
      continue;
    }
    if (t === Tok.Loop) {
      const rawTags: string[] = [];
      t = tk.next();
      while (t === Tok.Tag) {
        rawTags.push(tk.str());
        t = tk.next();
      }
      const [cat, fields] = rawTags.length ? loopNames(rawTags) : ['', []];
      const base = store.length;
      while (isValueTok(t)) {
        store.push(tk.start, tk.end, t === Tok.Value ? KIND_VALUE : KIND_NULL);
        t = tk.next();
      }
      if (fields.length) {
        const category = new CifCategory(cat, fields, store, text);
        category.base = base;
        category.rowCount = Math.floor((store.length - base) / fields.length);
        categories.set(cat, category);
      }
      continue;
    }
    if (t === Tok.Tag) {
      const [c, f] = splitTag(tk.str());
      t = tk.next();
      if (!isValueTok(t)) continue; // tag without value: ignore
      let category = categories.get(c);
      if (!category || !category.pairIndex) {
        category = new CifCategory(c, [], store, text);
        category.pairIndex = [];
        category.rowCount = 1;
        categories.set(c, category);
      }
      if (!category.fieldIndex.has(f)) {
        category.fieldIndex.set(f, category.fields.length);
        category.fields.push(f);
        category.pairIndex!.push(store.length);
      } else {
        category.pairIndex![category.fieldIndex.get(f)!] = store.length;
      }
      store.push(tk.start, tk.end, t === Tok.Value ? KIND_VALUE : KIND_NULL);
      t = tk.next();
      continue;
    }
    t = tk.next(); // stray values, save frames, stop_/global_
  }

  const index = new Map<string, { category: CifCategory; column: number }>();
  for (const [name, category] of categories) {
    category.fields.forEach((f, column) => {
      const key = f ? `${name}_${f}` : name;
      if (!index.has(key)) index.set(key, { category, column });
    });
  }
  return {
    name: blockName,
    categories,
    category: (n: string) => categories.get(n.toLowerCase()),
    find: (tag: string) => index.get(normalizeTag(tag)),
  };
}

// ---------------------------------------------------------------------------
// Molecule extraction
// ---------------------------------------------------------------------------

/** Element of a type symbol, or undefined when it is missing / unreadable. */
function elementFromType(typeSymbol: string | null): string | undefined {
  if (!typeSymbol) return undefined;
  const e = exactElement(typeSymbol) ?? normalizeElement(typeSymbol);
  return e !== 'X' ? e : undefined;
}

function elementFrom(typeSymbol: string | null, atomName: string, resName: string, hetero: boolean): string {
  return elementFromType(typeSymbol) ?? inferPdbElement(atomName, resName, hetero);
}

/** Parse mmCIF text into a raw molecule. */
export function parseCifMolecule(text: string, name?: string): Molecule {
  const block = parseCif(text);
  const site = block.find('_atom_site.Cartn_x')?.category;
  if (!site || site.rowCount === 0) {
    if (block.find('_atom_site_fract_x')) return parseCrystalCif(block, name);
    if (block.category('chem_comp_atom')) return parseChemComp(block, name);
    if (!block.categories.size) throw new Error('This does not look like an mmCIF file (no data block found).');
    throw new Error('No atom coordinates (_atom_site) found in this mmCIF file.');
  }

  const col = (f: string) => site.column(f);
  const cX = col('cartn_x'), cY = col('cartn_y'), cZ = col('cartn_z');
  if (cX < 0 || cY < 0 || cZ < 0) throw new Error('This mmCIF file has no Cartesian coordinates (_atom_site.Cartn_x/y/z).');
  const cGroup = col('group_pdb');
  const cId = col('id');
  const cType = col('type_symbol');
  const cAuthAtom = col('auth_atom_id'), cLabelAtom = col('label_atom_id');
  const cAuthComp = col('auth_comp_id'), cLabelComp = col('label_comp_id');
  const cAuthAsym = col('auth_asym_id'), cLabelAsym = col('label_asym_id');
  const cAuthSeq = col('auth_seq_id'), cLabelSeq = col('label_seq_id');
  const cIns = col('pdbx_pdb_ins_code');
  const cAlt = col('label_alt_id');
  const cOcc = col('occupancy');
  const cB = col('b_iso_or_equiv');
  const cCharge = col('pdbx_formal_charge');
  const cModel = col('pdbx_pdb_model_num');

  const atoms: AtomInput[] = [];
  /** 1 = element inferred from the atom name (no type symbol). */
  const inferred: number[] = [];
  const altFilter = new AltLocFilter();
  const firstModel = cModel >= 0 ? site.str(0, cModel) : null;

  for (let r = 0; r < site.rowCount; r++) {
    if (cModel >= 0 && site.str(r, cModel) !== firstModel) continue;
    const atomName = site.str(r, cAuthAtom) ?? site.str(r, cLabelAtom) ?? '';
    const resName = site.str(r, cAuthComp) ?? site.str(r, cLabelComp) ?? '';
    const chain = site.str(r, cAuthAsym) ?? site.str(r, cLabelAsym) ?? '';
    let resSeq = site.int(r, cAuthSeq);
    if (!Number.isFinite(resSeq)) resSeq = site.int(r, cLabelSeq);
    const iCode = site.str(r, cIns) ?? '';
    const altLoc = site.str(r, cAlt) ?? '';
    if (!altFilter.accept(altLoc, chain, Number.isFinite(resSeq) ? resSeq : undefined, iCode, resName, atomName)) continue;

    const x = site.float(r, cX), y = site.float(r, cY), z = site.float(r, cZ);
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue;
    const hetero = site.str(r, cGroup) === 'HETATM';
    const typeElement = elementFromType(site.str(r, cType));

    const atom: AtomInput = {
      // mmCIF names carry no PDB column: ATOM names are read like column-14 names (one-letter
      // elements unless residue context says otherwise), HETATM names like column-13 ones.
      element: typeElement ?? inferPdbElement(hetero ? atomName : ' ' + atomName, resName, hetero),
      x,
      y,
      z,
      name: atomName,
      resName: resName || undefined,
      resSeq: Number.isFinite(resSeq) ? resSeq : undefined,
      chain: chain || undefined,
      hetero,
    };
    const serial = site.int(r, cId);
    if (Number.isFinite(serial)) atom.serial = serial;
    if (iCode) atom.iCode = iCode;
    if (altLoc) atom.altLoc = altLoc;
    const occ = site.float(r, cOcc);
    if (Number.isFinite(occ)) atom.occupancy = occ;
    const b = site.float(r, cB);
    if (Number.isFinite(b)) atom.bfactor = b;
    const charge = site.int(r, cCharge);
    if (Number.isFinite(charge) && charge !== 0) atom.charge = charge;
    inferred.push(typeElement ? 0 : 1);
    atoms.push(atom);
  }
  resolveSingleAtomIons(atoms, inferred);

  const meta: MoleculeMeta = { format: 'cif' };
  const ranges = secondaryStructureRanges(block);
  if (ranges.length) {
    applySecondaryStructure(atoms, ranges);
    meta.hasSecondaryStructure = true;
  }
  const entryId = block.category('entry')?.get(0, 'id') ?? '';
  const title = collapseSpaces(block.category('struct')?.get(0, 'title') ?? '');
  if (entryId) meta.externalId = entryId;
  if (title) meta.title = title;
  return buildMolecule(pickName('Untitled', name, entryId, block.name), atoms, [], meta);
}

function secondaryStructureRanges(block: CifBlock): SsRange[] {
  const ranges: SsRange[] = [];
  const add = (cat: CifCategory, kind: 'helix' | 'sheet', r: number) => {
    const chain = cat.get(r, 'beg_auth_asym_id') ?? cat.get(r, 'beg_label_asym_id') ?? '';
    let startSeq = cat.int(r, cat.column('beg_auth_seq_id'));
    if (!Number.isFinite(startSeq)) startSeq = cat.int(r, cat.column('beg_label_seq_id'));
    let endSeq = cat.int(r, cat.column('end_auth_seq_id'));
    if (!Number.isFinite(endSeq)) endSeq = cat.int(r, cat.column('end_label_seq_id'));
    if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq)) return;
    ranges.push({
      kind,
      chain,
      startSeq,
      startICode: cat.get(r, 'pdbx_beg_pdb_ins_code') ?? '',
      endSeq,
      endICode: cat.get(r, 'pdbx_end_pdb_ins_code') ?? '',
    });
  };
  const conf = block.category('struct_conf');
  if (conf) {
    for (let r = 0; r < conf.rowCount; r++) {
      const type = (conf.get(r, 'conf_type_id') ?? '').toUpperCase();
      if (type.startsWith('HELX')) add(conf, 'helix', r);
    }
  }
  const sheet = block.category('struct_sheet_range');
  if (sheet) for (let r = 0; r < sheet.rowCount; r++) add(sheet, 'sheet', r);
  return ranges;
}

const CCD_ORDERS: Record<string, BondOrder> = { SING: 1, DOUB: 2, TRIP: 3, AROM: 1.5, DELO: 1.5 };

/** Chemical component dictionary entry (_chem_comp_atom / _chem_comp_bond). */
function parseChemComp(block: CifBlock, name?: string): Molecule {
  const ca = block.category('chem_comp_atom')!;
  const col = (f: string) => ca.column(f);
  const ideal = [col('pdbx_model_cartn_x_ideal'), col('pdbx_model_cartn_y_ideal'), col('pdbx_model_cartn_z_ideal')];
  const model = [col('model_cartn_x'), col('model_cartn_y'), col('model_cartn_z')];
  const cComp = col('comp_id'), cAtom = col('atom_id'), cType = col('type_symbol'), cCharge = col('charge');
  const atoms: AtomInput[] = [];
  const byName = new Map<string, number>();
  for (let r = 0; r < ca.rowCount; r++) {
    let x = ca.float(r, ideal[0]), y = ca.float(r, ideal[1]), z = ca.float(r, ideal[2]);
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
      x = ca.float(r, model[0]);
      y = ca.float(r, model[1]);
      z = ca.float(r, model[2]);
    }
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) continue;
    const atomName = ca.str(r, cAtom) ?? '';
    const resName = ca.str(r, cComp) ?? 'UNL';
    const atom: AtomInput = {
      element: elementFrom(ca.str(r, cType), atomName, resName, true),
      x,
      y,
      z,
      name: atomName,
      resName,
      resSeq: 1,
      hetero: true,
    };
    const charge = ca.int(r, cCharge);
    if (Number.isFinite(charge) && charge !== 0) atom.charge = charge;
    byName.set(atomName, atoms.length);
    atoms.push(atom);
  }
  if (!atoms.length) throw new Error('This chemical component file has no atom coordinates.');
  const bonds: BondInput[] = [];
  const cb = block.category('chem_comp_bond');
  if (cb) {
    for (let r = 0; r < cb.rowCount; r++) {
      const a = byName.get(cb.get(r, 'atom_id_1') ?? '');
      const b = byName.get(cb.get(r, 'atom_id_2') ?? '');
      if (a === undefined || b === undefined) continue;
      bonds.push({ a, b, order: CCD_ORDERS[(cb.get(r, 'value_order') ?? 'SING').toUpperCase()] ?? 1 });
    }
  }
  const comp = block.category('chem_comp');
  const compId = comp?.get(0, 'id') ?? block.name;
  const compName = collapseSpaces(comp?.get(0, 'name') ?? '');
  const meta: MoleculeMeta = { format: 'cif', hasBondOrders: bonds.length > 0 };
  if (compName) meta.title = compName;
  if (compId) meta.externalId = compId;
  return buildMolecule(pickName('Untitled', name, compId), atoms, bonds, meta);
}

// ---------------------------------------------------------------------------
// Small-molecule / inorganic crystal CIF (DDL1: COD, CSD, Materials Project)
// ---------------------------------------------------------------------------

/** Affine symmetry operation on fractional coordinates: x' = R·x + t. */
interface SymOp {
  r: number[][];
  t: number[];
}

/** Parse a symmetry operation such as '-x+1/2, y, -z' or 'x-y,x,z+1/6'. */
export function parseSymOp(text: string): SymOp | null {
  const parts = text.replace(/['"\s]/g, '').toLowerCase().split(',');
  if (parts.length !== 3) return null;
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const t = [0, 0, 0];
  const axis: Record<string, number> = { x: 0, y: 1, z: 2 };
  for (let i = 0; i < 3; i++) {
    const re = /([+-]?)(\d*\.?\d*(?:\/\d+)?)(\*?)([xyz]?)/g;
    let m: RegExpExecArray | null;
    let consumed = 0;
    while ((m = re.exec(parts[i])) && m[0] !== '') {
      consumed += m[0].length;
      const sign = m[1] === '-' ? -1 : 1;
      let num = 1;
      if (m[2]) {
        const [p, q] = m[2].split('/');
        num = parseFloat(p) / (q ? parseFloat(q) : 1);
        if (!Number.isFinite(num)) return null;
      }
      if (m[4]) r[i][axis[m[4]]] += sign * num;
      else if (m[2]) t[i] += sign * num;
    }
    if (consumed !== parts[i].length) return null;
  }
  return { r, t };
}

/** Fractional → Cartesian matrix for cell lengths (Å) and angles (degrees); a along x, b in the xy plane. */
export function cellMatrix(a: number, b: number, c: number, alphaDeg: number, betaDeg: number, gammaDeg: number): number[][] {
  const rad = Math.PI / 180;
  // cos(90°) is not exactly 0 in floating point: snap so orthogonal cells give exact coordinates.
  const cos = (d: number) => (Math.abs(d - 90) < 1e-9 ? 0 : Math.cos(d * rad));
  const ca = cos(alphaDeg), cb = cos(betaDeg), cg = cos(gammaDeg), sg = Math.abs(gammaDeg - 90) < 1e-9 ? 1 : Math.sin(gammaDeg * rad);
  const v = Math.sqrt(Math.max(0, 1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg));
  return [
    [a, b * cg, c * cb],
    [0, b * sg, (c * (ca - cb * cg)) / sg],
    [0, 0, (c * v) / sg],
  ];
}

const MAX_CRYSTAL_ATOMS = 50_000;

/**
 * Crystal structure from fractional coordinates: the asymmetric unit is expanded with the listed
 * symmetry operations into one unit cell. Each symmetry copy of the asymmetric unit is translated as
 * a whole (its centroid into the cell) so molecules stay intact; atoms that coincide with an already
 * placed atom modulo lattice translations (special positions) are dropped, giving the exact cell
 * contents.
 */
function parseCrystalCif(block: CifBlock, name?: string): Molecule {
  const num = (tag: string, fallback: number) => {
    const ref = block.find(tag);
    const v = ref ? ref.category.float(0, ref.column) : NaN;
    return Number.isFinite(v) ? v : fallback;
  };
  const a = num('_cell_length_a', NaN), b = num('_cell_length_b', NaN), c = num('_cell_length_c', NaN);
  if (!(a > 0 && b > 0 && c > 0)) throw new Error('This crystal CIF has fractional coordinates but no unit cell (_cell_length_a/b/c).');
  const m = cellMatrix(a, b, c, num('_cell_angle_alpha', 90), num('_cell_angle_beta', 90), num('_cell_angle_gamma', 90));
  const toCart = (f: number[]): [number, number, number] => [
    m[0][0] * f[0] + m[0][1] * f[1] + m[0][2] * f[2],
    m[1][1] * f[1] + m[1][2] * f[2],
    m[2][2] * f[2],
  ];

  const fx = block.find('_atom_site_fract_x')!;
  const site = fx.category;
  const col = (tag: string) => (block.find(tag)?.category === site ? block.find(tag)!.column : -1);
  const cY = col('_atom_site_fract_y'), cZ = col('_atom_site_fract_z');
  const cLabel = col('_atom_site_label'), cType = col('_atom_site_type_symbol');
  const cOcc = col('_atom_site_occupancy'), cU = col('_atom_site_U_iso_or_equiv'), cB = col('_atom_site_B_iso_or_equiv');

  interface Site { frac: number[]; element: string; label: string; charge?: number; occupancy?: number; bfactor?: number }
  const asym: Site[] = [];
  for (let r = 0; r < site.rowCount; r++) {
    const f = [site.float(r, fx.column), site.float(r, cY), site.float(r, cZ)];
    if (!f.every(Number.isFinite)) continue;
    const label = site.str(r, cLabel) ?? '';
    const type = site.str(r, cType) ?? '';
    const element = normalizeElement(type || label);
    const s: Site = { frac: f, element, label: label || element };
    const q = /(\d*)([+-])$/.exec(type);
    if (q) s.charge = (q[2] === '-' ? -1 : 1) * (q[1] ? parseInt(q[1], 10) : 1);
    const occ = site.float(r, cOcc);
    if (Number.isFinite(occ)) s.occupancy = occ;
    const u = site.float(r, cU);
    const bIso = site.float(r, cB);
    if (Number.isFinite(u)) s.bfactor = 8 * Math.PI * Math.PI * u;
    else if (Number.isFinite(bIso)) s.bfactor = bIso;
    asym.push(s);
  }
  if (!asym.length) throw new Error('No atom coordinates found in this crystal CIF.');

  // Symmetry operations (DDL1 and DDL2 spellings); identity if none are listed.
  const opRef =
    block.find('_space_group_symop_operation_xyz') ?? block.find('_symmetry_equiv_pos_as_xyz') ?? block.find('_space_group_symop.operation_xyz');
  const ops: SymOp[] = [];
  if (opRef) {
    for (let r = 0; r < opRef.category.rowCount; r++) {
      const op = parseSymOp(opRef.category.str(r, opRef.column) ?? '');
      if (op) ops.push(op);
    }
  }
  if (!ops.length || asym.length * ops.length > MAX_CRYSTAL_ATOMS) ops.splice(0, ops.length, { r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] });

  const placed: { frac: number[]; element: string }[] = [];
  const atoms: AtomInput[] = [];
  // Placed atoms are hashed into bins of their fractional coordinates (wrapped into [0, 1)), so the
  // duplicate check only visits neighbouring bins instead of every atom placed so far (high-symmetry
  // cells reach tens of thousands of atoms). A bin is at least as wide as the largest fractional
  // offset a 0.1 Å displacement can cause (row norms of the inverse cell matrix), so any duplicate
  // lies in the same or an adjacent bin (periodically).
  const DUP_TOL = 0.1;
  const inv = [
    [1 / m[0][0], -m[0][1] / (m[0][0] * m[1][1]), (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / (m[0][0] * m[1][1] * m[2][2])],
    [0, 1 / m[1][1], -m[1][2] / (m[1][1] * m[2][2])],
    [0, 0, 1 / m[2][2]],
  ];
  const nBins = inv.map((row) => {
    const reach = DUP_TOL * Math.hypot(row[0], row[1], row[2]);
    return Number.isFinite(reach) && reach > 0 ? Math.max(1, Math.min(256, Math.floor(1 / reach))) : 1;
  });
  const bins = new Map<number, number[]>();
  const binOf = (v: number, axis: number) => {
    const n = nBins[axis];
    const u = v - Math.floor(v);
    return Math.min(n - 1, Math.max(0, Math.floor(u * n)));
  };
  const binKey = (bx: number, by: number, bz: number) => (bx * nBins[1] + by) * nBins[2] + bz;
  const neighbourBins = (b: number, axis: number) => {
    const n = nBins[axis];
    return n >= 3 ? [(b + n - 1) % n, b, (b + 1) % n] : n === 2 ? [0, 1] : [0];
  };
  const isDuplicate = (f: number[], element: string) => {
    const bx = binOf(f[0], 0), by = binOf(f[1], 1), bz = binOf(f[2], 2);
    for (const x0 of neighbourBins(bx, 0)) {
      for (const y0 of neighbourBins(by, 1)) {
        for (const z0 of neighbourBins(bz, 2)) {
          const list = bins.get(binKey(x0, y0, z0));
          if (!list) continue;
          for (const k of list) {
            const p = placed[k];
            if (p.element !== element) continue;
            const d = [f[0] - p.frac[0], f[1] - p.frac[1], f[2] - p.frac[2]].map((x) => x - Math.round(x));
            const [x, y, z] = toCart(d);
            if (x * x + y * y + z * z < DUP_TOL * DUP_TOL) return true; // within 0.1 Å
          }
        }
      }
    }
    return false;
  };
  const addPlaced = (f: number[], element: string) => {
    const key = binKey(binOf(f[0], 0), binOf(f[1], 1), binOf(f[2], 2));
    let list = bins.get(key);
    if (!list) bins.set(key, (list = []));
    list.push(placed.length);
    placed.push({ frac: f, element });
  };
  for (const op of ops) {
    const images = asym.map((s) => [0, 1, 2].map((i) => op.r[i][0] * s.frac[0] + op.r[i][1] * s.frac[1] + op.r[i][2] * s.frac[2] + op.t[i]));
    const centroid = [0, 1, 2].map((i) => images.reduce((acc, f) => acc + f[i], 0) / images.length);
    const shift = centroid.map((v) => -Math.floor(v + 1e-6));
    images.forEach((f, k) => {
      const g = [f[0] + shift[0], f[1] + shift[1], f[2] + shift[2]];
      const s = asym[k];
      if (isDuplicate(g, s.element)) return;
      addPlaced(g, s.element);
      const [x, y, z] = toCart(g);
      const atom: AtomInput = { element: s.element, x, y, z, name: s.label };
      if (s.charge) atom.charge = s.charge;
      if (s.occupancy !== undefined) atom.occupancy = s.occupancy;
      if (s.bfactor !== undefined) atom.bfactor = s.bfactor;
      atoms.push(atom);
    });
  }

  const meta: MoleculeMeta = { format: 'cif' };
  const text = (tag: string) => {
    const ref = block.find(tag);
    return ref ? collapseSpaces(ref.category.str(0, ref.column) ?? '') : '';
  };
  const title = text('_chemical_name_common') || text('_chemical_name_systematic') || text('_chemical_formula_sum') || text('_chemical_formula_structural');
  if (title) meta.title = title;
  const codId = text('_cod_database_code');
  if (codId) meta.externalId = codId;
  const systematic = text('_chemical_name_systematic');
  const molName = pickName('Untitled', name, text('_chemical_name_common'), systematic.length <= 40 ? systematic : '', block.name);
  return buildMolecule(molName, atoms, [], meta);
}
