import { describe, expect, it } from 'vitest';
import type { AtomInput, BondInput } from './molecule';
import { buildMolecule } from './molecule';
import { setElement, setPositions, translateAtoms } from './edit';
import {
  evaluateSelection,
  maskToIds,
  quickSelections,
  quoteSelectionValue,
  selectionHelp,
  selectionIndexIdentity,
  selectionSuggestions,
  validateSelection,
} from './selection';
import type { Molecule, SecondaryStructure } from './types';

// ---------------------------------------------------------------------------------------------
// Fixture: a small "complex" with two protein chains, a heme-like ligand, waters, ions, DNA.
// Atom indices are listed in comments; residues are 10+ Å apart except where noted.
// ---------------------------------------------------------------------------------------------

interface Spec {
  name: string;
  el: string;
  pos?: [number, number, number];
  bondTo?: string[];
  extra?: Partial<AtomInput>;
}

function buildFixture(): Molecule {
  const atoms: AtomInput[] = [];
  const bonds: BondInput[] = [];
  let x0 = 0;
  const residue = (
    resName: string,
    resSeq: number,
    chain: string,
    specs: Spec[],
    opts: { hetero?: boolean; ss?: SecondaryStructure; iCode?: string; at?: number } = {},
  ) => {
    const base = atoms.length;
    const local = new Map<string, number>();
    const origin = opts.at ?? (x0 += 10);
    specs.forEach((s, k) => {
      const [x, y, z] = s.pos ?? [origin + 0.3 * k, 0.5 * (k % 3), 0];
      local.set(s.name, base + k);
      atoms.push({ element: s.el, name: s.name, resName, resSeq, chain, hetero: opts.hetero ?? false, ss: opts.ss, iCode: opts.iCode, x, y, z, serial: 1000 + base + k, bfactor: base + k, occupancy: 1, ...s.extra });
    });
    specs.forEach((s, k) => s.bondTo?.forEach((t) => bonds.push({ a: base + k, b: local.get(t)! })));
    return local;
  };
  const bbSpecs = (): Spec[] => [
    { name: 'N', el: 'N' },
    { name: 'CA', el: 'C', bondTo: ['N'] },
    { name: 'C', el: 'C', bondTo: ['CA'] },
    { name: 'O', el: 'O', bondTo: ['C'] },
  ];
  const peptide = (prev: Map<string, number>, next: Map<string, number>) => bonds.push({ a: prev.get('C')!, b: next.get('N')! });

  // Chain A: ALA 1 (0–7), GLY 2 (8–12), HIS 3 (13–19), ASP 4 (20–28)
  const ala = residue('ALA', 1, 'A', [...bbSpecs(), { name: 'CB', el: 'C', bondTo: ['CA'] }, { name: 'H', el: 'H', bondTo: ['N'] }, { name: 'HA', el: 'H', bondTo: ['CA'] }, { name: 'HB1', el: 'H', bondTo: ['CB'] }], { ss: 'helix' });
  const gly = residue('GLY', 2, 'A', [...bbSpecs(), { name: 'HA2', el: 'H', bondTo: ['CA'] }], { ss: 'helix' });
  const his = residue('HIS', 3, 'A', [...bbSpecs(), { name: 'CB', el: 'C', bondTo: ['CA'] }, { name: 'CG', el: 'C', bondTo: ['CB'] }, { name: 'ND1', el: 'N', bondTo: ['CG'] }], { ss: 'coil' });
  const asp = residue('ASP', 4, 'A', [
    ...bbSpecs(),
    { name: 'CB', el: 'C', bondTo: ['CA'] },
    { name: 'CG', el: 'C', bondTo: ['CB'] },
    { name: 'OD1', el: 'O', bondTo: ['CG'] },
    { name: 'OD2', el: 'O', bondTo: ['CG'], extra: { charge: -1 } },
    { name: 'OXT', el: 'O', bondTo: ['C'] },
  ]);
  peptide(ala, gly);
  peptide(gly, his);
  peptide(his, asp);
  // Chain B: LYS 10 (29–34, helix), PHE 11 (35–40, sheet)
  const lys = residue('LYS', 10, 'B', [...bbSpecs(), { name: 'CB', el: 'C', bondTo: ['CA'] }, { name: 'NZ', el: 'N', bondTo: ['CB'], extra: { charge: 1 } }], { ss: 'helix' });
  const phe = residue('PHE', 11, 'B', [...bbSpecs(), { name: 'CB', el: 'C', bondTo: ['CA'] }, { name: 'CG', el: 'C', bondTo: ['CB'] }], { ss: 'sheet' });
  peptide(lys, phe);
  // HEM 500 chain B (41–43) at x≈100
  residue('HEM', 500, 'B', [
    { name: 'FE', el: 'Fe', pos: [100, 0, 0] },
    { name: 'NA', el: 'N', pos: [98, 0, 0], bondTo: ['FE'] },
    { name: 'C1A', el: 'C', pos: [97, 1, 0], bondTo: ['NA'] },
  ], { hetero: true });
  // Waters: HOH 601 (44–46) 3 Å from FE; HOH 602 (47) 10 Å away
  residue('HOH', 601, 'W', [
    { name: 'O', el: 'O', pos: [103, 0, 0] },
    { name: 'H1', el: 'H', pos: [103.96, 0, 0], bondTo: ['O'] },
    { name: 'H2', el: 'H', pos: [102.76, 0.93, 0], bondTo: ['O'] },
  ], { hetero: true });
  residue('HOH', 602, 'W', [{ name: 'O', el: 'O', pos: [110, 0, 0] }], { hetero: true });
  // Ions: NA 701 (48) 4.5 Å from FE; ZN 702 (49)
  residue('NA', 701, 'I', [{ name: 'NA', el: 'Na', pos: [104.5, 0, 0], extra: { charge: 1 } }], { hetero: true });
  residue('ZN', 702, 'I', [{ name: 'ZN', el: 'Zn', pos: [150, 0, 0], extra: { charge: 2, occupancy: 0.5 } }], { hetero: true });
  // DNA: DA 1 chain C (50–59)
  residue('DA', 1, 'C', [
    { name: 'P', el: 'P' },
    { name: 'OP1', el: 'O', bondTo: ['P'] },
    { name: 'OP2', el: 'O', bondTo: ['P'] },
    { name: "O5'", el: 'O', bondTo: ['P'] },
    { name: "C5'", el: 'C', bondTo: ["O5'"] },
    { name: "C4'", el: 'C', bondTo: ["C5'"] },
    { name: "C3'", el: 'C', bondTo: ["C4'"] },
    { name: "O3'", el: 'O', bondTo: ["C3'"] },
    { name: 'N9', el: 'N' },
    { name: 'C8', el: 'C', bondTo: ['N9'] },
  ]);
  // Chain D: SER 52A (60–61), MET -1 (62–63)
  residue('SER', 52, 'D', [{ name: 'N', el: 'N' }, { name: 'CA', el: 'C', bondTo: ['N'] }], { iCode: 'A', ss: 'coil' });
  residue('MET', -1, 'D', [{ name: 'N', el: 'N' }, { name: 'CA', el: 'C', bondTo: ['N'] }]);
  return buildMolecule('fixture', atoms, bonds);
}

