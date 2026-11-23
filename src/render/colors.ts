/**
 * Color schemes. OWNER: advanced-render agent. CONTRACT: keep exported names & signatures.
 *
 * All colors are sRGB components in [0, 1]. Three.js consumers must convert with
 * `color.setRGB(r, g, b, THREE.SRGBColorSpace)` (ColorManagement is enabled).
 *
 * Schemes:
 *  - element: element.color from core/elements (Jmol CPK); uniformColor is ignored (carbons keep their
 *    element color).
 *  - chain: distinct palette per chain id (≥ 20 well-separated, colorblind-friendly-ish colors), stable by chain order.
 *  - residue: residue type (e.g. Shapely / RasMol amino colors; nucleotides A/C/G/T/U distinct); non-residue → element.
 *  - secondary: helix magenta/pink, sheet gold/yellow, coil light grey; non-protein → element.
 *  - bfactor: blue (low) → white → red (high), normalised over the whole molecule (5th–95th percentile).
 *  - hydrophobicity: Kyte–Doolittle scale, hydrophilic (teal/blue) → hydrophobic (orange/brown); non-protein → element.
 *  - rainbow: residue index gradient (N→C) per chain, blue → red (turbo-like); non-residue → element.
 *  - uniform: uniformColor everywhere.
 *
 * Implementation notes
 *  - Following core/types.ts (`Representation.uniformColor`), the 'element' scheme keeps CPK colors for
 *    carbon too; `uniformColor` only matters for the 'uniform' scheme.
 *  - 'bfactor' on AlphaFold models (meta.source === 'alphafold') uses the standard AlphaFold pLDDT
 *    confidence bands instead (the B-factor column holds pLDDT there, where *high* means *good*).
 *  - Results are cached per molecule object; the returned arrays are shared — never mutate them.
 */
import type { ColorScheme, Molecule, SecondaryStructure, Topology } from '../core/types';
import { getElement } from '../core/elements';
import { getTopology } from '../core/molecule';

export type RGB = [number, number, number];

// ---------------------------------------------------------------------------
// Basic conversions
// ---------------------------------------------------------------------------

/** Parse '#rrggbb' → [r, g, b] in 0..1 (sRGB). */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.7, 0.7, 0.7];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** sRGB component (0..1) → linear-sRGB (the working space of three.js vertex colors). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/**
 * 24 chain colors. Generated in OKLCH: 12 vivid colors (L 0.72, C ≤ 0.15) followed by 12 light ones
 * (L 0.85, C ≤ 0.09), hues stepped by 150° so consecutive chains always differ strongly. Readable on both
 * the dark and the light theme background.
 */
export const CHAIN_PALETTE: readonly string[] = [
  '#52a9fe', '#f28058', '#13bcb5', '#e17cc2', '#85b749', '#9498fe',
  '#df911a', '#09b7dc', '#f2798f', '#2fc183', '#c188ea', '#baa613',
  '#ecbaef', '#cbd591', '#b8cefd', '#fcbf95', '#82dfea', '#feb6d1',
  '#a9deaa', '#d1c4fe', '#e9ca89', '#95d7fe', '#fdbbb4', '#8ce1ca',
];

export const SS_COLORS: Readonly<Record<SecondaryStructure, string>> = {
  helix: '#e6519b',
  sheet: '#f2c14e',
  coil: '#c8cdd6',
};

/**
 * Amino-acid groups for the 'residue' scheme: RasMol "amino" (property-based) colors, brightened so the
 * dark residues stay visible on a dark background.
 */
const AMINO_GROUPS: { label: string; color: string; letters: string }[] = [
  { label: 'Acidic (D, E)', color: '#e8504f', letters: 'DE' },
  { label: 'Basic (K, R)', color: '#4a7bf7', letters: 'KR' },
  { label: 'Histidine', color: '#8a9bf0', letters: 'H' },
  { label: 'Polar (S, T)', color: '#f59f3a', letters: 'ST' },
  { label: 'Amide (N, Q)', color: '#38c9c9', letters: 'NQ' },
  { label: 'Sulfur (C, M)', color: '#e9d43f', letters: 'CMU' },
  { label: 'Aliphatic (A, V, L, I)', color: '#58b858', letters: 'AVLI' },
  { label: 'Aromatic (F, Y, W)', color: '#a774d6', letters: 'FYW' },
  { label: 'Glycine', color: '#e8e8e8', letters: 'G' },
  { label: 'Proline', color: '#e09c86', letters: 'P' },
  { label: 'Other amino acid', color: '#bba27a', letters: 'XO' },
];

