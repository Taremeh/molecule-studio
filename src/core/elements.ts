/**
 * Periodic table data.
 * OWNER: chemistry agent. CONTRACT: keep exported names & signatures.
 *
 * Data sources
 * - mass: IUPAC standard atomic weights (abridged / conventional values, 2021). Elements without a
 *   standard atomic weight use the mass number of their longest-lived isotope (e.g. Tc 98, Pu 244).
 * - covalentRadius: Cordero et al., Dalton Trans. 2008, 2832 (single-bond radii; sp3 C = 0.76;
 *   low-spin values for Mn, Fe, Co). Cordero stops at Cm (96); Bk–Og use the single-bond radii of
 *   Pyykkö & Atsumi, Chem. Eur. J. 2009, 15, 186.
 * - vdwRadius: Bondi, J. Phys. Chem. 1964, 68, 441, extended for main-group elements by Mantina et al.,
 *   J. Phys. Chem. A 2009, 113, 5806; remaining d/f-block elements from Alvarez, Dalton Trans. 2013,
 *   42, 8617; 2.0 Å when no value is available.
 * - color: Jmol CPK palette (Jmol defines colours up to Mt; Ds–Og reuse Mt's colour).
 * - valences: typical neutral valences used by the valence checker (see chemistry.ts). Metals,
 *   noble gases and the dummy atom have [] meaning "do not check".
 * - electronegativity: Pauling scale (CRC Handbook); undefined for He, Ne, Ar and Lr onwards.
 *
 * Periodic-table layout (tableRow / tableCol)
 * - Rows 1–7 are the periods, columns 1–18 the IUPAC groups.
 * - The f-block is split out: lanthanides La–Lu are row 9, actinides Ac–Lr row 10, both in
 *   columns 3–17 (15 elements each). The main-table cells (6, 3) and (7, 3) are therefore left EMPTY
 *   as placeholders for the f-block ("57–71" / "89–103"); Hf/Rf start at column 4.
 * - The dummy element 'X' has tableRow = tableCol = 0 (not shown in the table).
 */

export type ElementCategory =
  | 'nonmetal'
  | 'noble-gas'
  | 'alkali'
  | 'alkaline-earth'
  | 'metalloid'
  | 'halogen'
  | 'transition'
  | 'post-transition'
  | 'lanthanide'
  | 'actinide'
  | 'unknown';

export interface ElementInfo {
  /** Atomic number (0 for the dummy element 'X'). */
  number: number;
  symbol: string;
  name: string;
  /** Standard atomic weight (g/mol). */
  mass: number;
  /** Single-bond covalent radius (Å). */
  covalentRadius: number;
  /** van der Waals radius (Å). */
  vdwRadius: number;
  /** Jmol CPK color '#rrggbb'. */
  color: string;
  /** Allowed typical valences for neutral atoms, ascending. Empty = do not check valence (metals). */
  valences: number[];
  /** Pauling electronegativity, if known. */
  electronegativity?: number;
  category: ElementCategory;
  /** Periodic-table grid position for layout: row 1–7 main table, rows 9–10 for lanthanides/actinides. */
  tableRow: number;
  /** Periodic-table grid column 1–18 (f-block rows use columns 3–17). */
  tableCol: number;
  /** Period 1–7 (0 for 'X'). Unlike tableRow, lanthanides are period 6 and actinides period 7. */
  period?: number;
  /** IUPAC group 1–18; undefined for the f-block (La–Lu, Ac–Lr) and 'X'. */
  group?: number;
}

// [symbol, name, mass, covalent radius, vdW radius, Jmol colour (hex), Pauling EN (0 = unknown)]
type RawElement = [string, string, number, number, number, string, number];

