/**
 * Element symbols for file IO.
 *
 * The io layer keeps its own immutable symbol table (index = atomic number) so that parsers can map
 * atomic numbers (XYZ, some MOL2/CIF files) to symbols and normalize element text deterministically,
 * independent of the richer periodic-table data in core/elements.ts. `normalizeElement` follows the
 * same documented semantics as core/elements.ts `normalizeElementSymbol` ('CL' → 'Cl', 'c' → 'C',
 * ' FE' → 'Fe', digits/charges stripped, unknown → 'X'), plus deuterium/tritium → 'H'.
 */

/** Element symbols; index = atomic number (index 0 is the dummy 'X'). */
export const ELEMENT_SYMBOLS: readonly string[] = [
  'X',
  'H', 'He',
  'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar',
  'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr',
  'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe',
  'Cs', 'Ba',
  'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu',
  'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn',
  'Fr', 'Ra',
  'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr',
  'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og',
];

/** Upper-case symbol → canonical symbol. */
const CANONICAL = new Map<string, string>();
for (let z = 1; z < ELEMENT_SYMBOLS.length; z++) CANONICAL.set(ELEMENT_SYMBOLS[z].toUpperCase(), ELEMENT_SYMBOLS[z]);
// Hydrogen isotopes written with their own symbols in PDB / MDL files.
CANONICAL.set('D', 'H');
CANONICAL.set('T', 'H');

/** Canonical symbol for an exact (case-insensitive) symbol, or undefined. No stripping. */
export function exactElement(raw: string): string | undefined {
  return CANONICAL.get(raw.toUpperCase());
}

/** True if `raw` is exactly an element symbol (case-insensitive), e.g. 'FE', 'c'. */
export function isElementSymbol(raw: string): boolean {
  return CANONICAL.has(raw.toUpperCase());
}

const normCache = new Map<string, string>();

/**
 * Normalize raw element text from files to a canonical symbol.
 * Non-letters are stripped ('O1-' → 'O'); a two-letter symbol is preferred ('CL' → 'Cl'),
 * then the first letter ('CX' → 'C'). Unknown → 'X'. Results are memoized (hot path for big files).
 */
export function normalizeElement(raw: string): string {
  const cached = normCache.get(raw);
  if (cached !== undefined) return cached;
  let letters = '';
  for (let i = 0; i < raw.length && letters.length < 2; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters += raw[i];
  }
  let out = 'X';
  if (letters.length === 2 && CANONICAL.has(letters.toUpperCase())) out = CANONICAL.get(letters.toUpperCase())!;
  else if (letters.length >= 1 && CANONICAL.has(letters[0].toUpperCase())) out = CANONICAL.get(letters[0].toUpperCase())!;
  if (normCache.size < 10000) normCache.set(raw, out);
  return out;
}

/** Symbol for an atomic number, or 'X' if out of range. */
export function symbolFromAtomicNumber(z: number): string {
  return Number.isInteger(z) && z > 0 && z < ELEMENT_SYMBOLS.length ? ELEMENT_SYMBOLS[z] : 'X';
}

/** Atomic number of a symbol (0 for unknown / 'X'). */
export function atomicNumber(symbol: string): number {
  const canon = CANONICAL.get(symbol.toUpperCase());
  return canon ? ELEMENT_SYMBOLS.indexOf(canon) : 0;
}
