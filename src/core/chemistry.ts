/**
 * Chemical analysis: valence checks, bond validity, formula, mass, rings.
 * OWNER: chemistry agent. CONTRACT: keep exported names & signatures.
 *
 * Valence model (used for editor feedback, not as a full chemistry toolkit)
 * - Allowed valences come from ElementInfo.valences, adjusted for formal charge (allowedValences()).
 * - Bonds to "unchecked" partners (metals, noble gases, dummy 'X') are treated as optional: they may
 *   count as covalent bonds or as dative/coordination bonds, whichever makes the atom's valence valid.
 *   So an NH3 ligand bound to a metal or a carboxylate O− bridging to Zn is still 'ok'.
 * - Aromatic bonds (order 1.5) use the rule in effectiveValence() so that benzene C–H, pyridine N,
 *   pyrrole N–H, furan O and fused ring carbons all come out at their normal valence.
 */
import type { BondOrder, Molecule } from './types';
import { getElement, type ElementInfo } from './elements';
import { createStructureCache, getTopology } from './molecule';

export type ValenceStatus = 'ok' | 'under' | 'over' | 'unchecked';

export interface ValenceInfo {
  atomId: number;
  element: string;
  /**
   * Effective bond-order sum used for the check (implicit hydrogens are NOT counted). Plain sum for
   * non-aromatic atoms; for aromatic atoms the rounded value from the aromatic rule (benzene C–H = 4,
   * pyrrole N–H = 3). Optional metal/coordination bonds are included as far as they fit the valence.
   */
  bondOrderSum: number;
  /** Allowed total valences for this atom given its formal charge (empty = unchecked, e.g. metals). */
  allowed: number[];
  status: ValenceStatus;
  /** Number of additional single bonds needed to reach the nearest allowed valence (0 if ok/over/unchecked). */
  openValence: number;
  /** Human-readable explanation for 'over' / 'under', e.g. "C has 5 bonds (max 4)". */
  message?: string;
}

// ---------------------------------------------------------------------------
// Allowed valences
// ---------------------------------------------------------------------------

/** Number of valence electrons for main-group elements (groups 1, 2, 13–18), else undefined. */
function valenceElectrons(el: ElementInfo): number | undefined {
  const g = el.group;
  if (g === undefined) return undefined;
  if (g <= 2) return g;
  if (g >= 13) return g - 10;
  return undefined;
}

/**
 * Allowed valences for an element with a formal charge.
 * - neutral: ElementInfo.valences (empty → unchecked).
 * - charged main-group atoms follow the octet rule of the isoelectronic atom: N+ / B− → 4 (like C),
 *   O+ / C− / C+ → 3, N− / halogen+ → 2, O− / S− → 1, F− / Cl− / O2− → 0. H+ and H− → 0.
 * - heavier pnictogen anions may also be hypervalent (PF6−, AsF6−, SbF6−): P−/As−/Sb− → 2, 4, 6.
 */
export function allowedValences(element: string, charge = 0): number[] {
  const el = getElement(element);
  if (el.valences.length === 0) return [];
  const q = Math.round(charge || 0);
  if (q === 0) return el.valences.slice();
  if (el.number === 1) return [0];
  const ve = valenceElectrons(el);
  if (ve === undefined) return [];
  const e = ve - q;
  if (e < 0 || e > 8) return [];
  if (el.group === 15 && (el.period ?? 0) >= 3 && q === -1) return [2, 4, 6];
  return [e <= 4 ? e : 8 - e];
}

// ---------------------------------------------------------------------------
// Effective valence of one atom
// ---------------------------------------------------------------------------

/**
 * Effective (integer) valence from the orders of an atom's bonds to valence-checked partners.
 * Aromatic rule, with k = number of aromatic (1.5) bonds and s = sum of the other orders:
 * - k = 0: s.
 * - k = 1: s + 2 (a lone aromatic bond counts as 1.5 rounded up).
 * - k ≥ 2: s + k, plus 1 if that is below the lowest allowed valence (the atom then carries the ring's
 *   π bond): benzene C–H 1+2+1 = 4, pyridine N 0+2+1 = 3, pyrrole N–H 1+2 = 3, furan O 0+2 = 2,
 *   naphthalene fusion C 0+3+1 = 4, aromatic C=O (2-pyridone, caffeine) 2+2 = 4.
 *   An atom with more than three σ bonds cannot be an sp2 ring atom, so it uses the plain sum
 *   rounded up instead (benzene C with two hydrogens → 5, over-valent).
 */
