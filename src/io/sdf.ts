/**
 * MDL Molfile / SD file reader and writer (CTfile V2000 and V3000).
 *
 * Reader: first record only. Header (name), counts line, atom block (coordinates, symbol, charge
 * code), bond block (1/2/3, 4 = aromatic → 1.5), 'M  CHG' properties (which supersede atom-block
 * charges, as the CTfile spec requires), and SD data items after 'M  END' (PubChem name / CID).
 * Writer: V2000, or V3000 when the molecule has more than 999 atoms or bonds.
 */
import type { BondOrder, Molecule, MoleculeMeta } from '../core/types';
import { buildMolecule, type AtomInput, type BondInput } from '../core/molecule';
import { exactElement } from './elementSymbols';
import { collapseSpaces, fmtFixed, padLeft, padRight, pickName, splitLines, tokens } from './common';

/** Atom-block charge code → formal charge (4 = doublet radical, treated as neutral). */
const CHARGE_CODE: Record<number, number> = { 1: 3, 2: 2, 3: 1, 5: -1, 6: -2, 7: -3 };

function bondOrderFromMdl(type: number): BondOrder {
  if (type === 2) return 2;
  if (type === 3) return 3;
  if (type === 4) return 1.5;
  return 1; // 1 single; 5–8 query types → single
}

function sdfElement(symbol: string): string {
  // Query atoms (A, Q, *, L, R#, …) and unknown symbols become 'X'; D/T → H.
  return exactElement(symbol) ?? 'X';
}

export interface SdfParseResult {
  mol: Molecule;
  /** SD data items of the first record (name → value). */
  properties: Map<string, string>;
}

/** Parse the first record of an SD / MOL file. */
export function parseSdf(text: string, name?: string): Molecule {
  return parseSdfRecord(text, name).mol;
}

export function parseSdfRecord(text: string, name?: string): SdfParseResult {
  const lines = splitLines(text);
  // The name line may legitimately be blank, so only skip a stray leading blank line when the
  // versioned counts line sits one line too low.
  let start = 0;
  if (!lines[0]?.trim() && !isCountsLine(lines[3] ?? '') && isCountsLine(lines[4] ?? '')) start = 1;
  const countsIdx = start + 3;
  if (lines.length <= countsIdx) throw new Error('Invalid SDF/MOL file: the header is incomplete (expected 3 header lines and a counts line).');
  const header = lines[start];
  const counts = lines[countsIdx];

  const atoms: AtomInput[] = [];
  const bonds: BondInput[] = [];
  let i: number;
  if (/V3000/i.test(counts)) {
    i = parseV3000(lines, countsIdx + 1, atoms, bonds);
  } else {
    i = parseV2000(lines, countsIdx, atoms, bonds);
  }

  // Data items after M  END, up to $$$$.
  const properties = new Map<string, string>();
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('$$$$')) break;
    if (line.startsWith('>')) {
      const m = /<([^>]*)>/.exec(line);
      const key = m ? m[1] : line.slice(1).trim();
      const values: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !lines[i + 1].startsWith('$$$$')) values.push(lines[++i]);
      if (key && !properties.has(key)) properties.set(key, values.join('\n'));
    }
  }

  const headerName = header.trim();
  const prop = (...keys: string[]) => {
    for (const k of keys) {
      for (const [pk, v] of properties) if (pk.toLowerCase() === k.toLowerCase() && v.trim()) return v.trim();
    }
    return undefined;
  };
  const meta: MoleculeMeta = { format: 'sdf', hasBondOrders: true };
  const iupac = prop('PUBCHEM_IUPAC_NAME', 'IUPAC_NAME', 'IUPAC Name');
  const named = prop('Name', 'Title', 'PUBCHEM_IUPAC_TRADITIONAL_NAME', 'GENERIC_NAME', 'DRUGBANK_NAME', 'chembl_pref_name');
  const headerIsId = /^\d+$/.test(headerName);
  const title = iupac ?? named ?? (headerName && !headerIsId ? headerName : undefined);
  if (title) meta.title = collapseSpaces(title);
  const cid = prop('PUBCHEM_COMPOUND_CID');
  if (cid) meta.externalId = cid;
  else if (headerIsId && /PubChem|OEChem/i.test(lines[start + 1] ?? '')) meta.externalId = headerName;

  const molName = pickName('Untitled', name, headerName && !headerIsId ? headerName : undefined, named, iupac, headerName);
  return { mol: buildMolecule(molName, atoms, bonds, meta), properties };
}

