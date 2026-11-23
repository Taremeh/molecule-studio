/**
 * Select tool (view and edit mode): click to select, Shift/Ctrl/⌘-click to toggle, click a bond for
 * both atoms, click empty space to clear, double-click for the residue/fragment, Shift-drag on
 * empty space to box-select. Never consumes presses on atoms, so the camera always rotates.
 */
import { atomById, bondById } from '../../core/molecule';
import { pairLabel, shortAtomLabel } from '../feedback';
import { boxOpFromModifiers, createBoxDrag } from './boxDrag';
import { groupName, hitKey, selectByClick, selectGroupAndFocus } from './common';
import type { Tool } from './types';

export const selectTool: Tool = {
  hoverKey: (_env, hit) => hitKey(hit),

  preview(env, hit) {
    const s = env.state();
    const mol = s.molecule;
    if (!mol || !hit) {
      return { hint: s.mode === 'view' ? 'Drag to rotate · scroll to zoom · Shift-drag to box-select' : 'Click an atom to select it · Shift-drag to box-select' };
    }
    if (hit.kind === 'atom' && hit.atomId !== undefined && atomById(mol, hit.atomId)) {
      const sel = s.selection.has(hit.atomId);
      return {
        hint: `${shortAtomLabel(mol, hit.atomId)} — ${sel ? 'Shift-click to deselect' : 'click to select · Shift-click to add'} · double-click for the ${groupName(mol, hit.atomId)}`,
      };
    }
    const bond = hit.bondId !== undefined ? bondById(mol, hit.bondId) : undefined;
    return { hint: bond ? `Click to select the ${pairLabel(mol, bond.a, bond.b)} bond's atoms` : null };
  },

  press(_env, hit, p) {
    if (!hit && p.shift) {
      return { consume: true, startDrag: (env, start) => createBoxDrag(env, start, boxOpFromModifiers(start)) };
    }
    return { consume: false, click: (env, at) => selectByClick(env, hit, at) };
  },

  doubleClick(env, hit, p) {
    selectGroupAndFocus(env, hit, p, true);
  },
};
