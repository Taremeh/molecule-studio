/**
 * Atom-based representations drawn with instanced spheres and cylinders: ball-and-stick, spacefill
 * and licorice. OWNER: render-core. See ARCHITECTURE.md § Renderer.
 *
 * - One InstancedMesh of unit spheres (one instance per displayed atom) and one of unit cylinders
 *   (bond "sticks", see render/bondLayout.ts), with per-instance colours. Tessellation follows
 *   view.quality but is reduced automatically for very large instance counts.
 * - Coordinate-only updates rewrite the affected instance matrices in place (partial GPU upload).
 * - `displayRadius` is the single source of truth for atom sizes (drawing, picking, halos).
 */
import * as THREE from 'three';
import type { Atom, Molecule, RepStyle, Topology } from '../../core/types';
import { getElement } from '../../core/elements';
import { getTopology } from '../../core/molecule';
import { bondOffsetDirection, srgbToLinear, v3, writeCylinderMatrix, writeSphereMatrix } from '../math3d';
import { BALL_STICK_BOND_RADIUS, LICORICE_RADIUS, buildStickLayout, type StickLayout } from '../bondLayout';
import type { AtomRepInstance, Quality, SpherePickData } from '../repTypes';

export { BALL_STICK_BOND_RADIUS, LICORICE_RADIUS };

/** Nominal radius used for halos / picking of atoms drawn as lines. */
export const LINES_NOMINAL_RADIUS = 0.25;

const vdwCache = new Map<string, number>();
function vdwRadius(element: string): number {
  let r = vdwCache.get(element);
  if (r === undefined) {
    r = getElement(element).vdwRadius || 2.0;
    vdwCache.set(element, r);
  }
  return r;
}

/**
 * Radius (Å) at which an atom is drawn in the given style.
 *  - ball-and-stick: max(0.18, 0.25·vdW) (H: 0.2·vdW) × scale
 *  - spacefill: vdW × scale
 *  - licorice: 0.2 × scale (same as its bonds)
 *  - lines: nominal 0.25 × scale (used for halos only; lines are picked in screen space)
 *  - cartoon / surface: the ball-and-stick radius (used for halos around otherwise invisible atoms)
 */
export function displayRadius(atom: Pick<Atom, 'element'>, style: RepStyle, scale = 1): number {
  switch (style) {
    case 'spacefill':
      return vdwRadius(atom.element) * scale;
    case 'licorice':
      return LICORICE_RADIUS * scale;
    case 'lines':
      return LINES_NOMINAL_RADIUS * scale;
    default: {
      const f = atom.element === 'H' ? 0.2 : 0.25;
      return Math.max(0.18, f * vdwRadius(atom.element)) * scale;
    }
  }
}

// ---------------------------------------------------------------------------
// Tessellation
// ---------------------------------------------------------------------------

const QUALITY_ORDER: Quality[] = ['low', 'medium', 'high'];
const SPHERE_SEGMENTS: Record<Quality, [number, number]> = { low: [12, 8], medium: [20, 14], high: [32, 22] };
const CYLINDER_SEGMENTS: Record<Quality, number> = { low: 6, medium: 10, high: 16 };
/** Triangle budget per instanced mesh before tessellation is reduced. */
const TRIANGLE_BUDGET = 12_000_000;

function sphereTriangles(q: Quality): number {
  const [w, h] = SPHERE_SEGMENTS[q];
  return 2 * w * (h - 1);
}

/** Highest quality ≤ requested whose total triangle count fits the budget (never below 'low'). */
export function effectiveQuality(requested: Quality, instances: number, trianglesPer: (q: Quality) => number): Quality {
  let i = QUALITY_ORDER.indexOf(requested);
  while (i > 0 && instances * trianglesPer(QUALITY_ORDER[i]) > TRIANGLE_BUDGET) i--;
  return QUALITY_ORDER[i];
}

export function createSphereGeometry(q: Quality): THREE.BufferGeometry {
  const [w, h] = SPHERE_SEGMENTS[q];
  return new THREE.SphereGeometry(1, w, h);
}

