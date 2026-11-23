/**
 * Editor operations: turn a validated plan (see feedback.ts) into a new Molecule using the pure
 * edit functions of core/edit. Each function returns the new molecule (or an error) plus the undo
 * label; committing to the store is left to the caller.
 *
 * Auto-hydrogen policy (only when `autoH` is true, and only on the heavy atoms an edit touched):
 * - atoms whose bond orders changed are *re-hydrogenated* (all their H removed, then refilled by
 *   adjustHydrogens) so the remaining hydrogens get the geometry of the new hybridisation;
 * - otherwise adjustHydrogens just adds/removes the missing/excess hydrogens.
 */
import type { BondOrder, Molecule, Vec3 } from '../core/types';
import { atomById, bondBetween, bondById, neighborIds } from '../core/molecule';
import {
  addAtom,
  addBond,
  adjustHydrogens,
  attachFragment,
  removeAtoms,
  removeBonds,
  removeHydrogens,
  setBondOrder,
  setCharge,
  setDistance,
  setElement,
} from '../core/edit';
import { canAddBond, isBondInRing, valenceOf } from '../core/chemistry';
import { distance, fragmentSide, idealBondLengthInMolecule } from '../core/geometry';
import { getFragment } from '../core/templates';
import {
  type AddAtomPlan,
  type BondCheck,
  type BondSuggestion,
  type DeletePlan,
  bondDescription,
  chargeSuperscript,
  checkBond,
  formatCharge,
  nextBondOrder,
  orderName,
  pairLabel,
} from './feedback';

export type OpResult = { ok: true; mol: Molecule; label: string; warning?: string } | { ok: false; reason: string };

