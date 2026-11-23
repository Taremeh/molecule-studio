/**
 * Contracts between the editor controller (state machine, event plumbing) and the per-tool modules.
 */
import type { AppState } from '../../state/store';
import type { PickResult, ViewerApi } from '../../render/viewerApi';
import type { EditOverlay } from '../../core/types';

/** Pointer position (client px) and modifier keys of an event. */
export interface PointerState {
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

export type Hit = PickResult | null;

/** Controller-level state shared between events (survives across clicks). */
export interface EditorSession {
  /** add-bond tool: first atom of a click–click bond, or null. */
  bondStart: number | null;
}

/** Visual feedback for the current pointer state: overlay (missing fields = empty) + status hint. */
export interface Feedback {
  overlay?: Partial<EditOverlay>;
  hint: string | null;
}

export interface ToolEnv {
  readonly viewer: ViewerApi;
  /** Fresh store state (useStore.getState()). */
  state(): AppState;
  readonly session: EditorSession;
  /** Display overlay + hint (deduplicated by the controller). */
  show(feedback: Feedback): void;
}

/** An in-progress drag owned by a tool. The controller calls update at most once per frame. */
export interface DragSession {
  update(env: ToolEnv, p: PointerState): void;
  /** Pointer released: apply the result. */
  finish(env: ToolEnv, p: PointerState): void;
  /** Escape / interruption: undo any transient change. */
  cancel(env: ToolEnv): void;
}

/** What a pointerdown means for the current tool. */
export interface PressPlan {
  /** Consume the pointerdown (camera controls will not see the drag). */
  consume: boolean;
  /** Pointer released without dragging. `p` is the pointer state at press time. */
  click?(env: ToolEnv, p: PointerState): void;
  /** Pointer moved beyond the drag threshold (only called when consume is true). */
  startDrag?(env: ToolEnv, start: PointerState): DragSession | null;
}

export interface Tool {
  /** Cheap key identifying the hover preview; preview() is recomputed only when it changes. */
  hoverKey(env: ToolEnv, hit: Hit, p: PointerState): string;
  preview(env: ToolEnv, hit: Hit, p: PointerState): Feedback;
  /** Overlay kept while the pointer is outside the viewport (e.g. a pending bond start). */
  restingOverlay?(env: ToolEnv): Partial<EditOverlay> | undefined;
  press(env: ToolEnv, hit: Hit, p: PointerState): PressPlan;
  doubleClick?(env: ToolEnv, hit: Hit, p: PointerState): void;
}
