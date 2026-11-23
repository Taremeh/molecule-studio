/**
 * Keys typed into dialogs, popovers and text fields — or while a modal is open — must not run editor
 * shortcuts or the controller's Escape handling (regression tests for the global key plumbing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../app/actions', () => ({
  cmdAddHydrogens: vi.fn(),
  cmdRemoveHydrogens: vi.fn(),
  cmdCleanGeometry: vi.fn(async () => {}),
  cmdDeleteSelection: vi.fn(),
  exportMolecule: vi.fn(),
  focusSelection: vi.fn(),
}));

import { atomById } from '../core/molecule';
import { useStore } from '../state/store';
import { installShortcuts } from './shortcuts';
import { hasOpenPopover, isInsideOverlay, keyBelongsToUi } from './keyScope';
import { createHarness, type Harness } from './testing/fakeViewer';
import { twoGroups } from './testing/molecules';

const S = () => useStore.getState();

/** Minimal DOM element stand-in: `inside` lists the selectors of its ancestors (for closest()). */
function el(tagName: string, inside: string[] = [], type?: string) {
  return {
    tagName,
    type,
    closest: (sel: string) => (sel.split(',').some((s) => inside.includes(s.trim())) ? {} : null),
  };
}
const body = el('BODY');
const dialogButton = el('BUTTON', ['[role="dialog"]', '[aria-modal="true"]', '.modal']);
const menuItem = el('BUTTON', ['.popover', '[role="menu"]']);
const textField = el('INPUT', [], 'text');

type Listener = (e: unknown) => void;
let listeners: Listener[] = [];
let openPopover: unknown = null;
let uninstall: () => void = () => {};

function press(key: string, target: unknown, mods: { ctrl?: boolean; shift?: boolean } = {}) {
  const ev = {
    key,
    target,
    ctrlKey: !!mods.ctrl,
    metaKey: false,
    shiftKey: !!mods.shift,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault() {
      ev.defaultPrevented = true;
    },
  };
  for (const l of [...listeners]) l(ev);
  return ev;
}

function loadEdited() {
  const m = twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'C', nH: 3, at: [1.6, 0, 0] });
  S().loadMolecule(m);
  useStore.setState({ mode: 'edit', tool: 'move', panels: { ...S().panels, help: false, load: false, settings: false } });
  // one edit so that undo has something to do
  S().commit({ ...m, name: 'edited', atoms: m.atoms.map((a) => (a.id === 1 ? { ...a, x: 0.1 } : a)) }, 'Move C');
  S().setSelection([1, 5]);
}

