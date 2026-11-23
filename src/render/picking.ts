/**
 * Picking: nearest displayed atom / bond under a ray. OWNER: render-core.
 *
 * - Sphere/cylinder representations: analytic ray–sphere (atoms, display radius) and ray–capsule
 *   (bonds, pick radius covering multiple-bond cylinders), accelerated by a uniform grid
 *   (render/pickingGrid.ts) that is rebuilt lazily after the scene changes.
 * - Lines: screen-space tolerance (atoms 4 px, bonds 3 px), tested as cones around the ray.
 * - Cartoon / surface meshes: ray–triangle against a lazily built triangle grid; the hit maps to an atom
 *   via `userData.vertexAtomIndex` (nearest vertex of the hit triangle), falling back to the nearest
 *   atom of the representation's mask.
 * Atom hits win over a nearer bond hit when the pointer is within ~2 px of one of the bond's atoms.
 */
import type * as THREE from 'three';
import type { Molecule } from '../core/types';
import { getTopology } from '../core/molecule';
import type { LinePickData, SpherePickData } from './repTypes';
import { UniformGrid } from './pickingGrid';
import { rayCapsule, raySegmentClosest, raySphere, rayTriangle, v3 } from './math3d';

export interface PickRay {
  ox: number;
  oy: number;
  oz: number;
  /** Unit direction. */
  dx: number;
  dy: number;
  dz: number;
}

/** World size of one CSS pixel at ray distance t (perspective: ∝ t, orthographic: constant). */
export type PixelSize = (t: number) => number;

export interface MeshPickSource {
  object: THREE.Object3D;
  /** Molecule the mesh was built from (it may lag behind the current one, e.g. async surfaces). */
  mol: Molecule;
  /** Atoms (by index into `mol`) included in this representation (after the hydrogen filter). */
  mask: Uint8Array;
}

export interface PickHit {
  kind: 'atom' | 'bond';
  /** Atom index (kind 'atom') or bond index into mol.bonds (kind 'bond'). */
  index: number;
  t: number;
  point: [number, number, number];
}

/** Pixel tolerances for the lines style and the atom-over-bond priority. */
export const LINE_ATOM_TOLERANCE_PX = 4;
export const LINE_BOND_TOLERANCE_PX = 3;
export const ATOM_PRIORITY_PX = 2;
/** Moved items tested by brute force before the grid is rebuilt (see moveAtoms). */
const MAX_MOVED_ITEMS = 4096;

interface TriangleSoup {
  positions: Float32Array; // world space, 3 per vertex
  index: ArrayLike<number> | null;
  triangles: number;
  grid: UniformGrid;
  vertexAtomIndex: Int32Array | null;
}

const _seg = v3();

export class Picker {
  private mol: Molecule | null = null;
  private spheres: SpherePickData[] = [];
  private lines: LinePickData[] = [];
  private meshes: MeshPickSource[] = [];
  private dirty = true;

  // Combined sphere + capsule items (items < nSpheres are spheres).
  private grid: UniformGrid | null = null;
  private nSpheres = 0;
  private itemAtom = new Int32Array(0);
  private itemRadius = new Float32Array(0);
  private capA = new Int32Array(0);
  private capB = new Int32Array(0);
  private capBond = new Int32Array(0);
  /** Per atom index: largest sphere radius it is displayed with (0 = not a sphere). */
  private atomSphereRadius = new Float32Array(0);
  /** Per atom index: displayed by a lines representation. */
  private atomInLines = new Uint8Array(0);
  /** CSR map atom index → sphere / capsule items that involve it. */
  private atomItemStart = new Int32Array(1);
  private atomItemList = new Int32Array(0);
  /** Items whose atoms moved since the grid was built (tested by brute force in addition to the grid). */
  private moved: number[] = [];
  private isMoved = new Uint8Array(0);
  private soups = new WeakMap<THREE.BufferGeometry, { version: number; soup: TriangleSoup }>();

  /** Replace the pickable content. Cheap: the acceleration structure is rebuilt lazily on the next pick. */
  setSources(mol: Molecule | null, spheres: SpherePickData[], lines: LinePickData[], meshes: MeshPickSource[]) {
    this.mol = mol;
    this.spheres = spheres;
    this.lines = lines;
    this.meshes = meshes;
    this.dirty = true;
  }