export function effectiveValence(orders: readonly number[], allowed: readonly number[] = []): number {
  let k = 0;
  let s = 0;
  for (const o of orders) {
    if (o === 1.5) k++;
    else s += o;
  }
  if (k === 0) return s;
  if (k === 1) return s + 2;
  if (orders.length > 3) return Math.ceil(s + 1.5 * k);
  let v = s + k;
  if (allowed.length > 0 && v < allowed[0]) v += 1;
  return v;
}

export interface ValenceEvaluation {
  status: ValenceStatus;
  /** Effective valence (see ValenceInfo.bondOrderSum). */
  sum: number;
  openValence: number;
}

/**
 * Evaluate an atom from the orders of its bonds to checked partners (`orders`) and the order sum of
 * its bonds to unchecked partners (`flexSum`, metals etc., which may or may not count).
 */
export function evaluateValence(orders: readonly number[], flexSum: number, allowed: readonly number[]): ValenceEvaluation {
  const lo = effectiveValence(orders, allowed);
  const hi = lo + Math.ceil(flexSum);
  if (allowed.length === 0) return { status: 'unchecked', sum: hi, openValence: 0 };
  let okValue = -1;
  for (const v of allowed) if (v >= lo && v <= hi) okValue = v;
  if (okValue >= 0) return { status: 'ok', sum: okValue, openValence: 0 };
  const max = allowed[allowed.length - 1];
  if (lo > max) return { status: 'over', sum: lo, openValence: 0 };
  let target = max;
  for (const v of allowed) {
    if (v >= hi) {
      target = v;
      break;
    }
  }
  return { status: 'under', sum: hi, openValence: target - hi };
}

/** 'N', 'N+', 'O−', 'Fe2+' … */
export function formatAtomLabel(element: string, charge?: number): string {
  const q = Math.round(charge ?? 0);
  if (!q) return element;
  const mag = Math.abs(q) === 1 ? '' : String(Math.abs(q));
  return element + mag + (q > 0 ? '+' : '−');
}

/** Bond environment of one atom, split into checked partners and optional (metal) partners. */
interface BondEnv {
  /** Orders of bonds to valence-checked partners. */
  orders: number[];
  /** Order sum of bonds to unchecked partners (metals, noble gases, 'X'). */
  flexSum: number;
  /** True if every bond of the atom is single. */
  allSingle: boolean;
}

function bondEnv(mol: Molecule, index: number): BondEnv {
  const topo = getTopology(mol);
  const atom = mol.atoms[index];
  const orders: number[] = [];
  let flexSum = 0;
  let allSingle = true;
  for (const bi of topo.atomBonds[index]) {
    const bond = mol.bonds[bi];
    const otherId = bond.a === atom.id ? bond.b : bond.a;
    const oi = topo.idToIndex.get(otherId);
    if (oi === undefined) continue;
    if (bond.order !== 1) allSingle = false;
    if (getElement(mol.atoms[oi].element).valences.length === 0) flexSum += bond.order;
    else orders.push(bond.order);
  }
  return { orders, flexSum, allSingle };
}

function isIonResidueAtom(mol: Molecule, index: number): boolean {
  const topo = getTopology(mol);
  const r = topo.atomResidue[index];
  return r >= 0 && topo.residues[r].kind === 'ion';
}

/**
 * Valence analysis for every atom (map keyed by atom id).
 * Charge rules: N+ / O+ / S+ behave like the next group (N+ → 4, O+ → 3), N- → 2, O- → 1, C+/C- → 3, B- → 4.
 * Aromatic bonds (1.5): an atom's sum is rounded the chemically sensible way (e.g. aromatic C with
 * two 1.5 bonds + one H = 4 → ok). Metals / unknown elements → 'unchecked'.
 * Atoms of ion residues (PDB 'NA', 'CL', …) are 'unchecked' as well.
 * Cached per structure (molecule/structureKey): coordinate-only updates (drags) return the same Map;
 * any change of elements, charges, residue info or bonds (endpoints, orders) recomputes. Do not mutate.
 */