// prettier-ignore
const RAW: RawElement[] = [
  ['H', 'Hydrogen', 1.008, 0.31, 1.20, 'ffffff', 2.20],
  ['He', 'Helium', 4.0026, 0.28, 1.40, 'd9ffff', 0],
  ['Li', 'Lithium', 6.94, 1.28, 1.82, 'cc80ff', 0.98],
  ['Be', 'Beryllium', 9.0122, 0.96, 1.53, 'c2ff00', 1.57],
  ['B', 'Boron', 10.81, 0.84, 1.92, 'ffb5b5', 2.04],
  ['C', 'Carbon', 12.011, 0.76, 1.70, '909090', 2.55],
  ['N', 'Nitrogen', 14.007, 0.71, 1.55, '3050f8', 3.04],
  ['O', 'Oxygen', 15.999, 0.66, 1.52, 'ff0d0d', 3.44],
  ['F', 'Fluorine', 18.998, 0.57, 1.47, '90e050', 3.98],
  ['Ne', 'Neon', 20.18, 0.58, 1.54, 'b3e3f5', 0],
  ['Na', 'Sodium', 22.99, 1.66, 2.27, 'ab5cf2', 0.93],
  ['Mg', 'Magnesium', 24.305, 1.41, 1.73, '8aff00', 1.31],
  ['Al', 'Aluminium', 26.982, 1.21, 1.84, 'bfa6a6', 1.61],
  ['Si', 'Silicon', 28.085, 1.11, 2.10, 'f0c8a0', 1.90],
  ['P', 'Phosphorus', 30.974, 1.07, 1.80, 'ff8000', 2.19],
  ['S', 'Sulfur', 32.06, 1.05, 1.80, 'ffff30', 2.58],
  ['Cl', 'Chlorine', 35.45, 1.02, 1.75, '1ff01f', 3.16],
  ['Ar', 'Argon', 39.95, 1.06, 1.88, '80d1e3', 0],
  ['K', 'Potassium', 39.098, 2.03, 2.75, '8f40d4', 0.82],
  ['Ca', 'Calcium', 40.078, 1.76, 2.31, '3dff00', 1.00],
  ['Sc', 'Scandium', 44.956, 1.70, 2.58, 'e6e6e6', 1.36],
  ['Ti', 'Titanium', 47.867, 1.60, 2.46, 'bfc2c7', 1.54],
  ['V', 'Vanadium', 50.942, 1.53, 2.42, 'a6a6ab', 1.63],
  ['Cr', 'Chromium', 51.996, 1.39, 2.45, '8a99c7', 1.66],
  ['Mn', 'Manganese', 54.938, 1.39, 2.45, '9c7ac7', 1.55],
  ['Fe', 'Iron', 55.845, 1.32, 2.44, 'e06633', 1.83],
  ['Co', 'Cobalt', 58.933, 1.26, 2.40, 'f090a0', 1.88],
  ['Ni', 'Nickel', 58.693, 1.24, 1.63, '50d050', 1.91],
  ['Cu', 'Copper', 63.546, 1.32, 1.40, 'c88033', 1.90],
  ['Zn', 'Zinc', 65.38, 1.22, 1.39, '7d80b0', 1.65],
  ['Ga', 'Gallium', 69.723, 1.22, 1.87, 'c28f8f', 1.81],
  ['Ge', 'Germanium', 72.63, 1.20, 2.11, '668f8f', 2.01],
  ['As', 'Arsenic', 74.922, 1.19, 1.85, 'bd80e3', 2.18],
  ['Se', 'Selenium', 78.971, 1.20, 1.90, 'ffa100', 2.55],
  ['Br', 'Bromine', 79.904, 1.20, 1.85, 'a62929', 2.96],
  ['Kr', 'Krypton', 83.798, 1.16, 2.02, '5cb8d1', 3.00],
  ['Rb', 'Rubidium', 85.468, 2.20, 3.03, '702eb0', 0.82],
  ['Sr', 'Strontium', 87.62, 1.95, 2.49, '00ff00', 0.95],
  ['Y', 'Yttrium', 88.906, 1.90, 2.75, '94ffff', 1.22],
  ['Zr', 'Zirconium', 91.224, 1.75, 2.52, '94e0e0', 1.33],
  ['Nb', 'Niobium', 92.906, 1.64, 2.56, '73c2c9', 1.6],
  ['Mo', 'Molybdenum', 95.95, 1.54, 2.45, '54b5b5', 2.16],
  ['Tc', 'Technetium', 98, 1.47, 2.44, '3b9e9e', 1.9],
  ['Ru', 'Ruthenium', 101.07, 1.46, 2.46, '248f8f', 2.2],
  ['Rh', 'Rhodium', 102.91, 1.42, 2.44, '0a7d8c', 2.28],
  ['Pd', 'Palladium', 106.42, 1.39, 1.63, '006985', 2.20],
  ['Ag', 'Silver', 107.87, 1.45, 1.72, 'c0c0c0', 1.93],
  ['Cd', 'Cadmium', 112.41, 1.44, 1.58, 'ffd98f', 1.69],
  ['In', 'Indium', 114.82, 1.42, 1.93, 'a67573', 1.78],
  ['Sn', 'Tin', 118.71, 1.39, 2.17, '668080', 1.96],
  ['Sb', 'Antimony', 121.76, 1.39, 2.06, '9e63b5', 2.05],
  ['Te', 'Tellurium', 127.6, 1.38, 2.06, 'd47a00', 2.1],
  ['I', 'Iodine', 126.9, 1.39, 1.98, '940094', 2.66],
  ['Xe', 'Xenon', 131.29, 1.40, 2.16, '429eb0', 2.60],
  ['Cs', 'Caesium', 132.91, 2.44, 3.43, '57178f', 0.79],
  ['Ba', 'Barium', 137.33, 2.15, 2.68, '00c900', 0.89],
  ['La', 'Lanthanum', 138.91, 2.07, 2.98, '70d4ff', 1.10],
  ['Ce', 'Cerium', 140.12, 2.04, 2.88, 'ffffc7', 1.12],
  ['Pr', 'Praseodymium', 140.91, 2.03, 2.92, 'd9ffc7', 1.13],
  ['Nd', 'Neodymium', 144.24, 2.01, 2.95, 'c7ffc7', 1.14],
  ['Pm', 'Promethium', 145, 1.99, 2.0, 'a3ffc7', 1.13],
  ['Sm', 'Samarium', 150.36, 1.98, 2.90, '8fffc7', 1.17],
  ['Eu', 'Europium', 151.96, 1.98, 2.87, '61ffc7', 1.2],
  ['Gd', 'Gadolinium', 157.25, 1.96, 2.83, '45ffc7', 1.20],
  ['Tb', 'Terbium', 158.93, 1.94, 2.79, '30ffc7', 1.1],
  ['Dy', 'Dysprosium', 162.5, 1.92, 2.87, '1fffc7', 1.22],
  ['Ho', 'Holmium', 164.93, 1.92, 2.81, '00ff9c', 1.23],
  ['Er', 'Erbium', 167.26, 1.89, 2.83, '00e675', 1.24],
  ['Tm', 'Thulium', 168.93, 1.90, 2.79, '00d452', 1.25],
  ['Yb', 'Ytterbium', 173.05, 1.87, 2.80, '00bf38', 1.1],
  ['Lu', 'Lutetium', 174.97, 1.87, 2.74, '00ab24', 1.27],
  ['Hf', 'Hafnium', 178.49, 1.75, 2.63, '4dc2ff', 1.3],
  ['Ta', 'Tantalum', 180.95, 1.70, 2.53, '4da6ff', 1.5],
  ['W', 'Tungsten', 183.84, 1.62, 2.57, '2194d6', 2.36],
  ['Re', 'Rhenium', 186.21, 1.51, 2.49, '267dab', 1.9],
  ['Os', 'Osmium', 190.23, 1.44, 2.48, '266696', 2.2],
  ['Ir', 'Iridium', 192.22, 1.41, 2.41, '175487', 2.20],
  ['Pt', 'Platinum', 195.08, 1.36, 1.75, 'd0d0e0', 2.28],
  ['Au', 'Gold', 196.97, 1.36, 1.66, 'ffd123', 2.54],
  ['Hg', 'Mercury', 200.59, 1.32, 1.55, 'b8b8d0', 2.00],
  ['Tl', 'Thallium', 204.38, 1.45, 1.96, 'a6544d', 1.62],
  ['Pb', 'Lead', 207.2, 1.46, 2.02, '575961', 2.33],
  ['Bi', 'Bismuth', 208.98, 1.48, 2.07, '9e4fb5', 2.02],
  ['Po', 'Polonium', 209, 1.40, 1.97, 'ab5c00', 2.0],
  ['At', 'Astatine', 210, 1.50, 2.02, '754f45', 2.2],
  ['Rn', 'Radon', 222, 1.50, 2.20, '428296', 2.2],
  ['Fr', 'Francium', 223, 2.60, 3.48, '420066', 0.7],
  ['Ra', 'Radium', 226, 2.21, 2.83, '007d00', 0.9],
  ['Ac', 'Actinium', 227, 2.15, 2.80, '70abfa', 1.1],
  ['Th', 'Thorium', 232.04, 2.06, 2.93, '00baff', 1.3],
  ['Pa', 'Protactinium', 231.04, 2.00, 2.88, '00a1ff', 1.5],
  ['U', 'Uranium', 238.03, 1.96, 1.86, '008fff', 1.38],
  ['Np', 'Neptunium', 237, 1.90, 2.82, '0080ff', 1.36],
  ['Pu', 'Plutonium', 244, 1.87, 2.81, '006bff', 1.28],
  ['Am', 'Americium', 243, 1.80, 2.83, '545cf2', 1.13],
  ['Cm', 'Curium', 247, 1.69, 3.05, '785ce3', 1.28],
  ['Bk', 'Berkelium', 247, 1.68, 2.0, '8a4fe3', 1.3],
  ['Cf', 'Californium', 251, 1.68, 2.0, 'a136d4', 1.3],
  ['Es', 'Einsteinium', 252, 1.65, 2.0, 'b31fd4', 1.3],
  ['Fm', 'Fermium', 257, 1.67, 2.0, 'b31fba', 1.3],
  ['Md', 'Mendelevium', 258, 1.73, 2.0, 'b30da6', 1.3],
  ['No', 'Nobelium', 259, 1.76, 2.0, 'bd0d87', 1.3],
  ['Lr', 'Lawrencium', 266, 1.61, 2.0, 'c70066', 0],
  ['Rf', 'Rutherfordium', 267, 1.57, 2.0, 'cc0059', 0],
  ['Db', 'Dubnium', 268, 1.49, 2.0, 'd1004f', 0],
  ['Sg', 'Seaborgium', 269, 1.43, 2.0, 'd90045', 0],
  ['Bh', 'Bohrium', 270, 1.41, 2.0, 'e00038', 0],
  ['Hs', 'Hassium', 269, 1.34, 2.0, 'e6002e', 0],
  ['Mt', 'Meitnerium', 278, 1.29, 2.0, 'eb0026', 0],
  ['Ds', 'Darmstadtium', 281, 1.28, 2.0, 'eb0026', 0],
  ['Rg', 'Roentgenium', 282, 1.21, 2.0, 'eb0026', 0],
  ['Cn', 'Copernicium', 285, 1.22, 2.0, 'eb0026', 0],
  ['Nh', 'Nihonium', 286, 1.36, 2.0, 'eb0026', 0],
  ['Fl', 'Flerovium', 289, 1.43, 2.0, 'eb0026', 0],
  ['Mc', 'Moscovium', 290, 1.62, 2.0, 'eb0026', 0],
  ['Lv', 'Livermorium', 293, 1.75, 2.0, 'eb0026', 0],
  ['Ts', 'Tennessine', 294, 1.65, 2.0, 'eb0026', 0],
  ['Og', 'Oganesson', 294, 1.57, 2.0, 'eb0026', 0],
];

