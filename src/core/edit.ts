/**
 * Pure molecule editing operations. Every function returns a NEW Molecule (never mutates input),
 * reusing unchanged Atom/Bond objects. Atom ids are taken from mol.nextAtomId (and bonds from
 * mol.nextBondId) and these counters are advanced. Unknown ids are ignored gracefully.
 * When nothing changes, the input molecule itself is returned (so `store.commit` can skip no-ops).
 * New atoms created by edits get: no residue info unless the anchor atom had residue info
 * (then copy chain/resName/resSeq/iCode from the anchor and hetero=true; hydrogens copy the
 * anchor's hetero flag instead), and a generated `name` like element + count (e.g. 'C7'),
 * unique within the residue (or within the non-residue atoms).
 * OWNER: chemistry agent. CONTRACT: keep exported names & signatures.
 */
import type { Atom, Bond, BondOrder, Molecule, Vec3 } from './types';
import { bondBetween, centroid, getTopology } from './molecule';
import { getElement, normalizeElementSymbol } from './elements';
import { analyzeValence, evaluateValence, isBondInRing } from './chemistry';
import {
  type AtomGraph,
  add,
  angle,
  applyMat3,
  dihedral,
  distance,
  dot,
  fragmentSide,
  idealBondLength,
  length,
  normalize,
  openValenceDirections,
  rotateAround,
  rotationBetween,
  scale,
  smallerSide,
  sub,
  valenceDirectionsInGraph,
  anyPerpendicular,
  cross,
} from './geometry';
import { getFragment } from './templates';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const posOf = (a: Atom): Vec3 => [a.x, a.y, a.z];

function residueScope(a: Partial<Atom>): string {
  if (a.resName === undefined && a.resSeq === undefined) return '';
  return `${a.chain ?? ''}:${a.resSeq ?? 0}${a.iCode ?? ''}:${(a.resName ?? 'UNK').toUpperCase()}`;
}

/** Residue fields for an atom created next to `anchor` (empty if the anchor has no residue info). */
function residueInfoFrom(anchor: Atom | undefined, hydrogen = false): Partial<Atom> {
  if (!anchor || (anchor.resName === undefined && anchor.resSeq === undefined)) return {};
  const r: Partial<Atom> = {};
  if (anchor.chain !== undefined) r.chain = anchor.chain;
  if (anchor.resName !== undefined) r.resName = anchor.resName;
  if (anchor.resSeq !== undefined) r.resSeq = anchor.resSeq;
  if (anchor.iCode !== undefined) r.iCode = anchor.iCode;
  if (hydrogen) {
    if (anchor.hetero !== undefined) r.hetero = anchor.hetero;
  } else r.hetero = true;
  return r;
}

/** Generates atom names (element + number) that are unique within a residue scope. */
class AtomNamer {
  private used = new Map<string, Set<string>>();
  private counts = new Map<string, number>();

  constructor(atoms: readonly Atom[]) {
    for (const a of atoms) this.register(a);
  }

  private usedIn(scope: string): Set<string> {
    let s = this.used.get(scope);
    if (!s) {
      s = new Set();
      this.used.set(scope, s);
    }
    return s;
  }

