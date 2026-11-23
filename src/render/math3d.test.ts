import { describe, expect, it } from 'vitest';
import {
  bondOffsetDirection,
  easeInOutCubic,
  fitDistance,
  hexLuminance,
  perpendicularUnit,
  rayCapsule,
  raySegmentClosest,
  raySphere,
  rayTriangle,
  srgbToLinear,
  v3,
  writeCylinderMatrix,
  writeSphereMatrix,
} from './math3d';

/** Apply a column-major 4×4 matrix to a point. */
function apply(m: Float32Array, o: number, x: number, y: number, z: number): [number, number, number] {
  return [
    m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12],
    m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13],
    m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14],
  ];
}

function det3(m: Float32Array, o: number): number {
  const a = [m[o], m[o + 1], m[o + 2]];
  const b = [m[o + 4], m[o + 5], m[o + 6]];
  const c = [m[o + 8], m[o + 9], m[o + 10]];
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

/** Deterministic PRNG for reproducible random tests. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('writeSphereMatrix', () => {
  it('scales uniformly and translates', () => {
    const m = new Float32Array(32);
    writeSphereMatrix(m, 16, 1, 2, 3, 0.5);
    expect(apply(m, 16, 0, 0, 0)).toEqual([1, 2, 3]);
    const p = apply(m, 16, 1, 0, 0);
    expect(p[0]).toBeCloseTo(1.5);
    expect(m[16 + 15]).toBe(1);
  });
});

describe('writeCylinderMatrix', () => {
  const cases: [number, number, number, number, number, number][] = [
    [0, 0, 0, 0, 1.5, 0],
    [1, 2, 3, 2.2, 2.1, 2.4],
    [0, 0, 0, 0, 0, -1.54], // along −Z
    [5, -3, 1, 5, -3, 4], // along +Z
    [0, 0, 0, -1, 0, 0], // along −X
    [0.3, 0.1, -2, 1.1, -0.9, -1.2],
  ];
  it.each(cases)('maps the unit cylinder onto the segment (%f,%f,%f)→(%f,%f,%f)', (x0, y0, z0, x1, y1, z1) => {
    const m = new Float32Array(16);
    const r = 0.12;
    writeCylinderMatrix(m, 0, x0, y0, z0, x1, y1, z1, r);
    const p0 = apply(m, 0, 0, 0, 0);
    const p1 = apply(m, 0, 0, 1, 0);
    [x0, y0, z0].forEach((v, i) => expect(p0[i]).toBeCloseTo(v, 5));
    [x1, y1, z1].forEach((v, i) => expect(p1[i]).toBeCloseTo(v, 5));
    // A point on the unit circle at y = 0.5 ends up at distance r from the axis, at the midpoint.
    const axis = [x1 - x0, y1 - y0, z1 - z0];
    const len = Math.hypot(axis[0], axis[1], axis[2]);
    for (const [cx, cz] of [
      [1, 0],
      [0, 1],
      [Math.SQRT1_2, -Math.SQRT1_2],
    ]) {
      const q = apply(m, 0, cx, 0.5, cz);
      const mid = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
      const d = [q[0] - mid[0], q[1] - mid[1], q[2] - mid[2]];
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(r, 5);
      // ⟂ to the axis
      expect((d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) / len).toBeCloseTo(0, 5);
    }
    // Orientation preserving (front faces stay front faces).
    expect(det3(m, 0)).toBeGreaterThan(0);
    // Columns orthogonal (three's instanced normal transform requires no shear).
    const c0 = [m[0], m[1], m[2]];
    const c1 = [m[4], m[5], m[6]];
    const c2 = [m[8], m[9], m[10]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(c0, c1)).toBeCloseTo(0, 6);
    expect(dot(c0, c2)).toBeCloseTo(0, 6);
    expect(dot(c1, c2)).toBeCloseTo(0, 6);
  });

  it('honours a reference perpendicular for the roll', () => {
    const m = new Float32Array(16);
    const ref = v3(0, 0, 1);
    writeCylinderMatrix(m, 0, 0, 0, 0, 1, 0, 0, 0.2, ref);
    [0, 0, 1].forEach((v, i) => expect(m[i] / 0.2).toBeCloseTo(v, 6));
    expect(det3(m, 0)).toBeGreaterThan(0);
  });

  it('writes an invisible matrix for degenerate segments', () => {
    const m = new Float32Array(16).fill(7);
    writeCylinderMatrix(m, 0, 1, 1, 1, 1, 1, 1, 0.1);
    expect(det3(m, 0)).toBe(0);
    expect(apply(m, 0, 0, 1, 0)).toEqual([1, 1, 1]);
  });
});

describe('perpendicularUnit', () => {
  it('returns unit vectors perpendicular to random axes', () => {
    const rand = rng(1);
    const out = v3();
    for (let k = 0; k < 200; k++) {
      let a = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
      const l = Math.hypot(a[0], a[1], a[2]);
      a = a.map((x) => x / l);
      perpendicularUnit(a[0], a[1], a[2], out);
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
      expect(out.x * a[0] + out.y * a[1] + out.z * a[2]).toBeCloseTo(0, 6);
    }
  });
});

describe('bondOffsetDirection', () => {
  it('points towards the reference atom, perpendicular to the bond', () => {
    // Ethylene-like: C1=C2 along x, H on C1 at 120° in the xy plane.
    const out = v3();
    bondOffsetDirection(0, 0, 0, 1.33, 0, 0, v3(-0.54, 0.93, 0), out);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(1, 6);
    expect(out.z).toBeCloseTo(0, 6);
  });

  it('is the same for a reference on either side of the bond', () => {
    const a = v3();
    const b = v3();
    bondOffsetDirection(0, 0, 0, 1.4, 0, 0, v3(-0.7, 1.2, 0.3), a);
    bondOffsetDirection(0, 0, 0, 1.4, 0, 0, v3(2.1, 1.2, 0.3), b);
    expect(a.y).toBeCloseTo(b.y, 6);
    expect(a.z).toBeCloseTo(b.z, 6);
  });

  it('falls back to an arbitrary perpendicular when collinear or missing', () => {
    const out = v3();
    bondOffsetDirection(0, 0, 0, 0, 0, 1.2, v3(0, 0, -1.1), out); // linear (e.g. CO2)
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
    expect(out.z).toBeCloseTo(0, 6);
    bondOffsetDirection(0, 0, 0, 0, 1, 0, null, out);
    expect(out.y).toBeCloseTo(0, 6);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
  });
});

describe('raySphere', () => {
  it('hits the front surface', () => {
    expect(raySphere(0, 0, 10, 0, 0, -1, 0, 0, 0, 1)).toBeCloseTo(9, 9);
    // Off-centre: hit at distance 10 − sqrt(1 − 0.6²) = 9.2
    expect(raySphere(0.6, 0, 10, 0, 0, -1, 0, 0, 0, 1)).toBeCloseTo(9.2, 9);
  });
  it('misses', () => {
    expect(raySphere(1.01, 0, 10, 0, 0, -1, 0, 0, 0, 1)).toBe(-1);
    expect(raySphere(0, 0, 10, 0, 0, 1, 0, 0, 0, 1)).toBe(-1); // behind the origin
    expect(raySphere(0, 0, 0.5, 0, 0, -1, 0, 0, 0, 1)).toBe(-1); // origin inside
  });
});

describe('rayCapsule', () => {
  it('hits the body, the caps and misses', () => {
    // Capsule along x from 0 to 2, r = 0.5; ray downwards from z = 5.
    expect(rayCapsule(1, 0, 5, 0, 0, -1, 0, 0, 0, 2, 0, 0, 0.5)).toBeCloseTo(4.5, 9);
    // Over the cap at B (x = 2.3): sphere at (2,0,0) r .5 → z = sqrt(.25 − .09) = 0.4
    expect(rayCapsule(2.3, 0, 5, 0, 0, -1, 0, 0, 0, 2, 0, 0, 0.5)).toBeCloseTo(5 - 0.4, 9);
    expect(rayCapsule(-0.3, 0, 5, 0, 0, -1, 0, 0, 0, 2, 0, 0, 0.5)).toBeCloseTo(5 - 0.4, 9);
    expect(rayCapsule(2.6, 0, 5, 0, 0, -1, 0, 0, 0, 2, 0, 0, 0.5)).toBe(-1);
    expect(rayCapsule(1, 0.51, 5, 0, 0, -1, 0, 0, 0, 2, 0, 0, 0.5)).toBe(-1);
  });
  it('handles rays parallel to the axis', () => {
    expect(rayCapsule(-5, 0.1, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 0.5)).toBeCloseTo(5 - Math.sqrt(0.25 - 0.01), 9);
    expect(rayCapsule(7, 0, 0, -1, 0, 0, 0, 0, 0, 2, 0, 0, 0.5)).toBeCloseTo(4.5, 9);
  });
  it('agrees with ray marching on random configurations', () => {
    const rand = rng(42);
    const inside = (p: number[], a: number[], b: number[], r: number) => {
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
      const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
      const s = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2));
      const c = [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s];
      return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) <= r;
    };
    let hits = 0;
    for (let k = 0; k < 300; k++) {
      const a = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
      const b = [a[0] + rand() * 2 - 1, a[1] + rand() * 2 - 1, a[2] + rand() * 2 - 1];
      const r = 0.1 + rand() * 0.4;
      const o = [rand() * 6 - 3, rand() * 6 - 3, 6];
      const target = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
      let d = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
      const dl = Math.hypot(d[0], d[1], d[2]);
      d = d.map((x) => x / dl);
      const t = rayCapsule(o[0], o[1], o[2], d[0], d[1], d[2], a[0], a[1], a[2], b[0], b[1], b[2], r);
      // March with a small step to find the first inside point.
      let tm = -1;
      for (let s = 0; s < 20; s += 0.002) {
        if (inside([o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s], a, b, r)) {
          tm = s;
          break;
        }
      }
      if (tm < 0) expect(t).toBe(-1);
      else {
        hits++;
        expect(Math.abs(t - tm)).toBeLessThan(0.0025);
      }
    }
    expect(hits).toBeGreaterThan(30);
  });
});

describe('rayTriangle', () => {
  it('hits inside and misses outside (double sided)', () => {
    const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0] as const;
    expect(rayTriangle(0.2, 0.2, 3, 0, 0, -1, ...tri)).toBeCloseTo(3, 9);
    expect(rayTriangle(0.2, 0.2, -3, 0, 0, 1, ...tri)).toBeCloseTo(3, 9);
    expect(rayTriangle(0.6, 0.6, 3, 0, 0, -1, ...tri)).toBe(-1);
    expect(rayTriangle(0.2, 0.2, 3, 0, 0, 1, ...tri)).toBe(-1);
  });
});

describe('raySegmentClosest', () => {
  it('finds the closest approach', () => {
    const out = v3();
    // Ray along −z through (0.5, 0.3); segment along x at z = 0.
    raySegmentClosest(0.5, 0.3, 4, 0, 0, -1, 0, 0, 0, 1, 0, 0, out);
    expect(out.x).toBeCloseTo(0.09, 9);
    expect(out.y).toBeCloseTo(4, 9);
    expect(out.z).toBeCloseTo(0.5, 9);
    // Beyond the segment end: closest point is the endpoint B.
    raySegmentClosest(2, 0, 4, 0, 0, -1, 0, 0, 0, 1, 0, 0, out);
    expect(out.x).toBeCloseTo(1, 9);
    expect(out.z).toBeCloseTo(1, 9);
  });
});

describe('misc', () => {
  it('srgbToLinear matches the standard transfer function', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 9);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 5);
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 9);
  });
  it('fitDistance frames a sphere', () => {
    // FOV 90° square viewport: the sphere is tangent to the frustum at d = r / sin(45°).
    expect(fitDistance(1, 90, 1, 1)).toBeCloseTo(Math.SQRT2, 9);
    // Narrow viewports are limited by the horizontal FOV.
    expect(fitDistance(1, 35, 0.5, 1)).toBeGreaterThan(fitDistance(1, 35, 1, 1));
  });
  it('easeInOutCubic is monotone from 0 to 1', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
  });
  it('hexLuminance', () => {
    expect(hexLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(hexLuminance('#000000')).toBe(0);
    expect(hexLuminance('#0b0f17')).toBeLessThan(0.05);
    expect(hexLuminance('#f5f7fb')).toBeGreaterThan(0.85);
  });
});
