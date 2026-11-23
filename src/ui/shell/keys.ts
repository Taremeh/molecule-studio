/**
 * Keyboard shortcut display helpers (platform-aware). Pure functions except isMacPlatform().
 */

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X/.test(nav.userAgent ?? '');
}

const MOD_NAMES = /^(ctrl\/cmd|cmd\/ctrl|cmdorctrl|ctrlorcmd|mod|primary)$/i;

function keyLabel(key: string, mac: boolean): string {
  const k = key.trim();
  if (MOD_NAMES.test(k)) return mac ? '⌘' : 'Ctrl';
  const lower = k.toLowerCase();
  if (lower === 'cmd' || lower === 'meta' || lower === 'command' || k === '⌘') return mac ? '⌘' : 'Ctrl';
  if (lower === 'ctrl' || lower === 'control' || k === '⌃') return mac ? '⌃' : 'Ctrl';
  if (lower === 'shift' || k === '⇧') return mac ? '⇧' : 'Shift';
  if (lower === 'alt' || lower === 'option' || lower === 'opt' || k === '⌥') return mac ? '⌥' : 'Alt';
  if (lower === 'escape' || lower === 'esc') return 'Esc';
  if (lower === 'enter' || lower === 'return') return mac ? '↩' : 'Enter';
  if (lower === 'backspace') return mac ? '⌫' : 'Backspace';
  if (lower === 'delete' || lower === 'del') return mac ? '⌦' : 'Delete';
  if (lower === 'space') return 'Space';
  if (lower === 'arrowup' || lower === 'up') return '↑';
  if (lower === 'arrowdown' || lower === 'down') return '↓';
  if (lower === 'arrowleft' || lower === 'left') return '←';
  if (lower === 'arrowright' || lower === 'right') return '→';
  return k.length === 1 ? k.toUpperCase() : k;
}

const MODIFIER_RE = /^(ctrl\/cmd|cmd\/ctrl|cmdorctrl|ctrlorcmd|mod|primary|ctrl|control|cmd|command|meta|shift|alt|option|opt|⌘|⇧|⌥|⌃)$/i;

/** Split one combo ("Ctrl+Shift+Z", "⌘ Shift Z") into raw key names. */
function splitCombo(combo: string): string[] {
  if (combo === '+') return ['+'];
  if (combo.includes('+')) {
    const parts: string[] = [];
    let cur = '';
    for (const ch of combo) {
      if (ch === '+' && cur.trim() !== '') {
        parts.push(cur.trim());
        cur = '';
      } else if (ch === '+') {
        parts.push('+'); // '+' right after a separator is the plus key itself
      } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }
  return combo.split(/\s+/).filter(Boolean);
}

/**
 * Split a shortcut description into alternatives, each a list of key caps:
 * "Ctrl/Cmd+Shift+Z / Ctrl+Y" → [["Ctrl","Shift","Z"],["Ctrl","Y"]] (non-Mac).
 * Accepted forms: keys joined by "+" or by spaces ("⌘ Shift Z"); alternatives separated by
 * " / ", " · ", " or " or ", ". A space-separated list without modifiers ("C N O P") is a set of
 * alternative single keys.
 */
export function splitShortcut(keys: string, mac = false): string[][] {
  const out: string[][] = [];
  const alternatives = keys
    .split(/\s+\/\s+|\s*·\s*|\s+or\s+|,\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const alt of alternatives) {
    const parts = splitCombo(alt);
    const hasModifier = parts.some((p) => MODIFIER_RE.test(p));
    if (!hasModifier && parts.length > 1 && !alt.includes('+')) {
      for (const p of parts) out.push([keyLabel(p, mac)]);
    } else out.push(parts.map((p) => keyLabel(p, mac)));
  }
  return out;
}

/** Single-string rendering for tooltips, e.g. "⌘⇧Z" on Mac, "Ctrl+Shift+Z" elsewhere. */
export function formatShortcut(keys: string, mac = false): string {
  return splitShortcut(keys, mac)
    .map((caps) => (mac ? caps.join('') : caps.join('+')))
    .join(' / ');
}
