/**
 * Bond orders of standard amino acids and nucleotides from residue templates (PDB atom names,
 * following the wwPDB Chemical Component Dictionary). OWNER: structure agent.
 *
 * Applied by perceiveBondOrders to protein / nucleic residues whose bonds are all single (files
 * without explicit orders). A template order is only applied when the two atoms are bonded and the
 * bond is short enough for that order, which protects against unusual chemistry (e.g. reduced
 * residues) hiding behind a standard name.
 */
import type { BondOrder, Molecule } from './types';
import { getTopology } from './molecule';
import { moleculePositions } from './structure-grid';
import { isHydrogen, isMetal } from './structure-chem';

type Pair = [string, string, BondOrder];

const PHENYL: Pair[] = [
  ['CG', 'CD1', 1.5], ['CD1', 'CE1', 1.5], ['CE1', 'CZ', 1.5], ['CZ', 'CE2', 1.5], ['CE2', 'CD2', 1.5], ['CD2', 'CG', 1.5],
];

/** Side-chain templates by one-letter code (backbone C=O is added for every amino acid). */
const AMINO_TEMPLATES: Record<string, Pair[]> = {
  D: [['CG', 'OD1', 2]],
  E: [['CD', 'OE1', 2]],
  N: [['CG', 'OD1', 2]],
  Q: [['CD', 'OE1', 2]],
  R: [['CZ', 'NH2', 2]],
  F: PHENYL,
  Y: PHENYL,
  // Neutral Nε2-H tautomer (5-rings stay in Kekulé form); see HIS_DELTA for Nδ1-H.
  H: [['CG', 'CD2', 2], ['ND1', 'CE1', 2]],
  W: [
    ['CG', 'CD1', 2],
    ['CD2', 'CE2', 1.5], ['CE2', 'CZ2', 1.5], ['CZ2', 'CH2', 1.5], ['CH2', 'CZ3', 1.5], ['CZ3', 'CE3', 1.5], ['CE3', 'CD2', 1.5],
  ],
};

/** Nδ1-H tautomer of histidine (HID / HSD, or a hydrogen on ND1 only). */
const HIS_DELTA: Pair[] = [['CG', 'CD2', 2], ['CE1', 'NE2', 2]];
const HIS_DELTA_NAMES = new Set(['HID', 'HSD']);

const PHOSPHATE: Pair[] = [['P', 'OP1', 2]];

const BASE_TEMPLATES: Record<string, Pair[]> = {
  // Adenine: aromatic pyrimidine ring, C8=N7 in the imidazole ring.
  A: [
    ['N1', 'C2', 1.5], ['C2', 'N3', 1.5], ['N3', 'C4', 1.5], ['C4', 'C5', 1.5], ['C5', 'C6', 1.5], ['C6', 'N1', 1.5],
    ['N7', 'C8', 2],
  ],
  // Guanine (and inosine): keto form.
  G: [['C6', 'O6', 2], ['C2', 'N3', 2], ['C4', 'C5', 2], ['N7', 'C8', 2]],
  I: [['C6', 'O6', 2], ['C2', 'N3', 2], ['C4', 'C5', 2], ['N7', 'C8', 2]],
  C: [['C2', 'O2', 2], ['N3', 'C4', 2], ['C5', 'C6', 2]],
  T: [['C2', 'O2', 2], ['C4', 'O4', 2], ['C5', 'C6', 2]],
  U: [['C2', 'O2', 2], ['C4', 'O4', 2], ['C5', 'C6', 2]],
};

/** Residues whose name maps to a standard letter but whose chemistry differs from the template. */
const SKIP_RESIDUES = new Set(['H2U', 'UNK', 'ACE', 'NME', 'NH2']);

/** Old (PDB v2) atom names → current names; CHARMM (OT1/OT2) and GROMACS (OC1/OC2) C-terminal oxygens. */
const NAME_ALIASES: Record<string, string> = { O1P: 'OP1', O2P: 'OP2', O3P: 'OP3', OT1: 'O', OT2: 'OXT', OC1: 'O', OC2: 'OXT' };

