/**
 * Editor / interaction controller: turns pointer events on the 3D viewport into store actions
 * according to the current mode and tool. OWNER: editor agent.
 * See ARCHITECTURE.md § Editor for the behaviour of every tool.
 *
 * Structure: a small state machine (this file) plus one module per tool (./tools/*).
 *
 *   idle ──pointerdown──► pressing ──moved > 4 px──► dragging   (consumed press with a drag behaviour:
 *    ▲                       │                           │        move atoms / draw bond / box select)
 *    │                       │                           ├──► inert    (consumed, but the tool has no drag)
 *    │                       │                           └──► camera   (not consumed: camera rotates)
 *    └──────pointerup────────┴── click (≤ 4 px) ─────────────────────────────────────────────┘
 *
 * - Hover: one pick per animation frame; tool previews (overlay + hint) are recomputed only when
 *   the hover key (target, tool, settings, molecule version…) changes.
 * - Camera watch: the camera can move under a still pointer (auto-rotate, focus / reset
 *   animations, zoom and rotation damping). After each pick the controller keeps checking, once per
 *   frame, whether a few reference points moved on screen; if so it re-picks and recomputes the
 *   preview. The watch ends after CAMERA_WATCH_FRAMES still frames and is re-armed by pointer
 *   moves, wheel, key presses and double-clicks.
 * - Drags are also applied at most once per frame with the latest pointer position.
 * - Escape cancels a drag or a pending click–click bond (window keydown, capture phase, so the
 *   global shortcut handler never also clears the selection). Other keys are held back during drags.
 * - In view mode nothing is consumed except Shift-drag on empty space (box select), so camera
 *   rotation always works.
 */
import type { EditOverlay, Vec3 } from '../core/types';
import { EMPTY_OVERLAY } from '../core/types';
import { atomById } from '../core/molecule';
import type { ViewerApi } from '../render/viewerApi';
import { useStore, type AppState } from '../state/store';
import { classifyRelease, exceedsDragThreshold } from './gesture';
import { keyBelongsToUi } from './keyScope';
import { toolFor } from './tools';
import type { DragSession, EditorSession, Feedback, Hit, PointerState, PressPlan, ToolEnv } from './tools/types';

export interface EditorController {
  /** Return true to consume the event (camera controls will not see this drag). */
  onPointerDown(ev: PointerEvent): boolean;
  onPointerMove(ev: PointerEvent): void;
  onPointerUp(ev: PointerEvent): void;
  onPointerLeave(ev: PointerEvent): void;
  /** Double click: focus the clicked atom (view) — handled here. */
  onDoubleClick(ev: MouseEvent): void;
  dispose(): void;
}

/** Optional dependencies (for tests / non-browser hosts). */
export interface EditorControllerOptions {
  /** Schedule a callback before the next repaint (default: requestAnimationFrame). */
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
  /** Monotonic clock in ms (default: performance.now). */
  now?: () => number;
  /** Where keyboard listeners go (default: window; null disables them). */
  keyTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'pressing'; pointerId: number; start: PointerState; t0: number; plan: PressPlan }
  | { kind: 'dragging'; pointerId: number; drag: DragSession }
  | { kind: 'inert'; pointerId: number }
  | { kind: 'camera'; pointerId: number };

const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Control', 'Meta', 'AltGraph', 'CapsLock']);

/** Still frames after which the controller stops watching the camera for movement. */
export const CAMERA_WATCH_FRAMES = 45;
/** Screen movement (px) of a reference point that counts as a camera change. */
const CAMERA_EPS_PX = 0.5;

type PointerLike = Pick<MouseEvent, 'clientX' | 'clientY' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>;

function toPointer(ev: PointerLike): PointerState {
  return { x: ev.clientX, y: ev.clientY, shift: !!ev.shiftKey, alt: !!ev.altKey, ctrl: !!ev.ctrlKey, meta: !!ev.metaKey };
}

function pointerIdOf(ev: Partial<PointerEvent>): number {
  return typeof ev.pointerId === 'number' ? ev.pointerId : 1;
}

