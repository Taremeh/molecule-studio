import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/elements', () => import('./testing/fakeElements'));
vi.mock('../core/chemistry', () => import('./testing/fakeChemistry'));
vi.mock('../core/edit', () => import('./testing/fakeEdit'));
vi.mock('../core/geometry', async () => ({
  ...(await vi.importActual<object>('../core/geometry')),
  ...(await import('./testing/fakeGeometry')),
}));

import type { Molecule } from '../core/types';
import { atomById, bondBetween, neighborIds } from '../core/molecule';
import { idealBondLength } from '../core/geometry';
import { checkBond, planAddAtomOnAtom, planAddAtomToward, planDeleteAtoms } from './feedback';
import {
  applyAddAtom,
  applyAddFreeAtom,
  applyBond,
  applyChargeChange,
  applyCycleBond,
  applyDelete,
  applyDeleteBond,
  applyElementChange,
  applySnapBonds,
} from './ops';
import { counts, ethane, methane, mol, twoGroups, withHydrogens } from './testing/molecules';

function ok(r: ReturnType<typeof applyBond>): Molecule {
  if (!r.ok) throw new Error(r.reason);
  return r.mol;
}

const hCount = (m: Molecule, id: number) => neighborIds(m, id).filter((n) => atomById(m, n)?.element === 'H').length;

describe('adding atoms', () => {
  it('places a first carbon and fills it to methane in auto-H mode', () => {
    const empty = mol([]);
    const r = applyAddFreeAtom(empty, 'C', [0, 0, 0], true);
    expect(r.ok && r.label).toBe('Add C');
    expect(counts(ok(r))).toEqual({ C: 1, H: 4 });
    expect(counts(ok(applyAddFreeAtom(empty, 'N', [0, 0, 0], false)))).toEqual({ N: 1 });
  });

  it('grows methane into ethane by replacing a hydrogen', () => {
    const m = methane();
    const plan = planAddAtomOnAtom(m, 1, 'C', 1, { autoH: true, pickHydrogen: () => 2 });
    const r = applyAddAtom(m, plan, true);
    const next = ok(r);
    expect(counts(next)).toEqual({ C: 2, H: 6 });
    expect(atomById(next, 2)).toBeUndefined(); // the replaced H is gone
    const newC = r.ok ? r.atomId! : -1;
    expect(bondBetween(next, 1, newC)?.order).toBe(1);
    expect(hCount(next, 1)).toBe(3);
    expect(hCount(next, newC)).toBe(3);
  });

  it('turns methane into formaldehyde with a double-bonded O', () => {
    const m = methane();
    const plan = planAddAtomOnAtom(m, 1, 'O', 2, { autoH: true, pickHydrogen: () => 3 });
    const r = applyAddAtom(m, plan, true);
    const next = ok(r);
    const o = r.ok ? r.atomId! : -1;
    expect(counts(next)).toEqual({ C: 1, O: 1, H: 2 });
    expect(bondBetween(next, 1, o)?.order).toBe(2);
    expect(hCount(next, o)).toBe(0);
  });

  it('turns a clicked H of methane into a hydroxyl (methanol)', () => {
    const m = methane();
    const plan = planAddAtomOnAtom(m, 5, 'O', 1, { autoH: true });
    const next = ok(applyAddAtom(m, plan, true));
    expect(counts(next)).toEqual({ C: 1, O: 1, H: 4 });
  });

  it('draws a new atom from a drag, freeing the nearest H', () => {
    const m = methane();
    const plan = planAddAtomToward(m, 1, 'N', 1, [3, 0, 0]);
    const next = ok(applyAddAtom(m, plan, true));
    expect(counts(next)).toEqual({ C: 1, N: 1, H: 5 }); // CH3–NH2
  });

  it('refuses invalid plans', () => {
    const r = applyAddAtom(methane(), planAddAtomOnAtom(methane(), 1, 'H', 1, { autoH: true }), true);
    expect(r.ok).toBe(false);
  });
});

