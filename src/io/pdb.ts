/**
 * PDB format reader / writer (wwPDB format v3.3 fixed columns).
 *
 * Reader: ATOM/HETATM (first MODEL only, first altLoc only), CONECT, HELIX/SHEET, HEADER, TITLE,
 * COMPND. Tolerates short lines, CRLF, missing element columns (element inferred from the atom name
 * and its residue, see inferPdbElement), 4-character residue names (CHARMM), segment ids in place of
 * chain ids and hybrid-36 serials.
 * The hot loop only slices strings — no regular expressions per line.
 *
 * Writer: HELIX/SHEET from atom.ss, ATOM/HETATM with exact column layout, TER after polymer chains,
 * CONECT for bonds involving hetero / non-residue atoms and non-polymer inter-residue bonds
 * (e.g. disulfides), END.
 */
import type { Molecule, MoleculeMeta } from '../core/types';
import { AMINO_ACIDS, NUCLEIC_ACIDS, WATER_NAMES, buildMolecule, getTopology, type AtomInput, type BondInput } from '../core/molecule';
import { isMetal } from '../core/structure-chem';
import { exactElement, isElementSymbol, normalizeElement } from './elementSymbols';
import {
  AltLocFilter,
  applySecondaryStructure,
  collapseSpaces,
  fmtFixed,
  padLeft,
  padRight,
  pickName,
  splitLines,
  tokens,
  type SsRange,
} from './common';

// ---------------------------------------------------------------------------
// Hybrid-36 numbers (serials > 99999, residue numbers > 9999)
// ---------------------------------------------------------------------------

/** Decode a decimal or hybrid-36 field ('A0000' = 100000 for width 5). NaN if blank / invalid. */
export function decodeHybrid36(width: number, field: string): number {
  const s = field.trim();
  if (!s) return NaN;
  const c = s.charCodeAt(0);
  if ((c >= 48 && c <= 57) || c === 45 || c === 43) return parseInt(s, 10);
  if (s.length !== width) return NaN;
  const n = parseInt(s, 36);
  if (!Number.isFinite(n)) return NaN;
  const base = 10 * 36 ** (width - 1);
  if (c >= 65 && c <= 90) return n - base + 10 ** width;
  if (c >= 97 && c <= 122) return n - base + 10 ** width + 26 * 36 ** (width - 1);
  return NaN;
}