/** Nucleotide colors (common convention: A red, C yellow, G green, T blue, U cyan-blue). */
const NUCLEOTIDE_GROUPS: { label: string; color: string; letters: string }[] = [
  { label: 'Adenine (A)', color: '#e5615e', letters: 'A' },
  { label: 'Cytosine (C)', color: '#f2d04b', letters: 'C' },
  { label: 'Guanine (G)', color: '#5cbf63', letters: 'G' },
  { label: 'Thymine (T)', color: '#4f86e8', letters: 'T' },
  { label: 'Uracil (U)', color: '#45b6e6', letters: 'U' },
  { label: 'Other nucleotide', color: '#a0a6b0', letters: 'IN' },
];

function groupIndex(groups: { letters: string }[], letter: string): number {
  for (let i = 0; i < groups.length; i++) if (groups[i].letters.includes(letter)) return i;
  return groups.length - 1;
}

/** Kyte & Doolittle (1982) hydropathy index by one-letter code. */
export const KYTE_DOOLITTLE: Readonly<Record<string, number>> = {
  I: 4.5, V: 4.2, L: 3.8, F: 2.8, C: 2.5, M: 1.9, A: 1.8, G: -0.4, T: -0.7, S: -0.8,
  W: -0.9, Y: -1.3, P: -1.6, H: -3.2, E: -3.5, Q: -3.5, D: -3.5, N: -3.5, K: -3.9, R: -4.5,
  U: 2.5, // selenocysteine ~ cysteine
};

const BFACTOR_STOPS: RGB[] = ['#2166ac', '#67a9cf', '#f7f7f7', '#ef8a62', '#b2182b'].map(hexToRgb);
const HYDRO_STOPS: RGB[] = ['#1b9e9e', '#8fd3cf', '#f5f5f2', '#f4b26b', '#d9661f'].map(hexToRgb);

/** AlphaFold DB pLDDT confidence bands (official colors). */
const PLDDT_BANDS: { min: number; label: string; color: string }[] = [
  { min: 90, label: 'Very high (pLDDT > 90)', color: '#0053d6' },
  { min: 70, label: 'Confident (70–90)', color: '#65cbf3' },
  { min: 50, label: 'Low (50–70)', color: '#ffdb13' },
  { min: -Infinity, label: 'Very low (< 50)', color: '#ff7d45' },
];

/** Piecewise-linear gradient through evenly spaced stops; t clamped to [0, 1]. */
export function gradientColor(stops: readonly RGB[], t: number): RGB {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Turbo colormap (Mikhailov 2019, polynomial approximation), restricted to t ∈ [0.1, 0.9] so both ends
 * stay bright (blue → cyan → green → yellow → red).
 */
export function turboColor(t: number): RGB {
  const x = 0.1 + 0.8 * Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return [c(r), c(g), c(b)];
}

// ---------------------------------------------------------------------------
// Scheme implementation
// ---------------------------------------------------------------------------

const elementRgbCache = new Map<string, RGB>();
function elementRgb(symbol: string): RGB {
  let c = elementRgbCache.get(symbol);
  if (!c) {
    c = hexToRgb(getElement(symbol).color);
    elementRgbCache.set(symbol, c);
  }
  return c;
}

const hexRgbCache = new Map<string, RGB>();
function cachedHex(hex: string): RGB {
  let c = hexRgbCache.get(hex);
  if (!c) {
    c = hexToRgb(hex);
    hexRgbCache.set(hex, c);
  }
  return c;
}

function put(out: Float32Array, i: number, c: RGB) {
  out[i * 3] = c[0];
  out[i * 3 + 1] = c[1];
  out[i * 3 + 2] = c[2];
}

function isPolymer(kind: string): boolean {
  return kind === 'protein' || kind === 'nucleic';
}

/** Linear-interpolated percentile of a sorted array. */
function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return NaN;
  const x = (sorted.length - 1) * p;
  const i = Math.floor(x);
  const j = Math.min(sorted.length - 1, i + 1);
  return sorted[i] + (sorted[j] - sorted[i]) * (x - i);
}

/** 5th/95th percentile of the defined B-factors, or null if the molecule has none. */
function bfactorRange(mol: Molecule): { lo: number; hi: number } | null {
  const vals: number[] = [];
  for (const a of mol.atoms) if (a.bfactor !== undefined && Number.isFinite(a.bfactor)) vals.push(a.bfactor);
  if (vals.length === 0) return null;
  const sorted = Float64Array.from(vals).sort();
  return { lo: percentile(sorted, 0.05), hi: percentile(sorted, 0.95) };
}

function isAlphaFold(mol: Molecule): boolean {
  return (mol.meta.source ?? '').toLowerCase() === 'alphafold';
}

function plddtBand(v: number) {
  for (const b of PLDDT_BANDS) if (v > b.min) return b;
  return PLDDT_BANDS[PLDDT_BANDS.length - 1];
}

