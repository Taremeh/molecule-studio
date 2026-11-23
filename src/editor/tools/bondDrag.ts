/**
 * Drag from an atom to draw a bond (add-bond tool) or a new bonded atom (add-atom tool).
 * The preview bond follows the pointer on the camera plane through the anchor atom; over another
 * atom it snaps to it and shows whether that bond is valid. Release applies the result.
 */
import type { EditOverlay, Vec3 } from '../../core/types';
import { atomById } from '../../core/molecule';
import { canAcceptBond } from '../../core/chemistry';
import { type AddAtomPlan, type BondCheck, capacityOf, checkBond, orderName, pairLabel, planAddAtomToward, roomNeeded, shortAtomLabel, valenceReason } from '../feedback';
import { applyAddAtom, applyBond } from '../ops';
import { atomPos, autoHydrogens, commitResult, warn } from './common';
import type { DragSession, Feedback, PointerState, ToolEnv } from './types';

export type BondDragKind = 'add-atom' | 'add-bond';

type Outcome =
  | { kind: 'bond'; target: number; check: BondCheck }
  | { kind: 'atom'; plan: AddAtomPlan }
  | { kind: 'none'; reason?: string };

export function createBondDrag(env: ToolEnv, anchorId: number, kind: BondDragKind): DragSession | null {
  const mol0 = env.state().molecule;
  if (!mol0 || !atomById(mol0, anchorId)) return null;
  const anchorPos: Vec3 = atomPos(mol0, anchorId)!;
  let outcome: Outcome = { kind: 'none' };

  const evaluate = (p: PointerState): Outcome => {
    const s = env.state();
    const mol = s.molecule;
    if (!mol || !atomById(mol, anchorId)) return { kind: 'none', reason: 'The start atom no longer exists' };
    const order = s.editBondOrder;
    const autoH = autoHydrogens(s, mol);
    const hit = env.viewer.pick(p.x, p.y);
    const anchorHighlight = { atomId: anchorId, color: 'target' as const };

    if (hit?.kind === 'atom' && hit.atomId !== undefined && hit.atomId !== anchorId && atomById(mol, hit.atomId)) {
      const target = hit.atomId;
      const check = checkBond(mol, anchorId, target, order, autoH);
      const overlay: Partial<EditOverlay> = {
        ghostBonds: [{ from: anchorPos, to: atomPos(mol, target)!, valid: check.ok, order, style: 'preview' }],
        highlightAtoms: [anchorHighlight, { atomId: target, color: check.ok ? 'valid' : 'invalid' }, ...check.removeH.map((atomId) => ({ atomId, color: 'delete' as const }))],
      };
      const verb = check.existing ? `make ${pairLabel(mol, anchorId, target)} ${orderName(order)}` : `bond ${check.label}`;
      env.show({ overlay, hint: check.ok ? `Release to ${verb}` : check.reason ?? "Can't bond these atoms" });
      return { kind: 'bond', target, check };
    }

    const world = env.viewer.screenToWorldOnPlane(p.x, p.y, anchorPos);
    if (kind === 'add-atom') {
      const plan = planAddAtomToward(mol, anchorId, s.editElement, order, world);
      const feedback: Feedback = {
        overlay: {
          ghostAtoms: [{ position: plan.position, element: plan.element, valid: plan.ok }],
          ghostBonds: [{ from: anchorPos, to: plan.position, valid: plan.ok, order, style: 'preview' }],
          highlightAtoms: [anchorHighlight, ...plan.removeH.map((atomId) => ({ atomId, color: 'delete' as const }))],
        },
        hint: plan.ok ? `Release to add ${plan.element} · or release over an atom to bond to it` : plan.reason ?? "Can't add an atom here",
      };
      env.show(feedback);
      return { kind: 'atom', plan };
    }

    // add-bond over empty space: show the rubber band; red if the anchor itself has no room.
    const cap = capacityOf(mol, anchorId);
    const ok = canAcceptBond(mol, anchorId, order).ok || (autoH && roomNeeded(cap, order) <= cap.hydrogens.length);
    env.show({
      overlay: { ghostBonds: [{ from: anchorPos, to: world, valid: ok, order, style: 'preview' }], highlightAtoms: [anchorHighlight] },
      hint: ok ? `Release over another atom to bond it to ${shortAtomLabel(mol, anchorId)}` : valenceReason(mol, anchorId, order),
    });
    return { kind: 'none' };
  };

  return {
    update(_env, p) {
      outcome = evaluate(p);
    },
    finish(env, p) {
      outcome = evaluate(p);
      const s = env.state();
      const mol = s.molecule;
      if (!mol) return;
      const autoH = autoHydrogens(s, mol);
      if (outcome.kind === 'bond') {
        if (!outcome.check.ok) return warn(env, outcome.check.reason ?? "Can't bond these atoms");
        commitResult(env, applyBond(mol, anchorId, outcome.target, s.editBondOrder, outcome.check, autoH));
      } else if (outcome.kind === 'atom') {
        if (!outcome.plan.ok) return warn(env, outcome.plan.reason ?? "Can't add an atom here");
        commitResult(env, applyAddAtom(mol, outcome.plan, autoH));
      } else if (outcome.reason) warn(env, outcome.reason);
    },
    cancel() {},
  };
}
