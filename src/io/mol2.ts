/**
 * Tripos MOL2 reader / writer.
 *
 * Reader: first @<TRIPOS>MOLECULE only; ATOM (element from the SYBYL type prefix: C.ar → C,
 * N.pl3 → N, Cl → Cl; lone pairs dropped), BOND (1/2/3, ar → 1.5, am/du/un → 1, nc = not connected →
 * no bond), SUBSTRUCTURE (chain ids). Residue names/numbers come from subst_name ('ALA12' → ALA 12)
 * when the file describes residues (several substructures or a known residue name).
 * MOL2 has no formal-charge field: the charge column usually holds partial charges. If every value is
 * an integer and at least one is non-zero the column is read as formal charges; otherwise formal
 * charges are inferred from the SYBYL type (N.4 → +1).
 *
 * Writer: SYBYL atom types derived from element + bond orders, bond types 1/2/3/ar/am, one
 * substructure per residue, formal charges in the charge column (USER_CHARGES).
 */
import type { BondOrder, Molecule, MoleculeMeta } from '../core/types';
import { buildMolecule, classifyResidue, getTopology, type AtomInput, type BondInput } from '../core/molecule';
import { exactElement, normalizeElement } from './elementSymbols';
import { collapseSpaces, fmtFixed, padLeft, padRight, pickName, splitLines, tokens } from './common';

const DUMMY_TYPES = new Set(['DU', 'ANY', 'HAL', 'HET', 'HEV', 'DU.C']);
/** Generic substructure names used by tools for "no residue". */
const PLACEHOLDER_SUBST = new Set(['UNL', 'LIG', 'MOL', 'UNK', 'DRG', 'INH', 'RES', 'SUB', 'GRP', 'XXX', '***', '****', '<0>', '<1>']);

function elementFromSybyl(type: string, atomName: string): string {
  const dot = type.indexOf('.');
  const prefix = dot >= 0 ? type.substring(0, dot) : type;
  const e = exactElement(prefix);
  if (e) return e;
  if (DUMMY_TYPES.has(type.toUpperCase()) || DUMMY_TYPES.has(prefix.toUpperCase())) return 'X';
  return normalizeElement(atomName);
}

interface ParsedSubst {
  resName: string;
  resSeq: number;
  iCode: string;
}

/**
 * 'ALA12' → ALA 12, 'DA5' → DA 5, 'HOH301' → HOH 301, 'ALA52A' → ALA 52 A. `resNameHint` is the
 * SUBSTRUCTURE sub_type column (the residue name, e.g. 'MK1' for 'MK1902'): names that end or start
 * with digits are ambiguous without it ('PO4147' → PO4 147, '2MG10' → 2MG 10).
 */
function parseSubstName(substName: string, substId: number, resNameHint?: string): ParsedSubst | null {
  if (!substName || substName === '****' || substName.startsWith('<')) return null;
  if (resNameHint && resNameHint.length <= 4 && substName.toUpperCase().startsWith(resNameHint.toUpperCase())) {
    const rest = /^(-?\d+)([A-Za-z]?)$/.exec(substName.slice(resNameHint.length));
    if (rest) return { resName: resNameHint.toUpperCase(), resSeq: parseInt(rest[1], 10), iCode: rest[2] };
    if (substName.length === resNameHint.length) return { resName: resNameHint.toUpperCase(), resSeq: substId, iCode: '' };
  }
  const m = /^([A-Za-z][A-Za-z0-9]{0,3}?)(-?\d+)([A-Za-z]?)$/.exec(substName) ?? /^(\d[A-Za-z][A-Za-z0-9]?)(-?\d+)([A-Za-z]?)$/.exec(substName);
  if (m) return { resName: m[1].toUpperCase(), resSeq: parseInt(m[2], 10), iCode: m[3] };
  if (substName.length <= 4 && /^[A-Za-z0-9]+$/.test(substName)) return { resName: substName.toUpperCase(), resSeq: substId, iCode: '' };
  return null;
}