/** Typical neutral valences (ascending). Elements not listed are not valence-checked. */
const VALENCES: Record<string, number[]> = {
  H: [1],
  B: [3],
  C: [4],
  N: [3],
  O: [2],
  F: [1],
  Si: [4],
  P: [3, 5],
  S: [2, 4, 6],
  Cl: [1, 3, 5, 7],
  Ge: [4],
  As: [3, 5],
  Se: [2, 4, 6],
  Br: [1, 3, 5],
  Sb: [3, 5],
  Te: [2, 4, 6],
  I: [1, 3, 5, 7],
  At: [1],
};

const NONMETALS = new Set([1, 6, 7, 8, 15, 16, 34]);
const METALLOIDS = new Set([5, 14, 32, 33, 51, 52]);
const HALOGENS = new Set([9, 17, 35, 53, 85, 117]);
const NOBLE_GASES = new Set([2, 10, 18, 36, 54, 86, 118]);
const ALKALI = new Set([3, 11, 19, 37, 55, 87]);
const ALKALINE_EARTH = new Set([4, 12, 20, 38, 56, 88]);

/** Period, group and table cell for atomic number z (1–118). */
function layout(z: number): { period: number; group?: number; row: number; col: number } {
  if (z <= 2) return { period: 1, group: z === 1 ? 1 : 18, row: 1, col: z === 1 ? 1 : 18 };
  // Periods 2 and 3: groups 1–2 then 13–18.
  if (z <= 18) {
    const period = z <= 10 ? 2 : 3;
    const k = z - (period === 2 ? 3 : 11); // 0..7 within the period
    const group = k < 2 ? k + 1 : k + 11;
    return { period, group, row: period, col: group };
  }
  // Periods 4 and 5: 18 elements, one per group.
  if (z <= 54) {
    const period = z <= 36 ? 4 : 5;
    const group = z - (period === 4 ? 18 : 36);
    return { period, group, row: period, col: group };
  }
  // Periods 6 and 7: 32 elements; the 15 f-block elements go to rows 9 / 10, columns 3–17.
  const period = z <= 86 ? 6 : 7;
  const start = period === 6 ? 55 : 87;
  const k = z - start; // 0..31
  if (k < 2) return { period, group: k + 1, row: period, col: k + 1 };
  if (k < 17) return { period, row: period === 6 ? 9 : 10, col: k + 1 }; // La..Lu / Ac..Lr → cols 3..17
  const group = k - 13; // Hf / Rf (k = 17) → group 4 … Rn / Og (k = 31) → group 18
  return { period, group, row: period, col: group };
}

