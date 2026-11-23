/**
 * Small element classification helpers shared by bonding / bond orders / selection.
 * OWNER: structure agent.
 *
 * These deliberately do not depend on the element table being complete: metal-ness is decided
 * from the symbol, so behaviour is stable whatever `core/elements` contains.
 */
import { getElement } from './elements';

/** Non-metals and metalloids (everything else, except the dummy 'X', is treated as a metal). */
const NON_METALS = new Set([
  'H', 'D', 'T', 'He', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Si', 'P', 'S', 'Cl', 'Ar', 'Ge', 'As', 'Se', 'Br', 'Kr',
  'Sb', 'Te', 'I', 'Xe', 'At', 'Rn', 'X',
]);

/** All element symbols 1–118 (used to recognise element names in selections without the full table). */
export const ELEMENT_SYMBOLS: readonly string[] = (
  'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr ' +
  'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb ' +
  'Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf ' +
  'Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'
).split(' ');

const ELEMENT_SET_UPPER = new Set(ELEMENT_SYMBOLS.map((s) => s.toUpperCase()));

export function isElementSymbol(s: string): boolean {
  return ELEMENT_SET_UPPER.has(s.toUpperCase());
}

export function isHydrogen(el: string): boolean {
  return el === 'H' || el === 'D' || el === 'T';
}

export function isMetal(el: string): boolean {
  return !NON_METALS.has(el);
}

/** Typical neutral valences used when the element table has none (or the element is missing). */
const FALLBACK_VALENCES: Record<string, number[]> = {
  H: [1], D: [1], B: [3], C: [4], N: [3], O: [2], F: [1], Si: [4], P: [3, 5], S: [2, 4, 6],
  Cl: [1], Br: [1], I: [1], Se: [2, 4, 6], As: [3, 5], Te: [2, 4, 6], Ge: [4],
};

/** Group 15–17 elements: a positive formal charge raises the valence (N+ → 4, O+ → 3), negative lowers it. */
const CHARGE_RAISES = new Set(['N', 'P', 'As', 'Sb', 'O', 'S', 'Se', 'Te', 'F', 'Cl', 'Br', 'I']);

/**
 * Allowed valences (ascending) for a non-metal atom with the given formal charge, or [] when no
 * valence model applies (metals, unknown elements, noble gases).
 */
export function allowedValences(el: string, charge = 0): number[] {
  if (isMetal(el) || el === 'X') return [];
  const info = getElement(el);
  const base = info.symbol.toUpperCase() === el.toUpperCase() && info.valences.length ? info.valences : FALLBACK_VALENCES[el];
  if (!base || base.length === 0) return [];
  if (charge === 0) return base.slice();
  let adjusted: number[];
  if (CHARGE_RAISES.has(el)) adjusted = base.map((v) => v + charge);
  else if (el === 'B') adjusted = base.map((v) => v - charge); // B⁻ (borate) → 4
  else adjusted = base.map((v) => v - Math.abs(charge)); // C⁺/C⁻ → 3, H⁺ → 0
  return [...new Set(adjusted.filter((v) => v >= 0))].sort((a, b) => a - b);
}

/** Covalent radius (Å) with a sane default for unknown elements. */
export function covalentRadius(el: string): number {
  const r = getElement(el).covalentRadius;
  return Number.isFinite(r) && r > 0 ? r : 0.75;
}