export function analyzeValence(mol: Molecule): Map<number, ValenceInfo> {
  return valenceOfStructure(mol);
}

/** Coordinate-independent: reads elements, charges, residues (ion check) and bonds only. */
const valenceOfStructure = createStructureCache(computeValence);

function computeValence(mol: Molecule): Map<number, ValenceInfo> {
  const out = new Map<number, ValenceInfo>();
  for (let i = 0; i < mol.atoms.length; i++) {
    const atom = mol.atoms[i];
    const allowed = isIonResidueAtom(mol, i) ? [] : allowedValences(atom.element, atom.charge);
    const env = bondEnv(mol, i);
    const ev = evaluateValence(env.orders, env.flexSum, allowed);
    const info: ValenceInfo = {
      atomId: atom.id,
      element: atom.element,
      bondOrderSum: ev.sum,
      allowed,
      status: ev.status,
      openValence: ev.openValence,
    };
    const label = formatAtomLabel(atom.element, atom.charge);
    if (ev.status === 'over') {
      const max = allowed[allowed.length - 1];
      const n = env.orders.length; // metal bonds never make an atom over-valent, so they are not counted
      info.message = env.allSingle
        ? `${label} has ${n} bond${n === 1 ? '' : 's'} (max ${max})`
        : `${label} has valence ${ev.sum} (max ${max})`;
    } else if (ev.status === 'under') {
      const k = ev.openValence;
      info.message = `${label} has ${k} open valence${k === 1 ? '' : 's'} (valence ${ev.sum} of ${ev.sum + k})`;
    }
    out.set(atom.id, info);
  }
  return out;
}

/** Valence info for a single atom id. */
export function valenceOf(mol: Molecule, atomId: number): ValenceInfo | undefined {
  return analyzeValence(mol).get(atomId);
}

// ---------------------------------------------------------------------------
// Bond validity
// ---------------------------------------------------------------------------

export interface BondCheckOptions {
  /**
   * Treat explicit terminal hydrogens on the two atoms as removable (they would be replaced, e.g. by the
   * editor's auto-hydrogen step). Default false: the check is made against the molecule as it is.
   */
  hydrogensRemovable?: boolean;
}

/** Maximum distance (Å) at which a NEW bond is accepted. */
export const MAX_NEW_BOND_DISTANCE = 4;

/** Count of terminal hydrogens (H with exactly one bond) bonded to atom index i by single bonds. */
function terminalHydrogenCount(mol: Molecule, i: number): number {
  const topo = getTopology(mol);
  const atom = mol.atoms[i];
  let n = 0;
  for (const bi of topo.atomBonds[i]) {
    const bond = mol.bonds[bi];
    if (bond.order !== 1) continue;
    const oi = topo.idToIndex.get(bond.a === atom.id ? bond.b : bond.a);
    if (oi === undefined) continue;
    if (mol.atoms[oi].element === 'H' && topo.atomBonds[oi].length === 1) n++;
  }
  return n;
}

/**
 * Check one atom after a bond change. `oldOrder` is the order of the bond being replaced (0 = new bond),
 * `partnerFlexible` whether the partner is a metal/unchecked atom.
 */
