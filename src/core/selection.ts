/**
 * Selection language (a friendly subset of VMD/PyMOL syntax).
 * OWNER: structure agent. CONTRACT: keep exported names & signatures.
 *
 * Grammar (case-insensitive keywords; values are case-sensitive for chain ids, case-insensitive for
 * element/resname/name):
 *   expr   := term (('and' | 'or' | '&' | '|' | ',') term)*      — precedence: not > and > or; ',' = or
 *   term   := 'not' term | '!' term | '(' expr ')' | primary
 *   primary:
 *     all | none | everything | *
 *     protein | nucleic | water | solvent | ion | ions | ligand | hetero | organic
 *     backbone (protein N CA C O + nucleic P OP1 OP2 O5' C5' C4' C3' O3') | sidechain | hydrogen | heavy
 *     helix | sheet | coil (from atom.ss)
 *     acidic (ASP GLU) | basic (LYS ARG HIS) | polar | hydrophobic | aromatic (PHE TYR TRP HIS) | charged
 *     element <sym>+        e.g. element C N O
 *     name <atomname>+      wildcards: CA, C*, H?   (also 'atomname')
 *     resname <name>+       (also 'resn')
 *     resid <n>+ | resid <a> to <b> | resid <a>-<b>   (also 'resi', 'residue'); negative numbers allowed
 *     chain <id>+
 *     index <i>+ | index <a> to <b>     (0-based atom index)
 *     id <i>+ | id <a> to <b>           (atom ids)
 *     serial <i>+ | serial <a> to <b>
 *     within <dist> of <term>           all atoms within dist Å of the term's atoms (grid accelerated)
 *     same residue as <term> | byres <term>
 *     bonded to <term>
 *     selected / sele                   the current user selection (passed in via context)
 *   Bare word fallback: a word that is not a keyword is matched as resname (e.g. 'HIS', 'HEM'),
 *   then as atom name, then as element symbol. Bare integers → resid.
 *
 * Extensions (also documented in selectionHelp()): exwithin, same chain/fragment as, bychain,
 * bfactor/occupancy/charge/x/y/z comparisons ('bfactor > 50', 'z 0 to 5'), aliases (strand, loop,
 * alpha, waters, ligands, hydrogens, sidechains), ',' continues value lists ('chain A,B'),
 * insertion codes ('resid 52A'), double-quoted values ("O5'").
 */
import type { Molecule, ResidueKind, Topology } from './types';
import { AMINO_ACIDS, ION_NAMES, NUCLEIC_ACIDS, WATER_NAMES, createStructureCache, getTopology, structureKey } from './molecule';
import { SpatialGrid, moleculePositions } from './structure-grid';
import { isElementSymbol, isHydrogen, isMetal } from './structure-chem';
import {
  KEYWORD_DEFS,
  type FlagName,
  type NumberSet,
  type ParseResult,
  type SelNode,
  SelectionSyntaxError,
  TERM_KEYWORDS,
  keywordKind,
  parseSelection,
  suggestKeyword,
  tokenize,
  unknownKeywordMessage,
} from './structure-selparse';

export interface SelectionContext {
  /** Atom ids of the current user selection, for the 'selected' keyword. */
  selectedIds?: ReadonlySet<number>;
}