  register(a: Atom) {
    const scope = residueScope(a);
    if (a.name) this.usedIn(scope).add(a.name.toUpperCase());
    const key = scope + '|' + a.element;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  next(element: string, scope: string): string {
    const key = scope + '|' + element;
    const used = this.usedIn(scope);
    let k = (this.counts.get(key) ?? 0) + 1;
    while (used.has((element + k).toUpperCase())) k++;
    const name = element + k;
    used.add(name.toUpperCase());
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return name;
  }
}

/** Next free atom id (guards against a stale nextAtomId). */
function freshAtomId(mol: Molecule): number {
  const topo = getTopology(mol);
  if (!topo.idToIndex.has(mol.nextAtomId)) {
    let ok = true;
    for (const id of topo.idToIndex.keys()) if (id >= mol.nextAtomId) ok = false;
    if (ok) return mol.nextAtomId;
  }
  let max = 0;
  for (const a of mol.atoms) max = Math.max(max, a.id);
  return Math.max(max + 1, mol.nextAtomId);
}

/** Next free bond id (guards against a stale nextBondId). */
function freshBondId(mol: Molecule): number {
  let max = mol.nextBondId - 1;
  for (const b of mol.bonds) if (b.id > max) max = b.id;
  return max + 1;
}

function makeAtom(id: number, element: string, p: Vec3, name: string, extra: Partial<Atom> = {}): Atom {
  return { id, element, x: p[0], y: p[1], z: p[2], name, ...extra };
}

/** Apply a position transform to the atoms in `ids` (null = all). Returns mol if nothing moved. */
function transformAtoms(mol: Molecule, ids: Set<number> | null, f: (p: Vec3) => Vec3): Molecule {
  let changed = false;
  const atoms = mol.atoms.map((a) => {
    if (ids && !ids.has(a.id)) return a;
    const [x, y, z] = f(posOf(a));
    if (x === a.x && y === a.y && z === a.z) return a;
    changed = true;
    return { ...a, x, y, z };
  });
  return changed ? { ...mol, atoms } : mol;
}

/** Terminal hydrogens (H with exactly one bond, single order) bonded to atom index i, as atom indices. */
function terminalHydrogens(mol: Molecule, i: number): number[] {
  const topo = getTopology(mol);
  const out: number[] = [];
  const id = mol.atoms[i].id;
  for (const bi of topo.atomBonds[i]) {
    const bond = mol.bonds[bi];
    if (bond.order !== 1) continue;
    const j = topo.idToIndex.get(bond.a === id ? bond.b : bond.a);
    if (j === undefined || j === i) continue;
    if (mol.atoms[j].element === 'H' && topo.atomBonds[j].length === 1) out.push(j);
  }
  return out;
}

function atomTag(a: Atom, index: number): string {
  return a.name || `${a.element}${index + 1}`;
}

// ---------------------------------------------------------------------------
// Atoms and bonds
// ---------------------------------------------------------------------------

export interface AddAtomOptions {
  /** Bond the new atom to this existing atom id. */
  bondTo?: number;
  order?: BondOrder;
  charge?: number;
}

/** Add an atom at `position`. */
export function addAtom(mol: Molecule, element: string, position: Vec3, opts: AddAtomOptions = {}): { mol: Molecule; atomId: number } {
  const el = normalizeElementSymbol(element);
  const topo = getTopology(mol);
  const anchorIdx = opts.bondTo !== undefined ? topo.idToIndex.get(opts.bondTo) : undefined;
  const anchor = anchorIdx !== undefined ? mol.atoms[anchorIdx] : undefined;
  const id = freshAtomId(mol);
  const info = residueInfoFrom(anchor);
  const name = new AtomNamer(mol.atoms).next(el, residueScope(info));
  const atom = makeAtom(id, el, position, name, info);
  const q = Math.round(opts.charge ?? 0);
  if (q) atom.charge = q;
  let bonds = mol.bonds;
  let nextBondId = mol.nextBondId;
  if (anchor) {
    const bid = freshBondId(mol);
    bonds = [...bonds, { id: bid, a: anchor.id, b: id, order: opts.order ?? 1 }];
    nextBondId = bid + 1;
  }
  return { mol: { ...mol, atoms: [...mol.atoms, atom], bonds, nextAtomId: id + 1, nextBondId }, atomId: id };
}

/** Remove atoms (and all their bonds). Ids of remaining atoms are unchanged and never reused. */
export function removeAtoms(mol: Molecule, atomIds: Iterable<number>): Molecule {
  const topo = getTopology(mol);
  const remove = new Set<number>();
  for (const id of atomIds) if (topo.idToIndex.has(id)) remove.add(id);
  if (remove.size === 0) return mol;
  return {
    ...mol,
    atoms: mol.atoms.filter((a) => !remove.has(a.id)),
    bonds: mol.bonds.filter((b) => !remove.has(b.a) && !remove.has(b.b)),
  };
}

/** Add a bond a–b; if it already exists, set its order. Returns the bond id (-1 if a/b invalid). */
export function addBond(mol: Molecule, a: number, b: number, order: BondOrder = 1): { mol: Molecule; bondId: number } {
  if (a === b) return { mol, bondId: -1 };
  const topo = getTopology(mol);
  if (!topo.idToIndex.has(a) || !topo.idToIndex.has(b)) return { mol, bondId: -1 };
  const existing = bondBetween(mol, a, b);
  if (existing) return { mol: setBondOrder(mol, existing.id, order), bondId: existing.id };
  const id = freshBondId(mol);
  const bond: Bond = { id, a, b, order };
  return { mol: { ...mol, bonds: [...mol.bonds, bond], nextBondId: id + 1 }, bondId: id };
}

export function removeBonds(mol: Molecule, bondIds: Iterable<number>): Molecule {
  const topo = getTopology(mol);
  const remove = new Set<number>();
  for (const id of bondIds) if (topo.bondIdToIndex.has(id)) remove.add(id);
  if (remove.size === 0) return mol;
  return { ...mol, bonds: mol.bonds.filter((b) => !remove.has(b.id)) };
}

export function setBondOrder(mol: Molecule, bondId: number, order: BondOrder): Molecule {
  const idx = getTopology(mol).bondIdToIndex.get(bondId);
  if (idx === undefined || mol.bonds[idx].order === order) return mol;
  const bonds = mol.bonds.slice();
  bonds[idx] = { ...bonds[idx], order };
  return { ...mol, bonds };
}

/** Cycle 1 → 2 → 3 → 1 (aromatic 1.5 → 2). */
export function cycleBondOrder(mol: Molecule, bondId: number): Molecule {
  const idx = getTopology(mol).bondIdToIndex.get(bondId);
  if (idx === undefined) return mol;
  const o = mol.bonds[idx].order;
  const next: BondOrder = o === 1 ? 2 : o === 2 ? 3 : o === 3 ? 1 : 2;
  return setBondOrder(mol, bondId, next);
}

/**
 * Change element of atoms (keeps positions; bond lengths are NOT adjusted here).
 * Generated-looking names ('C7', or a bare 'C') are renamed for the new element ('N3').
 */
export function setElement(mol: Molecule, atomIds: Iterable<number>, element: string): Molecule {
  const el = normalizeElementSymbol(element);
  const topo = getTopology(mol);
  let atoms: Atom[] | null = null;
  let namer: AtomNamer | null = null;
  for (const id of atomIds) {
    const idx = topo.idToIndex.get(id);
    if (idx === undefined) continue;
    const a = (atoms ?? mol.atoms)[idx];
    if (a.element === el) continue;
    atoms ??= mol.atoms.slice();
    const next: Atom = { ...a, element: el };
    if (a.name && new RegExp(`^${a.element}\\d*$`, 'i').test(a.name)) {
      namer ??= new AtomNamer(mol.atoms);
      next.name = namer.next(el, residueScope(a));
    }
    atoms[idx] = next;
  }
  return atoms ? { ...mol, atoms } : mol;
}

export function setCharge(mol: Molecule, atomId: number, charge: number): Molecule {
  const idx = getTopology(mol).idToIndex.get(atomId);
  if (idx === undefined) return mol;
  const a = mol.atoms[idx];
  const q = Math.round(charge || 0);
  if ((a.charge ?? 0) === q) return mol;
  const atoms = mol.atoms.slice();
  if (q === 0) {
    const { charge: _drop, ...rest } = a;
    atoms[idx] = rest;
  } else atoms[idx] = { ...a, charge: q };
  return { ...mol, atoms };
}

/** Translate atoms by delta. */
export function translateAtoms(mol: Molecule, atomIds: Iterable<number>, delta: Vec3): Molecule {
  if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) return mol;
  return transformAtoms(mol, new Set(atomIds), (p) => add(p, delta));
}

