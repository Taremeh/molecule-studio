import { describe, expect, it } from 'vitest';
import {
  IDEAL_ANGLES,
  POLAR_BOND_LENGTHS,
  RESONANCE_BOND_LENGTHS,
  angle,
  applyMat3,
  connectedComponent,
  dihedral,
  distance,
  dot,
  fragmentSide,
  geometryFromOrders,
  idealBondLength,
  idealBondLengthInMolecule,
  measureAtoms,
  normalize,
  openValenceDirections,
  resonanceBondLength,
  resonanceEquivalents,
  rotationBetween,
  smallerSide,
  sub,
  suggestNewAtomPosition,
} from './geometry';
import { mk, ringAtoms, ringBonds, type AtomSpec, type BondSpec } from './chem-fixtures';
import { addAtom } from './edit';
import type { Molecule, Vec3 } from './types';

const P = (mol: Molecule, id: number): Vec3 => {
  const a = mol.atoms.find((x) => x.id === id)!;
  return [a.x, a.y, a.z];
};
const angleDeg = (u: Vec3, v: Vec3) => (Math.acos(Math.max(-1, Math.min(1, dot(normalize(u), normalize(v))))) * 180) / Math.PI;

describe('vector helpers', () => {
  it('angle / dihedral / rotationBetween', () => {
    expect(angle([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 10);
    expect(dihedral([1, 0, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1])).toBeCloseTo(90, 10);
    expect(dihedral([1, 0, 0], [0, 0, 0], [0, 0, 1], [-1, 0, 1])).toBeCloseTo(180, 10);
    for (const [f, t] of [
      [[1, 0, 0], [0, 1, 0]],
      [[1, 0, 0], [-1, 0, 0]],
      [[0.3, -0.2, 0.9], [-0.5, 0.5, 0.1]],
    ] as [Vec3, Vec3][]) {
      const r = applyMat3(rotationBetween(f, t), normalize(f));
      const nt = normalize(t);
      for (let k = 0; k < 3; k++) expect(r[k]).toBeCloseTo(nt[k], 10);
    }
  });
});

describe('measureAtoms', () => {
  const mol = mk('m', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['C', 1.5, 1.5, 0], ['C', 1.5, 1.5, 1.5]]);
  it('measures distance, angle, dihedral', () => {
    expect(measureAtoms(mol, [1, 2])).toBeCloseTo(1.5, 12);
    expect(measureAtoms(mol, [1, 2, 3])).toBeCloseTo(90, 10);
    expect(Math.abs(measureAtoms(mol, [1, 2, 3, 4]))).toBeCloseTo(90, 10);
  });
  it('returns NaN for missing atoms or wrong counts', () => {
    expect(measureAtoms(mol, [1, 99])).toBeNaN();
    expect(measureAtoms(mol, [1])).toBeNaN();
    expect(measureAtoms(mol, [1, 2, 3, 4, 1])).toBeNaN();
  });
});

describe('idealBondLength', () => {
  it('matches typical experimental lengths', () => {
    expect(idealBondLength('C', 'C', 1)).toBeCloseTo(1.52, 2);
    expect(idealBondLength('C', 'C', 2)).toBeCloseTo(1.32, 1);
    expect(idealBondLength('C', 'C', 3)).toBeCloseTo(1.19, 1);
    expect(idealBondLength('C', 'C', 1.5)).toBeCloseTo(1.41, 1);
    expect(idealBondLength('C', 'O', 1)).toBeCloseTo(1.42, 2);
    expect(idealBondLength('C', 'O', 2)).toBeCloseTo(1.24, 1);
    expect(idealBondLength('C', 'H')).toBe(1.09);
    expect(idealBondLength('H', 'O')).toBe(0.96);
    expect(idealBondLength('N', 'H')).toBe(1.01);
  });

  it('uses experimental lengths for polar bonds of second-row elements (same table as the minimiser)', () => {
    // Summed covalent radii are ~0.1 Å too long here (rP + rO = 1.73 Å vs 1.60 Å in phosphates).
    const cases: [string, string, 1 | 2, number][] = [
      ['P', 'O', 1, 1.6],
      ['O', 'P', 2, 1.48],
      ['S', 'O', 1, 1.58],
      ['S', 'O', 2, 1.44],
      ['S', 'N', 1, 1.63],
      ['P', 'N', 1, 1.67],
      ['P', 'F', 1, 1.56],
      ['F', 'S', 1, 1.56],
      ['Si', 'O', 1, 1.64],
      ['O', 'O', 1, 1.47],
    ];
    for (const [a, b, order, len] of cases) {
      expect(idealBondLength(a, b, order)).toBe(len);
      expect(idealBondLength(b, a, order)).toBe(len);
    }
    // Order 1.5 of a table pair: its explicit 1.5 entry (delocalised terminal P–O of phosphates,
    // S–O of sulfonates / sulfates, aromatic S(II)–N), else the mean of its single and double
    // lengths. (The radius rule gave P–O(1.5) = 1.609 Å, longer than the 1.60 Å single bond; the mean
    // then gave 1.540 / 1.510 Å, exactly on the P=O / S=O perception cut-offs.)
    expect(idealBondLength('P', 'O', 1.5)).toBe(1.52);
    expect(idealBondLength('O', 'S', 1.5)).toBe(1.47);
    expect(idealBondLength('S', 'N', 1.5)).toBe(1.62);
    expect(idealBondLength('N', 'P', 1.5)).toBeCloseTo((1.67 + 1.57) / 2, 10);
    // Pairs outside the table keep the covalent-radius rule.
    expect(idealBondLength('C', 'S', 1)).toBeCloseTo(1.81, 2);
    expect(idealBondLength('C', 'C', 1.5)).toBeCloseTo(1.52 * 0.93, 2);
  });

  it('orders single > aromatic > double > triple for every pair in the polar table', () => {
    for (const key of Object.keys(POLAR_BOND_LENGTHS)) {
      const [a, b] = key.split('-');
      const l1 = idealBondLength(a, b, 1);
      const l15 = idealBondLength(a, b, 1.5);
      const l2 = idealBondLength(a, b, 2);
      const l3 = idealBondLength(a, b, 3);
      expect(l15, key).toBeLessThan(l1);
      expect(l15, key).toBeGreaterThan(l2);
      expect(l15, key).toBeCloseTo(POLAR_BOND_LENGTHS[key][1.5] ?? (l1 + l2) / 2, 10);
      expect(l3, key).toBeLessThan(l2);
      expect(idealBondLength(b, a, 1.5)).toBe(l15);
    }
  });

  it('keeps order-1.5 P–O / S–O / S–N lengths clear of the bond-order perception cut-offs', () => {
    // core/structure-bondorders.ts reads an XYZ / PDB ligand bond as double when it is no longer
    // than halfway between its reference double and single lengths: O–P 1.48 / 1.60 → 1.54,
    // O–S 1.43 / 1.58 → 1.505, N–S 1.54 / 1.68 → 1.61 Å. A minimised 'ar' phosphate / sulfonate
    // must be read back with its P=O / S=O (shorter than the cut-off) and an aromatic S(II)–N as
    // single (longer); the old mean values sat exactly on the cut-offs (P–O 1.540, S–O 1.510).
    const MARGIN = 0.015;
    expect(idealBondLength('P', 'O', 1.5)).toBeLessThan(1.54 - MARGIN);
    expect(idealBondLength('S', 'O', 1.5)).toBeLessThan(1.505 - MARGIN);
    expect(idealBondLength('S', 'N', 1.5)).toBeGreaterThan(1.61);
    // Experimental ranges: PO₄ / phosphate monoester P–O 1.51–1.53, sulfonate / sulfate S–O
    // 1.45–1.48, isothiazole / thiadiazole S–N 1.61–1.65 Å.
    expect(idealBondLength('P', 'O', 1.5)).toBeGreaterThanOrEqual(1.51);
    expect(idealBondLength('P', 'O', 1.5)).toBeLessThanOrEqual(1.53);
    expect(idealBondLength('S', 'O', 1.5)).toBeGreaterThanOrEqual(1.45);
    expect(idealBondLength('S', 'O', 1.5)).toBeLessThanOrEqual(1.48);
    expect(idealBondLength('S', 'N', 1.5)).toBeGreaterThanOrEqual(1.61);
    expect(idealBondLength('S', 'N', 1.5)).toBeLessThanOrEqual(1.65);
  });
});

describe('resonance-delocalised terminal groups', () => {
  // Benzoate-like C(=O)O⁻ on a methyl carbon, nitro, carbonate, CO2, acetic acid, MOL2-style carboxylate.
  const acetate = mk('acetate', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['O', 2.1, 1.1, 0], ['O', 2.1, -1.1, 0, -1]], [[0, 1], [1, 2, 2], [1, 3]]);
  const nitro = mk('nitromethane', [['C', 0, 0, 0], ['N', 1.5, 0, 0, 1], ['O', 2.1, 1.1, 0], ['O', 2.1, -1.1, 0, -1]], [[0, 1], [1, 2, 2], [1, 3]]);
  const carbonate = mk(
    'carbonate',
    [['C', 0, 0, 0], ['O', 1.29, 0, 0], ['O', -0.645, 1.117, 0, -1], ['O', -0.645, -1.117, 0, -1]],
    [[0, 1, 2], [0, 2], [0, 3]],
  );
  const co2 = mk('co2', [['C', 0, 0, 0], ['O', 1.16, 0, 0], ['O', -1.16, 0, 0]], [[0, 1, 2], [0, 2, 2]]);
  const acid = mk('acetic acid', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['O', 2.1, 1.1, 0], ['O', 2.1, -1.1, 0], ['H', 3.0, -1.1, 0]], [[0, 1], [1, 2, 2], [1, 3], [3, 4]]);
  const mol2Style = mk('acetate (ar)', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['O', 2.1, 1.1, 0], ['O', 2.1, -1.1, 0]], [[0, 1], [1, 2, 1.5], [1, 3, 1.5]]);

  it('tabulated lengths: carboxylate 1.255, nitro 1.22, carbonate 1.29, nitrate 1.25 Å', () => {
    expect(RESONANCE_BOND_LENGTHS['C-O'][2]).toBe(1.255);
    expect(resonanceBondLength('C', 'O')).toBe(1.255);
    expect(resonanceBondLength('O', 'C', 2)).toBe(1.255);
    expect(resonanceBondLength('N', 'O')).toBe(1.22);
    expect(resonanceBondLength('C', 'O', 3)).toBe(1.29);
    expect(resonanceBondLength('O', 'N', 3)).toBe(1.25);
    // between the Kekulé double and single bonds, and shorter than the aromatic (ring) length
    for (const [a, b] of [['C', 'O'], ['N', 'O']]) {
      expect(resonanceBondLength(a, b)).toBeGreaterThan(idealBondLength(a, b, 2));
      expect(resonanceBondLength(a, b)).toBeLessThan(idealBondLength(a, b, 1.5));
    }
    // no entry: aromatic length
    expect(resonanceBondLength('C', 'S')).toBe(idealBondLength('C', 'S', 1.5));
  });

  it('resonanceEquivalents recognises carboxylate, nitro, carbonate and 1.5-bond carboxylates only', () => {
    // indices: 1 = centre, 2 / 3 = terminal O
    expect(resonanceEquivalents(acetate, 1, 2)).toBe(2);
    expect(resonanceEquivalents(acetate, 3, 1)).toBe(2);
    expect(resonanceEquivalents(acetate, 0, 1)).toBe(0); // C–C
    expect(resonanceEquivalents(nitro, 1, 2)).toBe(2);
    expect(resonanceEquivalents(nitro, 1, 3)).toBe(2);
    expect(resonanceEquivalents(carbonate, 0, 1)).toBe(3);
    expect(resonanceEquivalents(carbonate, 0, 3)).toBe(3);
    expect(resonanceEquivalents(co2, 0, 1)).toBe(0); // two C=O, no anion
    expect(resonanceEquivalents(acid, 1, 2)).toBe(0); // O–H is not terminal
    expect(resonanceEquivalents(mol2Style, 1, 2)).toBe(2);
  });

  it('idealBondLengthInMolecule gives the resonance length for both Kekulé bonds, idealBondLength otherwise', () => {
    // ids = index + 1
    expect(idealBondLengthInMolecule(acetate, 2, 3)).toBe(1.255);
    expect(idealBondLengthInMolecule(acetate, 2, 4)).toBe(1.255);
    expect(idealBondLengthInMolecule(acetate, 1, 2)).toBe(idealBondLength('C', 'C', 1));
    expect(idealBondLengthInMolecule(nitro, 2, 4)).toBe(1.22);
    expect(idealBondLengthInMolecule(mol2Style, 2, 3)).toBe(1.255);
    expect(idealBondLengthInMolecule(acid, 2, 3)).toBe(idealBondLength('C', 'O', 2));
    expect(idealBondLengthInMolecule(acid, 2, 4)).toBe(idealBondLength('C', 'O', 1));
    expect(idealBondLengthInMolecule(co2, 1, 2)).toBe(idealBondLength('C', 'O', 2));
    // explicit order; non-bonded pair; missing atom
    expect(idealBondLengthInMolecule(acetate, 2, 3, 3)).toBe(idealBondLength('C', 'O', 3));
    expect(idealBondLengthInMolecule(acetate, 3, 4)).toBe(idealBondLength('O', 'O', 1));
    expect(idealBondLengthInMolecule(acetate, 1, 99)).toBeNaN();
  });

  it('resonanceEquivalents edge cases: nitrate, nitrate ester, bicarbonate, mixed O/S, coordinated O, edits', () => {
    // indices: 0 = centre unless noted
    const nitrate = mk('nitrate', [['N', 0, 0, 0, 1], ['O', 1.25, 0, 0], ['O', -0.62, 1.08, 0, -1], ['O', -0.62, -1.08, 0, -1]], [[0, 1, 2], [0, 2], [0, 3]]);
    expect(resonanceEquivalents(nitrate, 0, 2)).toBe(3);
    expect(idealBondLengthInMolecule(nitrate, 1, 2)).toBe(1.25);
    // methyl nitrate: the two terminal O share the delocalisation, the ester O does not
    const ester = mk('methyl nitrate', [['N', 0, 0, 0, 1], ['O', 1.22, 0, 0], ['O', -0.6, 1.06, 0, -1], ['O', -0.7, -1.2, 0], ['C', 0, -2.4, 0]], [[0, 1, 2], [0, 2], [0, 3], [3, 4]]);
    expect(resonanceEquivalents(ester, 0, 1)).toBe(2);
    expect(resonanceEquivalents(ester, 0, 3)).toBe(0);
    // bicarbonate HO–C(=O)O⁻: C=O / C–O⁻ delocalised, C–OH not
    const bicarb = mk('bicarbonate', [['C', 0, 0, 0], ['O', 1.25, 0, 0], ['O', -0.63, 1.1, 0, -1], ['O', -0.68, -1.18, 0], ['H', -0.2, -1.95, 0]], [[0, 1, 2], [0, 2], [0, 3], [3, 4]]);
    expect(resonanceEquivalents(bicarb, 0, 1)).toBe(2);
    expect(resonanceEquivalents(bicarb, 0, 3)).toBe(0);
    // thioacetate C(=O)S⁻: different terminal elements are not counted as equivalent
    const thio = mk('thioacetate', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['O', 2.1, 1.1, 0], ['S', 2.4, -1.4, 0, -1]], [[0, 1], [1, 2, 2], [1, 3]]);
    expect(resonanceEquivalents(thio, 1, 2)).toBe(0);
    expect(resonanceEquivalents(thio, 1, 3)).toBe(0);
    // carboxylate O⁻ bonded to a metal is not terminal: no resonance pair left
    const zn = mk('zn acetate', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['O', 2.1, 1.1, 0], ['O', 2.1, -1.1, 0, -1], ['Zn', 3.5, -2, 0]], [[0, 1], [1, 2, 2], [1, 3], [3, 4]]);
    expect(resonanceEquivalents(zn, 1, 2)).toBe(0);
    expect(resonanceEquivalents(zn, 1, 3)).toBe(0);
    // a charge edit (new molecule object, same bonds array) is seen at once: no stale structure data
    const neutral: Molecule = { ...acetate, atoms: acetate.atoms.map((a) => (a.charge ? { ...a, charge: 0 } : a)) };
    expect(neutral.bonds).toBe(acetate.bonds);
    expect(resonanceEquivalents(acetate, 1, 3)).toBe(2);
    expect(resonanceEquivalents(neutral, 1, 3)).toBe(0);
    expect(idealBondLengthInMolecule(neutral, 2, 4)).toBe(idealBondLength('C', 'O', 1));
    // a bond-order edit (C=O → C≡O) drops the group as well
    const triple: Molecule = { ...acetate, bonds: acetate.bonds.map((b) => (b.order === 2 ? { ...b, order: 3 as const } : b)) };
    expect(resonanceEquivalents(triple, 1, 3)).toBe(0);
    // out-of-range indices are harmless
    expect(resonanceEquivalents(acetate, 1, 99)).toBe(0);
  });
});