/** Encode a number in `width` columns, switching to hybrid-36 when it does not fit in decimal. */
export function encodeHybrid36(width: number, value: number): string {
  const v0 = Math.trunc(value);
  if (v0 < 10 ** width && v0 > -(10 ** (width - 1))) return padLeft(v0, width);
  const span = 26 * 36 ** (width - 1);
  const base = 10 * 36 ** (width - 1);
  let v = v0 - 10 ** width;
  if (v < span) return (v + base).toString(36).toUpperCase();
  v -= span;
  if (v < span) return (v + base).toString(36).toLowerCase();
  return '*'.repeat(width);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Two-letter element names that are unambiguous at column 13 of a ligand / ion atom name
 * (no common organic atom names start with these letters). CA/NA/K/HG… are only accepted
 * when the residue is the ion itself (handled separately). Never used for standard residues.
 */
const HET_TWO_LETTER = new Set([
  'FE', 'ZN', 'MG', 'CL', 'BR', 'MN', 'CU', 'NI', 'SE', 'CD', 'LI', 'AL', 'PT', 'AU', 'AG', 'PB', 'SR', 'BA',
  'CS', 'RB', 'GD', 'YB', 'SB', 'TL', 'IR', 'OS', 'RU', 'RH', 'PD', 'MO', 'GA', 'AS', 'XE', 'KR', 'SM', 'EU', 'TB', 'LU',
]);

/** CHARMM / NAMD ion names (atom name = residue name). */
const MD_ION_NAMES: Record<string, string> = { SOD: 'Na', POT: 'K', CLA: 'Cl', CAL: 'Ca', CES: 'Cs', LIT: 'Li', RUB: 'Rb', BAR: 'Ba' };

/**
 * Symbols that look like ions once digits are stripped but name groups in structure files
 * ('NH2'/'NH3'/'NH4' → Nh, 'BH4' → Bh, 'NO3' → No, 'PO4' → Po): never read as monatomic ions.
 */
const NOT_IONS = new Set(['Po', 'At', 'Rn', 'Fr', 'Ra', 'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og']);

/**
 * Metal cofactors whose metal atom is named after the element (FE, FE1…, CU1, CO). Their metal is
 * read as such whatever the record type and column: MD packages (CHARMM, NAMD) write cofactors as
 * ATOM records and shift short names to column 14 (' FE ' would otherwise be fluorine). None of
 * these residues contains an atom of the one-letter element the name would suggest (F, C).
 */
const COFACTOR_METALS: Record<string, string> = {
  HEM: 'Fe', HEC: 'Fe', HEA: 'Fe', HEB: 'Fe', HEO: 'Fe', HEME: 'Fe', SRM: 'Fe',
  SF4: 'Fe', FES: 'Fe', F3S: 'Fe', CLF: 'Fe', ICS: 'Fe',
  CUA: 'Cu', B12: 'Co', CNC: 'Co',
};

/** Seleno amino acids: their SE atom is selenium also in ATOM records (MD packages, PDB files with MSE as ATOM). */
const SELENO_RESIDUES = new Set(['MSE', 'SEC']);

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Residue names that are polymer residues only in ATOM records; as HETATM they are ligands (UNK is a common ligand name). */
const LIGAND_WHEN_HETERO = new Set(['UNK', 'ACE', 'NME', 'NH2']);

/**
 * Standard polymer residues and water, including the 4-character variants MD packages write
 * (AMBER terminal residues NALA / CLYS, GROMACS and CHARMM protonation states HISD / LYSH / ASPP /
 * GLUP / CYS2). Their atom names follow the one-letter convention (CA, CD = carbon) in any column.
 * UNK and the caps count only in ATOM records, as in the residue classification (core/molecule.ts).
 */
function isStandardResidue(resName: string, hetero: boolean): boolean {
  const r = resName.toUpperCase();
  if (hetero && LIGAND_WHEN_HETERO.has(r)) return false;
  if (hasOwn(AMINO_ACIDS, r) || hasOwn(NUCLEIC_ACIDS, r) || WATER_NAMES.has(r)) return true;
  if (r.length === 4) {
    if ((r[0] === 'N' || r[0] === 'C') && hasOwn(AMINO_ACIDS, r.slice(1))) return true;
    if (hasOwn(AMINO_ACIDS, r.slice(0, 3))) return true;
  }
  return false;
}

/** Element of a single-atom ion residue whose atom carries the residue's name, else undefined. */
function monatomicIonElement(atomName: string, resName: string): string | undefined {
  const a = atomName.toUpperCase();
  if (a !== resName.trim().toUpperCase()) return undefined;
  const md = MD_ION_NAMES[a];
  if (md) return md;
  const letters = a.replace(/[^A-Z]/g, '');
  if (!(letters.length > 0 && letters.length <= 2 && /^[A-Z]+[\d+-]*$/.test(a))) return undefined;
  const e = exactElement(letters);
  return e && !NOT_IONS.has(e) ? e : undefined;
}

/**
 * Element from the first letter of an atom name. When that letter is no element (ZN, MG, MN, AU,
 * LI…, which would give 'X'), the first two letters are tried against the unambiguous two-letter table
 * unless `twoLetter` is false (standard residues: their 'M…' names are GROMACS virtual sites such as
 * MN1 / MNZ1, never manganese).
 */
function firstAlphaElement(name: string, twoLetter = true): string {
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    const c = ch.charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const e = exactElement(ch);
      if (e) return e;
      if (!twoLetter) return 'X';
      const two = name.substring(i, i + 2).toUpperCase();
      return HET_TWO_LETTER.has(two) ? exactElement(two)! : 'X';
    }
  }
  return 'X';
}

/**
 * Infer the element from a 4-character PDB atom name field (columns 13–16) when columns 77–78 are
 * blank. By convention one-letter elements start in column 14 and two-letter elements in column 13.
 *
 * The residue decides how much the column is trusted, not the record type (MD packages write
 * ligands, ions and cofactors such as heme as ATOM records):
 * - standard amino acids / nucleotides / water: one-letter elements (CA, CD, NE = C, C, N in any
 *   column), except SE of MSE / SEC;
 * - other residues: a name from column 13 starting with an unambiguous two-letter element (FE, ZN,
 *   CL, BR…) is that element. In ATOM records only names shorter than 4 characters count (a
 *   4-character name has to start in column 13); HETATM records keep the plain convention.
 * - metal atoms of known cofactors (FE of HEM, FE1 of SF4, CU1 of CUA) in any column.
 */