function isCountsLine(line: string): boolean {
  return /V[23]000/i.test(line);
}

/** Parse V2000 counts / atom / bond / property blocks. Returns the line index after 'M  END'. */
function parseV2000(lines: string[], countsIdx: number, atoms: AtomInput[], bonds: BondInput[]): number {
  const counts = lines[countsIdx];
  let nAtoms = parseInt(counts.substring(0, 3), 10);
  let nBonds = parseInt(counts.substring(3, 6), 10);
  if (!Number.isFinite(nAtoms) || !Number.isFinite(nBonds)) {
    const t = tokens(counts);
    nAtoms = parseInt(t[0], 10);
    nBonds = parseInt(t[1], 10);
  }
  if (!Number.isFinite(nAtoms) || nAtoms < 0) throw new Error('Invalid SDF/MOL file: could not read the atom count on line 4.');
  if (!Number.isFinite(nBonds) || nBonds < 0) nBonds = 0;

  let i = countsIdx + 1;
  for (let k = 0; k < nAtoms; k++, i++) {
    const line = lines[i];
    if (line === undefined) throw new Error(`Invalid SDF/MOL file: expected ${nAtoms} atoms but the file ended after ${k}.`);
    let x = parseFloat(line.substring(0, 10));
    let y = parseFloat(line.substring(10, 20));
    let z = parseFloat(line.substring(20, 30));
    let symbol = line.substring(31, 34).trim();
    let chargeCode = parseInt(line.substring(36, 39), 10);
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) || !symbol) {
      // Free-format fallback: x y z symbol massDiff chargeCode
      const t = tokens(line);
      x = parseFloat(t[0]);
      y = parseFloat(t[1]);
      z = parseFloat(t[2]);
      symbol = t[3] ?? '';
      chargeCode = parseInt(t[5] ?? '0', 10);
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) || !symbol) {
        throw new Error(`Invalid SDF/MOL file: could not read atom ${k + 1} on line ${i + 1}.`);
      }
    }
    const atom: AtomInput = { element: sdfElement(symbol), x, y, z };
    const charge = CHARGE_CODE[chargeCode];
    if (charge) atom.charge = charge;
    atoms.push(atom);
  }
  for (let k = 0; k < nBonds; k++, i++) {
    const line = lines[i];
    if (line === undefined) throw new Error(`Invalid SDF/MOL file: expected ${nBonds} bonds but the file ended after ${k}.`);
    let a = parseInt(line.substring(0, 3), 10);
    let b = parseInt(line.substring(3, 6), 10);
    let type = parseInt(line.substring(6, 9), 10);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(type)) {
      const t = tokens(line);
      a = parseInt(t[0], 10);
      b = parseInt(t[1], 10);
      type = parseInt(t[2], 10);
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Invalid SDF/MOL file: could not read bond ${k + 1} on line ${i + 1}.`);
    bonds.push({ a: a - 1, b: b - 1, order: bondOrderFromMdl(type) });
  }

  // Properties block.
  let chgSeen = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('M  END')) return i + 1;
    if (line.startsWith('$$$$') || line.startsWith('>')) return i; // missing M  END: tolerate
    if (line.startsWith('M  CHG')) {
      if (!chgSeen) {
        // The first CHG line supersedes all atom-block charges.
        for (const a of atoms) delete a.charge;
        chgSeen = true;
      }
      const t = tokens(line.substring(6));
      const n = parseInt(t[0], 10);
      for (let k = 0; k < n; k++) {
        const idx = parseInt(t[1 + 2 * k], 10) - 1;
        const val = parseInt(t[2 + 2 * k], 10);
        if (idx >= 0 && idx < atoms.length && Number.isFinite(val)) {
          if (val) atoms[idx].charge = val;
          else delete atoms[idx].charge;
        }
      }
    } else if (line.startsWith('A  ') || line.startsWith('G  ')) {
      i++; // atom alias / group abbreviation: followed by one text line
    }
  }
  return i;
}

/** Read V3000 logical lines ("M  V30 …" with '-' continuations) starting at `start`. */
function parseV3000(lines: string[], start: number, atoms: AtomInput[], bonds: BondInput[]): number {
  let i = start;
  let section: 'none' | 'atom' | 'bond' = 'none';
  const atomIndexById = new Map<number, number>();
  const readLogical = (): string | null => {
    if (i >= lines.length) return null;
    let line = lines[i++];
    if (!line.startsWith('M  V30')) return line;
    let content = line.substring(6).trim();
    while (content.endsWith('-') && i < lines.length && lines[i].startsWith('M  V30')) {
      content = content.slice(0, -1) + lines[i++].substring(7);
      content = content.trim();
    }
    return 'M  V30 ' + content;
  };
  for (;;) {
    const raw = readLogical();
    if (raw === null) return i;
    if (raw.startsWith('M  END')) return i;
    if (raw.startsWith('$$$$')) return i - 1;
    if (!raw.startsWith('M  V30')) continue;
    const content = raw.substring(7).trim();
    const upper = content.toUpperCase();
    if (upper.startsWith('BEGIN ATOM')) section = 'atom';
    else if (upper.startsWith('BEGIN BOND')) section = 'bond';
    else if (upper.startsWith('END ATOM') || upper.startsWith('END BOND')) section = 'none';
    else if (section === 'atom') {
      const t = v3000Tokens(content);
      const id = parseInt(t[0], 10);
      const x = parseFloat(t[2]), y = parseFloat(t[3]), z = parseFloat(t[4]);
      if (!Number.isFinite(id) || !(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
        throw new Error(`Invalid V3000 molfile: could not read atom line "${content.slice(0, 40)}".`);
      }
      const atom: AtomInput = { element: sdfElement(t[1] ?? ''), x, y, z };
      for (let k = 6; k < t.length; k++) {
        const eq = t[k].indexOf('=');
        if (eq > 0 && t[k].substring(0, eq).toUpperCase() === 'CHG') {
          const c = parseInt(t[k].substring(eq + 1), 10);
          if (c) atom.charge = c;
        }
      }
      atomIndexById.set(id, atoms.length);
      atoms.push(atom);
    } else if (section === 'bond') {
      const t = v3000Tokens(content);
      const type = parseInt(t[1], 10);
      const a = atomIndexById.get(parseInt(t[2], 10));
      const b = atomIndexById.get(parseInt(t[3], 10));
      if (a !== undefined && b !== undefined) bonds.push({ a, b, order: bondOrderFromMdl(type) });
    }
  }
}

/** Whitespace tokens, keeping quoted strings and parenthesised lists together. */
function v3000Tokens(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = false;
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    if (!quote) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
    }
    if ((ch === ' ' || ch === '\t') && depth === 0 && !quote) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function mdlBondType(order: BondOrder): number {
  return order === 1.5 ? 4 : order === 2 ? 2 : order === 3 ? 3 : 1;
}

function chargeCode(charge: number | undefined): number {
  switch (charge) {
    case 3: return 1;
    case 2: return 2;
    case 1: return 3;
    case -1: return 5;
    case -2: return 6;
    case -3: return 7;
    default: return 0;
  }
}

function mdlSymbol(element: string): string {
  return element === 'X' ? 'A' : element; // 'A' = any atom (query); keeps the record readable
}

function programLine(): string {
  const d = new Date();
  const p2 = (v: number) => String(v).padStart(2, '0');
  const stamp = p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getFullYear() % 100) + p2(d.getHours()) + p2(d.getMinutes());
  // IIPPPPPPPPMMDDYYHHmmdd : initials (2), program (8), date/time (10), dimensional code (2)
  return '  ' + padRight('MolStdio', 8) + stamp + '3D';
}

/** Serialize as an SD file record (V2000, or V3000 beyond 999 atoms / bonds), terminated by $$$$. */
export function writeSdf(mol: Molecule): string {
  const indexOf = new Map<number, number>();
  mol.atoms.forEach((a, i) => indexOf.set(a.id, i + 1));
  const bonds = mol.bonds.filter((b) => indexOf.has(b.a) && indexOf.has(b.b));
  const out: string[] = [collapseSpaces(mol.name).slice(0, 80), programLine(), collapseSpaces(mol.meta.title ?? '').slice(0, 80)];
  if (mol.atoms.length > 999 || bonds.length > 999) {
    writeV3000Body(out, mol, bonds, indexOf);
  } else {
    out.push(padLeft(mol.atoms.length, 3) + padLeft(bonds.length, 3) + '  0  0  0  0  0  0  0  0999 V2000');
    for (const a of mol.atoms) {
      out.push(
        fmtFixed(a.x, 4, 10) +
          fmtFixed(a.y, 4, 10) +
          fmtFixed(a.z, 4, 10) +
          ' ' +
          padRight(mdlSymbol(a.element), 3) +
          ' 0' +
          padLeft(chargeCode(a.charge), 3) +
          '  0  0  0  0  0  0  0  0  0  0',
      );
    }
    for (const b of bonds) {
      out.push(padLeft(indexOf.get(b.a)!, 3) + padLeft(indexOf.get(b.b)!, 3) + padLeft(mdlBondType(b.order), 3) + '  0  0  0  0');
    }
    // M  CHG lines (at most 8 entries per line); required for charges outside ±3, authoritative for all.
    const charged = mol.atoms.map((a, i) => [i + 1, Math.round(a.charge ?? 0)] as const).filter(([, c]) => c !== 0);
    for (let k = 0; k < charged.length; k += 8) {
      const chunk = charged.slice(k, k + 8);
      out.push('M  CHG' + padLeft(chunk.length, 3) + chunk.map(([i, c]) => ' ' + padLeft(i, 3) + ' ' + padLeft(c, 3)).join(''));
    }
    out.push('M  END');
  }
  out.push('$$$$');
  return out.join('\n') + '\n';
}

function writeV3000Body(out: string[], mol: Molecule, bonds: Molecule['bonds'], indexOf: Map<number, number>): void {
  out.push('  0  0  0     0  0            999 V3000');
  out.push('M  V30 BEGIN CTAB');
  out.push(`M  V30 COUNTS ${mol.atoms.length} ${bonds.length} 0 0 0`);
  out.push('M  V30 BEGIN ATOM');
  mol.atoms.forEach((a, i) => {
    const charge = Math.round(a.charge ?? 0);
    out.push(
      `M  V30 ${i + 1} ${mdlSymbol(a.element)} ${a.x.toFixed(4)} ${a.y.toFixed(4)} ${a.z.toFixed(4)} 0` + (charge ? ` CHG=${charge}` : ''),
    );
  });
  out.push('M  V30 END ATOM');
  if (bonds.length) {
    out.push('M  V30 BEGIN BOND');
    bonds.forEach((b, k) => out.push(`M  V30 ${k + 1} ${mdlBondType(b.order)} ${indexOf.get(b.a)} ${indexOf.get(b.b)}`));
    out.push('M  V30 END BOND');
  }
  out.push('M  V30 END CTAB');
  out.push('M  END');
}
