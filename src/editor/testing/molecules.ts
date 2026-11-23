/**
 * TEST ONLY — small molecules with realistic geometry for the editor's tests.
 */
import type { BondOrder, Molecule, Vec3 } from '../../core/types';
import { buildMolecule, type AtomInput, type BondInput } from '../../core/molecule';

/** Tetrahedral unit directions. */
export const TETRA: Vec3[] = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
].map(([x, y, z]) => [x / Math.sqrt(3), y / Math.sqrt(3), z / Math.sqrt(3)] as Vec3);

export interface AtomSpec {
  el: string;
  at: Vec3;
  charge?: number;
}

/** Build a molecule from atom specs and [i, j, order?] bonds (array indices); ids are 1-based indices. */
export function mol(atoms: AtomSpec[], bonds: [number, number, BondOrder?][] = [], name = 'test'): Molecule {
  const ai: AtomInput[] = atoms.map((a) => ({ element: a.el, x: a.at[0], y: a.at[1], z: a.at[2], charge: a.charge }));
  const bi: BondInput[] = bonds.map(([a, b, order]) => ({ a, b, order: order ?? 1 }));
  return buildMolecule(name, ai, bi, { source: 'editor' });
}

/**
 * Heavy atom at `center` with `nH` hydrogens at tetrahedral positions (C–H 1.09, N–H 1.01, O–H 0.96 Å).
 * With `xSign` all hydrogens point to that side of x (an "umbrella"), keeping them away from a partner.
 */
export function withHydrogens(el: string, center: Vec3, nH: number, start = 0, xSign?: 1 | -1): { atoms: AtomSpec[]; bonds: [number, number][] } {
  const len = el === 'C' ? 1.09 : el === 'N' ? 1.01 : el === 'O' ? 0.96 : 1.0;
  const atoms: AtomSpec[] = [{ el, at: center }];
  const bonds: [number, number][] = [];
  for (let k = 0; k < nH; k++) {
    const d = TETRA[k];
    const dx = xSign ? xSign * Math.abs(d[0]) : d[0];
    atoms.push({ el: 'H', at: [center[0] + dx * len, center[1] + d[1] * len, center[2] + d[2] * len] });
    bonds.push([start, start + k + 1]);
  }
  return { atoms, bonds };
}

/** CH4 at the origin: atom 1 = C, atoms 2–5 = H. */
export function methane(center: Vec3 = [0, 0, 0]): Molecule {
  const g = withHydrogens('C', center, 4);
  return mol(g.atoms, g.bonds, 'methane');
}

/**
 * Two unbonded groups (e.g. CH3 + CH3) in one molecule, `a` to the left of `b` on the x axis, with
 * their hydrogens pointing away from each other. Ids: a's heavy atom = 1, its H follow; then b.
 */
export function twoGroups(a: { el: string; nH: number; at: Vec3 }, b: { el: string; nH: number; at: Vec3 }): Molecule {
  const g1 = withHydrogens(a.el, a.at, a.nH, 0, -1);
  const g2 = withHydrogens(b.el, b.at, b.nH, g1.atoms.length, 1);
  return mol([...g1.atoms, ...g2.atoms], [...g1.bonds, ...g2.bonds]);
}

/** Ethane-like C–C (1.54 Å along x) with 3 H on each carbon: ids 1 = C1, 2–4 = H, 5 = C2, 6–8 = H. */
export function ethane(): Molecule {
  const c1: Vec3 = [0, 0, 0];
  const c2: Vec3 = [1.54, 0, 0];
  const atoms: AtomSpec[] = [{ el: 'C', at: c1 }];
  const bonds: [number, number, BondOrder?][] = [];
  const hDirs = (sign: number): Vec3[] => [
    [sign * -0.36, 1.03, 0],
    [sign * -0.36, -0.51, 0.89],
    [sign * -0.36, -0.51, -0.89],
  ];
  for (const d of hDirs(1)) {
    atoms.push({ el: 'H', at: [c1[0] + d[0], d[1], d[2]] });
    bonds.push([0, atoms.length - 1]);
  }
  atoms.push({ el: 'C', at: c2 });
  const i2 = atoms.length - 1;
  bonds.push([0, i2]);
  for (const d of hDirs(-1)) {
    atoms.push({ el: 'H', at: [c2[0] + d[0], d[1], d[2]] });
    bonds.push([i2, atoms.length - 1]);
  }
  return mol(atoms, bonds, 'ethane');
}

export function counts(m: Molecule): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of m.atoms) out[a.element] = (out[a.element] ?? 0) + 1;
  return out;
}