function heavyOnly(mol: Molecule, ids: Iterable<number>): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const a = atomById(mol, id);
    if (a && a.element !== 'H' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Fill / trim hydrogens on the given heavy atoms. */
export function fixHydrogens(mol: Molecule, ids: Iterable<number>): Molecule {
  const heavy = heavyOnly(mol, ids);
  return heavy.length ? adjustHydrogens(mol, heavy) : mol;
}

/** Remove all hydrogens of the given heavy atoms, then refill them with ideal geometry. */
export function rehydrogenate(mol: Molecule, ids: Iterable<number>): Molecule {
  const heavy = heavyOnly(mol, ids);
  if (!heavy.length) return mol;
  return adjustHydrogens(removeHydrogens(mol, heavy), heavy);
}

/** Over-valence warning for an atom of the edited molecule, if any. */
function overValenceWarning(mol: Molecule, id: number): string | undefined {
  const info = valenceOf(mol, id);
  if (info?.status !== 'over') return undefined;
  return info.message ?? `${info.element} exceeds its valence`;
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/** Add a free atom (no bonds) at `position`. */
export function applyAddFreeAtom(mol: Molecule, element: string, position: Vec3, autoH: boolean): OpResult & { atomId?: number } {
  const r = addAtom(mol, element, position);
  if (r.atomId < 0) return { ok: false, reason: `Couldn't add ${element}` };
  const m = autoH ? fixHydrogens(r.mol, [r.atomId]) : r.mol;
  return { ok: true, mol: m, label: `Add ${element}`, atomId: r.atomId };
}

/** Execute an add-atom plan from planAddAtomOnAtom / planAddAtomToward. */
export function applyAddAtom(mol: Molecule, plan: AddAtomPlan, autoH: boolean): OpResult & { atomId?: number } {
  if (!plan.ok) return { ok: false, reason: plan.reason ?? "Can't add an atom here" };
  let m = mol;
  const remove = [...plan.removeH];
  if (plan.replaceH !== undefined) remove.push(plan.replaceH);
  if (remove.length) m = removeAtoms(m, remove);
  const anchor = plan.anchorId !== undefined && atomById(m, plan.anchorId) ? plan.anchorId : undefined;
  const r = addAtom(m, plan.element, plan.position, anchor !== undefined ? { bondTo: anchor, order: plan.order } : {});
  if (r.atomId < 0) return { ok: false, reason: `Couldn't add ${plan.element}` };
  m = r.mol;
  if (autoH) {
    // A multiple bond changes the anchor's hybridisation: re-place its hydrogens.
    if (anchor !== undefined && plan.order !== 1) m = rehydrogenate(m, [anchor]);
    m = fixHydrogens(m, anchor !== undefined ? [r.atomId, anchor] : [r.atomId]);
  }
  return { ok: true, mol: m, label: plan.label, atomId: r.atomId };
}

/** Delete atoms per a DeletePlan; in auto-H mode, former heavy neighbours get their hydrogens back. */
export function applyDelete(mol: Molecule, plan: DeletePlan, autoH: boolean): OpResult {
  if (!plan.remove.length) return { ok: false, reason: 'Nothing to delete' };
  let m = removeAtoms(mol, plan.remove);
  if (autoH && plan.fix.length) m = fixHydrogens(m, plan.fix);
  return { ok: true, mol: m, label: plan.label };
}

// ---------------------------------------------------------------------------
// Bonds
// ---------------------------------------------------------------------------

/**
 * Create bond a–b (or change its order) after checkBond said ok. Re-verifies with canAddBond on
 * the molecule after the planned hydrogen removal, so the commit never violates the chemistry rules.
 */
export function applyBond(mol: Molecule, a: number, b: number, order: BondOrder, check: BondCheck, autoH: boolean): OpResult {
  if (!check.ok) return { ok: false, reason: check.reason ?? "Can't bond these atoms" };
  const orderChange = !!check.existing || order !== 1;
  let m = mol;
  if (autoH && orderChange) m = removeHydrogens(m, heavyOnly(m, [a, b]));
  else if (check.removeH.length) m = removeAtoms(m, check.removeH);
  if (m !== mol) {
    const verify = canAddBond(m, a, b, order);
    if (!verify.ok) return { ok: false, reason: verify.reason ?? "Can't bond these atoms" };
  }
  m = addBond(m, a, b, order).mol;
  // An order change of an existing bond also changes its ideal length (C–C 1.52 → C=C 1.32 Å).
  if (check.existing) m = fixBondLength(m, a, b);
  if (autoH) m = fixHydrogens(m, [a, b]);
  const label = check.existing ? `Bond ${pairLabel(mol, a, b)} (${orderName(order)})` : `Bond ${bondDescription(mol, a, b, order)}`;
  return { ok: true, mol: m, label };
}

/** Cycle a bond's order 1 → 2 → 3 → 1 (validated; in auto-H mode hydrogens make room / refill). */
export function applyCycleBond(mol: Molecule, bondId: number, autoH: boolean): OpResult {
  const bond = bondById(mol, bondId);
  if (!bond) return { ok: false, reason: 'That bond no longer exists' };
  const next = nextBondOrder(bond.order);
  if (next > bond.order) {
    const chk = checkBond(mol, bond.a, bond.b, next, autoH);
    if (!chk.ok) return { ok: false, reason: chk.reason ?? "Can't raise the bond order" };
    return applyBond(mol, bond.a, bond.b, next, chk, autoH);
  }
  let m = fixBondLength(setBondOrder(mol, bondId, next), bond.a, bond.b);
  if (autoH) m = rehydrogenate(m, [bond.a, bond.b]);
  return { ok: true, mol: m, label: `Bond ${pairLabel(mol, bond.a, bond.b)} (${orderName(next)})` };
}

/** Delete a bond; in auto-H mode the two (heavy) atoms get hydrogens for the freed valence. */
export function applyDeleteBond(mol: Molecule, bondId: number, autoH: boolean): OpResult {
  const bond = bondById(mol, bondId);
  if (!bond) return { ok: false, reason: 'That bond no longer exists' };
  let m = removeBonds(mol, [bondId]);
  const ea = atomById(mol, bond.a)?.element;
  const eb = atomById(mol, bond.b)?.element;
  // Deleting a bond to an H is an explicit request to drop that H — don't immediately re-add one.
  if (autoH && ea !== 'H' && eb !== 'H') m = fixHydrogens(m, [bond.a, bond.b]);
  return { ok: true, mol: m, label: `Delete ${pairLabel(mol, bond.a, bond.b)} bond` };
}

/**
 * Form the valid suggested bonds of a drag (closest first, at most one new bond per atom),
 * each re-validated on the molecule as it evolves.
 */
export function applySnapBonds(mol: Molecule, suggestions: BondSuggestion[], autoH: boolean): { mol: Molecule; formed: string[] } {
  let m = mol;
  const formed: string[] = [];
  const used = new Set<number>();
  for (const s of [...suggestions].sort((x, y) => x.ratio - y.ratio)) {
    if (!s.valid || used.has(s.a) || used.has(s.b)) continue;
    const chk = checkBond(m, s.a, s.b, 1, autoH);
    if (!chk.ok) continue;
    const r = applyBond(m, s.a, s.b, 1, chk, autoH);
    if (!r.ok) continue;
    m = r.mol;
    formed.push(pairLabel(mol, s.a, s.b));
    used.add(s.a);
    used.add(s.b);
  }
  return { mol: m, formed };
}

// ---------------------------------------------------------------------------
// Element & charge
// ---------------------------------------------------------------------------

/**
 * Set bond a–b to the ideal length for its order by moving the smaller side of the bond along the
 * bond axis. Ring bonds are left alone (moving one side would distort the ring).
 */
export function fixBondLength(mol: Molecule, a: number, b: number): Molecule {
  const A = atomById(mol, a);
  const B = atomById(mol, b);
  const bond = A && B ? bondBetween(mol, a, b) : undefined;
  if (!A || !B || !bond) return mol;
  const ideal = idealBondLengthInMolecule(mol, a, b, bond.order);
  if (Math.abs(distance([A.x, A.y, A.z], [B.x, B.y, B.z]) - ideal) < 0.01) return mol;
  if (isBondInRing(mol, a, b)) return mol;
  const sideB = fragmentSide(mol, a, b);
  const sideA = fragmentSide(mol, b, a);
  return sideB.size <= sideA.size ? setDistance(mol, a, b, ideal) : setDistance(mol, b, a, ideal);
}

/** Restore ideal lengths of the (non-ring) bonds of `atomId`, e.g. after its element changed. */
export function fixBondLengths(mol: Molecule, atomId: number): Molecule {
  let m = mol;
  for (const other of neighborIds(mol, atomId)) m = fixBondLength(m, atomId, other);
  return m;
}

export function applyElementChange(mol: Molecule, atomId: number, element: string, autoH: boolean): OpResult {
  const atom = atomById(mol, atomId);
  if (!atom) return { ok: false, reason: 'That atom no longer exists' };
  if (atom.element === element) return { ok: false, reason: `Already ${element}` };
  let m = setElement(mol, [atomId], element);
  if (autoH) m = fixHydrogens(m, [atomId]);
  m = fixBondLengths(m, atomId);
  return { ok: true, mol: m, label: `Change ${atom.element} to ${element}`, warning: overValenceWarning(m, atomId) };
}

export const MAX_ABS_CHARGE = 4;

export function applyChargeChange(mol: Molecule, atomId: number, delta: number, autoH: boolean): OpResult & { charge?: number } {
  const atom = atomById(mol, atomId);
  if (!atom) return { ok: false, reason: 'That atom no longer exists' };
  const current = atom.charge ?? 0;
  const charge = Math.max(-MAX_ABS_CHARGE, Math.min(MAX_ABS_CHARGE, current + delta));
  if (charge === current) return { ok: false, reason: `Charge is limited to ±${MAX_ABS_CHARGE}` };
  let m = setCharge(mol, atomId, charge);
  if (autoH) m = fixHydrogens(m, [atomId]);
  return {
    ok: true,
    mol: m,
    charge,
    label: `Charge ${atom.element}${chargeSuperscript(charge)} (${formatCharge(charge)})`,
    warning: overValenceWarning(m, atomId),
  };
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

export function applyFragment(
  mol: Molecule,
  fragmentId: string,
  opts: { anchorAtomId?: number; position?: Vec3 },
): OpResult & { atomIds?: number[] } {
  const frag = getFragment(fragmentId);
  if (!frag) return { ok: false, reason: 'Pick a fragment in the toolbar first' };
  const r = attachFragment(mol, fragmentId, opts);
  if (!r.atomIds.length || r.mol === mol) return { ok: false, reason: `Couldn't attach ${frag.name}` };
  const label = opts.anchorAtomId !== undefined ? `Attach ${frag.name}` : `Add ${frag.name}`;
  return { ok: true, mol: r.mol, label, atomIds: r.atomIds };
}
