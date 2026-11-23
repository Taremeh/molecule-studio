import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/elements', () => import('./testing/fakeElements'));
vi.mock('../core/chemistry', () => import('./testing/fakeChemistry'));
vi.mock('../core/edit', () => import('./testing/fakeEdit'));
vi.mock('../core/geometry', async () => ({
  ...(await vi.importActual<object>('../core/geometry')),
  ...(await import('./testing/fakeGeometry')),
}));
vi.mock('../app/actions', () => ({
  cmdAddHydrogens: vi.fn(),
  cmdRemoveHydrogens: vi.fn(),
  cmdCleanGeometry: vi.fn(async () => {}),
  cmdDeleteSelection: vi.fn(),
  exportMolecule: vi.fn(),
  focusSelection: vi.fn(),
}));

import * as actions from '../app/actions';
import type { ToolId } from '../core/types';
import { useStore } from '../state/store';
import { setViewer, type ViewerApi } from '../render/viewerApi';
import { SHORTCUTS, installShortcuts, isEditableTarget, matchShortcut, runShortcut, type ShortcutContext } from './shortcuts';
import { methane } from './testing/molecules';

const view: ShortcutContext = { mode: 'view', tool: 'select', modalOpen: false };
const edit = (tool: ToolId = 'select'): ShortcutContext => ({ mode: 'edit', tool, modalOpen: false });
const k = (key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('matchShortcut', () => {
  it('handles undo / redo with Ctrl or ⌘, case-insensitively', () => {
    expect(matchShortcut(k('z', { ctrl: true }), view)).toEqual({ action: 'undo' });
    expect(matchShortcut(k('z', { meta: true }), view)).toEqual({ action: 'undo' });
    expect(matchShortcut(k('Z', { meta: true, shift: true }), view)).toEqual({ action: 'redo' });
    expect(matchShortcut(k('y', { ctrl: true }), view)).toEqual({ action: 'redo' });
    expect(matchShortcut(k('Z', { ctrl: true, alt: true }), view)).toBeNull();
  });

  it('maps global single keys', () => {
    expect(matchShortcut(k('e'), view)).toEqual({ action: 'toggle-mode' });
    expect(matchShortcut(k('E'), view)).toEqual({ action: 'toggle-mode' }); // caps lock
    expect(matchShortcut(k('f'), view)).toEqual({ action: 'focus' });
    expect(matchShortcut(k('r'), view)).toEqual({ action: 'reset-view' });
    expect(matchShortcut(k('m'), view)).toEqual({ action: 'tool', tool: 'measure' });
    expect(matchShortcut(k('s'), view)).toEqual({ action: 'tool', tool: 'select' });
    expect(matchShortcut(k('?', { shift: true }), view)).toEqual({ action: 'help' });
    expect(matchShortcut(k('Escape'), view)).toEqual({ action: 'escape' });
    expect(matchShortcut(k('Delete'), view)).toEqual({ action: 'delete-selection' });
    expect(matchShortcut(k('Backspace'), edit())).toEqual({ action: 'delete-selection' });
  });

  it('maps mod combos', () => {
    expect(matchShortcut(k('a', { ctrl: true }), view)).toEqual({ action: 'select-all' });
    expect(matchShortcut(k('o', { meta: true }), view)).toEqual({ action: 'open' });
    expect(matchShortcut(k('s', { ctrl: true }), view)).toEqual({ action: 'export' });
    expect(matchShortcut(k('C', { ctrl: true, shift: true }), edit())).toEqual({ action: 'clean-geometry' });
    expect(matchShortcut(k('C', { ctrl: true, shift: true }), view)).toBeNull();
    // Ctrl+C (copy) is not carbon
    expect(matchShortcut(k('c', { ctrl: true }), edit('add-atom'))).toBeNull();
  });

  it('keeps edit-only keys out of view mode', () => {
    for (const key of ['v', 'a', 'b', 'd', 'g', '1', '2', '3', 'c', 'n', 'o', 'h', 'l', 'k', 'i', 'p']) {
      expect(matchShortcut(k(key), view)).toBeNull();
    }
    expect(matchShortcut(k('H', { shift: true }), view)).toBeNull();
  });

  it('maps edit tools, bond orders and hydrogens', () => {
    expect(matchShortcut(k('v'), edit())).toEqual({ action: 'tool', tool: 'move' });
    expect(matchShortcut(k('a'), edit())).toEqual({ action: 'tool', tool: 'add-atom' });
    expect(matchShortcut(k('b'), edit())).toEqual({ action: 'tool', tool: 'add-bond' });
    expect(matchShortcut(k('d'), edit())).toEqual({ action: 'tool', tool: 'delete' });
    expect(matchShortcut(k('g'), edit())).toEqual({ action: 'tool', tool: 'fragment' });
    expect(matchShortcut(k('2'), edit())).toEqual({ action: 'bond-order', order: 2 });
    expect(matchShortcut(k('h'), edit('move'))).toEqual({ action: 'add-hydrogens' });
    expect(matchShortcut(k('H', { shift: true }), edit('move'))).toEqual({ action: 'remove-hydrogens' });
    expect(matchShortcut(k('H', { shift: true }), edit('add-atom'))).toEqual({ action: 'remove-hydrogens' });
    expect(matchShortcut(k('X', { shift: true }), edit())).toBeNull();
  });

  it('maps element keys, with H / S / F contextual to element tools', () => {
    expect(matchShortcut(k('n'), edit('move'))).toEqual({ action: 'element', element: 'N' });
    expect(matchShortcut(k('l'), edit())).toEqual({ action: 'element', element: 'Cl' });
    expect(matchShortcut(k('k'), edit())).toEqual({ action: 'element', element: 'Br' });
    expect(matchShortcut(k('i'), edit())).toEqual({ action: 'element', element: 'I' });
    expect(matchShortcut(k('P'), edit())).toEqual({ action: 'element', element: 'P' });
    expect(matchShortcut(k('s'), edit('add-atom'))).toEqual({ action: 'element', element: 'S' });
    expect(matchShortcut(k('f'), edit('element'))).toEqual({ action: 'element', element: 'F' });
    expect(matchShortcut(k('h'), edit('add-atom'))).toEqual({ action: 'element', element: 'H' });
    expect(matchShortcut(k('s'), edit('move'))).toEqual({ action: 'tool', tool: 'select' });
    expect(matchShortcut(k('f'), edit('delete'))).toEqual({ action: 'focus' });
  });

  it('ignores single keys while a modal is open, and alt-modified letters', () => {
    const modal: ShortcutContext = { ...edit(), modalOpen: true };
    expect(matchShortcut(k('e'), modal)).toBeNull();
    expect(matchShortcut(k('Delete'), modal)).toBeNull();
    expect(matchShortcut(k('a', { ctrl: true }), modal)).toBeNull();
    expect(matchShortcut(k('Escape'), modal)).toEqual({ action: 'escape' });
    expect(matchShortcut(k('z', { ctrl: true }), modal)).toEqual({ action: 'undo' });
    expect(matchShortcut(k('?', { shift: true }), modal)).toEqual({ action: 'help' });
    expect(matchShortcut(k('ç', { alt: true }), edit())).toBeNull();
    expect(matchShortcut(k('c', { alt: true }), edit())).toBeNull();
    expect(matchShortcut(k('ArrowLeft'), edit())).toBeNull();
  });
});

describe('isEditableTarget', () => {
  it('recognises text fields but not buttons or checkboxes', () => {
    expect(isEditableTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isEditableTarget({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('runShortcut', () => {
  beforeEach(() => {
    useStore.getState().loadMolecule(methane());
    useStore.setState({ mode: 'edit', tool: 'select', panels: { ...useStore.getState().panels, help: false, load: false, settings: false } });
    vi.clearAllMocks();
  });

  it('picks an element and switches to add-atom only when needed', () => {
    runShortcut({ action: 'element', element: 'N' });
    expect(useStore.getState().editElement).toBe('N');
    expect(useStore.getState().tool).toBe('add-atom');
    useStore.getState().setTool('element');
    runShortcut({ action: 'element', element: 'O' });
    expect(useStore.getState().tool).toBe('element');
  });

  it('escape: closes overlays, then pending measure, then selection, then the tool', () => {
    const s = useStore.getState();
    s.setPanel('help', true);
    s.setTool('measure');
    s.setPendingMeasure([1]);
    s.setSelection([1, 2]);
    expect(runShortcut({ action: 'escape' })).toBe(true);
    expect(useStore.getState().panels.help).toBe(false);
    expect(useStore.getState().pendingMeasure).toEqual([1]);
    runShortcut({ action: 'escape' });
    expect(useStore.getState().pendingMeasure).toEqual([]);
    expect(useStore.getState().selection.size).toBe(2);
    runShortcut({ action: 'escape' });
    expect(useStore.getState().selection.size).toBe(0);
    runShortcut({ action: 'escape' });
    expect(useStore.getState().tool).toBe('select');
    expect(runShortcut({ action: 'escape' })).toBe(false);
  });

  it('toggles the mode and selects all', () => {
    runShortcut({ action: 'toggle-mode' });
    expect(useStore.getState().mode).toBe('view');
    runShortcut({ action: 'select-all' });
    expect([...useStore.getState().selection]).toEqual([1, 2, 3, 4, 5]);
  });

  it('delegates edit commands and exports small molecules as SDF', () => {
    runShortcut({ action: 'add-hydrogens' });
    expect(actions.cmdAddHydrogens).toHaveBeenCalledTimes(1);
    runShortcut({ action: 'export' });
    expect(actions.exportMolecule).toHaveBeenCalledWith('sdf');
  });

  it('deletes selected heavy atoms together with their hydrogens', () => {
    useStore.getState().setSelection([1]);
    runShortcut({ action: 'delete-selection' });
    const s = useStore.getState();
    expect(s.molecule!.atoms).toHaveLength(0); // the C and its 4 H
    expect(s.past.at(-1)?.label).toBe('Delete C');
    expect(s.selection.size).toBe(0);
  });

  it('does not delete in view mode but explains why', () => {
    useStore.getState().setMode('view');
    useStore.getState().setSelection([2]);
    expect(runShortcut({ action: 'delete-selection' })).toBe(true);
    expect(actions.cmdDeleteSelection).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.at(-1)?.message).toMatch(/Edit mode/);
  });

  it('refuses edit tools in view mode and resets the view through the viewer', () => {
    useStore.getState().setMode('view');
    expect(runShortcut({ action: 'tool', tool: 'move' })).toBe(false);
    expect(useStore.getState().tool).toBe('select');
    const resetView = vi.fn();
    setViewer({ resetView } as unknown as ViewerApi);
    runShortcut({ action: 'reset-view' });
    expect(resetView).toHaveBeenCalled();
    setViewer(null);
  });
});

describe('installShortcuts / SHORTCUTS', () => {
  it('is a no-op outside the browser', () => {
    const uninstall = installShortcuts();
    expect(typeof uninstall).toBe('function');
    uninstall();
  });

  it('documents every shortcut once', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(15);
    const keys = SHORTCUTS.map((s) => `${s.keys}|${s.mode ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SHORTCUTS) expect(s.description.length).toBeGreaterThan(3);
  });
});
