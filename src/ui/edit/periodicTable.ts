/**
 * Periodic-table layout and element search for the element palette.
 * OWNER: edit-ui.
 */
import { ELEMENTS, type ElementCategory, type ElementInfo } from '../../core/elements';

export interface PeriodicCell {
  el: ElementInfo;
  /** CSS grid row (1–7 main table, 9–10 lanthanides / actinides; row 8 is a spacer). */
  row: number;
  /** CSS grid column 1–18. */
  col: number;
}

export const CATEGORY_LABELS: Record<ElementCategory, string> = {
  nonmetal: 'Nonmetal',
  'noble-gas': 'Noble gas',
  alkali: 'Alkali metal',
  'alkaline-earth': 'Alkaline earth',
  metalloid: 'Metalloid',
  halogen: 'Halogen',
  transition: 'Transition metal',
  'post-transition': 'Post-transition',
  lanthanide: 'Lanthanide',
  actinide: 'Actinide',
  unknown: 'Unknown',
};

/** Display order of categories in the legend. */
export const CATEGORY_ORDER: ElementCategory[] = [
  'nonmetal',
  'halogen',
  'noble-gas',
  'metalloid',
  'alkali',
  'alkaline-earth',
  'transition',
  'post-transition',
  'lanthanide',
  'actinide',
];

/**
 * Grid cells for every real element with a table position (the dummy 'X' and anything without a
 * valid position are skipped). If two elements claim the same cell, the first one (lower atomic
 * number) wins so the grid never overlaps.
 */
export function periodicCells(elements: readonly ElementInfo[] = ELEMENTS): PeriodicCell[] {
  const taken = new Set<string>();
  const out: PeriodicCell[] = [];
  const sorted = [...elements].sort((a, b) => a.number - b.number);
  for (const el of sorted) {
    if (el.number <= 0) continue;
    const row = el.tableRow;
    const col = el.tableCol;
    if (!(row >= 1 && row <= 10 && col >= 1 && col <= 18)) continue;
    const key = `${row}:${col}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ el, row, col });
  }
  return out;
}

/**
 * Placeholder cells in the main table pointing to the f-block rows ("57–71" / "89–103"), added where
 * the main table leaves group 3 of periods 6/7 empty and the corresponding f-block row exists.
 */
export function fBlockMarkers(cells: readonly PeriodicCell[]): { row: number; col: number; label: string; title: string }[] {
  const occupied = new Set(cells.map((c) => `${c.row}:${c.col}`));
  const out: { row: number; col: number; label: string; title: string }[] = [];
  const series: [number, number, string][] = [
    [6, 9, 'Lanthanides'],
    [7, 10, 'Actinides'],
  ];
  for (const [mainRow, fRow, title] of series) {
    const fCells = cells.filter((c) => c.row === fRow);
    if (!fCells.length || occupied.has(`${mainRow}:3`)) continue;
    const nums = fCells.map((c) => c.el.number);
    out.push({ row: mainRow, col: 3, label: `${Math.min(...nums)}–${Math.max(...nums)}`, title });
  }
  return out;
}

/** "4", "2 · 4 · 6", or "not checked" (metals / elements without a valence rule). */
export function formatValences(el: ElementInfo): string {
  return el.valences.length ? el.valences.join(' · ') : 'not checked';
}

/** Atomic mass formatted with sensible precision (heavy, unstable elements are given as integers). */
export function formatMass(el: ElementInfo): string {
  if (!(el.mass > 0)) return '—';
  if (Number.isInteger(el.mass)) return `[${el.mass}]`;
  return el.mass < 100 ? el.mass.toFixed(3) : el.mass.toFixed(2);
}

/**
 * Elements matching a free-text query, best first: exact symbol, symbol prefix, name prefix,
 * atomic number. Case-insensitive. Empty query → [].
 */
export function searchElements(query: string, elements: readonly ElementInfo[] = ELEMENTS): ElementInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const real = elements.filter((e) => e.number > 0);
  const scored: { el: ElementInfo; score: number }[] = [];
  const asNumber = /^\d+$/.test(q) ? parseInt(q, 10) : NaN;
  for (const el of real) {
    const sym = el.symbol.toLowerCase();
    const name = el.name.toLowerCase();
    let score = -1;
    if (sym === q) score = 0;
    else if (el.number === asNumber) score = 0;
    else if (sym.startsWith(q)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (q.length >= 3 && name.includes(q)) score = 3;
    if (score >= 0) scored.push({ el, score });
  }
  scored.sort((a, b) => a.score - b.score || a.el.number - b.el.number);
  return scored.map((s) => s.el);
}
