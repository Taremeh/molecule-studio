import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildMolecule, type AtomInput } from '../../core/molecule';
import { computeAtomColors, srgbToLinear } from '../colors';
import { buildSurface, clearSurfaceCache, surfaceInput } from './surface';
import { computeSurface, planGrid, type SurfaceMeshData } from './surface-core';

type P = [number, number, number];
const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function surface(centers: P[], radii: number[], probe = 1.4, spacing = 0.5): SurfaceMeshData {
  const m = computeSurface({ positions: new Float32Array(centers.flat()), radii: new Float32Array(radii), probeRadius: probe, spacing });
  expect(m).not.toBeNull();
  return m!;
}

/** Every undirected edge must be shared by an even number (normally 2) of triangles: no holes. */
function edgeUse(m: SurfaceMeshData) {
  const use = new Map<number, number>();
  const nv = m.atom.length;
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e];
      const b = m.indices[t + ((e + 1) % 3)];
      const key = Math.min(a, b) * nv + Math.max(a, b);
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return [...use.values()];
}

function checkMesh(m: SurfaceMeshData) {
  const nv = m.atom.length;
  expect(nv).toBeGreaterThan(0);
  expect(m.positions.length).toBe(nv * 3);
  expect(m.normals.length).toBe(nv * 3);
  for (const v of m.positions) expect(Number.isFinite(v)).toBe(true);
  for (let i = 0; i < nv; i++) expect(Math.hypot(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2])).toBeCloseTo(1, 4);
  for (const i of m.indices) expect(i).toBeLessThan(nv);
  const uses = edgeUse(m);
  expect(uses.every((u) => u % 2 === 0)).toBe(true);
}

/** Signed volume (divergence theorem); positive iff triangles are wound counter-clockwise seen from outside. */
function volume(m: SurfaceMeshData): number {
  const p = m.positions;
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/**
 * Exact distance from v to the exterior of a union of (≤ 3) SAS spheres: nearest accessible point among
 * radial projections, intersection circles and triple points. Used as ground truth for the SES.
 */
function exactDepth(v: number[], c: P[], R: number[]): number {
  const n = c.length;
  if (!c.some((ci, i) => dist(v, ci) < R[i])) return -Math.min(...c.map((ci, i) => dist(v, ci) - R[i]));
  const accessible = (q: number[], ex: number[]) => c.every((cj, j) => ex.includes(j) || dist(q, cj) >= R[j] - 1e-7);
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const d = dist(v, c[i]) || 1;
    const q = c[i].map((x, k) => x + ((v[k] - x) / d) * R[i]);
    if (accessible(q, [i])) best = Math.min(best, dist(q, v));
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist(c[i], c[j]);
      if (d >= R[i] + R[j]) continue;
      const u = [0, 1, 2].map((k) => (c[j][k] - c[i][k]) / d);
      const x0 = (d * d + R[i] ** 2 - R[j] ** 2) / (2 * d);
      const rho = Math.sqrt(R[i] ** 2 - x0 * x0);
      const cc = [0, 1, 2].map((k) => c[i][k] + u[k] * x0);
      let w = [0, 1, 2].map((k) => v[k] - cc[k]);
      const wu = w[0] * u[0] + w[1] * u[1] + w[2] * u[2];
      w = w.map((x, k) => x - wu * u[k]);
      const wl = Math.hypot(...w) || 1;
      const q = [0, 1, 2].map((k) => cc[k] + (w[k] / wl) * rho);
      if (accessible(q, [i, j])) best = Math.min(best, dist(q, v));
      for (let l = j + 1; l < n; l++) {
        const L = [0, 1, 2].map((k) => c[l][k] - c[i][k]);
        const ii = u[0] * L[0] + u[1] * L[1] + u[2] * L[2];
        let ey = L.map((x, k) => x - ii * u[k]);
        const eyl = Math.hypot(...ey);
        ey = ey.map((x) => x / eyl);
        const jj = ey[0] * L[0] + ey[1] * L[1] + ey[2] * L[2];
        const ez = [u[1] * ey[2] - u[2] * ey[1], u[2] * ey[0] - u[0] * ey[2], u[0] * ey[1] - u[1] * ey[0]];
        const Y = (R[i] ** 2 - R[l] ** 2 + ii * ii + jj * jj) / (2 * jj) - (ii / jj) * x0;
        const z2 = R[i] ** 2 - x0 * x0 - Y * Y;
        if (z2 < 0) continue;
        for (const s of [1, -1]) {
          const t = [0, 1, 2].map((k) => c[i][k] + x0 * u[k] + Y * ey[k] + s * Math.sqrt(z2) * ez[k]);
          if (accessible(t, [i, j, l])) best = Math.min(best, dist(t, v));
        }
      }
    }
  }
  return best;
}