describe('geometryFromOrders', () => {
  it('derives hybridisation including the prospective bond', () => {
    expect(geometryFromOrders([1, 1, 1, 1])).toBe('tetrahedral');
    expect(geometryFromOrders([2, 1])).toBe('trigonal');
    expect(geometryFromOrders([1.5, 1.5, 1])).toBe('trigonal');
    expect(geometryFromOrders([3, 1])).toBe('linear');
    expect(geometryFromOrders([2, 2])).toBe('linear');
    expect(IDEAL_ANGLES.tetrahedral).toBeCloseTo(109.4712, 4);
  });
});

describe('suggestNewAtomPosition', () => {
  // Ethane-like C–C skeleton without hydrogens.
  const cc = mk('cc', [['C', 0, 0, 0], ['C', 1.52, 0, 0]], [[0, 1]]);

  it('sp3: ~109.5° to the existing neighbour, ideal bond length', () => {
    const p = suggestNewAtomPosition(cc, 2, 'C', 1);
    expect(angle(P(cc, 1), P(cc, 2), p)).toBeCloseTo(109.47, 1);
    expect(distance(P(cc, 2), p)).toBeCloseTo(1.52, 6);
  });

  it('sp2 for a new double bond: 120°', () => {
    const p = suggestNewAtomPosition(cc, 2, 'O', 2);
    expect(Math.abs(angle(P(cc, 1), P(cc, 2), p) - 120)).toBeLessThan(1);
    expect(distance(P(cc, 2), p)).toBeCloseTo(idealBondLength('C', 'O', 2), 6);
  });

  it('linear for a new triple bond: 180°', () => {
    const p = suggestNewAtomPosition(cc, 2, 'N', 3);
    expect(Math.abs(angle(P(cc, 1), P(cc, 2), p) - 180)).toBeLessThan(1);
  });

  it('linear when the anchor already has a triple bond', () => {
    const yne = mk('yne', [['C', 0, 0, 0], ['C', 1.2, 0, 0]], [[0, 1, 3]]);
    const p = suggestNewAtomPosition(yne, 2, 'C', 1);
    expect(angle(P(yne, 1), P(yne, 2), p)).toBeCloseTo(180, 6);
  });

  it('zero neighbours: along preferDir, else +x', () => {
    const c = mk('c', [['C', 1, 2, 3]]);
    const p = suggestNewAtomPosition(c, 1, 'C');
    expect(p[0]).toBeCloseTo(2.52, 6);
    expect(p[1]).toBeCloseTo(2, 6);
    const q = suggestNewAtomPosition(c, 1, 'C', 1, [0, 0, 2]);
    expect(q[2]).toBeCloseTo(4.52, 6);
  });

  it('grows chains as anti zig-zags (dihedral 180°)', () => {
    let mol = cc;
    let prev = [1, 2];
    for (let k = 0; k < 4; k++) {
      const p = suggestNewAtomPosition(mol, prev[1], 'C', 1, [0, 0, 1]);
      const r = addAtom(mol, 'C', p, { bondTo: prev[1] });
      mol = r.mol;
      prev = [prev[1], r.atomId];
    }
    // all consecutive dihedrals anti, all angles tetrahedral
    for (let i = 1; i + 3 <= 6; i++) {
      expect(Math.abs(measureAtoms(mol, [i, i + 1, i + 2, i + 3]))).toBeCloseTo(180, 6);
      expect(measureAtoms(mol, [i, i + 1, i + 2])).toBeCloseTo(109.47, 1);
    }
  });

  it('keeps sp2 systems coplanar (butadiene-like growth)', () => {
    // C1=C2 with a substituent on C1 (in the xy plane); add C3 to C2 with a double bond on C2 → plane kept.
    const mol = mk('vinyl', [['C', 0, 0, 0], ['C', 1.34, 0, 0], ['C', -0.67, 1.16, 0]], [[0, 1, 2], [0, 2]]);
    const p = suggestNewAtomPosition(mol, 2, 'C', 1);
    expect(p[2]).toBeCloseTo(0, 6);
    expect(angle(P(mol, 1), P(mol, 2), p)).toBeCloseTo(120, 6);
    expect(Math.abs(dihedral(P(mol, 3), P(mol, 1), P(mol, 2), p))).toBeCloseTo(180, 6); // trans
  });

  it('two neighbours: sp3 picks the tetrahedral site closer to preferDir; sp2 opposite the bisector', () => {
    const t = IDEAL_ANGLES.tetrahedral * (Math.PI / 180);
    // propane-like centre at origin, neighbours in the xy plane at the tetrahedral angle
    const mol = mk('c3', [['C', 0, 0, 0], ['C', 1.52, 0, 0], ['C', 1.52 * Math.cos(t), 1.52 * Math.sin(t), 0]], [[0, 1], [0, 2]]);
    const up = suggestNewAtomPosition(mol, 1, 'H', 1, [0, 0, 1]);
    const down = suggestNewAtomPosition(mol, 1, 'H', 1, [0, 0, -1]);
    expect(up[2]).toBeGreaterThan(0);
    expect(down[2]).toBeLessThan(0);
    for (const p of [up, down]) {
      expect(angle(P(mol, 2), [0, 0, 0], p)).toBeCloseTo(109.47, 1);
      expect(angle(P(mol, 3), [0, 0, 0], p)).toBeCloseTo(109.47, 1);
      expect(distance([0, 0, 0], p)).toBeCloseTo(1.09, 6);
    }
    expect(angle(up, [0, 0, 0], down)).toBeCloseTo(109.47, 1);

    const sp2 = mk('sp2', [['C', 0, 0, 0], ['C', 1.34, 0, 0], ['C', -0.75, 1.3, 0]], [[0, 1, 2], [0, 2]]);
    const q = suggestNewAtomPosition(sp2, 1, 'C', 1);
    expect(q[2]).toBeCloseTo(0, 6);
    expect(angle(P(sp2, 2), [0, 0, 0], q)).toBeCloseTo(angle(P(sp2, 3), [0, 0, 0], q), 6);
  });

  it('three neighbours: opposite the sum of bond vectors', () => {
    const d: Vec3[] = [
      [1, 1, 1],
      [-1, -1, 1],
      [-1, 1, -1],
    ];
    const mol = mk('c4', [['C', 0, 0, 0], ...d.map((v) => ['C', ...normalize(v).map((x) => x * 1.52)] as AtomSpec)], [[0, 1], [0, 2], [0, 3]]);
    const p = suggestNewAtomPosition(mol, 1, 'C');
    const n = normalize(p);
    const ex = normalize([1, -1, -1]);
    for (let k = 0; k < 3; k++) expect(n[k]).toBeCloseTo(ex[k], 6);
  });

  it('avoids a clash by choosing another staggered position', () => {
    // C1–C2 with an H on C1; the anti position on C2 is blocked by a stray atom.
    const base = mk('c2h', [['C', 0, 0, 0], ['C', 1.52, 0, 0], ['H', -0.36, 1.03, 0]], [[0, 1], [0, 2]]);
    const anti = suggestNewAtomPosition(base, 2, 'C');
    const blocked = mk(
      'blocked',
      [...base.atoms.map((a) => [a.element, a.x, a.y, a.z] as AtomSpec), ['O', anti[0], anti[1], anti[2]]],
      [[0, 1], [0, 2]],
    );
    const p = suggestNewAtomPosition(blocked, 2, 'C');
    expect(distance(p, anti)).toBeGreaterThan(1);
    expect(angle(P(blocked, 1), P(blocked, 2), p)).toBeCloseTo(109.47, 1);
  });
});

