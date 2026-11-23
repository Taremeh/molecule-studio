/**
 * Add-atom tool (element = store.editElement, bond order = store.editBondOrder).
 * - click empty space: new atom on the camera plane through the view target (origin for the first atom);
 * - click a hydrogen: it becomes the element (at the ideal bond length);
 * - click a saturated atom: its hydrogen nearest to the pointer is replaced (Avogadro-style);
 * - click an atom with an open valence: a new atom is bonded at the VSEPR-suggested position,
 *   on the side of the atom where the pointer is;
 * - drag from an atom: aim the new bond (release on empty) or bond to another atom (release on it).
 * Hover shows a ghost of the atom that would be created, red with the reason when invalid.
 */
import type { HighlightColor, Molecule, Vec3 } from '../../core/types';
import { atomById } from '../../core/molecule';
import { type AddAtomPlan, capacityOf, planAddAtomOnAtom, shortAtomLabel } from '../feedback';
import { applyAddAtom, applyAddFreeAtom } from '../ops';
import { createBondDrag } from './bondDrag';
import { atomPos, autoHydrogens, closestOnScreen, commitResult, hitKey, placementPoint, pointerSector, warn } from './common';
import type { Feedback, PointerState, Tool, ToolEnv } from './types';

interface PointerChoice {
  /** Changes whenever the plan would change (chosen H, pointer sector). */
  subKey: string;
  pickHydrogen?: (ids: number[]) => number;
  preferDir?: Vec3;
}

/** Cheap part of the hover preview: which H to replace / which side to add on, from the pointer. */
function pointerChoice(env: ToolEnv, mol: Molecule, atomId: number, p: PointerState): PointerChoice {
  const element = env.state().editElement;
  const atom = atomById(mol, atomId)!;
  if (atom.element === 'H') return { subKey: '' };
  const { sector, dir } = pointerSector(env.viewer, atomPos(mol, atomId)!, p);
  const hs = element !== 'H' ? capacityOf(mol, atomId).hydrogens : [];
  if (!hs.length) return { subKey: `s${sector}`, preferDir: dir };
  const h = closestOnScreen(env.viewer, mol, hs, p);
  return { subKey: `h${h}|s${sector}`, pickHydrogen: () => h, preferDir: dir };
}

/** Plan for the add-atom click on `atomId` given where the pointer sits on that atom. */
function planForPointer(env: ToolEnv, mol: Molecule, atomId: number, p: PointerState): AddAtomPlan {
  const s = env.state();
  const { pickHydrogen, preferDir } = pointerChoice(env, mol, atomId, p);
  return planAddAtomOnAtom(mol, atomId, s.editElement, s.editBondOrder, { autoH: autoHydrogens(s, mol), pickHydrogen, preferDir });
}

function previewForPlan(mol: Molecule, atomId: number, plan: AddAtomPlan): Feedback {
  const anchorPos = plan.anchorId !== undefined ? atomPos(mol, plan.anchorId) : null;
  const highlightAtoms: { atomId: number; color: HighlightColor }[] = [
    ...(plan.replaceH !== undefined ? [{ atomId: plan.replaceH, color: 'target' as const }] : []),
    ...plan.removeH.map((id) => ({ atomId: id, color: 'delete' as const })),
  ];
  if (!plan.ok) highlightAtoms.push({ atomId: plan.anchorId ?? atomId, color: 'invalid' });
  const overlay = {
    ghostAtoms: [{ position: plan.position, element: plan.element, valid: plan.ok }],
    ghostBonds: anchorPos ? [{ from: anchorPos, to: plan.position, valid: plan.ok, order: plan.order, style: 'preview' as const }] : [],
    highlightAtoms,
  };
  if (!plan.ok) return { overlay, hint: plan.reason ?? "Can't add an atom here" };
  const clicked = atomById(mol, atomId);
  let hint: string;
  if (clicked?.element === 'H' && plan.replaceH === atomId) hint = `Click to replace this H with ${plan.element}`;
  else if (plan.anchorId !== undefined) hint = `Click to add ${plan.element} to ${shortAtomLabel(mol, plan.anchorId)} · or drag to aim the bond`;
  else hint = `Click to add ${plan.element}`;
  return { overlay, hint };
}

export const addAtomTool: Tool = {
  hoverKey(env, hit, p) {
    const mol = env.state().molecule;
    if (!mol || hit?.kind !== 'atom' || hit.atomId === undefined || !atomById(mol, hit.atomId)) return hitKey(hit);
    return `${hitKey(hit)}|${pointerChoice(env, mol, hit.atomId, p).subKey}`;
  },

  preview(env, hit, p) {
    const s = env.state();
    const mol = s.molecule;
    const el = s.editElement;
    if (!mol) return { hint: null };
    if (hit?.kind === 'atom' && hit.atomId !== undefined && atomById(mol, hit.atomId)) {
      return previewForPlan(mol, hit.atomId, planForPointer(env, mol, hit.atomId, p));
    }
    if (hit?.kind === 'bond') return { hint: `Click an atom or empty space to add ${el}` };
    if (mol.atoms.length === 0) return { hint: `Click anywhere to place a ${el} atom` };
    return { hint: `Click to add ${el} · drag from an atom to draw a bond` };
  },

  press(_env, hit) {
    if (hit?.kind === 'atom' && hit.atomId !== undefined) {
      const atomId = hit.atomId;
      return {
        consume: true,
        click(env, p) {
          const s = env.state();
          const mol = s.molecule;
          if (!mol || !atomById(mol, atomId)) return;
          const plan = planForPointer(env, mol, atomId, p);
          if (!plan.ok) return warn(env, plan.reason ?? "Can't add an atom here");
          commitResult(env, applyAddAtom(mol, plan, autoHydrogens(s, mol)));
        },
        startDrag: (env) => createBondDrag(env, atomId, 'add-atom'),
      };
    }
    if (hit) return { consume: false };
    return {
      consume: false,
      click(env, p) {
        const s = env.state();
        const mol = s.molecule;
        if (!mol) return;
        commitResult(env, applyAddFreeAtom(mol, s.editElement, placementPoint(env, mol, p), autoHydrogens(s, mol)));
      },
    };
  },
};
