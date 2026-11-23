/**
 * Shift-drag rectangle: select (replace / add / remove) or delete the atoms inside.
 */
import { rectFromPoints } from '../gesture';
import { planDeleteAtoms } from '../feedback';
import { applyDelete } from '../ops';
import { autoHydrogens, commitResult } from './common';
import type { DragSession, PointerState, ToolEnv } from './types';
import type { HighlightColor } from '../../core/types';

export type BoxOp = 'select' | 'add' | 'remove' | 'delete';

/** Live highlighting of the atoms inside the box is skipped above this size (pickRect each frame). */
const LIVE_PREVIEW_MAX_ATOMS = 30000;
const MAX_HIGHLIGHTS = 5000;

/** Box operation implied by the modifiers held at press time (shift is the box trigger itself). */
export function boxOpFromModifiers(p: PointerState): BoxOp {
  if (p.ctrl || p.meta) return 'add';
  if (p.alt) return 'remove';
  return 'select';
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

export function createBoxDrag(env: ToolEnv, start: PointerState, op: BoxOp): DragSession {
  const pick = (p: PointerState) => {
    const r = rectFromPoints(start, p);
    return { rect: r, ids: env.viewer.pickRect(r.x0, r.y0, r.x1, r.y1) };
  };

  return {
    update(env, p) {
      const mol = env.state().molecule;
      const rect = rectFromPoints(start, p);
      if (!mol || mol.atoms.length > LIVE_PREVIEW_MAX_ATOMS) {
        env.show({ overlay: { selectionRect: rect }, hint: op === 'delete' ? 'Release to delete the atoms in the box' : 'Release to select the atoms in the box' });
        return;
      }
      const { ids } = pick(p);
      let shown = ids;
      let color: HighlightColor = 'hover';
      let hint: string;
      if (op === 'delete') {
        const plan = planDeleteAtoms(mol, ids);
        shown = plan.remove;
        color = 'delete';
        hint = ids.length ? `Release to delete ${plural(plan.remove.length, 'atom')} · Esc to cancel` : 'Drag over atoms to delete them';
      } else {
        const verb = op === 'add' ? 'add' : op === 'remove' ? 'deselect' : 'select';
        hint = ids.length ? `Release to ${verb} ${plural(ids.length, 'atom')}${op === 'add' ? ' to the selection' : ''}` : `Drag over atoms to ${verb} them`;
      }
      env.show({
        overlay: { selectionRect: rect, highlightAtoms: shown.slice(0, MAX_HIGHLIGHTS).map((atomId) => ({ atomId, color })) },
        hint,
      });
    },

    finish(env, p) {
      const s = env.state();
      const mol = s.molecule;
      if (!mol) return;
      const { ids } = pick(p);
      switch (op) {
        case 'select':
          s.setSelection(ids);
          break;
        case 'add':
          s.addToSelection(ids);
          break;
        case 'remove':
          s.removeFromSelection(ids);
          break;
        case 'delete':
          if (ids.length) commitResult(env, applyDelete(mol, planDeleteAtoms(mol, ids), autoHydrogens(s, mol)));
          break;
      }
    },

    cancel() {},
  };
}
