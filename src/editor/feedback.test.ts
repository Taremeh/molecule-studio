import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/elements', () => import('./testing/fakeElements'));
vi.mock('../core/chemistry', () => import('./testing/fakeChemistry'));
vi.mock('../core/geometry', async () => ({
  ...(await vi.importActual<object>('../core/geometry')),
  ...(await import('./testing/fakeGeometry')),
}));

import type { Molecule, Vec3 } from '../core/types';
import { atomById } from '../core/molecule';
import { idealBondLength } from '../core/geometry';
import {
  atomsWithinBonds,
  capacityOf,
  chargeSuperscript,
  checkBond,
  checkBondFast,
  checkElementChange,
  checkFragmentAnchor,
  computeDragFeedback,
  createProximityIndex,
  formatMeasurement,
  measureHint,
  nextBondOrder,
  nextPendingMeasure,
  planAddAtomOnAtom,
  planAddAtomToward,
  planDeleteAtoms,
  roomNeeded,
  valenceReason,
} from './feedback';
import { SpatialGrid } from './spatial';
import { ethane, methane, mol, twoGroups, withHydrogens } from './testing/molecules';

const pos = (m: Molecule, id: number): Vec3 => {
  const a = atomById(m, id)!;
  return [a.x, a.y, a.z];
};
const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

describe('labels and small helpers', () => {
  it('formats charges and measurements', () => {
    expect(chargeSuperscript(0)).toBe('');
    expect(chargeSuperscript(1)).toBe('⁺');
    expect(chargeSuperscript(-1)).toBe('⁻');
    expect(chargeSuperscript(2)).toBe('²⁺');
    expect(chargeSuperscript(-3)).toBe('³⁻');
    expect(formatMeasurement('distance', 1.5371)).toBe('1.54 Å');
    expect(formatMeasurement('angle', 109.4712)).toBe('109.5°');
    expect(formatMeasurement('dihedral', NaN)).toBe('—');
  });

  it('cycles bond orders like core/edit', () => {
    expect(nextBondOrder(1)).toBe(2);
    expect(nextBondOrder(2)).toBe(3);
    expect(nextBondOrder(3)).toBe(1);
    expect(nextBondOrder(1.5)).toBe(2);
  });

  it('builds measure hints and pending lists', () => {
    expect(measureHint('angle', 1)).toBe('Pick atom 2 of 3 for an angle');
    expect(measureHint('distance', 0)).toBe('Pick atom 1 of 2 for a distance');
    expect(nextPendingMeasure([], 4, 'distance')).toEqual({ pending: [4], complete: false });
    expect(nextPendingMeasure([4], 7, 'distance')).toEqual({ pending: [4, 7], complete: true });
    // clicking a picked atom un-picks it
    expect(nextPendingMeasure([4, 7], 4, 'angle')).toEqual({ pending: [7], complete: false });
    expect(nextPendingMeasure([1, 2, 3], 9, 'dihedral')).toEqual({ pending: [1, 2, 3, 9], complete: true });
  });
});

