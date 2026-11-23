/**
 * Which keyboard events belong to the UI rather than to the editor's shortcuts. Shared by the global
 * shortcut handler (shortcuts.ts) and the controller's capture-phase Escape handling (controller.ts),
 * so a key typed into a text field, a dialog or a popover menu never also edits the molecule, clears
 * the selection or switches the tool. Pure (DOM access only through the event target / document).
 */

/** True for targets where typing must not trigger shortcuts (text fields, selects, contenteditable). */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string; closest?: (sel: string) => unknown };
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    // Buttons, checkboxes, sliders… don't take text: shortcuts keep working after clicking them.
    const type = (el.type ?? 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file', 'image'].includes(type);
  }
  return typeof el.closest === 'function' && !!el.closest('[contenteditable=""], [contenteditable="true"]');
}

/** Dialogs (modal or not), popovers and menus handle their own keys (Escape closes them, arrows navigate). */
export const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], .modal, .popover';

/**
 * Overlays that own every key typed inside them: modal dialogs, popovers and menus. A non-modal
 * dialog (the Settings drawer, which stays open while you work on the stage) only owns Escape, so
 * shortcuts keep working after clicking one of its toggles (see isEditableTarget).
 */
export const KEY_OWNING_OVERLAY_SELECTOR = '[role="alertdialog"], [aria-modal="true"], [role="menu"], .modal, .popover';

function closestMatches(target: unknown, selector: string): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { closest?: (sel: string) => unknown };
  return typeof el.closest === 'function' && !!el.closest(selector);
}

/** True if the event target lies inside a dialog, popover or menu. */
export function isInsideOverlay(target: unknown): boolean {
  return closestMatches(target, OVERLAY_SELECTOR);
}

/** True if a popover / menu is open somewhere (its own window listener closes it on Escape). */
export function hasOpenPopover(doc: unknown = typeof document !== 'undefined' ? document : undefined): boolean {
  const d = doc as { querySelector?: (sel: string) => unknown } | undefined;
  return typeof d?.querySelector === 'function' && !!d.querySelector('.popover');
}

export interface KeyScopeState {
  panels: { help: boolean; load: boolean };
}

/**
 * True if the key belongs to the UI and must not run editor shortcuts / editor Escape handling:
 * it was typed into a text field or inside a modal dialog / popover / menu, a modal (Help, Open) is
 * open, or it is an Escape typed inside any dialog (also the non-modal Settings drawer) or while a
 * popover is open (their own listeners close them).
 */
export function keyBelongsToUi(e: { key?: string; target?: unknown }, s: KeyScopeState, doc?: unknown): boolean {
  if (isEditableTarget(e.target)) return true;
  if (s.panels.help || s.panels.load) return true;
  if (e.key === 'Escape') return isInsideOverlay(e.target) || hasOpenPopover(doc);
  return closestMatches(e.target, KEY_OWNING_OVERLAY_SELECTOR);
}