export function inferPdbElement(nameField: string, resName: string, hetero: boolean): string {
  const name = nameField.trim();
  if (!name) return 'X';
  // Monatomic ions named like their residue, also as ATOM records and with charge suffixes, as
  // MD packages write them (GROMACS 'NA'/'CL', AMBER 'Na+'/'Cl-', CHARMM 'SOD'/'CLA'/'POT').
  const ion = monatomicIonElement(name, resName);
  if (ion) return ion;
  const up = name.toUpperCase();
  const res = resName.trim().toUpperCase();
  if (isStandardResidue(res, hetero)) {
    if (up === 'SE' && SELENO_RESIDUES.has(res)) return 'Se';
    return firstAlphaElement(name, false);
  }
  const metal = hasOwn(COFACTOR_METALS, res) ? COFACTOR_METALS[res] : undefined;
  if (metal) {
    const sym = metal.toUpperCase();
    if (up.startsWith(sym) && /^\d*$/.test(up.slice(sym.length))) return metal;
  }
  const c0 = nameField.charAt(0);
  const blankOrDigit = c0 === ' ' || (c0 >= '0' && c0 <= '9');
  if (blankOrDigit) {
    const e = exactElement(nameField.charAt(1));
    if (e) return e;
  } else if (hetero || name.length < 4) {
    // Monatomic ions: the atom is named like its residue (CA in CA, NA in NA, K in K, IOD → I below).
    if (hetero && up === res && isElementSymbol(up)) return exactElement(up)!;
    const two = up.substring(0, 2);
    if (HET_TWO_LETTER.has(two)) return exactElement(two)!;
  }
  return firstAlphaElement(name);
}

/** Element of the element columns (77–78), or undefined when they are blank / unreadable. */
function elementFromField(elemField: string): string | undefined {
  if (!elemField) return undefined;
  const e = exactElement(elemField);
  if (e) return e;
  const n = normalizeElement(elemField);
  return n !== 'X' ? n : undefined;
}

const ION_HALOGENS = new Set(['F', 'Cl', 'Br', 'I']);

/**
 * Element of the only atom of an ion residue whose name carries a charge digit or is a long ion
 * name, as CHARMM / NAMD write them: atom ZN in ZN2, CD in CD2, MG in MG2+, CA in CAL, NA in SOD.
 * The atom name must be exactly an ion-forming element symbol (metal or halogen); only called for
 * residues of a single atom, so multi-atom ligands that merely share such a residue name keep the
 * convention-based elements.
 */
function singleAtomIonElement(atomName: string, resName: string): string | undefined {
  const a = atomName.trim().toUpperCase();
  if (a.length === 0 || a.length > 2) return undefined;
  const r = resName.trim().toUpperCase();
  let el: string | undefined;
  const md = MD_ION_NAMES[r];
  if (md !== undefined) el = md.toUpperCase() === a ? md : undefined;
  else if (r.length > a.length && r.startsWith(a) && /^[\d+-]+$/.test(r.slice(a.length))) el = exactElement(a);
  if (!el || NOT_IONS.has(el) || !(isMetal(el) || ION_HALOGENS.has(el))) return undefined;
  return el;
}

/**
 * Re-infer the element of atoms that are alone in their residue and whose element was inferred from
 * the name (no element column / type symbol): CHARMM ions such as ZN in residue ZN2 or CA in CAL.
 * Residues are runs of consecutive atoms with the same chain, number, insertion code and name, so
 * an atom is alone when neither neighbour in file order shares its residue.
 * `inferred[i]` marks atoms whose element came from the name. Mutates `atoms` (parser-local input).
 */
export function resolveSingleAtomIons(atoms: AtomInput[], inferred: ArrayLike<number | boolean>): void {
  const sameResidue = (p: AtomInput, q: AtomInput) =>
    p.resSeq === q.resSeq && p.resName === q.resName && p.chain === q.chain && p.iCode === q.iCode;
  const n = atoms.length;
  for (let i = 0; i < n; i++) {
    const a = atoms[i];
    if (!inferred[i] || !a.resName || !a.name || a.name.length > 2) continue;
    const el = singleAtomIonElement(a.name, a.resName);
    if (!el || el === a.element) continue;
    if ((i > 0 && sameResidue(atoms[i - 1], a)) || (i + 1 < n && sameResidue(atoms[i + 1], a))) continue;
    a.element = el;
  }
}

// ---------------------------------------------------------------------------
// PDBQT (AutoDock / Vina)
// ---------------------------------------------------------------------------

/**
 * AutoDock 4 / Vina atom types → element. The acceptor / donor variants are their element (NA, NS =
 * nitrogen acceptors, not sodium; OA, OS = oxygen acceptors, not osmium; SA = sulfur acceptor; HD, HS =
 * polar hydrogens, not hassium; A = aromatic carbon). AD4 spells metals and halogens both ways (Cl / CL,
 * Ca / CA …): its aromatic carbon is A, so CA is calcium. G, GA, J, Q are AD4 ring-closure ("glue")
 * carbons, CG0–CG9 Meeko's.
 */
const AUTODOCK_TYPES: Readonly<Record<string, string>> = {
  H: 'H', HD: 'H', HS: 'H',
  C: 'C', A: 'C', G: 'C', GA: 'C', J: 'C', Q: 'C',
  N: 'N', NA: 'N', NS: 'N',
  O: 'O', OA: 'O', OS: 'O',
  S: 'S', SA: 'S',
  P: 'P', F: 'F', I: 'I',
  Cl: 'Cl', CL: 'Cl', Br: 'Br', BR: 'Br',
  Mg: 'Mg', MG: 'Mg', Ca: 'Ca', CA: 'Ca', Mn: 'Mn', MN: 'Mn', Fe: 'Fe', FE: 'Fe', Zn: 'Zn', ZN: 'Zn',
};

