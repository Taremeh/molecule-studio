import { describe, expect, it } from 'vitest';
import { UniformGrid } from './pickingGrid';
import { rayCapsule, raySphere } from './math3d';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Scene {
  n: number;
  pos: Float64Array; // centers (spheres) or endpoints (capsules use pos + pos2)
  pos2: Float64Array;
  r: Float64Array;
  capsule: Uint8Array;
}

function randomScene(n: number, seed: number, extent = 30): Scene {
  const rand = rng(seed);
  const s: Scene = { n, pos: new Float64Array(n * 3), pos2: new Float64Array(n * 3), r: new Float64Array(n), capsule: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) s.pos[i * 3 + k] = (rand() - 0.5) * extent;
    s.capsule[i] = rand() < 0.5 ? 1 : 0;
    for (let k = 0; k < 3; k++) s.pos2[i * 3 + k] = s.pos[i * 3 + k] + (rand() - 0.5) * 3;
    s.r[i] = 0.1 + rand() * 0.6;
  }
  return s;
}

function boxes(s: Scene): Float32Array {
  const b = new Float32Array(s.n * 6);
  for (let i = 0; i < s.n; i++) {
    for (let k = 0; k < 3; k++) {
      const a = s.pos[i * 3 + k];
      const c = s.capsule[i] ? s.pos2[i * 3 + k] : a;
      b[i * 6 + k] = Math.min(a, c) - s.r[i];
      b[i * 6 + 3 + k] = Math.max(a, c) + s.r[i];
    }
  }
  return b;
}

function test(s: Scene, o: number[], d: number[]) {
  return (i: number) => {
    const p = s.pos;
    if (s.capsule[i]) {
      const q = s.pos2;
      return rayCapsule(o[0], o[1], o[2], d[0], d[1], d[2], p[i * 3], p[i * 3 + 1], p[i * 3 + 2], q[i * 3], q[i * 3 + 1], q[i * 3 + 2], s.r[i]);
    }
    return raySphere(o[0], o[1], o[2], d[0], d[1], d[2], p[i * 3], p[i * 3 + 1], p[i * 3 + 2], s.r[i]);
  };
}

function bruteForce(s: Scene, o: number[], d: number[]) {
  const f = test(s, o, d);
  let best = Infinity;
  let item = -1;
  for (let i = 0; i < s.n; i++) {
    const t = f(i);
    if (t > 0 && t < best) {
      best = t;
      item = i;
    }
  }
  return { item, t: best };
}

function randomRay(rand: () => number, extent: number, inside: boolean) {
  const o = inside
    ? [(rand() - 0.5) * extent, (rand() - 0.5) * extent, (rand() - 0.5) * extent]
    : [(rand() - 0.5) * extent * 3, (rand() - 0.5) * extent * 3, extent * 2 * (rand() < 0.5 ? 1 : -1)];
  const target = [(rand() - 0.5) * extent * 0.8, (rand() - 0.5) * extent * 0.8, (rand() - 0.5) * extent * 0.8];
  const d = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return { o, d: d.map((x) => x / l) };
}

describe('UniformGrid.raycast', () => {
  it('matches brute force on random spheres and capsules', () => {
    const s = randomScene(3000, 7);
    const grid = new UniformGrid(boxes(s), s.n);
    const rand = rng(99);
    let hits = 0;
    for (let k = 0; k < 400; k++) {
      const { o, d } = randomRay(rand, 30, k % 3 === 0);
      const g = grid.raycast(o[0], o[1], o[2], d[0], d[1], d[2], test(s, o, d));
      const b = bruteForce(s, o, d);
      expect(g.item).toBe(b.item);
      if (b.item >= 0) {
        hits++;
        expect(g.t).toBeCloseTo(b.t, 9);
      }
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('handles axis-aligned rays (zero direction components)', () => {
    const s = randomScene(2000, 3, 20);
    const grid = new UniformGrid(boxes(s), s.n);
    const rand = rng(5);
    const dirs = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (let k = 0; k < 120; k++) {
      const d = dirs[k % dirs.length];
      const o = [(rand() - 0.5) * 20, (rand() - 0.5) * 20, (rand() - 0.5) * 20].map((v, i) => (d[i] !== 0 ? -d[i] * 40 : v));
      const g = grid.raycast(o[0], o[1], o[2], d[0], d[1], d[2], test(s, o, d));
      const b = bruteForce(s, o, d);
      expect(g.item).toBe(b.item);
    }
  });

  it('works for empty, single-item and huge-extent sets', () => {
    const empty = new UniformGrid(new Float32Array(0), 0);
    expect(empty.raycast(0, 0, 5, 0, 0, -1, () => 1).item).toBe(-1);

    const one = new UniformGrid(new Float32Array([-1, -1, -1, 1, 1, 1]), 1);
    expect(one.raycast(0, 0, 5, 0, 0, -1, () => 4).item).toBe(0);
    expect(one.raycast(0, 0, 5, 0, 0, 1, () => -1).item).toBe(-1);

    // Two clusters very far apart: cell cap keeps memory bounded.
    const far = new UniformGrid(new Float32Array([0, 0, 0, 1, 1, 1, 1e5, 1e5, 1e5, 1e5 + 1, 1e5 + 1, 1e5 + 1]), 2);
    expect(far.nx * far.ny * far.nz).toBeLessThanOrEqual(2_000_000);
    expect(far.raycast(0.5, 0.5, 10, 0, 0, -1, (i) => (i === 0 ? 9 : -1)).item).toBe(0);
  });

  it('tests every item at most once per query', () => {
    const s = randomScene(500, 11, 10);
    const grid = new UniformGrid(boxes(s), s.n);
    const seen = new Map<number, number>();
    const o = [0, 0, 30];
    const d = [0.01, 0.02, -1];
    const l = Math.hypot(d[0], d[1], d[2]);
    const dn = d.map((x) => x / l);
    const f = test(s, o, dn);
    grid.raycast(o[0], o[1], o[2], dn[0], dn[1], dn[2], (i) => {
      seen.set(i, (seen.get(i) ?? 0) + 1);
      return f(i);
    });
    for (const c of seen.values()) expect(c).toBe(1);
  });

  it('is fast for a protein-sized set (50k spheres)', () => {
    // ~50k atoms at protein density (≈ 0.1 atoms/Å³) in a 80 Å box.
    const n = 50_000;
    const rand = rng(123);
    const s: Scene = { n, pos: new Float64Array(n * 3), pos2: new Float64Array(n * 3), r: new Float64Array(n).fill(0.4), capsule: new Uint8Array(n) };
    for (let i = 0; i < n * 3; i++) s.pos[i] = (rand() - 0.5) * 80;
    const t0 = performance.now();
    const grid = new UniformGrid(boxes(s), n);
    const build = performance.now() - t0;
    const queries = 300;
    const t1 = performance.now();
    for (let k = 0; k < queries; k++) {
      const { o, d } = randomRay(rand, 80, false);
      grid.raycast(o[0], o[1], o[2], d[0], d[1], d[2], test(s, o, d));
    }
    const perPick = (performance.now() - t1) / queries;
    expect(build).toBeLessThan(500);
    expect(perPick).toBeLessThan(4);
  });
});
