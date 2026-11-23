import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMolecule, type AtomInput } from '../../core/molecule';
import type { Molecule } from '../../core/types';

// The inspector delegates edit feasibility and the edits themselves to core/edit and ring
// detection to core/chemistry; those are mocked so this suite tests the view model only.
const mocks = vi.hoisted(() => ({
  canSetDihedral: vi.fn((): { ok: boolean; reason?: string } => ({ ok: true })),
  setDistance: vi.fn((m: unknown) => ({ ...(m as object), tag: 'distance' })),
  setAngle: vi.fn((m: unknown) => ({ ...(m as object), tag: 'angle' })),
  setDihedral: vi.fn((m: unknown) => ({ ...(m as object), tag: 'dihedral' })),
  isBondInRing: vi.fn(() => false),
}));
vi.mock('../../core/edit', () => ({
  canSetDihedral: mocks.canSetDihedral,
  setDistance: mocks.setDistance,
  setAngle: mocks.setAngle,
  setDihedral: mocks.setDihedral,
}));
vi.mock('../../core/chemistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/chemistry')>()),
  isBondInRing: mocks.isBondInRing,
}));

import {
  applyGeometryValue,
  compactAtomLabels,
  deviationTone,
  formatMeasure,
  formatSigned,
  geometryEditLabel,
  geometryModel,
  isPinned,
  kindForCount,
  measureIds,
  shortAtomLabels,
  TETRAHEDRAL_ANGLE,
} from './geometryModel';
import { idealBondLength } from '../../core/geometry';

const deg = Math.PI / 180;

function water(): Molecule {
  // Experimental gas-phase geometry: r(OH) = 0.9572 Å, ∠HOH = 104.52°.
  const r = 0.9572;
  const t = 104.52 * deg;
  return buildMolecule(
    'water',
    [
      { element: 'O', x: 0, y: 0, z: 0 },
      { element: 'H', x: r, y: 0, z: 0 },
      { element: 'H', x: r * Math.cos(t), y: r * Math.sin(t), z: 0 },
    ],
    [
      { a: 0, b: 1 },
      { a: 0, b: 2 },
    ],
  );
}

/** Four carbons with a 1.54 Å central bond and a +60° a–b–c–d dihedral. */
function butaneLike(dihedralDeg = 60): Molecule {
  const atoms: AtomInput[] = [
    { element: 'C', x: 1, y: 0, z: -0.5 },
    { element: 'C', x: 0, y: 0, z: 0 },
    { element: 'C', x: 0, y: 0, z: 1.54 },
    { element: 'C', x: Math.cos(dihedralDeg * deg), y: Math.sin(dihedralDeg * deg), z: 2.04 },
  ];
  return buildMolecule('c4', atoms, [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 2, b: 3 },
  ]);
}

beforeEach(() => {
  mocks.canSetDihedral.mockReset().mockReturnValue({ ok: true });
  mocks.isBondInRing.mockReset().mockReturnValue(false);
});

describe('measureIds', () => {
  it('reproduces known geometry values', () => {
    const w = water();
    expect(measureIds(w, [1, 2])).toBeCloseTo(0.9572, 6);
    expect(measureIds(w, [2, 1, 3])).toBeCloseTo(104.52, 6);
    // H···H distance of water: 2 r sin(θ/2) = 1.5139 Å
    expect(measureIds(w, [2, 3])).toBeCloseTo(2 * 0.9572 * Math.sin((104.52 / 2) * deg), 6);
    expect(measureIds(butaneLike(60), [1, 2, 3, 4])).toBeCloseTo(60, 6);
    expect(measureIds(butaneLike(-75), [1, 2, 3, 4])).toBeCloseTo(-75, 6);
    expect(measureIds(butaneLike(180), [1, 2, 3, 4])).toBeCloseTo(180, 6);
  });

  it('is NaN for missing atoms or unsupported counts', () => {
    expect(measureIds(water(), [1, 99])).toBeNaN();
    expect(measureIds(water(), [1])).toBeNaN();
  });
});