  /** Mark coordinates / radii as changed (same sources). */
  invalidate() {
    this.dirty = true;
  }

  /**
   * Coordinates changed for the atoms in `changed` (same structure and same sphere / line sources;
   * null = unknown). Small changes (e.g. dragging a few atoms in a large system) keep the grid: the
   * moved items are additionally tested by brute force, so no rebuild is needed per drag frame.
   * Items still sit in their old grid cells, which is harmless (the test uses current positions).
   */
  moveAtoms(mol: Molecule, changed: Int32Array | null, meshes: MeshPickSource[]) {
    this.mol = mol;
    this.meshes = meshes;
    if (this.dirty || !this.grid || !changed || this.atomItemStart.length !== mol.atoms.length + 1) {
      this.dirty = true;
      return;
    }
    const start = this.atomItemStart;
    const list = this.atomItemList;
    for (const i of changed) {
      for (let k = start[i]; k < start[i + 1]; k++) {
        const it = list[k];
        if (this.isMoved[it]) continue;
        this.isMoved[it] = 1;
        this.moved.push(it);
      }
      if (this.moved.length > MAX_MOVED_ITEMS) {
        this.dirty = true;
        return;
      }
    }
  }

  get molecule(): Molecule | null {
    return this.mol;
  }

  pick(ray: PickRay, pixelSize: PixelSize): PickHit | null {
    const mol = this.mol;
    if (!mol || mol.atoms.length === 0) return null;
    if (this.dirty) this.rebuild();
    const atoms = mol.atoms;
    const { ox, oy, oz, dx, dy, dz } = ray;

    let best: PickHit | null = null;
    const consider = (h: PickHit | null) => {
      if (h && (!best || h.t < best.t)) best = h;
    };

    // 1. Spheres and capsules.
    if (this.grid && this.grid.itemCount > 0) {
      const nS = this.nSpheres;
      const itemAtom = this.itemAtom;
      const itemRadius = this.itemRadius;
      const capA = this.capA;
      const capB = this.capB;
      const test = (it: number): number => {
        if (it < nS) {
          const a = atoms[itemAtom[it]];
          return raySphere(ox, oy, oz, dx, dy, dz, a.x, a.y, a.z, itemRadius[it]);
        }
        const c = it - nS;
        const A = atoms[capA[c]];
        const B = atoms[capB[c]];
        return rayCapsule(ox, oy, oz, dx, dy, dz, A.x, A.y, A.z, B.x, B.y, B.z, itemRadius[it]);
      };
      const res = this.grid.raycast(ox, oy, oz, dx, dy, dz, test);
      for (const it of this.moved) {
        const t = test(it);
        if (t > 0 && t < res.t) {
          res.t = t;
          res.item = it;
        }
      }
      if (res.item >= 0) {
        const p: [number, number, number] = [ox + dx * res.t, oy + dy * res.t, oz + dz * res.t];
        if (res.item < nS) consider({ kind: 'atom', index: itemAtom[res.item], t: res.t, point: p });
        else consider({ kind: 'bond', index: this.capBond[res.item - nS], t: res.t, point: p });
      }
    }

    // 2. Lines (screen-space tolerance, brute force: a few float ops per atom).
    for (const L of this.lines) consider(this.pickLines(L, ray, pixelSize));

    // 3. Meshes (cartoon / surface).
    for (const M of this.meshes) consider(this.pickMesh(M, ray));

    if (!best) return null;
    const hit: PickHit = best;
    if (hit.kind === 'bond') {
      // Prefer one of the bond's atoms if the pointer is within ~2 px of its silhouette.
      const bond = mol.bonds[hit.index];
      const ia = bond ? indexOfId(mol, bond.a) : -1;
      const ib = bond ? indexOfId(mol, bond.b) : -1;
      let bestAtom = -1;
      let bestScore = Infinity;
      for (const i of [ia, ib]) {
        if (i < 0) continue;
        const a = atoms[i];
        const lx = a.x - ox;
        const ly = a.y - oy;
        const lz = a.z - oz;
        const t = lx * dx + ly * dy + lz * dz;
        if (t <= 0) continue;
        const perp = Math.sqrt(Math.max(0, lx * lx + ly * ly + lz * lz - t * t));
        const px = pixelSize(t);
        const rs = this.atomSphereRadius[i];
        let allowed = rs > 0 ? rs + ATOM_PRIORITY_PX * px : 0;
        if (this.atomInLines[i]) allowed = Math.max(allowed, LINE_ATOM_TOLERANCE_PX * px);
        if (perp <= allowed) {
          const score = (perp - rs) / px;
          if (score < bestScore) {
            bestScore = score;
            bestAtom = i;
          }
        }
      }
      if (bestAtom >= 0) {
        const a = atoms[bestAtom];
        const rs = this.atomSphereRadius[bestAtom];
        let t = rs > 0 ? raySphere(ox, oy, oz, dx, dy, dz, a.x, a.y, a.z, rs) : -1;
        if (t < 0) t = (a.x - ox) * dx + (a.y - oy) * dy + (a.z - oz) * dz;
        return { kind: 'atom', index: bestAtom, t, point: [ox + dx * t, oy + dy * t, oz + dz * t] };
      }
    }
    return hit;
  }