/**
 * Equivalent partners of a template's double-bond atom (other carboxylate / phosphate O, other
 * guanidinium N). The file's hydrogens and formal charges decide which one carries the double bond:
 * not an O that bears an H or a negative charge (ASH/GLH with the H on OD1/OE1, 'OD1 1-'), and
 * preferably the N with a positive charge or the fewest bonds (neutral ARN).
 */
const EQUIVALENT: Record<string, string[]> = { O: ['OXT'], OD1: ['OD2'], OE1: ['OE2'], OP1: ['OP2'], NH2: ['NH1', 'NE'] };

/** Maximum bond length (Å) accepted for a templated order between two elements. */
function maxLength(e1: string, e2: string, order: BondOrder): number {
  const key = e1 < e2 ? `${e1}${e2}` : `${e2}${e1}`;
  const base: Record<string, number> = { CC: 1.5, CN: 1.42, CO: 1.36, NO: 1.36, OP: 1.6 };
  return (base[key] ?? 1.6) + (order === 1.5 ? 0.02 : 0);
}

/**
 * Returns per-bond orders for standard residues (Map bond index → order); empty when nothing applies.
 */
export function templateBondOrders(mol: Molecule): Map<number, BondOrder> {
  const out = new Map<number, BondOrder>();
  const topo = getTopology(mol);
  const pos = moleculePositions(mol);
  for (const res of topo.residues) {
    if (res.kind !== 'protein' && res.kind !== 'nucleic') continue;
    if (SKIP_RESIDUES.has(res.resName)) continue;
    // Atom name → index (first occurrence wins, i.e. the first altLoc).
    const byName = new Map<string, number>();
    for (const ai of res.atomIndices) {
      const raw = (mol.atoms[ai].name ?? '').toUpperCase().replace(/\*/g, "'");
      const name = NAME_ALIASES[raw] ?? raw;
      if (!byName.has(name)) byName.set(name, ai);
    }
    const chargeOf = (n: string) => {
      const i = byName.get(n);
      return i === undefined ? 0 : mol.atoms[i].charge ?? 0;
    };
    let side = res.kind === 'protein' ? AMINO_TEMPLATES[res.oneLetter] ?? [] : BASE_TEMPLATES[res.oneLetter] ?? [];
    if (res.kind === 'protein' && res.oneLetter === 'H') {
      // Tautomer from a file charge (the cationic N carries the ring double bond), else from the ring
      // hydrogens when the file has them, else from the residue name.
      const hasH = (n: string) => {
        const i = byName.get(n);
        return i !== undefined && topo.neighbors[i].some((j) => isHydrogen(mol.atoms[j].element));
      };
      const hd1 = hasH('ND1');
      const he2 = hasH('NE2');
      const plusD = chargeOf('ND1') > 0;
      const plusE = chargeOf('NE2') > 0;
      const delta = plusD !== plusE ? plusE : (hd1 && !he2) || (!hd1 && !he2 && HIS_DELTA_NAMES.has(res.resName));
      if (delta) side = HIS_DELTA;
    }
    // Respect explicit orders: skip residues that already have a non-single bond.
    let explicit = false;
    for (const ai of res.atomIndices) {
      for (const bi of topo.atomBonds[ai]) if (mol.bonds[bi].order !== 1) explicit = true;
    }
    if (explicit) continue;
    /** Score of an atom for taking a template double bond (lower is better). */
    const score = (n: string) => {
      const i = byName.get(n)!;
      const q = chargeOf(n);
      const degree = topo.neighbors[i].filter((j) => !isMetal(mol.atoms[j].element)).length;
      return degree + (mol.atoms[i].element === 'O' ? (q < 0 ? 100 : 0) : q > 0 ? -100 : 0);
    };
    /** Atoms to try for a template pair's second atom: equivalents by score, ties keep the template's atom first. */
    const candidates = (n: string, order: BondOrder): string[] => {
      const alts = order === 2 ? EQUIVALENT[n]?.filter((x) => byName.has(x)) : undefined;
      if (!alts?.length || !byName.has(n)) return [n];
      return [n, ...alts]
        .map((x, k) => ({ x, k, s: score(x) }))
        .sort((p, q) => p.s - q.s || p.k - q.k)
        .map((c) => c.x);
    };
    const pairs: Pair[] = res.kind === 'protein' ? [['C', 'O', 2], ...side] : [...PHOSPHATE, ...side];
    for (const [n1, n2, order] of pairs) {
      const i = byName.get(n1);
      if (i === undefined) continue;
      for (const name of candidates(n2, order)) {
        const j = byName.get(name);
        if (j === undefined) continue;
        const bi = topo.atomBonds[i].find((b) => {
          const bond = mol.bonds[b];
          const other = topo.idToIndex.get(bond.a) === i ? topo.idToIndex.get(bond.b) : topo.idToIndex.get(bond.a);
          return other === j;
        });
        if (bi === undefined) continue;
        const d = Math.hypot(pos[3 * i] - pos[3 * j], pos[3 * i + 1] - pos[3 * j + 1], pos[3 * i + 2] - pos[3 * j + 2]);
        if (d > maxLength(mol.atoms[i].element, mol.atoms[j].element, order)) continue;
        out.set(bi, order);
        break;
      }
    }
  }
  return out;
}

