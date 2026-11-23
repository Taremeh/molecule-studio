/**
 * Default status-bar hints per mode / tool, measurement progress text, and platform-aware
 * shortcut labels for tooltips.
 * OWNER: edit-ui.
 */
import type { AppMode, MeasureKind, ToolId } from '../../core/types';

export const MEASURE_ATOM_COUNT: Record<MeasureKind, number> = { distance: 2, angle: 3, dihedral: 4 };

const MEASURE_NOUN: Record<MeasureKind, string> = { distance: 'a distance', angle: 'an angle', dihedral: 'a dihedral' };

/** "Pick atom 2 of 3 for an angle" (pendingCount = atoms picked so far). */
export function measureProgressHint(kind: MeasureKind, pendingCount: number): string {
  const need = MEASURE_ATOM_COUNT[kind];
  const next = Math.min(Math.max(pendingCount, 0) + 1, need);
  return `Pick atom ${next} of ${need} for ${MEASURE_NOUN[kind]}`;
}

export interface HintContext {
  mode: AppMode;
  tool: ToolId;
  editElement: string;
  /** Display name of the current fragment template, if known. */
  fragmentName?: string;
  measureKind: MeasureKind;
  pendingCount: number;
}

/** Hint shown when the editor controller has not set a more specific one. */
export function defaultHint(ctx: HintContext): string {
  if (ctx.tool === 'measure') {
    const base = measureProgressHint(ctx.measureKind, ctx.pendingCount);
    return ctx.pendingCount > 0 ? `${base} · Esc to cancel` : `${base} · click atoms in the view`;
  }
  if (ctx.mode === 'view') {
    return 'Drag to rotate · right-drag to pan · scroll to zoom · click an atom to select';
  }
  switch (ctx.tool) {
    case 'select':
      return 'Click to select · shift-click to add · shift-drag to box-select · double-click selects a residue or fragment';
    case 'move':
      return 'Drag an atom to move it (or the selection) · alt-drag moves its whole fragment';
    case 'add-atom':
      return `Click empty space to place ${ctx.editElement} · click an atom to grow from it · drag from an atom to draw a bond`;
    case 'add-bond':
      return 'Drag from one atom to another to bond them · click a bond to cycle its order';
    case 'delete':
      return 'Click an atom or bond to delete it · shift-drag to delete a region';
    case 'element':
      return `Click an atom to turn it into ${ctx.editElement}`;
    case 'charge':
      return 'Click an atom to add +1 charge · shift-click for −1';
    case 'fragment':
      return `Click an atom to attach ${ctx.fragmentName ?? 'the fragment'} · click empty space to place it`;
    default:
      return '';
  }
}

/** True on Apple platforms (shortcuts use ⌘ instead of Ctrl). Safe outside the browser. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(p) || /Mac OS X/.test(navigator.userAgent ?? '');
}

/** Rewrites 'Mod+Shift+C' into '⌘⇧C' (mac) or 'Ctrl+Shift+C'. */
export function formatShortcut(keys: string, mac = isMacPlatform()): string {
  if (!mac) return keys.replace(/Mod/g, 'Ctrl');
  return keys
    .split('+')
    .map((k) => (k === 'Mod' ? '⌘' : k === 'Shift' ? '⇧' : k === 'Alt' ? '⌥' : k === 'Ctrl' ? '⌃' : k))
    .join('');
}

/** Keyboard shortcuts of the editing tools (see ARCHITECTURE.md § Shortcuts). */
export const TOOL_SHORTCUTS: Partial<Record<ToolId, string>> = {
  select: 'S',
  move: 'V',
  'add-atom': 'A',
  'add-bond': 'B',
  delete: 'D',
  fragment: 'G',
  measure: 'M',
};

/** Element hot keys of the editor (element symbol → key). */
export const ELEMENT_HOTKEYS: Record<string, string> = {
  C: 'C',
  N: 'N',
  O: 'O',
  H: 'H',
  S: 'S',
  P: 'P',
  F: 'F',
  Cl: 'L',
  Br: 'K',
  I: 'I',
};
