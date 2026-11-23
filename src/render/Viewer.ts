/**
 * Three.js viewer: scene, camera, controls, representations, picking, overlays.
 * OWNER: render-core agent. Implements ViewerApi (render/viewerApi.ts).
 * See ARCHITECTURE.md § Renderer for the full specification.
 *
 * Structure
 *  - Store changes only mark the viewer "store-dirty"; they are applied once per animation frame (or
 *    synchronously before an API call that needs an up-to-date scene, e.g. pick()).
 *  - A continuous requestAnimationFrame loop updates TrackballControls (damping) and renders only when
 *    something changed (camera moved, store change, resize, animation).
 *  - Representations are cached per layer: structure key (style, selection, quality, hydrogen filter,
 *    structureVersion, documentId) → rebuild; colour / scale / opacity / coordinates → updated in place.
 *  - World space = molecule coordinates (Å); the camera orbits the controls' target.
 */
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import type { PickResult, ViewerApi } from './viewerApi';
import type { Molecule, Representation, Vec3, ViewSettings } from '../core/types';
import { ATOM_STYLES } from '../core/types';
import { useStore, type AppState } from '../state/store';
import { getTopology } from '../core/molecule';
import { evaluateSelection } from '../core/selection';
import { computeAtomColors } from './colors';
import { buildCartoon } from './reps/cartoon';
import { buildSurface } from './reps/surface';
import { AtomRep, changedAtomIndices, displayRadius, type SphereStyle } from './reps/atoms';
import { LinesRep } from './reps/lines';
import type { AtomRepInstance, LinePickData, Quality, SpherePickData } from './repTypes';
import { Picker, type MeshPickSource, type PickRay } from './picking';
import { OverlayLayer } from './overlays';
import { LabelLayer, collectAtomLabels, drawLabels, type AtomLabel, type LabelDrawItem, type ScreenPoint } from './labels';
import { easeInOutCubic, fitDistance, hexLuminance } from './math3d';

const FOV = 35;
const FOCUS_MS = 350;
const SURFACE_DEBOUNCE_MS = 300;
const AUTO_ROTATE_RAD_PER_S = 0.35;
/**
 * Framing radius (Å) of an empty document, around the origin where the editor puts the first atom: close
 * enough that the first atoms are drawn at a useful size, with room for the molecule to grow.
 */
const EMPTY_VIEW_RADIUS = 4;
/** Atom names whose movement can change a cartoon (backbone trace / orientation). */
const CARTOON_ATOMS = new Set(['CA', 'C', 'N', 'O', 'OXT', 'P', 'OP1', 'OP2', "O5'", "C5'", "C4'", "C3'", "O3'", "C1'"]);

interface CameraPose {
  target: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** World-space height of the view at the target plane. */
  viewHeight: number;
}

interface CameraAnimation {
  from: CameraPose;
  to: CameraPose;
  start: number;
  duration: number;
}

interface RepEntry {
  id: string;
  rep: Representation;
  structKey: string;
  colorKey: string;
  /** Molecule the displayed geometry currently reflects. */
  mol: Molecule | null;
  /** Molecule / mask the mesh (cartoon / surface) object was built from. */
  builtMol: Molecule | null;
  mask: Uint8Array | null;
  atomRep: AtomRepInstance | null;
  object: THREE.Object3D | null;
  abort: AbortController | null;
  token: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastBuildMs: number;
  /** Scale / opacity currently applied to the geometry (may lag e.rep while the layer is hidden). */
  appliedScale: number;
  appliedOpacity: number;
  /** Style of the currently displayed object (a surface may still be shown while a new one builds). */
  objectStyle: Representation['style'] | null;
}

/** Renderer pixel ratio for the current display (capped at 2). */
function targetPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

function isAtomStyle(style: Representation['style']): boolean {
  return ATOM_STYLES.includes(style);
}

/** Dispose geometries / materials of an object built by another module (cartoon / surface). */
function disposeObject(obj: THREE.Object3D | null) {
  if (!obj) return;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
  });
  obj.removeFromParent();
}

/** Apply opacity to every material of an externally built object. */
function setObjectOpacity(obj: THREE.Object3D, opacity: number) {
  const transparent = opacity < 0.999;
  obj.traverse((o) => {
    const mat = (o as { material?: THREE.Material | THREE.Material[] }).material;
    const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const m of mats) {
      if (m.transparent !== transparent) m.needsUpdate = true;
      m.transparent = transparent;
      m.opacity = opacity;
      m.depthWrite = !transparent;
    }
  });
}

/** Selection mask for a layer (copied: cached masks are shared), with the hydrogen filter applied. */
function layerMask(mol: Molecule, query: string, hideH: boolean): Uint8Array {
  const n = mol.atoms.length;
  const mask = new Uint8Array(n);
  try {
    const res = evaluateSelection(mol, query.trim() === '' ? 'all' : query);
    if (!res.error) mask.set(res.mask.length > n ? res.mask.subarray(0, n) : res.mask);
  } catch (e) {
    console.warn('[viewer] selection failed:', query, e);
  }
  if (hideH) for (let i = 0; i < n; i++) if (mask[i] && mol.atoms[i].element === 'H') mask[i] = 0;
  return mask;
}

/**
 * Indices of atoms drawn by at least one visible layer, or null when that is every atom or nothing
 * (then the whole molecule is framed).
 */