describe('computeSurface (SES)', () => {
  it('reproduces a single atom as a sphere of its vdW radius', () => {
    const m = surface([[1, 2, 3]], [1.7]);
    checkMesh(m);
    for (let i = 0; i < m.atom.length; i++) {
      const v = [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
      expect(dist(v, [1, 2, 3])).toBeCloseTo(1.7, 3);
      // Normals point radially outwards.
      const n = [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]];
      expect((n[0] * (v[0] - 1) + n[1] * (v[1] - 2) + n[2] * (v[2] - 3)) / 1.7).toBeGreaterThan(0.99);
      expect(m.atom[i]).toBe(0);
    }
    expect(edgeUse(m).every((u) => u === 2)).toBe(true);
    // Inscribed polyhedron: slightly below the sphere volume 4/3·π·1.7³ = 20.58 Å³, and outward wound.
    const vol = volume(m);
    expect(vol).toBeGreaterThan(0.95 * 20.58);
    expect(vol).toBeLessThan(20.58);
  });

  it('builds a closed surface with the analytic re-entrant neck for two atoms', () => {
    const c: P[] = [[0, 0, 0], [3, 0, 0]];
    const m = surface(c, [1.7, 1.7], 1.4, 0.4);
    checkMesh(m);
    expect(edgeUse(m).every((u) => u === 2)).toBe(true);
    expect(volume(m)).toBeGreaterThan(0);
    // The probe (1.4 Å) rolling around the pair touches both atoms on a circle of radius
    // ρ = sqrt(3.1² − 1.5²) ≈ 2.713 Å in the mid plane, so the SES neck radius is ρ − 1.4 ≈ 1.313 Å
    // (vs 0.8 Å where the bare vdW spheres intersect).
    const neck: number[] = [];
    for (let i = 0; i < m.atom.length; i++) {
      if (Math.abs(m.positions[i * 3] - 1.5) < 0.1) neck.push(Math.hypot(m.positions[i * 3 + 1], m.positions[i * 3 + 2]));
    }
    expect(neck.length).toBeGreaterThan(4);
    const mean = neck.reduce((a, b) => a + b, 0) / neck.length;
    expect(mean).toBeGreaterThan(1.3);
    expect(mean).toBeLessThan(1.34);
    // Each half is colored by its own atom.
    for (let i = 0; i < m.atom.length; i++) {
      const x = m.positions[i * 3];
      if (x < 1.2) expect(m.atom[i]).toBe(0);
      if (x > 1.8) expect(m.atom[i]).toBe(1);
    }
  });

  it('matches the exact SES of three atoms (saddles and a concave triple patch)', () => {
    const c: P[] = [[0, 0, 0], [3.2, 0, 0], [1.6, 2.77, 0]];
    const r = [1.7, 1.55, 1.52];
    const R = r.map((x) => x + 1.4);
    for (const h of [0.8, 0.5]) {
      const m = surface(c, r, 1.4, h);
      checkMesh(m);
      let sum = 0;
      let max = 0;
      for (let i = 0; i < m.atom.length; i++) {
        const e = Math.abs(exactDepth([m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]], c, R) - 1.4);
        sum += e;
        max = Math.max(max, e);
      }
      expect(sum / m.atom.length).toBeLessThan(0.01);
      expect(max).toBeLessThan(0.1);
    }
  });

  it('gives the van der Waals surface for a zero probe radius', () => {
    const m = surface([[0, 0, 0], [3, 0, 0]], [1.7, 1.7], 0, 0.3);
    checkMesh(m);
    // Contact vertices lie on the vdW spheres.
    let onSphere = 0;
    for (let i = 0; i < m.atom.length; i++) {
      const v = [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
      if (Math.abs(Math.min(dist(v, [0, 0, 0]), dist(v, [3, 0, 0])) - 1.7) < 1e-3) onSphere++;
    }
    expect(onSphere / m.atom.length).toBeGreaterThan(0.9);
    // Union of two spheres, d = 3: V = 2·(4/3·π·r³) − lens, lens = π(4r + d)(2r − d)²/12 = 0.41 → 40.75 Å³.
    expect(volume(m)).toBeGreaterThan(0.97 * 40.75);
    expect(volume(m)).toBeLessThan(40.75);
  });

  it('coarsens the grid to respect the voxel cap', () => {
    const pos = new Float32Array([0, 0, 0, 200, 150, 100]);
    const radii = new Float32Array([1.7, 1.7]);
    const plan = planGrid(pos, radii, 1.4, 0.5, 1_000_000);
    expect(plan.dims[0] * plan.dims[1] * plan.dims[2]).toBeLessThanOrEqual(1_000_000);
    expect(plan.spacing).toBeGreaterThan(0.5);
    const fine = planGrid(new Float32Array([0, 0, 0]), new Float32Array([1.7]), 1.4, 0.5);
    expect(fine.spacing).toBe(0.5);
  });

  it('returns null for no atoms and when aborted', () => {
    expect(computeSurface({ positions: new Float32Array(0), radii: new Float32Array(0), probeRadius: 1.4, spacing: 0.8 })).toBeNull();
    expect(computeSurface({ positions: new Float32Array([0, 0, 0]), radii: new Float32Array([1.7]), probeRadius: 1.4, spacing: 0.8 }, () => true)).toBeNull();
  });
});

