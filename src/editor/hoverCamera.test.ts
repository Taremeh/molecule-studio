/**
 * Hover previews must follow the camera: auto-rotation, focus animations, zoom / damping move atoms
 * under a still pointer, so the controller re-picks when the view changes (and only then).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Molecule } from '../core/types';
import { useStore } from '../state/store';
import { createHarness, type Harness } from './testing/fakeViewer';
import { ethane, twoGroups } from './testing/molecules';

const S = () => useStore.getState();
let h: Harness;

function load(m: Molecule, mode: 'view' | 'edit', tool: Parameters<ReturnType<typeof S>['setTool']>[0]) {
  S().loadMolecule(m);
  useStore.setState({ mode, tool, panels: { ...S().panels, help: false, load: false }, view: { ...S().view, autoHydrogens: true, snapBonds: true, relaxOnDrag: false } });
}

beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.ctl.dispose());

describe('hover under a moving camera', () => {
  it('re-picks when the camera turns under a still pointer (auto-rotate / focus animation)', () => {
    const m = ethane();
    load(m, 'view', 'select');
    h.move(154, 0); // over C5 at x = 1.54 Å
    h.step();
    expect(S().hovered).toMatchObject({ kind: 'atom', atomId: 5 });
    // the view turns by 90° over a few frames; the pointer does not move
    for (const a of [30, 60, 90]) {
      h.camera.angle = a;
      h.step();
    }
    h.flush();
    expect(S().hovered).toBeNull();
    expect(S().hint).not.toMatch(/C5|C2/);
  });

  it('stops watching once the camera is still, without re-picking', () => {
    load(ethane(), 'view', 'select');
    h.move(154, 0);
    h.step();
    h.viewer.pick.mockClear();
    const frames = h.flush();
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThan(200);
    expect(h.viewer.pick).not.toHaveBeenCalled();
    expect(h.frames).toHaveLength(0);
  });

  it('a key press (F / R / view shortcuts) restarts the camera watch', () => {
    const m = ethane();
    load(m, 'view', 'select');
    h.move(154, 0);
    h.flush(); // watch expired
    expect(S().hovered).toMatchObject({ atomId: 5 });
    h.key({ key: 'f' });
    h.camera.pan = [0, 300]; // the focus animation moves the molecule away from the pointer
    h.flush();
    expect(S().hovered).toBeNull();
  });

  it('wheel zoom re-picks (zoom damping continues after the wheel event)', () => {
    const m = ethane();
    load(m, 'view', 'select');
    h.move(154, 0);
    h.flush();
    h.containerEvent('wheel');
    h.step();
    h.camera.pxPerA = 50; // zoom (out) continues for a few frames
    h.flush();
    expect(S().hovered).toBeNull();
  });

  it('a failing projection stops the watch quietly (no toast per frame)', () => {
    load(ethane(), 'view', 'select');
    useStore.setState({ toasts: [] });
    h.move(154, 0);
    h.step();
    h.viewer.worldToScreen.mockImplementation(() => {
      throw new Error('projection failed');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const frames = h.flush();
    err.mockRestore();
    expect(frames).toBeLessThan(3);
    expect(S().toasts).toHaveLength(0);
  });

  it('the add-bond rubber band follows the camera', () => {
    const m = twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'C', nH: 3, at: [3, 0, 0] });
    load(m, 'edit', 'add-bond');
    h.move(0, 0);
    h.click(0, 0); // bond start on C1
    h.move(150, 100); // empty space
    h.step();
    const before = S().editOverlay.ghostBonds[0]?.to;
    expect(before).toBeDefined();
    h.camera.pan = [50, 0];
    h.flush();
    const after = S().editOverlay.ghostBonds[0]?.to;
    expect(after![0]).toBeCloseTo(1.0, 6); // (150 − 50) px / 100 px per Å
    expect(after![0]).not.toBeCloseTo(before![0], 3);
  });
});