function visibleAtomIndices(mol: Molecule, s: Pick<AppState, 'reps' | 'view' | 'mode'>): number[] | null {
  const n = mol.atoms.length;
  const hideH = !s.view.showHydrogens && s.mode === 'view';
  const shown = new Uint8Array(n);
  for (const rep of s.reps) {
    if (!rep.visible) continue;
    const m = layerMask(mol, rep.selection, hideH);
    for (let i = 0; i < n; i++) shown[i] |= m[i];
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (shown[i]) idx.push(i);
  return idx.length === 0 || idx.length === n ? null : idx;
}

function layerColors(mol: Molecule, rep: Representation): Float32Array {
  try {
    const c = computeAtomColors(mol, rep.color, rep.uniformColor);
    if (c.length === mol.atoms.length * 3) return c;
  } catch (e) {
    console.warn('[viewer] colour scheme failed:', rep.color, e);
  }
  return new Float32Array(mol.atoms.length * 3).fill(0.7);
}

function masksEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function stopControlsMomentum(controls: TrackballControls) {
  // TrackballControls keeps its momentum in private fields; neutralise them so animations are not
  // fought by residual damping. Guarded in case the internals change.
  const c = controls as unknown as Record<string, unknown>;
  const copy = (a: string, b: string) => {
    const va = c[a] as THREE.Vector2 | undefined;
    const vb = c[b] as THREE.Vector2 | undefined;
    if (va && vb && typeof va.copy === 'function') va.copy(vb);
  };
  copy('_movePrev', '_moveCurr');
  copy('_zoomStart', '_zoomEnd');
  copy('_panStart', '_panEnd');
  if (typeof c._lastAngle === 'number') c._lastAngle = 0;
}

export class Viewer implements ViewerApi {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private perspCam: THREE.PerspectiveCamera;
  private orthoCam: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private controls: TrackballControls;
  private rig = new THREE.Group();
  private fog: THREE.Fog;
  private repRoot = new THREE.Group();
  private overlays = new OverlayLayer();
  private labels = new LabelLayer();
  private picker = new Picker();
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribe: () => void;

  private entries = new Map<string, RepEntry>();
  private lastState: AppState | null = null;
  private storeDirty = true;
  private dirty = true;
  private disposed = false;
  private contextLost = false;
  private raf = 0;
  private lastFrame = 0;
  private interacting = false;
  private anim: CameraAnimation | null = null;

  private width = 1;
  private height = 1;
  private sceneCenter = new THREE.Vector3();
  private sceneRadius = 10;
  private fogEnabled = true;
  private autoRotate = false;
  private lightBackground = false;

  /** Per atom index: display radius (largest among atom layers; 0 = not drawn by an atom layer). */
  private atomRadius = new Float32Array(0);
  /** Per atom index: displayed by any visible layer (for pickRect). */
  private displayed = new Uint8Array(0);
  private displayMol: Molecule | null = null;
  private radiiVersion = 0;
  private atomLabels: AtomLabel[] = [];
  private labelKey: unknown[] = [];

  // Scratch objects.
  private _v = new THREE.Vector3();
  private _v2 = new THREE.Vector3();
  private _m = new THREE.Matrix4();

  constructor(container: HTMLElement) {
    this.container = container;
    // Create the renderer first: if WebGL is unavailable this throws before anything is attached.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'viewport-gl';
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' });
    this.renderer.setPixelRatio(targetPixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.canvas);
    container.appendChild(this.labels.canvas);

    const state = useStore.getState();
    this.width = Math.max(1, container.clientWidth);
    this.height = Math.max(1, container.clientHeight);
    const aspect = this.width / this.height;
    this.perspCam = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 2000);
    this.orthoCam = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, -1000, 1000);
    this.perspCam.position.set(0, 0, 50);
    this.orthoCam.position.set(0, 0, 50);
    this.camera = state.view.projection === 'orthographic' ? this.orthoCam : this.perspCam;

    // Lights follow the camera (rig copies the camera transform before every render).
    const ambient = new THREE.AmbientLight(0xffffff, 0.95);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-1, 1.1, 2);
    key.target.position.set(0, 0, -1);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55);
    fill.position.set(1.2, -0.6, 1);
    fill.target.position.set(0, 0, -1);
    this.rig.add(ambient, key, key.target, fill, fill.target);
    this.scene.add(this.rig, this.repRoot, this.overlays.group);
    // A Fog object is always attached (toggling it would recompile programs); "off" = pushed far away.
    this.fog = new THREE.Fog(state.view.background, 1e6, 2e6);
    this.scene.fog = this.fog;

    this.controls = new TrackballControls(this.camera, this.canvas);
    this.controls.rotateSpeed = 3;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.9;
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.15;
    // TrackballControls listens to window keydown for A/S/D: neutralise (our shortcuts use those keys).
    this.controls.keys = ['__none_rotate__', '__none_zoom__', '__none_pan__'];
    this.controls.addEventListener('change', this.onControlsChange);
    this.controls.addEventListener('start', this.onControlsStart);
    this.controls.addEventListener('end', this.onControlsEnd);
    // The controls cache the canvas position; refresh it at the start of every gesture.
    container.addEventListener('pointerdown', this.onPointerDownCapture, { capture: true });

    this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(container);
    }
    this.handleResize();

    this.unsubscribe = useStore.subscribe(() => {
      this.storeDirty = true;
    });
    this.flush();
    this.raf = requestAnimationFrame(this.frame);
    (window as unknown as { __viewerInstance?: Viewer }).__viewerInstance = this;
  }

  // ===========================================================================
  // ViewerApi
  // ===========================================================================

  pick(clientX: number, clientY: number): PickResult | null {
    if (this.disposed) return null;
    this.flushIfNeeded();
    const mol = this.picker.molecule;
    if (!mol || mol.atoms.length === 0) return null;
    const ray = this.rayFromClient(clientX, clientY);
    if (!ray) return null;
    const hit = this.picker.pick(ray, this.pixelSizeFn());
    if (!hit) return null;
    if (hit.kind === 'atom') {
      const atom = mol.atoms[hit.index];
      return atom ? { kind: 'atom', atomId: atom.id, point: hit.point } : null;
    }
    const bond = mol.bonds[hit.index];
    return bond ? { kind: 'bond', bondId: bond.id, point: hit.point } : null;
  }

  pickRect(x0: number, y0: number, x1: number, y1: number): number[] {
    if (this.disposed) return [];
    this.flushIfNeeded();
    const mol = this.displayMol;
    if (!mol) return [];
    const rect = this.canvas.getBoundingClientRect();
    const lx = Math.min(x0, x1) - rect.left;
    const hx = Math.max(x0, x1) - rect.left;
    const ly = Math.min(y0, y1) - rect.top;
    const hy = Math.max(y0, y1) - rect.top;
    this.syncCamera();
    const e = this._m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const w = rect.width;
    const h = rect.height;
    const out: number[] = [];
    const shown = this.displayed;
    const atoms = mol.atoms;
    for (let i = 0; i < atoms.length; i++) {
      if (!shown[i]) continue;
      const a = atoms[i];
      const cw = e[3] * a.x + e[7] * a.y + e[11] * a.z + e[15];
      if (cw <= 0) continue;
      const cx = (e[0] * a.x + e[4] * a.y + e[8] * a.z + e[12]) / cw;
      const cy = (e[1] * a.x + e[5] * a.y + e[9] * a.z + e[13]) / cw;
      const cz = (e[2] * a.x + e[6] * a.y + e[10] * a.z + e[14]) / cw;
      if (cz < -1 || cz > 1) continue;
      const sx = ((cx + 1) / 2) * w;
      const sy = ((1 - cy) / 2) * h;
      if (sx >= lx && sx <= hx && sy >= ly && sy <= hy) out.push(a.id);
    }
    return out;
  }

  screenToWorldOnPlane(clientX: number, clientY: number, planePoint: Vec3): Vec3 {
    const ray = this.rayFromClient(clientX, clientY);
    if (!ray) return [...planePoint] as Vec3;
    const n = this.camera.getWorldDirection(this._v2);
    const denom = ray.dx * n.x + ray.dy * n.y + ray.dz * n.z;
    if (Math.abs(denom) < 1e-9) return [...planePoint] as Vec3;
    const t = ((planePoint[0] - ray.ox) * n.x + (planePoint[1] - ray.oy) * n.y + (planePoint[2] - ray.oz) * n.z) / denom;
    return [ray.ox + ray.dx * t, ray.oy + ray.dy * t, ray.oz + ray.dz * t];
  }

  worldToScreen(p: Vec3): { x: number; y: number; visible: boolean } {
    this.syncCamera();
    const rect = this.canvas.getBoundingClientRect();
    const v = this._v.set(p[0], p[1], p[2]);
    const fwd = this.camera.getWorldDirection(this._v2);
    const depth = (v.x - this.camera.position.x) * fwd.x + (v.y - this.camera.position.y) * fwd.y + (v.z - this.camera.position.z) * fwd.z;
    v.project(this.camera);
    const x = rect.left + ((v.x + 1) / 2) * rect.width;
    const y = rect.top + ((1 - v.y) / 2) * rect.height;
    const inFront = this.camera === this.perspCam ? depth > 0 : true;
    const visible = inFront && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    return { x, y, visible };
  }

  getViewDirection(): Vec3 {
    this.syncCamera();
    const d = this.camera.getWorldDirection(this._v2);
    return [d.x, d.y, d.z];
  }

  getTarget(): Vec3 {
    const t = this.controls.target;
    return [t.x, t.y, t.z];
  }

  focusAtoms(atomIds?: number[], animate = true): void {
    const mol = useStore.getState().molecule;
    if (!mol || this.disposed) return;
    const topo = getTopology(mol);
    let idx: number[] = [];
    if (atomIds && atomIds.length) {
      for (const id of atomIds) {
        const i = topo.idToIndex.get(id);
        if (i !== undefined) idx.push(i);
      }
    }
    const subset = idx.length > 0;
    // Without a subset, frame what is drawn (hidden waters scattered around a crystal structure
    // would otherwise shrink the molecule to a fraction of the view).
    if (!subset) idx = visibleAtomIndices(mol, useStore.getState()) ?? mol.atoms.map((_, i) => i);
    const sphere = this.boundingSphereOf(mol, idx, subset ? 4 : 3);
    const pose: CameraPose = {
      target: sphere.center,
      quaternion: this.camera.quaternion.clone(),
      viewHeight: this.fitViewHeight(sphere.radius),
    };
    this.goTo(pose, animate);
  }

  resetView(): void {
    this.resetViewInternal(true);
  }

  viewAlong(axis: 'x' | 'y' | 'z'): void {
    const eye = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const up = axis === 'y' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4().lookAt(eye, new THREE.Vector3(0, 0, 0), up);
    const pose = this.getPose();
    pose.quaternion = new THREE.Quaternion().setFromRotationMatrix(m);
    this.goTo(pose, true);
  }

  setControlsEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
    if (!enabled) stopControlsMomentum(this.controls);
  }

  async screenshot(opts: { scale?: number; transparent?: boolean } = {}): Promise<Blob> {
    if (this.disposed) throw new Error('Viewer is disposed');
    if (this.contextLost) throw new Error('The 3D context is not available right now');
    this.flushIfNeeded();
    const requested = Math.max(0.25, Math.min(8, opts.scale ?? 1));
    const transparent = !!opts.transparent;
    const basePR = this.renderer.getPixelRatio();
    const gl = this.renderer.getContext();
    const maxDim = Math.min(
      (gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number) || 4096,
      ((gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null)?.[0] as number) || 4096,
      16384,
    );
    const scale = Math.min(requested, maxDim / (this.width * basePR), maxDim / (this.height * basePR));
    const bg = this.lastState?.view.background ?? '#000000';
    const fogNear = this.fog.near;
    const fogFar = this.fog.far;
    let out: HTMLCanvasElement;
    try {
      this.renderer.setPixelRatio(basePR * scale);
      if (transparent) this.renderer.setClearColor(bg, 0);
      this.prepareFrame();
      if (transparent) {
        this.fog.near = 1e6;
        this.fog.far = 2e6;
      }
      this.renderer.render(this.scene, this.camera);
      // Copy synchronously, before the browser may discard the drawing buffer.
      out = document.createElement('canvas');
      out.width = gl.drawingBufferWidth;
      out.height = gl.drawingBufferHeight;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('Could not create an image canvas');
      ctx.drawImage(this.canvas, 0, 0, out.width, out.height);
      const k = out.width / this.width;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawLabels(ctx, this.labelDrawItems(), this.projector(), { dark: !this.lightBackground }, this.width, this.height);
    } finally {
      this.renderer.setPixelRatio(basePR);
      this.renderer.setClearColor(bg, 1);
      this.fog.near = fogNear;
      this.fog.far = fogFar;
      this.renderNow();
    }
    return new Promise<Blob>((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), 'image/png');
    });
  }

  requestRender(): void {
    this.dirty = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsubscribe();
    this.resizeObserver?.disconnect();
    this.container.removeEventListener('pointerdown', this.onPointerDownCapture, { capture: true });
    this.controls.removeEventListener('change', this.onControlsChange);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.controls.removeEventListener('end', this.onControlsEnd);
    this.controls.dispose();
    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries.clear();
    this.overlays.dispose();
    this.labels.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
    this.renderer.dispose();
    // Free the GL context right away (browsers cap the number of live contexts; StrictMode remounts).
    this.renderer.forceContextLoss();
    this.canvas.remove();
    const w = window as unknown as { __viewerInstance?: Viewer };
    if (w.__viewerInstance === this) w.__viewerInstance = undefined;
  }

  // ===========================================================================
  // Frame loop
  // ===========================================================================

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    // devicePixelRatio changes (browser zoom, window moved to another display) do not always resize the
    // container, so the ResizeObserver alone would leave both canvases at the old resolution (blurry).
    if (targetPixelRatio() !== this.renderer.getPixelRatio()) this.handleResize();
    if (this.storeDirty) this.flush();
    if (this.anim) this.stepAnimation(now);
    // Not while the editor has the controls disabled (atom drag): its drag plane follows the view.
    else if (this.autoRotate && !this.interacting && this.controls.enabled && dt > 0) this.autoRotateStep(dt);
    this.controls.update();
    if (this.overlays.animate(now)) this.dirty = true;
    if (this.dirty) this.renderNow();
  };

  private renderNow() {
    if (this.disposed || this.contextLost) return;
    this.prepareFrame();
    this.renderer.render(this.scene, this.camera);
    this.labels.draw(this.labelDrawItems(), this.projector(), { dark: !this.lightBackground });
    this.dirty = false;
  }

  /** Clipping planes, fog and light rig for the current camera. */
  private prepareFrame() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const fwd = cam.getWorldDirection(this._v2);
    const c = this.sceneCenter;
    const R = this.sceneRadius;
    const dCenter = (c.x - cam.position.x) * fwd.x + (c.y - cam.position.y) * fwd.y + (c.z - cam.position.z) * fwd.z;
    const margin = 2 + R * 0.05;
    // Also keep a slab around the orbit target: atoms / ghosts are created on the plane through it,
    // which may lie outside the molecule's bounding sphere after panning.
    const t = this.controls.target;
    const dTarget = (t.x - cam.position.x) * fwd.x + (t.y - cam.position.y) * fwd.y + (t.z - cam.position.z) * fwd.z;
    let near: number;
    let far: number;
    if (cam === this.perspCam) {
      far = Math.max(dCenter + R + margin, dTarget + 6, 1);
      near = Math.max(Math.min(dCenter - R - margin, dTarget - 6), far / 5000, 0.05);
    } else {
      near = Math.min(dCenter - R - margin, dTarget - 6);
      far = Math.max(dCenter + R + margin, dTarget + 6);
    }
    if (Math.abs(cam.near - near) > 1e-4 || Math.abs(cam.far - far) > 1e-4) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    if (this.fogEnabled) {
      this.fog.near = Math.max(0, dCenter - 0.1 * R);
      this.fog.far = dCenter + 2.6 * R;
    } else {
      this.fog.near = 1e6;
      this.fog.far = 2e6;
    }
    this.rig.position.copy(cam.position);
    this.rig.quaternion.copy(cam.quaternion);
  }

  private onControlsChange = () => {
    this.dirty = true;
  };
  private onControlsStart = () => {
    this.interacting = true;
    this.anim = null;
  };
  private onControlsEnd = () => {
    this.interacting = false;
  };
  private onPointerDownCapture = () => {
    this.controls.handleResize();
  };
  private onContextLost = (ev: Event) => {
    ev.preventDefault();
    this.contextLost = true;
    if (!this.disposed) console.warn('[viewer] WebGL context lost; waiting for it to be restored…');
  };
  private onContextRestored = () => {
    this.contextLost = false;
    console.info('[viewer] WebGL context restored');
    this.dirty = true;
  };

  private handleResize() {
    if (this.disposed) return;
    const pr = targetPixelRatio();
    if (pr !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(pr);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.perspCam.aspect = aspect;
    this.perspCam.updateProjectionMatrix();
    this.orthoCam.left = -aspect;
    this.orthoCam.right = aspect;
    this.orthoCam.top = 1;
    this.orthoCam.bottom = -1;
    this.orthoCam.updateProjectionMatrix();
    this.controls.handleResize();
    this.labels.resize(w, h, this.renderer.getPixelRatio());
    // Render immediately so the canvas never shows a stretched frame.
    this.renderNow();
  }

  // ===========================================================================
  // Store → scene
  // ===========================================================================

  private flushIfNeeded() {
    if (this.storeDirty) this.flush();
  }

  private flush() {
    if (this.disposed) return;
    this.storeDirty = false;
    const s = useStore.getState();
    const p = this.lastState;
    this.lastState = s;
    const docChanged = !p || s.documentId !== p.documentId;
    // An empty document (new molecule, or everything deleted) that just got atoms back.
    const firstAtoms = !docChanged && !!p?.molecule && p.molecule.atoms.length === 0 && !!s.molecule && s.molecule.atoms.length > 0;
    const repsChanged =
      !p ||
      s.molecule !== p.molecule ||
      s.reps !== p.reps ||
      s.view.showHydrogens !== p.view.showHydrogens ||
      s.view.quality !== p.view.quality ||
      s.mode !== p.mode ||
      s.documentId !== p.documentId;
    if (!p || s.view !== p.view) this.applyView(s.view, p?.view ?? null);
    if (repsChanged) this.syncReps(s, p);
    if (!p || s.molecule !== p.molecule) this.updateSceneBounds(s.molecule);
    this.syncOverlays(s);
    this.syncLabels(s);
    if (docChanged && (s.molecule || !p)) this.resetViewInternal(false);
    else if (firstAtoms) {
      // Undo / redo back to atoms (e.g. undoing "delete all") restores the earlier scene: keep the
      // camera unless none of them is on screen any more (the view was moved while the document was empty).
      const m = s.molecule!;
      const historyStep = p!.past.at(-1)?.molecule === m || p!.future.at(-1)?.molecule === m;
      if (!historyStep || !this.anyAtomInView(m)) this.frameFirstAtoms(m);
    }
    // Redraw only for render-relevant changes (toasts, hints, panels… do not need a frame).
    if (
      !p ||
      repsChanged ||
      s.view !== p.view ||
      s.selection !== p.selection ||
      s.hovered !== p.hovered ||
      s.editOverlay !== p.editOverlay ||
      s.measurements !== p.measurements ||
      s.pendingMeasure !== p.pendingMeasure ||
      s.measureKind !== p.measureKind
    )
      this.dirty = true;
  }

  private hideHydrogens(s: AppState): boolean {
    return !s.view.showHydrogens && s.mode === 'view';
  }

  private applyView(v: ViewSettings, prev: ViewSettings | null) {
    if (!prev || v.background !== prev.background) {
      this.renderer.setClearColor(v.background, 1);
      this.fog.color.set(v.background);
      this.lightBackground = hexLuminance(v.background) > 0.4;
    }
    if (prev && v.projection !== prev.projection) this.setProjection(v.projection);
    else if (!prev) this.setProjection(v.projection);
    this.fogEnabled = v.fog;
    this.autoRotate = v.autoRotate;
  }

  private setProjection(projection: ViewSettings['projection']) {
    const next = projection === 'orthographic' ? this.orthoCam : this.perspCam;
    if (next === this.camera) return;
    const pose = this.getPose();
    this.camera = next;
    this.controls.object = next;
    this.applyPose(pose);
    stopControlsMomentum(this.controls);
    this.dirty = true;
  }

  private syncReps(s: AppState, prev: AppState | null) {
    const mol = s.molecule;
    if (!mol) {
      for (const e of this.entries.values()) this.disposeEntry(e);
      this.entries.clear();
      this.afterRepsChanged(null);
      return;
    }
    const hideH = this.hideHydrogens(s);
    const quality = s.view.quality;
    const base = `${s.documentId}|${s.structureVersion}|${quality}|${hideH ? 1 : 0}|${mol.atoms.length}|${mol.bonds.length}`;
    const diffs = new Map<Molecule, Int32Array>();
    const diffFrom = (old: Molecule): Int32Array => {
      let d = diffs.get(old);
      if (!d) {
        d = changedAtomIndices(old, mol);
        diffs.set(old, d);
      }
      return d;
    };
    let displayChanged = false;
    const seen = new Set<string>();

    for (const rep of s.reps) {
      seen.add(rep.id);
      let e = this.entries.get(rep.id);
      if (!e) {
        e = {
          id: rep.id,
          rep,
          structKey: '',
          colorKey: '',
          mol: null,
          builtMol: null,
          mask: null,
          atomRep: null,
          object: null,
          abort: null,
          token: 0,
          timer: null,
          lastBuildMs: 0,
          appliedScale: rep.scale,
          appliedOpacity: rep.opacity,
          objectStyle: null,
        };
        this.entries.set(rep.id, e);
      }
      e.rep = rep;
      if (!rep.visible) {
        if (e.object && e.object.visible) {
          e.object.visible = false;
          displayChanged = true;
        }
        continue;
      }
      const atomStyle = isAtomStyle(rep.style);
      const structKey = atomStyle
        ? `${rep.style}|${rep.selection}|${base}`
        : `${rep.style}|${rep.selection}|${rep.color}|${rep.uniformColor}|${rep.scale}|${base}`;
      const colorKey = `${rep.color}|${rep.uniformColor}`;

      if (e.structKey !== structKey) {
        this.buildEntry(e, mol, hideH, quality, false);
        e.structKey = structKey;
        e.colorKey = colorKey;
        displayChanged = true;
        continue;
      }

      // Same structure: update in place.
      if (atomStyle && e.atomRep) {
        if (e.mol !== mol) {
          if (/\bwithin\b/i.test(rep.selection) && e.mask && !masksEqual(e.mask, layerMask(mol, rep.selection, hideH))) {
            this.buildEntry(e, mol, hideH, quality, false);
            e.colorKey = colorKey;
            displayChanged = true;
            continue;
          }
          e.atomRep.updateCoordinates(mol, e.mol ? diffFrom(e.mol) : null);
          e.mol = mol;
        }
        if (rep.scale !== e.appliedScale) {
          e.atomRep.setScale(rep.scale);
          e.appliedScale = rep.scale;
          displayChanged = true;
        }
        if (colorKey !== e.colorKey) {
          e.atomRep.setColors(layerColors(mol, rep));
          e.colorKey = colorKey;
        }
        if (rep.opacity !== e.appliedOpacity) {
          e.atomRep.setOpacity(rep.opacity);
          e.appliedOpacity = rep.opacity;
        }
      } else if (!atomStyle) {
        if (e.mol !== mol) {
          const changed = e.mol ? diffFrom(e.mol) : null;
          if (this.meshAffected(rep, e, mol, changed)) this.scheduleMeshRebuild(e, hideH, quality);
          else e.mol = mol;
        }
        if (e.object && rep.opacity !== e.appliedOpacity) {
          setObjectOpacity(e.object, rep.opacity);
          e.appliedOpacity = rep.opacity;
        }
      }
      if (e.object && !e.object.visible) {
        e.object.visible = true;
        displayChanged = true;
      }
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.disposeEntry(e);
        this.entries.delete(id);
        displayChanged = true;
      }
    }
    if (displayChanged || this.displayMol === null || this.displayMol.atoms.length !== mol.atoms.length || prev?.structureVersion !== s.structureVersion) {
      this.afterRepsChanged(mol);
    } else {
      // Coordinates only: keep the picking grid and tell it which atoms moved.
      const prevMol = this.displayMol;
      this.displayMol = mol;
      const moved = prevMol && prevMol !== mol ? diffFrom(prevMol) : new Int32Array(0);
      this.picker.moveAtoms(mol, moved, this.collectPickSources(mol).meshes);
    }
  }

  /** (Re)build a layer's geometry for `mol`. Cartoon: synchronous; surface: asynchronous. */
  private buildEntry(e: RepEntry, mol: Molecule, hideH: boolean, quality: Quality, coordinateOnly: boolean) {
    const rep = e.rep;
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    const mask = layerMask(mol, rep.selection, hideH);
    const colors = layerColors(mol, rep);
    e.appliedScale = rep.scale;
    e.appliedOpacity = rep.opacity;
    if (rep.style !== 'surface') this.cancelPendingBuild(e);
    // Only a surface keeps its previous (surface) object on screen while the new one is computed.
    this.dropGeometry(e, rep.style === 'surface' && e.objectStyle === 'surface');
    if (isAtomStyle(rep.style)) {
      let inst: AtomRepInstance | null = null;
      try {
        inst =
          rep.style === 'lines'
            ? new LinesRep(mol, mask, colors, { scale: rep.scale, opacity: rep.opacity })
            : new AtomRep(mol, mask, colors, { style: rep.style as SphereStyle, quality, scale: rep.scale, opacity: rep.opacity });
      } catch (err) {
        console.error('[viewer] failed to build layer', rep.style, err);
      }
      e.atomRep = inst;
      e.mask = mask;
      e.mol = mol;
      e.builtMol = mol;
      if (inst) this.replaceObject(e, inst.object);
      return;
    }
    if (rep.style === 'cartoon') {
      const t0 = performance.now();
      let obj: THREE.Object3D | null = null;
      try {
        obj = buildCartoon(mol, mask, colors, { opacity: rep.opacity, quality, scale: rep.scale });
      } catch (err) {
        console.error('[viewer] cartoon failed', err);
      }
      e.lastBuildMs = performance.now() - t0;
      e.mask = mask;
      e.mol = mol;
      e.builtMol = mol;
      this.replaceObject(e, obj);
      if (obj) setObjectOpacity(obj, rep.opacity);
      return;
    }
    // Surface (async). Keep the old surface visible until the new one is ready.
    e.abort?.abort();
    const ac = new AbortController();
    e.abort = ac;
    const token = ++e.token;
    e.mol = mol;
    const t0 = performance.now();
    buildSurface(mol, mask, colors, { opacity: rep.opacity, quality, scale: rep.scale }, ac.signal)
      .then((obj) => {
        if (this.disposed || ac.signal.aborted || token !== e.token || this.entries.get(e.id) !== e) {
          disposeObject(obj);
          return;
        }
        e.abort = null;
        e.lastBuildMs = performance.now() - t0;
        e.mask = mask;
        e.builtMol = mol;
        this.replaceObject(e, obj);
        if (obj) {
          setObjectOpacity(obj, e.rep.opacity);
          e.appliedOpacity = e.rep.opacity;
          obj.visible = e.rep.visible;
        }
        const cur = this.lastState?.molecule ?? null;
        this.afterRepsChanged(cur);
        this.dirty = true;
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        if (token === e.token) e.abort = null;
        console.error('[viewer] surface failed', err);
        useStore.getState().toast('Could not compute the surface for this layer', 'error');
      });
  }

  /** Does a coordinate-only change affect a cartoon / surface layer? */
  private meshAffected(rep: Representation, e: RepEntry, mol: Molecule, changed: Int32Array | null): boolean {
    if (!changed) return true;
    if (changed.length === 0) return false;
    const mask = e.mask;
    if (!mask || mask.length !== mol.atoms.length) return true;
    for (const i of changed) {
      if (!mask[i]) continue;
      if (rep.style === 'surface') return true;
      const name = mol.atoms[i].name;
      if (!name || CARTOON_ATOMS.has(name.toUpperCase())) return true;
    }
    return false;
  }

  /** Coordinate-only rebuild of a mesh layer: surfaces debounced, slow cartoons throttled. */
  private scheduleMeshRebuild(e: RepEntry, hideH: boolean, quality: Quality) {
    const run = () => {
      e.timer = null;
      if (this.disposed || this.entries.get(e.id) !== e) return;
      // Use the state the scene was last synced to, not the live store: a change that is not flushed yet
      // (e.g. a drag step made after this frame) would leave the atom layers out of the picking sources
      // (their geometry still reflects the flushed molecule). The next flush handles the newer molecule.
      const s = this.lastState;
      if (!s || !s.molecule || !e.rep.visible) return;
      this.buildEntry(e, s.molecule, this.hideHydrogens(s), s.view.quality, true);
      this.afterRepsChanged(s.molecule);
      this.dirty = true;
    };
    if (e.rep.style === 'surface') {
      if (e.timer) clearTimeout(e.timer);
      e.timer = setTimeout(run, SURFACE_DEBOUNCE_MS);
      return;
    }
    if (e.lastBuildMs < 12 && !e.timer) {
      const s = useStore.getState();
      if (s.molecule) this.buildEntry(e, s.molecule, hideH, quality, true);
      return;
    }
    if (!e.timer) e.timer = setTimeout(run, Math.max(60, 2 * e.lastBuildMs));
  }

  /** Show `obj` for the entry, disposing the previously shown mesh object. */
  private replaceObject(e: RepEntry, obj: THREE.Object3D | null) {
    if (e.object && e.object !== obj) {
      if (e.atomRep && e.atomRep.object === e.object) e.object.removeFromParent(); // owned by atomRep
      else disposeObject(e.object);
    }
    e.object = obj;
    e.objectStyle = obj ? e.rep.style : null;
    if (obj) {
      obj.visible = e.rep.visible;
      this.repRoot.add(obj);
    }
  }

  /** Release the entry's geometry; `keepMesh` keeps a cartoon / surface object on screen. */
  private dropGeometry(e: RepEntry, keepMesh: boolean) {
    if (e.atomRep) {
      e.atomRep.object.removeFromParent();
      e.atomRep.dispose();
      if (e.object === e.atomRep.object) e.object = null;
      e.atomRep = null;
    }
    if (!keepMesh && e.object) {
      disposeObject(e.object);
      e.object = null;
      e.objectStyle = null;
      e.mask = null;
      e.builtMol = null;
    }
  }

  /** Abort an in-flight asynchronous (surface) build and any scheduled rebuild. */
  private cancelPendingBuild(e: RepEntry) {
    e.abort?.abort();
    e.abort = null;
    e.token++;
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
  }

  private disposeEntry(e: RepEntry) {
    this.cancelPendingBuild(e);
    this.dropGeometry(e, false);
  }

  /** Recompute per-atom display data and picking sources after layers changed. */
  private afterRepsChanged(mol: Molecule | null) {
    this.displayMol = mol;
    this.radiiVersion++;
    const n = mol ? mol.atoms.length : 0;
    const radius = new Float32Array(n);
    const shown = new Uint8Array(n);
    if (mol) {
      for (const e of this.entries.values()) {
        if (!e.rep.visible || !e.object) continue;
        if (e.atomRep) {
          const atoms = e.atomRep.atoms;
          const radii = e.atomRep.radii;
          for (let k = 0; k < atoms.length; k++) {
            const i = atoms[k];
            if (i >= n) continue;
            shown[i] = 1;
            if (radii[k] > radius[i]) radius[i] = radii[k];
          }
        } else if (e.mask && e.builtMol && e.builtMol.atoms.length === n) {
          for (let i = 0; i < n; i++) if (e.mask[i]) shown[i] = 1;
        }
      }
    }
    this.atomRadius = radius;
    this.displayed = shown;
    this.updatePickSources(mol);
  }

  private updatePickSources(mol: Molecule | null) {
    const { spheres, lines, meshes } = this.collectPickSources(mol);
    this.picker.setSources(mol, spheres, lines, meshes);
  }

  private collectPickSources(mol: Molecule | null) {
    const spheres: SpherePickData[] = [];
    const lines: LinePickData[] = [];
    const meshes: MeshPickSource[] = [];
    if (mol) {
      for (const e of this.entries.values()) {
        if (!e.rep.visible || !e.object) continue;
        if (e.atomRep) {
          if (e.mol !== mol) continue; // stale (should not happen)
          const d = e.atomRep.pickData();
          if (d.kind === 'spheres') spheres.push(d);
          else lines.push(d);
        } else if (e.mask && e.builtMol) {
          meshes.push({ object: e.object, mol: e.builtMol, mask: e.mask });
        }
      }
    }
    return { spheres, lines, meshes };
  }

  private updateSceneBounds(mol: Molecule | null) {
    if (!mol || mol.atoms.length === 0) {
      this.sceneCenter.copy(this.controls.target);
      this.sceneRadius = 10;
      return;
    }
    let sx = 0, sy = 0, sz = 0;
    for (const a of mol.atoms) {
      sx += a.x;
      sy += a.y;
      sz += a.z;
    }
    const n = mol.atoms.length;
    const cx = sx / n, cy = sy / n, cz = sz / n;
    let r2 = 0;
    for (const a of mol.atoms) {
      const d = (a.x - cx) ** 2 + (a.y - cy) ** 2 + (a.z - cz) ** 2;
      if (d > r2) r2 = d;
    }
    this.sceneCenter.set(cx, cy, cz);
    // Room for spheres, ghosts and new atoms near the edge.
    this.sceneRadius = Math.sqrt(r2) + 4;
  }

  private radiusOf = (i: number): number => {
    const r = this.atomRadius[i];
    if (r > 0) return r;
    const mol = this.displayMol;
    const a = mol?.atoms[i];
    return a ? displayRadius(a, 'ball-and-stick', 1) : 0.4;
  };

  private syncOverlays(s: AppState) {
    const mol = s.molecule;
    const hideH = this.hideHydrogens(s);
    this.overlays.sync({
      mol,
      radiiVersion: this.radiiVersion,
      radiusOf: this.radiusOf,
      isHidden: (i) => hideH && !!mol && mol.atoms[i]?.element === 'H',
      selection: s.selection,
      hovered: s.hovered,
      editOverlay: s.editOverlay,
      measurements: s.measurements,
      pendingMeasure: s.pendingMeasure,
      measureKind: s.measureKind,
      mode: s.mode,
      showValence: s.view.showValence,
      lightBackground: this.lightBackground,
    });
  }

  private syncLabels(s: AppState) {
    const mol = s.molecule;
    const hideH = this.hideHydrogens(s);
    const key = [s.structureVersion, s.documentId, s.selection, s.view.labelMode, hideH, mol?.atoms.length ?? -1];
    if (key.length === this.labelKey.length && key.every((k, i) => k === this.labelKey[i])) return;
    this.labelKey = key;
    this.atomLabels = mol ? collectAtomLabels(mol, s.selection, s.view.labelMode, hideH) : [];
  }

  private labelDrawItems(): LabelDrawItem[] {
    const mol = this.lastState?.molecule;
    const items: LabelDrawItem[] = [];
    if (mol) {
      for (const l of this.atomLabels) {
        const a = mol.atoms[l.atomIndex];
        if (a) items.push({ x: a.x, y: a.y, z: a.z, text: l.text, kind: 'atom' });
      }
    }
    for (const it of this.overlays.labelItems) items.push(it);
    return items;
  }

  /** World → canvas CSS pixel projection for the label layer (depth normalised over the scene). */
  private projector(): (x: number, y: number, z: number) => ScreenPoint {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const e = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const pos = cam.position.clone();
    const c = this.sceneCenter;
    const R = this.sceneRadius;
    const dCenter = (c.x - pos.x) * fwd.x + (c.y - pos.y) * fwd.y + (c.z - pos.z) * fwd.z;
    const w = this.width;
    const h = this.height;
    return (x, y, z) => {
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw <= 1e-9) return { x: 0, y: 0, depth: 1, visible: false };
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
      const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
      const nz = (e[2] * x + e[6] * y + e[10] * z + e[14]) / cw;
      const depth = (x - pos.x) * fwd.x + (y - pos.y) * fwd.y + (z - pos.z) * fwd.z;
      return {
        x: ((nx + 1) / 2) * w,
        y: ((1 - ny) / 2) * h,
        depth: (depth - (dCenter - R)) / (2 * R),
        visible: nz >= -1 && nz <= 1,
      };
    };
  }

  // ===========================================================================
  // Camera
  // ===========================================================================

  private syncCamera() {
    this.camera.updateMatrixWorld();
  }

  /** Pointer ray in world space. Orthographic rays start well in front of the scene. */
  private rayFromClient(clientX: number, clientY: number): PickRay | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    const cam = this.camera;
    cam.updateMatrixWorld();
    if (cam === this.perspCam) {
      const o = cam.position;
      const p = this._v.set(nx, ny, 0.5).unproject(cam);
      const d = p.sub(o).normalize();
      return { ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z };
    }
    const d = cam.getWorldDirection(this._v2);
    const p = this._v.set(nx, ny, 0).unproject(cam);
    const back = this.sceneRadius * 4 + p.distanceTo(this.sceneCenter) + 50;
    return { ox: p.x - d.x * back, oy: p.y - d.y * back, oz: p.z - d.z * back, dx: d.x, dy: d.y, dz: d.z };
  }

  /** World size of one CSS pixel at ray distance t. */
  private pixelSizeFn(): (t: number) => number {
    const h = Math.max(1, this.canvas.getBoundingClientRect().height || this.height);
    if (this.camera === this.perspCam) {
      const k = (2 * Math.tan((this.perspCam.fov * Math.PI) / 360)) / h;
      return (t) => k * t;
    }
    const cam = this.orthoCam;
    const size = (cam.top - cam.bottom) / cam.zoom / h;
    return () => size;
  }

  private getPose(): CameraPose {
    const target = this.controls.target.clone();
    const quaternion = this.camera.quaternion.clone();
    let viewHeight: number;
    if (this.camera === this.perspCam) {
      const d = this.camera.position.distanceTo(target);
      viewHeight = 2 * d * Math.tan((FOV * Math.PI) / 360);
    } else {
      viewHeight = (this.orthoCam.top - this.orthoCam.bottom) / this.orthoCam.zoom;
    }
    return { target, quaternion, viewHeight: Math.max(1e-3, viewHeight) };
  }

  private applyPose(pose: CameraPose) {
    const cam = this.camera;
    this.controls.target.copy(pose.target);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
    let dist: number;
    if (cam === this.perspCam) {
      dist = pose.viewHeight / 2 / Math.tan((FOV * Math.PI) / 360);
    } else {
      // Orthographic framing is set by zoom. The distance only matters for clipping / fog and for
      // TrackballControls' orthographic pan, which scales with it: at width / panSpeed the scene
      // follows the cursor. Always stay outside the scene.
      dist = Math.max(this.width / this.controls.panSpeed, pose.target.distanceTo(this.sceneCenter) + this.sceneRadius + 20);
      this.orthoCam.zoom = (this.orthoCam.top - this.orthoCam.bottom) / pose.viewHeight;
      this.orthoCam.updateProjectionMatrix();
    }
    cam.position.copy(pose.target).addScaledVector(back, dist);
    cam.up.copy(up);
    cam.quaternion.copy(pose.quaternion);
    cam.updateMatrixWorld();
    this.dirty = true;
  }

  private goTo(pose: CameraPose, animate: boolean) {
    stopControlsMomentum(this.controls);
    if (!animate) {
      this.anim = null;
      this.applyPose(pose);
      return;
    }
    this.anim = { from: this.getPose(), to: pose, start: performance.now(), duration: FOCUS_MS };
    this.dirty = true;
  }

  private stepAnimation(now: number) {
    const a = this.anim!;
    const s = Math.min(1, Math.max(0, (now - a.start) / a.duration));
    const k = easeInOutCubic(s);
    const pose: CameraPose = {
      target: a.from.target.clone().lerp(a.to.target, k),
      quaternion: a.from.quaternion.clone().slerp(a.to.quaternion, k),
      // Geometric interpolation of the zoom feels uniform.
      viewHeight: Math.exp(Math.log(a.from.viewHeight) * (1 - k) + Math.log(a.to.viewHeight) * k),
    };
    this.applyPose(pose);
    if (s >= 1) this.anim = null;
  }

  private autoRotateStep(dt: number) {
    const cam = this.camera;
    const target = this.controls.target;
    const axis = this._v2.copy(cam.up).normalize();
    const offset = this._v.copy(cam.position).sub(target);
    offset.applyAxisAngle(axis, AUTO_ROTATE_RAD_PER_S * dt);
    cam.position.copy(target).add(offset);
    cam.lookAt(target);
    this.dirty = true;
  }

  /**
   * The first atoms of an empty document: frame them once, keeping the orientation and never closer
   * than the empty-document framing (so a first atom at the origin does not zoom the view at all).
   * Later edits never move the camera.
   */
  private frameFirstAtoms(mol: Molecule) {
    const sphere = this.boundingSphereOf(mol, null, EMPTY_VIEW_RADIUS);
    this.goTo({ target: sphere.center, quaternion: this.camera.quaternion.clone(), viewHeight: this.fitViewHeight(sphere.radius) }, true);
  }

  /** Is the centre of any atom of `mol` inside the current view? */
  private anyAtomInView(mol: Molecule): boolean {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const e = this._m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    for (const a of mol.atoms) {
      const cw = e[3] * a.x + e[7] * a.y + e[11] * a.z + e[15];
      if (cw <= 0) continue;
      const cx = (e[0] * a.x + e[4] * a.y + e[8] * a.z + e[12]) / cw;
      const cy = (e[1] * a.x + e[5] * a.y + e[9] * a.z + e[13]) / cw;
      if (cx >= -1 && cx <= 1 && cy >= -1 && cy <= 1) return true;
    }
    return false;
  }

  private resetViewInternal(animate: boolean) {
    const mol = useStore.getState().molecule;
    let sphere: { center: THREE.Vector3; radius: number };
    if (!mol || mol.atoms.length === 0) sphere = { center: new THREE.Vector3(0, 0, 0), radius: EMPTY_VIEW_RADIUS };
    else sphere = this.boundingSphereOf(mol, visibleAtomIndices(mol, useStore.getState()), 3);
    const pose: CameraPose = {
      target: sphere.center,
      quaternion: new THREE.Quaternion(), // looking down −Z with +Y up
      viewHeight: this.fitViewHeight(sphere.radius),
    };
    this.goTo(pose, animate);
  }

  /** Sphere around the centroid of the given atoms (null = all) covering their spheres. */
  private boundingSphereOf(mol: Molecule, idx: number[] | null, minRadius: number): { center: THREE.Vector3; radius: number } {
    const atoms = mol.atoms;
    const n = idx ? idx.length : atoms.length;
    // Nothing to frame (empty document): the empty-document framing, never a NaN centroid.
    if (n === 0) return { center: new THREE.Vector3(0, 0, 0), radius: Math.max(minRadius, EMPTY_VIEW_RADIUS) };
    let sx = 0, sy = 0, sz = 0;
    for (let k = 0; k < n; k++) {
      const a = atoms[idx ? idx[k] : k];
      sx += a.x;
      sy += a.y;
      sz += a.z;
    }
    const center = new THREE.Vector3(sx / n, sy / n, sz / n);
    let r = 0;
    for (let k = 0; k < n; k++) {
      const i = idx ? idx[k] : k;
      const a = atoms[i];
      const d = Math.hypot(a.x - center.x, a.y - center.y, a.z - center.z) + (this.atomRadius[i] || 0.5);
      if (d > r) r = d;
    }
    return { center, radius: Math.max(minRadius, r + 0.5) };
  }

  /** View height (at the target plane) that frames a sphere of radius r in the current camera. */
  private fitViewHeight(r: number): number {
    const aspect = this.width / this.height;
    if (this.camera === this.perspCam) {
      const d = fitDistance(r, FOV, aspect, 1.08);
      return 2 * d * Math.tan((FOV * Math.PI) / 360);
    }
    return (2 * r * 1.08) / Math.min(1, aspect);
  }
}
