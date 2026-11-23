import { beforeEach, describe, expect, it } from 'vitest';
import type { Molecule } from '../../core/types';
import { buildMolecule } from '../../core/molecule';
import { useStore } from '../../state/store';
import { createSliderEdit } from './sliderEdit';

const S = () => useStore.getState();

function pair(): Molecule {
  return buildMolecule('pair', [
    { element: 'C', x: 0, y: 0, z: 0 },
    { element: 'O', x: 1.4, y: 0, z: 0 },
  ]);
}

/** Moves atom 1 to x = v (stands in for setDistance & co.). */
const setX = (v: number) => (base: Molecule) => ({ ...base, atoms: [base.atoms[0], { ...base.atoms[1], x: v }] });
const label = (m: Molecule) => `Set x to ${m.atoms[1].x}`;
const x1 = () => S().molecule!.atoms[1].x;

/** Window stand-in that records listeners and dispatches to them. */
function fakeWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string, init: { key?: string } = {}) {
      const ev = {
        ...init,
        prevented: false,
        stopped: false,
        preventDefault() {
          this.prevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
      };
      for (const fn of [...(listeners.get(type) ?? [])]) fn(ev);
      return ev;
    },
    count() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

let win: ReturnType<typeof fakeWindow>;
beforeEach(() => {
  S().loadMolecule(pair());
  S().setMode('edit');
  win = fakeWindow();
});

describe('slider gesture ↔ transient edit', () => {
  it('a pointer drag is one undo entry, finished by the release anywhere', () => {
    const g = createSliderEdit(win);
    g.pointerDown(label);
    g.change(label, setX(2));
    g.change(label, setX(2.5));
    expect(S().transientBase).not.toBeNull();
    expect(S().past).toHaveLength(0);
    win.fire('pointerup');
    expect(S().transientBase).toBeNull();
    expect(S().past.map((e) => e.label)).toEqual(['Set x to 2.5']);
    expect(g.active).toBe(false);
    expect(win.count()).toBe(0);
    // The slider's own onCommit after the window release is a no-op.
    g.finish();
    expect(S().past).toHaveLength(1);
  });

  it('a click without a change leaves no entry and no transient behind', () => {
    const g = createSliderEdit(win);
    g.pointerDown(label);
    win.fire('pointerup');
    expect(S().transientBase).toBeNull();
    expect(S().past).toHaveLength(0);
  });

  it('keyboard steps are one entry each and leave no listeners behind', () => {
    const g = createSliderEdit(win);
    for (let k = 1; k <= 5; k++) {
      g.change(label, setX(1.4 + k / 10)); // key down: no pointer down before it
      g.finish(); // key up
      expect(win.count()).toBe(0);
    }
    expect(S().past).toHaveLength(5);
    expect(S().transientBase).toBeNull();
  });

  it('a key-driven gesture whose key-up was missed ends at the next pointer release', () => {
    const g = createSliderEdit(win);
    g.change(label, setX(3));
    win.fire('pointerup');
    expect(S().transientBase).toBeNull();
    expect(S().past.map((e) => e.label)).toEqual(['Set x to 3']);
  });

  it('undo during a drag: the rest of the gesture is ignored (no untracked edit)', () => {
    const before = S().molecule!;
    S().commit(setX(1.5)(before), 'Earlier edit');
    const g = createSliderEdit(win);
    g.pointerDown(label);
    g.change(label, setX(2));
    S().undo(); // Ctrl+Z while the mouse button is still down
    expect(S().molecule).toBe(before);
    g.change(label, setX(2.5));
    expect(S().molecule).toBe(before);
    win.fire('pointerup');
    expect(S().molecule).toBe(before);
    expect(S().past).toHaveLength(0);
    expect(S().future.map((e) => e.label)).toEqual(['Earlier edit']);
    // The next gesture works normally.
    g.pointerDown(label);
    g.change(label, setX(1.8));
    win.fire('pointerup');
    expect(S().past.map((e) => e.label)).toEqual(['Set x to 1.8']);
  });

  it('Escape during a drag cancels it and is not passed on to the global shortcuts', () => {
    S().setSelection([1, 2]);
    const g = createSliderEdit(win);
    g.pointerDown(label);
    g.change(label, setX(2.2));
    const esc = win.fire('keydown', { key: 'Escape' });
    expect(esc.stopped).toBe(true);
    expect(esc.prevented).toBe(true);
    expect(x1()).toBe(1.4);
    expect(S().transientBase).toBeNull();
    // Still holding the button: moving on doesn't restart the edit.
    g.change(label, setX(2.4));
    expect(x1()).toBe(1.4);
    win.fire('pointerup');
    expect(S().past).toHaveLength(0);
    expect(S().selection.size).toBe(2);
    expect(win.count()).toBe(0);
  });

  it("a key released mid-drag (the slider's key up) does not end, split or restart the drag", () => {
    // Shift tapped while dragging: still one entry.
    const g = createSliderEdit(win);
    g.pointerDown(label);
    g.change(label, setX(2));
    g.keyUp();
    g.change(label, setX(2.3));
    expect(S().past).toHaveLength(0);
    win.fire('pointerup');
    expect(S().past.map((e) => e.label)).toEqual(['Set x to 2.3']);
    // Escape (down + up) cancels, and moving on before the release does not start a new edit.
    g.pointerDown(label);
    g.change(label, setX(3));
    win.fire('keydown', { key: 'Escape' });
    g.keyUp();
    g.change(label, setX(3.5));
    expect(x1()).toBe(2.3);
    expect(S().transientBase).toBeNull();
    win.fire('pointerup');
    expect(S().past).toHaveLength(1);
    expect(win.count()).toBe(0);
  });

  it('key up ends a key-driven gesture', () => {
    const g = createSliderEdit(win);
    g.change(label, setX(1.6));
    g.keyUp();
    expect(S().transientBase).toBeNull();
    expect(S().past.map((e) => e.label)).toEqual(['Set x to 1.6']);
    expect(win.count()).toBe(0);
  });

  it('without a window, the slider pointer up ends the drag', () => {
    const g = createSliderEdit(null);
    g.pointerDown(label);
    g.change(label, setX(2));
    g.keyUp();
    expect(S().transientBase).toBeNull();
    expect(S().past).toHaveLength(1);
  });

  it('other keys during a drag pass through', () => {
    const g = createSliderEdit(win);
    g.pointerDown(label);
    g.change(label, setX(2));
    expect(win.fire('keydown', { key: 'Shift' }).stopped).toBe(false);
    win.fire('pointerup');
    expect(S().past).toHaveLength(1);
  });

  it('loading another molecule mid-drag does not edit the new one', () => {
    const g = createSliderEdit(win);
    g.pointerDown(label);
    g.change(label, setX(2));
    const next = pair();
    S().loadMolecule(next);
    g.change(label, setX(2.5));
    g.finish();
    expect(S().molecule).toBe(next);
    expect(S().past).toHaveLength(0);
  });

  it('unmount mid-drag (finish) keeps the change as one entry', () => {
    const g = createSliderEdit(win);
    g.pointerDown(label);
    g.change(label, setX(2));
    g.finish();
    expect(S().past.map((e) => e.label)).toEqual(['Set x to 2']);
    expect(win.count()).toBe(0);
  });
});
