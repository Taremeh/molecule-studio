/**
 * Global keyboard shortcuts. OWNER: editor agent. Ignores events whose target is an input,
 * textarea, select or contenteditable, keys typed inside modal dialogs / popover menus, everything
 * while a modal (Help, Open) is open, and Escape inside the non-modal Settings drawer or while a
 * popover is open (see keyScope.ts).
 * Returns an uninstall function.
 * See ARCHITECTURE.md § Shortcuts.
 *
 * Key matching (matchShortcut) is pure and separate from execution (runShortcut).
 * Letters are matched case-insensitively on `e.key`; Ctrl and ⌘ are interchangeable ("mod").
 *
 * Letter conflicts in edit mode: H, S and F are element keys only while a tool that uses an element
 * is active (Add atom, Element); otherwise they keep their global meaning (H add hydrogens,
 * S select tool, F focus). The other element keys (C N O P, L = Cl, K = Br, I) always pick the
 * element and switch to Add atom if the current tool doesn't use one.
 */
import type { AppMode, BondOrder, ToolId } from '../core/types';
import { isMacromolecule } from '../core/molecule';
import { useStore } from '../state/store';
import { getViewer } from '../render/viewerApi';
import { cmdAddHydrogens, cmdCleanGeometry, cmdDeleteSelection, cmdRemoveHydrogens, exportMolecule, focusSelection } from '../app/actions';
import { planDeleteAtoms } from './feedback';
import { applyDelete } from './ops';
import { autoHydrogens } from './tools/common';
import { isEditableTarget, keyBelongsToUi } from './keyScope';

export { isEditableTarget };

export type ShortcutAction =
  | 'undo'
  | 'redo'
  | 'toggle-mode'
  | 'escape'
  | 'delete-selection'
  | 'select-all'
  | 'focus'
  | 'reset-view'
  | 'help'
  | 'open'
  | 'export'
  | 'tool'
  | 'bond-order'
  | 'element'
  | 'add-hydrogens'
  | 'remove-hydrogens'
  | 'clean-geometry';

export interface ShortcutMatch {
  action: ShortcutAction;
  tool?: ToolId;
  order?: BondOrder;
  element?: string;
}

/** The subset of KeyboardEvent the matcher needs. */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface ShortcutContext {
  mode: AppMode;
  tool: ToolId;
  /** A modal dialog (load / help) is open: single-letter keys are ignored. */
  modalOpen: boolean;
}

/** Tools that use store.editElement. */
export const ELEMENT_TOOLS: readonly ToolId[] = ['add-atom', 'element'];

/** Element keys that never conflict with other shortcuts. */
const ELEMENT_KEYS: Record<string, string> = { c: 'C', n: 'N', o: 'O', p: 'P', l: 'Cl', k: 'Br', i: 'I' };
/** Element keys that only act as elements while an element tool is active. */
const CONTEXT_ELEMENT_KEYS: Record<string, string> = { h: 'H', s: 'S', f: 'F' };

const EDIT_TOOL_KEYS: Record<string, ToolId> = { v: 'move', a: 'add-atom', b: 'add-bond', d: 'delete', g: 'fragment' };

/** Match a key event to a shortcut (or null). Pure. */
export function matchShortcut(e: KeyLike, ctx: ShortcutContext): ShortcutMatch | null {
  const key = e.key;
  if (!key) return null;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const mod = !!(e.ctrlKey || e.metaKey);
  const shift = !!e.shiftKey;
  const alt = !!e.altKey;
  const edit = ctx.mode === 'edit';

  if (key === 'Escape') return { action: 'escape' };

  if (mod) {
    if (alt) return null;
    switch (lower) {
      case 'z':
        return { action: shift ? 'redo' : 'undo' };
      case 'y':
        return shift ? null : { action: 'redo' };
      case 'o':
        return shift ? null : { action: 'open' };
      case 's':
        return shift ? null : { action: 'export' };
      case 'a':
        return shift || ctx.modalOpen ? null : { action: 'select-all' };
      case 'c':
        return shift && edit && !ctx.modalOpen ? { action: 'clean-geometry' } : null;
      default:
        return null;
    }
  }

  // '?' also closes the help overlay it opened, so it is allowed while a modal is open.
  if (key === '?' && !alt) return { action: 'help' };
  if (ctx.modalOpen || alt) return null;

  if (key === 'Delete' || key === 'Backspace') return shift ? null : { action: 'delete-selection' };
  if (key.length !== 1) return null;

  if (shift) {
    // Shift+H is the only shifted letter shortcut.
    return lower === 'h' && edit ? { action: 'remove-hydrogens' } : null;
  }

  const elementTool = edit && ELEMENT_TOOLS.includes(ctx.tool);
  if (elementTool && lower in CONTEXT_ELEMENT_KEYS) return { action: 'element', element: CONTEXT_ELEMENT_KEYS[lower] };

  switch (lower) {
    case 'e':
      return { action: 'toggle-mode' };
    case 'f':
      return { action: 'focus' };
    case 'r':
      return { action: 'reset-view' };
    case 'm':
      return { action: 'tool', tool: 'measure' };
    case 's':
      return { action: 'tool', tool: 'select' };
  }

  if (!edit) return null;
  if (lower in EDIT_TOOL_KEYS) return { action: 'tool', tool: EDIT_TOOL_KEYS[lower] };
  if (lower === '1' || lower === '2' || lower === '3') return { action: 'bond-order', order: Number(lower) as BondOrder };
  if (lower === 'h') return { action: 'add-hydrogens' };
  if (lower in ELEMENT_KEYS) return { action: 'element', element: ELEMENT_KEYS[lower] };
  return null;
}