const MOL = buildFixture();
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

/** Selected atom indices for a query (throws on error so failures are visible). */
function sel(query: string, mol: Molecule = MOL, ctx = {}): number[] {
  const r = evaluateSelection(mol, query, ctx);
  if (r.error) throw new Error(`query "${query}" failed: ${r.error}`);
  const out: number[] = [];
  r.mask.forEach((v, i) => v && out.push(i));
  expect(r.count).toBe(out.length);
  return out;
}

function err(query: string, mol: Molecule = MOL): string {
  const r = evaluateSelection(mol, query);
  expect(r.count).toBe(0);
  expect(r.mask.every((v) => v === 0)).toBe(true);
  return r.error ?? '';
}

const N = MOL.atoms.length;
const PROTEIN = [...range(0, 40), 60, 61, 62, 63];

// ---------------------------------------------------------------------------------------------

describe('evaluateSelection: keywords', () => {
  it('all / none / empty', () => {
    expect(N).toBe(64);
    for (const q of ['', '  ', 'all', 'ALL', 'everything', '*']) expect(sel(q)).toHaveLength(N);
    expect(sel('none')).toEqual([]);
  });

  it('residue classes', () => {
    expect(sel('protein')).toEqual(PROTEIN);
    expect(sel('nucleic')).toEqual(range(50, 59));
    expect(sel('water')).toEqual([44, 45, 46, 47]);
    expect(sel('solvent')).toEqual(sel('water'));
    expect(sel('waters')).toEqual(sel('water'));
    expect(sel('ion')).toEqual([48, 49]);
    expect(sel('ions')).toEqual([48, 49]);
    expect(sel('ligand')).toEqual([41, 42, 43]);
    expect(sel('hetero')).toEqual(range(41, 49));
    expect(sel('organic')).toEqual([41, 42, 43]);
  });

  it('backbone / sidechain', () => {
    expect(sel('backbone')).toEqual([0, 1, 2, 3, 8, 9, 10, 11, 13, 14, 15, 16, 20, 21, 22, 23, 28, 29, 30, 31, 32, 35, 36, 37, 38, ...range(50, 57), 60, 61, 62, 63]);
    // Backbone H atoms (H on N, HA on CA, HA2 on Gly CA) are not side chain.
    expect(sel('sidechain')).toEqual([4, 7, 17, 18, 19, 24, 25, 26, 27, 33, 34, 39, 40]);
    expect(sel('sidechains')).toEqual(sel('sidechain'));
  });

  it('hydrogen / heavy', () => {
    expect(sel('hydrogen')).toEqual([5, 6, 7, 12, 45, 46]);
    expect(sel('hydrogens')).toEqual(sel('hydrogen'));
    expect(sel('heavy')).toHaveLength(N - 6);
  });

  it('secondary structure', () => {
    expect(sel('helix')).toEqual([...range(0, 12), ...range(29, 34)]);
    expect(sel('sheet')).toEqual(range(35, 40));
    expect(sel('strand')).toEqual(sel('sheet'));
    // Unset ss on protein atoms counts as coil; non-protein atoms never do.
    expect(sel('coil')).toEqual([...range(13, 28), 60, 61, 62, 63]);
    expect(sel('loop')).toEqual(sel('coil'));
  });

  it('amino-acid classes', () => {
    expect(sel('acidic')).toEqual(range(20, 28));
    expect(sel('basic')).toEqual([...range(13, 19), ...range(29, 34)]);
    expect(sel('charged')).toEqual([...range(13, 34)]);
    expect(sel('aromatic')).toEqual([...range(13, 19), ...range(35, 40)]);
    expect(sel('hydrophobic')).toEqual([...range(0, 7), ...range(35, 40), 62, 63]);
    expect(sel('polar')).toEqual([...range(13, 34), 60, 61]);
  });

  it('element (case-insensitive)', () => {
    expect(sel('element Fe')).toEqual([41]);
    expect(sel('element fe ZN')).toEqual([41, 49]);
    expect(sel('element H')).toEqual(sel('hydrogen'));
    expect(sel('elem P')).toEqual([50]);
  });

  it('name with wildcards and primes', () => {
    expect(sel('name CA')).toEqual([1, 9, 14, 21, 30, 36, 61, 63]);
    expect(sel('name ca')).toEqual(sel('name CA'));
    expect(sel('atomname OD1 OD2')).toEqual([26, 27]);
    expect(sel('name OD*')).toEqual([26, 27]);
    expect(sel('name H?')).toEqual([6, 45, 46]);
    expect(sel('name HB?')).toEqual([7]);
    expect(sel('name H*')).toEqual([5, 6, 7, 12, 45, 46]);
    expect(sel("name O5'")).toEqual([53]);
    expect(sel('name "O3\'" "C3\'"')).toEqual([56, 57]);
  });

  it('resname / resn', () => {
    expect(sel('resname HIS')).toEqual(range(13, 19));
    expect(sel('resn his asp')).toEqual(range(13, 28));
    expect(sel('resname H*')).toEqual([...range(13, 19), 41, 42, 43, 44, 45, 46, 47]);
    expect(sel('resname ALA,GLY')).toEqual(range(0, 12));
  });

  it('resid: lists, ranges, negative numbers, insertion codes', () => {
    expect(sel('resid 1')).toEqual([...range(0, 7), ...range(50, 59)]);
    expect(sel('resid 2 3')).toEqual(range(8, 19));
    expect(sel('resid 2 to 4')).toEqual(range(8, 28));
    expect(sel('resid 2-4')).toEqual(sel('resid 2 to 4'));
    expect(sel('resid 2 - 4')).toEqual(sel('resid 2 to 4'));
    expect(sel('resi 2:4')).toEqual(sel('resid 2 to 4'));
    expect(sel('residue 4 to 2')).toEqual(sel('resid 2 to 4'));
    expect(sel('resid -1')).toEqual([62, 63]);
    expect(sel('resid -5 to 0')).toEqual([62, 63]);
    expect(sel('resid 52A')).toEqual([60, 61]);
    expect(sel('resid 52B')).toEqual([]);
    expect(sel('resid 52')).toEqual([60, 61]);
    expect(sel('resid 1,2')).toEqual([...range(0, 12), ...range(50, 59)]);
  });

  it('chain: case-sensitive with case-insensitive fallback', () => {
    expect(sel('chain B')).toEqual(range(29, 43));
    expect(sel('chain A B')).toEqual(range(0, 43));
    expect(sel('chain A,B')).toEqual(range(0, 43));
    expect(sel('chain b')).toEqual(sel('chain B'));
    const two = buildMolecule('cs', [
      { element: 'C', x: 0, y: 0, z: 0, chain: 'A', resName: 'ALA', resSeq: 1 },
      { element: 'C', x: 5, y: 0, z: 0, chain: 'a', resName: 'ALA', resSeq: 1 },
    ]);
    expect(sel('chain A', two)).toEqual([0]);
    expect(sel('chain a', two)).toEqual([1]);
  });

  it('index / id / serial', () => {
    expect(sel('index 0 2 4')).toEqual([0, 2, 4]);
    expect(sel('index 60 to 100')).toEqual([60, 61, 62, 63]);
    expect(sel('id 1 2 3')).toEqual([0, 1, 2]);
    expect(sel('id 5-7')).toEqual([4, 5, 6]);
    expect(sel('id 0 1000')).toEqual([]);
    expect(sel('serial 1000 1063')).toEqual([0, 63]);
    expect(sel('serial 1010 to 1012')).toEqual([10, 11, 12]);
  });

  it('numeric properties', () => {
    expect(sel('bfactor > 61')).toEqual([62, 63]);
    expect(sel('bfactor <= 1')).toEqual([0, 1]);
    expect(sel('beta 10 to 12')).toEqual([10, 11, 12]);
    expect(sel('occupancy < 1')).toEqual([49]);
    expect(sel('charge != 0')).toEqual([27, 34, 48, 49]);
    expect(sel('charge -1')).toEqual([27]);
    expect(sel('charge = 2')).toEqual([49]);
    expect(sel('x > 145')).toEqual([49]);
    expect(sel('y == 0.93')).toEqual([46]);
  });

  it('within / exwithin (distance in Å, grid accelerated)', () => {
    expect(sel('within 4 of resname HEM')).toEqual([41, 42, 43, 44, 45, 46]);
    expect(sel('within 5 of resname HEM')).toEqual([41, 42, 43, 44, 45, 46, 48]);
    expect(sel('exwithin 4 of resname HEM')).toEqual([44, 45, 46]);
    expect(sel('water and within 3.5 of name FE')).toEqual([44, 46]);
    expect(sel('within 0 of name FE')).toEqual([41]);
    expect(sel('within 5 of none')).toEqual([]);
  });

  it('same residue / chain / fragment as, byres, bychain', () => {
    expect(sel('same residue as name FE')).toEqual([41, 42, 43]);
    expect(sel('byres name OD1')).toEqual(range(20, 28));
    expect(sel('same residue as within 3.5 of name FE')).toEqual([41, 42, 43, 44, 45, 46]);
    expect(sel('same chain as name NZ')).toEqual(range(29, 43));
    expect(sel('bychain name NZ')).toEqual(sel('same chain as name NZ'));
    // Fragment = bonded component: the peptide A chain is connected through peptide bonds.
    expect(sel('same fragment as name OXT')).toEqual(range(0, 28));
  });

  it('bonded to', () => {
    expect(sel('bonded to name CB and resname ALA')).toEqual([1, 7]);
    expect(sel('bonded to (name CB and resname ALA)')).toEqual([1, 7]);
    expect(sel('hydrogen and bonded to name CA')).toEqual([6, 12]);
  });

  it('selected / sele uses the context and is not cached', () => {
    const ids = new Set([MOL.atoms[3].id, MOL.atoms[5].id]);
    expect(sel('selected', MOL, { selectedIds: ids })).toEqual([3, 5]);
    expect(sel('sele', MOL, { selectedIds: new Set([MOL.atoms[0].id]) })).toEqual([0]);
    expect(sel('byres selected', MOL, { selectedIds: ids })).toEqual(range(0, 7));
    expect(sel('selected')).toEqual([]);
  });
});