describe('valence capacity', () => {
  it('counts used valence and hydrogens', () => {
    const m = methane();
    const cap = capacityOf(m, 1);
    expect(cap).toMatchObject({ used: 4, max: 4, bondCount: 4 });
    expect(cap.hydrogens).toEqual([2, 3, 4, 5]);
  });

  it('rounds aromatic sums sensibly', () => {
    // fused aromatic carbon: 3 × 1.5 = 4.5 → saturated, one more bond needs one slot
    expect(roomNeeded({ used: 4.5, max: 4, bondCount: 3, hydrogens: [] }, 1)).toBe(1);
    // aromatic CH: 2 × 1.5 + 1 = 4
    expect(roomNeeded({ used: 4, max: 4, bondCount: 3, hydrogens: [9] }, 1)).toBe(1);
    // aromatic C with two ring bonds only: room for one
    expect(roomNeeded({ used: 3, max: 4, bondCount: 2, hydrogens: [] }, 1)).toBe(0);
    expect(roomNeeded({ used: 3, max: 4, bondCount: 2, hydrogens: [] }, 2)).toBe(1);
    expect(roomNeeded({ used: 9, max: Infinity, bondCount: 9, hydrogens: [] }, 3)).toBe(0);
  });

  it('explains valence problems in plain words', () => {
    // N with three methyl-ish neighbours (no H)
    const m = mol(
      [
        { el: 'N', at: [0, 0, 0] },
        { el: 'C', at: [1.47, 0, 0] },
        { el: 'C', at: [-0.7, 1.27, 0] },
        { el: 'C', at: [-0.7, -1.27, 0] },
      ],
      [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );
    expect(valenceReason(m, 1, 1)).toBe("N already has 3 bonds — can't add another");
    const co2 = mol(
      [
        { el: 'O', at: [-1.16, 0, 0] },
        { el: 'C', at: [0, 0, 0] },
        { el: 'O', at: [1.16, 0, 0] },
      ],
      [
        [0, 1, 2],
        [1, 2, 2],
      ],
    );
    expect(valenceReason(co2, 2, 1)).toBe("C is saturated (valence 4 used) — can't add another bond");
    const amine = mol(
      [
        { el: 'N', at: [0, 0, 0] },
        { el: 'C', at: [1.47, 0, 0] },
        { el: 'C', at: [-0.7, 1.27, 0] },
      ],
      [
        [0, 1],
        [0, 2],
      ],
    );
    expect(valenceReason(amine, 1, 2)).toBe("N has room for only 1 more bond — can't add a double bond");
  });
});

describe('checkBond', () => {
  const radicals = () => twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'C', nH: 3, at: [1.6, 0, 0] });
  const methanes = () => twoGroups({ el: 'C', nH: 4, at: [0, 0, 0] }, { el: 'C', nH: 4, at: [1.6, 0, 0] });

  it('accepts a bond between two radicals', () => {
    const r = checkBond(radicals(), 1, 5, 1, false);
    expect(r).toMatchObject({ ok: true, removeH: [], label: 'C–C' });
  });

  it('refuses saturated atoms unless auto-hydrogens may make room', () => {
    const m = methanes();
    const no = checkBond(m, 1, 6, 1, false);
    expect(no.ok).toBe(false);
    expect(no.reason).toBe("C already has 4 bonds — can't add another");

    const yes = checkBond(m, 1, 6, 1, true);
    expect(yes.ok).toBe(true);
    expect(yes.removeH).toHaveLength(2);
    // one hydrogen from each carbon, the one closest to the partner
    const h1 = yes.removeH.find((h) => h >= 2 && h <= 5)!;
    const h2 = yes.removeH.find((h) => h >= 7)!;
    const closest = (hs: number[], to: Vec3) => hs.reduce((b, h) => (dist(pos(m, h), to) < dist(pos(m, b), to) ? h : b));
    expect(h1).toBe(closest([2, 3, 4, 5], pos(m, 6)));
    expect(h2).toBe(closest([7, 8, 9, 10], pos(m, 1)));
  });

  it('rejects same atom, duplicate order and far-apart atoms', () => {
    const m = radicals();
    expect(checkBond(m, 1, 1, 1, true).ok).toBe(false);
    const e = ethane();
    const dup = checkBond(e, 1, 5, 1, true);
    expect(dup.ok).toBe(false);
    expect(dup.reason).toBe('C–C is already a single bond');
    const far = twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'C', nH: 3, at: [5, 0, 0] });
    const r = checkBond(far, 1, 5, 1, true);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/far/);
  });

  it('upgrades an existing bond by removing one H per carbon in auto-H mode', () => {
    const e = ethane();
    expect(checkBond(e, 1, 5, 2, false).ok).toBe(false);
    const r = checkBond(e, 1, 5, 2, true);
    expect(r.ok).toBe(true);
    expect(r.existing?.order).toBe(1);
    expect(r.removeH).toHaveLength(2);
    expect(r.label).toBe('C–C (double)');
  });

  it('checkBondFast uses the current distance with the base valence analysis', () => {
    const base = twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'C', nH: 3, at: [8, 0, 0] });
    // far apart in the base molecule…
    expect(checkBond(base, 1, 5, 1, false).ok).toBe(false);
    expect(checkBondFast(base, 1, 5, 1, false, 8).ok).toBe(false);
    // …but close after a drag
    expect(checkBondFast(base, 1, 5, 1, false, 1.5).ok).toBe(true);
    const sat = twoGroups({ el: 'C', nH: 4, at: [0, 0, 0] }, { el: 'C', nH: 4, at: [1.5, 0, 0] });
    expect(checkBondFast(sat, 1, 6, 1, false, 1.5).ok).toBe(false);
    expect(checkBondFast(sat, 1, 6, 1, true, 1.5).ok).toBe(true);
  });
});

