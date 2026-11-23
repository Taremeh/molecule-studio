/**
 * 'lines' representation: bonds as 1-px line segments split at the midpoint (each half in its atom's
 * colour); displayed atoms without any displayed bond are drawn as small 3D crosses.
 * Cheap enough for very large systems (default for water and for editing > 3000 atoms).
 * OWNER: render-core.
 */
import * as THREE from 'three';
import type { Molecule, Topology } from '../../core/types';
import { getTopology } from '../../core/molecule';
import type { AtomRepInstance, LinePickData } from '../repTypes';
import { LINES_NOMINAL_RADIUS, applyOpacity, toLinearColors } from './atoms';

/** Half-length (Å) of the arms of the cross drawn for unbonded atoms. */
export const CROSS_HALF = 0.25;

export interface LinesRepOptions {
  scale: number;
  opacity: number;
}

export class LinesRep implements AtomRepInstance {
  readonly object: THREE.LineSegments;
  readonly atoms: Int32Array;
  readonly radii: Float32Array;
  version = 0;

  private mol: Molecule;
  private topo: Topology;
  private scale: number;
  /** Displayed bonds: mol.bonds index and endpoint atom indices. */
  private bonds: Int32Array;
  private bondA: Int32Array;
  private bondB: Int32Array;
  private bondToDisplayed: Int32Array;
  /** Atoms drawn as crosses, and atom index → cross slot (−1 if none). */
  private crossAtoms: Int32Array;
  private atomToCross: Int32Array;
  private positions: Float32Array;
  private colors: Float32Array;
  private geometry: THREE.BufferGeometry;
  private material: THREE.LineBasicMaterial;

  constructor(mol: Molecule, mask: Uint8Array, colors: Float32Array, opts: LinesRepOptions) {
    this.mol = mol;
    this.topo = getTopology(mol);
    this.scale = opts.scale;
    const topo = this.topo;
    const n = mol.atoms.length;

    const shown: number[] = [];
    for (let i = 0; i < n; i++) if (mask[i]) shown.push(i);
    this.atoms = Int32Array.from(shown);
    this.radii = new Float32Array(shown.length).fill(LINES_NOMINAL_RADIUS * opts.scale);

    const bonds: number[] = [];
    const hasBond = new Uint8Array(n);
    this.bondToDisplayed = new Int32Array(mol.bonds.length).fill(-1);
    for (let bi = 0; bi < mol.bonds.length; bi++) {
      const b = mol.bonds[bi];
      const ia = topo.idToIndex.get(b.a);
      const ib = topo.idToIndex.get(b.b);
      if (ia === undefined || ib === undefined || ia === ib || !mask[ia] || !mask[ib]) continue;
      this.bondToDisplayed[bi] = bonds.length;
      bonds.push(bi);
      hasBond[ia] = 1;
      hasBond[ib] = 1;
    }
    this.bonds = Int32Array.from(bonds);
    this.bondA = new Int32Array(bonds.length);
    this.bondB = new Int32Array(bonds.length);
    for (let d = 0; d < bonds.length; d++) {
      const b = mol.bonds[bonds[d]];
      this.bondA[d] = topo.idToIndex.get(b.a)!;
      this.bondB[d] = topo.idToIndex.get(b.b)!;
    }
    const cross: number[] = [];
    this.atomToCross = new Int32Array(n).fill(-1);
    for (const i of shown) {
      if (hasBond[i]) continue;
      this.atomToCross[i] = cross.length;
      cross.push(i);
    }
    this.crossAtoms = Int32Array.from(cross);

    // 4 vertices per bond (A, mid, mid, B), 6 per cross.
    const nv = bonds.length * 4 + cross.length * 6;
    this.positions = new Float32Array(nv * 3);
    this.colors = new Float32Array(nv * 3);
    this.geometry = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(this.positions, 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', pos);
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.material = new THREE.LineBasicMaterial({ vertexColors: true });
    applyOpacity(this.material, opts.opacity);
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.name = 'atoms:lines';
    this.object.frustumCulled = false;
    this.setColors(colors);
    this.writeAll();
  }

  pickData(): LinePickData {
    return { kind: 'lines', atoms: this.atoms, bonds: this.bonds, bondA: this.bondA, bondB: this.bondB };
  }

  updateCoordinates(mol: Molecule, changed: Int32Array | null): void {
    this.mol = mol;
    this.version++;
    if (!changed || changed.length > this.atoms.length / 4) {
      this.writeAll();
      return;
    }
    const attr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    let lo = Infinity;
    let hi = -1;
    const mark = (v0: number, nv: number) => {
      if (v0 < lo) lo = v0;
      if (v0 + nv - 1 > hi) hi = v0 + nv - 1;
    };
    const crossBase = this.bonds.length * 4;
    for (const i of changed) {
      for (const bi of this.topo.atomBonds[i]) {
        const d = this.bondToDisplayed[bi];
        if (d < 0) continue;
        this.writeBond(d);
        mark(d * 4, 4);
      }
      const c = this.atomToCross[i];
      if (c >= 0) {
        this.writeCross(c);
        mark(crossBase + c * 6, 6);
      }
    }
    if (hi >= 0) {
      attr.addUpdateRange(lo * 3, (hi - lo + 1) * 3);
      attr.needsUpdate = true;
    }
  }

  setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.radii.fill(LINES_NOMINAL_RADIUS * scale);
    this.version++;
    this.writeAll(); // cross size follows the scale
  }