describe('formatting', () => {
  it('formats measurements with units and typographic minus', () => {
    expect(formatMeasure('distance', 1.5432)).toBe('1.54 Å');
    expect(formatMeasure('distance', 1.5432, true)).toBe('1.543 Å');
    expect(formatMeasure('angle', 109.4712)).toBe('109.5°');
    expect(formatMeasure('dihedral', -60)).toBe('−60.0°');
    expect(formatMeasure('dihedral', -0.04)).toBe('0.0°');
    expect(formatMeasure('angle', NaN)).toBe('—');
    expect(formatSigned(-1.239, 2)).toBe('−1.24');
    expect(geometryEditLabel('angle', 109.47)).toBe('Set angle to 109.5°');
  });

  it('maps atom counts to kinds', () => {
    expect([1, 2, 3, 4, 5].map(kindForCount)).toEqual([null, 'distance', 'angle', 'dihedral', null]);
  });
});

describe('geometryModel', () => {
  it('describes a bonded pair with ideal length and deviation', () => {
    const m = butaneLike();
    const g = geometryModel(m, [2, 3])!;
    expect(g.kind).toBe('distance');
    expect(g.value).toBeCloseTo(1.54, 6);
    expect(g.unit).toBe('Å');
    expect([g.min, g.max]).toEqual([0.5, 10]);
    expect(g.editable).toBe(true);
    const ideal = idealBondLength('C', 'C', 1);
    expect(g.bond!.ideal).toBeCloseTo(ideal, 9);
    expect(g.bond!.deviation).toBeCloseTo(1.54 - ideal, 9);
    expect(g.presets.map((p) => p.label)).toEqual(['Ideal']);
    expect(g.note).toBe('Moves C3 and everything attached on its side.');
  });

  it('explains ring bonds and non-bonded pairs', () => {
    const m = butaneLike();
    mocks.isBondInRing.mockReturnValue(true);
    expect(geometryModel(m, [2, 3])!.note).toBe('Ring bond: only C3 moves.');
    const far = geometryModel(m, [1, 4])!;
    expect(far.bond).toBeUndefined();
    expect(far.note).toBe('Moves C4 only.');
  });

  it('keeps the slider range stable from the transient base', () => {
    const atoms: AtomInput[] = [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: 12.3, y: 0, z: 0 },
    ];
    const base = buildMolecule('far', atoms);
    const moved = buildMolecule('far', [atoms[0], { ...atoms[1], x: 4 }]);
    expect(geometryModel(base, [1, 2])!.max).toBe(13);
    expect(geometryModel(moved, [1, 2], base)!.max).toBe(13);
    expect(geometryModel(moved, [1, 2])!.max).toBe(10);
  });

  it('disables editing when atoms overlap', () => {
    const m = buildMolecule('dup', [
      { element: 'C', x: 1, y: 1, z: 1 },
      { element: 'C', x: 1, y: 1, z: 1 },
    ]);
    const g = geometryModel(m, [1, 2])!;
    expect(g.editable).toBe(false);
    expect(g.reason).toMatch(/overlap/);
  });

  it('uses the second selected atom as the angle vertex', () => {
    const w = water();
    const g = geometryModel(w, [2, 1, 3])!;
    expect(g.kind).toBe('angle');
    expect(g.value).toBeCloseTo(104.52, 6);
    expect([g.min, g.max]).toEqual([0, 180]);
    expect(g.presets[0].value).toBeCloseTo(109.4712, 4);
    expect(TETRAHEDRAL_ANGLE).toBeCloseTo(109.4712206, 6);
    expect(g.note).toBe('Rotates the H3 side about vertex O1.');
    // A different order measures a different angle (vertex = H2).
    expect(geometryModel(w, [1, 2, 3])!.value).toBeCloseTo((180 - 104.52) / 2, 6);
  });

  it('passes the dihedral feasibility check through', () => {
    const m = butaneLike(60);
    let g = geometryModel(m, [1, 2, 3, 4])!;
    expect(g.kind).toBe('dihedral');
    expect(g.value).toBeCloseTo(60, 6);
    expect([g.min, g.max]).toEqual([-180, 180]);
    expect(g.editable).toBe(true);
    expect(mocks.canSetDihedral).toHaveBeenCalledWith(m, 1, 2, 3, 4);
    mocks.canSetDihedral.mockReturnValue({ ok: false, reason: 'The C2–C3 bond is part of a ring' });
    g = geometryModel(m, [1, 2, 3, 4])!;
    expect(g.editable).toBe(false);
    expect(g.reason).toBe('The C2–C3 bond is part of a ring');
  });

  it('rejects other selections', () => {
    const m = butaneLike();
    expect(geometryModel(m, [1])).toBeNull();
    expect(geometryModel(m, [1, 2, 3, 4, 1])).toBeNull();
    expect(geometryModel(m, [1, 1])).toBeNull();
    expect(geometryModel(m, [1, 42])).toBeNull();
  });
});