describe('buildSurface', () => {
  const water = (): AtomInput[] => [
    { element: 'O', x: 0, y: 0, z: 0.117, name: 'O', resName: 'HOH', resSeq: 1 },
    { element: 'H', x: 0, y: 0.757, z: -0.469, name: 'H1', resName: 'HOH', resSeq: 1 },
    { element: 'H', x: 0, y: -0.757, z: -0.469, name: 'H2', resName: 'HOH', resSeq: 1 },
  ];

  it('builds a colored mesh mapping vertices to masked atoms', async () => {
    clearSurfaceCache();
    const mol = buildMolecule('w', [...water(), { element: 'C', x: 10, y: 0, z: 0 }]);
    const mask = new Uint8Array([1, 1, 1, 0]);
    const colors = computeAtomColors(mol, 'element', '#ffffff');
    const obj = (await buildSurface(mol, mask, colors, { opacity: 1, quality: 'high', scale: 1 })) as THREE.Mesh;
    expect(obj).toBeInstanceOf(THREE.Mesh);
    const g = obj.geometry;
    const n = g.getAttribute('position').count;
    const vai = obj.userData.vertexAtomIndex as Int32Array;
    expect(vai.length).toBe(n);
    expect(new Set(vai)).toEqual(new Set([0, 1, 2])); // never the unmasked carbon
    const col = g.getAttribute('color');
    for (let i = 0; i < n; i++) {
      const a = vai[i];
      expect(col.getX(i)).toBeCloseTo(srgbToLinear(colors[a * 3]), 5);
      expect(col.getZ(i)).toBeCloseTo(srgbToLinear(colors[a * 3 + 2]), 5);
    }
    // All vertices are close to the water molecule (well away from the masked-out carbon).
    for (let i = 0; i < n; i++) expect(g.getAttribute('position').getX(i)).toBeLessThan(3);
    const mat = obj.material as THREE.MeshStandardMaterial;
    expect(mat.vertexColors).toBe(true);
    expect(mat.transparent).toBe(false);
  });

  it('honours opacity, scale and the probe radius', async () => {
    const mol = buildMolecule('c', [{ element: 'C', x: 0, y: 0, z: 0 }]);
    const colors = computeAtomColors(mol, 'uniform', '#ff0000');
    const mask = new Uint8Array([1]);
    const obj = (await buildSurface(mol, mask, colors, { opacity: 0.4, quality: 'medium', scale: 1.5 })) as THREE.Mesh;
    const mat = obj.material as THREE.MeshStandardMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.opacity).toBeCloseTo(0.4);
    const p = obj.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) expect(Math.hypot(p.getX(i), p.getY(i), p.getZ(i))).toBeCloseTo(1.7 * 1.5, 3);
    const prep = surfaceInput(mol, mask, { opacity: 1, quality: 'low', scale: 1, probeRadius: 0 })!;
    expect(prep.input.probeRadius).toBe(0);
    expect(prep.input.spacing).toBe(1.2);
    expect(prep.input.radii[0]).toBeCloseTo(1.7);
  });

  it('reuses the cached surface when only colors change', async () => {
    clearSurfaceCache();
    const mol = buildMolecule('w', water());
    const mask = new Uint8Array([1, 1, 1]);
    const a = (await buildSurface(mol, mask, computeAtomColors(mol, 'element', '#fff'), { opacity: 1, quality: 'medium', scale: 1 })) as THREE.Mesh;
    const b = (await buildSurface(mol, mask, computeAtomColors(mol, 'uniform', '#00ff00'), { opacity: 1, quality: 'medium', scale: 1 })) as THREE.Mesh;
    expect(b.geometry.getAttribute('position').array).toBe(a.geometry.getAttribute('position').array);
    expect(b.geometry.getAttribute('color').getY(0)).toBeCloseTo(1);
    // Moving an atom invalidates the cache.
    const moved = buildMolecule('w', water().map((x, i) => (i === 0 ? { ...x, x: 0.2 } : x)));
    const c = (await buildSurface(moved, mask, computeAtomColors(moved, 'element', '#fff'), { opacity: 1, quality: 'medium', scale: 1 })) as THREE.Mesh;
    expect(c.geometry.getAttribute('position').array).not.toBe(a.geometry.getAttribute('position').array);
  });

  it('resolves null for empty masks and aborted builds', async () => {
    const mol = buildMolecule('w', water());
    const colors = computeAtomColors(mol, 'element', '#fff');
    expect(await buildSurface(mol, new Uint8Array(3), colors, { opacity: 1, quality: 'low', scale: 1 })).toBeNull();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await buildSurface(mol, new Uint8Array([1, 1, 1]), colors, { opacity: 1, quality: 'low', scale: 1 }, ctrl.signal)).toBeNull();
  });

  it('handles a 50k-atom protein-sized system in a few seconds', async () => {
    clearSurfaceCache();
    // Jittered lattice at protein packing density (0.05 atoms/Å³) inside a bumpy sphere.
    let seed = 12345;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const atoms: AtomInput[] = [];
    const a = 2.71;
    const R0 = Math.cbrt((50000 * 3) / (4 * Math.PI * 0.05));
    const lim = Math.ceil((R0 * 1.2) / a);
    const elements = ['C', 'C', 'N', 'O', 'C', 'S'];
    for (let i = -lim; i <= lim; i++)
      for (let j = -lim; j <= lim; j++)
        for (let k = -lim; k <= lim; k++) {
          const x = i * a + (rnd() - 0.5) * 0.9, y = j * a + (rnd() - 0.5) * 0.9, z = k * a + (rnd() - 0.5) * 0.9;
          const r = Math.hypot(x, y, z) || 1e-6;
          if (r < R0 * (1 + 0.12 * Math.sin(3 * Math.atan2(y, x)) * Math.cos(4 * Math.acos(z / r)))) {
            atoms.push({ element: elements[Math.floor(rnd() * 6)], x, y, z });
          }
        }
    const mol = buildMolecule('blob', atoms);
    expect(mol.atoms.length).toBeGreaterThan(45000);
    const colors = computeAtomColors(mol, 'element', '#fff');
    const t0 = performance.now();
    const obj = (await buildSurface(mol, new Uint8Array(mol.atoms.length).fill(1), colors, { opacity: 1, quality: 'medium', scale: 1 })) as THREE.Mesh;
    const ms = performance.now() - t0;
    const verts = obj.geometry.getAttribute('position').count;
    console.log(`surface: ${mol.atoms.length} atoms → ${verts} vertices in ${ms.toFixed(0)} ms (spacing ${obj.userData.gridSpacing})`);
    expect(verts).toBeGreaterThan(10000);
    // ≈ 1.2 s on an idle laptop; the bound is loose so parallel CI load does not make the test flaky.
    expect(ms).toBeLessThan(20000);
  }, 60000);
});