function sameOverlay(a: EditOverlay, b: EditOverlay): boolean {
  if (a === b) return true;
  const r1 = a.selectionRect;
  const r2 = b.selectionRect;
  if (!!r1 !== !!r2 || (r1 && r2 && (r1.x0 !== r2.x0 || r1.y0 !== r2.y0 || r1.x1 !== r2.x1 || r1.y1 !== r2.y1))) return false;
  const eq = <T>(x: T[], y: T[], f: (p: T, q: T) => boolean) => x.length === y.length && x.every((v, i) => f(v, y[i]));
  const v3 = (p: number[], q: number[]) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
  return (
    eq(a.highlightAtoms, b.highlightAtoms, (p, q) => p.atomId === q.atomId && p.color === q.color) &&
    eq(a.highlightBonds, b.highlightBonds, (p, q) => p.bondId === q.bondId && p.color === q.color) &&
    eq(a.ghostAtoms, b.ghostAtoms, (p, q) => p.element === q.element && p.valid === q.valid && v3(p.position, q.position)) &&
    eq(a.ghostBonds, b.ghostBonds, (p, q) => p.valid === q.valid && p.order === q.order && p.style === q.style && v3(p.from, q.from) && v3(p.to, q.to))
  );
}

function isEmptyOverlay(o: EditOverlay): boolean {
  return !o.selectionRect && !o.ghostAtoms.length && !o.ghostBonds.length && !o.highlightAtoms.length && !o.highlightBonds.length;
}