/** PDBQT pseudo-atom types that are no element (W: hydrated-docking water, Z: covalent map, X: dummy). */
const AUTODOCK_PSEUDO = new Set(['W', 'Z', 'X']);

const isDigitAt = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
};

/**
 * AutoDock atom type of a PDBQT ATOM / HETATM record, or undefined when the record does not have the
 * PDBQT layout: columns 67–70 blank, the partial charge in 71–76 (%6.3f, decimal point in column 73),
 * column 77 blank and the type from column 78 (AutoDockTools, Open Babel, Meeko and Vina all write
 * it so). A plain PDB record has a blank column 72 and the segment id in 73–76, so it never matches.
 */
export function pdbqtAtomType(line: string): string | undefined {
  if (line.length < 78 || line.charCodeAt(72) !== 46 /* . */ || line.charCodeAt(76) !== 32) return undefined;
  for (let c = 66; c < 70; c++) if (line.charCodeAt(c) !== 32) return undefined;
  if (!isDigitAt(line, 71) || !isDigitAt(line, 73) || !isDigitAt(line, 74) || !isDigitAt(line, 75)) return undefined;
  const c70 = line.charAt(70);
  if (c70 !== ' ' && c70 !== '-' && c70 !== '+' && !isDigitAt(line, 70)) return undefined;
  const type = line.substring(77).trim();
  if (!type || type.length > 3 || type.includes(' ')) return undefined;
  return type;
}

/**
 * Element of an AutoDock atom type (AUTODOCK_TYPES; other types written as an element symbol in
 * element case, such as Vina's Cu / Na / K / Hg / Si, are that element). A monatomic ion residue whose
 * atom carries its name and type keeps the ion element (sodium NA in residue NA). Undefined for pseudo
 * atoms and unknown all-capital types: the caller then infers the element from the atom name.
 */
export function autodockTypeElement(type: string, atomName = '', resName = ''): string | undefined {
  if (!type) return undefined;
  const ion = atomName && resName ? monatomicIonElement(atomName, resName) : undefined;
  if (ion && ion.toUpperCase() === type.toUpperCase()) return ion;
  if (hasOwn(AUTODOCK_TYPES, type)) return AUTODOCK_TYPES[type];
  if (type.length === 3 && type.startsWith('CG') && isDigitAt(type, 2)) return 'C';
  if (AUTODOCK_PSEUDO.has(type)) return undefined;
  const c0 = type.charCodeAt(0);
  if (c0 < 65 || c0 > 90) return undefined;
  if (type.length === 1) return exactElement(type);
  if (type.length === 2) {
    const c1 = type.charCodeAt(1);
    if (c1 >= 97 && c1 <= 122) return exactElement(type);
  }
  return undefined;
}

/** PDB charge field: '2+', '1-', also tolerates '+2', '-', '+'. */
function parsePdbCharge(field: string): number | undefined {
  if (!field) return undefined;
  let digits = '';
  let sign = 0;
  for (const ch of field) {
    if (ch >= '0' && ch <= '9') digits += ch;
    else if (ch === '+') sign = 1;
    else if (ch === '-') sign = -1;
  }
  if (!sign) return undefined;
  const mag = digits ? parseInt(digits, 10) : 1;
  return mag ? sign * mag : undefined;
}

