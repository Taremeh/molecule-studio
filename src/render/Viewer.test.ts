/**
 * Integration test for render/Viewer.ts in node: a minimal fake DOM and a fake WebGLRenderer (three's
 * real scene graph, cameras, TrackballControls, representations, picking and overlays are used).
 * Exercises the store → scene pipeline, camera framing, picking through the real camera, the in-place
 * update paths, screenshots and disposal.
 */
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------
type Listener = (ev: unknown) => void;

const CANVAS_RECT = { left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650, x: 100, y: 50 };

const ctx2d: unknown = new Proxy(
  {},
  {
    get(_t, k) {
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6 });
      return () => undefined;
    },
    set: () => true,
  },
);

function fakeEl(tag: string): any {
  const listeners = new Map<string, Set<Listener>>();
  return {
    tagName: tag.toUpperCase(),
    style: {},
    className: '',
    children: [] as unknown[],
    parent: null as unknown,
    width: 300,
    height: 150,
    clientWidth: 800,
    clientHeight: 600,
    ownerDocument: (globalThis as Record<string, unknown>).document,
    appendChild(c: { parent: unknown }) {
      this.children.push(c);
      c.parent = this;
      return c;
    },
    remove() {
      const p = this.parent as { children: unknown[] } | null;
      if (p) p.children = p.children.filter((x) => x !== this);
      this.parent = null;
    },
    addEventListener(t: string, f: Listener) {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(f);
    },
    removeEventListener(t: string, f: Listener) {
      listeners.get(t)?.delete(f);
    },
    getBoundingClientRect: () => CANVAS_RECT,
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
    getContext: (type: string) => (type === '2d' ? ctx2d : null),
    toBlob(cb: (b: Blob | null) => void) {
      cb(new Blob(['png'], { type: 'image/png' }));
    },
  };
}

const g = globalThis as Record<string, unknown>;
const win = fakeEl('window');
Object.assign(g, {
  window: g,
  devicePixelRatio: 2,
  pageXOffset: 0,
  pageYOffset: 0,
  addEventListener: win.addEventListener.bind(win),
  removeEventListener: win.removeEventListener.bind(win),
  document: {
    createElement: fakeEl,
    documentElement: { clientLeft: 0, clientTop: 0 },
    activeElement: null,
    body: {},
    addEventListener() {},
    removeEventListener() {},
  },
});
let rafQueue: ((t: number) => void)[] = [];
g.requestAnimationFrame = (f: (t: number) => void) => rafQueue.push(f);
g.cancelAnimationFrame = () => {
  rafQueue = [];
};
let now = 1000;
vi.spyOn(performance, 'now').mockImplementation(() => now);
function tick(ms = 16) {
  now += ms;
  const q = rafQueue;
  rafQueue = [];
  for (const f of q) f(now);
}

// ---------------------------------------------------------------------------
// Fake renderer (everything else in three is real)
// ---------------------------------------------------------------------------
const renders: { width: number }[] = [];
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    domElement = fakeEl('canvas');
    pr = 1;
    w = 1;
    h = 1;
    outputColorSpace = '';
    clear: unknown[] = [];
    setPixelRatio(v: number) {
      this.pr = v;
      this.setSize(this.w, this.h);
    }
    getPixelRatio() {
      return this.pr;
    }
    setSize(w: number, h: number) {
      this.w = w;
      this.h = h;
      this.domElement.width = w * this.pr;
      this.domElement.height = h * this.pr;
    }
    setClearColor(c: unknown, a: number) {
      this.clear = [c, a];
    }
    render() {
      renders.push({ width: this.domElement.width });
    }
    getContext() {
      const el = this.domElement;
      return {
        MAX_RENDERBUFFER_SIZE: 1,
        MAX_VIEWPORT_DIMS: 2,
        getParameter: (p: number) => (p === 1 ? 8192 : new Int32Array([8192, 8192])),
        get drawingBufferWidth() {
          return el.width;
        },
        get drawingBufferHeight() {
          return el.height;
        },
      };
    }
    dispose() {}
    forceContextLoss() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