function checkAtomAfterChange(
  mol: Molecule,
  index: number,
  oldOrder: number,
  newOrder: number,
  partnerFlexible: boolean,
  hydrogensRemovable: boolean,
): string | undefined {
  const atom = mol.atoms[index];
  const allowed = isIonResidueAtom(mol, index) ? [] : allowedValences(atom.element, atom.charge);
  if (allowed.length === 0) return undefined;
  const env = bondEnv(mol, index);
  let orders = env.orders;
  if (!partnerFlexible) {
    orders = orders.slice();
    if (oldOrder > 0) {
      const at = orders.indexOf(oldOrder);
      if (at >= 0) orders.splice(at, 1);
    }
    orders.push(newOrder);
  }
  // Bonds to metals never push the atom over (they may be dative); only checked bonds count.
  let lo = effectiveValence(orders, allowed);
  if (hydrogensRemovable) {
    let h = terminalHydrogenCount(mol, index);
    while (h > 0 && lo > allowed[allowed.length - 1]) {
      const at = orders.indexOf(1);
      if (at < 0) break;
      orders = orders.slice();
      orders.splice(at, 1);
      lo = effectiveValence(orders, allowed);
      h--;
    }
  }
  const max = allowed[allowed.length - 1];
  if (lo > max) return `${formatAtomLabel(atom.element, atom.charge)} would have valence ${lo} (max ${max})`;
  return undefined;
}

/**
 * Whether adding (or upgrading to) a bond a–b of the given order is chemically acceptable.
 * Not ok if: same atom, atom missing, the change would push either atom over its maximum valence,
 * or (for a new bond) the atoms are farther apart than 4 Å (reason: "too far apart").
 * Upgrading an existing bond's order only counts the difference.
 * Setting an existing bond to its current order is ok (no change).
 */
export function canAddBond(
  mol: Molecule,
  a: number,
  b: number,
  order: BondOrder,
  opts: BondCheckOptions = {},
): { ok: boolean; reason?: string } {
  if (a === b) return { ok: false, reason: 'Cannot bond an atom to itself' };
  const topo = getTopology(mol);
  const ia = topo.idToIndex.get(a);
  const ib = topo.idToIndex.get(b);
  if (ia === undefined || ib === undefined) return { ok: false, reason: 'Atom not found' };
  const A = mol.atoms[ia];
  const B = mol.atoms[ib];
  let existing = 0;
  for (const bi of topo.atomBonds[ia]) {
    const bond = mol.bonds[bi];
    if ((bond.a === a && bond.b === b) || (bond.a === b && bond.b === a)) existing = bond.order;
  }
  if (existing === order) return { ok: true };
  if (existing === 0) {
    const d = Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
    if (d > MAX_NEW_BOND_DISTANCE) return { ok: false, reason: `Atoms are too far apart (${d.toFixed(2)} Å)` };
  }
  const flexA = getElement(A.element).valences.length === 0;
  const flexB = getElement(B.element).valences.length === 0;
  const removable = !!opts.hydrogensRemovable;
  const ra = checkAtomAfterChange(mol, ia, existing, order, flexB, removable);
  if (ra) return { ok: false, reason: ra };
  const rb = checkAtomAfterChange(mol, ib, existing, order, flexA, removable);
  if (rb) return { ok: false, reason: rb };
  return { ok: true };
}

/** Whether atom `atomId` can accept one more bond of `order` (used for add-atom previews). */
export function canAcceptBond(
  mol: Molecule,
  atomId: number,
  order: BondOrder,
  opts: BondCheckOptions = {},
): { ok: boolean; reason?: string } {
  const idx = getTopology(mol).idToIndex.get(atomId);
  if (idx === undefined) return { ok: false, reason: 'Atom not found' };
  const reason = checkAtomAfterChange(mol, idx, 0, order, false, !!opts.hydrogensRemovable);
  return reason ? { ok: false, reason } : { ok: true };
}

/**
 * Policy for showing under-valence (open valence) markers: true if the molecule contains any explicit
 * hydrogens, or meta.source is 'editor' / 'smiles', or it has fewer than 30 heavy atoms and no residues.
 * (Protein structures from the PDB usually lack hydrogens — every atom would look under-valent.)
 */
export function shouldShowUnderValence(mol: Molecule): boolean {
  const src = mol.meta.source;
  if (src === 'editor' || src === 'smiles') return true;
  let heavy = 0;
  for (const a of mol.atoms) {
    if (a.element === 'H') return true;
    heavy++;
  }
  return heavy < 30 && getTopology(mol).residues.length === 0;
}

// ---------------------------------------------------------------------------
// Formula, mass, charge, summary
// ---------------------------------------------------------------------------

