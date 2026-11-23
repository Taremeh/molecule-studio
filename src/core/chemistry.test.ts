import { describe, expect, it } from 'vitest';
import {
  allowedValences,
  analyzeValence,
  canAcceptBond,
  canAddBond,
  effectiveValence,
  findRings,
  isAtomInRing,
  isBondInRing,
  molecularFormula,
  molecularMass,
  moleculeSummary,
  netCharge,
  ringBondMask,
  shouldShowUnderValence,
  valenceOf,
} from './chemistry';
import { addBond, removeBonds, setBondOrder, setCharge, setElement, setPositions, translateAtoms } from './edit';
import { benzene, caffeine, fiveRing, mk, radialHydrogens, ringAtoms, ringBonds, type AtomSpec, type BondSpec } from './chem-fixtures';
import { buildMolecule, bondBetween } from './molecule';
import type { Molecule } from './types';

const TET = [
  [0.629, 0.629, 0.629],
  [-0.629, -0.629, 0.629],
  [-0.629, 0.629, -0.629],
  [0.629, -0.629, -0.629],
] as const;

function methane(nH = 4, center = 'C', charge?: number): Molecule {
  const atoms: AtomSpec[] = [[center, 0, 0, 0, charge]];
  const bonds: BondSpec[] = [];
  for (let i = 0; i < nH; i++) {
    const d = TET[i % 4];
    atoms.push(['H', d[0] * (1 + Math.floor(i / 4)), d[1], d[2]]);
    bonds.push([0, i + 1]);
  }
  return mk('XHn', atoms, bonds);
}

function statusOf(mol: Molecule, index: number) {
  return valenceOf(mol, mol.atoms[index].id)!;
}

describe('allowedValences (charge rules)', () => {
  it('uses neutral valences for charge 0', () => {
    expect(allowedValences('C')).toEqual([4]);
    expect(allowedValences('S')).toEqual([2, 4, 6]);
    expect(allowedValences('P', 0)).toEqual([3, 5]);
  });
  it('applies isoelectronic octet rules for charged atoms', () => {
    expect(allowedValences('N', 1)).toEqual([4]);
    expect(allowedValences('N', -1)).toEqual([2]);
    expect(allowedValences('O', 1)).toEqual([3]);
    expect(allowedValences('O', -1)).toEqual([1]);
    expect(allowedValences('O', -2)).toEqual([0]);
    expect(allowedValences('S', 1)).toEqual([3]);
    expect(allowedValences('S', -1)).toEqual([1]);
    expect(allowedValences('C', 1)).toEqual([3]);
    expect(allowedValences('C', -1)).toEqual([3]);
    expect(allowedValences('B', -1)).toEqual([4]);
    expect(allowedValences('H', 1)).toEqual([0]);
    expect(allowedValences('H', -1)).toEqual([0]);
    expect(allowedValences('Cl', 1)).toEqual([2]);
    expect(allowedValences('Cl', -1)).toEqual([0]);
    expect(allowedValences('P', 1)).toEqual([4]);
    expect(allowedValences('P', -1)).toEqual([2, 4, 6]); // PF6−
    expect(allowedValences('N', -1)).toEqual([2]); // period 2: no hypervalence
  });
  it('does not check metals, noble gases or unknown atoms', () => {
    expect(allowedValences('Fe')).toEqual([]);
    expect(allowedValences('Fe', 2)).toEqual([]);
    expect(allowedValences('Na', 1)).toEqual([]);
    expect(allowedValences('Xe')).toEqual([]);
    expect(allowedValences('X')).toEqual([]);
  });
});

describe('effectiveValence (aromatic rule)', () => {
  it('handles the documented aromatic cases', () => {
    expect(effectiveValence([1.5, 1.5, 1], [4])).toBe(4); // benzene C–H
    expect(effectiveValence([1.5, 1.5], [3])).toBe(3); // pyridine N
    expect(effectiveValence([1.5, 1.5, 1], [3])).toBe(3); // pyrrole N–H
    expect(effectiveValence([1.5, 1.5], [2])).toBe(2); // furan O
    expect(effectiveValence([1.5, 1.5, 1.5], [4])).toBe(4); // naphthalene fusion C
    expect(effectiveValence([1.5, 1.5, 2], [4])).toBe(4); // aromatic C=O (2-pyridone, caffeine)
    expect(effectiveValence([1.5, 1], [4])).toBe(3); // single aromatic bond rounds up (1.5 → 2)
    expect(effectiveValence([1.5, 1.5, 1, 1], [4])).toBe(5); // >3 σ bonds: not an sp2 ring atom
    expect(effectiveValence([2, 1, 1], [4])).toBe(4);
  });
});