describe('evaluateSelection: molecules without residue information', () => {
  // Ethanol-like fragment (bonded) + a free Na and Cl (XYZ / SDF salt style).
  const salt = buildMolecule(
    'salt',
    [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: 1.5, y: 0, z: 0 },
      { element: 'O', x: 2.0, y: 1.3, z: 0 },
      { element: 'H', x: 2.9, y: 1.3, z: 0 },
      { element: 'Na', x: 8, y: 0, z: 0 },
      { element: 'Cl', x: 11, y: 0, z: 0 },
    ],
    [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }],
  );

  it('organic / ion fall back to bonded fragments and isolated atoms', () => {
    expect(sel('organic', salt)).toEqual([0, 1, 2, 3]);
    expect(sel('ion', salt)).toEqual([4, 5]);
    expect(sel('protein or water or ligand', salt)).toEqual([]);
  });

  it('same residue as uses the bonded fragment', () => {
    expect(sel('same residue as element O', salt)).toEqual([0, 1, 2, 3]);
    expect(sel('byres element Na', salt)).toEqual([4]);
    expect(sel('same fragment as index 0', salt)).toEqual([0, 1, 2, 3]);
  });
});

describe('evaluateSelection: bare words', () => {
  it('resname, then atom name, then element; integers → resid', () => {
    expect(sel('HIS')).toEqual(sel('resname HIS'));
    expect(sel('hem')).toEqual([41, 42, 43]);
    expect(sel('CA')).toEqual(sel('name CA'));
    expect(sel('OD*')).toEqual([26, 27]);
    expect(sel('3')).toEqual(sel('resid 3'));
    expect(sel('2-3')).toEqual(sel('resid 2 3'));
    // Residue-less molecule: falls through to element symbols.
    const xyz = buildMolecule('xyz', [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'O', x: 1.2, y: 0, z: 0 },
    ]);
    expect(sel('O', xyz)).toEqual([1]);
    expect(sel('c', xyz)).toEqual([0]);
    // Unknown, not keyword-like words simply match nothing.
    expect(sel('XYZ1')).toEqual([]);
  });

  it('a quoted value is a bare word', () => {
    expect(sel('"HEM"')).toEqual([41, 42, 43]);
  });
});