  // ---------------------------------------------------------------------------

  private rebuild() {
    this.dirty = false;
    const mol = this.mol;
    const n = mol ? mol.atoms.length : 0;
    this.atomSphereRadius = new Float32Array(n);
    this.atomInLines = new Uint8Array(n);
    this.grid = null;
    this.moved = [];
    this.atomItemStart = new Int32Array(n + 1);
    this.atomItemList = new Int32Array(0);
    if (!mol) return;
    const atoms = mol.atoms;

    let nS = 0;
    let nC = 0;
    for (const s of this.spheres) {
      nS += s.atoms.length;
      nC += s.bonds.length;
    }
    for (const L of this.lines) for (let k = 0; k < L.atoms.length; k++) this.atomInLines[L.atoms[k]] = 1;
    const total = nS + nC;
    this.nSpheres = nS;
    this.itemAtom = new Int32Array(nS);
    this.itemRadius = new Float32Array(total);
    this.capA = new Int32Array(nC);
    this.capB = new Int32Array(nC);
    this.capBond = new Int32Array(nC);
    const boxes = new Float32Array(total * 6);
    let s = 0;
    for (const src of this.spheres) {
      for (let k = 0; k < src.atoms.length; k++, s++) {
        const i = src.atoms[k];
        const r = src.radii[k];
        const a = atoms[i];
        this.itemAtom[s] = i;
        this.itemRadius[s] = r;
        if (r > this.atomSphereRadius[i]) this.atomSphereRadius[i] = r;
        const o = s * 6;
        boxes[o] = a.x - r;
        boxes[o + 1] = a.y - r;
        boxes[o + 2] = a.z - r;
        boxes[o + 3] = a.x + r;
        boxes[o + 4] = a.y + r;
        boxes[o + 5] = a.z + r;
      }
    }
    let c = 0;
    for (const src of this.spheres) {
      for (let d = 0; d < src.bonds.length; d++, c++) {
        const ia = src.bondA[d];
        const ib = src.bondB[d];
        const r = src.bondRadii[d];
        const A = atoms[ia];
        const B = atoms[ib];
        this.capA[c] = ia;
        this.capB[c] = ib;
        this.capBond[c] = src.bonds[d];
        const it = nS + c;
        this.itemRadius[it] = r;
        const o = it * 6;
        boxes[o] = Math.min(A.x, B.x) - r;
        boxes[o + 1] = Math.min(A.y, B.y) - r;
        boxes[o + 2] = Math.min(A.z, B.z) - r;
        boxes[o + 3] = Math.max(A.x, B.x) + r;
        boxes[o + 4] = Math.max(A.y, B.y) + r;
        boxes[o + 5] = Math.max(A.z, B.z) + r;
      }
    }
    if (total > 0) this.grid = new UniformGrid(boxes, total);
    this.isMoved = new Uint8Array(total);

    // atom → items map (CSR) for incremental coordinate updates.
    const start = this.atomItemStart;
    for (let it = 0; it < nS; it++) start[this.itemAtom[it] + 1]++;
    for (let c = 0; c < nC; c++) {
      start[this.capA[c] + 1]++;
      start[this.capB[c] + 1]++;
    }
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const list = new Int32Array(start[n]);
    const fill = start.slice(0, n);
    for (let it = 0; it < nS; it++) list[fill[this.itemAtom[it]]++] = it;
    for (let c = 0; c < nC; c++) {
      list[fill[this.capA[c]]++] = nS + c;
      list[fill[this.capB[c]]++] = nS + c;
    }
    this.atomItemList = list;
  }