describe('analyzeValence', () => {
  it('methane is ok, CH3 radical and bare C are under-valent', () => {
    const ch4 = methane();
    expect(statusOf(ch4, 0)).toMatchObject({ status: 'ok', bondOrderSum: 4, openValence: 0, allowed: [4] });
    for (let i = 1; i <= 4; i++) expect(statusOf(ch4, i).status).toBe('ok');
    const ch3 = methane(3);
    expect(statusOf(ch3, 0)).toMatchObject({ status: 'under', bondOrderSum: 3, openValence: 1 });
    expect(statusOf(ch3, 0).message).toContain('1 open valence');
    const c = methane(0);
    expect(statusOf(c, 0)).toMatchObject({ status: 'under', openValence: 4 });
  });

  it('flags a pentavalent carbon as over-valent with a readable message', () => {
    const ch5 = methane(5);
    const v = statusOf(ch5, 0);
    expect(v.status).toBe('over');
    expect(v.bondOrderSum).toBe(5);
    expect(v.openValence).toBe(0);
    expect(v.message).toBe('C has 5 bonds (max 4)');
  });

  it('ethylene carbons are ok; a double bond counts 2', () => {
    const mol = mk(
      'ethylene',
      [['C', 0, 0, 0], ['C', 1.33, 0, 0], ['H', -0.5, 0.9, 0], ['H', -0.5, -0.9, 0], ['H', 1.8, 0.9, 0], ['H', 1.8, -0.9, 0]],
      [[0, 1, 2], [0, 2], [0, 3], [1, 4], [1, 5]],
    );
    expect(statusOf(mol, 0)).toMatchObject({ status: 'ok', bondOrderSum: 4 });
    expect(statusOf(mol, 1)).toMatchObject({ status: 'ok', bondOrderSum: 4 });
    // without one H: under by one
    const vinyl = mk('vinyl', mol.atoms.slice(0, 5).map((a) => [a.element, a.x, a.y, a.z] as AtomSpec), [[0, 1, 2], [0, 2], [0, 3], [1, 4]]);
    expect(statusOf(vinyl, 1)).toMatchObject({ status: 'under', openValence: 1 });
  });

  it('aromatic benzene is ok; without hydrogens each carbon has one open valence', () => {
    const bz = benzene();
    for (let i = 0; i < 12; i++) expect(statusOf(bz, i).status).toBe('ok');
    expect(statusOf(bz, 0).bondOrderSum).toBe(4);
    const bare = mk('c6', ringAtoms(Array(6).fill('C'), 1.39), ringBonds(6, 1.5));
    for (let i = 0; i < 6; i++) expect(statusOf(bare, i)).toMatchObject({ status: 'under', openValence: 1, bondOrderSum: 3 });
  });

  it('pyridine N, pyrrole N–H, furan O, thiophene S are ok', () => {
    const ring = ringAtoms(['N', 'C', 'C', 'C', 'C', 'C'], 1.39);
    const h = radialHydrogens(ring, [1, 2, 3, 4, 5]);
    const pyridine = mk('pyridine', h.atoms, [...ringBonds(6, 1.5), ...h.bonds]);
    expect(statusOf(pyridine, 0)).toMatchObject({ status: 'ok', bondOrderSum: 3 });
    for (let i = 1; i < 6; i++) expect(statusOf(pyridine, i).status).toBe('ok');

    const pyrrole = fiveRing('pyrrole', ['N', 'C', 'C', 'C', 'C'], [0, 1, 2, 3, 4]);
    expect(statusOf(pyrrole, 0)).toMatchObject({ status: 'ok', bondOrderSum: 3 });
    for (let i = 1; i < 5; i++) expect(statusOf(pyrrole, i)).toMatchObject({ status: 'ok', bondOrderSum: 4 });

    const furan = fiveRing('furan', ['O', 'C', 'C', 'C', 'C'], [1, 2, 3, 4]);
    expect(statusOf(furan, 0)).toMatchObject({ status: 'ok', bondOrderSum: 2 });
    const thiophene = fiveRing('thiophene', ['S', 'C', 'C', 'C', 'C'], [1, 2, 3, 4]);
    expect(statusOf(thiophene, 0)).toMatchObject({ status: 'ok', bondOrderSum: 2 });
  });

  it('pyridinium N+ (with H) is ok', () => {
    const ring = ringAtoms(['N', 'C', 'C', 'C', 'C', 'C'], 1.39);
    ring[0] = ['N', ring[0][1], ring[0][2], 0, 1];
    const h = radialHydrogens(ring, [0, 1, 2, 3, 4, 5]);
    const mol = mk('pyridinium', h.atoms, [...ringBonds(6, 1.5), ...h.bonds]);
    expect(statusOf(mol, 0)).toMatchObject({ status: 'ok', allowed: [4], bondOrderSum: 4 });
  });

  it('naphthalene fusion carbons are ok', () => {
    // Two hexagons sharing the bond 0–1 (atoms 0 and 1 are the fusion carbons).
    const atoms: AtomSpec[] = [
      ['C', 0, 0.7, 0], ['C', 0, -0.7, 0],
      ['C', 1.21, -1.4, 0], ['C', 2.42, -0.7, 0], ['C', 2.42, 0.7, 0], ['C', 1.21, 1.4, 0],
      ['C', -1.21, -1.4, 0], ['C', -2.42, -0.7, 0], ['C', -2.42, 0.7, 0], ['C', -1.21, 1.4, 0],
    ];
    const bonds: BondSpec[] = [[0, 1, 1.5], [1, 2, 1.5], [2, 3, 1.5], [3, 4, 1.5], [4, 5, 1.5], [5, 0, 1.5], [1, 6, 1.5], [6, 7, 1.5], [7, 8, 1.5], [8, 9, 1.5], [9, 0, 1.5]];
    for (const c of [2, 3, 4, 5, 6, 7, 8, 9]) {
      atoms.push(['H', atoms[c][1] * 1.4, atoms[c][2] * 1.4, 0]);
      bonds.push([c, atoms.length - 1]);
    }
    const mol = mk('naphthalene', atoms, bonds);
    expect(statusOf(mol, 0)).toMatchObject({ status: 'ok', bondOrderSum: 4 });
    expect(statusOf(mol, 1)).toMatchObject({ status: 'ok', bondOrderSum: 4 });
    for (let i = 2; i < 10; i++) expect(statusOf(mol, i).status).toBe('ok');
    expect(molecularFormula(mol)).toBe('C10H8');
  });

  it('benzene carbon with two substituents is over-valent', () => {
    const bz = benzene();
    const extra = buildMolecule(
      'x',
      [...bz.atoms.map(({ id: _id, ...a }) => a), { element: 'H', x: 1.39, y: 0, z: 1.1 }],
      [...bz.bonds.map((b) => ({ a: b.a - 1, b: b.b - 1, order: b.order })), { a: 0, b: 12 }],
    );
    expect(statusOf(extra, 0).status).toBe('over');
  });

  it('ammonium N+ and carboxylate O− are ok', () => {
    const nh4 = methane(4, 'N', 1);
    expect(statusOf(nh4, 0)).toMatchObject({ status: 'ok', allowed: [4], bondOrderSum: 4 });
    const nh3 = methane(3, 'N');
    expect(statusOf(nh3, 0).status).toBe('ok');
    expect(statusOf(methane(4, 'N'), 0).status).toBe('over');

    // Acetate CH3–C(=O)–O−
    const acetate = mk(
      'acetate',
      [['C', 0, 0, 0], ['C', 1.52, 0, 0], ['O', 2.1, 1.1, 0], ['O', 2.1, -1.1, 0, -1], ['H', -0.4, 1, 0], ['H', -0.4, -0.5, 0.9], ['H', -0.4, -0.5, -0.9]],
      [[0, 1], [1, 2, 2], [1, 3], [0, 4], [0, 5], [0, 6]],
    );
    for (let i = 0; i < acetate.atoms.length; i++) expect(statusOf(acetate, i).status).toBe('ok');
    expect(statusOf(acetate, 3)).toMatchObject({ allowed: [1], bondOrderSum: 1 });
    expect(netCharge(acetate)).toBe(-1);
  });

  it('leaves metals unchecked and treats metal bonds as optional (dative)', () => {
    // [Co(NH3)6]: Co bonded to six NH3 (each N with 3 H).
    const atoms: AtomSpec[] = [['Co', 0, 0, 0, 3]];
    const bonds: BondSpec[] = [];
    const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [x, y, z] of axes) {
      atoms.push(['N', 2 * x, 2 * y, 2 * z]);
      const n = atoms.length - 1;
      bonds.push([0, n]);
      for (let k = 0; k < 3; k++) {
        atoms.push(['H', 2.4 * x + 0.3 * k, 2.4 * y + 0.3, 2.4 * z]);
        bonds.push([n, atoms.length - 1]);
      }
    }
    const mol = mk('hexaammine', atoms, bonds);
    expect(statusOf(mol, 0)).toMatchObject({ status: 'unchecked', allowed: [], openValence: 0 });
    expect(statusOf(mol, 1)).toMatchObject({ status: 'ok', bondOrderSum: 3 });
    // A carboxylate-like O (neutral, one C) bound to Zn counts the metal bond when needed.
    const zn = mk('zn', [['Zn', 0, 0, 0], ['O', 2, 0, 0], ['C', 3.3, 0, 0]], [[0, 1], [1, 2]]);
    expect(statusOf(zn, 1)).toMatchObject({ status: 'ok', bondOrderSum: 2 });
  });

  it('reports hypervalent states: S with 3 bonds is under (next allowed 4), SF6 is ok', () => {
    const s3 = mk('s3', [['S', 0, 0, 0], ['F', 1.6, 0, 0], ['F', -1.6, 0, 0], ['F', 0, 1.6, 0]], [[0, 1], [0, 2], [0, 3]]);
    expect(statusOf(s3, 0)).toMatchObject({ status: 'under', openValence: 1 });
    const sf6Atoms: AtomSpec[] = [['S', 0, 0, 0]];
    const sf6Bonds: BondSpec[] = [];
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      sf6Atoms.push(['F', 1.56 * x, 1.56 * y, 1.56 * z]);
      sf6Bonds.push([0, sf6Atoms.length - 1]);
    }
    expect(statusOf(mk('sf6', sf6Atoms, sf6Bonds), 0)).toMatchObject({ status: 'ok', bondOrderSum: 6 });
    // PF6− is ok thanks to the P− rule.
    const pf6 = mk('pf6', [['P', 0, 0, 0, -1], ...sf6Atoms.slice(1)], sf6Bonds);
    expect(statusOf(pf6, 0).status).toBe('ok');
  });

  it('treats atoms of ion residues as unchecked', () => {
    const mol = buildMolecule('ions', [{ element: 'Cl', x: 0, y: 0, z: 0, resName: 'CL', resSeq: 1, chain: 'A', hetero: true }]);
    expect(statusOf(mol, 0).status).toBe('unchecked');
  });

  it('is cached per molecule object', () => {
    const mol = methane();
    expect(analyzeValence(mol)).toBe(analyzeValence(mol));
  });
});

