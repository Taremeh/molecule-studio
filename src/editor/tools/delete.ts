/**
 * Delete tool: hover highlights what would go (an atom with its hydrogens, or a bond) in the
 * 'delete' color; click removes it; Shift-drag on empty space deletes everything in the box.
 * In auto-hydrogen mode the former neighbours get hydrogens for their freed valence.
 */
import { atomById, bondById } from '../../core/molecule';
import { pairLabel, planDeleteAtoms, shortAtomLabel } from '../feedback';
import { applyDelete, applyDeleteBond } from '../ops';
import { createBoxDrag } from './boxDrag';
import { autoHydrogens, commitResult, hitKey } from './common';
import type { Tool } from './types';

export const deleteTool: Tool = {
  hoverKey: (_env, hit) => hitKey(hit),

  preview(env, hit) {
    const mol = env.state().molecule;
    if (!mol) return { hint: null };
    if (hit?.kind === 'atom' && hit.atomId !== undefined && atomById(mol, hit.atomId)) {
      const plan = planDeleteAtoms(mol, [hit.atomId]);
      const extraH = plan.remove.length - 1;
      return {
        overlay: { highlightAtoms: plan.remove.map((atomId) => ({ atomId, color: 'delete' as const })) },
        hint: `Click to delete ${shortAtomLabel(mol, hit.atomId)}${extraH > 0 ? ` and its ${extraH} H` : ''}`,
      };
    }
    if (hit?.kind === 'bond' && hit.bondId !== undefined) {
      const bond = bondById(mol, hit.bondId);
      if (bond) {
        return {
          overlay: { highlightBonds: [{ bondId: bond.id, color: 'delete' }] },
          hint: `Click to delete the ${pairLabel(mol, bond.a, bond.b)} bond`,
        };
      }
    }
    return { hint: 'Click an atom or bond to delete it · Shift-drag to delete a region' };
  },

  press(_env, hit, p) {
    if (hit?.kind === 'atom' && hit.atomId !== undefined) {
      const atomId = hit.atomId;
      return {
        consume: true,
        click(env) {
          const s = env.state();
          const mol = s.molecule;
          if (!mol || !atomById(mol, atomId)) return;
          commitResult(env, applyDelete(mol, planDeleteAtoms(mol, [atomId]), autoHydrogens(s, mol)));
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
          commitResult(env, applyDeleteBond(mol, bondId, autoHydrogens(s, mol)));
        },
      };
    }
    if (p.shift) return { consume: true, startDrag: (env, start) => createBoxDrag(env, start, 'delete') };
    return { consume: false };
  },
};
