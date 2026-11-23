/**
 * Element tool: click an atom to change it to store.editElement. Hover shows a ghost of the new
 * element on the atom (red with a warning if it would exceed the new element's valence; the change
 * is still allowed so that e.g. a charge can be added next). Auto hydrogens and bond-length
 * correction follow the change.
 */
import { atomById } from '../../core/molecule';
import { checkElementChange, shortAtomLabel } from '../feedback';
import { applyElementChange } from '../ops';
import { atomPos, autoHydrogens, commitResult, hitKey } from './common';
import type { Tool } from './types';

export const elementTool: Tool = {
  hoverKey: (_env, hit) => hitKey(hit),

  preview(env, hit) {
    const s = env.state();
    const mol = s.molecule;
    const el = s.editElement;
    if (!mol) return { hint: null };
    if (hit?.kind === 'atom' && hit.atomId !== undefined && atomById(mol, hit.atomId)) {
      const chk = checkElementChange(mol, hit.atomId, el, autoHydrogens(s, mol));
      if (chk.same) return { hint: `Already ${el} · pick another element in the toolbar` };
      const valid = !chk.warning;
      return {
        overlay: {
          ghostAtoms: [{ position: atomPos(mol, hit.atomId)!, element: el, valid }],
          highlightAtoms: [{ atomId: hit.atomId, color: valid ? 'target' : 'invalid' }],
        },
        hint: valid ? `Click to change ${shortAtomLabel(mol, hit.atomId)} to ${el}` : `${chk.warning} — click to change anyway`,
      };
    }
    return { hint: `Click an atom to change it to ${el}` };
  },

  press(_env, hit) {
    if (hit?.kind !== 'atom' || hit.atomId === undefined) return { consume: false };
    const atomId = hit.atomId;
    return {
      consume: true,
      click(env) {
        const s = env.state();
        const mol = s.molecule;
        const atom = mol ? atomById(mol, atomId) : undefined;
        if (!mol || !atom || atom.element === s.editElement) return;
        commitResult(env, applyElementChange(mol, atomId, s.editElement, autoHydrogens(s, mol)));
      },
    };
  },
};
