/**
 * TEST ONLY — a small, fixed element table (Cordero 2008 covalent radii, Bondi vdW radii) so the
 * editor's unit tests don't depend on the concurrently developed core/elements.ts.
 * Used via vi.mock('../core/elements', () => import('./testing/fakeElements')).
 */
import type { ElementInfo } from '../../core/elements';

const E = (number: number, symbol: string, name: string, mass: number, covalentRadius: number, vdwRadius: number, valences: number[]): ElementInfo => ({
  number,
  symbol,
  name,
  mass,
  covalentRadius,
  vdwRadius,
  color: '#909090',
  valences,
  category: 'nonmetal',
  tableRow: 1,
  tableCol: 1,
});

export const ELEMENTS: ElementInfo[] = [
  E(0, 'X', 'Unknown', 0, 0.7, 2.0, []),
  E(1, 'H', 'Hydrogen', 1.008, 0.31, 1.2, [1]),
  E(6, 'C', 'Carbon', 12.011, 0.76, 1.7, [4]),
  E(7, 'N', 'Nitrogen', 14.007, 0.71, 1.55, [3]),
  E(8, 'O', 'Oxygen', 15.999, 0.66, 1.52, [2]),
  E(9, 'F', 'Fluorine', 18.998, 0.57, 1.47, [1]),
  E(10, 'Ne', 'Neon', 20.18, 0.58, 1.54, [0]),
  E(16, 'S', 'Sulfur', 32.06, 1.05, 1.8, [2, 4, 6]),
  E(17, 'Cl', 'Chlorine', 35.45, 1.02, 1.75, [1, 3, 5, 7]),
  E(26, 'Fe', 'Iron', 55.845, 1.32, 2.0, []),
];

const bySymbol = new Map(ELEMENTS.map((e) => [e.symbol.toUpperCase(), e]));

export function getElement(symbol: string): ElementInfo {
  return bySymbol.get(symbol.toUpperCase()) ?? ELEMENTS[0];
}

export function isKnownElement(symbol: string): boolean {
  return bySymbol.has(symbol.toUpperCase()) && symbol.toUpperCase() !== 'X';
}

export function normalizeElementSymbol(raw: string): string {
  const s = raw.replace(/[^A-Za-z]/g, '');
  if (!s) return 'X';
  const two = s.length >= 2 ? s[0].toUpperCase() + s[1].toLowerCase() : '';
  if (two && bySymbol.has(two.toUpperCase())) return two;
  return bySymbol.has(s[0].toUpperCase()) ? s[0].toUpperCase() : 'X';
}

export const COMMON_ELEMENTS = ['C', 'N', 'O', 'H', 'S', 'F', 'Cl'];