function categoryOf(z: number, group: number | undefined): ElementCategory {
  if (z >= 57 && z <= 71) return 'lanthanide';
  if (z >= 89 && z <= 103) return 'actinide';
  if (NONMETALS.has(z)) return 'nonmetal';
  if (METALLOIDS.has(z)) return 'metalloid';
  if (HALOGENS.has(z)) return 'halogen';
  if (NOBLE_GASES.has(z)) return 'noble-gas';
  if (ALKALI.has(z)) return 'alkali';
  if (ALKALINE_EARTH.has(z)) return 'alkaline-earth';
  if (group !== undefined && group >= 3 && group <= 12) return 'transition';
  if (group !== undefined && group >= 13 && group <= 16) return 'post-transition';
  return 'unknown';
}

const DUMMY: ElementInfo = {
  number: 0,
  symbol: 'X',
  name: 'Unknown',
  mass: 0,
  covalentRadius: 0.7,
  vdwRadius: 2.0,
  color: '#ff1493',
  valences: [],
  category: 'unknown',
  tableRow: 0,
  tableCol: 0,
  period: 0,
};

function buildTable(): ElementInfo[] {
  const out: ElementInfo[] = [DUMMY];
  RAW.forEach(([symbol, name, mass, covalentRadius, vdwRadius, color, en], i) => {
    const z = i + 1;
    const pos = layout(z);
    const info: ElementInfo = {
      number: z,
      symbol,
      name,
      mass,
      covalentRadius,
      vdwRadius,
      color: '#' + color,
      valences: VALENCES[symbol] ?? [],
      category: categoryOf(z, pos.group),
      tableRow: pos.row,
      tableCol: pos.col,
      period: pos.period,
    };
    if (en > 0) info.electronegativity = en;
    if (pos.group !== undefined) info.group = pos.group;
    out.push(info);
  });
  return out;
}

