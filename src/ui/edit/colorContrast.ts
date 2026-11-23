/**
 * Small color helpers for the editing UI: WCAG relative luminance / contrast ratio, picking a
 * readable text color for a colored tile (e.g. an element symbol on its CPK color), and nudging a
 * foreground color until it is legible on a given background.
 * OWNER: edit-ui.
 */

/** Parse '#rgb' or '#rrggbb' into sRGB components 0..1. Invalid input → mid grey. */
export function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-f]{6}$/i.test(h)) return [0.5, 0.5, 0.5];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function toHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** sRGB channel (0..1) → linear light, per the WCAG 2.x definition. */
function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two colors, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of `dark` / `light` has the higher contrast against `bg`. */
export function readableTextColor(bg: string, dark = '#0b0f17', light = '#ffffff'): string {
  return contrastRatio(bg, dark) >= contrastRatio(bg, light) ? dark : light;
}

/** Linear interpolation between two hex colors in sRGB space. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

/**
 * Return `fg` unchanged if it reaches `minRatio` against `bg`; otherwise mix it towards white (on
 * dark backgrounds) or black (on light ones) in small steps until it does. Keeps the hue recognisable
 * (e.g. sulfur yellow becomes a dark mustard on a white background).
 */
export function ensureContrast(fg: string, bg: string, minRatio = 3): string {
  if (contrastRatio(fg, bg) >= minRatio) return fg;
  const target = relativeLuminance(bg) > 0.4 ? '#000000' : '#ffffff';
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mixHex(fg, target, t);
    if (contrastRatio(c, bg) >= minRatio) return c;
  }
  return target;
}
