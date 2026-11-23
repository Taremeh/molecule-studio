/**
 * Which cylinders ("sticks") to draw for the bonds of an atom-based representation, and where.
 * Pure data (no three.js) so it can be unit-tested. OWNER: render-core.
 *
 * Every stick is a cylinder along the bond A→B between fractions t0..t1 of the bond, shifted by
 * `offset` Å (unscaled) along the bond's offset direction (perpendicular to the bond, in the plane of
 * the reference atom `bondRef`, see math3d.bondOffsetDirection). Bonds are split at the midpoint so
 * each half carries its own atom's colour.
 *
 * Ball-and-stick (r = 0.12):
 *   single      2 sticks                       r
 *   double      4 sticks at ±0.14              0.6 r
 *   triple      6 sticks at 0, ±0.19           0.5 r
 *   aromatic    2 full sticks + 2 short inner dashes (towards the ring) at +0.23, r = 0.42 r
 * Licorice (r = 0.2): every bond drawn as a single bond.
 * All lengths are multiplied by the representation's scale at matrix-build time.
 */
import type { Molecule } from '../core/types';
import { getTopology } from '../core/molecule';

export const BALL_STICK_BOND_RADIUS = 0.12;
export const LICORICE_RADIUS = 0.2;

export const DOUBLE_OFFSET = 0.14;
export const DOUBLE_RADIUS = BALL_STICK_BOND_RADIUS * 0.6;
export const TRIPLE_OFFSET = 0.19;
export const TRIPLE_RADIUS = BALL_STICK_BOND_RADIUS * 0.5;
export const AROMATIC_OFFSET = 0.23;
export const AROMATIC_RADIUS = BALL_STICK_BOND_RADIUS * 0.42;
/** Fractions of the bond covered by the two inner aromatic dashes (gap in the middle). */
export const AROMATIC_DASHES: readonly [number, number, number, number] = [0.2, 0.44, 0.56, 0.8];

export type StickStyle = 'ball-and-stick' | 'licorice';

export interface StickLayout {
  /** Number of sticks (cylinder instances). */
  count: number;
  /** Atom indices of the bond endpoints, per stick. */
  a: Int32Array;
  b: Int32Array;
  t0: Float32Array;
  t1: Float32Array;
  /** Unscaled offset along the bond's offset direction (0 = on the axis). */
  offset: Float32Array;
  /** Unscaled cylinder radius. */
  radius: Float32Array;
  /** Atom index whose colour the stick takes. */
  colorAtom: Int32Array;
  /** Index (into `bonds`) of the displayed bond each stick belongs to. */
  stickBond: Int32Array;

  /** Displayed bonds: indices into mol.bonds. */
  bonds: Int32Array;
  /** Per displayed bond: atom index of the reference atom for the offset plane, or −1. */
  bondRef: Int32Array;
  /** Per displayed bond: first stick and number of sticks. */
  bondFirstStick: Int32Array;
  bondStickCount: Uint8Array;
  /** Per displayed bond: unscaled pick radius (covers all its sticks). */
  bondPickRadius: Float32Array;
  /** mol.bonds index → displayed bond index (−1 if not displayed). */
  bondToDisplayed: Int32Array;
}

/**
 * Reference atom that defines the plane in which a multiple bond's cylinders are offset.
 * Aromatic bonds: prefer a neighbour joined by another aromatic bond (a ring atom), so the inner dash
 * points into the ring. Otherwise prefer heavy-atom neighbours of A, then of B, then any neighbour.
 */
export function chooseReferenceAtom(mol: Molecule, ia: number, ib: number, aromatic: boolean): number {
  const topo = getTopology(mol);
  const atoms = mol.atoms;
  const nbA = topo.neighbors[ia] ?? [];
  const nbB = topo.neighbors[ib] ?? [];
  if (aromatic) {
    const ringNeighbour = (center: number, other: number): number => {
      const bonds = topo.atomBonds[center];
      for (const bi of bonds) {
        const bond = mol.bonds[bi];
        if (bond.order !== 1.5) continue;
        const j = topo.idToIndex.get(bond.a === atoms[center].id ? bond.b : bond.a);
        if (j !== undefined && j !== other) return j;
      }
      return -1;
    };
    const r = ringNeighbour(ia, ib);
    if (r >= 0) return r;
    const r2 = ringNeighbour(ib, ia);
    if (r2 >= 0) return r2;
  }
  for (const j of nbA) if (j !== ib && atoms[j].element !== 'H') return j;
  for (const j of nbB) if (j !== ia && atoms[j].element !== 'H') return j;
  for (const j of nbA) if (j !== ib) return j;
  for (const j of nbB) if (j !== ia) return j;
  return -1;
}