  private pickLines(L: LinePickData, ray: PickRay, pixelSize: PixelSize): PickHit | null {
    const atoms = this.mol!.atoms;
    const { ox, oy, oz, dx, dy, dz } = ray;
    let bestPx = Infinity;
    let hit: PickHit | null = null;
    for (let k = 0; k < L.atoms.length; k++) {
      const i = L.atoms[k];
      const a = atoms[i];
      const lx = a.x - ox;
      const ly = a.y - oy;
      const lz = a.z - oz;
      const t = lx * dx + ly * dy + lz * dz;
      if (t <= 0) continue;
      const perp2 = lx * lx + ly * ly + lz * lz - t * t;
      const px = pixelSize(t);
      const tol = LINE_ATOM_TOLERANCE_PX * px;
      if (perp2 > tol * tol) continue;
      const dpx = Math.sqrt(Math.max(0, perp2)) / px;
      // Closest to the pointer; among (nearly) equal, the one nearer to the camera.
      if (dpx < bestPx - 0.5 || (dpx < bestPx + 0.5 && hit && t < hit.t)) {
        bestPx = dpx;
        hit = { kind: 'atom', index: i, t, point: [ox + dx * t, oy + dy * t, oz + dz * t] };
      }
    }
    if (hit) return hit;
    bestPx = Infinity;
    for (let d = 0; d < L.bonds.length; d++) {
      const A = atoms[L.bondA[d]];
      const B = atoms[L.bondB[d]];
      raySegmentClosest(ox, oy, oz, dx, dy, dz, A.x, A.y, A.z, B.x, B.y, B.z, _seg);
      const t = _seg.y;
      if (t <= 0) continue;
      const px = pixelSize(t);
      const tol = LINE_BOND_TOLERANCE_PX * px;
      if (_seg.x > tol * tol) continue;
      const dpx = Math.sqrt(_seg.x) / px;
      if (dpx < bestPx - 0.5 || (dpx < bestPx + 0.5 && hit && t < hit.t)) {
        bestPx = dpx;
        hit = { kind: 'bond', index: L.bonds[d], t, point: [ox + dx * t, oy + dy * t, oz + dz * t] };
      }
    }
    return hit;
  }

