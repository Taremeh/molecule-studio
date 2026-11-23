/**
 * Molecular surface geometry.
 * OWNER: advanced-render agent. CONTRACT: keep exported names & signatures.
 *
 * Approach: Gaussian density (or SES-like distance field with probe radius 1.4 Å) on a grid around
 * the selected atoms (grid spacing: low 1.2 Å, medium 0.8 Å, high 0.5 Å; cap total voxels ~ 8M by
 * increasing spacing), then extract the isosurface (marching cubes — three's
 * `three/examples/jsm/objects/MarchingCubes.js` exports `edgeTable` and `triTable` — or surface nets),
 * compute smooth normals, color vertices by the nearest atom's color (spatial grid lookup).
 * Run the heavy part in a Web Worker (e.g. `new Worker(new URL('./surface.worker.ts', import.meta.url), { type: 'module' })`)
 * so the UI stays responsive for large proteins; fall back to the main thread if workers are unavailable.
 * Each vertex maps to its nearest atom index: expose `object.userData.vertexAtomIndex: Int32Array`.
 *
 * Implementation: solvent-excluded surface (exact SAS probe positions + distance field, surface nets) —
 * see surface-core.ts. Atom radii are van der Waals radii × rep.scale. Results are cached by input
 * (coordinates, radii, probe, spacing), so recoloring or toggling a layer does not recompute the surface.
 */
import * as THREE from 'three';
import type { Molecule } from '../../core/types';
import { getElement } from '../../core/elements';
import { srgbToLinear } from '../colors';
import { computeSurface, DEFAULT_MAX_VOXELS, type SurfaceInput, type SurfaceMeshData, type SurfaceWorkerResponse } from './surface-core';

export interface SurfaceOptions {
  opacity: number;
  quality: 'low' | 'medium' | 'high';
  /** rep.scale — atom radius used for the surface is vdwRadius × scale (0.5..2). */
  scale: number;
  /** Probe radius for SES-like surfaces (default 1.4 Å). */
  probeRadius?: number;
}

/** Grid spacing per quality level (Å). */
export const SURFACE_SPACING = { low: 1.2, medium: 0.8, high: 0.5 } as const;
export const DEFAULT_PROBE_RADIUS = 1.4;

// ---------------------------------------------------------------------------
// Result cache (small LRU keyed by a hash of the inputs)
// ---------------------------------------------------------------------------

const CACHE_SIZE = 4;
const meshCache = new Map<string, SurfaceMeshData>();

function hashInput(input: SurfaceInput): string {
  // FNV-1a over the raw float bits of coordinates and radii.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ input.radii.length;
  const mix = (arr: Float32Array) => {
    const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
    for (let i = 0; i < u.length; i++) {
      h1 = Math.imul(h1 ^ u[i], 0x01000193);
      h2 = Math.imul(h2 ^ (u[i] >>> 7) ^ i, 0x5bd1e995);
    }
  };
  mix(input.positions);
  mix(input.radii);
  return `${input.radii.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}:${input.probeRadius}:${input.spacing}:${input.maxVoxels ?? ''}`;
}

function cacheGet(key: string): SurfaceMeshData | undefined {
  const v = meshCache.get(key);
  if (v) {
    meshCache.delete(key);
    meshCache.set(key, v);
  }
  return v;
}

function cachePut(key: string, v: SurfaceMeshData) {
  meshCache.delete(key);
  meshCache.set(key, v);
  while (meshCache.size > CACHE_SIZE) meshCache.delete(meshCache.keys().next().value as string);
}

/** Drop cached surfaces (e.g. to free memory). */
export function clearSurfaceCache(): void {
  meshCache.clear();
}

// ---------------------------------------------------------------------------
// Computation (worker with main-thread fallback)
// ---------------------------------------------------------------------------

let workerUnavailable = false;
let requestId = 0;

type WorkerOutcome =
  | { kind: 'done'; mesh: SurfaceMeshData | null }
  | { kind: 'aborted' }
  /** The worker could not start or crashed. */
  | { kind: 'failed'; error: string }
  /** The computation itself threw inside the worker. */
  | { kind: 'error'; error: string };

function runInWorker(input: SurfaceInput, signal?: AbortSignal): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./surface.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      resolve({ kind: 'failed', error: String(e) });
      return;
    }
    const id = ++requestId;
    let settled = false;
    const finish = (outcome: WorkerOutcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: 'aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (ev: MessageEvent<SurfaceWorkerResponse>) => {
      const r = ev.data;
      if (r.id !== id) return;
      finish(r.ok ? { kind: 'done', mesh: r.mesh } : { kind: 'error', error: r.error });
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      finish({ kind: 'failed', error: ev.message || 'worker error' });
    };
    worker.onmessageerror = () => finish({ kind: 'failed', error: 'message error' });
    // Inputs are structured-cloned (not transferred) so the main thread can still fall back on them.
    worker.postMessage({ id, input });
  });
}