describe('evaluateSelection: operators and precedence', () => {
  it('and / or / not and their symbols', () => {
    expect(sel('protein and helix')).toEqual(sel('helix'));
    expect(sel('protein & helix')).toEqual(sel('helix'));
    expect(sel('protein && helix')).toEqual(sel('helix'));
    expect(sel('water or ion')).toEqual([44, 45, 46, 47, 48, 49]);
    expect(sel('water | ion')).toEqual(sel('water or ion'));
    expect(sel('water || ion')).toEqual(sel('water or ion'));
    expect(sel('water, ion')).toEqual(sel('water or ion'));
    expect(sel('not protein')).toHaveLength(N - PROTEIN.length);
    expect(sel('!protein')).toEqual(sel('not protein'));
    expect(sel('NOT protein AND water')).toEqual(sel('water'));
  });

  it('not binds tighter than and, and tighter than or', () => {
    // (not protein) and water — not: not (protein and water)
    expect(sel('not protein and water')).toEqual([44, 45, 46, 47]);
    // protein or (water and hydrogen)
    expect(sel('protein or water and hydrogen')).toEqual([...range(0, 40), 45, 46, 60, 61, 62, 63]);
    // (water and hydrogen) or ion
    expect(sel('water and hydrogen or ion')).toEqual([45, 46, 48, 49]);
    expect(sel('not not protein')).toEqual(PROTEIN);
    expect(sel('not water or ion')).toEqual(sel('(not water) or ion'));
  });

  it('parentheses override precedence', () => {
    expect(sel('(protein or water) and hydrogen')).toEqual([5, 6, 7, 12, 45, 46]);
    expect(sel('not (protein or water)')).toEqual([41, 42, 43, 48, 49, ...range(50, 59)]);
    expect(sel('((chain A))')).toEqual(range(0, 28));
  });

  it('keyword arguments bind to a single term', () => {
    // (within 4 of HEM) and water
    expect(sel('within 4 of resname HEM and water')).toEqual([44, 45, 46]);
    expect(sel('within 4 of (resname HEM and name FE)')).toEqual([41, 42, 43, 44, 45, 46]);
    expect(sel('same residue as name FE or water')).toEqual([41, 42, 43, 44, 45, 46, 47]);
  });
});