/** Set absolute positions for atoms. */
export function setPositions(mol: Molecule, positions: Map<number, Vec3>): Molecule {
  if (positions.size === 0) return mol;
  let changed = false;
  const atoms = mol.atoms.map((a) => {
    const p = positions.get(a.id);
    if (!p || (p[0] === a.x && p[1] === a.y && p[2] === a.z)) return a;
    changed = true;
    return { ...a, x: p[0], y: p[1], z: p[2] };
  });
  return changed ? { ...mol, atoms } : mol;
}

// ---------------------------------------------------------------------------
// Internal coordinates
// ---------------------------------------------------------------------------

/** Positions of the given ids, or null if any is missing. */
function positionsOf(mol: Molecule, ids: number[]): Vec3[] | null {
  const topo = getTopology(mol);
  const out: Vec3[] = [];
  for (const id of ids) {
    const idx = topo.idToIndex.get(id);
    if (idx === undefined) return null;
    out.push(posOf(mol.atoms[idx]));
  }
  return out;
}

/**
 * Set the distance between atoms a and b to `target` Å, moving the fragment on b's side
 * (fragmentSide(a, b) if a–b is a bond not in a ring; otherwise only atom b) along the a→b axis.
 * For a non-ring bond the smaller of the two sides moves (ties → b's side), so the rest of a large
 * molecule stays put; the resulting distance is the same either way.
 */
export function setDistance(mol: Molecule, a: number, b: number, target: number): Molecule {
  if (a === b || !(target > 0) || !Number.isFinite(target)) return mol;
  const p = positionsOf(mol, [a, b]);
  if (!p) return mol;
  const d = distance(p[0], p[1]);
  if (d < 1e-9) return mol;
  const u = scale(sub(p[1], p[0]), 1 / d);
  const side = smallerSide(mol, a, b);
  const moving = side ? side.atoms : new Set([b]);
  const sign = side && side.side === 'a' ? -1 : 1;
  return translateAtoms(mol, moving, scale(u, sign * (target - d)));
}

