import { describe, expect, it } from 'vitest';
import { AtomRep, LINES_NOMINAL_RADIUS, changedAtomIndices, displayRadius, effectiveQuality } from './atoms';
import { LinesRep } from './lines';
import { getElement } from '../../core/elements';
import { DOUBLE_OFFSET, LICORICE_RADIUS } from '../bondLayout';
import { benzene, ethylene, moveAtom } from '../testMolecules';
import { srgbToLinear } from '../math3d';

const all = (n: number) => new Uint8Array(n).fill(1);
const grey = (n: number) => new Float32Array(n * 3).fill(0.5);

function translation(m: Float32Array, k: number): [number, number, number] {
  return [m[k * 16 + 12], m[k * 16 + 13], m[k * 16 + 14]];
}
function colY(m: Float32Array, k: number): [number, number, number] {
  return [m[k * 16 + 4], m[k * 16 + 5], m[k * 16 + 6]];
}

describe('displayRadius', () => {
  it('follows the documented style rules', () => {
    const c = getElement('C').vdwRadius;
    const h = getElement('H').vdwRadius;
    expect(displayRadius({ element: 'C' }, 'ball-and-stick')).toBeCloseTo(Math.max(0.18, 0.25 * c));
    expect(displayRadius({ element: 'H' }, 'ball-and-stick')).toBeCloseTo(Math.max(0.18, 0.2 * h));
    expect(displayRadius({ element: 'H' }, 'ball-and-stick')).toBeLessThan(displayRadius({ element: 'C' }, 'ball-and-stick'));
    expect(displayRadius({ element: 'C' }, 'spacefill', 1.5)).toBeCloseTo(1.5 * c);
    expect(displayRadius({ element: 'O' }, 'licorice', 2)).toBeCloseTo(2 * LICORICE_RADIUS);
    expect(displayRadius({ element: 'N' }, 'lines')).toBeCloseTo(LINES_NOMINAL_RADIUS);
    // Unknown elements fall back to a 2 Å vdW radius (or whatever 'X' defines) — never 0.
    expect(displayRadius({ element: 'Xx' }, 'spacefill')).toBeGreaterThan(0);
  });
});

describe('effectiveQuality', () => {
  it('reduces tessellation only for very large instance counts', () => {
    const tris = (q: 'low' | 'medium' | 'high') => ({ low: 100, medium: 500, high: 1300 })[q];
    expect(effectiveQuality('high', 1000, tris)).toBe('high');
    expect(effectiveQuality('high', 20_000, tris)).toBe('medium');
    expect(effectiveQuality('medium', 50_000, tris)).toBe('low');
    expect(effectiveQuality('low', 10_000_000, tris)).toBe('low');
  });
});