  private pickMesh(M: MeshPickSource, ray: PickRay): PickHit | null {
    const mol = this.mol!;
    let best: { t: number; soup: TriangleSoup; tri: number } | null = null;
    const rootMap = (M.object.userData?.vertexAtomIndex as Int32Array | undefined) ?? null;
    M.object.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const soup = this.soupFor(mesh, rootMap);
      if (!soup) return;
      const { ox, oy, oz, dx, dy, dz } = ray;
      const P = soup.positions;
      const idx = soup.index;
      const res = soup.grid.raycast(ox, oy, oz, dx, dy, dz, (tri) => {
        const a = idx ? idx[tri * 3] : tri * 3;
        const b = idx ? idx[tri * 3 + 1] : tri * 3 + 1;
        const c = idx ? idx[tri * 3 + 2] : tri * 3 + 2;
        return rayTriangle(
          ox, oy, oz, dx, dy, dz,
          P[a * 3], P[a * 3 + 1], P[a * 3 + 2],
          P[b * 3], P[b * 3 + 1], P[b * 3 + 2],
          P[c * 3], P[c * 3 + 1], P[c * 3 + 2],
        );
      });
      if (res.item >= 0 && (!best || res.t < best.t)) best = { t: res.t, soup, tri: res.item };
    });
    if (!best) return null;
    const { t, soup, tri } = best as { t: number; soup: TriangleSoup; tri: number };
    const px = ray.ox + ray.dx * t;
    const py = ray.oy + ray.dy * t;
    const pz = ray.oz + ray.dz * t;
    let atom = -1;
    const built = M.mol;
    if (soup.vertexAtomIndex) {
      // Nearest vertex of the hit triangle → its atom.
      let bestD = Infinity;
      for (let k = 0; k < 3; k++) {
        const v = soup.index ? soup.index[tri * 3 + k] : tri * 3 + k;
        const P = soup.positions;
        const d = (P[v * 3] - px) ** 2 + (P[v * 3 + 1] - py) ** 2 + (P[v * 3 + 2] - pz) ** 2;
        const ai = soup.vertexAtomIndex[v];
        if (d < bestD && ai >= 0 && ai < built.atoms.length && M.mask[ai]) {
          bestD = d;
          atom = ai;
        }
      }
    }
    if (atom < 0) atom = nearestMaskedAtom(built, M.mask, px, py, pz);
    if (atom < 0) return null;
    // Translate the index of the molecule the mesh was built from into the current molecule.
    if (built !== mol) atom = built.atoms[atom] ? indexOfId(mol, built.atoms[atom].id) : -1;
    if (atom < 0) return null;
    return { kind: 'atom', index: atom, t, point: [px, py, pz] };
  }

  private soupFor(mesh: THREE.Mesh, rootMap: Int32Array | null): TriangleSoup | null {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return null;
    const version = pos.version + (geom.index ? geom.index.version * 1e6 : 0);
    const cached = this.soups.get(geom);
    if (cached && cached.version === version) return cached.soup;
    mesh.updateWorldMatrix(true, false);
    const soup = buildTriangleSoup(geom, mesh.matrixWorld.elements, (mesh.userData?.vertexAtomIndex as Int32Array | undefined) ?? rootMap);
    if (soup) this.soups.set(geom, { version, soup });
    return soup;
  }
}

function indexOfId(mol: Molecule, id: number): number {
  return getTopology(mol).idToIndex.get(id) ?? -1;
}

/** Nearest atom (by index) with mask[i] set, or −1. */
export function nearestMaskedAtom(mol: Molecule, mask: Uint8Array, x: number, y: number, z: number): number {
  let best = -1;
  let bestD = Infinity;
  const atoms = mol.atoms;
  for (let i = 0; i < atoms.length; i++) {
    if (!mask[i]) continue;
    const a = atoms[i];
    const d = (a.x - x) ** 2 + (a.y - y) ** 2 + (a.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** World-space triangle soup with a grid, from an (indexed or not) BufferGeometry. */
export function buildTriangleSoup(
  geom: THREE.BufferGeometry,
  matrixWorld: ArrayLike<number>,
  vertexAtomIndex: Int32Array | null,
): TriangleSoup | null {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count === 0) return null;
  const nv = pos.count;
  const m = matrixWorld;
  const identity =
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[4] === 0 && m[5] === 1 && m[6] === 0 &&
    m[8] === 0 && m[9] === 0 && m[10] === 1 && m[12] === 0 && m[13] === 0 && m[14] === 0;
  const positions = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    if (identity) {
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = z;
    } else {
      const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
      positions[v * 3] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      positions[v * 3 + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      positions[v * 3 + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    }
  }
  const index = geom.index ? (geom.index.array as ArrayLike<number>) : null;
  let triangles = index ? Math.floor(index.length / 3) : Math.floor(nv / 3);
  // Honour drawRange when set.
  const dr = geom.drawRange;
  if (dr && Number.isFinite(dr.count)) triangles = Math.min(triangles, Math.floor((dr.start + dr.count) / 3));
  const boxes = new Float32Array(triangles * 6);
  for (let t = 0; t < triangles; t++) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = index ? index[t * 3 + k] : t * 3 + k;
      const x = positions[v * 3];
      const y = positions[v * 3 + 1];
      const z = positions[v * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const o = t * 6;
    boxes[o] = minX;
    boxes[o + 1] = minY;
    boxes[o + 2] = minZ;
    boxes[o + 3] = maxX;
    boxes[o + 4] = maxY;
    boxes[o + 5] = maxZ;
  }
  const grid = new UniformGrid(boxes, triangles, { itemsPerCell: 4, minCellSize: 0.75 });
  return { positions, index, triangles, grid, vertexAtomIndex: vertexAtomIndex && vertexAtomIndex.length >= nv ? vertexAtomIndex : null };
}
