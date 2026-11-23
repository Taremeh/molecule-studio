/**
 * Shared types for the representation objects built by render-core (atoms / lines) and consumed by
 * the Viewer and the picker. OWNER: render-core.
 */
import type * as THREE from 'three';
import type { Molecule } from '../core/types';

export type Quality = 'low' | 'medium' | 'high';

/** Pick data of sphere/cylinder representations (ball-and-stick, spacefill, licorice). */
export interface SpherePickData {
  kind: 'spheres';
  /** Displayed atom indices. */
  atoms: Int32Array;
  /** Scaled display radius per displayed atom. */
  radii: Float32Array;
  /** Displayed bonds (indices into mol.bonds) and their endpoint atom indices. */
  bonds: Int32Array;
  bondA: Int32Array;
  bondB: Int32Array;
  /** Scaled pick radius per displayed bond. */
  bondRadii: Float32Array;
}

/** Pick data of the 'lines' representation (screen-space tolerance). */
export interface LinePickData {
  kind: 'lines';
  atoms: Int32Array;
  bonds: Int32Array;
  bondA: Int32Array;
  bondB: Int32Array;
}

/** An atom-based representation instance (render-core). */
export interface AtomRepInstance {
  readonly object: THREE.Object3D;
  /** Displayed atom indices. */
  readonly atoms: Int32Array;
  /** Increments whenever pick-relevant data (coordinates, radii) changes. */
  readonly version: number;
  /** Nominal display radius per displayed atom (same order as `atoms`), scaled. */
  readonly radii: Float32Array;
  pickData(): SpherePickData | LinePickData;
  /**
   * Coordinates changed but not the structure. `changed` lists the atom indices whose Atom object
   * changed (null = assume all).
   */
  updateCoordinates(mol: Molecule, changed: Int32Array | null): void;
  setScale(scale: number): void;
  /** Per-atom sRGB colours (atoms × 3), as returned by computeAtomColors. */
  setColors(colors: Float32Array): void;
  setOpacity(opacity: number): void;
  dispose(): void;
}