describe('AtomRep', () => {
  it('ball-and-stick: one sphere per atom at its position, sticks along bonds', () => {
    const mol = ethylene();
    const rep = new AtomRep(mol, all(6), grey(6), { style: 'ball-and-stick', quality: 'medium', scale: 1, opacity: 1 });
    const spheres = rep.object.getObjectByName('spheres') as import('three').InstancedMesh;
    const sticks = rep.object.getObjectByName('sticks') as import('three').InstancedMesh;
    expect(spheres.count).toBe(6);
    expect(sticks.count).toBe(12);
    const m = spheres.instanceMatrix.array as Float32Array;
    mol.atoms.forEach((a, k) => expect(translation(m, k)).toEqual([a.x, a.y, a.z].map((v) => Math.fround(v))));
    expect(m[0]).toBeCloseTo(displayRadius(mol.atoms[0], 'ball-and-stick'), 6);
    // Double-bond cylinders are offset in the molecular plane (z = 0), ±DOUBLE_OFFSET from the axis.
    const sm = sticks.instanceMatrix.array as Float32Array;
    const ys: number[] = [];
    for (let k = 0; k < 4; k++) {
      const t = translation(sm, k);
      expect(t[2]).toBeCloseTo(0, 6);
      ys.push(t[1]);
    }
    expect(Math.max(...ys)).toBeCloseTo(DOUBLE_OFFSET, 5);
    expect(Math.min(...ys)).toBeCloseTo(-DOUBLE_OFFSET, 5);
    // Half bonds: each covers half the C=C bond length along x.
    expect(colY(sm, 0)[0]).toBeCloseTo(1.33 / 2, 5);
    rep.dispose();
  });

  it('colours instances with linearised sRGB per atom', () => {
    const mol = ethylene();
    const colors = grey(6);
    colors.set([1, 0, 0], 0); // atom 0 red
    const rep = new AtomRep(mol, all(6), colors, { style: 'ball-and-stick', quality: 'low', scale: 1, opacity: 1 });
    const spheres = rep.object.getObjectByName('spheres') as import('three').InstancedMesh;
    const c = spheres.instanceColor!.array as Float32Array;
    expect(Array.from(c.slice(0, 3))).toEqual([1, 0, 0]);
    expect(c[3]).toBeCloseTo(srgbToLinear(0.5), 6);
    rep.dispose();
  });

  it('aromatic dashes point into the ring', () => {
    const mol = benzene();
    const rep = new AtomRep(mol, all(12), grey(12), { style: 'ball-and-stick', quality: 'low', scale: 1, opacity: 1 });
    const sticks = rep.object.getObjectByName('sticks') as import('three').InstancedMesh;
    const sm = sticks.instanceMatrix.array as Float32Array;
    // First ring bond C1–C2: sticks 0,1 = full bond halves, 2,3 = inner dashes.
    const a = mol.atoms[0];
    const b = mol.atoms[1];
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    for (const k of [2, 3]) {
      const t = translation(sm, k);
      const y = colY(sm, k);
      const c = [t[0] + y[0] / 2, t[1] + y[1] / 2];
      // Dash centre closer to the ring centre than the bond midpoint.
      expect(Math.hypot(c[0], c[1])).toBeLessThan(Math.hypot(mid[0], mid[1]) - 0.15);
    }
    rep.dispose();
  });

  it('partial coordinate updates equal a full rebuild', () => {
    const mol = benzene();
    const opts = { style: 'ball-and-stick' as const, quality: 'low' as const, scale: 1.1, opacity: 1 };
    const rep = new AtomRep(mol, all(12), grey(12), opts);
    const moved = moveAtom(mol, 1, 0.3, -0.2, 0.5);
    const changed = changedAtomIndices(mol, moved);
    expect(Array.from(changed)).toEqual([1]);
    const v0 = rep.version;
    rep.updateCoordinates(moved, changed);
    expect(rep.version).toBeGreaterThan(v0);
    const fresh = new AtomRep(moved, all(12), grey(12), opts);
    for (const name of ['spheres', 'sticks']) {
      const a = (rep.object.getObjectByName(name) as import('three').InstancedMesh).instanceMatrix.array as Float32Array;
      const b = (fresh.object.getObjectByName(name) as import('three').InstancedMesh).instanceMatrix.array as Float32Array;
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 5);
    }
    rep.dispose();
    fresh.dispose();
  });

  it('setScale rescales radii and pick data', () => {
    const mol = ethylene();
    const rep = new AtomRep(mol, all(6), grey(6), { style: 'spacefill', quality: 'low', scale: 1, opacity: 1 });
    const r0 = rep.radii[0];
    rep.setScale(0.5);
    expect(rep.radii[0]).toBeCloseTo(r0 / 2, 6);
    expect(rep.pickData().radii[0]).toBeCloseTo(r0 / 2, 6);
    expect(rep.object.getObjectByName('sticks')).toBeUndefined(); // spacefill: no bonds
    rep.dispose();
  });

  it('empty masks produce an empty, disposable representation', () => {
    const mol = ethylene();
    const rep = new AtomRep(mol, new Uint8Array(6), grey(6), { style: 'ball-and-stick', quality: 'low', scale: 1, opacity: 0.5 });
    expect(rep.atoms.length).toBe(0);
    expect(rep.object.children.length).toBe(0);
    rep.updateCoordinates(moveAtom(mol, 0, 1, 0, 0), null);
    rep.dispose();
  });
});

describe('LinesRep', () => {
  it('splits bonds at the midpoint and draws crosses for unbonded atoms', () => {
    const mol = ethylene();
    const mask = new Uint8Array([1, 1, 1, 0, 0, 0]);
    // Atom 2 (H) is bonded to C1 → a bond. Hide the others; then make C2 isolated by hiding...
    const rep = new LinesRep(mol, mask, grey(6), { scale: 1, opacity: 1 });
    const pos = (rep.object.geometry.getAttribute('position').array as Float32Array);
    // 2 bonds (C=C, C1–H) × 4 vertices, no crosses.
    expect(pos.length).toBe(2 * 4 * 3);
    expect(pos[3]).toBeCloseTo(1.33 / 2, 6); // midpoint of C=C
    const lone = new LinesRep(mol, new Uint8Array([1, 0, 0, 0, 0, 0]), grey(6), { scale: 1, opacity: 1 });
    expect((lone.object.geometry.getAttribute('position').array as Float32Array).length).toBe(6 * 3);
    const pd = lone.pickData();
    expect(pd.atoms.length).toBe(1);
    expect(pd.bonds.length).toBe(0);
    rep.dispose();
    lone.dispose();
  });

  it('partial updates equal a full rebuild', () => {
    const mol = benzene();
    const rep = new LinesRep(mol, all(12), grey(12), { scale: 1, opacity: 1 });
    const moved = moveAtom(mol, 3, 0.2, 0.1, -0.4);
    rep.updateCoordinates(moved, changedAtomIndices(mol, moved));
    const fresh = new LinesRep(moved, all(12), grey(12), { scale: 1, opacity: 1 });
    const a = rep.object.geometry.getAttribute('position').array as Float32Array;
    const b = fresh.object.geometry.getAttribute('position').array as Float32Array;
    expect(Array.from(a)).toEqual(Array.from(b));
    rep.dispose();
    fresh.dispose();
  });
});
