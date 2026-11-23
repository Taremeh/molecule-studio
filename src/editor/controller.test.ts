import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/elements', () => import('./testing/fakeElements'));
vi.mock('../core/chemistry', () => import('./testing/fakeChemistry'));
vi.mock('../core/edit', () => import('./testing/fakeEdit'));
vi.mock('../core/geometry', async () => ({
  ...(await vi.importActual<object>('../core/geometry')),
  ...(await import('./testing/fakeGeometry')),
}));

import type { Molecule, Vec3 } from '../core/types';
import { atomById, bondBetween, createMolecule } from '../core/molecule';
import type { PickResult, ViewerApi } from '../render/viewerApi';
import { useStore } from '../state/store';
import { createEditorController, type EditorController } from './controller';
import { counts, ethane, methane, twoGroups } from './testing/molecules';

// --- test harness ------------------------------------------------------------------------------

/** Orthographic mock camera: 100 px per Å, screen y down, looking along −z. */
const PX = 100;
const toScreen = (p: Vec3) => ({ x: p[0] * PX, y: -p[1] * PX, visible: true });

function mockViewer() {
  const atomAt = (x: number, y: number): PickResult | null => {
    const mol = useStore.getState().molecule;
    if (!mol) return null;
    let best: PickResult | null = null;
    let bestD = 12; // px pick radius
    for (const a of mol.atoms) {
      const s = toScreen([a.x, a.y, a.z]);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'atom', atomId: a.id, point: [a.x, a.y, a.z] };
      }
    }
    if (best) return best;
    for (const b of mol.bonds) {
      const p = atomById(mol, b.a)!;
      const q = atomById(mol, b.b)!;
      const s = toScreen([(p.x + q.x) / 2, (p.y + q.y) / 2, (p.z + q.z) / 2]);
      if (Math.hypot(s.x - x, s.y - y) < 6) return { kind: 'bond', bondId: b.id, point: [p.x, p.y, p.z] };
    }
    return null;
  };
  return {
    container: {} as HTMLElement,
    canvas: {} as HTMLCanvasElement,
    pick: vi.fn(atomAt),
    pickRect: vi.fn((x0: number, y0: number, x1: number, y1: number) => {
      const mol = useStore.getState().molecule;
      if (!mol) return [];
      return mol.atoms
        .filter((a) => {
          const s = toScreen([a.x, a.y, a.z]);
          return s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
        })
        .map((a) => a.id);
    }),
    screenToWorldOnPlane: vi.fn((x: number, y: number, plane: Vec3): Vec3 => [x / PX, -y / PX, plane[2]]),
    worldToScreen: vi.fn(toScreen),
    getViewDirection: () => [0, 0, -1] as Vec3,
    getTarget: () => [0, 0, 0] as Vec3,
    focusAtoms: vi.fn(),
    resetView: vi.fn(),
    viewAlong: vi.fn(),
    setControlsEnabled: vi.fn(),
    screenshot: vi.fn(async () => new Blob()),
    requestRender: vi.fn(),
    dispose: vi.fn(),
  } satisfies ViewerApi;
}

interface Harness {
  ctl: EditorController;
  viewer: ReturnType<typeof mockViewer>;
  flush(): void;
  advance(ms: number): void;
  key(key: string): { prevented: boolean; stopped: boolean };
  keyListeners: ((e: unknown) => void)[];
  down(x: number, y: number, mods?: Mods): boolean;
  move(x: number, y: number, mods?: Mods): void;
  up(x: number, y: number, mods?: Mods): void;
  click(x: number, y: number, mods?: Mods): boolean;
  drag(from: [number, number], to: [number, number], mods?: Mods): boolean;
}
type Mods = { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean };

