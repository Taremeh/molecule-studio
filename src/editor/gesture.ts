/**
 * Click vs drag classification for pointer gestures on the viewport. Pure functions.
 *
 * A press becomes a *drag* as soon as the pointer travels more than DRAG_THRESHOLD_PX from where it
 * went down. A release before that is a *click* — provided it was quick (≤ CLICK_MAX_MS) when the
 * press was not consumed by the editor (i.e. the camera controls also saw it: a long, still press
 * there is more likely an aborted rotation than a click). Presses the editor consumed (e.g. on an
 * atom with an edit tool) have no time limit, so a slow, deliberate click still acts.
 */

export const DRAG_THRESHOLD_PX = 4;
export const CLICK_MAX_MS = 500;

export interface ScreenPoint {
  x: number;
  y: number;
}

/** True once the pointer is farther than `threshold` px from the press position. */
export function exceedsDragThreshold(start: ScreenPoint, current: ScreenPoint, threshold = DRAG_THRESHOLD_PX): boolean {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  return dx * dx + dy * dy > threshold * threshold;
}

export type ReleaseKind = 'click' | 'drag' | 'none';

/**
 * Classify a release: 'drag' if the pointer moved beyond the threshold, 'click' if it stayed
 * (and, for unconsumed presses, was released within CLICK_MAX_MS), otherwise 'none' (long press).
 */
export function classifyRelease(start: ScreenPoint, end: ScreenPoint, durationMs: number, consumed: boolean): ReleaseKind {
  if (exceedsDragThreshold(start, end)) return 'drag';
  if (!consumed && durationMs > CLICK_MAX_MS) return 'none';
  return 'click';
}

/** Normalised client-space rectangle spanned by two points. */
export function rectFromPoints(a: ScreenPoint, b: ScreenPoint): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}