describe('evaluateSelection: errors', () => {
  it('suggests keywords for typos (edit distance)', () => {
    expect(err('protien')).toBe("Unknown keyword 'protien' — did you mean 'protein'?");
    expect(err('backbon and chain A')).toBe("Unknown keyword 'backbon' — did you mean 'backbone'?");
    expect(err('chian A')).toBe("Unknown keyword 'chian' — did you mean 'chain'?");
    expect(err('resnam ALA')).toBe("Unknown keyword 'resnam' — did you mean 'resname'?");
    expect(err('witin 5 of ligand')).toBe("Unknown keyword 'witin' — did you mean 'within'?");
  });

  it('reports structural problems with the offending token', () => {
    expect(err('protein and')).toBe("Expected a selection after 'and'");
    expect(err('or water')).toMatch(/Unexpected 'or'/);
    expect(err('not')).toBe("Expected a selection after 'not'");
    expect(err('(protein or water')).toMatch(/Missing '\)'/);
    expect(err('protein)')).toBe("Unexpected ')' — no matching '('");
    expect(err('()')).toMatch(/Empty parentheses/);
    expect(err('protein water')).toBe("Unexpected 'water' — combine selections with 'and' / 'or'");
    expect(err('resname ALA protein')).toMatch(/Unexpected 'protein'/);
    expect(err('within of ligand')).toMatch(/Expected a distance in Å after 'within', got 'of'/);
    expect(err('within 5 ligand')).toMatch(/Expected 'of' after 'within 5', got 'ligand'/);
    expect(err('within 5 of')).toBe("Expected a selection after 'of'");
    expect(err('same foo as ligand')).toMatch(/Expected 'residue', 'chain' or 'fragment' after 'same', got 'foo'/);
    expect(err('same residue ligand')).toMatch(/Expected 'as' after 'same residue'/);
    expect(err('bonded ligand')).toMatch(/Expected 'to' after 'bonded'/);
    expect(err('resid abc')).toBe("Invalid residue number 'abc' after 'resid'");
    expect(err('resid')).toMatch(/'resid' needs at least one number/);
    expect(err('index 1.5')).toMatch(/Invalid atom index '1.5'/);
    expect(err('name')).toMatch(/'name' needs at least one value/);
    expect(err('chain and protein')).toMatch(/'chain' needs at least one value, got 'and'/);
    expect(err('element Qq')).toBe("Unknown element 'Qq' after 'element'");
    expect(err('bfactor >')).toMatch(/Expected a number after 'bfactor >'/);
    expect(err('> 5')).toMatch(/comparisons need a property/);
    expect(err('name "CA')).toMatch(/Missing closing quote/);
    expect(err('resid 1 to')).toMatch(/Expected a number after 'to'/);
    expect(err('of')).toMatch(/Unexpected 'of'/);
  });
});