function setup(): Harness {
  const frames: (() => void)[] = [];
  let t = 1000;
  const keyListeners: ((e: unknown) => void)[] = [];
  const viewer = mockViewer();
  const ctl = createEditorController(viewer, {
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => {
      frames.length = 0;
    },
    now: () => t,
    keyTarget: {
      addEventListener: (_t: string, l: unknown) => keyListeners.push(l as (e: unknown) => void),
      removeEventListener: (_t: string, l: unknown) => keyListeners.splice(keyListeners.indexOf(l as (e: unknown) => void), 1),
    },
  });
  const ev = (x: number, y: number, mods: Mods = {}) =>
    ({ clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, shiftKey: !!mods.shift, altKey: !!mods.alt, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta }) as unknown as PointerEvent;
  const flush = () => {
    while (frames.length) frames.shift()!();
  };
  const h: Harness = {
    ctl,
    viewer,
    flush,
    advance: (ms) => (t += ms),
    keyListeners,
    key(key) {
      const res = { prevented: false, stopped: false };
      for (const l of [...keyListeners]) l({ key, preventDefault: () => (res.prevented = true), stopPropagation: () => (res.stopped = true) });
      return res;
    },
    down: (x, y, m) => ctl.onPointerDown(ev(x, y, m)),
    move: (x, y, m) => ctl.onPointerMove(ev(x, y, m)),
    up: (x, y, m) => ctl.onPointerUp(ev(x, y, m)),
    click(x, y, m) {
      const consumed = h.down(x, y, m);
      h.advance(80);
      h.up(x, y, m);
      flush();
      return consumed;
    },
    drag(from, to, m) {
      const consumed = h.down(from[0], from[1], m);
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        h.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, m);
        flush();
      }
      h.advance(200);
      h.up(to[0], to[1], m);
      flush();
      return consumed;
    },
  };
  return h;
}

const S = () => useStore.getState();
const screenOf = (m: Molecule, id: number): [number, number] => {
  const a = atomById(m, id)!;
  const s = toScreen([a.x, a.y, a.z]);
  return [s.x, s.y];
};

function load(m: Molecule, mode: 'view' | 'edit' = 'view', tool = 'select' as Parameters<ReturnType<typeof S>['setTool']>[0]) {
  S().loadMolecule(m);
  useStore.setState({ mode, tool, view: { ...S().view, autoHydrogens: true, snapBonds: true, relaxOnDrag: false } });
}

let h: Harness;
beforeEach(() => {
  h = setup();
});
afterEach(() => {
  h.ctl.dispose();
});

// --- view mode -------------------------------------------------------------------------------

describe('view mode / select tool', () => {
  it('hovers atoms with a hint and clears on leave', () => {
    const m = ethane();
    load(m);
    h.move(...screenOf(m, 1));
    h.flush();
    expect(S().hovered).toMatchObject({ kind: 'atom', atomId: 1 });
    expect(S().hint).toMatch(/click to select/);
    h.ctl.onPointerLeave({} as PointerEvent);
    expect(S().hovered).toBeNull();
    expect(S().hint).toBeNull();
  });

  it('picks at most once per frame', () => {
    load(ethane());
    h.viewer.pick.mockClear();
    for (let i = 0; i < 10; i++) h.move(300 + i, 300);
    expect(h.viewer.pick).not.toHaveBeenCalled();
    h.flush();
    expect(h.viewer.pick).toHaveBeenCalledTimes(1);
  });

  it('never consumes presses on atoms; selects on click', () => {
    const m = ethane();
    load(m);
    expect(h.click(...screenOf(m, 1))).toBe(false);
    expect([...S().selection]).toEqual([1]);
    h.click(...screenOf(m, 5), { shift: true });
    expect([...S().selection]).toEqual([1, 5]);
    h.click(...screenOf(m, 1), { meta: true });
    expect([...S().selection]).toEqual([5]);
    h.click(900, 900);
    expect(S().selection.size).toBe(0);
  });

  it('selects both atoms of a clicked bond', () => {
    const m = ethane();
    load(m);
    h.click(77, 0); // midpoint of C1–C5 at x = 0.77 Å
    expect([...S().selection].sort()).toEqual([1, 5]);
  });

  it('a camera drag is not a click', () => {
    const m = ethane();
    load(m);
    S().setSelection([2]);
    expect(h.drag([900, 900], [960, 940])).toBe(false);
    expect([...S().selection]).toEqual([2]);
    expect(h.drag(screenOf(m, 1), [60, 40])).toBe(false); // drag starting on an atom rotates too
    expect([...S().selection]).toEqual([2]);
  });

  it('ignores slow, unconsumed presses', () => {
    const m = ethane();
    load(m);
    h.down(...screenOf(m, 1));
    h.advance(800);
    h.up(...screenOf(m, 1));
    expect(S().selection.size).toBe(0);
  });

  it('shift-drag on empty space box-selects (consumed)', () => {
    const m = ethane();
    load(m);
    const consumed = h.down(-80, -150, { shift: true });
    expect(consumed).toBe(true);
    h.move(100, 150, { shift: true });
    h.flush();
    expect(S().editOverlay.selectionRect).toEqual({ x0: -80, y0: -150, x1: 100, y1: 150 });
    expect(S().editOverlay.highlightAtoms.length).toBeGreaterThan(0);
    h.up(100, 150, { shift: true });
    h.flush();
    // all atoms with −0.8 ≤ x ≤ 1.0 Å: C1 (0), its H (−0.36) and C5's H (1.18) are outside
    expect([...S().selection].sort()).toEqual([1, 2, 3, 4]);
    expect(S().editOverlay.selectionRect).toBeNull();
  });

  it('double-click selects the fragment and focuses it', () => {
    const m = ethane();
    load(m);
    h.ctl.onDoubleClick({ clientX: screenOf(m, 2)[0], clientY: screenOf(m, 2)[1] } as MouseEvent);
    expect(S().selection.size).toBe(8);
    expect(h.viewer.focusAtoms).toHaveBeenCalled();
  });
});

