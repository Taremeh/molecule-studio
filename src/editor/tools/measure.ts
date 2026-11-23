/**
 * Measure tool: click 2 / 3 / 4 atoms for a distance / angle / dihedral (store.measureKind).
 * Clicking a picked atom again un-picks it; clicking a bond measures its length directly.
 */
import { atomById, bondById } from '../../core/molecule';
import { measureAtoms } from '../../core/geometry';
import { formatMeasurement, MEASURE_ATOM_COUNT, measureHint, nextPendingMeasure, pairLabel, shortAtomLabel } from '../feedback';
import { hitKey, selectGroupAndFocus } from './common';
import type { Tool } from './types';

const KIND_LABEL = { distance: 'Distance', angle: 'Angle', dihedral: 'Dihedral' } as const;

export const measureTool: Tool = {
  hoverKey: (_env, hit) => hitKey(hit),

  preview(env, hit) {
    const s = env.state();
    const mol = s.molecule;
    const kind = s.measureKind;
    const pending = s.pendingMeasure;
    const need = MEASURE_ATOM_COUNT[kind];
    if (!mol) return { hint: null };
    if (hit?.kind === 'atom' && hit.atomId !== undefined && atomById(mol, hit.atomId)) {
      const id = hit.atomId;
      if (pending.includes(id)) return { hint: `Click to un-pick ${shortAtomLabel(mol, id)} · Esc clears all picks` };
      if (pending.length === need - 1) {
        const value = measureAtoms(mol, [...pending, id]);
        const v = Number.isFinite(value) ? ` = ${formatMeasurement(kind, value)}` : '';
        return { hint: `Click to add ${KIND_LABEL[kind].toLowerCase()}${v}` };
      }
      return { hint: `${measureHint(kind, pending.length)} · click ${shortAtomLabel(mol, id)}` };
    }
    if (hit?.kind === 'bond' && kind === 'distance' && pending.length === 0) {
      const bond = hit.bondId !== undefined ? bondById(mol, hit.bondId) : undefined;
      if (bond) {
        const value = measureAtoms(mol, [bond.a, bond.b]);
        const v = Number.isFinite(value) ? ` (${formatMeasurement('distance', value)})` : '';
        return { hint: `Click to measure this ${pairLabel(mol, bond.a, bond.b)} bond${v}` };
      }
    }
    return { hint: measureHint(kind, pending.length) };
  },

  press(_env, hit) {
    return {
      consume: false,
      click(env) {
        const s = env.state();
        const mol = s.molecule;
        if (!mol || !hit) return;
        const kind = s.measureKind;
        if (hit.kind === 'atom' && hit.atomId !== undefined) {
          if (!atomById(mol, hit.atomId)) return;
          const { pending, complete } = nextPendingMeasure(s.pendingMeasure, hit.atomId, kind);
          if (complete) {
            s.addMeasurement(kind, pending);
            s.setPendingMeasure([]);
            const value = measureAtoms(mol, pending);
            s.toast(`${KIND_LABEL[kind]}${Number.isFinite(value) ? ' ' + formatMeasurement(kind, value) : ''} added`, 'success', 1800);
          } else s.setPendingMeasure(pending);
          return;
        }
        if (hit.kind === 'bond' && kind === 'distance' && s.pendingMeasure.length === 0 && hit.bondId !== undefined) {
          const bond = bondById(mol, hit.bondId);
          if (!bond) return;
          s.addMeasurement('distance', [bond.a, bond.b]);
          const value = measureAtoms(mol, [bond.a, bond.b]);
          s.toast(`Distance${Number.isFinite(value) ? ' ' + formatMeasurement('distance', value) : ''} added`, 'success', 1800);
        }
      },
    };
  },

  doubleClick(env, hit, p) {
    // Two clicks on the same atom already picked and un-picked it; just frame its neighbourhood.
    selectGroupAndFocus(env, hit, p, false);
  },
};