/**
 * Delete the selected atoms like the Delete tool does: hydrogens of deleted heavy atoms go too and,
 * in auto-hydrogen mode, the remaining neighbours get their hydrogens back. Falls back to
 * app/actions cmdDeleteSelection if the editor's plan cannot be applied.
 */
export function deleteSelection(): void {
  const s = useStore.getState();
  const mol = s.molecule;
  if (!mol || !s.selection.size || s.mode !== 'edit') return;
  const res = applyDelete(mol, planDeleteAtoms(mol, s.selection), autoHydrogens(s, mol));
  if (!res.ok) {
    cmdDeleteSelection();
    return;
  }
  s.commit(res.mol, res.label);
  useStore.getState().clearSelection();
}

/** Actions that may auto-repeat while the key is held. */
const REPEATABLE = new Set<ShortcutAction>(['undo', 'redo']);

/**
 * Execute a matched shortcut. Returns true if it did something (the caller then prevents the
 * browser's default action, e.g. Ctrl+S "save page").
 */
export function runShortcut(m: ShortcutMatch): boolean {
  const s = useStore.getState();
  switch (m.action) {
    case 'undo':
      if (!s.past.length && !s.transientBase) return true;
      s.undo();
      return true;
    case 'redo':
      s.redo();
      return true;
    case 'toggle-mode': {
      if (!s.molecule) return false;
      const next = s.mode === 'edit' ? 'view' : 'edit';
      s.setMode(next);
      s.toast(next === 'edit' ? 'Edit mode — press E to return to viewing' : 'View mode', 'info', 1400);
      return true;
    }
    case 'escape':
      if (s.panels.help || s.panels.load || s.panels.settings) {
        if (s.panels.help) s.setPanel('help', false);
        if (s.panels.load) s.setPanel('load', false);
        if (s.panels.settings) s.setPanel('settings', false);
        return true;
      }
      if (s.pendingMeasure.length) {
        s.setPendingMeasure([]);
        return true;
      }
      if (s.selection.size) {
        s.clearSelection();
        return true;
      }
      if (s.mode === 'edit' && s.tool !== 'select') {
        s.setTool('select');
        return true;
      }
      return false;
    case 'delete-selection':
      if (!s.selection.size) return false;
      if (s.mode !== 'edit') {
        s.toast('Switch to Edit mode (E) to delete atoms', 'info', 2200);
        return true;
      }
      deleteSelection();
      return true;
    case 'select-all':
      if (!s.molecule) return false;
      s.setSelection(s.molecule.atoms.map((a) => a.id));
      return true;
    case 'focus':
      if (!s.molecule) return false;
      focusSelection();
      return true;
    case 'reset-view':
      if (!s.molecule) return false;
      getViewer()?.resetView();
      return true;
    case 'help':
      s.togglePanel('help');
      return true;
    case 'open':
      s.setPanel('load', true);
      return true;
    case 'export': {
      const mol = s.molecule;
      if (!mol || !mol.atoms.length) {
        s.toast('Nothing to export', 'warning');
        return true;
      }
      // SDF (V2000) suits small molecules; proteins / large systems go to PDB.
      exportMolecule(isMacromolecule(mol) || mol.atoms.length > 999 ? 'pdb' : 'sdf');
      return true;
    }
    case 'tool':
      if (!m.tool) return false;
      if (s.mode === 'view' && m.tool !== 'select' && m.tool !== 'measure') return false;
      s.setTool(m.tool);
      return true;
    case 'bond-order':
      if (!m.order) return false;
      s.setEditBondOrder(m.order);
      if (s.tool !== 'add-bond' && s.tool !== 'add-atom') s.setTool('add-bond');
      return true;
    case 'element':
      if (!m.element) return false;
      s.setEditElement(m.element);
      if (!ELEMENT_TOOLS.includes(s.tool)) s.setTool('add-atom');
      return true;
    case 'add-hydrogens':
      cmdAddHydrogens();
      return true;
    case 'remove-hydrogens':
      cmdRemoveHydrogens();
      return true;
    case 'clean-geometry':
      void cmdCleanGeometry();
      return true;
  }
}