describe('global shortcuts and UI-owned keys', () => {
  beforeEach(() => {
    listeners = [];
    openPopover = null;
    vi.stubGlobal('window', {
      addEventListener: (_t: string, l: Listener) => listeners.push(l),
      removeEventListener: (_t: string, l: Listener) => (listeners = listeners.filter((x) => x !== l)),
    });
    vi.stubGlobal('document', { querySelector: (sel: string) => (sel.includes('.popover') ? openPopover : null) });
    uninstall = installShortcuts();
    loadEdited();
  });
  afterEach(() => {
    uninstall();
    vi.unstubAllGlobals();
  });

  it('Escape on the page still clears the selection, then switches to the select tool', () => {
    press('Escape', body);
    expect(S().selection.size).toBe(0);
    press('Escape', body);
    expect(S().tool).toBe('select');
  });

  it('Escape inside a popover menu only closes the menu (selection and tool stay)', () => {
    press('Escape', menuItem);
    expect(S().selection.size).toBe(2);
    expect(S().tool).toBe('move');
  });

  it('Escape while a popover is open (focus elsewhere) belongs to the popover', () => {
    openPopover = {};
    press('Escape', body);
    expect(S().selection.size).toBe(2);
  });

  it('keys typed inside a dialog do not run shortcuts (no undo behind the Open dialog)', () => {
    useStore.setState({ panels: { ...S().panels, load: true } });
    const before = S().molecule;
    const ev = press('z', dialogButton, { ctrl: true });
    expect(S().molecule).toBe(before);
    expect(ev.defaultPrevented).toBe(false);
    press('Escape', dialogButton);
    expect(S().selection.size).toBe(2); // the Modal closes itself; the selection is not touched
    // Ctrl+S / Ctrl+O do nothing there, but the browser's save / open dialogs stay away
    expect(press('s', dialogButton, { ctrl: true }).defaultPrevented).toBe(true);
    expect(S().panels.load).toBe(true);
  });

  it('no shortcuts while a modal is open, even if focus is outside it', () => {
    useStore.setState({ panels: { ...S().panels, help: true } });
    const before = S().molecule;
    press('z', body, { ctrl: true });
    expect(S().molecule).toBe(before);
    // '?' still toggles the help overlay closed
    press('?', dialogButton, { shift: true });
    expect(S().panels.help).toBe(false);
  });

  it('the non-modal Settings drawer only owns Escape: shortcuts work after clicking its toggles', () => {
    // SettingsPanel is a role="dialog" drawer (no aria-modal) that stays open while you work on the
    // stage; its toggles are checkboxes, which keep focus after a click.
    const settingsToggle = el('INPUT', ['[role="dialog"]'], 'checkbox');
    const before = S().molecule;
    press('z', settingsToggle, { ctrl: true });
    expect(S().molecule).not.toBe(before);
    press('Escape', settingsToggle); // the drawer's own listener closes it
    expect(S().selection.size).toBe(2);
    const closed = { panels: { help: false, load: false } };
    expect(keyBelongsToUi({ key: 'z', target: settingsToggle }, closed, { querySelector: () => null })).toBe(false);
    expect(keyBelongsToUi({ key: 'Escape', target: settingsToggle }, closed, { querySelector: () => null })).toBe(true);
    // inside a popover menu every key stays with the menu
    expect(keyBelongsToUi({ key: 'e', target: menuItem }, closed, { querySelector: () => ({}) })).toBe(true);
  });

  it('undo still works from the page', () => {
    const before = S().molecule;
    press('z', body, { ctrl: true });
    expect(S().molecule).not.toBe(before);
    expect(atomById(S().molecule!, 1)!.x).toBe(0);
  });
});

describe('keyScope helpers', () => {
  it('recognises overlays and open popovers', () => {
    expect(isInsideOverlay(menuItem)).toBe(true);
    expect(isInsideOverlay(dialogButton)).toBe(true);
    expect(isInsideOverlay(body)).toBe(false);
    expect(isInsideOverlay(null)).toBe(false);
    expect(hasOpenPopover({ querySelector: () => ({}) })).toBe(true);
    expect(hasOpenPopover({ querySelector: () => null })).toBe(false);
    expect(hasOpenPopover(undefined)).toBe(false);
    const closed = { panels: { help: false, load: false } };
    expect(keyBelongsToUi({ key: 'a', target: textField }, closed)).toBe(true);
    expect(keyBelongsToUi({ key: 'Escape', target: body }, closed, { querySelector: () => null })).toBe(false);
    expect(keyBelongsToUi({ key: 'Escape', target: body }, { panels: { help: true, load: false } })).toBe(true);
  });
});

describe('controller Escape handling', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
    const m = twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'C', nH: 3, at: [1.6, 0, 0] });
    S().loadMolecule(m);
    useStore.setState({ mode: 'edit', tool: 'add-bond', panels: { ...S().panels, help: false, load: false, settings: false } });
    h.move(0, 0);
    h.click(0, 0); // first atom of a click–click bond
    expect(S().editOverlay.highlightAtoms).toContainEqual({ atomId: 1, color: 'target' });
  });
  afterEach(() => h.ctl.dispose());

  it('Escape on the page cancels the pending bond (and stops the global handler)', () => {
    const res = h.key({ key: 'Escape', target: body });
    expect(res.stopped).toBe(true);
    h.flush();
    expect(S().editOverlay.highlightAtoms).not.toContainEqual({ atomId: 1, color: 'target' });
  });

  it('Escape in a text field belongs to the field (not swallowed, bond start kept)', () => {
    const res = h.key({ key: 'Escape', target: textField });
    expect(res).toEqual({ prevented: false, stopped: false });
    h.flush();
    expect(S().editOverlay.highlightAtoms).toContainEqual({ atomId: 1, color: 'target' });
  });

  it('Escape while the Help modal is open reaches the modal', () => {
    useStore.setState({ panels: { ...S().panels, help: true } });
    const res = h.key({ key: 'Escape', target: dialogButton });
    expect(res.stopped).toBe(false);
    const res2 = h.key({ key: 'Escape', target: body });
    expect(res2.stopped).toBe(false);
  });
});
