/**
 * Pure validation and preview computations for the editor tools: "what would happen if…" for
 * bonds, new atoms, deletions, element/charge changes and atom drags, plus the wording of the
 * hints and undo labels. Nothing here touches the store or the DOM.
 *
 * Validity rules come from core/chemistry (canAddBond / canAcceptBond / valenceOf). On top of them
 * this module models the editor's "auto hydrogens" behaviour: a bond that would over-fill an atom
 * is still acceptable when enough hydrogens on that atom can be removed to make room.
 */
import type { Bond, BondOrder, MeasureKind, Molecule, Vec3 } from '../core/types';
import { atomById, bondBetween, getTopology } from '../core/molecule';
import { canAcceptBond, canAddBond, valenceOf } from '../core/chemistry';
import { add, distance, idealBondLength, length, normalize, scale, sub, suggestNewAtomPosition } from '../core/geometry';
import { getElement } from '../core/elements';
import { SpatialGrid } from './spatial';

/** canAddBond refuses new bonds between atoms farther apart than this (Å). */
export const MAX_BOND_DISTANCE = 4;
/** Drag feedback: suggest a bond when d ≤ SUGGEST_FACTOR × (sum of covalent radii). */
export const SUGGEST_FACTOR = 1.2;
/** Drag feedback: non-bonded atoms closer than CLASH_FACTOR × (sum of vdW radii) clash. */
export const CLASH_FACTOR = 0.6;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function orderName(order: number): string {
  return order === 2 ? 'double' : order === 3 ? 'triple' : order === 1.5 ? 'aromatic' : 'single';
}

/** "C–O" for two atom ids. */
export function pairLabel(mol: Molecule, a: number, b: number): string {
  return `${atomById(mol, a)?.element ?? '?'}–${atomById(mol, b)?.element ?? '?'}`;
}

/** Bond description used in undo labels and hints: "C–O" or "C–O (double)". */
export function bondDescription(mol: Molecule, a: number, b: number, order: number): string {
  const pair = pairLabel(mol, a, b);
  return order === 1 ? pair : `${pair} (${orderName(order)})`;
}

/** Compact atom label for hints: "C3", "OG1 (SER 42)". */
export function shortAtomLabel(mol: Molecule, id: number): string {
  const topo = getTopology(mol);
  const idx = topo.idToIndex.get(id);
  if (idx === undefined) return `#${id}`;
  const a = mol.atoms[idx];
  const name = a.name || `${a.element}${idx + 1}`;
  return a.resName ? `${name} (${a.resName} ${a.resSeq ?? ''}${a.iCode ?? ''})`.replace(' )', ')') : name;
}

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

/** Charge as a superscript suffix: 0 → '', +1 → '⁺', −2 → '²⁻'. */
export function chargeSuperscript(charge: number): string {
  if (!charge) return '';
  const n = Math.abs(charge);
  const digits = n === 1 ? '' : String(n).split('').map((d) => SUPERSCRIPT_DIGITS[Number(d)]).join('');
  return digits + (charge > 0 ? '⁺' : '⁻');
}

/** Signed charge for labels: +1, −1, 0. */
export function formatCharge(charge: number): string {
  return charge > 0 ? `+${charge}` : charge < 0 ? `−${-charge}` : '0';
}

