/**
 * Small molecule builders used by the chemistry tests (core/*.test.ts).
 * OWNER: chemistry agent. Not used by the app.
 */
import type { BondOrder, Molecule } from './types';
import { buildMolecule } from './molecule';

/** [element, x, y, z, charge?] */
export type AtomSpec = [string, number, number, number, number?];
/** [atom index, atom index, order?] */
export type BondSpec = [number, number, BondOrder?];

export function mk(name: string, atoms: AtomSpec[], bonds: BondSpec[] = [], source = 'test'): Molecule {
  return buildMolecule(
    name,
    atoms.map(([element, x, y, z, charge]) => (charge ? { element, x, y, z, charge } : { element, x, y, z })),
    bonds.map(([a, b, order]) => ({ a, b, order: order ?? 1 })),
    { source },
  );
}

/** Regular polygon ring of `n` atoms (radius r) in the xy plane, centred at (cx, cy). */
export function ringAtoms(elements: string[], r: number, cx = 0, cy = 0, phase = 0): AtomSpec[] {
  const n = elements.length;
  return elements.map((el, i) => {
    const t = phase + (2 * Math.PI * i) / n;
    return [el, cx + r * Math.cos(t), cy + r * Math.sin(t), 0] as AtomSpec;
  });
}

/** Ring bonds 0-1, 1-2, …, (n-1)-0 with the given orders (single order or per-bond list). */
export function ringBonds(n: number, order: BondOrder | BondOrder[] = 1, offset = 0): BondSpec[] {
  const out: BondSpec[] = [];
  for (let i = 0; i < n; i++) out.push([offset + i, offset + ((i + 1) % n), Array.isArray(order) ? order[i] : order]);
  return out;
}

/** Attach one H to each listed ring atom, radially outwards (1.08 Å). */
export function radialHydrogens(atoms: AtomSpec[], which: number[], cx = 0, cy = 0): { atoms: AtomSpec[]; bonds: BondSpec[] } {
  const outAtoms = atoms.slice();
  const bonds: BondSpec[] = [];
  for (const i of which) {
    const [, x, y] = atoms[i];
    const dx = x - cx;
    const dy = y - cy;
    const l = Math.hypot(dx, dy) || 1;
    outAtoms.push(['H', x + (1.08 * dx) / l, y + (1.08 * dy) / l, 0]);
    bonds.push([i, outAtoms.length - 1, 1]);
  }
  return { atoms: outAtoms, bonds };
}

/** Benzene C6H6 with aromatic (1.5) bonds; atoms 0–5 carbons, 6–11 hydrogens. */
export function benzene(): Molecule {
  const ring = ringAtoms(['C', 'C', 'C', 'C', 'C', 'C'], 1.39);
  const h = radialHydrogens(ring, [0, 1, 2, 3, 4, 5]);
  return mk('benzene', h.atoms, [...ringBonds(6, 1.5), ...h.bonds]);
}

/** Five-membered aromatic ring with the heteroatom at index 0; H on the listed atoms. */
export function fiveRing(name: string, elements: string[], hOn: number[]): Molecule {
  const ring = ringAtoms(elements, 1.19);
  const h = radialHydrogens(ring, hOn);
  return mk(name, h.atoms, [...ringBonds(5, 1.5), ...h.bonds]);
}

/** Caffeine graph (Kekulé form, explicit H; coordinates are irrelevant for formula/valence tests). */
export function caffeine(): Molecule {
  // Heavy atoms: 0 N1, 1 C2, 2 O2, 3 N3, 4 C4, 5 C5, 6 C6, 7 O6, 8 N7, 9 C8, 10 N9, 11 C1m, 12 C3m, 13 C7m
  const atoms: AtomSpec[] = [
    ['N', 0, 0, 0], ['C', 1, 0, 0], ['O', 2, 0, 0], ['N', 1, 1, 0], ['C', 0, 2, 0], ['C', -1, 1, 0],
    ['C', -1, 0, 0], ['O', -2, 0, 0], ['N', -2, 2, 0], ['C', -1, 3, 0], ['N', 0, 3, 0],
    ['C', 0, -1, 0], ['C', 2, 1, 0], ['C', -3, 2, 0],
  ];
  const bonds: BondSpec[] = [
    [0, 1], [1, 2, 2], [1, 3], [3, 4], [4, 5, 2], [5, 6], [6, 0], [6, 7, 2], [5, 8], [8, 9], [9, 10, 2],
    [10, 4], [0, 11], [3, 12], [8, 13],
  ];
  // H: 3 on each methyl, 1 on C8.
  for (const c of [11, 12, 13, 13, 12, 11, 11, 12, 13, 9]) {
    atoms.push(['H', 0, 0, 0]);
    bonds.push([c, atoms.length - 1]);
  }
  return mk('caffeine', atoms, bonds);
}