export function createEditorController(viewer: ViewerApi, options: EditorControllerOptions = {}): EditorController {
  const requestFrame =
    options.requestFrame ??
    (typeof requestAnimationFrame === 'function' ? (cb: () => void) => requestAnimationFrame(cb) : (cb: () => void) => setTimeout(cb, 16) as unknown as number);
  const cancelFrame =
    options.cancelFrame ??
    (typeof cancelAnimationFrame === 'function' ? (h: number) => cancelAnimationFrame(h) : (h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const keyTarget = options.keyTarget !== undefined ? options.keyTarget : typeof window !== 'undefined' ? window : null;

  const store = (): AppState => useStore.getState();
  const session: EditorSession = { bondStart: null };

  let phase: Phase = { kind: 'idle' };
  let pointer: PointerState = { x: 0, y: 0, shift: false, alt: false, ctrl: false, meta: false };
  let inside = false;
  let frame: number | null = null;
  let disposed = false;
  let controlsDisabled = false;

  // Preview cache: the key of what is currently displayed, and the overlay/hint we put in the store.
  let previewKey: string | null = null;
  let shownOverlay: EditOverlay | null = null;
  let shownHint: string | null | undefined;
  let selectionStamp = 0;
  let lastSelection: ReadonlySet<number> | null = null;

  // Hover request + camera watch (see header).
  let hoverWanted = false;
  let camRefs: Vec3[] | null = null;
  let camSig: number[] = [];
  let camStill = 0;

  const show = (fb: Feedback) => {
    const s = store();
    const o: EditOverlay = fb.overlay ? { ...EMPTY_OVERLAY, ...fb.overlay } : EMPTY_OVERLAY;
    if (isEmptyOverlay(o)) s.clearEditOverlay();
    else if (!sameOverlay(o, s.editOverlay)) s.setEditOverlay(o);
    shownOverlay = store().editOverlay;
    s.setHint(fb.hint);
    shownHint = fb.hint;
  };

  const env: ToolEnv = { viewer, state: store, session, show };

  const safePick = (x: number, y: number): Hit => {
    try {
      return viewer.pick(x, y);
    } catch (e) {
      console.error('pick failed', e);
      return null;
    }
  };

  /**
   * Run a tool action; a bug in one edit must not leave the controller in a broken state.
   * Returns the action's result, or `fallback` if it threw.
   */
  function attempt<T>(what: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      console.error(`Editor: ${what} failed`, e);
      store().toast(`Something went wrong (${what}): ${e instanceof Error ? e.message : String(e)}`, 'error', 5000);
      return fallback;
    }
  }
  const guarded = (what: string, fn: () => void): boolean => attempt(what, () => (fn(), true), false);

  const globalKey = (s: AppState): string => {
    if (s.selection !== lastSelection) {
      lastSelection = s.selection;
      selectionStamp++;
    }
    return [
      s.mode,
      s.tool,
      s.editElement,
      s.editBondOrder,
      s.editFragment,
      s.measureKind,
      s.pendingMeasure.join(','),
      s.moleculeVersion,
      s.view.autoHydrogens ? 1 : 0,
      s.view.snapBonds ? 1 : 0,
      selectionStamp,
      session.bondStart ?? '',
    ].join('|');
  };

  const scheduleFrame = () => {
    if (frame === null && !disposed) frame = requestFrame(onFrame);
  };

  const cancelScheduledFrame = () => {
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
  };

  /** Pick (and update the preview) on the next frame. */
  const requestHover = () => {
    hoverWanted = true;
    scheduleFrame();
  };

  const projectRefs = (refs: Vec3[]): number[] => {
    const out: number[] = [];
    for (const r of refs) {
      const sp = viewer.worldToScreen(r);
      out.push(sp.x, sp.y);
    }
    return out;
  };

  /** Remember where fixed world points (orbit target, axes, the point under the pointer) project now. */
  const armCameraWatch = (pointerWorld: Vec3 | null) => {
    try {
      const t = viewer.getTarget();
      const w = pointerWorld ?? viewer.screenToWorldOnPlane(pointer.x, pointer.y, t);
      const d = Math.hypot(w[0] - t[0], w[1] - t[1], w[2] - t[2]);
      const r = Number.isFinite(d) ? Math.max(5, d) : 5; // NaN here would blind the axis references
      camRefs = [t, w, [t[0] + r, t[1], t[2]], [t[0], t[1] + r, t[2]], [t[0], t[1], t[2] + r]];
      camSig = projectRefs(camRefs);
      camStill = 0;
    } catch {
      camRefs = null;
    }
  };

  /** True if the view changed since the last pick (NaN-safe: an undefined projection never counts). */
  const cameraMoved = (): boolean => {
    if (!camRefs) return false;
    const now = projectRefs(camRefs);
    for (let i = 0; i < now.length; i++) if (Math.abs(now[i] - camSig[i]) > CAMERA_EPS_PX) return true;
    return false;
  };

  /** Keep checking the camera for a while (something may be about to animate it). */
  const watchCamera = () => {
    if (phase.kind !== 'idle' || !inside || !camRefs) return;
    camStill = 0;
    scheduleFrame();
  };

  function onFrame() {
    frame = null;
    if (disposed) return;
    if (phase.kind === 'dragging') {
      const drag = phase.drag;
      guarded('drag', () => drag.update(env, pointer));
      return;
    }
    if (phase.kind !== 'idle' || !inside) return;
    let moved = false;
    try {
      moved = cameraMoved();
    } catch (e) {
      // A best-effort check: never toast once per frame for it, just stop watching.
      console.error('Editor: camera watch failed', e);
      camRefs = null;
    }
    if (hoverWanted || moved) {
      hoverWanted = false;
      // The scene moved under the pointer: previews in world space (ghosts, rubber bands) are stale too.
      if (moved) previewKey = null;
      guarded('hover', hover);
    } else if (!camRefs || ++camStill > CAMERA_WATCH_FRAMES) return;
    scheduleFrame();
  }

  /** Pick under the pointer, update the hovered atom/bond and (if anything changed) the tool preview. */
  function hover() {
    const s = store();
    const mol = s.molecule;
    if (!mol) {
      rest();
      return;
    }
    const p = pointer;
    const hit = safePick(p.x, p.y);
    armCameraWatch(hit ? hit.point : null);
    s.setHovered(hit ? { kind: hit.kind, atomId: hit.atomId, bondId: hit.bondId, clientX: p.x, clientY: p.y } : null);
    const tool = toolFor(s.mode, s.tool);
    const key = `${globalKey(s)}#${tool.hoverKey(env, hit, p)}`;
    const st = store();
    if (key === previewKey && st.editOverlay === shownOverlay && st.hint === shownHint) return;
    previewKey = key;
    show(tool.preview(env, hit, p));
  }

  /** Feedback when the pointer is not hovering (outside, rotating the camera): only persistent overlays. */
  function rest() {
    const s = store();
    s.setHovered(null);
    previewKey = null;
    hoverWanted = false;
    camRefs = null;
    const tool = toolFor(s.mode, s.tool);
    show({ overlay: s.molecule ? tool.restingOverlay?.(env) : undefined, hint: null });
  }

  const invalidatePreview = () => {
    previewKey = null;
    if (phase.kind === 'idle' && inside) requestHover();
  };

  function beginDragUi() {
    viewer.setControlsEnabled(false);
    controlsDisabled = true;
    store().setHovered(null);
    previewKey = null;
    hoverWanted = false;
    camRefs = null;
  }

  function endDragUi() {
    if (controlsDisabled) {
      viewer.setControlsEnabled(true);
      controlsDisabled = false;
    }
    if (inside) {
      previewKey = null;
      show({ overlay: toolFor(store().mode, store().tool).restingOverlay?.(env), hint: null });
      requestHover();
    } else rest();
  }

  /** Abort whatever is in progress (Escape, pointercancel, document change, dispose). */
  function abortInteraction(): boolean {
    const cur = phase;
    phase = { kind: 'idle' };
    cancelScheduledFrame();
    if (cur.kind === 'dragging') {
      guarded('cancel', () => cur.drag.cancel(env));
      endDragUi();
      return true;
    }
    return cur.kind === 'pressing' && cur.plan.consume;
  }

  // ------------------------------------------------------------------ keyboard

  const onKeyDown = (e: Event) => {
    const ev = e as KeyboardEvent;
    if (disposed) return;
    // Shortcuts may animate the camera (F focus, R reset…) under the still pointer.
    if (!MODIFIER_KEYS.has(ev.key)) watchCamera();
    if (phase.kind === 'dragging') {
      if (ev.key === 'Escape') {
        abortInteraction();
        ev.preventDefault();
      }
      // Keep global shortcuts (undo, tool switches…) out of an active drag.
      if (!MODIFIER_KEYS.has(ev.key)) ev.stopPropagation();
      return;
    }
    if (ev.key !== 'Escape') return;
    // Escape typed into a text field, a dialog or a popover (or while a modal is open) is theirs:
    // swallowing it here would keep the modal open / break the field's own Escape handling.
    if (keyBelongsToUi(ev, store())) return;
    if (phase.kind === 'pressing' && phase.plan.consume) {
      // Pointer is down on an atom but hasn't moved yet: cancel the pending click.
      phase = { kind: 'inert', pointerId: phase.pointerId };
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (session.bondStart !== null) {
      session.bondStart = null;
      ev.preventDefault();
      ev.stopPropagation();
      if (inside) invalidatePreview();
      else rest();
    }
  };
  keyTarget?.addEventListener('keydown', onKeyDown, true);

  // ------------------------------------------------------------------ store

  const unsubscribe = useStore.subscribe((s, prev) => {
    if (disposed) return;
    const startBefore = session.bondStart;
    if (s.documentId !== prev.documentId) {
      if (phase.kind === 'dragging') abortInteraction();
      session.bondStart = null;
    }
    if (s.tool !== prev.tool || s.mode !== prev.mode) session.bondStart = null;
    if (session.bondStart !== null && s.molecule !== prev.molecule && (!s.molecule || !atomById(s.molecule, session.bondStart))) {
      session.bondStart = null;
    }
    const relevant =
      session.bondStart !== startBefore ||
      s.molecule !== prev.molecule ||
      s.tool !== prev.tool ||
      s.mode !== prev.mode ||
      s.editElement !== prev.editElement ||
      s.editBondOrder !== prev.editBondOrder ||
      s.editFragment !== prev.editFragment ||
      s.measureKind !== prev.measureKind ||
      s.pendingMeasure !== prev.pendingMeasure ||
      s.selection !== prev.selection ||
      s.reps !== prev.reps ||
      s.view !== prev.view;
    if (!relevant || phase.kind !== 'idle') return;
    if (inside) invalidatePreview();
    else if (session.bondStart !== startBefore) rest();
  });

  // ------------------------------------------------------------------ extra DOM listeners

  const container = viewer.container as HTMLElement | undefined;
  const onPointerCancel = (e: Event) => {
    const id = pointerIdOf(e as PointerEvent);
    if (phase.kind !== 'idle' && 'pointerId' in phase && phase.pointerId === id) abortInteraction();
  };
  // Zooming moves atoms under a still pointer: re-pick.
  const onWheel = () => {
    if (phase.kind === 'idle' && inside) requestHover();
  };
  container?.addEventListener?.('pointercancel', onPointerCancel);
  container?.addEventListener?.('wheel', onWheel, { passive: true });

  // ------------------------------------------------------------------ pointer events

  return {
    onPointerDown(ev) {
      if (disposed) return false;
      const p = toPointer(ev);
      const id = pointerIdOf(ev);
      if (phase.kind !== 'idle') {
        if (ev.isPrimary === false) {
          // A second finger turns an unconsumed press into a camera gesture (pinch / pan).
          if (phase.kind === 'pressing' && !phase.plan.consume) {
            phase = { kind: 'camera', pointerId: phase.pointerId };
            rest();
          }
          return false;
        }
        // A new primary pointer while busy means we missed a pointerup: recover.
        abortInteraction();
      }
      pointer = p;
      inside = true;
      if (ev.button !== undefined && ev.button !== 0) {
        phase = { kind: 'camera', pointerId: id }; // right / middle button: pan / zoom
        rest();
        return false;
      }
      const s = store();
      if (!s.molecule) return false;
      const hit = safePick(p.x, p.y);
      const plan = attempt<PressPlan>('press', () => toolFor(s.mode, s.tool).press(env, hit, p), { consume: false });
      phase = { kind: 'pressing', pointerId: id, start: p, t0: now(), plan };
      return plan.consume;
    },

    onPointerMove(ev) {
      if (disposed) return;
      const p = toPointer(ev);
      const id = pointerIdOf(ev);
      switch (phase.kind) {
        case 'idle':
          pointer = p;
          inside = true;
          requestHover();
          return;
        case 'pressing': {
          if (id !== phase.pointerId) return;
          pointer = p;
          if (!exceedsDragThreshold(phase.start, p)) return;
          const { plan, start } = phase;
          if (!plan.consume) {
            phase = { kind: 'camera', pointerId: id };
            rest();
            return;
          }
          const drag = attempt<DragSession | null>('drag start', () => plan.startDrag?.(env, start) ?? null, null);
          if (drag) {
            phase = { kind: 'dragging', pointerId: id, drag };
            beginDragUi();
            scheduleFrame();
          } else phase = { kind: 'inert', pointerId: id };
          return;
        }
        case 'dragging':
          if (id !== phase.pointerId) return;
          pointer = p;
          scheduleFrame();
          return;
        case 'inert':
        case 'camera':
          if (id === phase.pointerId) pointer = p;
          return;
      }
    },

    onPointerUp(ev) {
      if (disposed) return;
      const p = toPointer(ev);
      const id = pointerIdOf(ev);
      if (phase.kind === 'idle' || phase.pointerId !== id) return;
      const cur = phase;
      phase = { kind: 'idle' };
      pointer = p;
      switch (cur.kind) {
        case 'pressing':
          if (classifyRelease(cur.start, p, now() - cur.t0, cur.plan.consume) === 'click' && cur.plan.click) {
            const click = cur.plan.click;
            guarded('click', () => click(env, cur.start));
          }
          invalidatePreview();
          return;
        case 'dragging':
          cancelScheduledFrame();
          // If finish() throws before ending its transient edit, cancel it: never leave one dangling.
          if (!guarded('drag', () => cur.drag.finish(env, p))) guarded('cancel', () => cur.drag.cancel(env));
          endDragUi();
          return;
        case 'inert':
        case 'camera':
          invalidatePreview();
          return;
      }
    },

    onPointerLeave() {
      if (disposed) return;
      inside = false;
      if (phase.kind === 'idle' || phase.kind === 'camera') {
        cancelScheduledFrame();
        rest();
      }
    },

    onDoubleClick(ev) {
      if (disposed || phase.kind !== 'idle') return;
      const s = store();
      if (!s.molecule) return;
      const p = toPointer(ev);
      const tool = toolFor(s.mode, s.tool);
      if (!tool.doubleClick) return;
      const hit = safePick(p.x, p.y);
      guarded('double-click', () => tool.doubleClick!(env, hit, p));
      watchCamera(); // double-click focuses (animated)
    },

    dispose() {
      if (disposed) return;
      abortInteraction();
      disposed = true;
      cancelScheduledFrame();
      unsubscribe();
      keyTarget?.removeEventListener('keydown', onKeyDown, true);
      container?.removeEventListener?.('pointercancel', onPointerCancel);
      container?.removeEventListener?.('wheel', onWheel);
      if (controlsDisabled) viewer.setControlsEnabled(true);
      const s = store();
      s.setHovered(null);
      s.clearEditOverlay();
      s.setHint(null);
    },
  };
}