/**
 * Build the stick layout for the bonds whose two atoms are both displayed (`displayed[atomIndex]`).
 */
export function buildStickLayout(mol: Molecule, displayed: Uint8Array, style: StickStyle): StickLayout {
  const topo = getTopology(mol);
  const nb = mol.bonds.length;
  const bondToDisplayed = new Int32Array(nb).fill(-1);
  const shown: number[] = [];
  let sticks = 0;
  for (let bi = 0; bi < nb; bi++) {
    const bond = mol.bonds[bi];
    const ia = topo.idToIndex.get(bond.a);
    const ib = topo.idToIndex.get(bond.b);
    if (ia === undefined || ib === undefined || ia === ib) continue;
    if (!displayed[ia] || !displayed[ib]) continue;
    bondToDisplayed[bi] = shown.length;
    shown.push(bi);
    sticks += sticksPerBond(style, bond.order);
  }
  const nd = shown.length;
  const L: StickLayout = {
    count: sticks,
    a: new Int32Array(sticks),
    b: new Int32Array(sticks),
    t0: new Float32Array(sticks),
    t1: new Float32Array(sticks),
    offset: new Float32Array(sticks),
    radius: new Float32Array(sticks),
    colorAtom: new Int32Array(sticks),
    stickBond: new Int32Array(sticks),
    bonds: Int32Array.from(shown),
    bondRef: new Int32Array(nd).fill(-1),
    bondFirstStick: new Int32Array(nd),
    bondStickCount: new Uint8Array(nd),
    bondPickRadius: new Float32Array(nd),
    bondToDisplayed,
  };
  let s = 0;
  const push = (d: number, ia: number, ib: number, t0: number, t1: number, off: number, r: number, colorAtom: number) => {
    L.a[s] = ia;
    L.b[s] = ib;
    L.t0[s] = t0;
    L.t1[s] = t1;
    L.offset[s] = off;
    L.radius[s] = r;
    L.colorAtom[s] = colorAtom;
    L.stickBond[s] = d;
    s++;
  };
  const halves = (d: number, ia: number, ib: number, off: number, r: number) => {
    push(d, ia, ib, 0, 0.5, off, r, ia);
    push(d, ia, ib, 0.5, 1, off, r, ib);
  };
  for (let d = 0; d < nd; d++) {
    const bond = mol.bonds[shown[d]];
    const ia = topo.idToIndex.get(bond.a)!;
    const ib = topo.idToIndex.get(bond.b)!;
    L.bondFirstStick[d] = s;
    if (style === 'licorice') {
      halves(d, ia, ib, 0, LICORICE_RADIUS);
      L.bondPickRadius[d] = LICORICE_RADIUS;
    } else if (bond.order === 2) {
      L.bondRef[d] = chooseReferenceAtom(mol, ia, ib, false);
      halves(d, ia, ib, DOUBLE_OFFSET, DOUBLE_RADIUS);
      halves(d, ia, ib, -DOUBLE_OFFSET, DOUBLE_RADIUS);
      L.bondPickRadius[d] = DOUBLE_OFFSET + DOUBLE_RADIUS;
    } else if (bond.order === 3) {
      L.bondRef[d] = chooseReferenceAtom(mol, ia, ib, false);
      halves(d, ia, ib, 0, TRIPLE_RADIUS);
      halves(d, ia, ib, TRIPLE_OFFSET, TRIPLE_RADIUS);
      halves(d, ia, ib, -TRIPLE_OFFSET, TRIPLE_RADIUS);
      L.bondPickRadius[d] = TRIPLE_OFFSET + TRIPLE_RADIUS;
    } else if (bond.order === 1.5) {
      L.bondRef[d] = chooseReferenceAtom(mol, ia, ib, true);
      halves(d, ia, ib, 0, BALL_STICK_BOND_RADIUS);
      const [d0, d1, d2, d3] = AROMATIC_DASHES;
      push(d, ia, ib, d0, d1, AROMATIC_OFFSET, AROMATIC_RADIUS, ia);
      push(d, ia, ib, d2, d3, AROMATIC_OFFSET, AROMATIC_RADIUS, ib);
      L.bondPickRadius[d] = Math.max(BALL_STICK_BOND_RADIUS, (AROMATIC_OFFSET + AROMATIC_RADIUS) * 0.75);
    } else {
      halves(d, ia, ib, 0, BALL_STICK_BOND_RADIUS);
      L.bondPickRadius[d] = BALL_STICK_BOND_RADIUS;
    }
    L.bondStickCount[d] = s - L.bondFirstStick[d];
  }
  return L;
}

export function sticksPerBond(style: StickStyle, order: number): number {
  if (style === 'licorice') return 2;
  if (order === 2) return 4;
  if (order === 3) return 6;
  if (order === 1.5) return 4;
  return 2;
}
