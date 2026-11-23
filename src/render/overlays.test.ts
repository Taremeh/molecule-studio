import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { OverlayLayer, angleArc, measurementValue, type OverlayInput } from './overlays';
import { EMPTY_OVERLAY, type Vec3 } from '../core/types';
import { ethylene } from './testMolecules';

describe('angleArc', () => {
  it('draws an arc around the vertex between the two arms', () => {
    const a: Vec3 = [2, 0, 0];
    const b: Vec3 = [0, 0, 0];
    const c: Vec3 = [0, 3, 0];
    const { points, label } = angleArc(a, b, c, 8);
    expect(points.length).toBe(9);
    const r = Math.hypot(...points[0]);
    for (const p of points) expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(r, 9);
    expect(points[0][1]).toBeCloseTo(0, 9); // starts along BA
    expect(points[8][0]).toBeCloseTo(0, 9); // ends along BC
    // Label on the bisector.
    expect(label[0]).toBeCloseTo(label[1], 9);
    expect(label[0]).toBeGreaterThan(0);
  });
  it('skips the arc for straight angles', () => {
    expect(angleArc([1, 0, 0], [0, 0, 0], [-1, 0, 0]).points.length).toBe(0);
  });
});

describe('measurementValue', () => {
  it('computes distance / angle / dihedral (with fallback if core returns NaN)', () => {
    const mol = ethylene();
    const P = (i: number): Vec3 => [mol.atoms[i].x, mol.atoms[i].y, mol.atoms[i].z];
    const ids = (...ix: number[]) => ix.map((i) => mol.atoms[i].id);
    expect(measurementValue(mol, 'distance', ids(0, 1), [P(0), P(1)])).toBeCloseTo(1.33, 6);
    expect(measurementValue(mol, 'angle', ids(2, 0, 1), [P(2), P(0), P(1)])).toBeCloseTo(121.5, 4);
    // H–C=C–H cis dihedral in planar ethylene is 0°, trans is 180°.
    expect(Math.abs(measurementValue(mol, 'dihedral', ids(2, 0, 1, 4), [P(2), P(0), P(1), P(4)]))).toBeCloseTo(0, 4);
    expect(Math.abs(measurementValue(mol, 'dihedral', ids(2, 0, 1, 5), [P(2), P(0), P(1), P(5)]))).toBeCloseTo(180, 4);
  });
});

describe('OverlayLayer', () => {
  function input(partial: Partial<OverlayInput>): OverlayInput {
    return {
      mol: ethylene(),
      radiiVersion: 1,
      radiusOf: () => 0.4,
      isHidden: () => false,
      selection: new Set(),
      hovered: null,
      editOverlay: EMPTY_OVERLAY,
      measurements: [],
      pendingMeasure: [],
      measureKind: 'distance',
      mode: 'view',
      showValence: true,
      lightBackground: false,
      ...partial,
    };
  }
  const visibleMesh = (o: OverlayLayer, name: string) => {
    const m = o.group.getObjectByName(name) as THREE.InstancedMesh | undefined;
    return m && m.visible ? m.count : 0;
  };

  it('builds selection halos, hover and measurement labels incrementally', () => {
    const o = new OverlayLayer();
    const base = input({});
    const mol = base.mol!;
    o.sync(base);
    expect(visibleMesh(o, 'selection-halos')).toBe(0);

    const sel = new Set([mol.atoms[0].id, mol.atoms[1].id]);
    o.sync({ ...base, selection: sel });
    expect(visibleMesh(o, 'selection-halos')).toBe(2);
    const halo = o.group.getObjectByName('selection-halos') as THREE.InstancedMesh;
    expect(halo.instanceMatrix.array[0]).toBeCloseTo(Math.max(1.25 * 0.4, 0.4 + 0.12), 6); // ~1.25× display radius

    o.sync({ ...base, selection: sel, hovered: { kind: 'atom', atomId: mol.atoms[2].id, clientX: 0, clientY: 0 } });
    expect(visibleMesh(o, 'hover-atom')).toBe(1);

    o.sync({
      ...base,
      selection: sel,
      measurements: [{ id: 'm1', kind: 'distance', atomIds: [mol.atoms[0].id, mol.atoms[1].id] }],
    });
    expect(o.labelItems.length).toBe(1);
    expect(o.labelItems[0].text).toBe('1.33 Å');
    expect(o.labelItems[0].x).toBeCloseTo(0.665, 6);

    o.sync({
      ...base,
      editOverlay: {
        ...EMPTY_OVERLAY,
        ghostAtoms: [{ position: [3, 0, 0], element: 'O', valid: false }],
        ghostBonds: [
          { from: [1.33, 0, 0], to: [3, 0, 0], valid: true, order: 1, style: 'preview' },
          { from: [0, 0, 0], to: [3, 0, 0], valid: true, order: 1, style: 'suggest' },
        ],
        highlightAtoms: [{ atomId: mol.atoms[0].id, color: 'delete' }],
      },
    });
    expect(visibleMesh(o, 'ghost-atoms')).toBe(1);
    expect(visibleMesh(o, 'ghost-bonds')).toBe(1);
    expect(visibleMesh(o, 'highlight-atoms')).toBe(1);
    o.dispose();
  });

  it('ignores references to missing atoms', () => {
    const o = new OverlayLayer();
    o.sync(
      input({
        selection: new Set([999]),
        hovered: { kind: 'bond', bondId: 999, clientX: 0, clientY: 0 },
        measurements: [{ id: 'x', kind: 'angle', atomIds: [1, 2, 999] }],
        pendingMeasure: [999],
      }),
    );
    expect(visibleMesh(o, 'selection-halos')).toBe(0);
    expect(o.labelItems.length).toBe(0);
    o.sync(input({ mol: null }));
    o.dispose();
  });
});