export function formatMeasurement(kind: MeasureKind, value: number): string {
  if (!Number.isFinite(value)) return '—';
  return kind === 'distance' ? `${value.toFixed(2)} Å` : `${value.toFixed(1)}°`;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export const MEASURE_ATOM_COUNT: Record<MeasureKind, number> = { distance: 2, angle: 3, dihedral: 4 };

const MEASURE_ARTICLE: Record<MeasureKind, string> = { distance: 'a distance', angle: 'an angle', dihedral: 'a dihedral' };

/** "Pick atom 2 of 3 for an angle". */
export function measureHint(kind: MeasureKind, pendingCount: number): string {
  const need = MEASURE_ATOM_COUNT[kind];
  return `Pick atom ${Math.min(pendingCount + 1, need)} of ${need} for ${MEASURE_ARTICLE[kind]}`;
}

/**
 * Next pending-measure state after clicking `atomId`: clicking an atom that is already picked
 * un-picks it (measurements need distinct atoms); otherwise it is appended. `complete` is true
 * when the list reaches the atom count of `kind`.
 */
export function nextPendingMeasure(pending: readonly number[], atomId: number, kind: MeasureKind): { pending: number[]; complete: boolean } {
  if (pending.includes(atomId)) return { pending: pending.filter((id) => id !== atomId), complete: false };
  const next = [...pending, atomId].slice(-MEASURE_ATOM_COUNT[kind]);
  return { pending: next, complete: next.length === MEASURE_ATOM_COUNT[kind] };
}

// ---------------------------------------------------------------------------
// Valence capacity
// ---------------------------------------------------------------------------

export interface Capacity {
  /** Bond-order sum currently used. */
  used: number;
  /** Highest allowed valence (Infinity when the element is not valence-checked, e.g. metals). */
  max: number;
  /** Number of bonds. */
  bondCount: number;
  /** Ids of hydrogens bonded to the atom (single bonds). */
  hydrogens: number[];
}

/** Valence capacity of an atom (from core/chemistry's valence analysis). */
export function capacityOf(mol: Molecule, atomId: number): Capacity {
  const topo = getTopology(mol);
  const idx = topo.idToIndex.get(atomId);
  if (idx === undefined) return { used: 0, max: Infinity, bondCount: 0, hydrogens: [] };
  let sum = 0;
  const hydrogens: number[] = [];
  for (const bi of topo.atomBonds[idx]) {
    const b = mol.bonds[bi];
    sum += b.order;
    const other = b.a === atomId ? b.b : b.a;
    if (b.order === 1 && atomById(mol, other)?.element === 'H') hydrogens.push(other);
  }
  const info = valenceOf(mol, atomId);
  const max = info && info.allowed.length ? Math.max(...info.allowed) : Infinity;
  return { used: info ? info.bondOrderSum : sum, max, bondCount: topo.atomBonds[idx].length, hydrogens };
}

/**
 * Number of single bonds that must be freed so that `delta` more bond order fits.
 * Aromatic sums are rounded the chemically sensible way (a fused aromatic carbon at 4.5 counts as
 * saturated, not as over by ½).
 */
export function roomNeeded(cap: Capacity, delta: number): number {
  if (!Number.isFinite(cap.max)) return 0;
  return Math.max(0, Math.ceil(cap.used + delta - cap.max - 0.5 - 1e-6));
}

/** Highest valence of a neutral element (Infinity if not checked). */
export function maxElementValence(element: string): number {
  const v = getElement(element).valences;
  return v.length ? Math.max(...v) : Infinity;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Explain why an atom cannot take `delta` more bond order: "N already has 3 bonds — can't add another". */
export function valenceReason(mol: Molecule, atomId: number, delta: number): string {
  const atom = atomById(mol, atomId);
  const el = atom ? atom.element + chargeSuperscript(atom.charge ?? 0) : 'This atom';
  const cap = capacityOf(mol, atomId);
  if (!Number.isFinite(cap.max)) return `${el} can't take another bond`;
  const free = Math.max(0, Math.floor(cap.max - cap.used + 0.5 + 1e-6));
  if (free <= 0) {
    return cap.used === cap.bondCount
      ? `${el} already has ${plural(cap.bondCount, 'bond')} — can't add another`
      : `${el} is saturated (valence ${cap.max} used) — can't add another bond`;
  }
  return `${el} has room for only ${plural(free, 'more bond')} — can't add a ${orderName(delta)} bond`;
}

/** Ids from `candidates` sorted by distance to `target` (closest first). */
function closestTo(mol: Molecule, candidates: number[], target: Vec3): number[] {
  const d = (id: number) => {
    const a = atomById(mol, id);
    return a ? distance([a.x, a.y, a.z], target) : Infinity;
  };
  return [...candidates].sort((x, y) => d(x) - d(y));
}

function posOf(mol: Molecule, id: number): Vec3 | null {
  const a = atomById(mol, id);
  return a ? [a.x, a.y, a.z] : null;
}

// ---------------------------------------------------------------------------
// Bonds between existing atoms
// ---------------------------------------------------------------------------

export interface BondCheck {
  ok: boolean;
  reason?: string;
  /** Existing bond between the two atoms (the operation is then an order change). */
  existing?: Bond;
  /** Hydrogens that must be removed first to make room (auto-hydrogen mode only). */
  removeH: number[];
  /** "C–O" / "C–O (double)". */
  label: string;
}

/**
 * Can atoms a and b be bonded with `order` (new bond, or order change of an existing bond)?
 * Uses canAddBond; when that refuses only because of valence and `autoH` is on, the bond is still
 * acceptable if enough hydrogens on the over-filled atom(s) can be removed (closest to the partner first).
 */
export function checkBond(mol: Molecule, a: number, b: number, order: BondOrder, autoH: boolean): BondCheck {
  const label = bondDescription(mol, a, b, order);
  const pa = posOf(mol, a);
  const pb = posOf(mol, b);
  if (!pa || !pb) return { ok: false, reason: 'That atom no longer exists', removeH: [], label };
  if (a === b) return { ok: false, reason: 'Pick a different atom to bond to', removeH: [], label };
  const existing = bondBetween(mol, a, b);
  if (existing && existing.order === order) {
    return { ok: false, reason: `${pairLabel(mol, a, b)} is already a ${orderName(order)} bond`, existing, removeH: [], label };
  }
  const res = canAddBond(mol, a, b, order);
  if (res.ok) return { ok: true, existing, removeH: [], label };
  return extendWithHydrogenRemoval(mol, a, b, order, autoH, existing, res.reason, distance(pa, pb), label);
}

/**
 * Fast analytic variant of checkBond for per-frame drag feedback. Valence and topology come from
 * `valenceMol` (the molecule at drag start: same topology, so its cached valence analysis and
 * topology are reused); `currentDistance` is the a–b distance in the dragged geometry. Mirrors the
 * canAddBond contract (same atom, missing atom, valence, > 4 Å for new bonds). Never builds the
 * topology of the per-frame molecule (that is O(N) and would stall drags on large structures).
 */
export function checkBondFast(valenceMol: Molecule, a: number, b: number, order: BondOrder, autoH: boolean, currentDistance: number): BondCheck {
  const label = bondDescription(valenceMol, a, b, order);
  if (!atomById(valenceMol, a) || !atomById(valenceMol, b)) return { ok: false, reason: 'That atom no longer exists', removeH: [], label };
  if (a === b) return { ok: false, reason: 'Pick a different atom to bond to', removeH: [], label };
  const existing = bondBetween(valenceMol, a, b);
  if (existing && existing.order === order) {
    return { ok: false, reason: `${pairLabel(valenceMol, a, b)} is already a ${orderName(order)} bond`, existing, removeH: [], label };
  }
  return extendWithHydrogenRemoval(valenceMol, a, b, order, autoH, existing, undefined, currentDistance, label, true);
}

function extendWithHydrogenRemoval(
  mol: Molecule,
  a: number,
  b: number,
  order: BondOrder,
  autoH: boolean,
  existing: Bond | undefined,
  chemReason: string | undefined,
  dist: number,
  label: string,
  analytic = false,
): BondCheck {
  if (!existing && dist > MAX_BOND_DISTANCE) {
    return { ok: false, reason: chemReason ?? `Too far apart (${dist.toFixed(1)} Å) to bond`, removeH: [], label };
  }
  const delta = order - (existing?.order ?? 0);
  const removeH: number[] = [];
  let valenceProblem: string | undefined;
  if (delta > 0) {
    for (const [x, partner] of [
      [a, b],
      [b, a],
    ] as const) {
      const cap = capacityOf(mol, x);
      const need = roomNeeded(cap, delta);
      if (need === 0) continue;
      const removable = cap.hydrogens.filter((h) => h !== partner);
      if (!autoH || need > removable.length) {
        valenceProblem ??= valenceReason(mol, x, delta);
        continue;
      }
      removeH.push(...closestTo(mol, removable, posOf(mol, partner)!).slice(0, need));
    }
  }
  if (valenceProblem) return { ok: false, reason: valenceProblem, existing, removeH: [], label };
  // canAddBond refused for a reason we cannot fix by removing hydrogens.
  if (!analytic && removeH.length === 0) return { ok: false, reason: chemReason ?? "These atoms can't be bonded", existing, removeH: [], label };
  return { ok: true, existing, removeH, label };
}

/** Next order when cycling a bond: 1 → 2 → 3 → 1, aromatic → 2 (matches core/edit cycleBondOrder). */
export function nextBondOrder(order: BondOrder): BondOrder {
  return order === 1 ? 2 : order === 2 ? 3 : order === 3 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// New atoms
// ---------------------------------------------------------------------------

export interface AddAtomPlan {
  ok: boolean;
  reason?: string;
  element: string;
  order: BondOrder;
  /** Atom the new atom bonds to (undefined: free atom, e.g. replacing a lone H). */
  anchorId?: number;
  /** Hydrogen that the new atom replaces (Avogadro-style). */
  replaceH?: number;
  /** Additional hydrogens on the anchor removed to make room for a multiple bond. */
  removeH: number[];
  /** Where the new atom goes. */
  position: Vec3;
  /** Undo label, e.g. "Add O" or "Replace H with O". */
  label: string;
}

function elementBondProblem(element: string, order: BondOrder): string | undefined {
  const max = maxElementValence(element);
  if (max === 0) return `${element} doesn't form bonds`;
  if (max < order) return `${element} can't form a ${orderName(order)} bond`;
  return undefined;
}

export interface PlanAddOnAtomOptions {
  autoH: boolean;
  /** Choose which hydrogen to replace among the anchor's hydrogens (default: the first). */
  pickHydrogen?: (hydrogenIds: number[]) => number;
  /** Tie-breaking direction for suggestNewAtomPosition (e.g. towards the pointer). */
  preferDir?: Vec3;
}

/**
 * Plan for clicking atom `atomId` with the add-atom tool:
 * - clicked H (and element ≠ H): replace that H by the new element at the ideal bond length;
 * - clicked saturated heavy atom with hydrogens (and element ≠ H): replace one of its hydrogens
 *   (the one `pickHydrogen` chooses — the controller picks the H nearest to the pointer);
 * - otherwise: a new atom bonded to it at the VSEPR-suggested position (fills an open valence).
 */
export function planAddAtomOnAtom(mol: Molecule, atomId: number, element: string, order: BondOrder, opts: PlanAddOnAtomOptions): AddAtomPlan {
  const atom = atomById(mol, atomId);
  const fail = (reason: string, position: Vec3 = [0, 0, 0]): AddAtomPlan => ({
    ok: false,
    reason,
    element,
    order,
    anchorId: atomId,
    removeH: [],
    position,
    label: `Add ${element}`,
  });
  if (!atom) return fail('That atom no longer exists');
  const pos: Vec3 = [atom.x, atom.y, atom.z];

  if (atom.element === 'H' && element !== 'H') {
    const topo = getTopology(mol);
    const parents = topo.neighbors[topo.idToIndex.get(atomId)!].map((j) => mol.atoms[j].id);
    if (parents.length === 0) {
      // A lone hydrogen simply becomes the new element.
      return { ok: true, element, order, replaceH: atomId, removeH: [], position: pos, label: `Replace H with ${element}` };
    }
    if (parents.length === 1) return planReplaceHydrogen(mol, parents[0], atomId, element, order, opts.autoH, `Replace H with ${element}`);
  }

  // A saturated atom gives up a hydrogen for the new atom; an atom with an open valence uses it.
  const acc = canAcceptBond(mol, atomId, order);
  if (element !== 'H' && !acc.ok) {
    const hs = capacityOf(mol, atomId).hydrogens;
    if (hs.length > 0) {
      const h = opts.pickHydrogen ? opts.pickHydrogen(hs) : hs[0];
      return planReplaceHydrogen(mol, atomId, hs.includes(h) ? h : hs[0], element, order, opts.autoH, `Add ${element}`);
    }
  }

  const position = suggestNewAtomPosition(mol, atomId, element, order, opts.preferDir);
  const elProblem = elementBondProblem(element, order);
  if (elProblem) return fail(elProblem, position);
  if (!acc.ok) return fail(valenceOrReason(mol, atomId, order, acc.reason), position);
  return { ok: true, element, order, anchorId: atomId, removeH: [], position, label: `Add ${element}` };
}

function valenceOrReason(mol: Molecule, atomId: number, delta: number, chemReason?: string): string {
  return Number.isFinite(capacityOf(mol, atomId).max) ? valenceReason(mol, atomId, delta) : chemReason ?? "Can't add a bond here";
}

/** Replace hydrogen `hId` on `parentId` by a new atom of `element` bonded with `order`. */
function planReplaceHydrogen(
  mol: Molecule,
  parentId: number,
  hId: number,
  element: string,
  order: BondOrder,
  autoH: boolean,
  label: string,
): AddAtomPlan {
  const parent = atomById(mol, parentId)!;
  const h = atomById(mol, hId)!;
  const pp: Vec3 = [parent.x, parent.y, parent.z];
  const dir = normalize(sub([h.x, h.y, h.z], pp));
  const position = add(pp, scale(dir, idealBondLength(parent.element, element, order)));
  const base = { element, order, anchorId: parentId, replaceH: hId, position, label };
  const elProblem = elementBondProblem(element, order);
  if (elProblem) return { ...base, ok: false, reason: elProblem, removeH: [] };
  const hBond = bondBetween(mol, parentId, hId);
  const delta = order - (hBond?.order ?? 1);
  if (delta <= 0) return { ...base, ok: true, removeH: [] };
  const acc = canAcceptBond(mol, parentId, delta as BondOrder);
  if (acc.ok) return { ...base, ok: true, removeH: [] };
  if (autoH) {
    const cap = capacityOf(mol, parentId);
    const need = roomNeeded(cap, delta);
    const others = cap.hydrogens.filter((x) => x !== hId);
    if (need > 0 && need <= others.length) return { ...base, ok: true, removeH: closestTo(mol, others, position).slice(0, need) };
  }
  return { ...base, ok: false, reason: valenceOrReason(mol, parentId, delta, acc.reason), removeH: [] };
}

/**
 * Plan for dragging from `anchorId` and releasing on empty space at `target`: a new atom bonded to
 * the anchor in the pointer's direction at the ideal bond length. A saturated anchor makes room by
 * giving up the hydrogen(s) closest to the new position (like replacing an H on click).
 */
export function planAddAtomToward(mol: Molecule, anchorId: number, element: string, order: BondOrder, target: Vec3): AddAtomPlan {
  const anchor = atomById(mol, anchorId);
  const label = `Add ${element}`;
  if (!anchor) return { ok: false, reason: 'That atom no longer exists', element, order, removeH: [], position: target, label };
  const ap: Vec3 = [anchor.x, anchor.y, anchor.z];
  const v = sub(target, ap);
  const dir = length(v) > 0.2 ? normalize(v) : normalize(sub(suggestNewAtomPosition(mol, anchorId, element, order), ap));
  const position = add(ap, scale(dir, idealBondLength(anchor.element, element, order)));
  const base = { element, order, anchorId, position, label };
  const elProblem = elementBondProblem(element, order);
  if (elProblem) return { ...base, ok: false, reason: elProblem, removeH: [] };
  const acc = canAcceptBond(mol, anchorId, order);
  if (acc.ok) return { ...base, ok: true, removeH: [] };
  const cap = capacityOf(mol, anchorId);
  const need = roomNeeded(cap, order);
  if (element !== 'H' && need > 0 && need <= cap.hydrogens.length) {
    return { ...base, ok: true, removeH: closestTo(mol, cap.hydrogens, position).slice(0, need) };
  }
  return { ...base, ok: false, reason: valenceOrReason(mol, anchorId, order, acc.reason), removeH: [] };
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

export interface DeletePlan {
  /** All atom ids that will be removed (requested atoms plus hydrogens on removed heavy atoms). */
  remove: number[];
  /** Remaining heavy atoms that lost a heavy neighbour (their hydrogens get fixed in auto-H mode). */
  fix: number[];
  label: string;
}

export function planDeleteAtoms(mol: Molecule, atomIds: Iterable<number>): DeletePlan {
  const topo = getTopology(mol);
  const remove = new Set<number>();
  for (const id of atomIds) if (topo.idToIndex.has(id)) remove.add(id);
  const requested = [...remove];
  // Hydrogens riding on removed heavy atoms go too (when all their partners are removed).
  for (const id of requested) {
    const idx = topo.idToIndex.get(id)!;
    if (mol.atoms[idx].element === 'H') continue;
    for (const j of topo.neighbors[idx]) {
      const n = mol.atoms[j];
      if (n.element !== 'H' || remove.has(n.id)) continue;
      if (topo.neighbors[j].every((k) => remove.has(mol.atoms[k].id))) remove.add(n.id);
    }
  }
  const fix = new Set<number>();
  for (const id of remove) {
    const idx = topo.idToIndex.get(id)!;
    if (mol.atoms[idx].element === 'H') continue;
    for (const j of topo.neighbors[idx]) {
      const n = mol.atoms[j];
      if (!remove.has(n.id) && n.element !== 'H') fix.add(n.id);
    }
  }
  const heavy = requested.filter((id) => mol.atoms[topo.idToIndex.get(id)!].element !== 'H');
  let label: string;
  if (requested.length === 1) label = `Delete ${mol.atoms[topo.idToIndex.get(requested[0])!].element}`;
  else if (heavy.length === 0) label = `Delete ${remove.size} hydrogens`;
  else label = `Delete ${remove.size} atoms`;
  return { remove: [...remove], fix: [...fix], label };
}

// ---------------------------------------------------------------------------
// Element / charge / fragment
// ---------------------------------------------------------------------------

export interface ElementChangeCheck {
  /** False only when nothing would change. */
  ok: boolean;
  same: boolean;
  /** Set when the result would exceed the new element's valence (the change is still allowed). */
  warning?: string;
  label: string;
}

export function checkElementChange(mol: Molecule, atomId: number, element: string, autoH: boolean): ElementChangeCheck {
  const atom = atomById(mol, atomId);
  if (!atom) return { ok: false, same: false, label: '' };
  const label = `Change ${atom.element} to ${element}`;
  if (atom.element === element) return { ok: false, same: true, label };
  const cap = capacityOf(mol, atomId);
  // With auto hydrogens, surplus H are stripped automatically; only heavy-atom bonds must fit.
  const fixed = autoH ? cap.used - cap.hydrogens.length : cap.used;
  const max = maxElementValence(element);
  if (Number.isFinite(max) && fixed > max + 1e-6 && !atom.charge) {
    const n = Math.round(fixed);
    return { ok: true, same: false, label, warning: `${element} forms at most ${plural(max, 'bond')}, but this atom has ${n}` };
  }
  return { ok: true, same: false, label };
}

export function checkFragmentAnchor(mol: Molecule, atomId: number): { ok: boolean; reason?: string } {
  const atom = atomById(mol, atomId);
  if (!atom) return { ok: false, reason: 'That atom no longer exists' };
  if (atom.element === 'H') return { ok: true };
  if (capacityOf(mol, atomId).hydrogens.length > 0) return { ok: true };
  const acc = canAcceptBond(mol, atomId, 1);
  return acc.ok ? { ok: true } : { ok: false, reason: valenceOrReason(mol, atomId, 1, acc.reason).replace("can't add another", 'nowhere to attach') };
}

// ---------------------------------------------------------------------------
// Drag feedback: bond suggestions and clashes around moved atoms
// ---------------------------------------------------------------------------

/** Fast neighbourhood lookup over the atoms that are NOT being dragged. */
export interface ProximityIndex {
  /** Candidate atom indices (into mol.atoms) within `radius` of p (superset; distance-check them). */
  near(p: Vec3, radius: number): Iterable<number>;
  /** Largest covalent / vdW radius present in the molecule. */
  maxCovalent: number;
  maxVdw: number;
  /** Extra search radius for atoms that may have moved since the index was built (relaxation). */
  margin: number;
}

const BRUTE_FORCE_LIMIT = 600;

/** Build a proximity index over all atoms except `exclude` (atom ids). */
export function createProximityIndex(mol: Molecule, exclude: ReadonlySet<number>, margin = 0): ProximityIndex {
  const indices: number[] = [];
  let maxCovalent = 0;
  let maxVdw = 0;
  const seenEl = new Set<string>();
  for (let i = 0; i < mol.atoms.length; i++) {
    const a = mol.atoms[i];
    if (!seenEl.has(a.element)) {
      seenEl.add(a.element);
      const e = getElement(a.element);
      maxCovalent = Math.max(maxCovalent, e.covalentRadius);
      maxVdw = Math.max(maxVdw, e.vdwRadius);
    }
    if (!exclude.has(a.id)) indices.push(i);
  }
  if (indices.length <= BRUTE_FORCE_LIMIT) return { near: () => indices, maxCovalent, maxVdw, margin };
  const grid = new SpatialGrid(mol, indices, 2.5);
  return { near: (p, r) => grid.query(p, r + margin), maxCovalent, maxVdw, margin };
}

export interface BondSuggestion {
  /** Moved atom id. */
  a: number;
  /** Stationary atom id. */
  b: number;
  from: Vec3;
  to: Vec3;
  valid: boolean;
  reason?: string;
  /** Distance / ideal single-bond length (lower = better fit). */
  ratio: number;
}

export interface DragFeedback {
  /** Sorted by ratio; for the grabbed atom all candidates, for other moved atoms only valid ones. */
  suggestions: BondSuggestion[];
  /** Non-bonded pairs that are too close (moved atom id, other atom id). */
  clashes: { a: number; b: number }[];
}

export interface DragFeedbackOptions {
  moved: ReadonlySet<number>;
  /** The atom under the pointer (primary feedback target). */
  grabbed: number;
  autoH: boolean;
  /** Molecule with the same topology and atom order as `mol` (its valence analysis is cached). Default: mol. */
  topologyMol?: Molecule;
  index?: ProximityIndex;
  /** Only the grabbed atom is checked when more atoms than this are moved. */
  maxCheckedAtoms?: number;
}

export function computeDragFeedback(mol: Molecule, opts: DragFeedbackOptions): DragFeedback {
  const topoMol = opts.topologyMol ?? mol;
  const topo = getTopology(topoMol);
  const index = opts.index ?? createProximityIndex(topoMol, opts.moved);
  const maxChecked = opts.maxCheckedAtoms ?? 1500;
  const checked = opts.moved.size > maxChecked ? [opts.grabbed] : [...opts.moved];
  const suggestions: BondSuggestion[] = [];
  const clashes: { a: number; b: number }[] = [];
  const posAt = (i: number): Vec3 => {
    const a = mol.atoms[i];
    return [a.x, a.y, a.z];
  };

  for (const id of checked) {
    const i = topo.idToIndex.get(id);
    if (i === undefined) continue;
    const ea = getElement(topoMol.atoms[i].element);
    const pa = posAt(i);
    const radius = Math.max(SUGGEST_FACTOR * (ea.covalentRadius + index.maxCovalent), CLASH_FACTOR * (ea.vdwRadius + index.maxVdw));
    const bonded = topo.neighbors[i];
    const mine: BondSuggestion[] = [];
    for (const j of index.near(pa, radius)) {
      const other = topoMol.atoms[j];
      if (opts.moved.has(other.id) || j === i || bonded.includes(j)) continue;
      const pb = posAt(j);
      const d = distance(pa, pb);
      const eb = getElement(other.element);
      const covSum = ea.covalentRadius + eb.covalentRadius;
      const clashCut = CLASH_FACTOR * (ea.vdwRadius + eb.vdwRadius);
      if (d <= SUGGEST_FACTOR * covSum) {
        const chk = checkBondFast(topoMol, id, other.id, 1, opts.autoH, d);
        mine.push({ a: id, b: other.id, from: pa, to: pb, valid: chk.ok, reason: chk.reason, ratio: d / covSum });
        if (!chk.ok && d < clashCut) clashes.push({ a: id, b: other.id });
      } else if (d < clashCut) {
        clashes.push({ a: id, b: other.id });
      }
    }
    mine.sort((x, y) => x.ratio - y.ratio);
    if (id === opts.grabbed) suggestions.push(...mine.slice(0, 6));
    else {
      const best = mine.find((s) => s.valid);
      if (best) suggestions.push(best);
    }
  }
  suggestions.sort((x, y) => x.ratio - y.ratio);
  return { suggestions, clashes };
}

/** Atom ids within `depth` bonds of `seeds` (excluding the seeds themselves). */
export function atomsWithinBonds(mol: Molecule, seeds: ReadonlySet<number>, depth: number): Set<number> {
  const topo = getTopology(mol);
  const seen = new Set<number>();
  let frontier: number[] = [];
  for (const id of seeds) {
    const i = topo.idToIndex.get(id);
    if (i !== undefined) {
      seen.add(i);
      frontier.push(i);
    }
  }
  const out = new Set<number>();
  for (let level = 0; level < depth && frontier.length; level++) {
    const next: number[] = [];
    for (const i of frontier) {
      for (const j of topo.neighbors[i]) {
        if (seen.has(j)) continue;
        seen.add(j);
        next.push(j);
        out.add(mol.atoms[j].id);
      }
    }
    frontier = next;
  }
  return out;
}