async function compute(input: SurfaceInput, signal?: AbortSignal): Promise<SurfaceMeshData | null> {
  if (typeof Worker !== 'undefined' && !workerUnavailable) {
    const r = await runInWorker(input, signal);
    if (r.kind === 'done') return r.mesh;
    if (r.kind === 'aborted') return null;
    if (r.kind === 'error') throw new Error(r.error);
    // Worker could not start or crashed: remember (startup failures are permanent) and compute here.
    console.warn('[surface] worker failed, computing on the main thread:', r.error);
    workerUnavailable = true;
  }
  if (signal?.aborted) return null;
  // Let pending UI work run before blocking the main thread.
  if (typeof window !== 'undefined') await new Promise((r) => setTimeout(r, 0));
  if (signal?.aborted) return null;
  return computeSurface(input, () => signal?.aborted === true);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Gather the masked atoms into the compact surface input. */
export function surfaceInput(mol: Molecule, mask: Uint8Array, opts: SurfaceOptions): { input: SurfaceInput; atomIndices: Int32Array } | null {
  const n = mol.atoms.length;
  const usable = (i: number) => {
    const a = mol.atoms[i];
    return mask[i] && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
  };
  let m = 0;
  for (let i = 0; i < n; i++) if (usable(i)) m++;
  if (m === 0) return null;
  const atomIndices = new Int32Array(m);
  const positions = new Float32Array(m * 3);
  const radii = new Float32Array(m);
  const scale = opts.scale > 0 && Number.isFinite(opts.scale) ? opts.scale : 1;
  const radiusCache = new Map<string, number>();
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (!usable(i)) continue;
    const a = mol.atoms[i];
    let r = radiusCache.get(a.element);
    if (r === undefined) {
      const v = getElement(a.element).vdwRadius;
      r = v > 0 && Number.isFinite(v) ? v : 2.0;
      radiusCache.set(a.element, r);
    }
    atomIndices[k] = i;
    positions[k * 3] = a.x;
    positions[k * 3 + 1] = a.y;
    positions[k * 3 + 2] = a.z;
    radii[k] = r * scale;
    k++;
  }
  const probe = opts.probeRadius ?? DEFAULT_PROBE_RADIUS;
  return {
    input: {
      positions,
      radii,
      probeRadius: probe >= 0 && Number.isFinite(probe) ? probe : DEFAULT_PROBE_RADIUS,
      spacing: SURFACE_SPACING[opts.quality] ?? SURFACE_SPACING.medium,
      maxVoxels: DEFAULT_MAX_VOXELS,
    },
    atomIndices,
  };
}

function makeMesh(data: SurfaceMeshData, atomIndices: Int32Array, colors: Float32Array, opts: SurfaceOptions): THREE.Mesh {
  const vCount = data.atom.length;
  // Linear-sRGB color per masked atom, then per vertex.
  const m = atomIndices.length;
  const atomLin = new Float32Array(m * 3);
  for (let k = 0; k < m; k++) {
    const g = atomIndices[k];
    atomLin[k * 3] = srgbToLinear(colors[g * 3] ?? 0.7);
    atomLin[k * 3 + 1] = srgbToLinear(colors[g * 3 + 1] ?? 0.7);
    atomLin[k * 3 + 2] = srgbToLinear(colors[g * 3 + 2] ?? 0.7);
  }
  const vcolors = new Float32Array(vCount * 3);
  const vertexAtomIndex = new Int32Array(vCount);
  for (let v = 0; v < vCount; v++) {
    const local = data.atom[v];
    vertexAtomIndex[v] = atomIndices[local];
    vcolors[v * 3] = atomLin[local * 3];
    vcolors[v * 3 + 1] = atomLin[local * 3 + 1];
    vcolors[v * 3 + 2] = atomLin[local * 3 + 2];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(vcolors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const opacity = Math.max(0, Math.min(1, opts.opacity));
  const transparent = opacity < 1;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0,
    side: THREE.FrontSide,
    transparent,
    opacity,
    depthWrite: !transparent,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'surface';
  mesh.userData.vertexAtomIndex = vertexAtomIndex;
  mesh.userData.kind = 'surface';
  mesh.userData.gridSpacing = data.spacing;
  return mesh;
}

/**
 * Asynchronously build a surface. Must not throw for empty masks (resolve null).
 * Pass an AbortSignal: if aborted, resolve null as soon as possible (a newer build superseded it).
 */
export async function buildSurface(
  mol: Molecule,
  mask: Uint8Array,
  colors: Float32Array,
  opts: SurfaceOptions,
  signal?: AbortSignal,
): Promise<THREE.Object3D | null> {
  if (signal?.aborted) return null;
  const prepared = surfaceInput(mol, mask, opts);
  if (!prepared) return null;
  const key = hashInput(prepared.input);
  let data: SurfaceMeshData | null | undefined = cacheGet(key);
  if (!data) {
    try {
      data = await compute(prepared.input, signal);
    } catch (e) {
      console.error('[surface] computation failed', e);
      return null;
    }
    if (!data || signal?.aborted) return null;
    cachePut(key, data);
  }
  if (signal?.aborted) return null;
  return makeMesh(data, prepared.atomIndices, colors, opts);
}
