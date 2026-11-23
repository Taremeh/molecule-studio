/**
 * Vector math and molecular geometry helpers.
 * OWNER: chemistry agent. CONTRACT: keep exported names & signatures.
 */
import type { BondOrder, Molecule, Vec3 } from './types';
import { getElement } from './elements';
import { getTopology } from './molecule';
import { valenceOf } from './chemistry';

// --- basic vector ops (implemented; extend freely) ---------------------------
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [1, 0, 0];
};
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Angle a-b-c in degrees (b is the vertex). */
export function angle(a: Vec3, b: Vec3, c: Vec3): number {
  const u = sub(a, b);
  const v = sub(c, b);
  const d = dot(u, v) / (length(u) * length(v) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

/** Dihedral a-b-c-d in degrees, range (-180, 180]. */
export function dihedral(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const b0 = sub(a, b);
  const b1 = normalize(sub(c, b));
  const b2 = sub(d, c);
  const v = sub(b0, scale(b1, dot(b0, b1)));
  const w = sub(b2, scale(b1, dot(b2, b1)));
  const x = dot(v, w);
  const y = dot(cross(b1, v), w);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Rotate point p around the axis through `origin` with unit direction `axis` by `deg` degrees (Rodrigues). */
export function rotateAround(p: Vec3, origin: Vec3, axis: Vec3, deg: number): Vec3 {
  const t = (deg * Math.PI) / 180;
  const k = normalize(axis);
  const v = sub(p, origin);
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return add(origin, [
    v[0] * cos + kv[0] * sin + k[0] * kd * (1 - cos),
    v[1] * cos + kv[1] * sin + k[1] * kd * (1 - cos),
    v[2] * cos + kv[2] * sin + k[2] * kd * (1 - cos),
  ]);
}

/** Component of v perpendicular to the unit vector `axis`. */
export function rejection(v: Vec3, axis: Vec3): Vec3 {
  return sub(v, scale(axis, dot(v, axis)));
}

/** A deterministic unit vector perpendicular to v (v need not be normalized). */
export function anyPerpendicular(v: Vec3): Vec3 {
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  // Cross with the coordinate axis least aligned with v.
  const other: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return normalize(cross(v, other));
}

/** 3×3 rotation matrix, row-major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Rotation matrix about a unit axis by `deg` degrees. */
export function axisAngleMatrix(axis: Vec3, deg: number): Mat3 {
  const [x, y, z] = normalize(axis);
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

/** Rotation matrix that maps unit vector `from` onto unit vector `to` (shortest arc). */
export function rotationBetween(from: Vec3, to: Vec3): Mat3 {
  const f = normalize(from);
  const t = normalize(to);
  const c = Math.max(-1, Math.min(1, dot(f, t)));
  if (c > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -1 + 1e-12) return axisAngleMatrix(anyPerpendicular(f), 180);
  return axisAngleMatrix(cross(f, t), (Math.acos(c) * 180) / Math.PI);
}

// --- molecule geometry --------------------------------------------------------

const pos = (a: { x: number; y: number; z: number }): Vec3 => [a.x, a.y, a.z];

/** Measure distance (2 ids, Å), angle (3 ids, °) or dihedral (4 ids, °). NaN if an atom is missing. */
export function measureAtoms(mol: Molecule, atomIds: number[]): number {
  if (atomIds.length < 2 || atomIds.length > 4) return NaN;
  const topo = getTopology(mol);
  const p: Vec3[] = [];
  for (const id of atomIds) {
    const idx = topo.idToIndex.get(id);
    if (idx === undefined) return NaN;
    p.push(pos(mol.atoms[idx]));
  }
  if (p.length === 2) return distance(p[0], p[1]);
  if (p.length === 3) return angle(p[0], p[1], p[2]);
  return dihedral(p[0], p[1], p[2], p[3]);
}

/**
 * Typical experimental X–H single-bond lengths (Å). Covalent-radius sums underestimate these
 * (Cordero C + H = 1.07 Å vs. the usual 1.09 Å), so idealBondLength uses this table for X–H.
 */
export const XH_BOND_LENGTHS: Record<string, number> = {
  H: 0.74,
  B: 1.19,
  C: 1.09,
  N: 1.01,
  O: 0.96,
  F: 0.92,
  Si: 1.48,
  P: 1.42,
  S: 1.34,
  Cl: 1.27,
  Ge: 1.53,
  As: 1.52,
  Se: 1.46,
  Br: 1.41,
  Te: 1.66,
  I: 1.61,
};

/**
 * Typical experimental lengths (Å) for bonds where summed covalent radii are poor (polar bonds of
 * second-row elements; e.g. rP + rO = 1.73 Å vs ≈ 1.60 Å observed in phosphates), indexed by the
 * element pair in alphabetical order ('O-P') and the bond order. Single source of truth for
 * idealBondLength and therefore for the force field's rest lengths (ff-model restLength).
 * Sources: CSD / Allen et al. (1987) typical values.
 *
 * Order 1.5 entries are the delocalised bonds such files write as aromatic: terminal P–O of
 * phosphates (MOL2 'ar' to O.co2; PO₄³⁻ / phosphate monoester dianions ≈ 1.51–1.53 Å), terminal
 * S–O of sulfonates / sulfates (≈ 1.45–1.48 Å) and the S(II)–N bonds of aromatic rings (isothiazole,
 * 1,2,5-thiadiazole 1.63 Å, 2,1,3-benzothiadiazole ≈ 1.61–1.62 Å). The table's single S–N (1.63 Å,
 * sulfonamides) and S–O / P–O values are those of S(VI) / P(V), so the mean of single and double does
 * not describe these bonds; the chosen values also stay clear of the P=O / S=O / S=N cut-offs of the
 * bond-order perception for XYZ / PDB ligands (core/structure-bondorders.ts: 1.54, 1.505 and 1.61 Å),
 * so a minimised phosphate / sulfonate is read back with its P=O / S=O bonds, and a thiadiazole S–N
 * as single.
 */
export const POLAR_BOND_LENGTHS: Readonly<Record<string, Readonly<Partial<Record<1 | 1.5 | 2 | 3, number>>>>> = {
  'O-P': { 1: 1.6, 1.5: 1.52, 2: 1.48 },
  'O-S': { 1: 1.58, 1.5: 1.47, 2: 1.44 },
  'N-S': { 1: 1.63, 1.5: 1.62, 2: 1.54 },
  'N-P': { 1: 1.67, 2: 1.57 },
  'F-P': { 1: 1.56 },
  'F-S': { 1: 1.56 },
  'O-Si': { 1: 1.64 },
  'Cl-P': { 1: 2.04 },
  'O-O': { 1: 1.47 },
};

const pairKey = (a: string, b: string) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Covalent-radius rule: summed radii, shortened for double (0.87×) / triple (0.78×) / aromatic (0.93×) bonds. */
function radiusBondLength(elementA: string, elementB: string, order: BondOrder): number {
  const single = getElement(elementA).covalentRadius + getElement(elementB).covalentRadius;
  const f = order === 2 ? 0.87 : order === 3 ? 0.78 : order === 1.5 ? 0.93 : 1;
  return single * f;
}

/**
 * Ideal bond length (Å) from covalent radii, shortened for double (~0.87×) / triple (~0.78×) / aromatic (~0.93×) bonds.
 * Single bonds to hydrogen use typical experimental X–H lengths (XH_BOND_LENGTHS) when known, and
 * polar bonds of second-row elements the experimental POLAR_BOND_LENGTHS (P–O, S=O, S–N, Si–O, O–O…).
 * Order 1.5 for a pair in POLAR_BOND_LENGTHS is its explicit 1.5 entry (P–O 1.52, S–O 1.47,
 * S–N 1.62 Å), else the mean of its single and double lengths (each from the table, else from the
 * radius rule), so it always lies between them; the radius rule alone would put it above the
 * experimental single bond (rP + rO = 1.73 Å × 0.93).
 * Delocalised terminal groups (carboxylate, nitro) are not order 1.5 here: see resonanceBondLength.
 */
export function idealBondLength(elementA: string, elementB: string, order: BondOrder = 1): number {
  if (order === 1) {
    if (elementA === 'H' && XH_BOND_LENGTHS[elementB] !== undefined) return XH_BOND_LENGTHS[elementB];
    if (elementB === 'H' && XH_BOND_LENGTHS[elementA] !== undefined) return XH_BOND_LENGTHS[elementA];
  }
  const polar = POLAR_BOND_LENGTHS[pairKey(elementA, elementB)];
  if (polar) {
    const len = polar[order];
    if (len !== undefined) return len;
    if (order === 1.5) {
      const single = polar[1] ?? radiusBondLength(elementA, elementB, 1);
      const double = polar[2] ?? radiusBondLength(elementA, elementB, 2);
      return (single + double) / 2;
    }
  }
  return radiusBondLength(elementA, elementB, order);
}

/**
 * Typical lengths (Å) of bonds that are equivalent by resonance in delocalised terminal groups, whose
 * Kekulé structure shows one double and one or two anionic single bonds: carboxylate C(=O)O⁻ (two
 * equivalent O, ≈ 1.25–1.26 Å), nitro N⁺(=O)O⁻ (≈ 1.22 Å), carbonate CO₃²⁻ (three O, ≈ 1.29 Å),
 * nitrate NO₃⁻ (≈ 1.25 Å). Indexed by the element pair in alphabetical order ('C-O') and the number of
 * equivalent terminal atoms. These are shorter than the aromatic (order 1.5) lengths of the same
 * pairs, which describe ring bonds (furan C–O ≈ 1.36 Å). Sources: CSD / Allen et al. (1987).
 */
export const RESONANCE_BOND_LENGTHS: Readonly<Record<string, Readonly<Partial<Record<2 | 3, number>>>>> = {
  'C-O': { 2: 1.255, 3: 1.29 },
  'N-O': { 2: 1.22, 3: 1.25 },
};

/**
 * Length (Å) of a bond between a delocalisation centre and one of `equivalents` (2 or 3) resonance-
 * equivalent terminal atoms (RESONANCE_BOND_LENGTHS; pairs without an entry, e.g. the C–S of a
 * dithiocarboxylate, fall back to idealBondLength(…, 1.5)). Element order does not matter.
 */
export function resonanceBondLength(elementA: string, elementB: string, equivalents = 2): number {
  const len = RESONANCE_BOND_LENGTHS[pairKey(elementA, elementB)]?.[equivalents >= 3 ? 3 : 2];
  return len ?? idealBondLength(elementA, elementB, 1.5);
}

/**
 * Resonance check for the bond between atom INDICES i and j (positions in mol.atoms): is it one of
 * the equivalent bonds of a delocalised terminal group — a C or N centre with ≥ 2 terminal O (or S)
 * atoms written as one double plus anionic single bond(s) (carboxylate C(=O)O⁻, nitro N⁺(=O)O⁻,
 * carbonate, nitrate, dithiocarboxylate), or with aromatic 1.5 bonds (MOL2 'ar' for O.co2)?
 * Returns the number of equivalent terminal atoms (2 or 3), or 0. CO₂, acids (O–H) and esters → 0.
 * Used by the force field (ff-model restLength) and idealBondLengthInMolecule.
 */
export function resonanceEquivalents(mol: Molecule, i: number, j: number): number {
  const topo = getTopology(mol);
  const ni = topo.neighbors[i];
  const nj = topo.neighbors[j];
  if (!ni || !nj) return 0;
  let term: number, centre: number;
  if (ni.length === 1) {
    term = i;
    centre = j;
  } else if (nj.length === 1) {
    term = j;
    centre = i;
  } else return 0;
  const ce = mol.atoms[centre].element;
  if (ce !== 'C' && ce !== 'N') return 0;
  const el = mol.atoms[term].element;
  if (el !== 'O' && el !== 'S') return 0;
  const list = topo.neighbors[centre];
  const bonds = topo.atomBonds[centre];
  let double = 0, anion = 0, aromatic = 0;
  let self = false;
  for (let k = 0; k < list.length; k++) {
    const x = list[k];
    if (topo.neighbors[x].length !== 1 || mol.atoms[x].element !== el) continue;
    const o = mol.bonds[bonds[k]].order;
    if (o === 2) double++;
    else if (o === 1.5) aromatic++;
    else if (o === 1 && (mol.atoms[x].charge ?? 0) < 0) anion++;
    else continue;
    if (x === term) self = true;
  }
  if (!self || !((double > 0 && anion > 0) || aromatic >= 2)) return 0;
  return double + anion + aromatic;
}

/**
 * Ideal length (Å) of the bond between atoms `atomA` and `atomB` (ids) in its chemical context:
 * idealBondLength for `order` (default: the bond's order, 1 if the atoms are not bonded), except that
 * the Kekulé single and double bonds of a delocalised terminal group (carboxylate, nitro …) both get
 * resonanceBondLength — the rest length the minimiser relaxes them to (ff-model restLength). For the
 * geometry inspector / hover tooltips. NaN if an atom is missing.
 */
export function idealBondLengthInMolecule(mol: Molecule, atomA: number, atomB: number, order?: BondOrder): number {
  const topo = getTopology(mol);
  const i = topo.idToIndex.get(atomA);
  const j = topo.idToIndex.get(atomB);
  if (i === undefined || j === undefined) return NaN;
  const ea = mol.atoms[i].element;
  const eb = mol.atoms[j].element;
  const k = topo.neighbors[i].indexOf(j);
  if (k < 0) return idealBondLength(ea, eb, order ?? 1);
  const bo = order ?? mol.bonds[topo.atomBonds[i][k]].order;
  if (bo !== 3) {
    const eq = resonanceEquivalents(mol, i, j);
    if (eq > 0) return resonanceBondLength(ea, eb, eq);
  }
  return idealBondLength(ea, eb, bo);
}

// --- VSEPR-like completion of an atom's coordination ---------------------------

export type VseprGeometry = 'linear' | 'trigonal' | 'tetrahedral';

/** Ideal bond angle (degrees) per geometry. Tetrahedral = acos(−1/3). */
export const IDEAL_ANGLES: Record<VseprGeometry, number> = {
  linear: 180,
  trigonal: 120,
  tetrahedral: (Math.acos(-1 / 3) * 180) / Math.PI,
};

/**
 * Electron-domain geometry implied by an atom's bond orders (pass the existing orders PLUS the
 * prospective new bond): any triple or ≥ 2 doubles → linear (sp); any double or aromatic → trigonal
 * planar (sp2); else tetrahedral (sp3, also for O/N/S with lone pairs).
 */
export function geometryFromOrders(orders: readonly number[]): VseprGeometry {
  let doubles = 0;
  let pi = false;
  for (const o of orders) {
    if (o === 3) return 'linear';
    if (o === 2) doubles++;
    if (o === 2 || o === 1.5) pi = true;
  }
  if (doubles >= 2) return 'linear';
  return pi ? 'trigonal' : 'tetrahedral';
}

/**
 * Minimal graph interface for the direction engine, so edit.ts can place many hydrogens in one pass
 * without rebuilding a Molecule after each one. Indices are arbitrary integers.
 */
export interface AtomGraph {
  position(i: number): Vec3;
  /** Neighbour indices of i. */
  neighbors(i: number): readonly number[];
  /** Orders of i's bonds. */
  bondOrders(i: number): readonly number[];
  isHydrogen(i: number): boolean;
}

/** AtomGraph view of a molecule (indices = atom indices). */
export function moleculeGraph(mol: Molecule): AtomGraph {
  const topo = getTopology(mol);
  return {
    position: (i) => pos(mol.atoms[i]),
    neighbors: (i) => topo.neighbors[i],
    bondOrders: (i) => topo.atomBonds[i].map((bi) => mol.bonds[bi].order),
    isHydrogen: (i) => mol.atoms[i].element === 'H',
  };
}

interface DirectionContext {
  /** Unit vectors from the centre to its existing neighbours. */
  bondDirs: Vec3[];
  /**
   * Single-neighbour case: vectors from that neighbour to ITS other neighbours (heavy atoms first),
   * used to place the new bond anti (zig-zag) to them.
   */
  refDirs: Vec3[];
  geometry: VseprGeometry;
  preferDir?: Vec3;
}

const HALF_TETRAHEDRAL = (IDEAL_ANGLES.tetrahedral / 2) * (Math.PI / 180);

/** Unit vector perpendicular to `axis`, as close as possible to `hint` (fallback: any perpendicular). */
function perpendicularTowards(axis: Vec3, hint?: Vec3): Vec3 {
  if (hint) {
    const r = rejection(hint, axis);
    if (length(r) > 1e-6) return normalize(r);
  }
  return anyPerpendicular(axis);
}

/** The two remaining tetrahedral positions next to bonds u1, u2; the first is closer to preferDir. */
function tetrahedralPair(u1: Vec3, u2: Vec3, preferDir?: Vec3): [Vec3, Vec3] {
  let b = scale(add(u1, u2), -1);
  b = length(b) > 1e-6 ? normalize(b) : perpendicularTowards(u1, preferDir);
  let n = cross(u1, u2);
  n = length(n) > 1e-6 ? normalize(n) : normalize(cross(u1, b));
  const c = Math.cos(HALF_TETRAHEDRAL);
  const s = Math.sin(HALF_TETRAHEDRAL);
  const p = normalize(add(scale(b, c), scale(n, s)));
  const q = normalize(sub(scale(b, c), scale(n, s)));
  if (preferDir && dot(q, preferDir) > dot(p, preferDir) + 1e-9) return [q, p];
  return [p, q];
}

/** Direction for a new bond on an atom with exactly one bond (direction u1). */
function singleNeighbourDirection(u1: Vec3, ctx: DirectionContext, useRefs: boolean): Vec3 {
  if (ctx.geometry === 'linear') return scale(u1, -1);
  const theta = (IDEAL_ANGLES[ctx.geometry] * Math.PI) / 180;
  let w: Vec3 | undefined;
  if (useRefs) {
    for (const ref of ctx.refDirs) {
      const r = rejection(ref, u1);
      if (length(r) > 1e-3 * Math.max(1, length(ref))) {
        w = scale(normalize(r), -1); // anti to the neighbour's substituent → zig-zag / trans
        break;
      }
    }
  }
  if (!w) w = perpendicularTowards(u1, ctx.preferDir);
  return normalize(add(scale(u1, Math.cos(theta)), scale(w, Math.sin(theta))));
}

/** Direction farthest (in angle) from all given directions, sampled on a Fibonacci sphere. */
function leastCrowdedDirection(dirs: Vec3[], preferDir?: Vec3): Vec3 {
  const N = 256;
  let best: Vec3 = [1, 0, 0];
  let bestScore = Infinity;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    const cand: Vec3 = [Math.cos(t) * r, y, Math.sin(t) * r];
    let worst = -Infinity;
    for (const d of dirs) worst = Math.max(worst, dot(cand, d));
    const score = worst - (preferDir ? 1e-3 * dot(cand, preferDir) : 0);
    if (score < bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

/** One new bond direction given the current set of bond directions. */
function nextDirection(dirs: Vec3[], ctx: DirectionContext, useRefs: boolean): Vec3 {
  const n = dirs.length;
  if (n === 0) return ctx.preferDir && length(ctx.preferDir) > 1e-9 ? normalize(ctx.preferDir) : [1, 0, 0];
  if (n === 1) return singleNeighbourDirection(dirs[0], ctx, useRefs);
  if (n === 2) {
    if (ctx.geometry === 'tetrahedral') return tetrahedralPair(dirs[0], dirs[1], ctx.preferDir)[0];
    const s = add(dirs[0], dirs[1]);
    return length(s) > 1e-6 ? normalize(scale(s, -1)) : perpendicularTowards(dirs[0], ctx.preferDir);
  }
  if (n === 3) {
    const s = add(add(dirs[0], dirs[1]), dirs[2]);
    if (length(s) > 1e-3) return normalize(scale(s, -1));
    // Planar arrangement: use the plane normal, oriented towards preferDir.
    let nrm = cross(sub(dirs[1], dirs[0]), sub(dirs[2], dirs[0]));
    nrm = length(nrm) > 1e-9 ? normalize(nrm) : anyPerpendicular(dirs[0]);
    if (ctx.preferDir && dot(nrm, ctx.preferDir) < 0) nrm = scale(nrm, -1);
    return nrm;
  }
  return leastCrowdedDirection(dirs, ctx.preferDir);
}

/** Complete `count` new bond directions (unit vectors), placing them one after the other. */
function completeDirections(ctx: DirectionContext, count: number): Vec3[] {
  const dirs = ctx.bondDirs.slice();
  const out: Vec3[] = [];
  while (out.length < count) {
    if (dirs.length === 2 && ctx.geometry === 'tetrahedral' && count - out.length >= 2) {
      // Both remaining tetrahedral positions at once (exactly symmetric even for non-ideal u1/u2).
      const [p, q] = tetrahedralPair(dirs[0], dirs[1], ctx.preferDir);
      out.push(p, q);
      dirs.push(p, q);
      continue;
    }
    const d = nextDirection(dirs, ctx, out.length === 0);
    out.push(d);
    dirs.push(d);
  }
  return out.slice(0, count);
}

/** Build the direction context of atom i in a graph. `newOrder` is the prospective bond's order. */
function contextFor(g: AtomGraph, i: number, newOrder: BondOrder, preferDir?: Vec3): DirectionContext {
  const center = g.position(i);
  const nbrs = g.neighbors(i);
  const bondDirs: Vec3[] = [];
  const realNbrs: number[] = [];
  for (const j of nbrs) {
    const v = sub(g.position(j), center);
    if (length(v) < 1e-6) continue; // coincident atoms carry no direction
    bondDirs.push(normalize(v));
    realNbrs.push(j);
  }
  const refDirs: Vec3[] = [];
  if (realNbrs.length === 1) {
    const j = realNbrs[0];
    const pj = g.position(j);
    const others = g.neighbors(j).filter((k) => k !== i);
    const heavy = others.filter((k) => !g.isHydrogen(k));
    const light = others.filter((k) => g.isHydrogen(k));
    for (const k of [...heavy, ...light]) refDirs.push(sub(g.position(k), pj));
  }
  const geometry = geometryFromOrders([...g.bondOrders(i), newOrder]);
  return { bondDirs, refDirs, geometry, preferDir: preferDir ? normalize(preferDir) : undefined };
}

/**
 * Unit vectors for `count` new bonds on atom i of an abstract graph (same VSEPR completion as
 * openValenceDirections). Exposed for batch operations (edit.ts addHydrogens).
 */
export function valenceDirectionsInGraph(g: AtomGraph, i: number, count: number, newOrder: BondOrder = 1, preferDir?: Vec3): Vec3[] {
  if (count <= 0) return [];
  return completeDirections(contextFor(g, i, newOrder, preferDir), count);
}

/** Candidate directions for ONE new bond, most preferred first (alternatives are used to avoid clashes). */
function candidateDirections(ctx: DirectionContext): Vec3[] {
  const n = ctx.bondDirs.length;
  const first = nextDirection(ctx.bondDirs, ctx, true);
  if (n === 1 && ctx.geometry !== 'linear') {
    const u1 = ctx.bondDirs[0];
    const alts = ctx.geometry === 'tetrahedral' ? [120, -120] : [180];
    return [first, ...alts.map((deg) => rotateAround(first, [0, 0, 0], u1, deg))];
  }
  if (n === 2 && ctx.geometry === 'tetrahedral') return tetrahedralPair(ctx.bondDirs[0], ctx.bondDirs[1], ctx.preferDir);
  return [first];
}

/** Atoms closer than this (Å) to a suggested position count as a clash. */
const CLASH_DISTANCE = 1.0;

/**
 * Position for a NEW atom of `element` bonded to anchor atom `anchorId`, using VSEPR-like geometry
 * from the anchor's existing neighbours (0 nbrs: along +x or away from the view; 1 nbr: ~109.5°/120°/180°
 * depending on hybridisation implied by bond orders; 2–3 nbrs: tetrahedral / trigonal completion).
 * `preferDir` (optional unit vector, e.g. towards the camera) breaks ties. Bond length = idealBondLength.
 *
 * Details: the anchor's hybridisation includes the prospective bond (`order`). With one neighbour the
 * new bond is placed anti to that neighbour's other substituent (heavy atoms first), so chains grow as
 * zig-zags and sp2 systems stay coplanar. If the preferred position clashes with an existing atom
 * (< 1 Å), the alternative positions (other staggered rotamer / other tetrahedral site) are tried.
 * Missing anchor → preferDir or [0, 0, 0].
 */
export function suggestNewAtomPosition(mol: Molecule, anchorId: number, element: string, order: BondOrder = 1, preferDir?: Vec3): Vec3 {
  const topo = getTopology(mol);
  const i = topo.idToIndex.get(anchorId);
  if (i === undefined) return preferDir ? [...preferDir] : [0, 0, 0];
  const anchor = mol.atoms[i];
  const center = pos(anchor);
  const L = idealBondLength(anchor.element, element, order);
  const ctx = contextFor(moleculeGraph(mol), i, order, preferDir);
  const candidates = candidateDirections(ctx);
  if (candidates.length === 1) return add(center, scale(candidates[0], L));

  // Clash check against atoms near the anchor.
  const near: Vec3[] = [];
  const r2 = (L + CLASH_DISTANCE + 0.5) ** 2;
  for (let k = 0; k < mol.atoms.length; k++) {
    if (k === i) continue;
    const a = mol.atoms[k];
    const dx = a.x - center[0];
    const dy = a.y - center[1];
    const dz = a.z - center[2];
    if (dx * dx + dy * dy + dz * dz <= r2) near.push(pos(a));
  }
  let best = add(center, scale(candidates[0], L));
  let bestClear = -Infinity;
  for (const d of candidates) {
    const p = add(center, scale(d, L));
    let clear = Infinity;
    for (const q of near) clear = Math.min(clear, distance(p, q));
    if (clear >= CLASH_DISTANCE) return p;
    if (clear > bestClear) {
      bestClear = clear;
      best = p;
    }
  }
  return best;
}

/**
 * Unit vectors pointing into the atom's open valence positions (count = open valence, or `count` if given),
 * using the same VSEPR completion as suggestNewAtomPosition (prospective bonds are single).
 */
export function openValenceDirections(mol: Molecule, atomId: number, count?: number): Vec3[] {
  const i = getTopology(mol).idToIndex.get(atomId);
  if (i === undefined) return [];
  const n = count ?? valenceOf(mol, atomId)?.openValence ?? 0;
  return valenceDirectionsInGraph(moleculeGraph(mol), i, n, 1);
}

// --- connectivity ---------------------------------------------------------------

/**
 * BFS over atom indices from `start`, never using the direct edge start–`blocked`. Returns the visited
 * indices, or null if `blocked` is reached another way (ring) or more than `limit` atoms are visited.
 */
function sideIndices(mol: Molecule, blocked: number, start: number, limit = Infinity): number[] | null {
  const topo = getTopology(mol);
  const seen = new Uint8Array(mol.atoms.length);
  seen[start] = 1;
  const out = [start];
  for (let qi = 0; qi < out.length; qi++) {
    const x = out[qi];
    for (const y of topo.neighbors[x]) {
      if (y === blocked) {
        if (x === start) continue; // the a–b bond itself
        return null; // reached a around a ring
      }
      if (seen[y]) continue;
      seen[y] = 1;
      out.push(y);
      if (out.length > limit) return null;
    }
  }
  return out;
}

/**
 * Atom ids on the `side` of the bond a–b: all atoms reachable from b without crossing a–b (includes b).
 * If a–b is in a ring, returns only [b].
 * (If a and b are not bonded, the same rule applies: b's whole component, or only b if a is reachable.)
 */
export function fragmentSide(mol: Molecule, a: number, b: number): Set<number> {
  const topo = getTopology(mol);
  const ib = topo.idToIndex.get(b);
  if (ib === undefined) return new Set();
  const ia = topo.idToIndex.get(a) ?? -1;
  const idx = sideIndices(mol, ia, ib);
  if (!idx) return new Set([b]);
  return new Set(idx.map((k) => mol.atoms[k].id));
}

/**
 * The smaller rigid side of the bond a–b (ties → b's side), used by setDistance / setAngle / setDihedral so
 * that editing a side chain never drags the rest of a protein along.
 * Returns which side moves ('b' = fragmentSide(a, b), 'a' = fragmentSide(b, a)) and its atom ids, or null
 * if a–b is not a bond or is in a ring.
 */
export function smallerSide(mol: Molecule, a: number, b: number): { side: 'a' | 'b'; atoms: Set<number> } | null {
  const topo = getTopology(mol);
  const ia = topo.idToIndex.get(a);
  const ib = topo.idToIndex.get(b);
  if (ia === undefined || ib === undefined || !topo.neighbors[ia].includes(ib)) return null;
  const sb = sideIndices(mol, ia, ib);
  if (!sb) return null;
  // a's side only matters if it is strictly smaller than b's side.
  const sa = sideIndices(mol, ib, ia, sb.length - 1);
  const pick = sa && sa.length < sb.length ? { side: 'a' as const, idx: sa } : { side: 'b' as const, idx: sb };
  return { side: pick.side, atoms: new Set(pick.idx.map((k) => mol.atoms[k].id)) };
}

/** Connected component (atom ids) containing `atomId`. */
export function connectedComponent(mol: Molecule, atomId: number): Set<number> {
  const topo = getTopology(mol);
  const start = topo.idToIndex.get(atomId);
  if (start === undefined) return new Set();
  const idx = sideIndices(mol, -1, start) ?? [start];
  return new Set(idx.map((k) => mol.atoms[k].id));
}