export function installShortcuts(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || isEditableTarget(e.target)) return;
    const s = useStore.getState();
    const m = matchShortcut(e, { mode: s.mode, tool: s.tool, modalOpen: s.panels.load || s.panels.help });
    if (!m) return;
    // Keys inside a modal dialog / popover menu, or while a modal is open, belong to that UI (its own
    // listener closes it on Escape); only '?' may still close the help overlay it opened.
    if (keyBelongsToUi(e, s) && !(m.action === 'help' && s.panels.help)) {
      // Still keep the browser's own Ctrl/⌘+S (save page) / Ctrl/⌘+O (open file) dialogs away.
      if (m.action === 'export' || m.action === 'open') e.preventDefault();
      return;
    }
    if (e.repeat && !REPEATABLE.has(m.action)) {
      e.preventDefault();
      return;
    }
    if (runShortcut(m)) e.preventDefault();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/** Modifier token understood by the help overlay's key formatter (rendered as ⌘ on macOS, Ctrl elsewhere). */
const MOD = 'Ctrl/Cmd';

/** For the help overlay: list of shortcuts. */
export const SHORTCUTS: { keys: string; description: string; mode?: 'view' | 'edit' }[] = [
  { keys: `${MOD}+Z`, description: 'Undo' },
  { keys: `${MOD}+Shift+Z / Ctrl+Y`, description: 'Redo' },
  { keys: 'E', description: 'Switch between View and Edit mode' },
  { keys: 'Esc', description: 'Cancel the current action · clear pending measurement · clear selection' },
  { keys: `${MOD}+A`, description: 'Select all atoms' },
  { keys: 'F', description: 'Focus the selection (or the whole molecule)' },
  { keys: 'R', description: 'Reset the view' },
  { keys: 'S', description: 'Select tool' },
  { keys: 'M', description: 'Measure tool' },
  { keys: '?', description: 'Show / hide this help' },
  { keys: `${MOD}+O`, description: 'Open a molecule' },
  { keys: `${MOD}+S`, description: 'Export (SDF for small molecules, PDB for proteins)' },
  { keys: 'Delete / Backspace', description: 'Delete the selected atoms', mode: 'edit' },
  { keys: 'V', description: 'Move tool', mode: 'edit' },
  { keys: 'A', description: 'Add-atom tool', mode: 'edit' },
  { keys: 'B', description: 'Add-bond tool', mode: 'edit' },
  { keys: 'D', description: 'Delete tool', mode: 'edit' },
  { keys: 'G', description: 'Fragment tool', mode: 'edit' },
  { keys: '1 · 2 · 3', description: 'Single / double / triple bond order', mode: 'edit' },
  { keys: 'C N O P', description: 'Element C, N, O, P (switches to Add atom)', mode: 'edit' },
  { keys: 'L · K · I', description: 'Element Cl, Br, I', mode: 'edit' },
  { keys: 'H S F', description: 'Element H, S, F while the Add-atom or Element tool is active', mode: 'edit' },
  { keys: 'H', description: 'Add hydrogens (to the selection, or everywhere)', mode: 'edit' },
  { keys: 'Shift+H', description: 'Remove hydrogens', mode: 'edit' },
  { keys: `${MOD}+Shift+C`, description: 'Clean up geometry', mode: 'edit' },
];

/** Mouse gestures, for the help overlay (optional). */
export const MOUSE_CONTROLS: { gesture: string; description: string; mode?: 'view' | 'edit' }[] = [
  { gesture: 'Drag', description: 'Rotate' },
  { gesture: 'Right-drag', description: 'Pan' },
  { gesture: 'Scroll', description: 'Zoom' },
  { gesture: 'Click', description: 'Select an atom (Shift or Ctrl/⌘: add or remove)' },
  { gesture: 'Double-click', description: 'Select and focus the residue or fragment' },
  { gesture: 'Shift-drag on empty space', description: 'Box-select (add Ctrl/⌘ to extend the selection, Alt to remove)' },
  { gesture: 'Drag an atom (Move tool)', description: 'Move it · Alt-drag moves the whole fragment', mode: 'edit' },
  { gesture: 'Drag from an atom (Add atom / Add bond)', description: 'Draw a new bond', mode: 'edit' },
];
