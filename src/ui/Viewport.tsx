/**
 * Mounts the Viewer, registers it with setViewer(), creates the editor controller and forwards
 * pointer events to it (capture phase on the container; if onPointerDown returns true the event is
 * stopped so camera controls ignore it, and pointer capture is taken). Renders the box-selection
 * rectangle from store.editOverlay.selectionRect and the cursor style for the current tool.
 * OWNER: render-core agent.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Viewer } from '../render/Viewer';
import { getViewer, setViewer } from '../render/viewerApi';
import { createEditorController } from '../editor/controller';
import { useStore, type AppState } from '../state/store';
import './Viewport.css';

type DragKind = 'none' | 'camera' | 'edit';

/** Movement (px) after which an unconsumed press counts as a camera drag (for the cursor only). */
const CAMERA_DRAG_PX = 4;

/** Cursor class for the current tool / hover state. */
function cursorFor(s: AppState): string {
  const overAtom = s.hovered?.kind === 'atom';
  const overSomething = !!s.hovered;
  switch (s.tool) {
    case 'add-atom':
    case 'add-bond':
    case 'measure':
      return 'cursor-crosshair';
    case 'delete':
      return overSomething ? 'cursor-delete' : 'cursor-crosshair';
    case 'move':
      return overAtom ? 'cursor-grab' : '';
    case 'fragment':
      return overAtom ? 'cursor-pointer' : 'cursor-crosshair';
    case 'element':
    case 'charge':
      return overAtom ? 'cursor-pointer' : '';
    case 'select':
    default:
      return overSomething ? 'cursor-pointer' : '';
  }
}

function blurTextInput() {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) el.blur();
}

export default function Viewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragKind>('none');
  const cursor = useStore(cursorFor);
  const selectionRect = useStore((s) => s.editOverlay.selectionRect);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let viewer: Viewer;
    try {
      viewer = new Viewer(el);
    } catch (e) {
      console.error('[viewport] could not create the 3D viewer', e);
      setError('3D graphics (WebGL) are not available in this browser or were disabled.');
      useStore.getState().toast('WebGL is not available — the 3D view cannot be shown.', 'error', 8000);
      return;
    }
    setViewer(viewer);
    const controller = createEditorController(viewer);

    let consumedPointer: number | null = null;
    let press: { id: number; x: number; y: number; camera: boolean } | null = null;

    const safe = <T,>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (e) {
        console.error('[viewport] editor controller error', e);
        return fallback;
      }
    };

    const onPointerDown = (ev: PointerEvent) => {
      blurTextInput();
      const consumed = safe(() => controller.onPointerDown(ev), false);
      if (consumed) {
        ev.stopPropagation();
        ev.preventDefault();
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          /* pointer already released */
        }
        consumedPointer = ev.pointerId;
        press = null;
        setDrag('edit');
      } else {
        press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, camera: false };
      }
    };
    const onPointerMove = (ev: PointerEvent) => {
      if (press && press.id === ev.pointerId && !press.camera && ev.buttons !== 0) {
        if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > CAMERA_DRAG_PX) {
          press.camera = true;
          setDrag('camera');
        }
      }
      safe(() => controller.onPointerMove(ev), undefined);
    };
    /** Local bookkeeping when a press ends (released or cancelled). */
    const clearPress = (ev: PointerEvent) => {
      if (consumedPointer === ev.pointerId) {
        try {
          if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        consumedPointer = null;
      }
      if (press && press.id === ev.pointerId) press = null;
      setDrag('none');
    };
    const onPointerUp = (ev: PointerEvent) => {
      safe(() => controller.onPointerUp(ev), undefined);
      clearPress(ev);
    };
    // pointercancel: the controller listens on viewer.container itself and aborts the interaction
    // (a cancel must not commit a drag), so only clean up here.
    const onPointerCancel = (ev: PointerEvent) => clearPress(ev);
    const onPointerLeave = (ev: PointerEvent) => {
      safe(() => controller.onPointerLeave(ev), undefined);
    };
    const onDoubleClick = (ev: MouseEvent) => {
      safe(() => controller.onDoubleClick(ev), undefined);
    };
    const onContextMenu = (ev: MouseEvent) => ev.preventDefault();

    const capture = { capture: true } as const;
    el.addEventListener('pointerdown', onPointerDown, capture);
    el.addEventListener('pointermove', onPointerMove, capture);
    el.addEventListener('pointerup', onPointerUp, capture);
    el.addEventListener('pointercancel', onPointerCancel, capture);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('dblclick', onDoubleClick, capture);
    el.addEventListener('contextmenu', onContextMenu);

    return () => {
      el.removeEventListener('pointerdown', onPointerDown, capture);
      el.removeEventListener('pointermove', onPointerMove, capture);
      el.removeEventListener('pointerup', onPointerUp, capture);
      el.removeEventListener('pointercancel', onPointerCancel, capture);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.removeEventListener('dblclick', onDoubleClick, capture);
      el.removeEventListener('contextmenu', onContextMenu);
      safe(() => controller.dispose(), undefined);
      if (getViewer() === viewer) setViewer(null);
      viewer.dispose();
    };
  }, []);

  // Box-selection rectangle: client coordinates → container coordinates.
  let rectStyle: CSSProperties | null = null;
  if (selectionRect && ref.current) {
    const box = ref.current.getBoundingClientRect();
    const x = Math.min(selectionRect.x0, selectionRect.x1) - box.left;
    const y = Math.min(selectionRect.y0, selectionRect.y1) - box.top;
    rectStyle = {
      left: x,
      top: y,
      width: Math.abs(selectionRect.x1 - selectionRect.x0),
      height: Math.abs(selectionRect.y1 - selectionRect.y0),
    };
  }

  const dragClass = drag === 'edit' ? 'is-dragging-edit' : drag === 'camera' ? 'is-dragging-camera' : '';
  return (
    <div className="viewport-wrap">
      <div ref={ref} className={['viewport', cursor, dragClass].filter(Boolean).join(' ')} data-drag={drag} />
      {rectStyle && <div className="viewport-selrect" style={rectStyle} />}
      {error && (
        <div className="viewport-error" role="alert">
          <strong>3D view unavailable</strong>
          <span>{error}</span>
          <span className="viewport-error-hint">Try enabling hardware acceleration or another browser.</span>
        </div>
      )}
    </div>
  );
}
