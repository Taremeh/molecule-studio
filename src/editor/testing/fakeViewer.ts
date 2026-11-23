/**
 * TEST ONLY — a scriptable stand-in for render/Viewer plus a harness that drives the editor
 * controller with real pointer / key sequences (no DOM, no WebGL).
 *
 * Camera: orthographic, `pxPerA` pixels per Å, screen y down, looking along −z, rotated by
 * `camera.angle` degrees about the z axis (view axis) and shifted by `camera.pan` (px). Change the
 * camera fields to simulate zoom / auto-rotation / panning under a still pointer.
 */
import { vi } from 'vitest';
import type { Molecule, Vec3 } from '../../core/types';
import { atomById } from '../../core/molecule';
import type { PickResult, ViewerApi } from '../../render/viewerApi';
import { useStore } from '../../state/store';
import { createEditorController, type EditorController } from '../controller';

export interface FakeCamera {
  pxPerA: number;
  /** Rotation about the view axis, degrees. */
  angle: number;
  pan: [number, number];
}

export function createFakeViewer(camera: FakeCamera = { pxPerA: 100, angle: 0, pan: [0, 0] }) {
  const toScreen = (p: Vec3) => {
    const t = (camera.angle * Math.PI) / 180;
    const x = p[0] * Math.cos(t) - p[1] * Math.sin(t);
    const y = p[0] * Math.sin(t) + p[1] * Math.cos(t);
    return { x: x * camera.pxPerA + camera.pan[0], y: -y * camera.pxPerA + camera.pan[1], visible: true };
  };
  const toWorld = (sx: number, sy: number, z: number): Vec3 => {
    const x = (sx - camera.pan[0]) / camera.pxPerA;
    const y = -(sy - camera.pan[1]) / camera.pxPerA;
    const t = (-camera.angle * Math.PI) / 180;
    return [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t), z];
  };
  const pick = (x: number, y: number): PickResult | null => {
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
  const viewer = {
    container: {} as HTMLElement,
    canvas: {} as HTMLCanvasElement,
    pick: vi.fn(pick),
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
    screenToWorldOnPlane: vi.fn((x: number, y: number, plane: Vec3): Vec3 => toWorld(x, y, plane[2])),
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
  return { viewer, camera, toScreen };
}

export type Mods = { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean };

/** Fake key event; `target` defaults to a plain element outside any dialog. */
export interface FakeKey {
  key: string;
  target?: unknown;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export function createHarness(camera?: FakeCamera) {
  const frames: (() => void)[] = [];
  let t = 1000;
  const keyListeners: ((e: unknown) => void)[] = [];
  const containerListeners = new Map<string, ((e: unknown) => void)[]>();
  const fake = createFakeViewer(camera);
  const viewer = {
    ...fake.viewer,
    container: {
      addEventListener: (type: string, l: (e: unknown) => void) => {
        const list = containerListeners.get(type) ?? [];
        list.push(l);
        containerListeners.set(type, list);
      },
      removeEventListener: (type: string, l: (e: unknown) => void) => {
        const list = containerListeners.get(type) ?? [];
        const i = list.indexOf(l);
        if (i >= 0) list.splice(i, 1);
      },
    } as unknown as HTMLElement,
  };
  const ctl: EditorController = createEditorController(viewer, {
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
  /** Run pending animation frames (bounded, so a self-rescheduling loop fails loudly instead of hanging). */
  const flush = (max = 1000) => {
    let n = 0;
    while (frames.length) {
      if (++n > max) throw new Error('animation frames keep rescheduling');
      frames.shift()!();
    }
    return n;
  };
  const h = {
    ctl,
    viewer,
    camera: fake.camera,
    toScreen: fake.toScreen,
    frames,
    flush,
    /** Run exactly one pending frame (if any). */
    step() {
      const f = frames.shift();
      f?.();
      return !!f;
    },
    advance: (ms: number) => (t += ms),
    keyListeners,
    containerEvent(type: string, e: unknown = {}) {
      for (const l of [...(containerListeners.get(type) ?? [])]) l(e);
    },
    key(k: string | FakeKey) {
      const spec: FakeKey = typeof k === 'string' ? { key: k } : k;
      const res = { prevented: false, stopped: false };
      for (const l of [...keyListeners]) {
        l({ ...spec, target: spec.target ?? null, preventDefault: () => (res.prevented = true), stopPropagation: () => (res.stopped = true) });
      }
      return res;
    },
    down: (x: number, y: number, m?: Mods) => ctl.onPointerDown(ev(x, y, m)),
    move: (x: number, y: number, m?: Mods) => ctl.onPointerMove(ev(x, y, m)),
    up: (x: number, y: number, m?: Mods) => ctl.onPointerUp(ev(x, y, m)),
    click(x: number, y: number, m?: Mods) {
      const consumed = h.down(x, y, m);
      h.advance(80);
      h.up(x, y, m);
      flush();
      return consumed;
    },
    drag(from: [number, number], to: [number, number], m?: Mods, steps = 5) {
      const consumed = h.down(from[0], from[1], m);
      for (let i = 1; i <= steps; i++) {
        h.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, m);
        flush();
      }
      h.advance(200);
      h.up(to[0], to[1], m);
      flush();
      return consumed;
    },
    screenOf(m: Molecule, id: number): [number, number] {
      const a = atomById(m, id)!;
      const s = fake.toScreen([a.x, a.y, a.z]);
      return [s.x, s.y];
    },
  };
  return h;
}

export type Harness = ReturnType<typeof createHarness>;