export interface SelectionResult {
  /** 1 if the atom (by index in mol.atoms) is selected. Length = mol.atoms.length. */
  mask: Uint8Array;
  count: number;
  /** Parse error message (mask is all zeros if set). */
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// Parsing (cached)
// ---------------------------------------------------------------------------------------------

type Parsed = ParseResult | { error: string };
const PARSE_CACHE_SIZE = 256;
const parseCache = new Map<string, Parsed>();

function parseCached(query: string): Parsed {
  const hit = parseCache.get(query);
  if (hit) {
    parseCache.delete(query);
    parseCache.set(query, hit);
    return hit;
  }
  let res: Parsed;
  try {
    res = parseSelection(query);
  } catch (e) {
    if (!(e instanceof SelectionSyntaxError)) throw e;
    res = { error: e.message };
  }
  parseCache.set(query, res);
  if (parseCache.size > PARSE_CACHE_SIZE) parseCache.delete(parseCache.keys().next().value!);
  return res;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

const RESULT_CACHE_SIZE = 64;
/**
 * Cached results per query. Keyed by the molecule's structureKey for queries that do not read
 * coordinates (shared across coordinate-only updates such as drag frames), and by the molecule
 * object itself for coordinate-dependent ones ('within', 'exwithin', x/y/z comparisons).
 */
const resultCache = new WeakMap<object, Map<string, SelectionResult>>();

/**
 * Evaluate a selection query. Empty query or 'all' → everything.
 * Results are cached per (molecule, query) when no context is used; results of queries that do not
 * depend on coordinates are shared by molecules with the same structure (see structureKey).
 * The returned mask is a fresh copy and may be modified by the caller.
 */
export function evaluateSelection(mol: Molecule, query: string, ctx: SelectionContext = {}): SelectionResult {
  const q = query.trim();
  const n = mol.atoms.length;
  if (q === '' || q.toLowerCase() === 'all') return { mask: new Uint8Array(n).fill(1), count: n };

  const parsed = parseCached(q);
  // Parse errors do not depend on the molecule at all (only the mask length does).
  const cacheKey: object = 'error' in parsed || !usesCoordinates(parsed.ast) ? structureKey(mol) : mol;
  let perMol = resultCache.get(cacheKey);
  const hit = perMol?.get(q);
  if (hit) {
    perMol!.delete(q);
    perMol!.set(q, hit);
    return copyResult(hit);
  }

  let result: SelectionResult;
  if ('error' in parsed) result = { mask: new Uint8Array(n), count: 0, error: parsed.error };
  else {
    try {
      const mask = new Evaluator(mol, ctx).eval(parsed.ast);
      result = { mask, count: countMask(mask) };
    } catch (e) {
      if (!(e instanceof SelectionSyntaxError)) throw e;
      result = { mask: new Uint8Array(n), count: 0, error: e.message };
    }
    // Context-dependent results ('selected') are not cached.
    if (parsed.usesSelection) return result;
  }
  if (!perMol) {
    perMol = new Map();
    resultCache.set(cacheKey, perMol);
  }
  perMol.set(q, result);
  if (perMol.size > RESULT_CACHE_SIZE) perMol.delete(perMol.keys().next().value!);
  return copyResult(result);
}

/**
 * True if the result may depend on atom coordinates. Conservative: only node types known to read
 * nothing but structure (atoms' non-coordinate fields, bonds, topology) count as coordinate-free.
 */
function usesCoordinates(node: SelNode): boolean {
  switch (node.t) {
    case 'all':
    case 'none':
    case 'flag':
    case 'values':
    case 'numbers':
    case 'selected':
    case 'bare':
      return false;
    case 'compare':
    case 'propIn':
      return node.field !== 'bfactor' && node.field !== 'occupancy' && node.field !== 'charge';
    case 'not':
    case 'same':
    case 'bonded':
      return usesCoordinates(node.a);
    case 'and':
    case 'or':
      return usesCoordinates(node.a) || usesCoordinates(node.b);
    default:
      return true; // 'within' / 'exwithin', and anything added later
  }
}

function copyResult(r: SelectionResult): SelectionResult {
  return r.error ? { mask: r.mask.slice(), count: r.count, error: r.error } : { mask: r.mask.slice(), count: r.count };
}

function countMask(mask: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < mask.length; i++) c += mask[i];
  return c;
}

/** Validate syntax without evaluating. Returns an error message or null. */
export function validateSelection(query: string): string | null {
  const q = query.trim();
  if (q === '') return null;
  const parsed = parseCached(q);
  if ('error' in parsed) return parsed.error;
  // Without a molecule, a bare word is only reported when it looks like a misspelt keyword and is
  // not a common residue name or element symbol.
  let msg: string | null = null;
  visit(parsed.ast, (node) => {
    if (msg || node.t !== 'bare') return;
    const w = node.word.toUpperCase();
    if (w in AMINO_ACIDS || w in NUCLEIC_ACIDS || WATER_NAMES.has(w) || ION_NAMES.has(w) || isElementSymbol(w)) return;
    const s = suggestKeyword(node.word);
    if (s) msg = unknownKeywordMessage(node.word, s);
  });
  return msg;
}

function visit(node: SelNode, fn: (n: SelNode) => void): void {
  fn(node);
  if ('a' in node) visit(node.a, fn);
  if ('b' in node) visit(node.b, fn);
}

/** Convert a mask to atom ids. */
export function maskToIds(mol: Molecule, mask: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push(mol.atoms[i].id);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-molecule index (cached)
// ---------------------------------------------------------------------------------------------

const KIND_CODE: Record<ResidueKind, number> = { protein: 1, nucleic: 2, water: 3, ion: 4, ligand: 5, other: 6 };
const K_NONE = 0, K_PROTEIN = 1, K_NUCLEIC = 2, K_WATER = 3, K_ION = 4, K_LIGAND = 5, K_OTHER = 6;

const PROTEIN_BACKBONE = new Set(['N', 'CA', 'C', 'O', 'OXT', 'OT1', 'OT2']);
const NUCLEIC_BACKBONE = new Set(['P', 'OP1', 'OP2', 'OP3', 'O1P', 'O2P', 'O3P', "O5'", "C5'", "C4'", "C3'", "O3'"]);
/** Hydrogens on backbone atoms (used when bonds are missing). */
const BACKBONE_H = new Set(['H', 'HN', 'H1', 'H2', 'H3', 'HT1', 'HT2', 'HT3', 'HA', 'HA2', 'HA3', '1HA', '2HA', 'HXT']);

const ONE_LETTER_CLASSES: Partial<Record<FlagName, Set<string>>> = {
  acidic: new Set(['D', 'E']),
  basic: new Set(['K', 'R', 'H']),
  aromatic: new Set(['F', 'Y', 'W', 'H']),
  hydrophobic: new Set(['A', 'V', 'L', 'I', 'M', 'F', 'W', 'P']),
  polar: new Set(['S', 'T', 'N', 'Q', 'C', 'Y', 'D', 'E', 'K', 'R', 'H']),
  charged: new Set(['D', 'E', 'K', 'R', 'H']),
};

/**
 * Structure-only index (never reads coordinates), shared by all molecules with the same structureKey
 * (e.g. every frame of a drag). `mol` is the molecule it was last requested for; any of them gives
 * the same answers since they differ only in coordinates.
 */
class SelIndex {
  readonly n: number;
  readonly topo: Topology;
  /** Residue kind code per atom (K_*). */
  readonly kind: Uint8Array;
  /** Upper-case atom names ('*' primes normalised to "'"). */
  readonly nameU: string[];
  readonly resU: string[];
  readonly elU: string[];
  private readonly flags = new Map<FlagName, Uint8Array>();
  private _fragments: Int32Array | null = null;
  private _resNames: Set<string> | null = null;
  private _atomNames: Set<string> | null = null;
  private _elements: Set<string> | null = null;
  private _chains: Set<string> | null = null;

  constructor(public mol: Molecule) {
    const n = (this.n = mol.atoms.length);
    const topo = (this.topo = getTopology(mol));
    this.kind = new Uint8Array(n);
    this.nameU = new Array(n);
    this.resU = new Array(n);
    this.elU = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = mol.atoms[i];
      const ri = topo.atomResidue[i];
      this.kind[i] = ri >= 0 ? KIND_CODE[topo.residues[ri].kind] : K_NONE;
      this.nameU[i] = (a.name ?? '').toUpperCase().replace(/\*/g, "'");
      this.resU[i] = ri >= 0 ? topo.residues[ri].resName : '';
      this.elU[i] = a.element.toUpperCase();
    }
  }

  get resNames(): Set<string> {
    return (this._resNames ??= new Set(this.topo.residues.map((r) => r.resName)));
  }
  get atomNames(): Set<string> {
    return (this._atomNames ??= new Set(this.nameU.filter((s) => s)));
  }
  get elements(): Set<string> {
    return (this._elements ??= new Set(this.elU));
  }
  get chains(): Set<string> {
    return (this._chains ??= new Set(this.mol.atoms.map((a) => a.chain ?? '')));
  }

  /** Connected component id per atom (via bonds). */
  get fragments(): Int32Array {
    if (this._fragments) return this._fragments;
    const comp = new Int32Array(this.n).fill(-1);
    let c = 0;
    const stack: number[] = [];
    for (let s = 0; s < this.n; s++) {
      if (comp[s] >= 0) continue;
      comp[s] = c;
      stack.push(s);
      while (stack.length) {
        const i = stack.pop()!;
        for (const j of this.topo.neighbors[i]) {
          if (comp[j] < 0) {
            comp[j] = c;
            stack.push(j);
          }
        }
      }
      c++;
    }
    return (this._fragments = comp);
  }

  flag(f: FlagName): Uint8Array {
    let m = this.flags.get(f);
    if (!m) {
      m = this.computeFlag(f);
      this.flags.set(f, m);
    }
    return m;
  }

  private computeFlag(f: FlagName): Uint8Array {
    const { n, kind, mol, topo } = this;
    const out = new Uint8Array(n);
    const atoms = mol.atoms;
    const byKind = (k: number) => {
      for (let i = 0; i < n; i++) if (kind[i] === k) out[i] = 1;
      return out;
    };
    switch (f) {
      case 'protein':
        return byKind(K_PROTEIN);
      case 'nucleic':
        return byKind(K_NUCLEIC);
      case 'water':
        return byKind(K_WATER);
      case 'ligand':
        return byKind(K_LIGAND);
      case 'ion':
        for (let i = 0; i < n; i++) {
          if (kind[i] === K_ION) out[i] = 1;
          // Free-standing metal / halide atoms of residue-less files (XYZ, SDF salts).
          else if (kind[i] === K_NONE && topo.neighbors[i].length === 0) {
            const el = atoms[i].element;
            if (isMetal(el) || el === 'F' || el === 'Cl' || el === 'Br' || el === 'I') out[i] = 1;
          }
        }
        return out;
      case 'hetero':
        for (let i = 0; i < n; i++) if (atoms[i].hetero) out[i] = 1;
        return out;
      case 'organic': {
        // Non-polymer, non-solvent groups (residues, or bonded fragments without residue info) containing carbon.
        const resHasC = new Uint8Array(topo.residues.length);
        const frag = this.fragments;
        const fragHasC = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          if (atoms[i].element !== 'C') continue;
          const ri = topo.atomResidue[i];
          if (ri >= 0) resHasC[ri] = 1;
          else fragHasC[frag[i]] = 1;
        }
        for (let i = 0; i < n; i++) {
          const k = kind[i];
          if (k === K_LIGAND || k === K_OTHER) out[i] = resHasC[topo.atomResidue[i]];
          else if (k === K_NONE) out[i] = fragHasC[frag[i]];
        }
        return out;
      }
      case 'backbone':
        for (let i = 0; i < n; i++) {
          if (kind[i] === K_PROTEIN && PROTEIN_BACKBONE.has(this.nameU[i])) out[i] = 1;
          else if (kind[i] === K_NUCLEIC && NUCLEIC_BACKBONE.has(this.nameU[i])) out[i] = 1;
        }
        return out;
      case 'sidechain': {
        const bb = this.flag('backbone');
        for (let i = 0; i < n; i++) {
          if (kind[i] !== K_PROTEIN || bb[i]) continue;
          if (isHydrogen(atoms[i].element)) {
            const nb = topo.neighbors[i];
            if (nb.length ? nb.some((j) => bb[j]) : BACKBONE_H.has(this.nameU[i])) continue;
          }
          out[i] = 1;
        }
        return out;
      }
      case 'hydrogen':
        for (let i = 0; i < n; i++) if (isHydrogen(atoms[i].element)) out[i] = 1;
        return out;
      case 'heavy':
        for (let i = 0; i < n; i++) if (!isHydrogen(atoms[i].element)) out[i] = 1;
        return out;
      case 'helix':
      case 'sheet':
        for (let i = 0; i < n; i++) if (atoms[i].ss === f) out[i] = 1;
        return out;
      case 'coil':
        for (let i = 0; i < n; i++) if (kind[i] === K_PROTEIN && atoms[i].ss !== 'helix' && atoms[i].ss !== 'sheet') out[i] = 1;
        return out;
      default: {
        const letters = ONE_LETTER_CLASSES[f]!;
        for (let i = 0; i < n; i++) {
          const ri = topo.atomResidue[i];
          if (ri >= 0 && kind[i] === K_PROTEIN && letters.has(topo.residues[ri].oneLetter)) out[i] = 1;
        }
        if (f === 'aromatic') {
          // Atoms of non-polymer molecules that take part in aromatic bonds.
          for (const b of mol.bonds) {
            if (b.order !== 1.5) continue;
            for (const id of [b.a, b.b]) {
              const i = topo.idToIndex.get(id);
              if (i !== undefined && kind[i] !== K_PROTEIN && kind[i] !== K_NUCLEIC) out[i] = 1;
            }
          }
        }
        return out;
      }
    }
  }
}

