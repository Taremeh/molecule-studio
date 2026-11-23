/**
 * Component-level regression tests: the real components rendered with react-dom/client on the
 * minimal DOM of ./testing/fakeDom, driven by DOM events, checked against the real store.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAll, installFakeDom, makeEvent, type FakeElement } from './testing/fakeDom';

const dom = installFakeDom(); // before React / the components are imported

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const { useStore } = await import('../state/store');
const { atomById, buildMolecule } = await import('../core/molecule');
const { installShortcuts } = await import('../editor/shortcuts');
const GeometryInspector = (await import('./GeometryInspector')).default;
const MeasurementsPanel = (await import('./MeasurementsPanel')).default;
const LayersPanel = (await import('./LayersPanel')).default;
const InfoPanel = (await import('./InfoPanel')).default;
const HoverTooltip = (await import('./HoverTooltip')).default;

type Molecule = import('../core/types').Molecule;
const S = () => useStore.getState();

function propanol(): Molecule {
  // C1–C2–O3 plus the hydrogens of the hydroxyl and C1 (enough for counts / neighbours).
  return buildMolecule(
    'mol',
    [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: 1.54, y: 0, z: 0 },
      { element: 'O', x: 2.0, y: 1.35, z: 0 },
      { element: 'H', x: -0.5, y: 0.9, z: 0 },
      { element: 'H', x: 2.9, y: 1.4, z: 0 },
    ],
    [
      { a: 0, b: 1, order: 1 },
      { a: 1, b: 2, order: 1 },
      { a: 0, b: 3, order: 1 },
      { a: 2, b: 4, order: 1 },
    ],
  );
}

let root: ReturnType<typeof createRoot> | null = null;
let host: FakeElement;
async function mount(...els: React.FunctionComponent[]) {
  host = dom.document.createElement('div');
  dom.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => root!.render(React.createElement(React.Fragment, null, ...els.map((c) => React.createElement(c)))));
}
async function fire(target: FakeElement, type: string, init: Record<string, unknown> = {}) {
  await act(async () => {
    target.dispatchEvent(makeEvent(type, init));
  });
}
const byClass = (cls: string) => findAll(host, (e) => (e.attributes.class ?? '').split(/\s+/).includes(cls));

let uninstallShortcuts = () => {};
beforeEach(() => {
  uninstallShortcuts = installShortcuts();
  S().setMode('view');
  S().setView({ showHydrogens: true });
  S().loadMolecule(propanol());
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  dom.document.activeElement = dom.body;
  uninstallShortcuts();
});
afterAll(() => {
  for (const k of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'HTMLIFrameElement', 'ResizeObserver']) delete (globalThis as Record<string, unknown>)[k];
});

describe('GeometryInspector slider', () => {
  const distance = () => {
    const m = S().molecule!;
    const a = atomById(m, 1)!;
    const b = atomById(m, 2)!;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  };
  async function slider() {
    S().setMode('edit');
    S().setSelection([1, 2]);
    await mount(GeometryInspector);
    return findAll(host, (e) => e.localName === 'input' && e.attributes.type === 'range')[0];
  }
  async function slideTo(input: FakeElement, v: number) {
    input.value = String(v);
    await fire(input, 'input');
  }

  it('a drag is one undo entry', async () => {
    const input = await slider();
    await fire(input, 'pointerdown');
    await slideTo(input, 2.0);
    await slideTo(input, 2.2);
    await fire(input, 'pointerup');
    expect(distance()).toBeCloseTo(2.2, 3);
    expect(S().past.map((e) => e.label)).toEqual(['Set distance to 2.20 Å']);
    expect(S().transientBase).toBeNull();
  });

  it('Ctrl+Z during a drag: moving on does not edit the molecule without an undo entry', async () => {
    S().commit({ ...S().molecule!, name: 'renamed' }, 'Earlier edit');
    const input = await slider();
    await fire(input, 'pointerdown');
    await slideTo(input, 2.0);
    await fire(input, 'keydown', { key: 'z', ctrlKey: true });
    await fire(input, 'keyup', { key: 'z', ctrlKey: true }); // the slider has the focus: it sees the key up
    await slideTo(input, 2.5);
    await fire(input, 'pointerup');
    expect(distance()).toBeCloseTo(1.54, 6);
    expect(S().past).toHaveLength(0);
    expect(S().future.map((e) => e.label)).toEqual(['Earlier edit']);
  });

  it('Escape during a drag cancels it and keeps the selection', async () => {
    const input = await slider();
    await fire(input, 'pointerdown');
    await slideTo(input, 2.2);
    await fire(input, 'keydown', { key: 'Escape' });
    await fire(input, 'keyup', { key: 'Escape' });
    await slideTo(input, 2.4);
    await fire(input, 'pointerup');
    expect(distance()).toBeCloseTo(1.54, 6);
    expect(S().past).toHaveLength(0);
    expect(S().selection.size).toBe(2);
  });

  it('a shortcut edit pressed mid-drag (H: add hydrogens) is kept, as one undo entry', async () => {
    const input = await slider();
    const n0 = S().molecule!.atoms.length;
    await fire(input, 'pointerdown');
    await slideTo(input, 2.0);
    await fire(input, 'keydown', { key: 'h' });
    const n1 = S().molecule!.atoms.length;
    expect(n1).toBeGreaterThan(n0);
    await slideTo(input, 2.1);
    await fire(input, 'pointerup');
    expect(S().molecule!.atoms.length).toBe(n1);
    expect(S().past.map((e) => e.label)).toEqual(['Add hydrogens']);
    S().undo();
    expect(S().molecule!.atoms.length).toBe(n0);
    expect(distance()).toBeCloseTo(1.54, 6);
  });

  it('a value typed into the number field, then a slider drag: both land, as two undo steps', async () => {
    const input = await slider();
    const field = findAll(host, (e) => e.localName === 'input' && e.attributes.inputMode === 'decimal')[0];
    await act(async () => field.focus());
    field.value = '2.000';
    await fire(field, 'input');
    await fire(input, 'pointerdown'); // the browser moves the focus only after the pointer down
    await act(async () => input.focus());
    await slideTo(input, 2.5);
    await fire(input, 'pointerup');
    expect(distance()).toBeCloseTo(2.5, 3);
    expect(S().past.map((e) => e.label)).toEqual(['Set distance to 2.00 Å', 'Set distance to 2.50 Å']);
    S().undo();
    expect(distance()).toBeCloseTo(2.0, 3);
    S().undo();
    expect(distance()).toBeCloseTo(1.54, 6);
  });

  it('a key tapped mid-drag (Shift) keeps the drag one undo entry', async () => {
    const input = await slider();
    await fire(input, 'pointerdown');
    await slideTo(input, 2.0);
    await fire(input, 'keydown', { key: 'Shift', shiftKey: true });
    await fire(input, 'keyup', { key: 'Shift' });
    await slideTo(input, 2.3);
    await fire(input, 'pointerup');
    expect(distance()).toBeCloseTo(2.3, 3);
    expect(S().past.map((e) => e.label)).toEqual(['Set distance to 2.30 Å']);
  });

  it('a right click on the slider does not open a transient edit (the context menu may swallow the release)', async () => {
    const input = await slider();
    await fire(input, 'pointerdown', { button: 2 });
    expect(S().transientBase).toBeNull();
    expect(dom.window.listenerCount('pointerup')).toBe(0);
  });

  it('arrow-key steps leave no window listeners behind', async () => {
    const input = await slider();
    const before = dom.window.listenerCount('pointerup');
    for (let k = 1; k <= 3; k++) {
      await fire(input, 'keydown', { key: 'ArrowRight' });
      await slideTo(input, 1.54 + k / 100);
      await fire(input, 'keyup', { key: 'ArrowRight' });
    }
    expect(S().past).toHaveLength(3);
    expect(dom.window.listenerCount('pointerup')).toBe(before);
  });
});

describe('MeasurementsPanel row hover', () => {
  it("adds its highlight on top of the editor's overlay and restores that overlay on leave", async () => {
    S().addMeasurement('distance', [2, 3]);
    const editorOverlay = [{ atomId: 1, color: 'target' as const }]; // e.g. a pending add-bond start atom
    S().setEditOverlay({ highlightAtoms: editorOverlay });
    await mount(MeasurementsPanel);
    const row = findAll(host, (e) => e.localName === 'li')[0];
    await fire(row, 'mouseover', { relatedTarget: null });
    expect(S().editOverlay.highlightAtoms.map((h) => h.atomId)).toEqual([1, 2, 3]);
    await fire(row, 'mouseout', { relatedTarget: null });
    expect(S().editOverlay.highlightAtoms).toEqual(editorOverlay);
  });
});

describe('LayersPanel atom count', () => {
  it('does not count hydrogens hidden by "Show hydrogens" (View mode)', async () => {
    await mount(LayersPanel);
    const badge = () => byClass('layers-count')[0];
    expect(badge().textContent).toBe('5');
    await act(async () => S().setView({ showHydrogens: false }));
    expect(badge().textContent).toBe('3');
    expect(badge().attributes.title).toMatch(/2 hydrogens hidden/);
    await act(async () => S().setMode('edit')); // hydrogens are always drawn in Edit mode
    expect(badge().textContent).toBe('5');
  });
});

describe('InfoPanel neighbour list', () => {
  it('clears its 3D hover when the list goes away under the pointer', async () => {
    S().setSelection([2]);
    await mount(InfoPanel, HoverTooltip);
    const item = byClass('info-neigh-item')[0];
    await fire(item, 'mouseover', { relatedTarget: null, clientX: 300, clientY: 200 });
    expect(S().hovered?.atomId).toBe(1);
    expect(findAll(host, (e) => e.attributes.role === 'tooltip')).toHaveLength(1);
    await act(async () => S().clearSelection()); // Escape while the pointer rests on the list
    expect(S().hovered).toBeNull();
    expect(findAll(host, (e) => e.attributes.role === 'tooltip')).toHaveLength(0);
  });

  it('clears it when clicking an item shows that atom (the item under the pointer changes)', async () => {
    S().setSelection([2]);
    await mount(InfoPanel);
    const item = byClass('info-neigh-item')[0];
    await fire(item, 'mouseover', { relatedTarget: null, clientX: 300, clientY: 200 });
    await fire(item, 'click');
    expect([...S().selection]).toEqual([1]);
    expect(S().hovered).toBeNull();
  });
});
