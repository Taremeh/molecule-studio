/**
 * Add-bond tool (order = store.editBondOrder):
 * - drag atom A → atom B: bond (or change the existing bond's order); preview + green/red target;
 * - click A, then click B: the same (A is highlighted as 'target' in between; Esc / empty click cancels);
 * - click a bond: cycle its order 1 → 2 → 3 → 1 (validated).
 * Invalid operations toast the reason and change nothing.
 */
import type { EditOverlay } from '../../core/types';
import { atomById, bondById } from '../../core/molecule';
import { checkBond, nextBondOrder, orderName, pairLabel, shortAtomLabel } from '../feedback';
import { applyBond, applyCycleBond } from '../ops';
import { createBondDrag } from './bondDrag';
import { atomPos, autoHydrogens, commitResult, hitKey, warn } from './common';
import type { Feedback, Tool, ToolEnv } from './types';

function validStart(env: ToolEnv): number | null {
  const start = env.session.bondStart;
  const mol = env.state().molecule;
  if (start === null || !mol || !atomById(mol, start)) return null;
  return start;
}

function startOverlay(start: number | null): Partial<EditOverlay> | undefined {
  return start === null ? undefined : { highlightAtoms: [{ atomId: start, color: 'target' }] };
}

export const addBondTool: Tool = {
  hoverKey(env, hit, p) {
    const start = validStart(env);
    // While a click–click bond is pending, the rubber band follows the pointer over empty space.
    if (start !== null && hit?.kind !== 'atom') return `${hitKey(hit)}|${p.x},${p.y}`;
    return hitKey(hit);
  },

  preview(env, hit, p): Feedback {
    const s = env.state();
    const mol = s.molecule;
    if (!mol) return { hint: null };
    const order = s.editBondOrder;
    const autoH = autoHydrogens(s, mol);
    const start = validStart(env);

    if (start !== null) {
      const from = atomPos(mol, start)!;
      if (hit?.kind === 'atom' && hit.atomId !== undefined && hit.atomId !== start && atomById(mol, hit.atomId)) {
        const chk = checkBond(mol, start, hit.atomId, order, autoH);
        return {
          overlay: {
            ghostBonds: [{ from, to: atomPos(mol, hit.atomId)!, valid: chk.ok, order, style: 'preview' }],
            highlightAtoms: [
              { atomId: start, color: 'target' },
              { atomId: hit.atomId, color: chk.ok ? 'valid' : 'invalid' },
              ...chk.removeH.map((atomId) => ({ atomId, color: 'delete' as const })),
            ],
          },
          hint: chk.ok
            ? chk.existing
              ? `Click to make ${pairLabel(mol, start, hit.atomId)} ${orderName(order)}`
              : `Click to bond ${chk.label}`
            : chk.reason ?? "Can't bond these atoms",
        };
      }
      if (hit?.kind === 'atom' && hit.atomId === start) {
        return { overlay: startOverlay(start), hint: 'Click again to cancel · or click another atom to bond' };
      }
      const to = env.viewer.screenToWorldOnPlane(p.x, p.y, from);
      return {
        overlay: { ...startOverlay(start), ghostBonds: [{ from, to, valid: true, order, style: 'preview' }] },
        hint: `Click another atom to bond it to ${shortAtomLabel(mol, start)} · Esc to cancel`,
      };
    }

    if (hit?.kind === 'atom') return { hint: 'Drag to another atom to bond · or click two atoms' };
    if (hit?.kind === 'bond' && hit.bondId !== undefined) {
      const bond = bondById(mol, hit.bondId);
      if (!bond) return { hint: null };
      const next = nextBondOrder(bond.order);
      const chk = next > bond.order ? checkBond(mol, bond.a, bond.b, next, autoH) : { ok: true, reason: undefined };
      return {
        overlay: { highlightBonds: [{ bondId: bond.id, color: chk.ok ? 'target' : 'invalid' }] },
        hint: chk.ok
          ? `Click to make ${pairLabel(mol, bond.a, bond.b)} ${orderName(next)} (now ${orderName(bond.order)})`
          : chk.reason ?? `Can't make this bond ${orderName(next)}`,
      };
    }
    return { hint: 'Drag between two atoms to bond them · click a bond to change its order' };
  },

  restingOverlay(env) {
    return startOverlay(validStart(env));
  },

  press(_env, hit) {
    if (hit?.kind === 'atom' && hit.atomId !== undefined) {
      const atomId = hit.atomId;
      return {
        consume: true,
        click(env) {
          const s = env.state();
          const mol = s.molecule;
          if (!mol || !atomById(mol, atomId)) return;
          const start = validStart(env);
          if (start === null) {
            env.session.bondStart = atomId;
            return;
          }
          env.session.bondStart = null;
          if (start === atomId) return;
          const order = s.editBondOrder;
          const autoH = autoHydrogens(s, mol);
          const chk = checkBond(mol, start, atomId, order, autoH);
          if (!chk.ok) return warn(env, chk.reason ?? "Can't bond these atoms");
          commitResult(env, applyBond(mol, start, atomId, order, chk, autoH));
        },
        startDrag(env) {
          env.session.bondStart = null;
          return createBondDrag(env, atomId, 'add-bond');
        },
      };
    }
    if (hit?.kind === 'bond' && hit.bondId !== undefined) {
      const bondId = hit.bondId;
      return {
        consume: true,
        click(env) {
          const s = env.state();
          const mol = s.molecule;
          if (!mol) return;
          env.session.bondStart = null;
          commitResult(env, applyCycleBond(mol, bondId, autoHydrogens(s, mol)));
        },
      };
    }
    return {
      consume: false,
      click(env) {
        env.session.bondStart = null;
      },
    };
  },
};