/** Map chain id → palette index by order of appearance in the topology. */
function chainIndexMap(topo: Topology): Map<string, number> {
  const m = new Map<string, number>();
  topo.chains.forEach((c, i) => m.set(c.id, i));
  return m;
}

function chainColor(index: number): string {
  return CHAIN_PALETTE[((index % CHAIN_PALETTE.length) + CHAIN_PALETTE.length) % CHAIN_PALETTE.length];
}

function fillColors(mol: Molecule, scheme: ColorScheme, uniformColor: string): Float32Array {
  const n = mol.atoms.length;
  const out = new Float32Array(n * 3);
  const atoms = mol.atoms;
  // Element colors are the fallback for every scheme (except uniform).
  if (scheme !== 'uniform') for (let i = 0; i < n; i++) put(out, i, elementRgb(atoms[i].element));
  if (scheme === 'element') return out;
  if (scheme === 'uniform') {
    const c = hexToRgb(uniformColor);
    for (let i = 0; i < n; i++) put(out, i, c);
    return out;
  }

  const topo = getTopology(mol);
  const { residues, atomResidue } = topo;

  switch (scheme) {
    case 'chain': {
      const idx = chainIndexMap(topo);
      for (let i = 0; i < n; i++) {
        const r = atomResidue[i];
        if (r < 0) continue;
        put(out, i, cachedHex(chainColor(idx.get(residues[r].chain) ?? 0)));
      }
      break;
    }
    case 'residue': {
      for (let i = 0; i < n; i++) {
        const r = atomResidue[i];
        if (r < 0) continue;
        const res = residues[r];
        if (res.kind === 'protein') put(out, i, cachedHex(AMINO_GROUPS[groupIndex(AMINO_GROUPS, res.oneLetter)].color));
        else if (res.kind === 'nucleic') put(out, i, cachedHex(NUCLEOTIDE_GROUPS[groupIndex(NUCLEOTIDE_GROUPS, res.oneLetter)].color));
      }
      break;
    }
    case 'secondary': {
      for (let i = 0; i < n; i++) {
        const r = atomResidue[i];
        if (r < 0 || residues[r].kind !== 'protein') continue;
        put(out, i, cachedHex(SS_COLORS[residues[r].ss ?? atoms[i].ss ?? 'coil']));
      }
      break;
    }
    case 'bfactor': {
      if (isAlphaFold(mol)) {
        for (let i = 0; i < n; i++) {
          const b = atoms[i].bfactor;
          if (b !== undefined && Number.isFinite(b)) put(out, i, cachedHex(plddtBand(b).color));
        }
        break;
      }
      const range = bfactorRange(mol);
      if (!range) break;
      const span = range.hi - range.lo;
      for (let i = 0; i < n; i++) {
        const b = atoms[i].bfactor;
        if (b === undefined || !Number.isFinite(b)) continue;
        put(out, i, gradientColor(BFACTOR_STOPS, span > 1e-9 ? (b - range.lo) / span : 0.5));
      }
      break;
    }
    case 'hydrophobicity': {
      for (let i = 0; i < n; i++) {
        const r = atomResidue[i];
        if (r < 0 || residues[r].kind !== 'protein') continue;
        const kd = KYTE_DOOLITTLE[residues[r].oneLetter] ?? 0;
        put(out, i, gradientColor(HYDRO_STOPS, (kd + 4.5) / 9));
      }
      break;
    }
    case 'rainbow': {
      // Position of each polymer residue along its chain (N → C), normalised per chain.
      const t = new Float32Array(residues.length).fill(-1);
      for (const chain of topo.chains) {
        const poly = chain.residueIndices.filter((ri) => isPolymer(residues[ri].kind));
        const denom = Math.max(1, poly.length - 1);
        poly.forEach((ri, k) => (t[ri] = poly.length === 1 ? 0 : k / denom));
      }
      for (let i = 0; i < n; i++) {
        const r = atomResidue[i];
        if (r < 0 || t[r] < 0) continue;
        put(out, i, turboColor(t[r]));
      }
      break;
    }
  }
  return out;
}

const colorCache = new WeakMap<Molecule, Map<string, Float32Array>>();