describe('formula, mass, charge, summary', () => {
  it('caffeine is C8H10N4O2 with M ≈ 194.19 g/mol', () => {
    const mol = caffeine();
    expect(molecularFormula(mol)).toBe('C8H10N4O2');
    expect(molecularMass(mol)).toBeCloseTo(194.19, 2);
    for (const v of analyzeValence(mol).values()) expect(v.status).toBe('ok');
  });

  it('uses Hill order (alphabetical without carbon)', () => {
    expect(molecularFormula(mk('w', [['O', 0, 0, 0], ['H', 1, 0, 0], ['H', 0, 1, 0]]))).toBe('H2O');
    expect(molecularFormula(mk('s', [['Na', 0, 0, 0], ['Cl', 3, 0, 0]]))).toBe('ClNa');
    expect(molecularFormula(mk('a', [['S', 0, 0, 0], ['O', 1, 0, 0], ['O', 2, 0, 0], ['O', 3, 0, 0], ['O', 4, 0, 0], ['H', 5, 0, 0], ['H', 6, 0, 0]]))).toBe(
      'H2O4S',
    );
    expect(molecularFormula(mk('e', [['Br', 0, 0, 0], ['C', 1, 0, 0], ['H', 2, 0, 0], ['N', 3, 0, 0], ['Cl', 4, 0, 0]]))).toBe('CHBrClN');
    expect(molecularFormula(mk('empty', []))).toBe('');
  });

  it('supports subsets of atoms (duplicates and unknown ids ignored)', () => {
    const mol = methane();
    expect(molecularFormula(mol, [1, 2, 2, 999])).toBe('CH');
    expect(molecularMass(mol, [1])).toBeCloseTo(12.011, 6);
    expect(molecularMass(mol)).toBeCloseTo(16.043, 3);
  });

  it('moleculeSummary aggregates counts and valence errors', () => {
    const s = moleculeSummary(methane(5));
    expect(s).toMatchObject({ atoms: 6, heavyAtoms: 1, hydrogens: 5, bonds: 5, residues: 0, chains: 0, formula: 'CH5', charge: 0, valenceErrors: 1 });
    expect(s.mass).toBeCloseTo(12.011 + 5 * 1.008, 6);
  });
});

