import { describe, expect, it } from 'vitest';
import { buildMolecule, type AtomInput } from '../core/molecule';
import type { Molecule } from '../core/types';
import {
  CHAIN_PALETTE,
  KYTE_DOOLITTLE,
  SS_COLORS,
  colorLegend,
  computeAtomColors,
  gradientColor,
  hexToRgb,
  rgbToHex,
  srgbToLinear,
  turboColor,
} from './colors';

const rgbAt = (c: Float32Array, i: number) => [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
const hexAt = (c: Float32Array, i: number) => rgbToHex(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]);

function atom(p: Partial<AtomInput> & { element: string }): AtomInput {
  return { x: 0, y: 0, z: 0, ...p };
}

/** Small peptide: residues with given names/ss in chains, plus a ligand and a water. */
function peptide(): Molecule {
  const atoms: AtomInput[] = [];
  const add = (chain: string, resSeq: number, resName: string, ss: 'helix' | 'sheet' | 'coil', bfactor?: number) => {
    for (const [name, element] of [['N', 'N'], ['CA', 'C'], ['C', 'C'], ['O', 'O']] as const) {
      atoms.push(atom({ element, name, resName, resSeq, chain, ss, bfactor, x: atoms.length * 1.5 }));
    }
  };
  add('A', 1, 'ILE', 'helix', 10);
  add('A', 2, 'ARG', 'helix', 20);
  add('A', 3, 'GLY', 'sheet', 30);
  add('A', 4, 'ALA', 'coil', 40);
  add('B', 1, 'LYS', 'coil', 50);
  add('B', 2, 'GLU', 'sheet', 60);
  add('C', 1, 'SER', 'helix', 70);
  atoms.push(atom({ element: 'C', name: 'C1', resName: 'LIG', resSeq: 100, chain: 'A', hetero: true }));
  atoms.push(atom({ element: 'O', name: 'O', resName: 'HOH', resSeq: 200, chain: 'A', hetero: true }));
  return buildMolecule('pep', atoms);
}

describe('hex conversions', () => {
  it('round-trips', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(rgbToHex(1, 128 / 255, 0)).toBe('#ff8000');
    expect(hexToRgb('garbage')).toEqual([0.7, 0.7, 0.7]);
  });
  it('linearises sRGB', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 6);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 3);
  });
});