/** Unit cylinder of radius 1 along +Y from y = 0 to y = 1 (capped). */
export function createCylinderGeometry(q: Quality, capped = true): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, CYLINDER_SEGMENTS[q], 1, !capped);
  g.translate(0, 0.5, 0);
  return g;
}

export function createAtomMaterial(opacity: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0 });
  applyOpacity(m, opacity);
  return m;
}

/** Set opacity on a material following the renderer rule (opacity < 1 → transparent, no depth write). */
export function applyOpacity(m: THREE.Material, opacity: number): void {
  const transparent = opacity < 0.999;
  if (m.transparent !== transparent) m.needsUpdate = true;
  m.transparent = transparent;
  m.opacity = Math.max(0, Math.min(1, opacity));
  m.depthWrite = !transparent;
}

export function makeInstancedMesh(geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3);
  // Instance matrices change in place; bounding volumes would go stale.
  mesh.frustumCulled = false;
  return mesh;
}

/** Per-atom linear-space colours from per-atom sRGB colours. */
export function toLinearColors(srgb: Float32Array): Float32Array {
  const out = new Float32Array(srgb.length);
  for (let i = 0; i < srgb.length; i++) out[i] = srgbToLinear(srgb[i]);
  return out;
}

/** Diff two structurally identical molecules by atom object identity → changed atom indices. */
export function changedAtomIndices(prev: Molecule, next: Molecule): Int32Array {
  const n = Math.min(prev.atoms.length, next.atoms.length);
  const out: number[] = [];
  const pa = prev.atoms;
  const na = next.atoms;
  for (let i = 0; i < n; i++) {
    const a = pa[i];
    const b = na[i];
    if (a !== b && (a.x !== b.x || a.y !== b.y || a.z !== b.z)) out.push(i);
  }
  return Int32Array.from(out);
}

// ---------------------------------------------------------------------------
// AtomRep
// ---------------------------------------------------------------------------

export type SphereStyle = 'ball-and-stick' | 'spacefill' | 'licorice';

export interface AtomRepOptions {
  style: SphereStyle;
  quality: Quality;
  scale: number;
  opacity: number;
}

const _dir = v3();
const _ref = v3();

export class AtomRep implements AtomRepInstance {
  readonly object = new THREE.Group();
  readonly style: SphereStyle;
  readonly atoms: Int32Array;
  readonly radii: Float32Array;
  version = 0;

  private mol: Molecule;
  private topo: Topology;
  private scale: number;
  private baseRadii: Float32Array;
  private atomToSphere: Int32Array;
  private layout: StickLayout | null;
  private bondA: Int32Array;
  private bondB: Int32Array;
  private bondRadii: Float32Array;
  private material: THREE.MeshStandardMaterial;
  private spheres: THREE.InstancedMesh | null = null;
  private sticks: THREE.InstancedMesh | null = null;
  private stamp: Uint32Array;
  private stampId = 0;

  constructor(mol: Molecule, mask: Uint8Array, colors: Float32Array, opts: AtomRepOptions) {
    this.mol = mol;
    this.topo = getTopology(mol);
    this.style = opts.style;
    this.scale = opts.scale;
    this.object.name = `atoms:${opts.style}`;

    const n = mol.atoms.length;
    const shown: number[] = [];
    for (let i = 0; i < n; i++) if (mask[i]) shown.push(i);
    this.atoms = Int32Array.from(shown);
    this.atomToSphere = new Int32Array(n).fill(-1);
    this.baseRadii = new Float32Array(shown.length);
    this.radii = new Float32Array(shown.length);
    for (let k = 0; k < shown.length; k++) {
      const i = shown[k];
      this.atomToSphere[i] = k;
      this.baseRadii[k] = displayRadius(mol.atoms[i], opts.style, 1);
    }

    this.layout = opts.style === 'spacefill' ? null : buildStickLayout(mol, mask, opts.style);
    const nd = this.layout ? this.layout.bonds.length : 0;
    this.bondA = new Int32Array(nd);
    this.bondB = new Int32Array(nd);
    this.bondRadii = new Float32Array(nd);
    if (this.layout) {
      for (let d = 0; d < nd; d++) {
        const s = this.layout.bondFirstStick[d];
        this.bondA[d] = this.layout.a[s];
        this.bondB[d] = this.layout.b[s];
      }
    }
    this.stamp = new Uint32Array(Math.max(nd, 1));

    this.material = createAtomMaterial(opts.opacity);
    if (shown.length > 0) {
      const q = effectiveQuality(opts.quality, shown.length, sphereTriangles);
      this.spheres = makeInstancedMesh(createSphereGeometry(q), this.material, shown.length);
      this.spheres.name = 'spheres';
      this.object.add(this.spheres);
    }
    if (this.layout && this.layout.count > 0) {
      const q = effectiveQuality(opts.quality, this.layout.count, (qq) => 4 * CYLINDER_SEGMENTS[qq]);
      this.sticks = makeInstancedMesh(createCylinderGeometry(q), this.material, this.layout.count);
      this.sticks.name = 'sticks';
      this.object.add(this.sticks);
    }
    this.setColors(colors);
    this.applyScaleToRadii();
    this.writeAll();
  }