/** Fallback for misaligned coordinate columns: the first three consecutive decimal numbers after the name. */
function fallbackCoords(line: string): [number, number, number] | null {
  const t = tokens(line.substring(6));
  for (let i = 0; i + 2 < t.length; i++) {
    if (t[i].includes('.') && t[i + 1].includes('.') && t[i + 2].includes('.')) {
      const x = Number(t[i]), y = Number(t[i + 1]), z = Number(t[i + 2]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return [x, y, z];
    }
  }
  return null;
}

function conectSerials(line: string): number[] {
  // Fixed columns: atom 7–11, bonded atoms 12–16, 17–21, 22–26, 27–31.
  const out: number[] = [];
  let ok = true;
  for (let c = 6; c < 31 && c < line.length; c += 5) {
    const f = line.substring(c, c + 5);
    if (!f.trim()) continue;
    const v = decodeHybrid36(5, f);
    if (Number.isFinite(v)) out.push(v);
    else ok = false;
  }
  if (ok) return out;
  // Free-format fallback (some programs write CONECT without fixed widths).
  const t = tokens(line.substring(6));
  const free: number[] = [];
  for (const s of t) {
    const v = parseInt(s, 10);
    if (Number.isFinite(v)) free.push(v);
  }
  return free;
}

function isRecord(line: string, rec: string): boolean {
  return line.startsWith(rec);
}

export interface ParsePdbOptions {
  /**
   * Read AutoDock PDBQT columns (partial charge in 71–76, AutoDock atom type from 78) on records with
   * that layout. Default: detected from the first ATOM / HETATM record; false reads plain PDB only.
   */
  pdbqt?: boolean;
}

/**
 * Parse PDB text into a raw molecule (first model only). PDBQT files (AutoDock / Vina receptors,
 * ligands and docked poses) are recognised by their column layout: their elements come from the
 * AutoDock atom types (autodockTypeElement), and the partial-charge columns are not read as segment
 * id / formal charge. ROOT / BRANCH / TORSDOF records are ignored.
 */
export function parsePdb(text: string, name?: string, opts: ParsePdbOptions = {}): Molecule {
  const lines = splitLines(text);
  /** PDBQT layout: decided on the first ATOM / HETATM record unless given. */
  let pdbqt = opts.pdbqt;
  const atoms: AtomInput[] = [];
  const bonds: BondInput[] = [];
  const serialToIndex = new Map<number, number>();
  const conect: number[][] = [];
  const ranges: SsRange[] = [];
  const altFilter = new AltLocFilter();
  /** 1 = element inferred from the atom name (blank element columns). */
  const inferred: number[] = [];

  let idCode = '';
  const titleParts: string[] = [];
  const compndParts: string[] = [];
  let sawModel = false;
  let atomsDone = false; // set after the first model ends
  let badCoords = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const c0 = line.charCodeAt(0);
    // Fast dispatch on the first letter: A(TOM) H(ETATM/HELIX/HEADER) C(ONECT/COMPND) S(HEET) T(ITLE) M(ODEL) E(NDMDL/END)
    if (c0 === 65 /* A */ || c0 === 72 /* H */) {
      const isAtom = isRecord(line, 'ATOM');
      const isHet = !isAtom && isRecord(line, 'HETATM');
      if (isAtom || isHet) {
        if (atomsDone) continue;
        const nameField = line.substring(12, 16);
        const altLoc = line.charAt(16).trim();
        const resName = line.substring(17, 21).trim();
        const chainId = line.charAt(21).trim();
        const resSeq = decodeHybrid36(4, line.substring(22, 26));
        const iCode = line.charAt(26).trim();
        const atomName = nameField.trim();
        if (!altFilter.accept(altLoc, chainId, Number.isFinite(resSeq) ? resSeq : undefined, iCode, resName, atomName)) continue;

        let x = parseFloat(line.substring(30, 38));
        let y = parseFloat(line.substring(38, 46));
        let z = parseFloat(line.substring(46, 54));
        if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
          const fb = fallbackCoords(line);
          if (!fb) {
            badCoords++;
            continue;
          }
          [x, y, z] = fb;
        }
        const occ = parseFloat(line.substring(54, 60));
        const bf = parseFloat(line.substring(60, 66));
        if (pdbqt === undefined) pdbqt = pdbqtAtomType(line) !== undefined;
        const adType = pdbqt ? pdbqtAtomType(line) : undefined;
        let segId = '';
        let charge: number | undefined;
        let fieldElement: string | undefined;
        if (adType !== undefined) {
          // PDBQT: columns 71–76 hold the partial charge, 78–79 the AutoDock type (no element,
          // segment id or formal charge columns).
          fieldElement = autodockTypeElement(adType, atomName, resName);
        } else {
          segId = line.length > 72 ? line.substring(72, 76).trim() : '';
          const elemField = line.length > 76 ? line.substring(76, 78).trim() : '';
          charge = line.length > 78 ? parsePdbCharge(line.substring(78, 80).trim()) : undefined;
          fieldElement = elementFromField(elemField);
        }
        const serial = decodeHybrid36(5, line.substring(6, 11));

        const atom: AtomInput = {
          element: fieldElement ?? inferPdbElement(nameField, resName, isHet),
          x,
          y,
          z,
          name: atomName,
          resName: resName || undefined,
          resSeq: Number.isFinite(resSeq) ? resSeq : undefined,
          chain: chainId || segId || undefined,
          hetero: isHet,
        };
        if (Number.isFinite(serial)) {
          atom.serial = serial;
          serialToIndex.set(serial, atoms.length);
        }
        if (iCode) atom.iCode = iCode;
        if (altLoc) atom.altLoc = altLoc;
        if (Number.isFinite(occ)) atom.occupancy = occ;
        if (Number.isFinite(bf)) atom.bfactor = bf;
        if (charge) atom.charge = charge;
        inferred.push(fieldElement ? 0 : 1);
        atoms.push(atom);
        continue;
      }
      if (isRecord(line, 'HELIX')) {
        const startSeq = decodeHybrid36(4, line.substring(21, 25));
        const endSeq = decodeHybrid36(4, line.substring(33, 37));
        if (Number.isFinite(startSeq) && Number.isFinite(endSeq)) {
          ranges.push({
            kind: 'helix',
            chain: line.charAt(19).trim(),
            startSeq,
            startICode: line.charAt(25).trim(),
            endSeq,
            endICode: line.charAt(37).trim(),
          });
        }
        continue;
      }
      if (isRecord(line, 'HEADER')) {
        const id = line.substring(62, 66).trim();
        if (id) idCode = id;
        continue;
      }
      continue;
    }
    if (c0 === 67 /* C */) {
      if (isRecord(line, 'CONECT')) conect.push(conectSerials(line));
      else if (isRecord(line, 'COMPND')) compndParts.push(line.substring(10, 80));
      continue;
    }
    if (c0 === 83 /* S */) {
      if (isRecord(line, 'SHEET')) {
        const startSeq = decodeHybrid36(4, line.substring(22, 26));
        const endSeq = decodeHybrid36(4, line.substring(33, 37));
        if (Number.isFinite(startSeq) && Number.isFinite(endSeq)) {
          ranges.push({
            kind: 'sheet',
            chain: line.charAt(21).trim(),
            startSeq,
            startICode: line.charAt(26).trim(),
            endSeq,
            endICode: line.charAt(37).trim(),
          });
        }
      }
      continue;
    }
    if (c0 === 84 /* T */) {
      if (isRecord(line, 'TITLE')) titleParts.push(line.substring(10, 80));
      continue;
    }
    if (c0 === 77 /* M */) {
      if (isRecord(line, 'MODEL')) {
        if (sawModel || atoms.length > 0) atomsDone = true;
        sawModel = true;
      }
      continue;
    }
    if (c0 === 69 /* E */) {
      if (isRecord(line, 'ENDMDL')) {
        if (atoms.length > 0) atomsDone = true;
      } else if (line.trim() === 'END') {
        break;
      }
      continue;
    }
  }

  if (atoms.length === 0 && badCoords > 0) {
    throw new Error('Could not read atom coordinates: the ATOM/HETATM records do not follow the PDB column layout.');
  }
  resolveSingleAtomIons(atoms, inferred);

  // CONECT → bonds (unknown serials ignored, duplicates removed by buildMolecule).
  for (const rec of conect) {
    if (rec.length < 2) continue;
    const ia = serialToIndex.get(rec[0]);
    if (ia === undefined) continue;
    for (let k = 1; k < rec.length; k++) {
      const ib = serialToIndex.get(rec[k]);
      if (ib !== undefined && ib !== ia) bonds.push({ a: ia, b: ib, order: 1 });
    }
  }

  const meta: MoleculeMeta = { format: 'pdb' };
  if (ranges.length) {
    applySecondaryStructure(atoms, ranges);
    meta.hasSecondaryStructure = true;
  }
  const title = collapseSpaces(titleParts.join(' '));
  const compound = compoundName(compndParts);
  if (title) meta.title = title;
  else if (compound) meta.title = compound;
  if (idCode) meta.externalId = idCode;

  return buildMolecule(pickName('Untitled', name, idCode, compound), atoms, bonds, meta);
}

