/**
 * Number / text formatting helpers for the shell UI. Pure functions.
 */

/** 1234567 → "1,234,567" (locale-independent so tests and UI agree). */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Approximate count for gallery cards: 3 → "3", 1234 → "~1.2k", 12345 → "~12k", 2.5e6 → "~2.5M". */
export function formatApprox(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) {
    const k = n / 1000;
    return `~${k < 10 ? trimZero(k.toFixed(1)) : Math.round(k)}k`;
  }
  const m = n / 1e6;
  return `~${m < 10 ? trimZero(m.toFixed(1)) : Math.round(m)}M`;
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** "1 atom", "2 atoms", "1,024 atoms". */
export function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${formatCount(n)} ${n === 1 ? word : pluralWord}`;
}

/** Molecular mass: "194.19 g/mol"; large values get thousands separators ("64,458.3 g/mol"). */
export function formatMass(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '—';
  if (m < 1000) return `${m.toFixed(2)} g/mol`;
  return `${m.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} g/mol`;
}

/** kDa string for macromolecules (≥ 5 kDa), otherwise null. */
export function formatKDa(m: number): string | null {
  if (!Number.isFinite(m) || m < 5000) return null;
  return `${(m / 1000).toFixed(1)} kDa`;
}

/** Formal charge with explicit sign and a typographic minus: 0 → "0", 1 → "+1", -2 → "−2". */
export function formatCharge(c: number): string {
  if (!c) return '0';
  return c > 0 ? `+${c}` : `−${Math.abs(c)}`;
}

/** Compact charge suffix for element badges: 1 → "+", 2 → "2+", -1 → "−". */
export function chargeSuffix(c: number | undefined): string {
  if (!c) return '';
  const mag = Math.abs(c);
  return `${mag === 1 ? '' : mag}${c > 0 ? '+' : '−'}`;
}

/** Coordinate in Å with 3 decimals; "−" sign for negatives. */
export function formatCoord(x: number): string {
  if (!Number.isFinite(x)) return '—';
  const s = x.toFixed(3);
  return s.startsWith('-') ? (s === '-0.000' ? '0.000' : '−' + s.slice(1)) : s;
}

/** Split a Hill formula into text runs with subscript flags: "C8H10N4O2" → C,8,H,10,N,4,O,2. */
export function formulaParts(formula: string): { text: string; sub: boolean }[] {
  const out: { text: string; sub: boolean }[] = [];
  const re = /(\d+)|([^\d]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula))) {
    if (m[1]) out.push({ text: m[1], sub: true });
    else out.push({ text: m[2], sub: false });
  }
  return out;
}

/**
 * Text color (dark or light) readable on a given '#rrggbb' background, using WCAG relative
 * luminance. Falls back to dark text for invalid input.
 */
export function readableTextColor(hex: string): '#0b0f17' | '#ffffff' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#0b0f17';
  const n = parseInt(m[1], 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Contrast vs white = 1.05 / (L + 0.05); vs our near-black (#0b0f17, L ≈ 0.0048) = (L + 0.05) / 0.0548.
  return 1.05 / (L + 0.05) > (L + 0.05) / 0.0548 ? '#ffffff' : '#0b0f17';
}

/** Truncate long text with an ellipsis. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

/** Bond order symbol and name. */
export function bondOrderLabel(order: number): { symbol: string; name: string } {
  switch (order) {
    case 1.5:
      return { symbol: ':', name: 'aromatic' };
    case 2:
      return { symbol: '=', name: 'double' };
    case 3:
      return { symbol: '≡', name: 'triple' };
    default:
      return { symbol: '–', name: 'single' };
  }
}