describe('measure tool', () => {
  it('builds a measurement from clicks', () => {
    const m = ethane();
    load(m, 'view', 'measure');
    h.move(...screenOf(m, 1));
    h.flush();
    expect(S().hint).toMatch(/Pick atom 1 of 2/);
    h.click(...screenOf(m, 1));
    expect(S().pendingMeasure).toEqual([1]);
    h.move(...screenOf(m, 5));
    h.flush();
    expect(S().hint).toMatch(/1\.54 Å/);
    h.click(...screenOf(m, 5));
    expect(S().measurements).toHaveLength(1);
    expect(S().measurements[0]).toMatchObject({ kind: 'distance', atomIds: [1, 5] });
    expect(S().pendingMeasure).toEqual([]);
  });
});

// --- edit mode -------------------------------------------------------------------------------

describe('move tool', () => {
  const pair = () => twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'C', nH: 3, at: [3, 0, 0] });

  it('drags an atom with its hydrogens and snaps a bond on release', () => {
    const m = pair();
    load(m, 'edit', 'move');
    const consumed = h.down(0, 0);
    expect(consumed).toBe(true);
    h.move(60, 0);
    h.flush();
    expect(h.viewer.setControlsEnabled).toHaveBeenLastCalledWith(false);
    expect(S().transientBase).toBe(m);
    expect(atomById(S().molecule!, 1)!.x).toBeCloseTo(0.6, 6);
    h.move(150, 0);
    h.flush();
    expect(S().editOverlay.ghostBonds).toEqual([expect.objectContaining({ style: 'suggest', valid: true })]);
    expect(S().hint).toMatch(/Release to bond C–C/);
    h.up(150, 0);
    h.flush();
    const now = S().molecule!;
    expect(S().transientBase).toBeNull();
    expect(bondBetween(now, 1, 5)).toBeDefined();
    expect(atomById(now, 2)!.x).toBeCloseTo(atomById(m, 2)!.x + 1.5, 6); // H rode along
    expect(S().past.at(-1)?.label).toBe('Move C & bond C–C');
    expect(S().toasts.at(-1)?.message).toBe('Formed C–C bond');
    expect(h.viewer.setControlsEnabled).toHaveBeenLastCalledWith(true);
    // one undo restores the original
    S().undo();
    expect(S().molecule).toBe(m);
  });

  it('Escape cancels a drag and keeps the selection', () => {
    const m = pair();
    load(m, 'edit', 'move');
    S().setSelection([5]);
    h.down(0, 0);
    h.move(100, 50);
    h.flush();
    expect(S().molecule).not.toBe(m);
    const res = h.key('Escape');
    expect(res).toEqual({ prevented: true, stopped: true });
    expect(S().molecule).toBe(m);
    expect(S().transientBase).toBeNull();
    expect([...S().selection]).toEqual([5]);
    h.up(100, 50);
    expect(S().past).toHaveLength(0);
  });

  it('holds back other shortcuts while dragging', () => {
    load(pair(), 'edit', 'move');
    h.down(0, 0);
    h.move(100, 0);
    h.flush();
    expect(h.key('z').stopped).toBe(true);
    expect(h.key('Shift').stopped).toBe(false);
    h.up(100, 0);
  });

  it('moves the selection rigidly when a selected atom is grabbed', () => {
    const m = pair();
    load(m, 'edit', 'move');
    S().setSelection([1, 5]);
    h.drag([0, 0], [0, -100]);
    const now = S().molecule!;
    expect(atomById(now, 1)!.y).toBeCloseTo(1, 6);
    expect(atomById(now, 5)!.y).toBeCloseTo(1, 6);
    expect(atomById(now, 2)!.y).toBeCloseTo(atomById(m, 2)!.y, 6); // hydrogens not selected
    expect(S().past.at(-1)?.label).toBe('Move 2 atoms');
  });

  it('empty-space drags still rotate the camera', () => {
    load(pair(), 'edit', 'move');
    expect(h.down(900, 900)).toBe(false);
  });
});