/** Per-atom sRGB colors (length = atoms × 3), indexed by atom index. Cached per (molecule, scheme, uniformColor). */
export function computeAtomColors(mol: Molecule, scheme: ColorScheme, uniformColor: string): Float32Array {
  const key = scheme === 'uniform' ? `uniform|${uniformColor.trim().toLowerCase()}` : scheme;
  let perMol = colorCache.get(mol);
  if (!perMol) {
    perMol = new Map();
    colorCache.set(mol, perMol);
  }
  let out = perMol.get(key);
  if (!out) {
    out = fillColors(mol, scheme, uniformColor);
    perMol.set(key, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

const MAX_LEGEND = 12;

function fmtValue(v: number): string {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, '');
}

function gradientLegend(stops: readonly RGB[], labels: string[]): { label: string; color: string }[] {
  return labels.map((label, i) => {
    const c = gradientColor(stops, labels.length === 1 ? 0.5 : i / (labels.length - 1));
    return { label, color: rgbToHex(c[0], c[1], c[2]) };
  });
}

/** Legend entries for the UI (max ~12 entries; for gradients return 3–5 stops with labels like 'low'/'high'). */
export function colorLegend(mol: Molecule, scheme: ColorScheme, uniformColor: string): { label: string; color: string }[] {
  switch (scheme) {
    case 'uniform':
      return [{ label: 'All atoms', color: rgbToHex(...hexToRgb(uniformColor)) }];
    case 'element': {
      const counts = new Map<string, number>();
      for (const a of mol.atoms) counts.set(a.element, (counts.get(a.element) ?? 0) + 1);
      return [...counts.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .slice(0, MAX_LEGEND)
        .map(([el]) => ({ label: el, color: getElement(el).color.toLowerCase() }));
    }
    case 'chain': {
      const topo = getTopology(mol);
      const entries = topo.chains.map((c, i) => ({ label: c.id ? `Chain ${c.id}` : 'No chain id', color: chainColor(i) }));
      if (entries.length <= MAX_LEGEND) return entries;
      return [...entries.slice(0, MAX_LEGEND - 1), { label: `+${entries.length - (MAX_LEGEND - 1)} more chains`, color: '#8a8f99' }];
    }
    case 'residue': {
      const topo = getTopology(mol);
      const amino = new Set<number>();
      const nuc = new Set<number>();
      for (const r of topo.residues) {
        if (r.kind === 'protein') amino.add(groupIndex(AMINO_GROUPS, r.oneLetter));
        else if (r.kind === 'nucleic') nuc.add(groupIndex(NUCLEOTIDE_GROUPS, r.oneLetter));
      }
      const out: { label: string; color: string }[] = [];
      AMINO_GROUPS.forEach((g, i) => amino.has(i) && out.push({ label: g.label, color: g.color }));
      NUCLEOTIDE_GROUPS.forEach((g, i) => nuc.has(i) && out.push({ label: g.label, color: g.color }));
      return out;
    }
    case 'secondary':
      return [
        { label: 'Helix', color: SS_COLORS.helix },
        { label: 'Sheet', color: SS_COLORS.sheet },
        { label: 'Coil / loop', color: SS_COLORS.coil },
      ];
    case 'bfactor': {
      if (isAlphaFold(mol)) return PLDDT_BANDS.map((b) => ({ label: b.label, color: b.color }));
      const range = bfactorRange(mol);
      if (!range) return [];
      const { lo, hi } = range;
      if (hi - lo <= 1e-9) return gradientLegend(BFACTOR_STOPS, [`${fmtValue(lo)} (uniform)`]);
      const labels = [0, 0.25, 0.5, 0.75, 1].map((f) => fmtValue(lo + (hi - lo) * f));
      labels[0] = `≤ ${labels[0]} (low)`;
      labels[4] = `≥ ${labels[4]} (high)`;
      return gradientLegend(BFACTOR_STOPS, labels);
    }
    case 'hydrophobicity':
      return gradientLegend(HYDRO_STOPS, ['−4.5 hydrophilic', '−2.25', '0 neutral', '+2.25', '+4.5 hydrophobic']);
    case 'rainbow': {
      const stops = [0, 0.25, 0.5, 0.75, 1];
      const labels = ['N-terminus', '25%', '50%', '75%', 'C-terminus'];
      return stops.map((t, i) => {
        const c = turboColor(t);
        return { label: labels[i], color: rgbToHex(c[0], c[1], c[2]) };
      });
    }
  }
  return [];
}

export const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
  element: 'Element',
  chain: 'Chain',
  residue: 'Residue type',
  secondary: 'Secondary structure',
  bfactor: 'B-factor',
  hydrophobicity: 'Hydrophobicity',
  rainbow: 'Rainbow (N→C)',
  uniform: 'Single color',
};

/** Highlight colors for editor feedback (hex). */
export const HIGHLIGHT_COLORS = {
  selection: '#facc15',
  hover: '#60a5fa',
  valid: '#22c55e',
  invalid: '#ef4444',
  delete: '#ef4444',
  target: '#22d3ee',
  suggest: '#a78bfa',
  valenceOver: '#ef4444',
  valenceUnder: '#f59e0b',
} as const;