/** First "MOLECULE: …;" value of the COMPND records. */
function compoundName(parts: string[]): string {
  if (!parts.length) return '';
  const text = collapseSpaces(parts.join(' '));
  const m = /MOLECULE:\s*([^;]*)/i.exec(text);
  if (m) return m[1].trim();
  // Old-style COMPND without tokens.
  return text.includes(':') ? '' : text;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Atom name in columns 13–16: one-letter elements start in column 14, two-letter elements in 13. */
function formatAtomName(name: string, element: string): string {
  const n = name.slice(0, 4);
  if (n.length >= 4) return n;
  const c0 = n.charAt(0);
  if (element.length === 1 && !(c0 >= '0' && c0 <= '9')) return padRight(' ' + n, 4);
  return padRight(n, 4);
}

function formatResName(resName: string): string {
  // Columns 18–20 right-justified; 4-character names (CHARMM) use column 21 too.
  return resName.length >= 4 ? resName.slice(0, 4) : padLeft(resName, 3) + ' ';
}

function formatCharge(charge: number | undefined): string {
  if (!charge) return '  ';
  const mag = Math.min(9, Math.abs(Math.round(charge)));
  return mag === 0 ? '  ' : `${mag}${charge > 0 ? '+' : '-'}`;
}

interface OutAtomInfo {
  record: 'ATOM  ' | 'HETATM';
  name: string;
  resName: string;
  chain: string;
  resSeq: number;
  iCode: string;
  /** residue index in topology, or a synthetic id for non-residue atoms */
  resKey: string;
  polymer: boolean;
  noResidue: boolean;
}

/** Serialize a molecule as PDB text. */
export function writePdb(mol: Molecule): string {
  const topo = getTopology(mol);
  const atoms = mol.atoms;
  const n = atoms.length;
  const info: OutAtomInfo[] = new Array(n);

  // Synthetic residue for atoms without residue info: HETATM UNL, chain A, after the last residue of chain A.
  let unlSeq = 1;
  for (const r of topo.residues) if (r.chain === 'A' && r.resSeq >= unlSeq) unlSeq = r.resSeq + 1;
  let usedNames = new Set<string>();
  let counters = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const a = atoms[i];
    const ri = topo.atomResidue[i];
    if (ri >= 0) {
      const res = topo.residues[ri];
      const polymer = res.kind === 'protein' || res.kind === 'nucleic';
      const hetero = a.hetero ?? !polymer;
      info[i] = {
        record: hetero ? 'HETATM' : 'ATOM  ',
        name: a.name || a.element.toUpperCase(),
        resName: res.resName,
        chain: (a.chain ?? '').charAt(0),
        resSeq: a.resSeq ?? 0,
        iCode: (a.iCode ?? '').charAt(0),
        resKey: 'r' + ri,
        polymer,
        noResidue: false,
      };
      continue;
    }
    // Unique atom name within the synthetic residue (existing name if possible, else C1, C2, O1, …).
    const el = a.element.toUpperCase();
    let atomName = '';
    const own = a.name?.trim().toUpperCase();
    if (own && own.length <= 4 && !usedNames.has(own)) atomName = own;
    while (!atomName) {
      const k = (counters.get(el) ?? 0) + 1;
      counters.set(el, k);
      const candidate = el + k;
      if (candidate.length > 4) {
        // Residue is full for this element: start a new synthetic residue.
        unlSeq++;
        usedNames = new Set();
        counters = new Map();
        continue;
      }
      if (!usedNames.has(candidate)) atomName = candidate;
    }
    usedNames.add(atomName);
    info[i] = {
      record: 'HETATM',
      name: atomName,
      resName: 'UNL',
      chain: 'A',
      resSeq: unlSeq,
      iCode: '',
      resKey: 'u' + unlSeq,
      polymer: false,
      noResidue: true,
    };
  }

  const out: string[] = [];
  const title = mol.meta.title?.trim() || mol.name;
  writeContinued(out, 'TITLE   ', collapseSpaces(title));
  out.push(padRight(`COMPND    MOLECULE: ${collapseSpaces(mol.name).replace(/;/g, ',').slice(0, 58)};`, 80));
  out.push(padRight('REMARK    GENERATED BY MOLECULE STUDIO', 80));
  writeSecondaryStructure(out, mol);

  // ATOM / HETATM / TER
  const serials = new Int32Array(n);
  let serial = 0;
  for (let i = 0; i < n; i++) {
    const a = atoms[i];
    const f = info[i];
    serial++;
    serials[i] = serial;
    out.push(
      f.record +
        encodeHybrid36(5, serial) +
        ' ' +
        formatAtomName(f.name, a.element) +
        (a.altLoc ? a.altLoc.charAt(0) : ' ') +
        formatResName(f.resName) +
        (f.chain || ' ') +
        encodeHybrid36(4, f.resSeq) +
        (f.iCode || ' ') +
        '   ' +
        fmtFixed(a.x, 3, 8) +
        fmtFixed(a.y, 3, 8) +
        fmtFixed(a.z, 3, 8) +
        fmtFixed(a.occupancy ?? 1, 2, 6) +
        fmtFixed(a.bfactor ?? 0, 2, 6) +
        '          ' +
        padLeft(a.element === 'X' ? 'X' : a.element.toUpperCase(), 2) +
        formatCharge(a.charge),
    );
    // TER closes a polymer chain: the next atom is in another chain or is not a polymer ATOM record.
    if (f.record === 'ATOM  ' && f.polymer) {
      const next = i + 1 < n ? info[i + 1] : null;
      if (!next || next.record !== 'ATOM  ' || next.chain !== f.chain) {
        serial++;
        out.push(
          padRight(
            'TER   ' + encodeHybrid36(5, serial) + '      ' + formatResName(f.resName) + (f.chain || ' ') + encodeHybrid36(4, f.resSeq) + (f.iCode || ' '),
            80,
          ),
        );
      }
    }
  }

  // CONECT for hetero / non-residue atoms and non-polymer links between residues (disulfides, cross-links).
  const partners: number[][] = Array.from({ length: n }, () => []);
  for (const b of mol.bonds) {
    const ia = topo.idToIndex.get(b.a);
    const ib = topo.idToIndex.get(b.b);
    if (ia === undefined || ib === undefined) continue;
    const fa = info[ia];
    const fb = info[ib];
    const include =
      fa.record === 'HETATM' || fb.record === 'HETATM' || (fa.resKey !== fb.resKey && !isPolymerLink(fa.name, fb.name));
    if (!include) continue;
    partners[ia].push(ib);
    partners[ib].push(ia);
  }
  for (let i = 0; i < n; i++) {
    const p = partners[i];
    if (!p.length) continue;
    p.sort((x, y) => x - y);
    for (let k = 0; k < p.length; k += 4) {
      let line = 'CONECT' + encodeHybrid36(5, serials[i]);
      for (let m = k; m < Math.min(k + 4, p.length); m++) line += encodeHybrid36(5, serials[p[m]]);
      out.push(padRight(line, 80));
    }
  }
  out.push(padRight('END', 80));
  return out.join('\n') + '\n';
}