describe('planAddAtomOnAtom', () => {
  it('replaces the chosen hydrogen of a heavy atom at the ideal bond length', () => {
    const m = methane();
    const plan = planAddAtomOnAtom(m, 1, 'O', 1, { autoH: false, pickHydrogen: () => 3 });
    expect(plan).toMatchObject({ ok: true, anchorId: 1, replaceH: 3, removeH: [], label: 'Add O' });
    // ideal C–O single bond (≈ 1.42 Å), along the C→H3 direction
    const co = idealBondLength('C', 'O', 1);
    expect(co).toBeCloseTo(1.42, 1);
    expect(dist(plan.position, [0, 0, 0])).toBeCloseTo(co, 6);
    const h = pos(m, 3);
    const l = Math.hypot(...h);
    plan.position.forEach((v, i) => expect(v / co).toBeCloseTo(h[i] / l, 6));
  });

  it('makes room for a double bond in auto-H mode and refuses it otherwise', () => {
    const m = methane();
    const auto = planAddAtomOnAtom(m, 1, 'O', 2, { autoH: true, pickHydrogen: () => 2 });
    expect(auto.ok).toBe(true);
    expect(auto.replaceH).toBe(2);
    expect(auto.removeH).toHaveLength(1);
    expect(dist(auto.position, [0, 0, 0])).toBeCloseTo(idealBondLength('C', 'O', 2), 6);
    const manual = planAddAtomOnAtom(m, 1, 'O', 2, { autoH: false, pickHydrogen: () => 2 });
    expect(manual.ok).toBe(false);
    expect(manual.reason).toBe("C already has 4 bonds — can't add another");
  });

  it('turns a clicked hydrogen into the new element', () => {
    const m = methane();
    const plan = planAddAtomOnAtom(m, 4, 'Cl', 1, { autoH: true });
    expect(plan).toMatchObject({ ok: true, anchorId: 1, replaceH: 4, label: 'Replace H with Cl' });
    expect(dist(plan.position, [0, 0, 0])).toBeCloseTo(idealBondLength('C', 'Cl', 1), 6);
  });

  it('adds a new bonded atom when there is no hydrogen to replace', () => {
    const radical = mol(withHydrogens('C', [0, 0, 0], 3).atoms, withHydrogens('C', [0, 0, 0], 3).bonds);
    const plan = planAddAtomOnAtom(radical, 1, 'N', 1, { autoH: true });
    expect(plan.ok).toBe(true);
    expect(plan.replaceH).toBeUndefined();
    expect(dist(plan.position, [0, 0, 0])).toBeCloseTo(idealBondLength('C', 'N', 1), 6);
  });

  it('explains invalid additions', () => {
    const amine = mol(
      [
        { el: 'N', at: [0, 0, 0] },
        { el: 'C', at: [1.47, 0, 0] },
        { el: 'C', at: [-0.7, 1.27, 0] },
        { el: 'C', at: [-0.7, -1.27, 0] },
      ],
      [
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );
    const r = planAddAtomOnAtom(amine, 1, 'C', 1, { autoH: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("N already has 3 bonds — can't add another");
    const radical = mol([{ el: 'C', at: [0, 0, 0] }]);
    expect(planAddAtomOnAtom(radical, 1, 'F', 2, { autoH: true }).reason).toBe("F can't form a double bond");
    expect(planAddAtomOnAtom(radical, 1, 'Ne', 1, { autoH: true }).reason).toBe("Ne doesn't form bonds");
    // adding H to a saturated atom is never "made room for"
    expect(planAddAtomOnAtom(methane(), 1, 'H', 1, { autoH: true }).ok).toBe(false);
  });

  it('converts a lone hydrogen in place', () => {
    const m = mol([{ el: 'H', at: [1, 2, 3] }]);
    const plan = planAddAtomOnAtom(m, 1, 'O', 1, { autoH: true });
    expect(plan).toMatchObject({ ok: true, replaceH: 1, position: [1, 2, 3] });
    expect(plan.anchorId).toBeUndefined();
  });
});

describe('planAddAtomToward', () => {
  it('aims the new bond at the pointer at the ideal length, freeing the nearest H', () => {
    const m = methane();
    const plan = planAddAtomToward(m, 1, 'C', 1, [5, 0.3, 0.2]);
    expect(plan.ok).toBe(true);
    expect(dist(plan.position, [0, 0, 0])).toBeCloseTo(idealBondLength('C', 'C', 1), 6);
    expect(plan.removeH).toHaveLength(1);
    // the removed H is the one closest to the new atom
    const others = [2, 3, 4, 5].filter((h) => h !== plan.removeH[0]);
    for (const h of others) expect(dist(pos(m, plan.removeH[0]), plan.position)).toBeLessThan(dist(pos(m, h), plan.position));
  });

  it('is invalid for a saturated atom without hydrogens', () => {
    const co2 = mol(
      [
        { el: 'O', at: [-1.16, 0, 0] },
        { el: 'C', at: [0, 0, 0] },
        { el: 'O', at: [1.16, 0, 0] },
      ],
      [
        [0, 1, 2],
        [1, 2, 2],
      ],
    );
    const plan = planAddAtomToward(co2, 2, 'C', 1, [0, 3, 0]);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/saturated/);
  });
});

describe('planDeleteAtoms', () => {
  // methanol: C1 (H2 H3 H4) – O5 – H6
  const methanol = () => {
    const c = withHydrogens('C', [0, 0, 0], 3, 0, -1);
    return mol(
      [...c.atoms, { el: 'O', at: [1.43, 0, 0] }, { el: 'H', at: [1.75, 0.9, 0] }],
      [...c.bonds, [0, 4], [4, 5]],
    );
  };

  it('removes a heavy atom with its hydrogens and fixes its neighbours', () => {
    const plan = planDeleteAtoms(methanol(), [1]);
    expect(plan.remove.sort()).toEqual([1, 2, 3, 4]);
    expect(plan.fix).toEqual([5]);
    expect(plan.label).toBe('Delete C');
  });

  it('removes a single hydrogen without fixing its parent', () => {
    const plan = planDeleteAtoms(methanol(), [6]);
    expect(plan).toEqual({ remove: [6], fix: [], label: 'Delete H' });
  });

  it('labels multi-atom deletions with the total count', () => {
    const plan = planDeleteAtoms(methanol(), [1, 5, 99]);
    expect(plan.remove).toHaveLength(6);
    expect(plan.label).toBe('Delete 6 atoms');
    expect(planDeleteAtoms(methanol(), [2, 3]).label).toBe('Delete 2 hydrogens');
  });
});

describe('element and fragment checks', () => {
  it('warns when the new element cannot hold the heavy-atom bonds', () => {
    const quaternary = mol(
      [
        { el: 'C', at: [0, 0, 0] },
        { el: 'C', at: [1.54, 0, 0] },
        { el: 'C', at: [-0.51, 1.45, 0] },
        { el: 'C', at: [-0.51, -0.73, 1.26] },
        { el: 'C', at: [-0.51, -0.73, -1.26] },
      ],
      [
        [0, 1],
        [0, 2],
        [0, 3],
        [0, 4],
      ],
    );
    expect(checkElementChange(quaternary, 1, 'N', true).warning).toBe('N forms at most 3 bonds, but this atom has 4');
    // methane C → O is fine in auto-H mode (surplus H go away) but over-valent without
    expect(checkElementChange(methane(), 1, 'O', true).warning).toBeUndefined();
    expect(checkElementChange(methane(), 1, 'O', false).warning).toBeDefined();
    expect(checkElementChange(methane(), 1, 'C', true)).toMatchObject({ ok: false, same: true });
  });

  it('accepts fragment anchors with a hydrogen or open valence', () => {
    expect(checkFragmentAnchor(methane(), 1).ok).toBe(true);
    expect(checkFragmentAnchor(methane(), 2).ok).toBe(true);
    const co2 = mol(
      [
        { el: 'O', at: [-1.16, 0, 0] },
        { el: 'C', at: [0, 0, 0] },
        { el: 'O', at: [1.16, 0, 0] },
      ],
      [
        [0, 1, 2],
        [1, 2, 2],
      ],
    );
    expect(checkFragmentAnchor(co2, 2).ok).toBe(false);
  });
});

describe('drag feedback', () => {
  it('suggests a valid bond when a radical is dragged next to another', () => {
    // CH3 radical (ids 1–4) dragged to 1.5 Å of an OH radical (O = 5, H = 6)
    const m = twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'O', nH: 1, at: [1.5, 0, 0] });
    const moved = new Set([1, 2, 3, 4]);
    const fb = computeDragFeedback(m, { moved, grabbed: 1, autoH: false });
    expect(fb.suggestions).toHaveLength(1);
    expect(fb.suggestions[0]).toMatchObject({ a: 1, b: 5, valid: true });
    expect(fb.suggestions[0].ratio).toBeCloseTo(1.5 / 1.42, 6);
    expect(fb.clashes).toEqual([]);
  });

  it('flags a saturated partner as invalid and clashing', () => {
    const m = twoGroups({ el: 'C', nH: 4, at: [0, 0, 0] }, { el: 'C', nH: 4, at: [1.3, 0, 0] });
    const moved = new Set([1, 2, 3, 4, 5]);
    const fb = computeDragFeedback(m, { moved, grabbed: 1, autoH: false });
    const s = fb.suggestions.find((x) => x.b === 6)!;
    expect(s.valid).toBe(false);
    expect(s.reason).toBe("C already has 4 bonds — can't add another");
    expect(fb.clashes).toContainEqual({ a: 1, b: 6 });
    // with auto hydrogens the same approach is a valid ring-closure-style bond
    const auto = computeDragFeedback(m, { moved, grabbed: 1, autoH: true });
    expect(auto.suggestions.find((x) => x.b === 6)?.valid).toBe(true);
    expect(auto.clashes.find((c) => c.b === 6)).toBeUndefined();
  });

  it('ignores bonded partners and reports plain vdW clashes', () => {
    const e = ethane();
    const fb = computeDragFeedback(e, { moved: new Set([1]), grabbed: 1, autoH: false });
    expect(fb.suggestions.find((s) => s.b === 5)).toBeUndefined();
    // two non-bonded hydrogens 0.9 Å apart: beyond bonding range (1.2 × 0.62) but clashing (0.6 × 2.4)
    const hh = mol([
      { el: 'H', at: [0, 0, 0] },
      { el: 'H', at: [0.9, 0, 0] },
      { el: 'C', at: [3, 0, 0] },
    ]);
    const hhFb = computeDragFeedback(hh, { moved: new Set([1]), grabbed: 1, autoH: false });
    expect(hhFb.suggestions).toEqual([]);
    expect(hhFb.clashes).toEqual([{ a: 1, b: 2 }]);
    const close = mol([
      { el: 'C', at: [0, 0, 0] },
      { el: 'O', at: [1.8, 0, 0] },
    ]);
    // 1.8 Å > 1.2 × 1.42 (no bond suggestion) but < 0.6 × (1.7 + 1.52) = 1.93 → clash
    const fb2 = computeDragFeedback(close, { moved: new Set([1]), grabbed: 1, autoH: false });
    expect(fb2.suggestions).toEqual([]);
    expect(fb2.clashes).toEqual([{ a: 1, b: 2 }]);
  });

  it('gives identical results with the grid index on a large molecule', () => {
    // a 12×12×6 lattice of isolated carbons 3 Å apart, plus one radical carbon we drag into it
    const atoms = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) for (let k = 0; k < 6; k++) atoms.push({ el: 'C', at: [i * 3, j * 3, k * 3] as Vec3 });
    atoms.push({ el: 'C', at: [15.6, 15.2, 9] as Vec3 });
    const m = mol(atoms);
    const movedId = atoms.length;
    const moved = new Set([movedId]);
    const index = createProximityIndex(m, moved);
    const fast = computeDragFeedback(m, { moved, grabbed: movedId, autoH: false, index });
    const brute = computeDragFeedback(m, { moved, grabbed: movedId, autoH: false, index: { ...index, near: () => m.atoms.map((_, i) => i) } });
    expect(fast).toEqual(brute);
    expect(fast.suggestions.length).toBeGreaterThan(0);
  });
});