/** All elements; ELEMENTS[0] is the dummy 'X', then ordered by atomic number. */
export const ELEMENTS: ElementInfo[] = buildTable();

const bySymbol = new Map<string, ElementInfo>();
for (const e of ELEMENTS) bySymbol.set(e.symbol.toUpperCase(), e);

/** Look up an element by (case-insensitive) symbol. Unknown → the dummy 'X' element. */
export function getElement(symbol: string): ElementInfo {
  return bySymbol.get(symbol.toUpperCase()) ?? ELEMENTS[0];
}

/** Element by atomic number (1–118); anything else → the dummy 'X' element. */
export function elementByNumber(z: number): ElementInfo {
  return Number.isInteger(z) && z >= 1 && z < ELEMENTS.length ? ELEMENTS[z] : ELEMENTS[0];
}

/** True if the symbol is a known element (not 'X'). */
export function isKnownElement(symbol: string): boolean {
  return bySymbol.has(symbol.toUpperCase()) && symbol.toUpperCase() !== 'X';
}

/** True for elements whose valence is not checked (metals, noble gases, unknown). */
export function isValenceUnchecked(symbol: string): boolean {
  return getElement(symbol).valences.length === 0;
}

/**
 * Normalize raw element text from files: 'CL' → 'Cl', 'c' → 'C', ' FE' → 'Fe'.
 * Strips digits/charges ('O1-' → 'O'). Unknown → 'X'.
 * The hydrogen isotopes 'D' and 'T' (neutron structures) map to 'H'.
 */
export function normalizeElementSymbol(raw: string): string {
  const s = raw.replace(/[^A-Za-z]/g, '');
  if (!s) return 'X';
  const two = s.length >= 2 ? s[0].toUpperCase() + s[1].toLowerCase() : '';
  if (two && bySymbol.has(two.toUpperCase())) return two;
  const one = s[0].toUpperCase();
  if (bySymbol.has(one)) return one;
  if (s.length === 1 && (one === 'D' || one === 'T')) return 'H';
  return 'X';
}

/** Elements offered as quick picks in the editor palette. */
export const COMMON_ELEMENTS = ['C', 'N', 'O', 'H', 'S', 'P', 'F', 'Cl', 'Br', 'I'];