function mol2BondOrder(type: string): BondOrder | null {
  switch (type.toLowerCase()) {
    case '2':
      return 2;
    case '3':
      return 3;
    case 'ar':
      return 1.5;
    case 'nc':
      return null; // "not connected"
    default:
      return 1; // 1, am, du, un
  }
}

interface RawMol2Atom {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  type: string;
  substId: number;
  substName: string;
  charge: number;
}

/** Parse the first molecule of a MOL2 file. */
export function parseMol2(text: string, name?: string): Molecule {
  const lines = splitLines(text);
  let section = '';
  let molName = '';
  let molLine = 0;
  let moleculeCount = 0;
  const raw: RawMol2Atom[] = [];
  const rawBonds: { a: number; b: number; order: BondOrder }[] = [];
  const substChain = new Map<number, string>();
  /** SUBSTRUCTURE sub_type (residue name) by substructure id. */
  const substType = new Map<number, string>();
  let hasChargeColumn = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@<TRIPOS>')) {
      section = line.substring(9).trim().toUpperCase();
      if (section === 'MOLECULE') {
        moleculeCount++;
        if (moleculeCount > 1) break;
        molLine = 0;
      }
      continue;
    }
    if (!line.trim() || line.trimStart().startsWith('#')) {
      if (section === 'MOLECULE' && molLine === 0 && !line.trim()) molLine++; // blank name line
      continue;
    }
    if (section === 'MOLECULE') {
      if (molLine === 0) molName = line.trim();
      molLine++;
    } else if (section === 'ATOM') {
      const t = tokens(line);
      if (t.length < 6) throw new Error(`Invalid MOL2 file: atom line ${i + 1} has too few columns.`);
      const x = Number(t[2]), y = Number(t[3]), z = Number(t[4]);
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
        throw new Error(`Invalid MOL2 file: could not read the coordinates on line ${i + 1}.`);
      }
      const charge = t.length > 8 ? Number(t[8]) : NaN;
      if (Number.isFinite(charge)) hasChargeColumn = true;
      raw.push({
        id: parseInt(t[0], 10),
        name: t[1],
        x,
        y,
        z,
        type: t[5],
        substId: t.length > 6 ? parseInt(t[6], 10) : NaN,
        substName: t.length > 7 ? t[7] : '',
        charge: Number.isFinite(charge) ? charge : 0,
      });
    } else if (section === 'BOND') {
      const t = tokens(line);
      if (t.length < 4) continue;
      const order = mol2BondOrder(t[3]);
      if (order === null) continue;
      rawBonds.push({ a: parseInt(t[1], 10), b: parseInt(t[2], 10), order });
    } else if (section === 'SUBSTRUCTURE') {
      const t = tokens(line);
      const id = parseInt(t[0], 10);
      const chain = t[5];
      if (Number.isFinite(id) && chain && chain !== '****' && chain !== '*') substChain.set(id, chain);
      const subType = t[6];
      if (Number.isFinite(id) && subType && !subType.startsWith('*')) substType.set(id, subType);
    }
  }
  if (moleculeCount === 0) throw new Error('Invalid MOL2 file: no @<TRIPOS>MOLECULE section found.');

  // Residue information: only when the file actually describes residues.
  const substIds = new Set(raw.map((a) => a.substId).filter((v) => Number.isFinite(v)));
  let useResidues = substIds.size > 1;
  if (!useResidues && raw.length) {
    const p = parseSubstName(raw[0].substName, raw[0].substId, substType.get(raw[0].substId));
    if (p && !PLACEHOLDER_SUBST.has(p.resName) && p.resName !== molName.toUpperCase()) useResidues = true;
  }

  // Formal charges: integral charge column with at least one non-zero value.
  const integral = hasChargeColumn && raw.some((a) => a.charge !== 0) && raw.every((a) => Math.abs(a.charge - Math.round(a.charge)) < 1e-4);

  const atoms: AtomInput[] = [];
  const indexById = new Map<number, number>();
  for (const a of raw) {
    if (a.type.toUpperCase() === 'LP') continue; // lone pairs are not atoms
    const atom: AtomInput = { element: elementFromSybyl(a.type, a.name), x: a.x, y: a.y, z: a.z, name: a.name };
    if (Number.isFinite(a.id)) atom.serial = a.id;
    if (useResidues) {
      const p = parseSubstName(a.substName, a.substId, substType.get(a.substId));
      if (p) {
        atom.resName = p.resName;
        atom.resSeq = p.resSeq;
        if (p.iCode) atom.iCode = p.iCode;
        const kind = classifyResidue(p.resName, false);
        atom.hetero = kind !== 'protein' && kind !== 'nucleic';
        const chain = substChain.get(a.substId);
        if (chain) atom.chain = chain;
      }
    }
    if (integral) {
      const c = Math.round(a.charge);
      if (c) atom.charge = c;
    }
    indexById.set(a.id, atoms.length);
    atoms.push(atom);
  }
  const bonds: BondInput[] = [];
  const degree = new Array<number>(atoms.length).fill(0);
  for (const b of rawBonds) {
    const ia = indexById.get(b.a);
    const ib = indexById.get(b.b);
    if (ia === undefined || ib === undefined) continue;
    bonds.push({ a: ia, b: ib, order: b.order });
    degree[ia]++;
    degree[ib]++;
  }
  if (!integral) {
    // Infer obvious formal charges from SYBYL types: quaternary / protonated amine N.4 → +1.
    let k = 0;
    for (const a of raw) {
      if (a.type.toUpperCase() === 'LP') continue;
      if (a.type.toUpperCase() === 'N.4' && degree[k] === 4) atoms[k].charge = 1;
      k++;
    }
  }

  const meta: MoleculeMeta = { format: 'mol2', hasBondOrders: true };
  const cleanName = molName && molName !== '*****' ? molName : '';
  if (cleanName) meta.title = cleanName;
  return buildMolecule(pickName('Untitled', name, cleanName), atoms, bonds, meta);
}