function* iterAtoms(mol: Molecule, atomIds?: Iterable<number>) {
  if (!atomIds) {
    yield* mol.atoms;
    return;
  }
  const topo = getTopology(mol);
  const seen = new Set<number>();
  for (const id of atomIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const idx = topo.idToIndex.get(id);
    if (idx !== undefined) yield mol.atoms[idx];
  }
}

/** Molecular formula in Hill order (C, H, then alphabetical; alphabetical if no carbon), e.g. "C8H10N4O2". */
export function molecularFormula(mol: Molecule, atomIds?: Iterable<number>): string {
  const counts = new Map<string, number>();
  for (const a of iterAtoms(mol, atomIds)) counts.set(a.element, (counts.get(a.element) ?? 0) + 1);
  const symbols = [...counts.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const order: string[] = [];
  if (counts.has('C')) {
    order.push('C');
    if (counts.has('H')) order.push('H');
    for (const s of symbols) if (s !== 'C' && s !== 'H') order.push(s);
  } else order.push(...symbols);
  return order.map((s) => (counts.get(s) === 1 ? s : s + counts.get(s))).join('');
}

/** Molecular mass in g/mol (sum of standard atomic weights). */
export function molecularMass(mol: Molecule, atomIds?: Iterable<number>): number {
  const massOf = new Map<string, number>();
  let m = 0;
  for (const a of iterAtoms(mol, atomIds)) {
    let w = massOf.get(a.element);
    if (w === undefined) {
      w = getElement(a.element).mass;
      massOf.set(a.element, w);
    }
    m += w;
  }
  return m;
}

/** Sum of formal charges. */
export function netCharge(mol: Molecule, atomIds?: Iterable<number>): number {
  let q = 0;
  for (const a of iterAtoms(mol, atomIds)) q += a.charge ?? 0;
  return q;
}

export interface MoleculeSummary {
  atoms: number;
  heavyAtoms: number;
  hydrogens: number;
  bonds: number;
  residues: number;
  chains: number;
  formula: string;
  mass: number;
  charge: number;
  /** Number of atoms that are over-valent. */
  valenceErrors: number;
}

/** Cached per structure (shared across coordinate-only updates, like analyzeValence). Do not mutate. */
export function moleculeSummary(mol: Molecule): MoleculeSummary {
  return summaryOfStructure(mol);
}

/** Coordinate-independent: counts, formula, mass, charge, topology and valence only. */
const summaryOfStructure = createStructureCache(computeSummary);

function computeSummary(mol: Molecule): MoleculeSummary {
  const topo = getTopology(mol);
  let hydrogens = 0;
  for (const a of mol.atoms) if (a.element === 'H') hydrogens++;
  let valenceErrors = 0;
  for (const v of analyzeValence(mol).values()) if (v.status === 'over') valenceErrors++;
  const summary: MoleculeSummary = {
    atoms: mol.atoms.length,
    heavyAtoms: mol.atoms.length - hydrogens,
    hydrogens,
    bonds: mol.bonds.length,
    residues: topo.residues.length,
    chains: topo.chains.filter((c) => c.residueIndices.length > 0).length,
    formula: molecularFormula(mol),
    mass: molecularMass(mol),
    charge: netCharge(mol),
    valenceErrors,
  };
  return summary;
}

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

interface RingData {
  /** Per bond index: 1 if the bond lies on a cycle (is not a bridge). */
  ringBond: Uint8Array;
  /** Per atom index: 1 if the atom has a ring bond. */
  ringAtom: Uint8Array;
  /** Lazily computed SSSR (atom ids in ring order). */
  rings?: number[][];
}

/**
 * Ring data per structure (shared across coordinate-only updates; the lazily added SSSR as well).
 * Coordinate-independent: reads the bond graph only.
 */
const ringDataOfStructure = createStructureCache(computeRingData);

/** Neighbour lists carrying bond indices, built from the cached topology. */
function adjacencyWithBonds(mol: Molecule): { nbr: number[][]; edge: number[][] } {
  const topo = getTopology(mol);
  const n = mol.atoms.length;
  const nbr: number[][] = new Array(n);
  const edge: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    nbr[i] = [];
    edge[i] = [];
    const id = mol.atoms[i].id;
    for (const bi of topo.atomBonds[i]) {
      const bond = mol.bonds[bi];
      const j = topo.idToIndex.get(bond.a === id ? bond.b : bond.a);
      if (j === undefined || j === i) continue;
      nbr[i].push(j);
      edge[i].push(bi);
    }
  }
  return { nbr, edge };
}