describe('add-atom tool', () => {
  it('places the first atom at the origin and fills hydrogens', () => {
    const empty = createMolecule('New', { source: 'editor' });
    load(empty, 'edit', 'add-atom');
    h.move(250, 250);
    h.flush();
    expect(S().hint).toBe('Click anywhere to place a C atom');
    h.click(250, 250);
    const m = S().molecule!;
    expect(counts(m)).toEqual({ C: 1, H: 4 });
    expect(atomById(m, 1)).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(S().past.at(-1)?.label).toBe('Add C');
  });

  it('previews and adds an atom on a saturated carbon by replacing the H nearest the pointer', () => {
    const m = methane();
    load(m, 'edit', 'add-atom');
    useStore.setState({ editElement: 'O' });
    // pointer slightly towards H2 (at +x +y on screen: x = 0.63 Å → 63 px, y = −63 px)
    h.move(6, -6);
    h.flush();
    const o = S().editOverlay;
    expect(o.ghostAtoms).toHaveLength(1);
    expect(o.ghostAtoms[0]).toMatchObject({ element: 'O', valid: true });
    expect(o.highlightAtoms).toContainEqual({ atomId: 2, color: 'target' });
    expect(S().hint).toMatch(/Click to add O/);
    expect(h.click(6, -6)).toBe(true);
    const next = S().molecule!;
    expect(atomById(next, 2)).toBeUndefined();
    expect(counts(next)).toEqual({ C: 1, O: 1, H: 4 }); // methanol
  });

  it('shows invalid previews with the reason and toasts on click', () => {
    const co2 = twoGroups({ el: 'C', nH: 0, at: [0, 0, 0] }, { el: 'O', nH: 0, at: [1.16, 0, 0] });
    const m: Molecule = { ...co2, bonds: [{ id: 1, a: 1, b: 2, order: 2 }, ...co2.bonds] };
    const withO = { ...m, atoms: [...m.atoms, { id: 3, element: 'O', x: -1.16, y: 0, z: 0 }], bonds: [...m.bonds, { id: 2, a: 1, b: 3, order: 2 as const }], nextAtomId: 4, nextBondId: 3 };
    load(withO, 'edit', 'add-atom');
    h.move(0, 0);
    h.flush();
    expect(S().editOverlay.ghostAtoms[0]?.valid).toBe(false);
    expect(S().hint).toMatch(/saturated/);
    h.click(0, 0);
    expect(S().molecule).toBe(withO);
    expect(S().toasts.at(-1)).toMatchObject({ kind: 'warning' });
  });

  it('drags from an atom to draw a new bonded atom', () => {
    const m = methane();
    load(m, 'edit', 'add-atom');
    useStore.setState({ editElement: 'N' });
    h.down(0, 0);
    h.move(100, 0);
    h.flush();
    expect(S().editOverlay.ghostBonds[0]).toMatchObject({ style: 'preview', valid: true });
    expect(S().hint).toMatch(/Release to add N/);
    h.up(200, 0);
    h.flush();
    expect(counts(S().molecule!)).toEqual({ C: 1, N: 1, H: 5 });
  });
});

