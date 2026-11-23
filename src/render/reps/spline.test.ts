import { describe, expect, it } from 'vitest';
import { anyPerpendicular, catmullRom, orthonormalize, rotationMinimizingFrames, smoothstep, smoothstepDeriv } from './spline';

describe('catmullRom', () => {
  const pts = new Float64Array([0, 0, 0, 1, 2, 0, 3, 3, 1, 4, 1, 2, 6, 0, 2]);
  const n = 5;

  it('interpolates the control points', () => {
    const out = new Float64Array(3);
    for (let k = 0; k < n - 1; k++) {
      catmullRom(pts, n, k, 0, out, 0);
      expect([...out]).toEqual([pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]]);
      catmullRom(pts, n, k, 1, out, 0);
      for (let c = 0; c < 3; c++) expect(out[c]).toBeCloseTo(pts[(k + 1) * 3 + c], 12);
    }
  });

  it('has the analytic derivative and is C¹ across intervals', () => {
    const a = new Float64Array(3), b = new Float64Array(3), d = new Float64Array(3);
    const eps = 1e-6;
    for (let k = 0; k < n - 1; k++) {
      for (const u of [0.1, 0.5, 0.9]) {
        catmullRom(pts, n, k, u, a, 0, d, 0);
        catmullRom(pts, n, k, u + eps, b, 0);
        for (let c = 0; c < 3; c++) expect((b[c] - a[c]) / eps).toBeCloseTo(d[c], 4);
      }
    }
    // Tangent at a shared control point is (p[k+1] − p[k−1]) / 2 from both sides.
    const d0 = new Float64Array(3), d1 = new Float64Array(3);
    catmullRom(pts, n, 1, 1, a, 0, d0, 0);
    catmullRom(pts, n, 2, 0, a, 0, d1, 0);
    for (let c = 0; c < 3; c++) {
      expect(d0[c]).toBeCloseTo(d1[c], 12);
      expect(d1[c]).toBeCloseTo((pts[9 + c] - pts[3 + c]) / 2, 12);
    }
  });

  it('is a straight line for two points', () => {
    const two = new Float64Array([0, 0, 0, 2, 4, 6]);
    const out = new Float64Array(3);
    catmullRom(two, 2, 0, 0.25, out, 0);
    expect([...out].map((v) => +v.toFixed(12))).toEqual([0.5, 1, 1.5]);
  });
});

describe('smoothstep', () => {
  it('goes 0 → 1 with zero end slopes', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstepDeriv(0)).toBe(0);
    expect(smoothstepDeriv(1)).toBe(0);
    expect(smoothstepDeriv(0.5)).toBeCloseTo(1.5);
  });
});

describe('frames', () => {
  it('orthonormalizes against a tangent', () => {
    const v = new Float64Array([1, 1, 0]);
    const t = new Float64Array([1, 0, 0]);
    expect(orthonormalize(v, 0, t, 0)).toBeCloseTo(1);
    expect([...v]).toEqual([0, 1, 0]);
    const p = new Float64Array(3);
    anyPerpendicular(new Float64Array([0, 0, 1]), 0, p, 0);
    expect(Math.hypot(...p)).toBeCloseTo(1);
    expect(p[2]).toBeCloseTo(0);
  });

  it('builds twist-free frames along a helix', () => {
    const m = 200;
    const pos = new Float64Array(m * 3);
    const tan = new Float64Array(m * 3);
    for (let i = 0; i < m; i++) {
      const t = i * 0.05;
      pos.set([3 * Math.cos(t), 3 * Math.sin(t), 0.5 * t], i * 3);
      const d = [-3 * Math.sin(t), 3 * Math.cos(t), 0.5];
      const l = Math.hypot(...d);
      tan.set(d.map((x) => x / l), i * 3);
    }
    const ref = new Float64Array(m * 3);
    anyPerpendicular(tan, 0, ref, 0);
    rotationMinimizingFrames(pos, tan, m, ref);
    for (let i = 0; i < m; i++) {
      const o = i * 3;
      expect(Math.hypot(ref[o], ref[o + 1], ref[o + 2])).toBeCloseTo(1, 9);
      expect(ref[o] * tan[o] + ref[o + 1] * tan[o + 1] + ref[o + 2] * tan[o + 2]).toBeCloseTo(0, 9);
      if (i > 0) {
        // Consecutive frames rotate only slightly (no flips).
        const dot = ref[o] * ref[o - 3] + ref[o + 1] * ref[o - 2] + ref[o + 2] * ref[o - 1];
        expect(dot).toBeGreaterThan(0.99);
      }
    }
  });
});
