import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_OVERLAY } from '../../core/types';
import { buildMolecule } from '../../core/molecule';
import type { ViewerApi } from '../../render/viewerApi';
import { useStore } from '../../state/store';
import { createEditorController } from '../../editor/controller';
import { showTemporaryHighlight } from './overlayHighlight';

const S = () => useStore.getState();

function chain4() {
  return buildMolecule(
    'chain',
    [0, 1.5, 3, 4.5].map((x) => ({ element: 'C', x, y: 0, z: 0 })),
    [
      { a: 0, b: 1, order: 1 },
      { a: 1, b: 2, order: 1 },
    ],
  );
}

/** Orthographic stand-in: 100 px per Å, picks the atom within 12 px. */
function viewer(): ViewerApi {
  const PX = 100;
  return {
    container: {} as HTMLElement,
    canvas: {} as HTMLCanvasElement,
    pick: (x, y) => {
      const a = S().molecule?.atoms.find((t) => Math.hypot(t.x * PX - x, -t.y * PX - y) < 12);
      return a ? { kind: 'atom', atomId: a.id, point: [a.x, a.y, a.z] } : null;
    },
    pickRect: () => [],
    screenToWorldOnPlane: (x, y, p) => [x / PX, -y / PX, p[2]],
    worldToScreen: (p) => ({ x: p[0] * PX, y: -p[1] * PX, visible: true }),
    getViewDirection: () => [0, 0, -1],
    getTarget: () => [0, 0, 0],
    focusAtoms: () => {},
    resetView: () => {},
    viewAlong: () => {},
    setControlsEnabled: () => {},
    screenshot: async () => new Blob(),
    requestRender: () => {},
    dispose: () => {},
  };
}

beforeEach(() => {
  S().loadMolecule(chain4());
  S().setMode('edit');
});

describe('showTemporaryHighlight', () => {
  it('adds to the overlay and restores the exact previous state', () => {
    expect(S().editOverlay).toBe(EMPTY_OVERLAY);
    const remove = showTemporaryHighlight([3, 4]);
    expect(S().editOverlay.highlightAtoms).toEqual([
      { atomId: 3, color: 'target' },
      { atomId: 4, color: 'target' },
    ]);
    remove();
    expect(S().editOverlay).toBe(EMPTY_OVERLAY);
  });

  it("keeps the add-bond tool's pending start atom highlighted (hover a measurement row and leave it)", () => {
    S().setTool('add-bond');
    const frames: (() => void)[] = [];
    const ctl = createEditorController(viewer(), {
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => (frames.length = 0),
      keyTarget: null,
    });
    const ev = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }) as unknown as PointerEvent;
    // Click atom 1: the click–click bond is pending, atom 1 shows the 'target' highlight.
    ctl.onPointerDown(ev(0, 0));
    ctl.onPointerUp(ev(0, 0));
    while (frames.length) frames.shift()!();
    ctl.onPointerLeave(ev(0, 0)); // pointer moves over to the side panel
    const start = [{ atomId: 1, color: 'target' }];
    expect(S().editOverlay.highlightAtoms).toEqual(start);

    const remove = showTemporaryHighlight([3, 4]); // row hover
    expect(S().editOverlay.highlightAtoms).toEqual([...start, { atomId: 3, color: 'target' }, { atomId: 4, color: 'target' }]);
    remove(); // row leave
    expect(S().editOverlay.highlightAtoms).toEqual(start);
    ctl.dispose();
  });

  it("leaves a newer overlay alone (the editor replaced it during the hover)", () => {
    const remove = showTemporaryHighlight([3]);
    S().setEditOverlay({ highlightAtoms: [{ atomId: 2, color: 'delete' }] });
    remove();
    expect(S().editOverlay.highlightAtoms).toEqual([{ atomId: 2, color: 'delete' }]);
  });
});