/** The atoms that rotate with `end` about pivot `pivot` (bonded, non-ring: the whole side; else just `end`). */
function rotatingSide(mol: Molecule, pivot: number, end: number, forbidden: number[]): Set<number> {
  const bonded = !!bondBetween(mol, pivot, end);
  if (bonded && !isBondInRing(mol, pivot, end)) {
    const side = fragmentSide(mol, pivot, end);
    if (!forbidden.some((id) => side.has(id))) return side;
  }
  return new Set([end]);
}

/**
 * Set angle a–b–c to `deg` degrees by rotating c's side (fragmentSide(b, c), or just c if in ring)
 * about the axis through b perpendicular to the a–b–c plane.
 * If a's side (fragmentSide(b, a)) is smaller, it is rotated the opposite way instead (same angle).
 */
export function setAngle(mol: Molecule, a: number, b: number, c: number, deg: number): Molecule {
  if (a === b || b === c || a === c || !Number.isFinite(deg)) return mol;
  const p = positionsOf(mol, [a, b, c]);
  if (!p) return mol;
  const u = sub(p[0], p[1]);
  const v = sub(p[2], p[1]);
  if (length(u) < 1e-9 || length(v) < 1e-9) return mol;
  const target = Math.max(0, Math.min(180, deg));
  const delta = target - angle(p[0], p[1], p[2]);
  if (Math.abs(delta) < 1e-12) return mol;
  let axis = cross(u, v);
  axis = length(axis) > 1e-9 * length(u) * length(v) ? normalize(axis) : anyPerpendicular(u);
  const cSide = rotatingSide(mol, b, c, [a, b]);
  const aSide = rotatingSide(mol, b, a, [b, c]);
  // Rotating c about axis = u × v by +delta opens the angle; rotating a by −delta does the same.
  const moveA = aSide.size < cSide.size;
  return transformAtoms(mol, moveA ? aSide : cSide, (q) => rotateAround(q, p[1], axis, moveA ? -delta : delta));
}

/** Wrap an angle difference into (−180, 180]. */
function wrapDegrees(d: number): number {
  let x = d % 360;
  if (x <= -180) x += 360;
  if (x > 180) x -= 360;
  return x;
}

/**
 * Set dihedral a–b–c–d to `deg` by rotating c's side of the b–c bond (fragmentSide(b, c)) about b→c.
 * If b's side is smaller, it is rotated the opposite way instead (same dihedral).
 * If b–c is in a ring, returns the molecule unchanged (see canSetDihedral).
 */
export function setDihedral(mol: Molecule, a: number, b: number, c: number, d: number, deg: number): Molecule {
  if (!Number.isFinite(deg) || !canSetDihedral(mol, a, b, c, d).ok) return mol;
  const p = positionsOf(mol, [a, b, c, d])!;
  const delta = wrapDegrees(deg - dihedral(p[0], p[1], p[2], p[3]));
  if (Math.abs(delta) < 1e-12) return mol;
  const side = smallerSide(mol, b, c);
  if (!side) return mol;
  const axis = sub(p[2], p[1]);
  // side 'b' = fragmentSide(b, c), i.e. the atoms that move with c.
  const sign = side.side === 'b' ? 1 : -1;
  return transformAtoms(mol, side.atoms, (q) => rotateAround(q, p[1], axis, sign * delta));
}