describe('canAddBond / canAcceptBond', () => {
  const two = (nh = 3) => {
    // Two CH(nh) groups 1.5 Å apart (no bond between them).
    const atoms: AtomSpec[] = [['C', 0, 0, 0], ['C', 1.5, 0, 0]];
    const bonds: BondSpec[] = [];
    for (let k = 0; k < nh; k++) {
      atoms.push(['H', -0.5, Math.cos(k * 2.1), Math.sin(k * 2.1)]);
      bonds.push([0, atoms.length - 1]);
      atoms.push(['H', 2.0, Math.cos(k * 2.1), Math.sin(k * 2.1)]);
      bonds.push([1, atoms.length - 1]);
    }
    return mk('two', atoms, bonds);
  };

  it('rejects self bonds, missing atoms and far atoms', () => {
    const mol = two();
    expect(canAddBond(mol, 1, 1, 1)).toEqual({ ok: false, reason: 'Cannot bond an atom to itself' });
    expect(canAddBond(mol, 1, 99, 1).ok).toBe(false);
    const far = mk('far', [['C', 0, 0, 0], ['C', 5, 0, 0]]);
    const r = canAddBond(far, 1, 2, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('too far apart');
  });

  it('accepts bonds between methyl radicals but not between saturated carbons', () => {
    expect(canAddBond(two(3), 1, 2, 1)).toEqual({ ok: true });
    const sat = canAddBond(two(4 - 0), 1, 2, 1);
    expect(sat.ok).toBe(false);
    expect(sat.reason).toBe('C would have valence 5 (max 4)');
    // …unless hydrogens may be replaced (auto-hydrogens editing)
    expect(canAddBond(two(4), 1, 2, 1, { hydrogensRemovable: true }).ok).toBe(true);
    // double bond between two CH3 radicals → each C would be 5
    expect(canAddBond(two(3), 1, 2, 2).ok).toBe(false);
    expect(canAddBond(two(2), 1, 2, 2).ok).toBe(true);
  });

  it('counts only the difference when upgrading an existing bond', () => {
    // Ethane-like CH2–CH2 (each C has 2 H + the C–C bond): single → double is fine, → triple is not.
    const mol = mk(
      'c2h4',
      [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['H', -0.5, 0.9, 0], ['H', -0.5, -0.9, 0], ['H', 2, 0.9, 0], ['H', 2, -0.9, 0]],
      [[0, 1], [0, 2], [0, 3], [1, 4], [1, 5]],
    );
    expect(canAddBond(mol, 1, 2, 2).ok).toBe(true);
    expect(canAddBond(mol, 1, 2, 3).ok).toBe(false);
    expect(canAddBond(mol, 1, 2, 1).ok).toBe(true); // unchanged order
    expect(bondBetween(mol, 1, 2)?.order).toBe(1);
  });

  it('never fails for metal partners', () => {
    const mol = mk('m', [['N', 0, 0, 0], ['H', 1, 0, 0], ['H', 0, 1, 0], ['H', 0, 0, 1], ['Zn', -2, 0, 0]], [[0, 1], [0, 2], [0, 3]]);
    expect(canAddBond(mol, 1, 5, 1).ok).toBe(true);
  });

  it('canAcceptBond', () => {
    expect(canAcceptBond(methane(3), 1, 1).ok).toBe(true);
    expect(canAcceptBond(methane(3), 1, 2).ok).toBe(false);
    const full = canAcceptBond(methane(4), 1, 1);
    expect(full.ok).toBe(false);
    expect(full.reason).toContain('max 4');
    expect(canAcceptBond(methane(4), 1, 1, { hydrogensRemovable: true }).ok).toBe(true);
    expect(canAcceptBond(methane(4), 42, 1).ok).toBe(false);
    expect(canAcceptBond(mk('fe', [['Fe', 0, 0, 0]]), 1, 3).ok).toBe(true);
  });
});

describe('shouldShowUnderValence', () => {
  it('follows the documented policy', () => {
    expect(shouldShowUnderValence(methane())).toBe(true); // has H
    expect(shouldShowUnderValence(mk('c', [['C', 0, 0, 0]]))).toBe(true); // small, no residues
    const atoms = Array.from({ length: 40 }, (_, i) => ({ element: 'C', x: i, y: 0, z: 0, resName: 'ALA', resSeq: i, chain: 'A' }));
    const protein = buildMolecule('p', atoms, [], { source: 'pdb' });
    expect(shouldShowUnderValence(protein)).toBe(false);
    expect(shouldShowUnderValence({ ...protein, meta: { source: 'editor' } })).toBe(true);
    const big = buildMolecule('big', Array.from({ length: 40 }, (_, i) => ({ element: 'C', x: i, y: 0, z: 0 })));
    expect(shouldShowUnderValence(big)).toBe(false);
  });
});

describe('rings', () => {
  const ringsBySize = (mol: Molecule) => findRings(mol).map((r) => r.length).sort((a, b) => a - b);
  const expectRingOrder = (mol: Molecule) => {
    for (const r of findRings(mol)) {
      for (let i = 0; i < r.length; i++) expect(bondBetween(mol, r[i], r[(i + 1) % r.length])).toBeDefined();
      expect(new Set(r).size).toBe(r.length);
    }
  };

  it('benzene: one 6-ring; ring bonds vs. C–H', () => {
    const bz = benzene();
    expect(ringsBySize(bz)).toEqual([6]);
    expectRingOrder(bz);
    expect(isBondInRing(bz, 1, 2)).toBe(true);
    expect(isBondInRing(bz, 1, 7)).toBe(false);
    expect(isBondInRing(bz, 1, 4)).toBe(false); // not bonded
    expect(isAtomInRing(bz, 1)).toBe(true);
    expect(isAtomInRing(bz, 7)).toBe(false);
    expect(findRings(bz)).toBe(findRings(bz)); // cached
  });

  it('acyclic molecules have no rings', () => {
    const chain = mk('chain', Array.from({ length: 10 }, (_, i) => ['C', i * 1.5, 0, 0] as AtomSpec), Array.from({ length: 9 }, (_, i) => [i, i + 1] as BondSpec));
    expect(findRings(chain)).toEqual([]);
    expect(isBondInRing(chain, 3, 4)).toBe(false);
  });

  it('naphthalene: two 6-rings (not the 10-ring)', () => {
    const atoms: AtomSpec[] = Array.from({ length: 10 }, (_, i) => ['C', i, 0, 0]);
    const bonds: BondSpec[] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 6], [6, 7], [7, 8], [8, 9], [9, 0]];
    const mol = mk('naph', atoms, bonds);
    expect(ringsBySize(mol)).toEqual([6, 6]);
    expectRingOrder(mol);
  });

  it('spiro, bridged and cage systems', () => {
    // spiro[4.4]nonane: atom 0 shared.
    const spiro = mk('spiro', Array.from({ length: 9 }, (_, i) => ['C', i, 0, 0] as AtomSpec), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [0, 5], [5, 6], [6, 7], [7, 8], [8, 0]]);
    expect(ringsBySize(spiro)).toEqual([5, 5]);
    // norbornane (bicyclo[2.2.1]heptane): bridgeheads 0 and 3.
    const norb = mk('norbornane', Array.from({ length: 7 }, (_, i) => ['C', i, 0, 0] as AtomSpec), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 6], [6, 3]]);
    expect(ringsBySize(norb)).toEqual([5, 5]);
    expectRingOrder(norb);
    // cubane: 8 vertices, 12 edges → 5 independent 4-rings.
    const cube: BondSpec[] = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const cubane = mk('cubane', Array.from({ length: 8 }, (_, i) => ['C', i, 0, 0] as AtomSpec), cube);
    expect(ringsBySize(cubane)).toEqual([4, 4, 4, 4, 4]);
    expectRingOrder(cubane);
    // adamantane: 10 C, 12 bonds → 3 six-rings.
    const ad: BondSpec[] = [[0, 4], [0, 5], [0, 6], [1, 4], [1, 7], [1, 8], [2, 5], [2, 7], [2, 9], [3, 6], [3, 8], [3, 9]];
    const adamantane = mk('adamantane', Array.from({ length: 10 }, (_, i) => ['C', i, 0, 0] as AtomSpec), ad);
    expect(ringsBySize(adamantane)).toEqual([6, 6, 6]);
    expectRingOrder(adamantane);
  });

  it('two separate ring systems joined by a chain (biphenyl-like)', () => {
    const a = ringAtoms(Array(6).fill('C'), 1.39);
    const b = ringAtoms(Array(6).fill('C'), 1.39, 5, 0);
    const mol = mk('biphenyl', [...a, ...b], [...ringBonds(6, 1.5), ...ringBonds(6, 1.5, 6), [0, 9]]);
    expect(ringsBySize(mol)).toEqual([6, 6]);
    expect(isBondInRing(mol, 1, 10)).toBe(false);
  });

  it('finds every hexagon of a large honeycomb sheet quickly', () => {
    // Graphene-like flake: hexagonal lattice of R×C hexagons built from a brick-wall graph.
    const R = 20;
    const C = 20;
    const rows = R + 1;
    const cols = 2 * C + 2;
    const idx = (r: number, c: number) => r * cols + c;
    const atoms: AtomSpec[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) atoms.push(['C', c, r, 0]);
    const bonds: BondSpec[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c + 1 < cols; c++) bonds.push([idx(r, c), idx(r, c + 1)]);
    // Vertical rungs alternate between rows to form hexagons (brick wall).
    for (let r = 0; r + 1 < rows; r++) for (let c = r % 2; c < cols; c += 2) bonds.push([idx(r, c), idx(r + 1, c)]);
    const mol = mk('honeycomb', atoms, bonds);
    const t0 = performance.now();
    const rings = findRings(mol);
    const ms = performance.now() - t0;
    // Cyclomatic number of the (connected) lattice.
    expect(rings.length).toBe(bonds.length - atoms.length + 1);
    expect(rings.every((r) => r.length === 6)).toBe(true);
    expect(ms).toBeLessThan(3000);
  });
});