describe('evaluateSelection: caching and performance', () => {
  it('returns independent masks for repeated queries', () => {
    const a = evaluateSelection(MOL, 'protein');
    a.mask.fill(0);
    const b = evaluateSelection(MOL, 'protein');
    expect(b.count).toBe(PROTEIN.length);
    expect(b.mask.reduce((s, v) => s + v, 0)).toBe(PROTEIN.length);
    expect(b.mask).not.toBe(a.mask);
  });

  it('evaluates per molecule object', () => {
    const other = buildMolecule('o', [{ element: 'C', x: 0, y: 0, z: 0 }]);
    expect(evaluateSelection(other, 'protein').count).toBe(0);
    expect(evaluateSelection(MOL, 'protein').count).toBe(PROTEIN.length);
  });

  it('handles long id lists and big molecules quickly', () => {
    const atoms: AtomInput[] = [];
    for (let i = 0; i < 100_000; i++) atoms.push({ element: i % 10 ? 'C' : 'H', x: (i % 50) * 1.5, y: (Math.floor(i / 50) % 40) * 1.5, z: Math.floor(i / 2000) * 1.5, resName: 'ALA', resSeq: Math.floor(i / 10), chain: 'A', name: i % 10 ? 'C' : 'H' });
    const big = buildMolecule('big', atoms);
    const ids = Array.from({ length: 5000 }, (_, k) => k * 3 + 1);
    const t0 = performance.now();
    const r = evaluateSelection(big, 'id ' + ids.join(' '));
    expect(r.count).toBe(5000);
    expect(evaluateSelection(big, 'index 10 to 50009').count).toBe(50000);
    expect(evaluateSelection(big, 'resid 0 to 99 and not hydrogen').count).toBe(900);
    expect(evaluateSelection(big, 'within 2 of index 0').count).toBe(4); // itself + 3 lattice neighbours at 1.5 Å
    expect(evaluateSelection(big, 'same residue as within 3 of index 50000').count).toBeGreaterThan(10);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('validateSelection', () => {
  it('accepts valid queries and plausible bare words', () => {
    for (const q of ['', 'protein', 'HEM', 'WAT', 'CA', 'within 5 of ligand and not water', 'resid 1 to 10', 'Zn']) expect(validateSelection(q)).toBeNull();
  });

  it('reports syntax errors and keyword-like typos', () => {
    expect(validateSelection('protein and')).toBe("Expected a selection after 'and'");
    expect(validateSelection('protien')).toBe("Unknown keyword 'protien' — did you mean 'protein'?");
    expect(validateSelection('ligand or watr')).toBe("Unknown keyword 'watr' — did you mean 'water'?");
  });
});

describe('maskToIds', () => {
  it('maps indices to atom ids', () => {
    const mask = new Uint8Array(N);
    mask[0] = 1;
    mask[63] = 1;
    expect(maskToIds(MOL, mask)).toEqual([MOL.atoms[0].id, MOL.atoms[63].id]);
  });
});

describe('selectionSuggestions', () => {
  it('suggests keywords for a partial word', () => {
    expect(selectionSuggestions(MOL, 'pro')[0]).toBe('protein');
    expect(selectionSuggestions(null, 'wit')).toContain('within');
    expect(selectionSuggestions(null, '').slice(0, 3)).toEqual(['protein', 'ligand', 'water']);
    expect(selectionSuggestions(MOL, 'protein and ba')).toEqual(expect.arrayContaining(['backbone', 'basic']));
  });

  it('suggests molecule values after value keywords', () => {
    expect(selectionSuggestions(MOL, 'chain ')).toEqual(['A', 'B', 'W', 'I', 'C', 'D']);
    expect(selectionSuggestions(MOL, 'chain A ')).toEqual(['B', 'W', 'I', 'C', 'D', 'and', 'or']);
    expect(selectionSuggestions(MOL, 'resname H')).toEqual(expect.arrayContaining(['HIS', 'HEM', 'HOH']));
    expect(selectionSuggestions(MOL, 'element ')[0]).toBe('C');
    expect(selectionSuggestions(MOL, 'name O')).toEqual(expect.arrayContaining(['OD1', "O5'"]));
    expect(selectionSuggestions(null, 'chain ')).toEqual([]);
  });

  it('suggests residue names of this molecule as bare words', () => {
    expect(selectionSuggestions(MOL, 'HE')).toContain('HEM');
  });

  it('suggests the next structural word', () => {
    expect(selectionSuggestions(MOL, 'within ')).toContain('5');
    expect(selectionSuggestions(MOL, 'within 5 ')).toEqual(['of']);
    expect(selectionSuggestions(MOL, 'within 5 of ')).toContain('ligand');
    expect(selectionSuggestions(MOL, 'same ')).toEqual(['residue', 'chain', 'fragment']);
    expect(selectionSuggestions(MOL, 'same residue ')).toEqual(['as']);
    expect(selectionSuggestions(MOL, 'bonded ')).toEqual(['to']);
    expect(selectionSuggestions(MOL, 'protein ')).toEqual(['and', 'or', 'and not']);
    expect(selectionSuggestions(MOL, '(protein or water) ')).toEqual(['and', 'or', 'and not']);
    expect(selectionSuggestions(MOL, 'resid 1 to ')).toEqual([]);
    expect(selectionSuggestions(MOL, 'bfactor ')).toContain('>');
  });
});

describe('selectionHelp', () => {
  it('documents every grammar keyword with a valid example', () => {
    const help = selectionHelp();
    const names = help.map((h) => h.keyword);
    for (const k of ['all', 'none', 'protein', 'nucleic', 'water', 'ion', 'ligand', 'hetero', 'organic', 'backbone', 'sidechain', 'hydrogen', 'heavy', 'helix', 'sheet', 'coil', 'acidic', 'basic', 'polar', 'hydrophobic', 'aromatic', 'charged', 'element', 'name', 'resname', 'resid', 'chain', 'index', 'id', 'serial', 'within', 'same', 'byres', 'bonded', 'selected', 'not', 'and', 'or'])
      expect(names).toContain(k);
    for (const h of help) {
      expect(h.description.length).toBeGreaterThan(3);
      expect(h.example.length).toBeGreaterThan(0);
      if (h.keyword !== 'bare word') expect(validateSelection(h.example)).toBeNull();
      expect(evaluateSelection(MOL, h.example).error).toBeUndefined();
    }
  });
});

describe('quickSelections', () => {
  it('offers only chips that are meaningful for the molecule', () => {
    const chips = quickSelections(MOL);
    const labels = chips.map((c) => c.label);
    expect(labels).toEqual([
      'Protein', 'Backbone', 'Side chains', 'Ligands', 'Water', 'Ions', 'Nucleic', 'Helix', 'Sheet', 'Hydrogens', 'Heavy atoms',
      'Chain A', 'Chain B', 'Chain W', 'Chain I', 'Chain C', 'Chain D', 'HEM',
    ]);
    for (const c of chips) {
      const r = evaluateSelection(MOL, c.query);
      expect(r.error).toBeUndefined();
      expect(r.count).toBeGreaterThan(0);
    }
  });

  it('small molecules get only atom-type chips', () => {
    const small = buildMolecule('m', [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'H', x: 1.09, y: 0, z: 0 },
    ]);
    expect(quickSelections(small).map((c) => c.label)).toEqual(['Hydrogens', 'Heavy atoms']);
    const noH = buildMolecule('m', [{ element: 'C', x: 0, y: 0, z: 0 }]);
    expect(quickSelections(noH)).toEqual([]);
  });

  it('quotes values that are not plain words', () => {
    expect(quoteSelectionValue('A')).toBe('A');
    expect(quoteSelectionValue('X')).toBe('X');
    expect(quoteSelectionValue('all')).toBe('"all"');
    expect(quoteSelectionValue('A B')).toBe('"A B"');
    const odd = buildMolecule('odd', [
      { element: 'C', x: 0, y: 0, z: 0, chain: 'all', resName: 'ALA', resSeq: 1 },
      { element: 'C', x: 9, y: 0, z: 0, chain: 'B', resName: 'ALA', resSeq: 1 },
    ]);
    const chip = quickSelections(odd).find((c) => c.label === 'Chain all')!;
    expect(chip.query).toBe('chain "all"');
    expect(evaluateSelection(odd, chip.query).count).toBe(1);
  });
});

describe('evaluateSelection across coordinate-only updates', () => {
  const idsOf = (mol: Molecule, idx: number[]) => idx.map((i) => mol.atoms[i].id);
  const HEM = [41, 42, 43];

  it('shares the selection index and structural results, recomputes coordinate-dependent ones', () => {
    const mol = buildFixture();
    const structural = ['protein', 'resname HEM', 'same residue as resname HOH', 'bonded to name CA', 'chain B and not hetero', 'bfactor > 40', 'serial 1000 to 1010', 'HEM'];
    const before = new Map(structural.map((q) => [q, sel(q, mol)]));
    expect(sel('within 4 of resname HEM', mol)).toEqual([41, 42, 43, 44, 45, 46]);
    expect(sel('exwithin 4 of resname HEM', mol)).toEqual([44, 45, 46]);
    expect(sel('x 99 to 101 and y < 1', mol)).toEqual([41]);
    // move the heme 50 Å away: a drag of the whole residue
    const moved = translateAtoms(mol, idsOf(mol, HEM), [0, 50, 0]);
    expect(selectionIndexIdentity(moved)).toBe(selectionIndexIdentity(mol));
    for (const q of structural) expect(sel(q, moved), q).toEqual(before.get(q));
    expect(sel('within 4 of resname HEM', moved)).toEqual(HEM);
    expect(sel('exwithin 4 of resname HEM', moved)).toEqual([]);
    expect(sel('same residue as within 4 of resname HEM', moved)).toEqual(HEM);
    expect(sel('not within 4 of resname HEM', mol)).not.toContain(44);
    expect(sel('not within 4 of resname HEM', moved)).toContain(44);
    expect(sel('y > 10', moved)).toEqual(HEM);
    expect(sel('x 99 to 101 and y < 1', moved)).toEqual([]);
    expect(sel('y 40 to 60', moved)).toEqual(HEM);
    expect(sel('protein or z == 0', moved).length).toBe(sel('protein or z == 0', mol).length);
    // …and the original molecule still answers for its own coordinates
    expect(sel('within 4 of resname HEM', mol)).toEqual([41, 42, 43, 44, 45, 46]);
    expect(sel('y > 10', mol)).toEqual([]);
    // drag frames: each frame from the same base
    for (let f = 1; f <= 5; f++) {
      const frame = setPositions(mol, new Map([[mol.atoms[44].id, [100 + f, 0, 0]]]));
      expect(selectionIndexIdentity(frame)).toBe(selectionIndexIdentity(mol));
      expect(sel('x < 102 and resname HOH', frame)).toEqual(f < 2 ? [44] : []);
      expect(sel('water', frame)).toEqual([44, 45, 46, 47]);
    }
  });

  it('structural changes rebuild the index and results', () => {
    const mol = buildFixture();
    expect(sel('element N', mol)).toContain(0);
    const changed = setElement(mol, [mol.atoms[1].id], 'N'); // CA of ALA 1 → N
    expect(selectionIndexIdentity(changed)).not.toBe(selectionIndexIdentity(mol));
    expect(sel('element N', changed)).toContain(1);
    expect(sel('element N', mol)).not.toContain(1);
    const atoms = mol.atoms.slice();
    atoms[44] = { ...atoms[44], resName: 'LIG', bfactor: 0 };
    const renamed = { ...mol, atoms };
    expect(sel('resname LIG', renamed)).toEqual([44]);
    expect(sel('resname LIG', mol)).toEqual([]);
    expect(sel('bfactor < 1', renamed)).toEqual([0, 44]);
    const ss = mol.atoms.map((a, i) => (i === 13 ? { ...a, ss: 'sheet' as const } : a));
    expect(sel('sheet', { ...mol, atoms: ss })).toContain(13);
    expect(sel('sheet', mol)).not.toContain(13);
  });
});