describe('topology helpers', () => {
  it('finds atoms within n bonds', () => {
    const chain = mol(
      Array.from({ length: 7 }, (_, i) => ({ el: 'C', at: [i * 1.5, 0, 0] as Vec3 })),
      Array.from({ length: 6 }, (_, i) => [i, i + 1] as [number, number]),
    );
    expect([...atomsWithinBonds(chain, new Set([1]), 3)].sort()).toEqual([2, 3, 4]);
    expect([...atomsWithinBonds(chain, new Set([4]), 1)].sort()).toEqual([3, 5]);
    expect([...atomsWithinBonds(chain, new Set([3, 4]), 2)].sort()).toEqual([1, 2, 5, 6]);
  });
});

describe('SpatialGrid', () => {
  it('returns a superset of the atoms within the radius, without duplicates', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 40 - 20;
    const m = mol(Array.from({ length: 2000 }, () => ({ el: 'C', at: [rnd(), rnd(), rnd()] as Vec3 })));
    const grid = new SpatialGrid(m, m.atoms.map((_, i) => i), 2.5);
    for (let q = 0; q < 20; q++) {
      const p: Vec3 = [rnd(), rnd(), rnd()];
      const r = 1 + Math.abs(rnd()) / 5;
      const got = grid.query(p, r);
      expect(new Set(got).size).toBe(got.length);
      const want = m.atoms.map((a, i) => (dist([a.x, a.y, a.z], p) <= r ? i : -1)).filter((i) => i >= 0);
      for (const i of want) expect(got).toContain(i);
    }
  });
});