describe('computeAtomColors', () => {
  it('uses Jmol CPK colors for the element scheme', () => {
    const mol = buildMolecule('m', [atom({ element: 'C' }), atom({ element: 'O' }), atom({ element: 'N' }), atom({ element: 'H' })]);
    const c = computeAtomColors(mol, 'element', '#123456');
    expect(c.length).toBe(12);
    expect(hexAt(c, 0)).toBe('#909090');
    expect(hexAt(c, 1)).toBe('#ff0d0d');
    expect(hexAt(c, 2)).toBe('#3050f8');
    expect(hexAt(c, 3)).toBe('#ffffff');
  });

  it('caches per molecule, scheme and uniform color', () => {
    const mol = peptide();
    expect(computeAtomColors(mol, 'chain', '#000000')).toBe(computeAtomColors(mol, 'chain', '#ffffff'));
    const u1 = computeAtomColors(mol, 'uniform', '#ff0000');
    expect(computeAtomColors(mol, 'uniform', '#FF0000')).toBe(u1);
    const u2 = computeAtomColors(mol, 'uniform', '#00ff00');
    expect(u2).not.toBe(u1);
    expect(rgbAt(u1, 5)).toEqual([1, 0, 0]);
    expect(rgbAt(u2, 5)).toEqual([0, 1, 0]);
    // A new molecule object gets fresh colors.
    expect(computeAtomColors({ ...mol }, 'chain', '#000000')).not.toBe(computeAtomColors(mol, 'chain', '#000000'));
  });

  it('has a chain palette of ≥ 20 distinct colors, one per chain', () => {
    expect(CHAIN_PALETTE.length).toBeGreaterThanOrEqual(20);
    expect(new Set(CHAIN_PALETTE).size).toBe(CHAIN_PALETTE.length);
    // Minimum pairwise RGB distance keeps colors distinguishable.
    let min = Infinity;
    for (let i = 0; i < CHAIN_PALETTE.length; i++)
      for (let j = i + 1; j < CHAIN_PALETTE.length; j++) {
        const a = hexToRgb(CHAIN_PALETTE[i]);
        const b = hexToRgb(CHAIN_PALETTE[j]);
        min = Math.min(min, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    expect(min).toBeGreaterThan(0.05);

    const mol = peptide();
    const c = computeAtomColors(mol, 'chain', '#000000');
    const chainA = hexAt(c, 0);
    const chainB = hexAt(c, 16);
    const chainC = hexAt(c, 24);
    expect(hexAt(c, 15)).toBe(chainA); // same chain, other residue
    expect(new Set([chainA, chainB, chainC]).size).toBe(3);
    expect([chainA, chainB, chainC]).toEqual([CHAIN_PALETTE[0], CHAIN_PALETTE[1], CHAIN_PALETTE[2]]);
  });

  it('colors secondary structure and falls back to element colors elsewhere', () => {
    const mol = peptide();
    const c = computeAtomColors(mol, 'secondary', '#000000');
    expect(hexAt(c, 1)).toBe(SS_COLORS.helix); // ILE CA
    expect(hexAt(c, 3)).toBe(SS_COLORS.helix); // ILE O (whole residue)
    expect(hexAt(c, 9)).toBe(SS_COLORS.sheet); // GLY CA
    expect(hexAt(c, 13)).toBe(SS_COLORS.coil); // ALA CA
    expect(hexAt(c, 28)).toBe('#909090'); // ligand carbon
    expect(hexAt(c, 29)).toBe('#ff0d0d'); // water oxygen
  });

  it('normalises B-factors between the 5th and 95th percentile', () => {
    const atoms: AtomInput[] = [];
    for (let b = 0; b <= 100; b++) atoms.push(atom({ element: 'C', bfactor: b }));
    atoms.push(atom({ element: 'N' })); // no B-factor
    const mol = buildMolecule('b', atoms);
    const c = computeAtomColors(mol, 'bfactor', '#000000');
    const low = gradientColor(['#2166ac', '#67a9cf', '#f7f7f7', '#ef8a62', '#b2182b'].map(hexToRgb), 0);
    const high = gradientColor(['#2166ac', '#67a9cf', '#f7f7f7', '#ef8a62', '#b2182b'].map(hexToRgb), 1);
    for (const b of [0, 3, 5]) expect(rgbAt(c, b).map((v) => +v.toFixed(5))).toEqual(low.map((v) => +v.toFixed(5)));
    for (const b of [95, 99, 100]) expect(rgbAt(c, b).map((v) => +v.toFixed(5))).toEqual(high.map((v) => +v.toFixed(5)));
    expect(hexAt(c, 50)).toBe('#f7f7f7'); // median → white
    // Monotonic: blue decreases / red increases from low to high.
    expect(c[25 * 3 + 2]).toBeGreaterThan(c[75 * 3 + 2]);
    expect(c[25 * 3]).toBeLessThan(c[75 * 3]);
    expect(hexAt(c, 101)).toBe('#3050f8'); // atom without B-factor keeps its element color

    const legend = colorLegend(mol, 'bfactor', '#000000');
    expect(legend).toHaveLength(5);
    expect(legend[0].label).toContain('5');
    expect(legend[4].label).toContain('95');
  });

  it('uses pLDDT confidence bands for AlphaFold models', () => {
    const atoms = [95, 80, 60, 30].map((b) => atom({ element: 'C', bfactor: b }));
    const mol = buildMolecule('af', atoms, [], { source: 'alphafold' });
    const c = computeAtomColors(mol, 'bfactor', '#000000');
    expect([0, 1, 2, 3].map((i) => hexAt(c, i))).toEqual(['#0053d6', '#65cbf3', '#ffdb13', '#ff7d45']);
    expect(colorLegend(mol, 'bfactor', '#000000')).toHaveLength(4);
  });

  it('maps Kyte–Doolittle hydropathy from teal (hydrophilic) to orange (hydrophobic)', () => {
    expect(KYTE_DOOLITTLE.I).toBe(4.5);
    expect(KYTE_DOOLITTLE.R).toBe(-4.5);
    const mol = peptide();
    const c = computeAtomColors(mol, 'hydrophobicity', '#000000');
    const ile = rgbAt(c, 1);
    const arg = rgbAt(c, 5);
    expect(rgbToHex(ile[0], ile[1], ile[2])).toBe('#d9661f');
    expect(rgbToHex(arg[0], arg[1], arg[2])).toBe('#1b9e9e');
    expect(ile[0]).toBeGreaterThan(ile[2]); // orange
    expect(arg[2]).toBeGreaterThan(arg[0]); // teal
    expect(hexAt(c, 28)).toBe('#909090'); // ligand → element
  });

  it('colors residue types (amino acid groups, nucleotides)', () => {
    const atoms: AtomInput[] = [];
    ['DA', 'DC', 'DG', 'DT'].forEach((resName, i) => atoms.push(atom({ element: 'P', name: 'P', resName, resSeq: i + 1, chain: 'X' })));
    atoms.push(atom({ element: 'C', name: 'CA', resName: 'ASP', resSeq: 10, chain: 'Y' }));
    atoms.push(atom({ element: 'C', name: 'CA', resName: 'LYS', resSeq: 11, chain: 'Y' }));
    const mol = buildMolecule('r', atoms);
    const c = computeAtomColors(mol, 'residue', '#000000');
    const cols = [0, 1, 2, 3].map((i) => hexAt(c, i));
    expect(new Set(cols).size).toBe(4);
    const [a, cc, g, t] = [0, 1, 2, 3].map((i) => rgbAt(c, i));
    expect(a[0]).toBeGreaterThan(a[1]); // A red-ish
    expect(cc[0]).toBeGreaterThan(cc[2]); // C yellow
    expect(cc[1]).toBeGreaterThan(cc[2]);
    expect(g[1]).toBeGreaterThan(g[0]); // G green
    expect(t[2]).toBeGreaterThan(t[0]); // T blue
    expect(hexAt(c, 4)).not.toBe(hexAt(c, 5)); // acidic vs basic
    const legend = colorLegend(mol, 'residue', '#000000');
    expect(legend.map((e) => e.label)).toEqual(['Acidic (D, E)', 'Basic (K, R)', 'Adenine (A)', 'Cytosine (C)', 'Guanine (G)', 'Thymine (T)']);
  });

  it('runs the rainbow N→C per chain from blue to red', () => {
    const mol = peptide();
    const c = computeAtomColors(mol, 'rainbow', '#000000');
    const first = rgbAt(c, 1); // chain A residue 1
    const last = rgbAt(c, 13); // chain A residue 4
    expect(first[2]).toBeGreaterThan(first[0]);
    expect(last[0]).toBeGreaterThan(last[2]);
    // Chain B restarts at blue.
    expect(hexAt(c, 17)).toBe(hexAt(c, 1));
    expect(hexAt(c, 28)).toBe('#909090'); // ligand
    const t0 = turboColor(0);
    const t1 = turboColor(1);
    expect(t0[2]).toBeGreaterThan(0.7);
    expect(t1[0]).toBeGreaterThan(0.6);
  });

  it('returns legends for every scheme', () => {
    const mol = peptide();
    expect(colorLegend(mol, 'element', '#000000').map((e) => e.label)).toEqual(['C', 'O', 'N']); // by frequency
    expect(colorLegend(mol, 'chain', '#000000').map((e) => e.label)).toEqual(['Chain A', 'Chain B', 'Chain C']);
    expect(colorLegend(mol, 'secondary', '#000000')).toHaveLength(3);
    expect(colorLegend(mol, 'uniform', '#AbCdEf')).toEqual([{ label: 'All atoms', color: '#abcdef' }]);
    for (const s of ['hydrophobicity', 'rainbow'] as const) {
      const l = colorLegend(mol, s, '#000000');
      expect(l.length).toBeGreaterThanOrEqual(3);
      expect(l.length).toBeLessThanOrEqual(5);
      for (const e of l) expect(e.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keeps every component within [0, 1] for all schemes', () => {
    const mol = peptide();
    for (const s of ['element', 'chain', 'residue', 'secondary', 'bfactor', 'hydrophobicity', 'rainbow', 'uniform'] as const) {
      const c = computeAtomColors(mol, s, '#336699');
      expect(c.length).toBe(mol.atoms.length * 3);
      for (const v of c) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