const indexOfStructure = createStructureCache((mol) => new SelIndex(mol));
function getIndex(mol: Molecule): SelIndex {
  const idx = indexOfStructure(mol);
  // Point at the newest molecule so the index does not keep an old drag frame / snapshot alive.
  idx.mol = mol;
  return idx;
}

/**
 * Opaque identity of the selection index used for `mol` (exposed for tests): equal for molecules
 * that differ only in coordinates, so structural keywords are not re-indexed on every drag frame.
 */
export function selectionIndexIdentity(mol: Molecule): object {
  return indexOfStructure(mol);
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/** Compile a name pattern with * and ? wildcards (input already upper-cased). */
function compilePattern(p: string): (s: string) => boolean {
  if (!/[*?]/.test(p)) return (s) => s === p;
  const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return (s) => re.test(s);
}

function inNumberSet(set: NumberSet, v: number): boolean {
  if (set.values.has(v)) return true;
  for (const [a, b] of set.ranges) if (v >= a && v <= b) return true;
  return false;
}

class Evaluator {
  private readonly idx: SelIndex;
  private readonly n: number;

  constructor(private readonly mol: Molecule, private readonly ctx: SelectionContext) {
    this.idx = getIndex(mol);
    this.n = mol.atoms.length;
  }

  eval(node: SelNode): Uint8Array {
    const n = this.n;
    switch (node.t) {
      case 'all':
        return new Uint8Array(n).fill(1);
      case 'none':
        return new Uint8Array(n);
      case 'not': {
        const a = this.eval(node.a);
        for (let i = 0; i < n; i++) a[i] ^= 1;
        return a;
      }
      case 'and': {
        const a = this.eval(node.a);
        const b = this.eval(node.b);
        for (let i = 0; i < n; i++) a[i] &= b[i];
        return a;
      }
      case 'or': {
        const a = this.eval(node.a);
        const b = this.eval(node.b);
        for (let i = 0; i < n; i++) a[i] |= b[i];
        return a;
      }
      case 'flag':
        return this.idx.flag(node.flag).slice();
      case 'values':
        return this.evalValues(node.field, node.values);
      case 'numbers':
        return this.evalNumbers(node.field, node.set);
      case 'compare':
      case 'propIn':
        return this.evalProp(node);
      case 'within':
        return this.evalWithin(node.dist, node.exclusive, this.eval(node.a));
      case 'same':
        return this.evalSame(node.what, this.eval(node.a));
      case 'bonded': {
        const a = this.eval(node.a);
        const out = new Uint8Array(n);
        const nb = this.idx.topo.neighbors;
        for (let i = 0; i < n; i++) if (a[i]) for (const j of nb[i]) out[j] = 1;
        return out;
      }
      case 'selected': {
        const out = new Uint8Array(n);
        const ids = this.ctx.selectedIds;
        if (ids) {
          const map = this.idx.topo.idToIndex;
          for (const id of ids) {
            const i = map.get(id);
            if (i !== undefined) out[i] = 1;
          }
        }
        return out;
      }
      case 'bare':
        return this.evalBare(node.word);
    }
  }

  private evalValues(field: 'element' | 'name' | 'resname' | 'chain', values: string[]): Uint8Array {
    const n = this.n;
    const out = new Uint8Array(n);
    const idx = this.idx;
    if (field === 'chain') {
      // Exact (case-sensitive) ids; fall back to case-insensitive when the exact id is absent.
      const wanted = new Set<string>();
      for (const v of values) {
        if (idx.chains.has(v)) wanted.add(v);
        else for (const c of idx.chains) if (c.toLowerCase() === v.toLowerCase()) wanted.add(c);
      }
      for (let i = 0; i < n; i++) if (wanted.has(this.mol.atoms[i].chain ?? '')) out[i] = 1;
      return out;
    }
    if (field === 'element') {
      const wanted = new Set<string>();
      for (const v of values) {
        const u = v.toUpperCase();
        if (!isElementSymbol(u) && u !== 'X' && u !== 'D') throw new SelectionSyntaxError(`Unknown element '${v}' after 'element'`);
        wanted.add(u);
      }
      for (let i = 0; i < n; i++) if (wanted.has(idx.elU[i])) out[i] = 1;
      return out;
    }
    const arr = field === 'name' ? idx.nameU : idx.resU;
    const pats = values.map((v) => compilePattern(v.toUpperCase()));
    // Evaluate each distinct name once.
    const memo = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const s = arr[i];
      let hit = memo.get(s);
      if (hit === undefined) {
        hit = s !== '' && pats.some((p) => p(s)) ? 1 : 0;
        memo.set(s, hit);
      }
      out[i] = hit;
    }
    return out;
  }

  private evalNumbers(field: 'resid' | 'index' | 'id' | 'serial', set: NumberSet): Uint8Array {
    const n = this.n;
    const out = new Uint8Array(n);
    const { topo } = this.idx;
    const atoms = this.mol.atoms;
    switch (field) {
      case 'index':
        for (const v of set.values) if (v >= 0 && v < n) out[v] = 1;
        for (const [a, b] of set.ranges) for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) out[i] = 1;
        return out;
      case 'id': {
        const map = topo.idToIndex;
        for (const v of set.values) {
          const i = map.get(v);
          if (i !== undefined) out[i] = 1;
        }
        for (const [a, b] of set.ranges) {
          if (b - a < n) {
            for (let v = a; v <= b; v++) {
              const i = map.get(v);
              if (i !== undefined) out[i] = 1;
            }
          } else for (let i = 0; i < n; i++) if (atoms[i].id >= a && atoms[i].id <= b) out[i] = 1;
        }
        return out;
      }
      case 'serial':
        for (let i = 0; i < n; i++) {
          const s = atoms[i].serial;
          if (s !== undefined && inNumberSet(set, s)) out[i] = 1;
        }
        return out;
      case 'resid': {
        for (const res of topo.residues) {
          const hit =
            inNumberSet(set, res.resSeq) || (res.iCode !== '' && set.withICode.has(`${res.resSeq}${res.iCode.toUpperCase()}`));
          if (hit) for (const i of res.atomIndices) out[i] = 1;
        }
        return out;
      }
    }
  }

  private evalProp(node: Extract<SelNode, { t: 'compare' | 'propIn' }>): Uint8Array {
    const n = this.n;
    const out = new Uint8Array(n);
    const atoms = this.mol.atoms;
    const get = (i: number): number => {
      const a = atoms[i];
      switch (node.field) {
        case 'bfactor':
          return a.bfactor ?? NaN;
        case 'occupancy':
          return a.occupancy ?? NaN;
        case 'charge':
          return a.charge ?? 0;
        case 'x':
          return a.x;
        case 'y':
          return a.y;
        case 'z':
          return a.z;
      }
    };
    if (node.t === 'compare') {
      const v = node.value;
      const test =
        node.op === '<' ? (x: number) => x < v
        : node.op === '<=' ? (x: number) => x <= v
        : node.op === '>' ? (x: number) => x > v
        : node.op === '>=' ? (x: number) => x >= v
        : node.op === '==' ? (x: number) => Math.abs(x - v) < 1e-6
        : (x: number) => !Number.isNaN(x) && Math.abs(x - v) >= 1e-6;
      for (let i = 0; i < n; i++) if (test(get(i))) out[i] = 1;
      return out;
    }
    for (let i = 0; i < n; i++) {
      const x = get(i);
      if (Number.isNaN(x)) continue;
      if (node.values.some((v) => Math.abs(x - v) < 1e-6) || node.ranges.some(([a, b]) => x >= a - 1e-9 && x <= b + 1e-9)) out[i] = 1;
    }
    return out;
  }

  private evalWithin(dist: number, exclusive: boolean, target: Uint8Array): Uint8Array {
    const n = this.n;
    const out = new Uint8Array(n);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) if (target[i]) ids.push(i);
    if (ids.length === 0) return out;
    const pos = moleculePositions(this.mol);
    const grid = new SpatialGrid(pos, Math.max(dist, 1), ids);
    for (let i = 0; i < n; i++) {
      if (target[i]) out[i] = exclusive ? 0 : 1;
      else if (grid.anyWithin(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], dist)) out[i] = 1;
    }
    return out;
  }

  private evalSame(what: 'residue' | 'chain' | 'fragment', target: Uint8Array): Uint8Array {
    const n = this.n;
    const out = new Uint8Array(n);
    const { topo } = this.idx;
    if (what === 'chain') {
      const chains = new Set<string>();
      for (let i = 0; i < n; i++) if (target[i]) chains.add(this.mol.atoms[i].chain ?? '');
      for (let i = 0; i < n; i++) if (chains.has(this.mol.atoms[i].chain ?? '')) out[i] = 1;
      return out;
    }
    // Residue: atoms without residue information fall back to their bonded fragment.
    const frag = this.idx.fragments;
    const resHit = new Uint8Array(topo.residues.length);
    const fragHit = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!target[i]) continue;
      const ri = topo.atomResidue[i];
      if (what === 'residue' && ri >= 0) resHit[ri] = 1;
      else fragHit[frag[i]] = 1;
    }
    for (let i = 0; i < n; i++) {
      const ri = topo.atomResidue[i];
      if (what === 'residue' && ri >= 0) out[i] = resHit[ri];
      else out[i] = fragHit[frag[i]];
    }
    return out;
  }

  /** Bare word: residue name, then atom name, then element symbol. */
  private evalBare(word: string): Uint8Array {
    const n = this.n;
    const idx = this.idx;
    const u = word.toUpperCase();
    const match = compilePattern(u);
    const anyIn = (set: Set<string>) => {
      for (const s of set) if (s !== '' && match(s)) return true;
      return false;
    };
    if (anyIn(idx.resNames)) return this.evalValues('resname', [word]);
    if (anyIn(idx.atomNames)) return this.evalValues('name', [word]);
    if (idx.elements.has(u)) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (idx.elU[i] === u) out[i] = 1;
      return out;
    }
    const s = suggestKeyword(word);
    if (s) throw new SelectionSyntaxError(unknownKeywordMessage(word, s));
    return new Uint8Array(n);
  }
}