describe('bonds', () => {
  it('closes a bond between two methanes by removing one H on each (auto-H)', () => {
    const m = twoGroups({ el: 'C', nH: 4, at: [0, 0, 0] }, { el: 'C', nH: 4, at: [1.6, 0, 0] });
    const chk = checkBond(m, 1, 6, 1, true);
    const r = applyBond(m, 1, 6, 1, chk, true);
    expect(r.ok && r.label).toBe('Bond C–C');
    const next = ok(r);
    expect(counts(next)).toEqual({ C: 2, H: 6 });
    expect(bondBetween(next, 1, 6)).toBeDefined();
  });

  it('upgrades ethane to ethene and re-hydrogenates both carbons', () => {
    const e = ethane();
    const bond = bondBetween(e, 1, 5)!;
    const r = applyCycleBond(e, bond.id, true);
    expect(r.ok && r.label).toBe('Bond C–C (double)');
    const next = ok(r);
    expect(bondBetween(next, 1, 5)?.order).toBe(2);
    expect(counts(next)).toEqual({ C: 2, H: 4 });
    // the C=C bond is shortened to its ideal length
    const c1 = atomById(next, 1)!;
    const c2 = atomById(next, 5)!;
    expect(Math.hypot(c1.x - c2.x, c1.y - c2.y, c1.z - c2.z)).toBeCloseTo(idealBondLength('C', 'C', 2), 6);
  });

  it('cycles triple back to single, adding hydrogens', () => {
    // ethyne H–C≡C–H
    const m = mol(
      [
        { el: 'H', at: [-1.06, 0, 0] },
        { el: 'C', at: [0, 0, 0] },
        { el: 'C', at: [1.2, 0, 0] },
        { el: 'H', at: [2.26, 0, 0] },
      ],
      [
        [0, 1],
        [1, 2, 3],
        [2, 3],
      ],
    );
    const bond = bondBetween(m, 2, 3)!;
    const next = ok(applyCycleBond(m, bond.id, true));
    expect(bondBetween(next, 2, 3)?.order).toBe(1);
    expect(counts(next)).toEqual({ C: 2, H: 6 });
  });

  it('refuses an order increase without room (no auto-H)', () => {
    const e = ethane();
    const r = applyCycleBond(e, bondBetween(e, 1, 5)!.id, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("C already has 4 bonds — can't add another");
  });

  it('deletes a bond and refills hydrogens on both sides', () => {
    const e = ethane();
    const r = applyDeleteBond(e, bondBetween(e, 1, 5)!.id, true);
    expect(r.ok && r.label).toBe('Delete C–C bond');
    expect(counts(ok(r))).toEqual({ C: 2, H: 8 });
    // deleting a C–H bond does not immediately re-add a hydrogen
    const r2 = applyDeleteBond(e, bondBetween(e, 1, 2)!.id, true);
    expect(counts(ok(r2))).toEqual({ C: 2, H: 6 });
  });

  it('snaps suggested bonds closest first, one per atom', () => {
    // two methyl radicals C1 and C5 and a bare O9 above C5
    const a = withHydrogens('C', [0, 0, 0], 3, 0, -1);
    const b = withHydrogens('C', [1.6, 0, 0], 3, 4, 1);
    const m = mol([...a.atoms, ...b.atoms, { el: 'O', at: [1.6, 1.5, 0] }], [...a.bonds, ...b.bonds]);
    const res = applySnapBonds(
      m,
      [
        { a: 5, b: 9, from: [1.6, 0, 0], to: [1.6, 1.5, 0], valid: true, ratio: 1.5 / 1.42 }, // 1.056
        { a: 1, b: 5, from: [0, 0, 0], to: [1.6, 0, 0], valid: true, ratio: 1.6 / 1.52 }, // 1.053 (better)
      ],
      false,
    );
    // C5 is used by the better-fitting C–C bond, so the C–O suggestion is dropped
    expect(res.formed).toEqual(['C–C']);
    expect(bondBetween(res.mol, 1, 5)).toBeDefined();
    expect(bondBetween(res.mol, 5, 9)).toBeUndefined();
  });
});

describe('delete, element, charge', () => {
  const methanol = () => {
    const c = withHydrogens('C', [0, 0, 0], 3, 0, -1);
    return mol([...c.atoms, { el: 'O', at: [1.43, 0, 0] }, { el: 'H', at: [1.75, 0.9, 0] }], [...c.bonds, [0, 4], [4, 5]]);
  };

  it('deletes the carbon of methanol, leaving water in auto-H mode', () => {
    const m = methanol();
    const r = applyDelete(m, planDeleteAtoms(m, [1]), true);
    expect(r.ok && r.label).toBe('Delete C');
    expect(counts(ok(r))).toEqual({ O: 1, H: 2 });
    expect(counts(ok(applyDelete(m, planDeleteAtoms(m, [1]), false)))).toEqual({ O: 1, H: 1 });
  });

  it('changes methane to water and fixes the O–H bond lengths', () => {
    const r = applyElementChange(methane(), 1, 'O', true);
    expect(r.ok && r.label).toBe('Change C to O');
    const next = ok(r);
    expect(counts(next)).toEqual({ O: 1, H: 2 });
    const o = atomById(next, 1)!;
    for (const h of neighborIds(next, 1)) {
      const a = atomById(next, h)!;
      expect(Math.hypot(a.x - o.x, a.y - o.y, a.z - o.z)).toBeCloseTo(idealBondLength('O', 'H', 1), 6);
    }
  });

  it('warns (but applies) an over-valent element change', () => {
    const r = applyElementChange(methane(), 1, 'O', false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/O has 4 bonds/);
  });

  it('protonates ammonia to ammonium and deprotonates water to hydroxide', () => {
    const nh3 = mol(withHydrogens('N', [0, 0, 0], 3).atoms, withHydrogens('N', [0, 0, 0], 3).bonds);
    const r = applyChargeChange(nh3, 1, +1, true);
    expect(r.ok && r.label).toBe('Charge N⁺ (+1)');
    const next = ok(r);
    expect(atomById(next, 1)?.charge).toBe(1);
    expect(counts(next)).toEqual({ N: 1, H: 4 });

    const water = mol(withHydrogens('O', [0, 0, 0], 2).atoms, withHydrogens('O', [0, 0, 0], 2).bonds);
    expect(counts(ok(applyChargeChange(water, 1, -1, true)))).toEqual({ O: 1, H: 1 });
  });

  it('limits the charge range', () => {
    const m = mol([{ el: 'C', at: [0, 0, 0], charge: 4 }]);
    expect(applyChargeChange(m, 1, +1, false).ok).toBe(false);
  });
});