/** Peptide (C–N) and phosphodiester (O3'–P) links are implied by residue order and not written as CONECT. */
function isPolymerLink(nameA: string, nameB: string): boolean {
  const a = nameA.toUpperCase();
  const b = nameB.toUpperCase();
  if ((a === 'C' && b === 'N') || (a === 'N' && b === 'C')) return true;
  const o3 = (s: string) => s === "O3'" || s === 'O3*';
  return (o3(a) && b === 'P') || (a === 'P' && o3(b));
}

/** TITLE-style record with continuation numbers in columns 9–10 and text in 11–80. */
function writeContinued(out: string[], record: string, text: string): void {
  if (!text) return;
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  const maxLen = (k: number) => (k === 0 ? 70 : 69);
  for (const w of words) {
    const limit = maxLen(lines.length);
    if (!cur) cur = w.slice(0, limit);
    else if (cur.length + 1 + w.length <= limit) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w.slice(0, maxLen(lines.length));
    }
  }
  if (cur) lines.push(cur);
  lines.forEach((l, k) => {
    const cont = k === 0 ? '  ' : padLeft(k + 1, 2);
    out.push(padRight(record + cont + (k === 0 ? l : ' ' + l), 80));
  });
}

/** HELIX / SHEET records from contiguous runs of atom.ss (per chain, in residue order). */
function writeSecondaryStructure(out: string[], mol: Molecule): void {
  const topo = getTopology(mol);
  if (!topo.residues.some((r) => r.ss === 'helix' || r.ss === 'sheet')) return;
  let helixNo = 0;
  let sheetNo = 0;
  for (const chain of topo.chains) {
    const chainId = (chain.id || ' ').charAt(0);
    const idx = chain.residueIndices;
    let k = 0;
    while (k < idx.length) {
      const r0 = topo.residues[idx[k]];
      const ss = r0.kind === 'protein' ? r0.ss : undefined;
      if (ss !== 'helix' && ss !== 'sheet') {
        k++;
        continue;
      }
      let e = k;
      while (e + 1 < idx.length) {
        const rn = topo.residues[idx[e + 1]];
        if (rn.kind !== 'protein' || rn.ss !== ss) break;
        e++;
      }
      const r1 = topo.residues[idx[e]];
      const len = e - k + 1;
      if (ss === 'helix') {
        helixNo++;
        out.push(
          padRight(
            'HELIX  ' +
              padLeft(helixNo, 3) +
              ' ' +
              padLeft(String(helixNo).slice(-3), 3) +
              ' ' +
              padLeft(r0.resName.slice(0, 3), 3) +
              ' ' +
              chainId +
              ' ' +
              encodeHybrid36(4, r0.resSeq) +
              (r0.iCode || ' ').charAt(0) +
              ' ' +
              padLeft(r1.resName.slice(0, 3), 3) +
              ' ' +
              chainId +
              ' ' +
              encodeHybrid36(4, r1.resSeq) +
              (r1.iCode || ' ').charAt(0) +
              ' 1' +
              ' '.repeat(30) +
              ' ' +
              padLeft(len, 5),
            80,
          ),
        );
      } else {
        sheetNo++;
        out.push(
          padRight(
            'SHEET  ' +
              padLeft(1, 3) +
              ' ' +
              padLeft(sheetNo.toString(36).toUpperCase().slice(-3), 3) +
              padLeft(1, 2) +
              ' ' +
              padLeft(r0.resName.slice(0, 3), 3) +
              ' ' +
              chainId +
              encodeHybrid36(4, r0.resSeq) +
              (r0.iCode || ' ').charAt(0) +
              ' ' +
              padLeft(r1.resName.slice(0, 3), 3) +
              ' ' +
              chainId +
              encodeHybrid36(4, r1.resSeq) +
              (r1.iCode || ' ').charAt(0) +
              padLeft(0, 2),
            80,
          ),
        );
      }
      k = e + 1;
    }
  }
}