// ---------------------------------------------------------------------------
// SYBYL atom typing (writer)
// ---------------------------------------------------------------------------

/** SYBYL atom types for every atom, from elements, bond orders, charges and connectivity. */
export function sybylAtomTypes(mol: Molecule): string[] {
  const topo = getTopology(mol);
  const atoms = mol.atoms;
  const n = atoms.length;
  const nDouble = new Int32Array(n), nTriple = new Int32Array(n), nArom = new Int32Array(n);
  for (const b of mol.bonds) {
    const ia = topo.idToIndex.get(b.a);
    const ib = topo.idToIndex.get(b.b);
    if (ia === undefined || ib === undefined) continue;
    const arr = b.order === 2 ? nDouble : b.order === 3 ? nTriple : b.order === 1.5 ? nArom : null;
    if (arr) {
      arr[ia]++;
      arr[ib]++;
    }
  }
  const el = (i: number) => atoms[i].element;
  const unsaturated = (i: number) => nDouble[i] + nTriple[i] + nArom[i] > 0;
  /** Neighbours j of i connected by a bond of the given order. */
  const partners = (i: number, order: BondOrder) =>
    topo.atomBonds[i]
      .map((bi) => mol.bonds[bi])
      .filter((b) => b.order === order)
      .map((b) => topo.idToIndex.get(b.a === atoms[i].id ? b.b : b.a)!)
      .filter((j) => j !== undefined);
  /** True if C/S atom i has a double bond to O or S (carbonyl / thiocarbonyl). */
  const isCarbonylLike = (i: number) => partners(i, 2).some((j) => el(j) === 'O' || el(j) === 'S');
  const terminalOs = (i: number) => topo.neighbors[i].filter((j) => el(j) === 'O' && topo.neighbors[j].length === 1);
  /** Carboxylate / phosphate centre: ≥ 2 terminal O, at least one of them anionic or delocalised. */
  const isOxyAnionCentre = (i: number) => {
    if (el(i) !== 'C' && el(i) !== 'P') return false;
    const os = terminalOs(i);
    return os.length >= 2 && os.some((j) => (atoms[j].charge ?? 0) < 0 || nArom[j] > 0);
  };

  const types: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = atoms[i];
    const deg = topo.neighbors[i].length;
    const charge = a.charge ?? 0;
    switch (a.element) {
      case 'C': {
        if (nArom[i] > 0) types[i] = 'C.ar';
        else if (nTriple[i] > 0 || nDouble[i] >= 2) types[i] = 'C.1';
        else if (nDouble[i] === 1) {
          // Guanidinium carbon: three N neighbours, one of them cationic.
          const ns = topo.neighbors[i].filter((j) => el(j) === 'N');
          types[i] = deg === 3 && ns.length === 3 && ns.some((j) => (atoms[j].charge ?? 0) > 0) ? 'C.cat' : 'C.2';
        } else types[i] = charge > 0 && deg === 3 ? 'C.cat' : 'C.3';
        break;
      }
      case 'N': {
        if (nArom[i] > 0) types[i] = 'N.ar';
        else if (nTriple[i] > 0 || nDouble[i] >= 2) types[i] = 'N.1';
        else if (nDouble[i] === 1) types[i] = deg >= 3 ? 'N.pl3' : 'N.2';
        else if (deg >= 4) types[i] = 'N.4';
        else if (topo.neighbors[i].some((j) => el(j) === 'C' && isCarbonylLike(j))) types[i] = 'N.am';
        else if (topo.neighbors[i].some((j) => unsaturated(j))) types[i] = 'N.pl3';
        else types[i] = 'N.3';
        break;
      }
      case 'O': {
        const terminal = deg === 1;
        const centre = terminal ? topo.neighbors[i][0] : -1;
        if (terminal && isOxyAnionCentre(centre)) types[i] = 'O.co2';
        else if (nDouble[i] > 0 || nArom[i] > 0) types[i] = 'O.2';
        else types[i] = 'O.3';
        break;
      }
      case 'S': {
        const oxo = partners(i, 2).filter((j) => el(j) === 'O').length;
        if (oxo >= 2) types[i] = 'S.O2';
        else if (oxo === 1) types[i] = 'S.O';
        else if (nDouble[i] > 0 || nArom[i] > 0) types[i] = 'S.2';
        else types[i] = 'S.3';
        break;
      }
      case 'P':
        types[i] = 'P.3';
        break;
      case 'B':
        types[i] = unsaturated(i) ? 'B.2' : 'B.3';
        break;
      case 'X':
        types[i] = 'Du';
        break;
      default:
        types[i] = a.element; // H, halogens, metals: plain element symbol
    }
  }
  return types;
}