function ringData(mol: Molecule): RingData {
  return ringDataOfStructure(mol);
}

/** Ring bonds = bonds that are not bridges (iterative Tarjan low-link, O(V + E)). */
function computeRingData(mol: Molecule): RingData {
  const n = mol.atoms.length;
  const { nbr, edge } = adjacencyWithBonds(mol);
  const ringBond = new Uint8Array(mol.bonds.length);
  const ringAtom = new Uint8Array(n);
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const parentEdge = new Int32Array(n).fill(-1);
  const iter = new Int32Array(n);
  const isBridge = new Uint8Array(mol.bonds.length);
  const stack: number[] = [];
  let time = 0;
  for (let root = 0; root < n; root++) {
    if (disc[root] >= 0) continue;
    disc[root] = low[root] = time++;
    stack.push(root);
    while (stack.length) {
      const v = stack[stack.length - 1];
      if (iter[v] < nbr[v].length) {
        const k = iter[v]++;
        const w = nbr[v][k];
        const e = edge[v][k];
        if (e === parentEdge[v]) continue;
        if (disc[w] < 0) {
          parentEdge[w] = e;
          disc[w] = low[w] = time++;
          stack.push(w);
        } else if (disc[w] < low[v]) low[v] = disc[w];
      } else {
        stack.pop();
        if (stack.length) {
          const p = stack[stack.length - 1];
          if (low[v] < low[p]) low[p] = low[v];
          if (low[v] > disc[p]) isBridge[parentEdge[v]] = 1;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < edge[i].length; k++) {
      const e = edge[i][k];
      if (!isBridge[e]) {
        ringBond[e] = 1;
        ringAtom[i] = 1;
      }
    }
  }
  return { ringBond, ringAtom };
}

/** True if the bond between atom ids a and b is part of a ring. */
export function isBondInRing(mol: Molecule, a: number, b: number): boolean {
  const topo = getTopology(mol);
  const ia = topo.idToIndex.get(a);
  if (ia === undefined) return false;
  const rd = ringData(mol);
  for (const bi of topo.atomBonds[ia]) {
    const bond = mol.bonds[bi];
    if ((bond.a === a && bond.b === b) || (bond.a === b && bond.b === a)) return rd.ringBond[bi] === 1;
  }
  return false;
}

/** True if the atom is part of at least one ring. */
export function isAtomInRing(mol: Molecule, atomId: number): boolean {
  const idx = getTopology(mol).idToIndex.get(atomId);
  return idx !== undefined && ringData(mol).ringAtom[idx] === 1;
}

/** Per bond index (molecule.bonds order): 1 if the bond is in a ring. Cached; do not mutate. */
export function ringBondMask(mol: Molecule): Uint8Array {
  return ringData(mol).ringBond;
}

/**
 * Smallest set of smallest rings (approximate is fine): each ring is a list of atom ids in ring order. Cached.
 *
 * Algorithm, per ring system (connected component of ring bonds, cyclomatic number c = E − V + 1):
 * - c = 1: the system is a single cycle, walked directly.
 * - otherwise Horton-style candidates: for every root atom r, a BFS tree gives one cycle
 *   P(r,x) + (x,y) + P(y,r) per non-tree edge (x,y) whose paths only share r. Candidates are sorted
 *   by size and added greedily when linearly independent over GF(2) (edge-incidence bit vectors,
 *   Gaussian elimination) until c rings are found — a minimum cycle basis (exact SSSR for ring
 *   systems ≤ 300 atoms). Very large systems bound the BFS depth (rings ≤ 49 atoms) and fall back to
 *   fundamental cycles of a spanning tree for anything bigger, so the ring count is always c.
 */
export function findRings(mol: Molecule): number[][] {
  const rd = ringData(mol);
  if (rd.rings) return rd.rings;
  const rings: number[][] = [];
  const n = mol.atoms.length;
  const { nbr, edge } = adjacencyWithBonds(mol);
  // Restrict adjacency to ring bonds.
  const rn: number[][] = new Array(n);
  const re: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    rn[i] = [];
    re[i] = [];
    if (!rd.ringAtom[i]) continue;
    for (let k = 0; k < nbr[i].length; k++) {
      if (rd.ringBond[edge[i][k]]) {
        rn[i].push(nbr[i][k]);
        re[i].push(edge[i][k]);
      }
    }
  }
  const compOf = new Int32Array(n).fill(-1);
  for (let s = 0; s < n; s++) {
    if (!rd.ringAtom[s] || compOf[s] >= 0) continue;
    // Collect the ring system containing s.
    const verts: number[] = [s];
    compOf[s] = s;
    for (let qi = 0; qi < verts.length; qi++) {
      for (const w of rn[verts[qi]]) {
        if (compOf[w] < 0) {
          compOf[w] = s;
          verts.push(w);
        }
      }
    }
    const edgeSet = new Set<number>();
    for (const v of verts) for (const e of re[v]) edgeSet.add(e);
    const cyclomatic = edgeSet.size - verts.length + 1;
    if (cyclomatic <= 0) continue;
    const found = cyclomatic === 1 ? [walkCycle(verts[0], rn)] : ringSystemSSSR(verts, edgeSet, rn, re, cyclomatic);
    for (const r of found) rings.push(r.map((i) => mol.atoms[i].id));
  }
  rings.sort((x, y) => x.length - y.length);
  rd.rings = rings;
  return rings;
}

/** Walk a simple cycle (every vertex has exactly two ring neighbours). Returns atom indices. */
function walkCycle(start: number, rn: number[][]): number[] {
  const out = [start];
  let prev = -1;
  let cur = start;
  for (;;) {
    const next = rn[cur][0] !== prev ? rn[cur][0] : rn[cur][1];
    if (next === undefined || next === start) break;
    out.push(next);
    prev = cur;
    cur = next;
  }
  return out;
}

interface Candidate {
  verts: number[];
  edges: number[];
  key: string;
}

/**
 * Minimum cycle basis of one ring system (atom indices per ring).
 * Horton candidates are generated with iterative deepening (BFS depth 3, 6, 12, 24, then unbounded for
 * systems ≤ 300 atoms): every Horton cycle of length ≤ 2d+1 is found at depth d, so taking candidates
 * round by round in size order is equivalent to the full Horton algorithm, but large fused systems
 * (graphene flakes, cages) usually complete in the first, cheap round.
 */
function ringSystemSSSR(
  verts: number[],
  edgeSet: Set<number>,
  rn: number[][],
  re: number[][],
  cyclomatic: number,
): number[][] {
  // Local edge numbering for bit vectors.
  const localEdge = new Map<number, number>();
  for (const e of edgeSet) localEdge.set(e, localEdge.size);
  const words = Math.ceil(localEdge.size / 32);

  const depth = new Map<number, number>();
  const parent = new Map<number, number>();
  const parentEdge = new Map<number, number>();
  const branch = new Map<number, number>();
  const pathTo = (v: number): { vs: number[]; es: number[] } => {
    const vs: number[] = [];
    const es: number[] = [];
    let x = v;
    while (parent.has(x)) {
      vs.push(x);
      es.push(parentEdge.get(x)!);
      x = parent.get(x)!;
    }
    vs.push(x); // root
    return { vs, es };
  };
  const keyOf = (edges: number[]) =>
    edges
      .map((e) => localEdge.get(e)!)
      .sort((x, y) => x - y)
      .join(',');

  const basis = new Map<number, Uint32Array>(); // pivot bit → vector whose lowest set bit is the pivot
  const accepted: number[][] = [];
  /** Add the cycle to the basis if it is linearly independent (GF(2) elimination). */
  const tryAdd = (edges: number[]): boolean => {
    const v = new Uint32Array(words);
    for (const e of edges) {
      const b = localEdge.get(e)!;
      v[b >>> 5] ^= 1 << (b & 31);
    }
    for (;;) {
      let pivot = -1;
      for (let w = 0; w < words; w++) {
        if (v[w] !== 0) {
          pivot = (w << 5) + (31 - Math.clz32(v[w] & -v[w]));
          break;
        }
      }
      if (pivot < 0) return false; // dependent on accepted rings
      const bv = basis.get(pivot);
      if (!bv) {
        basis.set(pivot, v);
        return true;
      }
      for (let w = 0; w < words; w++) v[w] ^= bv[w];
    }
  };

  const tested = new Set<string>();
  const depths = verts.length <= 300 ? [3, 6, 12, 24, Infinity] : [3, 6, 12, 24];
  for (const maxDepth of depths) {
    const round = new Map<string, Candidate>();
    for (const r of verts) {
      depth.clear();
      parent.clear();
      parentEdge.clear();
      branch.clear();
      depth.set(r, 0);
      branch.set(r, r);
      const queue = [r];
      const seenEdge = new Set<number>();
      for (let qi = 0; qi < queue.length; qi++) {
        const x = queue[qi];
        const dx = depth.get(x)!;
        for (let k = 0; k < rn[x].length; k++) {
          const y = rn[x][k];
          const e = re[x][k];
          if (e === parentEdge.get(x)) continue;
          if (!depth.has(y)) {
            if (dx + 1 > maxDepth) continue;
            depth.set(y, dx + 1);
            parent.set(y, x);
            parentEdge.set(y, e);
            branch.set(y, x === r ? y : branch.get(x)!);
            queue.push(y);
          } else if (!seenEdge.has(e) && e !== parentEdge.get(y)) {
            seenEdge.add(e);
            if (branch.get(x) === branch.get(y)) continue; // paths overlap → not a simple cycle through r
            const px = pathTo(x);
            const py = pathTo(y);
            const ce = px.es.concat(py.es, [e]);
            const key = keyOf(ce);
            if (tested.has(key) || round.has(key)) continue;
            // r … x, then y … (child of r): px reversed + py without the root.
            round.set(key, { verts: px.vs.slice().reverse().concat(py.vs.slice(0, -1)), edges: ce, key });
          }
        }
      }
    }
    const sorted = [...round.values()].sort((a, b) => a.edges.length - b.edges.length || (a.key < b.key ? -1 : 1));
    for (const c of sorted) {
      tested.add(c.key);
      if (tryAdd(c.edges)) {
        accepted.push(c.verts);
        if (accepted.length >= cyclomatic) return accepted;
      }
    }
  }

  // Completeness fallback (very large ring systems only): fundamental cycles of a BFS spanning tree.
  depth.clear();
  parent.clear();
  parentEdge.clear();
  const root = verts[0];
  depth.set(root, 0);
  const queue = [root];
  const treeEdges = new Set<number>();
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < rn[x].length; k++) {
      const y = rn[x][k];
      if (depth.has(y)) continue;
      depth.set(y, depth.get(x)! + 1);
      parent.set(y, x);
      parentEdge.set(y, re[x][k]);
      treeEdges.add(re[x][k]);
      queue.push(y);
    }
  }
  const extra: { verts: number[]; edges: number[] }[] = [];
  for (const x of verts) {
    for (let k = 0; k < rn[x].length; k++) {
      const y = rn[x][k];
      const e = re[x][k];
      if (treeEdges.has(e) || x > y) continue;
      // Cycle = x → lowest common ancestor → y, closed by the edge (x, y).
      const px = pathTo(x);
      const py = pathTo(y);
      const inPy = new Set(py.vs);
      let cut = 0;
      while (!inPy.has(px.vs[cut])) cut++;
      const cutY = py.vs.indexOf(px.vs[cut]);
      extra.push({
        verts: px.vs.slice(0, cut + 1).concat(py.vs.slice(0, cutY).reverse()),
        edges: px.es.slice(0, cut).concat(py.es.slice(0, cutY), [e]),
      });
    }
  }
  extra.sort((a, b) => a.edges.length - b.edges.length);
  for (const c of extra) {
    if (accepted.length >= cyclomatic) break;
    if (tryAdd(c.edges)) accepted.push(c.verts);
  }
  return accepted;
}