describe('add-bond tool', () => {
  const pair = () => twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'C', nH: 3, at: [1.6, 0, 0] });

  it('click–click bonds two atoms; Escape cancels the first pick', () => {
    load(pair(), 'edit', 'add-bond');
    h.click(0, 0);
    expect(S().editOverlay.highlightAtoms).toContainEqual({ atomId: 1, color: 'target' });
    const k = h.key('Escape');
    expect(k.stopped).toBe(true);
    h.move(0, 0);
    h.flush();
    expect(S().editOverlay.highlightAtoms).not.toContainEqual({ atomId: 1, color: 'target' });
    h.click(0, 0);
    h.move(160, 0);
    h.flush();
    expect(S().hint).toBe('Click to bond C–C');
    h.click(160, 0);
    expect(bondBetween(S().molecule!, 1, 5)).toBeDefined();
    expect(S().past.at(-1)?.label).toBe('Bond C–C');
  });

  it('drag A → B bonds them and clicking a bond cycles its order', () => {
    load(pair(), 'edit', 'add-bond');
    h.drag([0, 0], [160, 0]);
    const m = S().molecule!;
    const bond = bondBetween(m, 1, 5)!;
    expect(bond.order).toBe(1);
    h.click(80, 0); // bond midpoint
    expect(bondBetween(S().molecule!, 1, 5)!.order).toBe(2);
    expect(counts(S().molecule!)).toEqual({ C: 2, H: 4 }); // ethene, re-hydrogenated
  });

  it('refuses invalid bonds with a toast', () => {
    const m = twoGroups({ el: 'C', nH: 4, at: [0, 0, 0] }, { el: 'C', nH: 4, at: [1.6, 0, 0] });
    load(m, 'edit', 'add-bond');
    useStore.setState({ view: { ...S().view, autoHydrogens: false } });
    h.drag([0, 0], [160, 0]);
    expect(S().molecule).toBe(m);
    expect(S().toasts.at(-1)?.message).toBe("C already has 4 bonds — can't add another");
  });
});

describe('delete tool', () => {
  it('highlights what will be deleted and deletes it', () => {
    const m = ethane();
    load(m, 'edit', 'delete');
    h.move(0, 0);
    h.flush();
    expect(S().editOverlay.highlightAtoms.map((x) => x.atomId).sort()).toEqual([1, 2, 3, 4]);
    expect(S().hint).toMatch(/and its 3 H/);
    expect(h.click(0, 0)).toBe(true);
    expect(counts(S().molecule!)).toEqual({ C: 1, H: 4 }); // methane left over
    expect(S().past.at(-1)?.label).toBe('Delete C');
  });

  it('shift-drag deletes a region', () => {
    load(ethane(), 'edit', 'delete');
    useStore.setState({ view: { ...S().view, autoHydrogens: false } });
    h.drag([-80, -150], [100, 150], { shift: true });
    expect(counts(S().molecule!)).toEqual({ C: 1, H: 3 });
  });
});

describe('element & charge tools', () => {
  it('changes an element', () => {
    load(methane(), 'edit', 'element');
    useStore.setState({ editElement: 'N' });
    h.move(0, 0);
    h.flush();
    expect(S().editOverlay.ghostAtoms[0]).toMatchObject({ element: 'N', valid: true });
    h.click(0, 0);
    expect(counts(S().molecule!)).toEqual({ N: 1, H: 3 });
  });

  it('adds and removes charge', () => {
    load(methane(), 'edit', 'charge');
    h.click(0, 0, { shift: true });
    expect(atomById(S().molecule!, 1)!.charge).toBe(-1);
    expect(counts(S().molecule!)).toEqual({ C: 1, H: 3 });
  });
});

describe('lifecycle', () => {
  it('refreshes the preview when the tool changes under a still pointer', () => {
    load(methane(), 'edit', 'select');
    h.move(0, 0);
    h.flush();
    expect(S().hint).toMatch(/click to select/);
    S().setTool('delete');
    h.flush();
    expect(S().hint).toMatch(/Click to delete/);
  });

  it('dispose removes listeners and clears feedback', () => {
    load(methane(), 'edit', 'delete');
    h.move(0, 0);
    h.flush();
    expect(h.keyListeners).toHaveLength(1);
    h.ctl.dispose();
    expect(h.keyListeners).toHaveLength(0);
    expect(S().hint).toBeNull();
    expect(S().editOverlay.highlightAtoms).toEqual([]);
  });
});