/** SYBYL bond type: 1, 2, 3, ar, or am for amide C(=O)–N single bonds. */
function sybylBondType(order: BondOrder, typeA: string, typeB: string, carbonylA: boolean, carbonylB: boolean): string {
  if (order === 1.5) return 'ar';
  if (order === 2) return '2';
  if (order === 3) return '3';
  if ((typeA === 'N.am' && carbonylB) || (carbonylA && typeB === 'N.am')) return 'am';
  return '1';
}

/** Right-justified number in `width` columns, always preceded by whitespace (wide values grow the field). */
function numField(v: number, width: number): string {
  const s = String(v);
  return s.length >= width ? ' ' + s : padLeft(s, width);
}

/** Serialize as MOL2. */
export function writeMol2(mol: Molecule): string {
  const topo = getTopology(mol);
  const types = sybylAtomTypes(mol);
  const n = mol.atoms.length;
  const indexOf = new Map<number, number>();
  mol.atoms.forEach((a, i) => indexOf.set(a.id, i + 1));
  const bonds = mol.bonds.filter((b) => indexOf.has(b.a) && indexOf.has(b.b));

  // Substructures: one per residue; atoms without residue info share one 'UNL' group.
  const substOfAtom = new Int32Array(n);
  const substs: { name: string; root: number; type: string; chain: string; resName: string }[] = [];
  const substByResidue = new Map<number, number>();
  let unlSubst = -1;
  for (let i = 0; i < n; i++) {
    const ri = topo.atomResidue[i];
    if (ri >= 0) {
      let s = substByResidue.get(ri);
      if (s === undefined) {
        const r = topo.residues[ri];
        s = substs.length;
        substs.push({
          name: `${r.resName}${r.resSeq}${r.iCode}`,
          root: i + 1,
          type: r.kind === 'protein' || r.kind === 'nucleic' ? 'RESIDUE' : 'GROUP',
          chain: r.chain,
          resName: r.resName,
        });
        substByResidue.set(ri, s);
      }
      substOfAtom[i] = s;
    } else {
      if (unlSubst < 0) {
        unlSubst = substs.length;
        substs.push({ name: `UNL${substs.length + 1}`, root: i + 1, type: 'GROUP', chain: '', resName: 'UNL' });
      }
      substOfAtom[i] = unlSubst;
    }
  }

  const hasCharges = mol.atoms.some((a) => a.charge);
  let molType = 'SMALL';
  if (topo.residues.some((r) => r.kind === 'protein')) molType = topo.residues.some((r) => r.kind === 'nucleic') ? 'BIOPOLYMER' : 'PROTEIN';
  else if (topo.residues.some((r) => r.kind === 'nucleic')) molType = 'NUCLEIC_ACID';

  const out: string[] = [];
  out.push('@<TRIPOS>MOLECULE');
  out.push(collapseSpaces(mol.name) || 'molecule');
  out.push(`${padLeft(n, 5)} ${padLeft(bonds.length, 5)} ${padLeft(substs.length, 5)} ${padLeft(0, 5)} ${padLeft(0, 5)}`);
  out.push(molType);
  out.push(hasCharges ? 'USER_CHARGES' : 'NO_CHARGES');
  out.push('');
  out.push('@<TRIPOS>ATOM');

  const elementCounters = new Map<string, number>();
  mol.atoms.forEach((a, i) => {
    let atomName = a.name?.trim().replace(/\s+/g, '_') ?? '';
    if (!atomName) {
      const k = (elementCounters.get(a.element) ?? 0) + 1;
      elementCounters.set(a.element, k);
      atomName = a.element + k;
    }
    const s = substs[substOfAtom[i]];
    out.push(
      padLeft(i + 1, 7) +
        ' ' +
        padRight(atomName, 8) +
        fmtFixed(a.x, 4, 11) +
        fmtFixed(a.y, 4, 11) +
        fmtFixed(a.z, 4, 11) +
        ' ' +
        padRight(types[i], 6) +
        numField(substOfAtom[i] + 1, 6) +
        '  ' +
        padRight(s.name, 8) +
        fmtFixed(a.charge ?? 0, 4, 10),
    );
  });

  // Carbonyl / thiocarbonyl carbons (for amide bond typing).
  const carbonyl = new Uint8Array(n);
  for (const b of bonds) {
    if (b.order !== 2) continue;
    const ia = indexOf.get(b.a)! - 1;
    const ib = indexOf.get(b.b)! - 1;
    const ea = mol.atoms[ia].element, eb = mol.atoms[ib].element;
    if (ea === 'C' && (eb === 'O' || eb === 'S')) carbonyl[ia] = 1;
    if (eb === 'C' && (ea === 'O' || ea === 'S')) carbonyl[ib] = 1;
  }
  out.push('@<TRIPOS>BOND');
  bonds.forEach((b, k) => {
    const ia = indexOf.get(b.a)!;
    const ib = indexOf.get(b.b)!;
    const type = sybylBondType(b.order, types[ia - 1], types[ib - 1], carbonyl[ia - 1] === 1, carbonyl[ib - 1] === 1);
    out.push(numField(k + 1, 6) + numField(ia, 6) + numField(ib, 6) + ' ' + type);
  });

  out.push('@<TRIPOS>SUBSTRUCTURE');
  substs.forEach((s, k) => {
    const dict = s.type === 'RESIDUE' ? 1 : 0;
    out.push(
      numField(k + 1, 6) + ' ' + padRight(s.name, 8) + numField(s.root, 6) + ' ' + padRight(s.type, 8) + padLeft(dict, 2) + ' ' +
        padRight(s.chain || '****', 4) + ' ' + padRight(s.resName, 4) + ' 0',
    );
  });
  return out.join('\n') + '\n';
}