describe('openValenceDirections', () => {
  it('bare carbon → 4 tetrahedral directions', () => {
    const dirs = openValenceDirections(mk('c', [['C', 0, 0, 0]]), 1);
    expect(dirs).toHaveLength(4);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(angleDeg(dirs[i], dirs[j])).toBeCloseTo(109.4712, 3);
  });

  it('terminal =CH2 carbon → 2 directions coplanar with the double bond partner substituents', () => {
    const mol = mk('vinyl', [['C', 0, 0, 0], ['C', 1.34, 0, 0], ['C', -0.67, 1.16, 0], ['H', -0.6, -0.9, 0]], [[0, 1, 2], [0, 2], [0, 3]]);
    const dirs = openValenceDirections(mol, 2);
    expect(dirs).toHaveLength(2);
    for (const d of dirs) {
      expect(d[2]).toBeCloseTo(0, 6);
      expect(angleDeg(d, [-1, 0, 0])).toBeCloseTo(120, 6);
    }
    expect(angleDeg(dirs[0], dirs[1])).toBeCloseTo(120, 6);
  });

  it('respects an explicit count and returns [] for unknown atoms / saturated atoms', () => {
    const c = mk('c', [['C', 0, 0, 0]]);
    expect(openValenceDirections(c, 1, 2)).toHaveLength(2);
    expect(openValenceDirections(c, 7)).toEqual([]);
    expect(openValenceDirections(mk('fe', [['Fe', 0, 0, 0]]), 1)).toEqual([]);
  });

  it('aromatic CH position lies in the ring plane, bisecting outwards', () => {
    const mol = mk('c6', ringAtoms(Array(6).fill('C'), 1.39), ringBonds(6, 1.5));
    const [d] = openValenceDirections(mol, 1);
    const c: Vec3 = P(mol, 1);
    const n = normalize(c);
    for (let k = 0; k < 3; k++) expect(d[k]).toBeCloseTo(n[k], 6);
  });
});