describe('coordinate-independent caches across coordinate-only updates', () => {
  /** Acetate-like ion with a benzene ring: C, H, O−, aromatic bonds. */
  function sample(): Molecule {
    const ring = ringAtoms(['C', 'C', 'C', 'C', 'C', 'C'], 1.39);
    const h = radialHydrogens(ring, [1, 2, 3, 4, 5]);
    const atoms: AtomSpec[] = [...h.atoms, ['C', 2.9, 0, 0], ['O', 3.5, 1.1, 0], ['O', 3.5, -1.1, 0, -1]];
    const c = atoms.length - 3;
    const bonds: BondSpec[] = [...ringBonds(6, 1.5), ...h.bonds, [0, c], [c, c + 1, 2], [c, c + 2]];
    return mk('sample', atoms, bonds);
  }

  it('analyzeValence / moleculeSummary / rings are reused while only coordinates change', () => {
    const mol = sample();
    const val = analyzeValence(mol);
    const sum = moleculeSummary(mol);
    const rings = findRings(mol);
    const mask = ringBondMask(mol);
    expect([...val.values()].every((v) => v.status === 'ok')).toBe(true);
    let frame = mol;
    for (let f = 1; f <= 5; f++) {
      frame = translateAtoms(mol, [1, 7], [0.2 * f, 0.1, 0]);
      expect(analyzeValence(frame)).toBe(val);
      expect(moleculeSummary(frame)).toBe(sum);
      expect(findRings(frame)).toBe(rings);
      expect(ringBondMask(frame)).toBe(mask);
    }
    const all = translateAtoms(mol, mol.atoms.map((a) => a.id), [5, 5, 5]);
    expect(analyzeValence(all)).toBe(val);
    expect(analyzeValence(setPositions(frame, new Map([[3, [9, 9, 9]]])))).toBe(val);
  });

  it('a charge change recomputes valence and summary', () => {
    const mol = sample();
    const val = analyzeValence(mol);
    const o = mol.atoms[mol.atoms.length - 1]; // O−
    const neutral = setCharge(mol, o.id, 0);
    const v2 = analyzeValence(neutral);
    expect(v2).not.toBe(val);
    expect(v2.get(o.id)!.status).toBe('under');
    expect(val.get(o.id)!.status).toBe('ok');
    expect(moleculeSummary(neutral).charge).toBe(0);
    expect(moleculeSummary(mol).charge).toBe(-1);
  });

  it('an element change recomputes valence, formula and summary', () => {
    const mol = sample();
    const val = analyzeValence(mol);
    const sum = moleculeSummary(mol);
    const h = mol.atoms[6]; // first ring H
    const cl = setElement(mol, [h.id], 'Cl');
    expect(analyzeValence(cl)).not.toBe(val);
    expect(analyzeValence(cl).get(h.id)!.element).toBe('Cl');
    expect(moleculeSummary(cl)).not.toBe(sum);
    expect(moleculeSummary(cl).formula).toBe('C7H4ClO2');
    expect(sum.formula).toBe('C7H5O2');
  });

  it('bond order and endpoint changes recompute valence and rings', () => {
    const mol = sample();
    const val = analyzeValence(mol);
    const rings = findRings(mol);
    const c = mol.atoms.length - 3;
    const co = mol.bonds.find((b) => b.a === mol.atoms[c].id && b.b === mol.atoms[c + 1].id)!;
    const single = setBondOrder(mol, co.id, 1);
    expect(analyzeValence(single)).not.toBe(val);
    expect(analyzeValence(single).get(mol.atoms[c].id)!.status).toBe('under');
    expect(moleculeSummary(single).valenceErrors).toBe(0);
    const triple = setBondOrder(mol, co.id, 3);
    expect(analyzeValence(triple).get(mol.atoms[c].id)!.status).toBe('over');
    expect(moleculeSummary(triple).valenceErrors).toBeGreaterThan(0);
    // break the ring: a bond's endpoints change
    const ringBond = mol.bonds[0];
    const opened = removeBonds(mol, [ringBond.id]);
    expect(findRings(opened)).toEqual([]);
    expect(findRings(mol)).toBe(rings);
    const rewired = { ...mol, bonds: mol.bonds.map((b) => (b === ringBond ? { ...b, b: mol.atoms[c + 2].id } : b)) };
    expect(analyzeValence(rewired)).not.toBe(val);
    expect(findRings(rewired)).not.toBe(rings);
    expect(isBondInRing(rewired, ringBond.a, ringBond.b)).toBe(false);
    // a new bond between existing atoms
    const bonded = addBond(mol, mol.atoms[6].id, mol.atoms[7].id).mol;
    expect(analyzeValence(bonded).get(mol.atoms[6].id)!.status).toBe('over');
  });
});