  pickData(): SpherePickData {
    return {
      kind: 'spheres',
      atoms: this.atoms,
      radii: this.radii,
      bonds: this.layout ? this.layout.bonds : new Int32Array(0),
      bondA: this.bondA,
      bondB: this.bondB,
      bondRadii: this.bondRadii,
    };
  }

  updateCoordinates(mol: Molecule, changed: Int32Array | null): void {
    this.mol = mol;
    this.version++;
    if (!changed || changed.length > this.atoms.length / 4) {
      this.writeAll();
      return;
    }
    if (changed.length === 0) return;
    this.writePartial(changed);
  }

  setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.version++;
    this.applyScaleToRadii();
    this.writeAll();
  }

  setColors(colors: Float32Array): void {
    const lin = toLinearColors(colors);
    if (this.spheres) {
      const arr = this.spheres.instanceColor!.array as Float32Array;
      for (let k = 0; k < this.atoms.length; k++) {
        const i = this.atoms[k] * 3;
        arr[k * 3] = lin[i];
        arr[k * 3 + 1] = lin[i + 1];
        arr[k * 3 + 2] = lin[i + 2];
      }
      this.spheres.instanceColor!.needsUpdate = true;
    }
    if (this.sticks && this.layout) {
      const arr = this.sticks.instanceColor!.array as Float32Array;
      const ca = this.layout.colorAtom;
      for (let s = 0; s < this.layout.count; s++) {
        const i = ca[s] * 3;
        arr[s * 3] = lin[i];
        arr[s * 3 + 1] = lin[i + 1];
        arr[s * 3 + 2] = lin[i + 2];
      }
      this.sticks.instanceColor!.needsUpdate = true;
    }
  }

  setOpacity(opacity: number): void {
    applyOpacity(this.material, opacity);
  }

  dispose(): void {
    this.spheres?.geometry.dispose();
    this.sticks?.geometry.dispose();
    this.spheres?.dispose();
    this.sticks?.dispose();
    this.material.dispose();
    this.object.clear();
  }

  // ---- internals ----

  private applyScaleToRadii() {
    for (let k = 0; k < this.baseRadii.length; k++) this.radii[k] = this.baseRadii[k] * this.scale;
    if (this.layout) for (let d = 0; d < this.layout.bonds.length; d++) this.bondRadii[d] = this.layout.bondPickRadius[d] * this.scale;
  }

  private writeAll() {
    const atoms = this.mol.atoms;
    if (this.spheres) {
      const arr = this.spheres.instanceMatrix.array as Float32Array;
      for (let k = 0; k < this.atoms.length; k++) {
        const a = atoms[this.atoms[k]];
        writeSphereMatrix(arr, k * 16, a.x, a.y, a.z, this.radii[k]);
      }
      this.spheres.instanceMatrix.clearUpdateRanges();
      this.spheres.instanceMatrix.needsUpdate = true;
    }
    if (this.sticks && this.layout) {
      for (let d = 0; d < this.layout.bonds.length; d++) this.writeBond(d);
      this.sticks.instanceMatrix.clearUpdateRanges();
      this.sticks.instanceMatrix.needsUpdate = true;
    }
  }

  private writePartial(changed: Int32Array) {
    const atoms = this.mol.atoms;
    if (this.spheres) {
      const arr = this.spheres.instanceMatrix.array as Float32Array;
      let lo = Infinity;
      let hi = -1;
      for (const i of changed) {
        const k = this.atomToSphere[i];
        if (k < 0) continue;
        const a = atoms[i];
        writeSphereMatrix(arr, k * 16, a.x, a.y, a.z, this.radii[k]);
        if (k < lo) lo = k;
        if (k > hi) hi = k;
      }
      if (hi >= 0) {
        this.spheres.instanceMatrix.addUpdateRange(lo * 16, (hi - lo + 1) * 16);
        this.spheres.instanceMatrix.needsUpdate = true;
      }
    }
    if (this.sticks && this.layout) {
      const L = this.layout;
      const topo = this.topo;
      // Affected bonds: incident to a changed atom, or (for offset multiple bonds) incident to a
      // neighbour of a changed atom, because the offset plane depends on neighbour positions.
      if (++this.stampId === 0xffffffff) {
        this.stamp.fill(0);
        this.stampId = 1;
      }
      const sid = this.stampId;
      let lo = Infinity;
      let hi = -1;
      const touch = (bi: number, multipleOnly: boolean) => {
        const d = L.bondToDisplayed[bi];
        if (d < 0 || this.stamp[d] === sid) return;
        if (multipleOnly && L.bondRef[d] < 0) return;
        this.stamp[d] = sid;
        this.writeBond(d);
        const s0 = L.bondFirstStick[d];
        const s1 = s0 + L.bondStickCount[d] - 1;
        if (s0 < lo) lo = s0;
        if (s1 > hi) hi = s1;
      };
      for (const i of changed) {
        for (const bi of topo.atomBonds[i]) touch(bi, false);
        for (const j of topo.neighbors[i]) for (const bi of topo.atomBonds[j]) touch(bi, true);
      }
      if (hi >= 0) {
        this.sticks.instanceMatrix.addUpdateRange(lo * 16, (hi - lo + 1) * 16);
        this.sticks.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Write the matrices of all sticks of displayed bond `d`. */
  private writeBond(d: number) {
    const L = this.layout!;
    const arr = this.sticks!.instanceMatrix.array as Float32Array;
    const atoms = this.mol.atoms;
    const s0 = L.bondFirstStick[d];
    const A = atoms[L.a[s0]];
    const B = atoms[L.b[s0]];
    const refIdx = L.bondRef[d];
    let hasOffset = false;
    for (let s = s0; s < s0 + L.bondStickCount[d]; s++) if (L.offset[s] !== 0) hasOffset = true;
    let dir = null as typeof _dir | null;
    if (hasOffset) {
      let ref: typeof _ref | null = null;
      if (refIdx >= 0) {
        const R = atoms[refIdx];
        _ref.x = R.x;
        _ref.y = R.y;
        _ref.z = R.z;
        ref = _ref;
      }
      dir = bondOffsetDirection(A.x, A.y, A.z, B.x, B.y, B.z, ref, _dir);
    }
    const k = this.scale;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const dz = B.z - A.z;
    for (let s = s0; s < s0 + L.bondStickCount[d]; s++) {
      const off = L.offset[s] * k;
      let ox = 0, oy = 0, oz = 0;
      if (off !== 0 && dir) {
        ox = dir.x * off;
        oy = dir.y * off;
        oz = dir.z * off;
      }
      const t0 = L.t0[s];
      const t1 = L.t1[s];
      writeCylinderMatrix(
        arr,
        s * 16,
        A.x + dx * t0 + ox,
        A.y + dy * t0 + oy,
        A.z + dz * t0 + oz,
        A.x + dx * t1 + ox,
        A.y + dy * t1 + oy,
        A.z + dz * t1 + oz,
        L.radius[s] * k,
        dir ?? undefined,
      );
    }
  }
}
