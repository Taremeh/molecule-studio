/**
 * Small, self-contained element tables used by the force field and the SMILES code.
 * OWNER: forcefield agent.
 *
 * These are deliberately independent of core/elements.ts valence lists: the force field needs
 * valence-electron counts (to count lone pairs / steric numbers) and a stable notion of which
 * elements form directional covalent bonds, regardless of how the periodic table data evolves.
 */

/** Valence-electron count for main-group elements (s + p electrons). */
const VALENCE_ELECTRONS: Record<string, number> = {
  H: 1, He: 2,
  Li: 1, Be: 2, B: 3, C: 4, N: 5, O: 6, F: 7, Ne: 8,
  Na: 1, Mg: 2, Al: 3, Si: 4, P: 5, S: 6, Cl: 7, Ar: 8,
  K: 1, Ca: 2, Ga: 3, Ge: 4, As: 5, Se: 6, Br: 7, Kr: 8,
  Rb: 1, Sr: 2, In: 3, Sn: 4, Sb: 5, Te: 6, I: 7, Xe: 8,
  Cs: 1, Ba: 2, Tl: 3, Pb: 4, Bi: 5, Po: 6, At: 7, Rn: 8,
};

/**
 * Elements whose bonds are treated as directional covalent bonds (angle / torsion terms).
 * Everything else (metals, unknown 'X') only gets bond-stretch and soft non-bonded terms.
 */
const COVALENT = new Set([
  'H', 'B', 'C', 'N', 'O', 'F', 'Si', 'P', 'S', 'Cl', 'Ge', 'As', 'Se', 'Br', 'Sb', 'Te', 'I', 'At',
  'He', 'Ne', 'Ar', 'Kr', 'Xe', 'Rn',
]);

/** Period-2 elements cannot expand their octet (N is special-cased for the neutral nitro convention). */
const PERIOD2 = new Set(['H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne']);

export function isCovalentElement(el: string): boolean {
  return COVALENT.has(el);
}

export function valenceElectrons(el: string): number | undefined {
  return VALENCE_ELECTRONS[el];
}

/**
 * Allowed total bond-order sums ("valences") for a main-group atom with the given formal charge,
 * ascending. Derived from the valence-electron count: the lowest valence completes the octet
 * (e.g. N 3, N+ 4, O− 1, C+ 3, B− 4); period ≥ 3 elements may expand by steps of two
 * (S 2/4/6, P 3/5, Cl 1/3/5/7). Neutral N also allows 5 (the N(=O)=O nitro convention).
 * Returns [] for metals / unknown elements (no valence model).
 */
export function allowedValences(el: string, charge = 0): number[] {
  if (!COVALENT.has(el)) return [];
  if (el === 'H') return [charge === 0 ? 1 : 0];
  const ve = VALENCE_ELECTRONS[el];
  if (ve === undefined) return [];
  const e = ve - charge;
  if (e < 0 || e > 8) return [];
  const base = e <= 4 ? e : 8 - e;
  const out = [base];
  if (!PERIOD2.has(el)) {
    for (let v = base + 2; v <= e; v += 2) out.push(v);
  } else if (el === 'N' && charge === 0) {
    out.push(5);
  }
  return out;
}

/** Lowest allowed valence (octet valence), or undefined for metals / unknown elements. */
export function baseValence(el: string, charge = 0): number | undefined {
  const v = allowedValences(el, charge);
  return v.length ? v[0] : undefined;
}

/** All element symbols 1–118 (used by the SMILES bracket-atom tokenizer). */
export const ELEMENT_SYMBOLS: readonly string[] = [
  'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar',
  'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr',
  'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe',
  'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu',
  'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn',
  'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr',
  'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og',
];
