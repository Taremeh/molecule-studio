/**
 * Charge tool: click an atom for +1, Shift-click for −1 (auto hydrogens adjust, e.g. NH₃ → NH₄⁺).
 */
import { atomById } from '../../core/molecule';
import { chargeSuperscript } from '../feedback';
import { applyChargeChange, MAX_ABS_CHARGE } from '../ops';
import { autoHydrogens, commitResult, hitKey } from './common';
import type { Tool } from './types';

export const chargeTool: Tool = {
  hoverKey: (_env, hit, p) => `${hitKey(hit)}|${p.shift ? '-' : '+'}`,

  preview(env, hit, p) {
    const mol = env.state().molecule;
    if (!mol) return { hint: null };
    const atom = hit?.kind === 'atom' && hit.atomId !== undefined ? atomById(mol, hit.atomId) : undefined;
    if (!atom) return { hint: 'Click an atom: charge +1 · Shift-click: −1' };
    const c = atom.charge ?? 0;
    const delta = p.shift ? -1 : 1;
    const next = c + delta;
    const label = (q: number) => `${atom.element}${chargeSuperscript(q)}`;
    const limited = Math.abs(next) > MAX_ABS_CHARGE;
    return {
      overlay: { highlightAtoms: [{ atomId: atom.id, color: limited ? 'invalid' : 'target' }] },
      hint: limited
        ? `Charge is limited to ±${MAX_ABS_CHARGE}`
        : `${p.shift ? 'Shift-click' : 'Click'}: ${label(c)} → ${label(next)} · ${p.shift ? 'click' : 'Shift-click'}: ${label(c - delta)}`,
    };
  },

  press(_env, hit) {
    if (hit?.kind !== 'atom' || hit.atomId === undefined) return { consume: false };
    const atomId = hit.atomId;
    return {
      consume: true,
      click(env, p) {
        const s = env.state();
        const mol = s.molecule;
        if (!mol || !atomById(mol, atomId)) return;
        commitResult(env, applyChargeChange(mol, atomId, p.shift ? -1 : 1, autoHydrogens(s, mol)));
      },
    };
  },
};
