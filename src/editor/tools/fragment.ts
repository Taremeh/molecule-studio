/**
 * Fragment tool (template = store.editFragment): click an atom to attach the fragment there
 * (replacing a hydrogen when possible), click empty space to place a free copy.
 */
import { atomById } from '../../core/molecule';
import { getFragment } from '../../core/templates';
import { checkFragmentAnchor, shortAtomLabel } from '../feedback';
import { applyFragment } from '../ops';
import { commitResult, hitKey, placementPoint, warn } from './common';
import type { Tool } from './types';

export const fragmentTool: Tool = {
  hoverKey: (_env, hit) => hitKey(hit),

  preview(env, hit) {
    const s = env.state();
    const mol = s.molecule;
    if (!mol) return { hint: null };
    const frag = getFragment(s.editFragment);
    if (!frag) return { hint: 'Pick a fragment in the toolbar' };
    if (hit?.kind === 'atom' && hit.atomId !== undefined && atomById(mol, hit.atomId)) {
      const chk = checkFragmentAnchor(mol, hit.atomId);
      return {
        overlay: { highlightAtoms: [{ atomId: hit.atomId, color: chk.ok ? 'target' : 'invalid' }] },
        hint: chk.ok ? `Click to attach ${frag.name} to ${shortAtomLabel(mol, hit.atomId)}` : chk.reason ?? `Can't attach ${frag.name} here`,
      };
    }
    return { hint: mol.atoms.length ? `Click to place ${frag.name} · or click an atom to attach it` : `Click to place ${frag.name}` };
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
          const chk = checkFragmentAnchor(mol, atomId);
          if (!chk.ok) return warn(env, chk.reason ?? "Can't attach a fragment here");
          commitResult(env, applyFragment(mol, s.editFragment, { anchorAtomId: atomId }));
        },
      };
    }
    if (hit) return { consume: false };
    return {
      consume: false,
      click(env, p) {
        const s = env.state();
        const mol = s.molecule;
        if (!mol) return;
        commitResult(env, applyFragment(mol, s.editFragment, { position: placementPoint(env, mol, p) }));
      },
    };
  },
};
