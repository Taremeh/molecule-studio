import { describe, expect, it } from 'vitest';
import type { FragmentTemplate } from '../../core/templates';
import type { Vec3 } from '../../core/types';
import { rotateAround } from '../../core/geometry';
import { sketchFragment, symmetricEigen3 } from './fragmentSketch';

const matVec = (m: number[][], v: Vec3): Vec3 => [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]) as Vec3;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('symmetricEigen3', () => {
  it('sorts eigenvalues of a diagonal matrix', () => {
    const { values, vectors } = symmetricEigen3([
      [1, 0, 0],
      [0, 3, 0],
      [0, 0, 2],
    ]);
    expect(values).toEqual([3, 2, 1]);
    expect(Math.abs(vectors[0][1])).toBeCloseTo(1, 12);
    expect(Math.abs(vectors[1][2])).toBeCloseTo(1, 12);
  });

  it('diagonalises a general symmetric matrix', () => {
    const m = [
      [4, 1, -2],
      [1, 2, 0.5],
      [-2, 0.5, 3],
    ];
    const { values, vectors } = symmetricEigen3(m);
    // Trace and determinant are invariant.
    expect(values[0] + values[1] + values[2]).toBeCloseTo(9, 10);
    const det = 4 * (2 * 3 - 0.25) - 1 * (1 * 3 + 1) + -2 * (0.5 + 4);
    expect(values[0] * values[1] * values[2]).toBeCloseTo(det, 9);
    for (let i = 0; i < 3; i++) {
      const mv = matVec(m, vectors[i]);
      for (let k = 0; k < 3; k++) expect(mv[k]).toBeCloseTo(values[i] * vectors[i][k], 9);
      expect(dot(vectors[i], vectors[i])).toBeCloseTo(1, 12);
      for (let j = i + 1; j < 3; j++) expect(dot(vectors[i], vectors[j])).toBeCloseTo(0, 12);
    }
    expect(values[0]).toBeGreaterThanOrEqual(values[1]);
    expect(values[1]).toBeGreaterThanOrEqual(values[2]);
  });
});

/** Benzene (C–C 1.39 Å, C–H 1.09 Å) tilted arbitrarily in 3D; atom 0's hydrogen (index 6) is replaced. */
function tiltedPhenyl(): FragmentTemplate {
  const atoms: FragmentTemplate['atoms'] = [];
  const rot = (p: Vec3) => rotateAround(rotateAround(p, [0, 0, 0], [1, 0.3, 0], 37), [0, 0, 0], [0, 1, 1], -71);
  for (let i = 0; i < 6; i++) {
    const t = (i * Math.PI) / 3;
    const [x, y, z] = rot([1.39 * Math.cos(t), 1.39 * Math.sin(t), 0]);
    atoms.push({ element: 'C', x, y, z });
  }
  for (let i = 0; i < 6; i++) {
    const t = (i * Math.PI) / 3;
    const [x, y, z] = rot([2.48 * Math.cos(t), 2.48 * Math.sin(t), 0]);
    atoms.push({ element: 'H', x, y, z });
  }
  const bonds: FragmentTemplate['bonds'] = [];
  for (let i = 0; i < 6; i++) {
    bonds.push({ a: i, b: (i + 1) % 6, order: i % 2 === 0 ? 2 : 1 });
    bonds.push({ a: i, b: i + 6, order: 1 });
  }
  return { id: 'ph', name: 'Phenyl', label: 'Ph', category: 'ring', atoms, bonds, attachAtom: 0, attachHydrogen: 6 };
}

describe('sketchFragment', () => {
  it('draws a tilted ring as a regular hexagon with the attachment pointing left', () => {
    const s = sketchFragment(tiltedPhenyl(), 44, 30, 4);
    expect(s.text).toBeUndefined();
    expect(s.atoms).toHaveLength(6);
    expect(s.atoms.every((a) => a.label === undefined)).toBe(true);
    const cx = s.atoms.reduce((t, a) => t + a.x, 0) / 6;
    const cy = s.atoms.reduce((t, a) => t + a.y, 0) / 6;
    const radii = s.atoms.map((a) => Math.hypot(a.x - cx, a.y - cy));
    for (const r of radii) expect(r).toBeCloseTo(radii[0], 6);
    for (const a of s.atoms) {
      expect(a.x).toBeGreaterThanOrEqual(4 - 1e-9);
      expect(a.x).toBeLessThanOrEqual(40 + 1e-9);
      expect(a.y).toBeGreaterThanOrEqual(4 - 1e-9);
      expect(a.y).toBeLessThanOrEqual(26 + 1e-9);
    }
    // Only heavy-atom bonds are drawn; double bonds get their second line on the ring side.
    expect(s.bonds).toHaveLength(6);
    for (const b of s.bonds.filter((b) => b.order === 2)) {
      expect(b.inner).toBe(true);
      const mx = (b.x1 + b.x2) / 2;
      const my = (b.y1 + b.y2) / 2;
      expect((cx - mx) * b.nx + (cy - my) * b.ny).toBeGreaterThan(0);
    }
    // Attachment stub starts at the attach atom and points to the left.
    expect(s.stub).toBeDefined();
    expect(s.stub!.x1).toBeCloseTo(s.atoms[0].x, 9);
    expect(s.stub!.y1).toBeCloseTo(s.atoms[0].y, 9);
    expect(s.stub!.x2).toBeLessThan(s.stub!.x1);
    expect(s.stub!.y2).toBeCloseTo(s.stub!.y1, 9);
  });

  it('labels heteroatoms with their hydrogens', () => {
    const carboxyl: FragmentTemplate = {
      id: 'cooh',
      name: 'Carboxyl',
      label: 'COOH',
      category: 'group',
      atoms: [
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'O', x: 0.6, y: 1.05, z: 0 },
        { element: 'O', x: 0.68, y: -1.15, z: 0 },
        { element: 'H', x: 1.63, y: -1.05, z: 0 },
        { element: 'H', x: -1.1, y: 0, z: 0 },
      ],
      bonds: [
        { a: 0, b: 1, order: 2 },
        { a: 0, b: 2, order: 1 },
        { a: 2, b: 3, order: 1 },
        { a: 0, b: 4, order: 1 },
      ],
      attachAtom: 0,
      attachHydrogen: 4,
    };
    const s = sketchFragment(carboxyl);
    expect(s.atoms.map((a) => a.label)).toEqual([undefined, 'O', 'OH']);
    expect(s.bonds).toHaveLength(2);
  });

  it('uses the text label for single-heavy-atom groups', () => {
    const methyl: FragmentTemplate = {
      id: 'me',
      name: 'Methyl',
      label: 'CH₃',
      category: 'group',
      atoms: [
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'H', x: 1.09, y: 0, z: 0 },
      ],
      bonds: [{ a: 0, b: 1, order: 1 }],
      attachAtom: 0,
      attachHydrogen: 1,
    };
    const s = sketchFragment(methyl);
    expect(s.text).toBe('CH₃');
    expect(s.atoms).toEqual([]);
  });
});