describe('editing helpers', () => {
  it('dispatches to the matching edit operation', () => {
    const m = butaneLike();
    expect((applyGeometryValue(m, 'distance', [1, 2], 1.5) as Molecule & { tag?: string }).tag).toBe('distance');
    expect(mocks.setDistance).toHaveBeenLastCalledWith(m, 1, 2, 1.5);
    applyGeometryValue(m, 'angle', [1, 2, 3], 120);
    expect(mocks.setAngle).toHaveBeenLastCalledWith(m, 1, 2, 3, 120);
    applyGeometryValue(m, 'dihedral', [1, 2, 3, 4], -60);
    expect(mocks.setDihedral).toHaveBeenLastCalledWith(m, 1, 2, 3, 4, -60);
    expect(applyGeometryValue(m, 'angle', [1, 2], 120)).toBe(m);
  });

  it('detects pinned measurements in either direction', () => {
    const list = [{ id: 'm1', kind: 'angle' as const, atomIds: [1, 2, 3] }];
    expect(isPinned(list, 'angle', [1, 2, 3])).toBe(true);
    expect(isPinned(list, 'angle', [3, 2, 1])).toBe(true);
    expect(isPinned(list, 'angle', [2, 1, 3])).toBe(false);
    expect(isPinned(list, 'distance', [1, 2])).toBe(false);
  });

  it('grades bond-length deviations', () => {
    expect(deviationTone(0.02)).toBe('ok');
    expect(deviationTone(-0.1)).toBe('warn');
    expect(deviationTone(0.3)).toBe('error');
  });
});

describe('labels', () => {
  const protein = () =>
    buildMolecule('pep', [
      { element: 'N', name: 'N', resName: 'ALA', resSeq: 42, chain: 'A', x: 0, y: 0, z: 0 },
      { element: 'C', name: 'CA', resName: 'ALA', resSeq: 42, chain: 'A', x: 1.46, y: 0, z: 0 },
      { element: 'C', name: 'CA', resName: 'GLY', resSeq: 43, chain: 'A', x: 3, y: 1, z: 0 },
    ]);

  it('adds residue numbers only when atoms span residues', () => {
    const m = protein();
    expect(shortAtomLabels(m, [1, 2])).toEqual(['N', 'CA']);
    expect(shortAtomLabels(m, [2, 3])).toEqual(['CA 42', 'CA 43']);
  });

  it('compacts consecutive atoms of the same residue', () => {
    const m = protein();
    const full = (id: number) => `full${id}`;
    expect(compactAtomLabels(m, [1, 2, 3], full)).toBe('full1 – CA – full3');
  });
});

describe('ideal length of delocalised bonds', () => {
  it('compares a relaxed carboxylate C–O⁻ with the resonance length, not the single-bond length', async () => {
    const { moleculeFromSmiles } = await import('../../core/smiles');
    const { minimize } = await import('../../core/minimize');
    const mol = minimize(moleculeFromSmiles('CC(=O)[O-]'), { maxSteps: 500 }).mol;
    const oMinus = mol.atoms.find((a) => a.element === 'O' && a.charge === -1)!;
    const bond = mol.bonds.find((b) => b.a === oMinus.id || b.b === oMinus.id)!;
    const carbon = bond.a === oMinus.id ? bond.b : bond.a;
    const model = geometryModel(mol, [carbon, oMinus.id])!;
    expect(model.bond).toBeTruthy();
    expect(model.bond!.ideal).toBeLessThan(1.3); // ~1.255 Å, not 1.42 Å
    expect(Math.abs(model.bond!.deviation)).toBeLessThan(0.05);
  });
});
