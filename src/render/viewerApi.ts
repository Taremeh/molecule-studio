/**
 * Imperative viewer API — the contract between the 3D renderer (render/Viewer.ts) and everything else
 * (editor controller, UI buttons). OWNER: integration.
 *
 * World space == molecule coordinates (Å). Client coordinates are CSS pixels as in PointerEvent.clientX/Y.
 */
import type { Vec3 } from '../core/types';

export interface PickResult {
  kind: 'atom' | 'bond';
  atomId?: number;
  bondId?: number;
  /** World-space point where the ray hit the displayed geometry. */
  point: Vec3;
}

export interface ViewerApi {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /**
   * Pick the nearest atom or bond under a client-space point. Only considers what is displayed
   * (visible representations; hidden hydrogens are not pickable). Atom hits take priority over
   * bonds when both are within ~2 px. For cartoon/surface hits, returns the nearest atom of that
   * representation's selection to the hit point (kind 'atom').
   */
  pick(clientX: number, clientY: number): PickResult | null;
  /** All atom ids whose projected centers fall inside the client-space rectangle (displayed atoms only). */
  pickRect(x0: number, y0: number, x1: number, y1: number): number[];
  /** Intersect the pointer ray with the camera-facing plane that passes through `planePoint`. */
  screenToWorldOnPlane(clientX: number, clientY: number, planePoint: Vec3): Vec3;
  /** Project a world point to client coordinates. `visible` is false if behind the camera / outside the canvas. */
  worldToScreen(p: Vec3): { x: number; y: number; visible: boolean };
  /** Unit vector from the camera towards the orbit target. */
  getViewDirection(): Vec3;
  /** Current orbit/rotation center. */
  getTarget(): Vec3;
  /** Frame the given atoms (or the whole molecule if omitted / empty). */
  focusAtoms(atomIds?: number[], animate?: boolean): void;
  /** Reset to the default view of the whole molecule. */
  resetView(): void;
  /** Rotate the camera to look along a principal axis. */
  viewAlong(axis: 'x' | 'y' | 'z'): void;
  /** Enable/disable camera interaction (used while dragging atoms). */
  setControlsEnabled(enabled: boolean): void;
  /** Render a PNG of the current view at `scale` × the canvas resolution. */
  screenshot(opts?: { scale?: number; transparent?: boolean }): Promise<Blob>;
  /** Schedule a redraw (rendering is on demand). */
  requestRender(): void;
  dispose(): void;
}

let current: ViewerApi | null = null;

export function setViewer(v: ViewerApi | null) {
  current = v;
}

export function getViewer(): ViewerApi | null {
  return current;
}