  setColors(srgb: Float32Array): void {
    const lin = toLinearColors(srgb);
    const c = this.colors;
    const put = (v: number, atom: number) => {
      c[v * 3] = lin[atom * 3];
      c[v * 3 + 1] = lin[atom * 3 + 1];
      c[v * 3 + 2] = lin[atom * 3 + 2];
    };
    for (let d = 0; d < this.bonds.length; d++) {
      const a = this.bondA[d];
      const b = this.bondB[d];
      put(d * 4, a);
      put(d * 4 + 1, a);
      put(d * 4 + 2, b);
      put(d * 4 + 3, b);
    }
    const base = this.bonds.length * 4;
    for (let k = 0; k < this.crossAtoms.length; k++) for (let v = 0; v < 6; v++) put(base + k * 6 + v, this.crossAtoms[k]);
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  setOpacity(opacity: number): void {
    applyOpacity(this.material, opacity);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  // ---- internals ----

  private writeAll() {
    for (let d = 0; d < this.bonds.length; d++) this.writeBond(d);
    for (let k = 0; k < this.crossAtoms.length; k++) this.writeCross(k);
    const attr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.clearUpdateRanges();
    attr.needsUpdate = true;
  }

  private writeBond(d: number) {
    const A = this.mol.atoms[this.bondA[d]];
    const B = this.mol.atoms[this.bondB[d]];
    const p = this.positions;
    const o = d * 12;
    const mx = (A.x + B.x) / 2;
    const my = (A.y + B.y) / 2;
    const mz = (A.z + B.z) / 2;
    p[o] = A.x;
    p[o + 1] = A.y;
    p[o + 2] = A.z;
    p[o + 3] = mx;
    p[o + 4] = my;
    p[o + 5] = mz;
    p[o + 6] = mx;
    p[o + 7] = my;
    p[o + 8] = mz;
    p[o + 9] = B.x;
    p[o + 10] = B.y;
    p[o + 11] = B.z;
  }

  private writeCross(k: number) {
    const a = this.mol.atoms[this.crossAtoms[k]];
    const h = CROSS_HALF * this.scale;
    const p = this.positions;
    let o = (this.bonds.length * 4 + k * 6) * 3;
    const seg = (dx: number, dy: number, dz: number) => {
      p[o++] = a.x - dx;
      p[o++] = a.y - dy;
      p[o++] = a.z - dz;
      p[o++] = a.x + dx;
      p[o++] = a.y + dy;
      p[o++] = a.z + dz;
    };
    seg(h, 0, 0);
    seg(0, h, 0);
    seg(0, 0, h);
  }
}