/** Whether the dihedral can be changed (b–c must not be in a ring, and must be bonded). */
export function canSetDihedral(mol: Molecule, a: number, b: number, c: number, d: number): { ok: boolean; reason?: string } {
  const ids = [a, b, c, d];
  if (new Set(ids).size < 4) return { ok: false, reason: 'Atoms must be distinct' };
  const p = positionsOf(mol, ids);
  if (!p) return { ok: false, reason: 'Atom not found' };
  if (!bondBetween(mol, a, b) || !bondBetween(mol, b, c) || !bondBetween(mol, c, d)) {
    return { ok: false, reason: 'Atoms are not bonded in sequence' };
  }
  if (isBondInRing(mol, b, c)) {
    const topo = getTopology(mol);
    const ib = topo.idToIndex.get(b)!;
    const ic = topo.idToIndex.get(c)!;
    return { ok: false, reason: `The ${atomTag(mol.atoms[ib], ib)}–${atomTag(mol.atoms[ic], ic)} bond is in a ring` };
  }
  const t1 = angle(p[0], p[1], p[2]);
  const t2 = angle(p[1], p[2], p[3]);
  if (t1 < 0.05 || t1 > 179.95 || t2 < 0.05 || t2 > 179.95) {
    return { ok: false, reason: 'Dihedral is undefined for collinear atoms' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Hydrogens
// ---------------------------------------------------------------------------

/**
 * Place `count` new hydrogens on each atom (map: atom INDEX → count), in map order, with VSEPR
 * directions and ideal X–H lengths. Hydrogens placed earlier are visible to later atoms (so e.g. the
 * two CH3 groups of ethane come out staggered). One pass; no intermediate molecules.
 */
function placeHydrogens(mol: Molecule, counts: Map<number, number>): Molecule {
  if (counts.size === 0) return mol;
  const topo = getTopology(mol);
  const n0 = mol.atoms.length;
  const extraPos: Vec3[] = [];
  const extraParent: number[] = [];
  const extraNbr = new Map<number, number[]>();
  const graph: AtomGraph = {
    position: (i) => (i < n0 ? posOf(mol.atoms[i]) : extraPos[i - n0]),
    neighbors: (i) => {
      if (i >= n0) return [extraParent[i - n0]];
      const extra = extraNbr.get(i);
      return extra ? [...topo.neighbors[i], ...extra] : topo.neighbors[i];
    },
    bondOrders: (i) => {
      if (i >= n0) return [1];
      const orders = topo.atomBonds[i].map((bi) => mol.bonds[bi].order as number);
      const extra = extraNbr.get(i);
      if (extra) for (let k = 0; k < extra.length; k++) orders.push(1);
      return orders;
    },
    isHydrogen: (i) => i >= n0 || mol.atoms[i].element === 'H',
  };
  for (const [i, k] of counts) {
    if (k <= 0) continue;
    const parent = mol.atoms[i];
    const L = idealBondLength(parent.element, 'H', 1);
    const center = posOf(parent);
    for (const dir of valenceDirectionsInGraph(graph, i, k, 1)) {
      const idx = n0 + extraPos.length;
      extraPos.push(add(center, scale(dir, L)));
      extraParent.push(i);
      const list = extraNbr.get(i);
      if (list) list.push(idx);
      else extraNbr.set(i, [idx]);
    }
  }
  if (extraPos.length === 0) return mol;
  const namer = new AtomNamer(mol.atoms);
  let atomId = freshAtomId(mol);
  let bondId = freshBondId(mol);
  const newAtoms: Atom[] = [];
  const newBonds: Bond[] = [];
  for (let k = 0; k < extraPos.length; k++) {
    const parent = mol.atoms[extraParent[k]];
    const info = residueInfoFrom(parent, true);
    newAtoms.push(makeAtom(atomId, 'H', extraPos[k], namer.next('H', residueScope(info)), info));
    newBonds.push({ id: bondId++, a: parent.id, b: atomId, order: 1 });
    atomId++;
  }
  return {
    ...mol,
    atoms: mol.atoms.concat(newAtoms),
    bonds: mol.bonds.concat(newBonds),
    nextAtomId: atomId,
    nextBondId: bondId,
  };
}

/**
 * Add explicit hydrogens to fill open valences (for the given atom ids, or all heavy atoms),
 * placed with ideal bond length and VSEPR geometry (openValenceDirections).
 * Hydrogen atoms in `atomIds` are skipped.
 */
export function addHydrogens(mol: Molecule, atomIds?: Iterable<number>): Molecule {
  const topo = getTopology(mol);
  const info = analyzeValence(mol);
  const counts = new Map<number, number>();
  const consider = (i: number) => {
    const a = mol.atoms[i];
    if (a.element === 'H' || counts.has(i)) return;
    const v = info.get(a.id);
    if (v && v.status === 'under' && v.openValence > 0) counts.set(i, v.openValence);
  };
  if (atomIds) {
    for (const id of atomIds) {
      const i = topo.idToIndex.get(id);
      if (i !== undefined) consider(i);
    }
  } else for (let i = 0; i < mol.atoms.length; i++) consider(i);
  return placeHydrogens(mol, counts);
}

/** Remove hydrogens (attached to the given atoms, or all hydrogens). Hydrogens listed in atomIds are removed too. */
export function removeHydrogens(mol: Molecule, atomIds?: Iterable<number>): Molecule {
  if (!atomIds) return removeAtoms(mol, mol.atoms.filter((a) => a.element === 'H').map((a) => a.id));
  const topo = getTopology(mol);
  const remove: number[] = [];
  for (const id of atomIds) {
    const i = topo.idToIndex.get(id);
    if (i === undefined) continue;
    if (mol.atoms[i].element === 'H') remove.push(id);
    else for (const j of topo.neighbors[i]) if (mol.atoms[j].element === 'H') remove.push(mol.atoms[j].id);
  }
  return removeAtoms(mol, remove);
}

/**
 * Desired number of explicit terminal hydrogens on atom i so that its valence is ok, changing as few
 * hydrogens as possible (ties → fewer hydrogens, e.g. H2S + extra bond → thiol rather than SH3).
 * undefined = leave as is (already ok, unchecked, or not fixable by hydrogens).
 */
function desiredHydrogenCount(mol: Molecule, i: number, allowed: number[]): number | undefined {
  if (allowed.length === 0) return undefined;
  const topo = getTopology(mol);
  const atom = mol.atoms[i];
  const hs = new Set(terminalHydrogens(mol, i));
  const heavyOrders: number[] = [];
  let flexSum = 0;
  for (const bi of topo.atomBonds[i]) {
    const bond = mol.bonds[bi];
    const j = topo.idToIndex.get(bond.a === atom.id ? bond.b : bond.a);
    if (j === undefined || hs.has(j)) continue;
    if (getElement(mol.atoms[j].element).valences.length === 0) flexSum += bond.order;
    else heavyOrders.push(bond.order);
  }
  const h = hs.size;
  const withH = (n: number) => {
    const orders = heavyOrders.slice();
    for (let k = 0; k < n; k++) orders.push(1);
    return evaluateValence(orders, flexSum, allowed);
  };
  if (withH(h).status === 'ok') return undefined;
  let best: number | undefined;
  const maxH = h + allowed[allowed.length - 1] + 1;
  for (let n = 0; n <= maxH; n++) {
    if (withH(n).status !== 'ok') continue;
    if (best === undefined || Math.abs(n - h) < Math.abs(best - h)) best = n;
  }
  if (best !== undefined) return best;
  return withH(0).status === 'over' ? 0 : undefined;
}

/** Hydrogens of atom i ordered by how crowded they are (closest to a heavy neighbour first). */
function hydrogensByCrowding(mol: Molecule, i: number): number[] {
  const topo = getTopology(mol);
  const center = posOf(mol.atoms[i]);
  const hs = terminalHydrogens(mol, i);
  const hset = new Set(hs);
  const heavyDirs = topo.neighbors[i].filter((j) => !hset.has(j)).map((j) => normalize(sub(posOf(mol.atoms[j]), center)));
  const score = (j: number) => {
    const d = normalize(sub(posOf(mol.atoms[j]), center));
    let s = -Infinity;
    for (const h of heavyDirs) s = Math.max(s, dot(d, h));
    return s;
  };
  return hs
    .map((j) => ({ j, s: score(j) }))
    .sort((x, y) => y.s - x.s || mol.atoms[y.j].id - mol.atoms[x.j].id)
    .map((x) => x.j);
}

/**
 * For each given atom: remove excess hydrogens if over-valent, add hydrogens if under-valent.
 * Used by the editor's "auto hydrogens" option after each edit. Only touches the given atoms' H.
 * Removed hydrogens are the most crowded ones (closest to a heavy neighbour, i.e. where a new bond
 * was just formed). Retained X–H bonds more than 0.05 Å off the ideal length are reset to it
 * (e.g. C→O on methane gives water with 0.96 Å O–H bonds).
 */
export function adjustHydrogens(mol: Molecule, atomIds: Iterable<number>): Molecule {
  const topo = getTopology(mol);
  const info = analyzeValence(mol);
  const targets: number[] = [];
  const removeIds: number[] = [];
  const addById = new Map<number, number>();
  const seen = new Set<number>();
  for (const id of atomIds) {
    const i = topo.idToIndex.get(id);
    if (i === undefined || seen.has(id) || mol.atoms[i].element === 'H') continue;
    seen.add(id);
    targets.push(id);
    const allowed = info.get(id)?.allowed ?? [];
    const want = desiredHydrogenCount(mol, i, allowed);
    if (want === undefined) continue;
    const have = terminalHydrogens(mol, i).length;
    if (want < have) for (const j of hydrogensByCrowding(mol, i).slice(0, have - want)) removeIds.push(mol.atoms[j].id);
    else if (want > have) addById.set(id, want - have);
  }
  let out = removeAtoms(mol, removeIds);

  // Reset retained X–H bond lengths of the target atoms.
  const t1 = getTopology(out);
  const fixes = new Map<number, Vec3>();
  for (const id of targets) {
    const i = t1.idToIndex.get(id)!;
    const parent = out.atoms[i];
    const L = idealBondLength(parent.element, 'H', 1);
    const c = posOf(parent);
    for (const j of terminalHydrogens(out, i)) {
      const hp = posOf(out.atoms[j]);
      const d = distance(c, hp);
      if (d > 1e-6 && Math.abs(d - L) > 0.05) fixes.set(out.atoms[j].id, add(c, scale(sub(hp, c), L / d)));
    }
  }
  out = setPositions(out, fixes);

  if (addById.size) {
    const t2 = getTopology(out);
    const counts = new Map<number, number>();
    for (const [id, k] of addById) counts.set(t2.idToIndex.get(id)!, k);
    out = placeHydrogens(out, counts);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fragments, merging, centering
// ---------------------------------------------------------------------------

/**
 * Attach a fragment template (see core/templates.ts).
 * - anchorAtomId is a hydrogen: the H is replaced by the fragment's attach atom (bond to H's parent).
 * - anchorAtomId is a heavy atom: if it has an H, that H is replaced; else the fragment bonds to it
 *   along an open valence direction.
 * - no anchor: the fragment is placed (centered) at `position`.
 * Fragment orientation: attach-atom→fragment axis aligned with the new bond direction.
 * Returns the ids of the created atoms.
 *
 * Refinement: a heavy anchor that still has an open valence (e.g. a CH3 radical) bonds along that open
 * valence instead of losing one of its hydrogens; an H is only replaced when the anchor is saturated.
 *
 * Placement: the template's attachAtom→attachHydrogen vector is rotated onto the new bond (attach atom
 * → anchor), the attach atom is put at the ideal bond length from the anchor, and the fragment is then
 * turned about the bond axis in 30° steps to the orientation with the largest minimum distance to the
 * rest of the molecule (staggered, clash-free). Unknown fragment / anchor → unchanged molecule.
 */
export function attachFragment(
  mol: Molecule,
  fragmentId: string,
  opts: { anchorAtomId?: number; position?: Vec3 },
): { mol: Molecule; atomIds: number[] } {
  const frag = getFragment(fragmentId);
  if (!frag || frag.atoms.length === 0) return { mol, atomIds: [] };
  const T: Vec3[] = frag.atoms.map((a) => [a.x, a.y, a.z]);
  const elements = frag.atoms.map((a) => normalizeElementSymbol(a.element));

  if (opts.anchorAtomId === undefined) {
    // Free placement: the complete template (including attachHydrogen), centred at `position`.
    const c = T.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3).map((x) => x / T.length) as Vec3;
    const offset = sub(opts.position ?? [0, 0, 0], c);
    return appendFragment(mol, frag, elements, T.map((p) => add(p, offset)), new Set(), undefined, undefined);
  }

  const topo = getTopology(mol);
  const ai = topo.idToIndex.get(opts.anchorAtomId);
  if (ai === undefined) return { mol, atomIds: [] };
  let anchorIdx = ai;
  let replacedIdx: number | undefined;
  if (mol.atoms[ai].element === 'H' && topo.neighbors[ai].length > 0) {
    replacedIdx = ai;
    anchorIdx = topo.neighbors[ai][0];
  } else if (!((analyzeValence(mol).get(mol.atoms[ai].id)?.openValence ?? 0) > 0)) {
    // Saturated (or unchecked) heavy atom: replace one of its hydrogens, if any.
    replacedIdx = terminalHydrogens(mol, ai)[0];
  }
  const anchor = mol.atoms[anchorIdx];
  const pA = posOf(anchor);
  let u: Vec3;
  if (replacedIdx !== undefined && distance(posOf(mol.atoms[replacedIdx]), pA) > 1e-6) {
    u = normalize(sub(posOf(mol.atoms[replacedIdx]), pA));
  } else {
    u = openValenceDirections(mol, anchor.id, 1)[0] ?? [1, 0, 0];
  }

  // Template direction from the attach atom towards where the anchor goes.
  const ta = frag.attachAtom;
  const th = frag.attachHydrogen;
  const hasAttachH = th >= 0 && th < T.length && th !== ta;
  let t: Vec3;
  if (hasAttachH) t = normalize(sub(T[th], T[ta]));
  else {
    const others = T.filter((_, k) => k !== ta);
    if (others.length === 0) t = [1, 0, 0];
    else {
      const c = others.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3).map((x) => x / others.length) as Vec3;
      t = length(sub(T[ta], c)) > 1e-6 ? normalize(sub(T[ta], c)) : [1, 0, 0];
    }
  }
  const R = rotationBetween(t, scale(u, -1));
  const L = idealBondLength(anchor.element, elements[ta], 1);
  const attachPos = add(pA, scale(u, L));
  const base = T.map((p) => add(attachPos, applyMat3(R, sub(p, T[ta]))));
  const keep = T.map((_, k) => !(hasAttachH && k === th));

  // Atoms of the molecule near the fragment (excluding the anchor and the hydrogen being replaced).
  let extent = 0;
  for (const p of base) extent = Math.max(extent, distance(p, attachPos));
  const reach2 = (extent + 3.5) ** 2;
  const near: Vec3[] = [];
  for (let k = 0; k < mol.atoms.length; k++) {
    if (k === anchorIdx || k === replacedIdx) continue;
    const a = mol.atoms[k];
    const dx = a.x - attachPos[0];
    const dy = a.y - attachPos[1];
    const dz = a.z - attachPos[2];
    if (dx * dx + dy * dy + dz * dz <= reach2) near.push([a.x, a.y, a.z]);
  }
  let bestPos = base;
  let bestScore = -Infinity;
  for (let step = 0; step < 12; step++) {
    const rotated = step === 0 ? base : base.map((p) => rotateAround(p, attachPos, u, step * 30));
    let score = Infinity;
    for (let k = 0; k < rotated.length; k++) {
      if (!keep[k] || k === ta) continue;
      for (const q of near) score = Math.min(score, distance(rotated[k], q));
    }
    if (score > bestScore + 1e-9) {
      bestScore = score;
      bestPos = rotated;
    }
  }
  const removed = new Set<number>();
  if (replacedIdx !== undefined) removed.add(mol.atoms[replacedIdx].id);
  return appendFragment(mol, frag, elements, bestPos, removed, anchor, hasAttachH ? th : undefined);
}

/** Append template atoms at `positions` (skipping `skip`), remove `removed`, bond attach atom to `anchor`. */
function appendFragment(
  mol: Molecule,
  frag: NonNullable<ReturnType<typeof getFragment>>,
  elements: string[],
  positions: Vec3[],
  removed: Set<number>,
  anchor: Atom | undefined,
  skip: number | undefined,
): { mol: Molecule; atomIds: number[] } {
  const namer = new AtomNamer(mol.atoms);
  const info = residueInfoFrom(anchor);
  const scope = residueScope(info);
  let atomId = freshAtomId(mol);
  let bondId = freshBondId(mol);
  const idOf = new Map<number, number>();
  const newAtoms: Atom[] = [];
  frag.atoms.forEach((ta, k) => {
    if (k === skip) return;
    const atom = makeAtom(atomId, elements[k], positions[k], namer.next(elements[k], scope), info);
    const q = Math.round(ta.charge ?? 0);
    if (q) atom.charge = q;
    newAtoms.push(atom);
    idOf.set(k, atomId++);
  });
  const newBonds: Bond[] = [];
  for (const b of frag.bonds) {
    const a = idOf.get(b.a);
    const c = idOf.get(b.b);
    if (a === undefined || c === undefined || a === c) continue;
    newBonds.push({ id: bondId++, a, b: c, order: b.order });
  }
  const attachId = idOf.get(frag.attachAtom);
  if (anchor && attachId !== undefined) newBonds.push({ id: bondId++, a: anchor.id, b: attachId, order: 1 });
  const atoms = (removed.size ? mol.atoms.filter((a) => !removed.has(a.id)) : mol.atoms).concat(newAtoms);
  const bonds = (removed.size ? mol.bonds.filter((b) => !removed.has(b.a) && !removed.has(b.b)) : mol.bonds).concat(newBonds);
  return {
    mol: { ...mol, atoms, bonds, nextAtomId: atomId, nextBondId: bondId },
    atomIds: newAtoms.map((a) => a.id),
  };
}

/** Append all atoms/bonds of `other` (new ids), optionally translated. Returns created atom ids. */
export function mergeMolecules(mol: Molecule, other: Molecule, offset?: Vec3): { mol: Molecule; atomIds: number[] } {
  if (other.atoms.length === 0) return { mol, atomIds: [] };
  const off = offset ?? [0, 0, 0];
  let atomId = freshAtomId(mol);
  let bondId = freshBondId(mol);
  const idMap = new Map<number, number>();
  const newAtoms: Atom[] = other.atoms.map((a) => {
    const id = atomId++;
    idMap.set(a.id, id);
    return { ...a, id, x: a.x + off[0], y: a.y + off[1], z: a.z + off[2] };
  });
  const newBonds: Bond[] = [];
  for (const b of other.bonds) {
    const a = idMap.get(b.a);
    const c = idMap.get(b.b);
    if (a === undefined || c === undefined) continue;
    newBonds.push({ ...b, id: bondId++, a, b: c });
  }
  return {
    mol: { ...mol, atoms: mol.atoms.concat(newAtoms), bonds: mol.bonds.concat(newBonds), nextAtomId: atomId, nextBondId: bondId },
    atomIds: newAtoms.map((a) => a.id),
  };
}

/** Translate the whole molecule so its centroid is at the origin. */
export function centerMolecule(mol: Molecule): Molecule {
  if (mol.atoms.length === 0) return mol;
  const c = centroid(mol);
  if (c[0] === 0 && c[1] === 0 && c[2] === 0) return mol;
  return transformAtoms(mol, null, (p) => sub(p, c));
}