// ---------------------------------------------------------------------------------------------
// Autocomplete, help, quick chips
// ---------------------------------------------------------------------------------------------

const MAX_SUGGESTIONS = 12;

/** Keywords offered first when the user starts a term (most useful first). */
const COMMON_TERMS = [
  'protein', 'ligand', 'water', 'ion', 'nucleic', 'backbone', 'sidechain', 'chain', 'resname', 'resid', 'name',
  'element', 'within', 'same', 'byres', 'not', 'hydrogen', 'heavy', 'helix', 'sheet', 'coil', 'hetero', 'organic',
  'acidic', 'basic', 'polar', 'hydrophobic', 'aromatic', 'charged', 'bonded', 'selected', 'all', 'none', 'index', 'id',
  'serial', 'bfactor', 'occupancy', 'charge', 'exwithin', 'bychain',
];

/**
 * Quote a value for use in a query (e.g. `chain ${quoteSelectionValue(id)}`) when it would not
 * survive tokenisation as a plain value word.
 */
export function quoteSelectionValue(v: string): string {
  const plain = /^[^\s()&|,!<>="]+$/.test(v) && (!keywordKind(v) || /^[xyz]$/i.test(v));
  return plain ? v : `"${v.replace(/"/g, '')}"`;
}
const quoteValue = quoteSelectionValue;

function rankByCount<T extends string>(values: Iterable<T>): T[] {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((e) => e[0]);
}

/**
 * Autocomplete: suggestions for the last token of a partial query, using molecule content (chains, resnames, elements).
 * Returns replacement strings for the trailing (possibly empty) word of `partial`, best first.
 */
export function selectionSuggestions(mol: Molecule | null, partial: string): string[] {
  // Split off the trailing partial word.
  let cut = partial.length;
  while (cut > 0 && !/[\s()&|,!<>="]/.test(partial[cut - 1])) cut--;
  const prefix = partial.slice(cut);
  const pl = prefix.toLowerCase();
  let toks: ReturnType<typeof tokenize>;
  try {
    toks = tokenize(partial.slice(0, cut)).filter((t) => t.type !== 'end');
  } catch {
    return [];
  }
  const last = toks[toks.length - 1];
  const lastWord = last && last.type === 'word' ? last.text.toLowerCase() : '';
  const prevWord = toks.length > 1 && toks[toks.length - 2].type === 'word' ? toks[toks.length - 2].text.toLowerCase() : '';
  const startsWith = (s: string) => s.toLowerCase().startsWith(pl) && s.toLowerCase() !== pl;
  const finish = (list: string[]) => [...new Set(list)].filter(startsWith).slice(0, MAX_SUGGESTIONS);

  // Fixed follow-ups.
  if (lastWord === 'within' || lastWord === 'exwithin') return finish(['3', '4', '5', '6', '8', '10']);
  if ((prevWord === 'within' || prevWord === 'exwithin') && last && /^[\d.]+$/.test(last.text)) return finish(['of']);
  if (lastWord === 'same') return finish(['residue', 'chain', 'fragment']);
  if (prevWord === 'same' && ['residue', 'chain', 'fragment'].includes(lastWord)) return finish(['as']);
  if (lastWord === 'bonded') return finish(['to']);
  // A number follows a range's 'to' or a comparison operator.
  if ((lastWord === 'to' && prevWord !== 'bonded') || last?.type === 'cmp') return [];
  if (lastWord && keywordKind(lastWord)?.k === 'prop') return ['>', '<', '>=', '<=', '==', '!='];

  // Inside a value list? Walk back over plain words to the keyword that opened it.
  let field: string | null = null;
  const typed = new Set<string>();
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.type === 'comma') continue;
    if (t.type !== 'word' && t.type !== 'string') break;
    const kind = keywordKind(t.text);
    if (kind && t.text.toLowerCase() !== 'x' && t.text.toLowerCase() !== 'y' && t.text.toLowerCase() !== 'z') {
      if (kind.k === 'values' || kind.k === 'numbers') field = kind.field;
      break;
    }
    typed.add(t.text.toUpperCase());
  }
  if (field) {
    if (!mol) return [];
    const idx = getIndex(mol);
    let values: string[] = [];
    if (field === 'chain') values = [...idx.chains].filter((c) => c !== '');
    else if (field === 'resname') values = rankByCount(idx.topo.residues.map((r) => r.resName));
    else if (field === 'name') values = rankByCount(idx.nameU.filter((s) => s));
    else if (field === 'element') values = rankByCount(mol.atoms.map((a) => a.element));
    const more = finish(values.filter((v) => !typed.has(v.toUpperCase())).map(quoteValue));
    // After at least one value, the list may also be finished with an operator.
    if (typed.size && prefix === '') return [...more.slice(0, MAX_SUGGESTIONS - 2), 'and', 'or'];
    return more;
  }

  // After a complete term an operator is expected.
  const expectsTerm =
    !last ||
    last.type === 'lparen' || last.type === 'and' || last.type === 'or' || last.type === 'comma' || last.type === 'not' ||
    (last.type === 'word' && (lastWord === 'of' || lastWord === 'as' || lastWord === 'to' || lastWord === 'byres' || lastWord === 'bychain'));
  const afterTerm = !expectsTerm;
  if (afterTerm && prefix === '') return ['and', 'or', 'and not'];

  // Start of a term (or a word typed right after one): keywords, then this molecule's residue
  // names (bare-word fallback).
  const out: string[] = [];
  if (afterTerm) out.push('and', 'or');
  out.push(...COMMON_TERMS);
  for (const k of TERM_KEYWORDS) out.push(k);
  if (mol && prefix) {
    const idx = getIndex(mol);
    const ligands = idx.topo.residues.filter((r) => r.kind === 'ligand').map((r) => r.resName);
    out.push(...rankByCount(ligands), ...rankByCount(idx.topo.residues.map((r) => r.resName)));
  }
  return finish(out);
}

/** Keyword help for the UI. */
export interface SelectionKeywordHelp {
  keyword: string;
  description: string;
  example: string;
}
export function selectionHelp(): SelectionKeywordHelp[] {
  const help: SelectionKeywordHelp[] = KEYWORD_DEFS.map((d) => {
    const [main, ...aliases] = d.names;
    const alias = aliases.length ? ` (also ${aliases.map((a) => `'${a}'`).join(', ')})` : '';
    return { keyword: main, description: d.description + alias, example: d.example };
  });
  help.push(
    { keyword: '( )', description: 'Group expressions', example: '(chain A or chain B) and helix' },
    { keyword: 'bare word', description: 'Any other word matches a residue name, then an atom name, then an element', example: 'HEM' },
    { keyword: 'number', description: 'A bare number or range is a residue number', example: '42-50' },
  );
  return help;
}

/** Quick-pick chips relevant to this molecule, e.g. Protein, Ligands, Water, Chain A, Helix, ... */
export function quickSelections(mol: Molecule): { label: string; query: string }[] {
  const topo = getTopology(mol);
  const kinds = new Set(topo.residues.map((r) => r.kind));
  const out: { label: string; query: string }[] = [];
  let hasH = false;
  let hasHeavy = false;
  let helix = false;
  let sheet = false;
  for (const a of mol.atoms) {
    if (isHydrogen(a.element)) hasH = true;
    else hasHeavy = true;
    if (a.ss === 'helix') helix = true;
    else if (a.ss === 'sheet') sheet = true;
  }
  if (kinds.has('protein')) {
    out.push({ label: 'Protein', query: 'protein' }, { label: 'Backbone', query: 'backbone' });
    if (topo.residues.some((r) => r.kind === 'protein' && r.resName !== 'GLY')) out.push({ label: 'Side chains', query: 'sidechain' });
  }
  if (kinds.has('ligand')) out.push({ label: 'Ligands', query: 'ligand' });
  if (kinds.has('water')) out.push({ label: 'Water', query: 'water' });
  if (kinds.has('ion')) out.push({ label: 'Ions', query: 'ion' });
  if (kinds.has('nucleic')) out.push({ label: 'Nucleic', query: 'nucleic' });
  if (helix) out.push({ label: 'Helix', query: 'helix' });
  if (sheet) out.push({ label: 'Sheet', query: 'sheet' });
  if (hasH) out.push({ label: 'Hydrogens', query: 'hydrogen' });
  if (hasH && hasHeavy) out.push({ label: 'Heavy atoms', query: 'heavy' });
  const chains = topo.chains.map((c) => c.id).filter((id) => id !== '');
  if (chains.length >= 2 && chains.length <= 12) for (const c of chains) out.push({ label: `Chain ${c}`, query: `chain ${quoteValue(c)}` });
  const ligandNames = [...new Set(topo.residues.filter((r) => r.kind === 'ligand').map((r) => r.resName))];
  for (const r of ligandNames.slice(0, 12)) out.push({ label: r, query: `resname ${quoteValue(r)}` });
  return out;
}