/**
 * Formal charges of protonation states in standard residues that carry explicit hydrogens (MD and
 * NMR files rarely fill the charge column): with the final bond orders `orders` (per bond index),
 * N with four bonds' worth of valence is protonated (+1: LYS NZ, ARG NH2, HIP, N-termini) and a
 * terminal singly bonded O next to a C=O / P=O is deprotonated (−1: ASP, GLU, C-termini,
 * phosphates). Residues without hydrogens and atoms that already have a charge are left alone.
 * Returns atom index → charge.
 */
export function protonationCharges(mol: Molecule, orders: ArrayLike<number>): Map<number, number> {
  const out = new Map<number, number>();
  const topo = getTopology(mol);
  const atoms = mol.atoms;
  const other = (bi: number, i: number) => {
    const b = mol.bonds[bi];
    const ia = topo.idToIndex.get(b.a);
    return ia === i ? topo.idToIndex.get(b.b) : ia;
  };
  for (const res of topo.residues) {
    if (res.kind !== 'protein' && res.kind !== 'nucleic') continue;
    if (SKIP_RESIDUES.has(res.resName)) continue;
    if (!res.atomIndices.some((ai) => isHydrogen(atoms[ai].element))) continue;
    for (const i of res.atomIndices) {
      const a = atoms[i];
      if (a.charge || (a.element !== 'N' && a.element !== 'O')) continue;
      let sum = 0;
      let degree = 0;
      let partner = -1;
      let partnerBond = -1;
      for (const bi of topo.atomBonds[i]) {
        const j = other(bi, i);
        if (j === undefined || j === i || isMetal(atoms[j].element)) continue;
        sum += orders[bi];
        degree++;
        partner = j;
        partnerBond = bi;
      }
      if (a.element === 'N') {
        if (Math.abs(sum - 4) < 1e-6) out.set(i, 1);
        continue;
      }
      // O: terminal, single bond to a C / P that also has a double-bonded oxygen.
      if (degree !== 1 || orders[partnerBond] !== 1) continue;
      const pe = atoms[partner].element;
      if (pe !== 'C' && pe !== 'P') continue;
      const oxo = topo.atomBonds[partner].some((bi) => {
        const j = other(bi, partner);
        return j !== undefined && j !== i && atoms[j].element === 'O' && orders[bi] === 2;
      });
      if (oxo) out.set(i, -1);
    }
  }
  return out;
}