describe('buildSurface worker path', () => {
  /** Minimal stand-in for a module Worker running surface.worker.ts's protocol asynchronously. */
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static mode: 'ok' | 'error' | 'never' = 'ok';
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: { message: string; preventDefault(): void }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminated = false;
    constructor(public url: URL, public opts: { type?: string }) {
      FakeWorker.instances.push(this);
    }
    postMessage(msg: { id: number; input: Parameters<typeof computeSurface>[0] }) {
      setTimeout(() => {
        if (this.terminated) return;
        if (FakeWorker.mode === 'error') this.onerror?.({ message: 'failed to load', preventDefault() {} });
        else if (FakeWorker.mode === 'ok') this.onmessage?.({ data: { id: msg.id, ok: true, mesh: computeSurface(msg.input) } });
      }, 1);
    }
    terminate() {
      this.terminated = true;
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    FakeWorker.instances = [];
    FakeWorker.mode = 'ok';
  });

  const mol = buildMolecule('c', [{ element: 'C', x: 0, y: 0, z: 0 }, { element: 'O', x: 1.2, y: 0, z: 0 }]);
  const mask = new Uint8Array([1, 1]);
  const colors = computeAtomColors(mol, 'element', '#fff');
  const opts = { opacity: 1, quality: 'medium' as const, scale: 1 };

  it('computes in a module worker and terminates it', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { buildSurface: build } = await import('./surface');
    const obj = (await build(mol, mask, colors, opts)) as THREE.Mesh;
    expect(obj).toBeInstanceOf(THREE.Mesh);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].opts.type).toBe('module');
    expect(String(FakeWorker.instances[0].url)).toMatch(/surface\.worker\.ts$/);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('terminates the worker and resolves null when aborted', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.mode = 'never';
    const { buildSurface: build } = await import('./surface');
    const ctrl = new AbortController();
    const p = build(mol, mask, colors, opts, ctrl.signal);
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    expect(await p).toBeNull();
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('falls back to the main thread when the worker cannot start', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.mode = 'error';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { buildSurface: build } = await import('./surface');
    const obj = await build(mol, mask, colors, opts);
    expect(obj).toBeInstanceOf(THREE.Mesh);
    expect(warn).toHaveBeenCalled();
    // Later builds skip the broken worker.
    await build(mol, mask, colors, { ...opts, quality: 'low' });
    expect(FakeWorker.instances).toHaveLength(1);
    warn.mockRestore();
  });
});