const { Viewer } = await import('./Viewer');
const { useStore } = await import('../state/store');
const { ethylene, moveAtom } = await import('./testMolecules');
const { buildMolecule } = await import('../core/molecule');

type Internals = {
  entries: Map<string, { rep: { style: string }; atomRep: { atoms: Int32Array } | null; object: unknown }>;
  overlays: { group: import('three').Group; labelItems: { text: string }[] };
  renderer: { getPixelRatio(): number; clear: unknown[] };
  labelDrawItems(): { kind: string }[];
};

describe('Viewer', () => {
  it('loads, frames, picks, updates in place, screenshots and disposes', async () => {
    const container = fakeEl('div');
    const v = new Viewer(container);
    const vi_ = v as unknown as Internals;
    expect(container.children.length).toBe(2); // WebGL canvas + label canvas
    tick();
    expect(v.pick(500, 350)).toBeNull();
    expect(v.pickRect(0, 0, 2000, 2000)).toEqual([]);

    const mol = ethylene();
    useStore.getState().loadMolecule(mol);
    tick();
    expect(vi_.entries.size).toBe(1);
    // documentId change → reset view: rotate about the centroid, looking down −Z.
    expect(v.getTarget()[0]).toBeCloseTo(0.665, 3);
    expect(v.getViewDirection()[2]).toBeCloseTo(-1, 6);
    for (const a of mol.atoms) expect(v.worldToScreen([a.x, a.y, a.z]).visible).toBe(true);

    // Picking through the real camera.
    const s0 = v.worldToScreen([0, 0, 0]);
    expect(v.pick(s0.x, s0.y)).toMatchObject({ kind: 'atom', atomId: 1 });
    const sm = v.worldToScreen([0.665, 0, 0]);
    expect(v.pick(sm.x, sm.y)).toMatchObject({ kind: 'bond', bondId: 1 });
    expect(v.pickRect(0, 0, 2000, 2000).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(v.pickRect(s0.x - 3, s0.y - 3, s0.x + 3, s0.y + 3)).toEqual([1]);
    const p: [number, number, number] = [1.33, 0.4, 0];
    const sp = v.worldToScreen(p);
    v.screenToWorldOnPlane(sp.x, sp.y, p).forEach((x, i) => expect(x).toBeCloseTo(p[i], 4));

    // Camera moves.
    v.focusAtoms([2], false);
    expect(v.getTarget()[0]).toBeCloseTo(1.33, 5);
    v.viewAlong('x');
    for (let k = 0; k < 30; k++) tick();
    expect(v.getViewDirection()[0]).toBeCloseTo(-1, 4);
    v.resetView();
    for (let k = 0; k < 30; k++) tick();

    // Switching projection keeps the framing.
    const before = v.worldToScreen([1.33, 0, 0]);
    useStore.getState().setView({ projection: 'orthographic' });
    tick();
    const after = v.worldToScreen([1.33, 0, 0]);
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);
    expect(v.pick(after.x, after.y)).toMatchObject({ kind: 'atom', atomId: 2 });
    useStore.getState().setView({ projection: 'perspective' });
    tick();

    // Coordinate-only edit → same representation instance, pick at the new position.
    const entry = [...vi_.entries.values()][0];
    const inst = entry.atomRep;
    const atoms = mol.atoms.slice();
    atoms[0] = { ...atoms[0], z: 1.5 };
    useStore.getState().commit({ ...mol, atoms }, 'Move');
    tick();
    expect(entry.atomRep).toBe(inst);
    const sMoved = v.worldToScreen([0, 0, 1.5]);
    expect(v.pick(sMoved.x, sMoved.y)).toMatchObject({ kind: 'atom', atomId: 1 });

    // Opacity, colour and scale are applied in place.
    const repId = useStore.getState().reps[0].id;
    useStore.getState().updateRep(repId, { opacity: 0.5 });
    useStore.getState().updateRep(repId, { color: 'uniform', uniformColor: '#ff0000', scale: 1.5 });
    tick();
    expect(entry.atomRep).toBe(inst);

    // Hiding hydrogens rebuilds; hidden atoms are not pickable.
    useStore.getState().setView({ showHydrogens: false });
    tick();
    expect(entry.atomRep).not.toBe(inst);
    expect(entry.atomRep!.atoms.length).toBe(2);
    const sh = v.worldToScreen([mol.atoms[2].x, mol.atoms[2].y, 0]);
    expect(v.pick(sh.x, sh.y)?.atomId).not.toBe(3);
    useStore.getState().setView({ showHydrogens: true });

    // Overlays and labels.
    useStore.getState().setSelection([1, 2]);
    useStore.getState().addMeasurement('distance', [1, 2]);
    useStore.getState().setHovered({ kind: 'bond', bondId: 1, clientX: 0, clientY: 0 });
    useStore.getState().setView({ labelMode: 'element' });
    tick();
    const halos = vi_.overlays.group.getObjectByName('selection-halos') as import('three').InstancedMesh;
    expect(halos.visible && halos.count).toBe(2);
    expect(vi_.overlays.labelItems[0].text).toMatch(/Å$/);
    expect(vi_.labelDrawItems().filter((x) => x.kind === 'atom').length).toBe(2);

    // Screenshot at 2× with a transparent background; the renderer is restored afterwards.
    const pr = vi_.renderer.getPixelRatio();
    const blob = await v.screenshot({ scale: 2, transparent: true });
    expect(blob).toBeInstanceOf(Blob);
    expect(renders.some((r) => r.width === 800 * pr * 2)).toBe(true);
    expect(vi_.renderer.getPixelRatio()).toBe(pr);
    expect(vi_.renderer.clear[1]).toBe(1);

    // Switching a layer's style releases the previous geometry (no stale atom data for picking).
    const root = (v as unknown as { repRoot: import('three').Group }).repRoot;
    const disposeSpy = vi.spyOn(entry.atomRep as unknown as { dispose(): void }, 'dispose');
    useStore.getState().updateRep(repId, { style: 'surface' });
    tick();
    expect(disposeSpy).toHaveBeenCalled();
    expect(entry.atomRep).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    tick();
    expect(root.children.length).toBeLessThanOrEqual(1);
    useStore.getState().updateRep(repId, { style: 'lines' });
    tick();
    expect(entry.atomRep).not.toBeNull();
    expect(root.children.length).toBe(1);
    const s1 = v.worldToScreen([0, 0, 1.5]); // atom 1 was moved above
    expect(v.pick(s1.x, s1.y)).toMatchObject({ kind: 'atom', atomId: 1 });

    // Every style builds; removing layers clears picking.
    for (const style of ['lines', 'spacefill', 'licorice', 'cartoon', 'surface'] as const) useStore.getState().addRep({ style, selection: 'all' });
    tick();
    await new Promise((r) => setTimeout(r, 30));
    tick();
    expect(vi_.entries.size).toBe(6);
    expect(v.pick(s0.x, s0.y)?.kind).toBe('atom');
    useStore.getState().setReps([]);
    tick();
    expect(vi_.entries.size).toBe(0);
    expect(v.pick(s0.x, s0.y)).toBeNull();

    // Empty document (edit mode).
    useStore.getState().newDocument();
    tick();
    expect(v.pick(500, 350)).toBeNull();
    expect(v.getTarget()).toEqual([0, 0, 0]);

    // Idle frames do not render.
    const n0 = renders.length;
    tick();
    tick();
    expect(renders.length).toBe(n0);

    v.dispose();
    expect(container.children.length).toBe(0);
    expect(g.__viewerInstance).toBeUndefined();
    expect(rafQueue.length).toBe(0);
    useStore.getState().loadMolecule(ethylene());
    tick();
    expect(renders.length).toBe(n0);
  });

  it('shows valence markers in edit mode and keeps pulsing while they are visible', () => {
    const v = new Viewer(fakeEl('div'));
    const vi_ = v as unknown as Internals;
    const base = ethylene();
    // Remove one H from C1 (open valence) and give C2 five bonds (over-valent).
    const atoms = base.atoms.filter((a) => a.id !== 3).concat([
      { id: 7, element: 'H', x: 1.33, y: 0, z: 1.1 },
      { id: 8, element: 'H', x: 1.33, y: 0, z: -1.1 },
    ]);
    const bonds = base.bonds.filter((b) => b.a !== 3 && b.b !== 3).concat([
      { id: 6, a: 2, b: 7, order: 1 },
      { id: 7, a: 2, b: 8, order: 1 },
    ]);
    useStore.getState().loadMolecule({ ...base, atoms, bonds, nextAtomId: 9, nextBondId: 8, meta: { source: 'editor' } });
    useStore.getState().setMode('edit');
    tick();
    const count = (name: string) => {
      const m = vi_.overlays.group.getObjectByName(name) as import('three').InstancedMesh | undefined;
      return m && m.visible ? m.count : 0;
    };
    expect(count('valence-over')).toBeGreaterThanOrEqual(1);
    expect(count('valence-stubs')).toBeGreaterThanOrEqual(1);
    const n = renders.length;
    tick();
    tick();
    expect(renders.length).toBeGreaterThan(n);
    useStore.getState().setMode('view');
    tick();
    expect(count('valence-over')).toBe(0);

    // Auto-rotate turns the camera.
    useStore.getState().setView({ autoRotate: true });
    tick();
    const d0 = v.getViewDirection();
    for (let k = 0; k < 10; k++) tick(50);
    const d1 = v.getViewDirection();
    expect(Math.abs(d1[0] - d0[0]) + Math.abs(d1[2] - d0[2])).toBeGreaterThan(0.05);
    useStore.getState().setView({ autoRotate: false });
    v.dispose();
  });

  it('survives a StrictMode-style mount / unmount / mount', () => {
    const c = fakeEl('div');
    const a = new Viewer(c);
    a.dispose();
    const b = new Viewer(c);
    tick();
    expect(c.children.length).toBe(2);
    expect(g.__viewerInstance).toBe(b);
    b.dispose();
  });

  /** Screen pixels per Å at world point p (horizontal). */
  const pxPerAngstrom = (v: InstanceType<typeof Viewer>, p: [number, number, number]) =>
    v.worldToScreen([p[0] + 1, p[1], p[2]]).x - v.worldToScreen(p).x;
  /** Methane centred at c (atom ids 1..5). */
  const methaneAt = (c: [number, number, number]) => {
    const d = 1.09 / Math.sqrt(3);
    const hs = [
      [d, d, d],
      [-d, -d, d],
      [-d, d, -d],
      [d, -d, -d],
    ];
    return buildMolecule(
      'New molecule',
      [{ element: 'C', x: c[0], y: c[1], z: c[2] }, ...hs.map(([x, y, z]) => ({ element: 'H', x: c[0] + x, y: c[1] + y, z: c[2] + z }))],
      [1, 2, 3, 4].map((k) => ({ a: 0, b: k })),
      { source: 'editor' },
    );
  };

  it('frames an empty document closely and frames its first atoms once', () => {
    const v = new Viewer(fakeEl('div'));
    useStore.getState().newDocument();
    tick();
    // A new, empty document is framed a few Å around the origin (where the first atom goes), so the
    // first atoms are drawn at a useful size (≥ 50 px per Å on a 600 px tall view, i.e. < 12 Å tall).
    expect(v.getTarget()).toEqual([0, 0, 0]);
    expect(pxPerAngstrom(v, [0, 0, 0])).toBeGreaterThan(50);

    // The first atoms of the empty document are framed once (here placed away from the origin).
    useStore.getState().commit(methaneAt([6, 0, 0]), 'Add C');
    for (let k = 0; k < 30; k++) tick();
    v.getTarget().forEach((x, i) => expect(x).toBeCloseTo([6, 0, 0][i], 3));
    expect(pxPerAngstrom(v, [6, 0, 0])).toBeGreaterThan(50);
    const target = v.getTarget();
    const scale = pxPerAngstrom(v, [6, 0, 0]);

    // Later edits never move the camera.
    const mol = useStore.getState().molecule!;
    const grown = { ...mol, atoms: [...mol.atoms, { id: 6, element: 'C', x: 6, y: 9, z: 0 }], nextAtomId: 7 };
    useStore.getState().commit(grown, 'Add C');
    for (let k = 0; k < 30; k++) tick();
    expect(v.getTarget()).toEqual(target);
    expect(pxPerAngstrom(v, [6, 0, 0])).toBeCloseTo(scale, 6);
    v.dispose();
  });

  it('frames the visible layers, not hidden waters spread around the structure', () => {
    const v = new Viewer(fakeEl('div'));
    // A small peptide-like cluster at the origin plus hidden waters 40 Å away.
    const atoms = [
      ...Array.from({ length: 6 }, (_, i) => ({ element: 'C', name: 'CA', resName: 'ALA', resSeq: i + 1, chain: 'A', x: i * 1.5, y: 0, z: 0 })),
      ...[40, -40].map((x, i) => ({ element: 'O', name: 'O', resName: 'HOH', resSeq: 100 + i, chain: 'W', hetero: true, x, y: 0, z: 0 })),
    ];
    useStore.getState().loadMolecule(buildMolecule('peptide', atoms, []));
    const reps = useStore.getState().reps;
    useStore.getState().setReps(reps.map((r) => (r.selection === 'water' ? { ...r, visible: false } : r)));
    v.resetView();
    for (let k = 0; k < 60; k++) tick();
    v.getTarget().forEach((x, i) => expect(x).toBeCloseTo([3.75, 0, 0][i], 1));
    const framed = pxPerAngstrom(v, [3.75, 0, 0]);
    // With every atom framed the view would have to span ~80 Å; the peptide alone spans ~8 Å.
    expect(framed).toBeGreaterThan(20);
    v.dispose();
  });

  it('does not move the camera when the first atom lands at the origin of an empty document', () => {
    const v = new Viewer(fakeEl('div'));
    useStore.getState().newDocument();
    tick();
    const scale = pxPerAngstrom(v, [0, 0, 0]);
    useStore.getState().commit(methaneAt([0, 0, 0]), 'Add C'); // what add-atom does on an empty document
    for (let k = 0; k < 30; k++) tick();
    v.getTarget().forEach((x) => expect(x).toBeCloseTo(0, 6));
    expect(pxPerAngstrom(v, [0, 0, 0])).toBeCloseTo(scale, 4);
    v.dispose();
  });

  it('keeps the camera when undo brings back the atoms of an emptied document', () => {
    const v = new Viewer(fakeEl('div'));
    const mol = methaneAt([20, 3, 0]);
    useStore.getState().loadMolecule(mol);
    tick();
    v.focusAtoms([2], false); // the user looks at a part of the molecule
    tick();
    const target = v.getTarget();
    const scale = pxPerAngstrom(v, [20, 3, 0]);
    const empty = buildMolecule('New molecule', [], [], { source: 'editor' });
    useStore.getState().commit(empty, 'Delete 5 atoms'); // select all + Delete
    for (let k = 0; k < 30; k++) tick();
    useStore.getState().undo();
    for (let k = 0; k < 30; k++) tick();
    expect(v.getTarget()).toEqual(target);
    expect(pxPerAngstrom(v, [20, 3, 0])).toBeCloseTo(scale, 6);
    useStore.getState().redo(); // empty again
    for (let k = 0; k < 30; k++) tick();
    // The view was moved while the document was empty ("R"): the restored atoms are framed again.
    v.resetView();
    for (let k = 0; k < 30; k++) tick();
    useStore.getState().undo();
    for (let k = 0; k < 30; k++) tick();
    v.getTarget().forEach((x, i) => expect(x).toBeCloseTo([20, 3, 0][i], 3));
    // A new first atom of the emptied document (at the origin, possibly off-screen) is framed.
    useStore.getState().commit(empty, 'Delete 5 atoms');
    for (let k = 0; k < 30; k++) tick();
    useStore.getState().commit(methaneAt([0, 0, 0]), 'Add C');
    for (let k = 0; k < 30; k++) tick();
    v.getTarget().forEach((x) => expect(x).toBeCloseTo(0, 3));
    v.dispose();
  });

  it('keeps a valid camera when focusing an empty document', () => {
    const v = new Viewer(fakeEl('div'));
    useStore.getState().newDocument();
    tick();
    v.focusAtoms(); // "F" / Center on a new document
    for (let k = 0; k < 30; k++) tick();
    for (const x of v.getTarget()) expect(Number.isFinite(x)).toBe(true);
    useStore.getState().commit(methaneAt([0, 0, 0]), 'Add C');
    for (let k = 0; k < 30; k++) tick();
    const s = v.worldToScreen([0, 0, 0]);
    expect(s.visible).toBe(true);
    expect(v.pick(s.x, s.y)).toMatchObject({ kind: 'atom', atomId: 1 });
    v.dispose();
  });

  it('keeps atom layers pickable when a throttled cartoon rebuild runs before the store is flushed', async () => {
    const v = new Viewer(fakeEl('div'));
    const internals = v as unknown as { entries: Map<string, { rep: { style: string }; lastBuildMs: number }> };
    const mol = ethylene();
    useStore.getState().loadMolecule(mol);
    useStore.getState().addRep({ style: 'cartoon', selection: 'all' });
    tick();
    // Pretend the cartoon is slow to build, so coordinate edits rebuild it on a timer.
    for (const e of internals.entries.values()) if (e.rep.style === 'cartoon') e.lastBuildMs = 40;
    const m1 = moveAtom(mol, 0, 0, 0, 0.2);
    useStore.getState().commit(m1, 'Move');
    tick(); // schedules the cartoon rebuild (≥ 80 ms)
    // A drag frame updates the store after the viewer's frame; the timer fires before the next frame.
    const m2 = moveAtom(m1, 0, 0, 0, 0.2);
    useStore.getState().updateTransient(m2);
    await new Promise((r) => setTimeout(r, 150));
    tick();
    const s = v.worldToScreen([1.33, 0, 0]); // atom 2 (not moved)
    expect(v.pick(s.x, s.y)).toMatchObject({ kind: 'atom', atomId: 2 });
    v.dispose();
  });

  it('pauses auto-rotation while the editor has the camera controls disabled (atom drags)', () => {
    const v = new Viewer(fakeEl('div'));
    useStore.getState().loadMolecule(ethylene());
    useStore.getState().setView({ autoRotate: true });
    tick();
    v.setControlsEnabled(false); // editor drag starts: the drag plane is fixed to the current view
    const d0 = v.getViewDirection();
    for (let k = 0; k < 10; k++) tick(50);
    v.getViewDirection().forEach((x, i) => expect(x).toBeCloseTo(d0[i], 9));
    v.setControlsEnabled(true); // drag ended
    for (let k = 0; k < 10; k++) tick(50);
    const d1 = v.getViewDirection();
    expect(Math.abs(d1[0] - d0[0]) + Math.abs(d1[2] - d0[2])).toBeGreaterThan(0.05);
    useStore.getState().setView({ autoRotate: false });
    v.dispose();
  });

  it('follows devicePixelRatio changes (browser zoom, moving to another display)', () => {
    const v = new Viewer(fakeEl('div'));
    const vi_ = v as unknown as Internals & { labels: { dpr: number } };
    g.devicePixelRatio = 1;
    tick();
    expect(vi_.renderer.getPixelRatio()).toBe(1);
    expect(vi_.labels.dpr).toBe(1);
    g.devicePixelRatio = 1.5;
    tick();
    expect(vi_.renderer.getPixelRatio()).toBe(1.5);
    expect(vi_.labels.dpr).toBe(1.5);
    g.devicePixelRatio = 2;
    v.dispose();
  });
});