describe('fragmentSide / smallerSide / connectedComponent', () => {
  // butane C1–C2–C3–C4 plus a separate atom
  const butane = mk('butane', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['C', 2, 1.4, 0], ['C', 3.5, 1.4, 0], ['C', 3, 1, 0], ['O', 9, 9, 9]], [[0, 1], [1, 2], [2, 3], [2, 4]]);

  it('returns the atoms beyond the bond', () => {
    expect([...fragmentSide(butane, 2, 3)].sort()).toEqual([3, 4, 5]);
    expect([...fragmentSide(butane, 3, 2)].sort()).toEqual([1, 2]);
    expect([...fragmentSide(butane, 3, 4)]).toEqual([4]);
    expect(fragmentSide(butane, 1, 99).size).toBe(0);
  });

  it('returns only b for ring bonds', () => {
    const ring: BondSpec[] = ringBonds(6);
    const mol = mk('cyclohexane', ringAtoms(Array(6).fill('C'), 1.5), ring);
    expect([...fragmentSide(mol, 1, 2)]).toEqual([2]);
  });

  it('smallerSide picks the smaller rigid side (ties → b)', () => {
    expect(smallerSide(butane, 3, 2)).toEqual({ side: 'b', atoms: new Set([1, 2]) });
    expect(smallerSide(butane, 2, 3)!.side).toBe('a'); // C1–C2 side (2 atoms) < C3 side (3 atoms)
    expect([...smallerSide(butane, 2, 3)!.atoms].sort()).toEqual([1, 2]);
    expect(smallerSide(butane, 3, 4)).toEqual({ side: 'b', atoms: new Set([4]) });
    expect(smallerSide(butane, 1, 3)).toBeNull(); // not bonded
    const ring = mk('c3', ringAtoms(['C', 'C', 'C'], 1), ringBonds(3));
    expect(smallerSide(ring, 1, 2)).toBeNull();
  });

  it('connectedComponent', () => {
    expect([...connectedComponent(butane, 1)].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...connectedComponent(butane, 6)]).toEqual([6]);
    expect(connectedComponent(butane, 99).size).toBe(0);
  });
});

describe('directions are unit vectors', () => {
  it('for several environments', () => {
    const mols = [
      mk('a', [['N', 0, 0, 0], ['C', 1.47, 0, 0]], [[0, 1]]),
      mk('b', [['O', 0, 0, 0], ['C', 1.4, 0, 0], ['C', -0.5, 1.3, 0]], [[0, 1], [0, 2]]),
    ];
    for (const m of mols) for (const d of openValenceDirections(m, 1)) expect(Math.hypot(...d)).toBeCloseTo(1, 10);
    expect(sub([1, 1, 1], [1, 1, 1])).toEqual([0, 0, 0]);
  });
});
