/**
 * Rest lengths of delocalised terminal groups (carboxylate, nitro …) in the force field, and the
 * export → re-import round trip that depends on them.
 */
import { describe, expect, it } from 'vitest';
import type { Molecule } from './types';
import { getTopology } from './molecule';
import { mk } from './chem-fixtures';
import { idealBondLength, idealBondLengthInMolecule, resonanceBondLength } from './geometry';
import { perceiveTyping, restLength } from './ff-model';
import { analyzeValence } from './chemistry';
import { createForceField, minimize } from './minimize';
import { moleculeFromSmiles } from './smiles';
import { prepareMolecule } from './prepare';
import { parseMolecule, writeMolecule } from '../io/formats';

const len = (mol: Molecule, i: number, j: number) => {
  const A = mol.atoms[i], B = mol.atoms[j];
  return Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
};

/** The terminal O atoms of the first C/N centre carrying ≥ 2 of them, with bond orders and lengths. */
function terminalGroup(mol: Molecule, centreElement: 'C' | 'N') {
  const topo = getTopology(mol);
  for (let c = 0; c < mol.atoms.length; c++) {
    if (mol.atoms[c].element !== centreElement) continue;
    const terms = topo.neighbors[c]
      .map((x, k) => ({ x, bond: mol.bonds[topo.atomBonds[c][k]] }))
      .filter(({ x }) => mol.atoms[x].element === 'O' && topo.neighbors[x].length === 1);
    if (terms.length < 2) continue;
    return {
      centre: c,
      orders: terms.map((t) => t.bond.order).sort(),
      lengths: terms.map((t) => len(mol, c, t.x)),
      charges: terms.map((t) => mol.atoms[t.x].charge ?? 0).sort(),
      centreCharge: mol.atoms[c].charge ?? 0,
      /** Index of the terminal O doubly bonded to the centre (−1 if none). */
      doubleO: terms.find((t) => t.bond.order === 2)?.x ?? -1,
    };
  }
  throw new Error(`no ${centreElement}O2 group`);
}

const status = (mol: Molecule, index: number) => analyzeValence(mol).get(mol.atoms[index].id)?.status;
const valenceProblems = (mol: Molecule) =>
  [...analyzeValence(mol).values()].filter((v) => v.status === 'under' || v.status === 'over').map((v) => `${v.element}${v.atomId}:${v.status}`);

/**
 * C=O perception threshold of the bond-order perception for XYZ / PDB ligands: halfway between its
 * reference C=O (1.21 Å) and C–O (1.43 Å) lengths (core/structure-bondorders.ts); N=O: 1.21 / 1.40.
 */
const CO_DOUBLE_THRESHOLD = 1.32;
const NO_DOUBLE_THRESHOLD = 1.305;

describe('restLength of delocalised and order-1.5 polar bonds', () => {
  it('carboxylate / nitro bonds (Kekulé or 1.5) use the resonance length, as the inspector does', () => {
    const cases = [
      // [molecule, centre index, terminal indices, expected length]
      [mk('acetate', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['O', 2.1, 1.1, 0], ['O', 2.1, -1.1, 0, -1]], [[0, 1], [1, 2, 2], [1, 3]]), 1.255],
      [mk('acetate (ar)', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['O', 2.1, 1.1, 0], ['O', 2.1, -1.1, 0]], [[0, 1], [1, 2, 1.5], [1, 3, 1.5]]), 1.255],
      [mk('nitromethane', [['C', 0, 0, 0], ['N', 1.5, 0, 0, 1], ['O', 2.1, 1.1, 0], ['O', 2.1, -1.1, 0, -1]], [[0, 1], [1, 2, 2], [1, 3]]), 1.22],
    ] as const;
    for (const [m, expected] of cases) {
      const t = perceiveTyping(m);
      for (const term of [2, 3]) {
        const order = m.bonds.find((b) => b.b === term + 1)!.order;
        const r0 = restLength(m, t, 1, term, order);
        expect(r0, m.name).toBeCloseTo(expected, 6);
        expect(r0, m.name).toBe(resonanceBondLength(m.atoms[1].element, 'O'));
        expect(idealBondLengthInMolecule(m, 2, term + 1), m.name).toBe(r0);
      }
    }
  });

  it('local relaxation (region typing) builds the same resonance rest lengths', () => {
    // benzoate plus 25 waters: moving only the carboxylate triggers region-limited typing
    const mol = moleculeFromSmiles('c1ccccc1C(=O)[O-]' + '.O'.repeat(25));
    const g = terminalGroup(mol, 'C');
    const topo = getTopology(mol);
    const ids = [g.centre, ...topo.neighbors[g.centre]].map((i) => mol.atoms[i].id);
    expect(ids.length * 20).toBeLessThan(mol.atoms.length);
    const ctx = createForceField(mol, { movable: new Set(ids) });
    const r0 = (i: number, j: number) => {
      for (let b = 0; b < ctx.model.bondCount; b++)
        if ((ctx.model.bI[b] === i && ctx.model.bJ[b] === j) || (ctx.model.bI[b] === j && ctx.model.bJ[b] === i)) return ctx.model.bR0[b];
      return NaN;
    };
    for (const o of topo.neighbors[g.centre]) if (mol.atoms[o].element === 'O') expect(r0(g.centre, o)).toBeCloseTo(1.255, 6);
  });

  it('order-1.5 P–O / S–O rest lengths lie between single and double (idealBondLength)', () => {
    // MOL2-style phosphate / sulfonate with aromatic terminal bonds
    const m = mk(
      'ar oxyanions',
      [['P', 0, 0, 0], ['O', 1.5, 0, 0], ['O', -1.5, 0, 0], ['S', 5, 0, 0], ['O', 6.5, 0, 0], ['O', 3.5, 0, 0]],
      [[0, 1, 1.5], [0, 2, 1.5], [3, 4, 1.5], [3, 5, 1.5]],
    );
    const t = perceiveTyping(m);
    expect(restLength(m, t, 0, 1, 1.5)).toBeCloseTo(idealBondLength('P', 'O', 1.5), 6);
    expect(restLength(m, t, 3, 4, 1.5)).toBeCloseTo(idealBondLength('S', 'O', 1.5), 6);
    expect(restLength(m, t, 0, 1, 1.5)).toBeLessThan(idealBondLength('P', 'O', 1));
    expect(restLength(m, t, 0, 1, 1.5)).toBeGreaterThan(idealBondLength('P', 'O', 2));
    expect(restLength(m, t, 3, 4, 1.5)).toBeLessThan(idealBondLength('S', 'O', 1));
    expect(restLength(m, t, 3, 4, 1.5)).toBeGreaterThan(idealBondLength('S', 'O', 2));
  });
});

describe('delocalised terminal groups after minimisation', () => {
  it('carboxylate C–O bonds relax to ≈ 1.255 Å, well below the C=O perception threshold', () => {
    const m = minimize(moleculeFromSmiles('c1ccccc1C(=O)[O-]')).mol;
    const g = terminalGroup(m, 'C');
    for (const d of g.lengths) {
      expect(d).toBeGreaterThan(1.23);
      expect(d).toBeLessThan(1.28);
      expect(d).toBeLessThan(CO_DOUBLE_THRESHOLD - 0.03);
    }
    expect(Math.abs(g.lengths[0] - g.lengths[1])).toBeLessThan(0.01); // equivalent by resonance
  });

  it('nitro N–O bonds relax to ≈ 1.22 Å', () => {
    const m = minimize(moleculeFromSmiles('c1ccccc1[N+](=O)[O-]')).mol;
    const g = terminalGroup(m, 'N');
    for (const d of g.lengths) {
      expect(d).toBeGreaterThan(1.2);
      expect(d).toBeLessThan(1.24);
      expect(d).toBeLessThan(NO_DOUBLE_THRESHOLD - 0.05);
    }
  });
});

describe('export → re-import keeps carboxylate / nitro bond orders', () => {
  const roundTrip = (mol: Molecule, format: 'xyz' | 'pdb') => prepareMolecule(parseMolecule(writeMolecule(mol, format), format, 'rt'));

  const benzoate = minimize(moleculeFromSmiles('c1ccccc1C(=O)[O-]')).mol;
  const nitrobenzene = minimize(moleculeFromSmiles('c1ccccc1[N+](=O)[O-]')).mol;

  it('PDB (charges kept): one C=O, one C–O⁻, no valence problems', () => {
    const back = roundTrip(benzoate, 'pdb');
    const g = terminalGroup(back, 'C');
    expect(g.orders).toEqual([1, 2]);
    expect(g.charges).toEqual([-1, 0]);
    expect(status(back, g.centre)).toBe('ok');
    expect(valenceProblems(back)).toEqual([]);
  });

  it('XYZ (no charges in the format): one C=O and a saturated carboxyl carbon', () => {
    const back = roundTrip(benzoate, 'xyz');
    const g = terminalGroup(back, 'C');
    expect(g.orders).toEqual([1, 2]);
    expect(status(back, g.centre)).toBe('ok');
    expect(status(back, g.doubleO)).toBe('ok');
    // The single-bonded O cannot get its −1 back: XYZ stores no charges and the bond-order
    // perception only assigns charges to nitro groups.
  });

  for (const format of ['pdb', 'xyz'] as const) {
    it(`${format.toUpperCase()}: nitro comes back as N⁺(=O)O⁻ with exact valences`, () => {
      const back = roundTrip(nitrobenzene, format);
      const g = terminalGroup(back, 'N');
      expect(g.orders).toEqual([1, 2]);
      expect(g.charges).toEqual([-1, 0]);
      expect(g.centreCharge).toBe(1);
      expect(valenceProblems(back)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Order-1.5 polar bonds (MOL2 'ar' phosphate / sulfonate) and aromatic S(II)–N ring bonds
// ---------------------------------------------------------------------------------------------

/** Minimal MOL2 text: atoms [name, SYBYL type, x, y, z], bonds [1-based a, b, type]. */
function mol2Text(name: string, atoms: [string, string, number, number, number][], bonds: [number, number, string][]): string {
  let s = `@<TRIPOS>MOLECULE\n${name}\n ${atoms.length} ${bonds.length} 0 0 0\nSMALL\nNO_CHARGES\n\n@<TRIPOS>ATOM\n`;
  atoms.forEach(([nm, type, x, y, z], k) => (s += `${k + 1} ${nm} ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} ${type} 1 LIG 0.0000\n`));
  s += '@<TRIPOS>BOND\n';
  bonds.forEach(([a, b, t], k) => (s += `${k + 1} ${a} ${b} ${t}\n`));
  return s;
}

const METHYL_H: [string, string, number, number, number][] = [['H1', 'H', -0.4, 1.0, 0], ['H2', 'H', -0.4, -0.5, 0.9], ['H3', 'H', -0.4, -0.5, -0.9]];

/** Methyl phosphate dianion with aromatic P–O.co2 bonds (as some MOL2 writers store phosphates). */
const AR_PHOSPHATE = mol2Text(
  'methyl phosphate',
  [['C1', 'C.3', 0, 0, 0], ['O1', 'O.3', 1.43, 0, 0], ['P1', 'P.3', 2.1, 1.35, 0], ['O2', 'O.co2', 3.6, 1.2, 0], ['O3', 'O.co2', 1.6, 2.1, 1.2], ['O4', 'O.co2', 1.6, 2.1, -1.2], ...METHYL_H],
  [[1, 2, '1'], [2, 3, '1'], [3, 4, 'ar'], [3, 5, 'ar'], [3, 6, 'ar'], [1, 7, '1'], [1, 8, '1'], [1, 9, '1']],
);
/** Dimethyl phosphate anion (phosphodiester, as in a nucleic-acid backbone) with aromatic P–O.co2 bonds. */
const AR_PHOSPHODIESTER = mol2Text(
  'dimethyl phosphate',
  [
    ['C1', 'C.3', 0, 0, 0], ['O1', 'O.3', 1.43, 0, 0], ['P1', 'P.3', 2.1, 1.35, 0], ['O2', 'O.co2', 1.6, 2.1, 1.2], ['O3', 'O.co2', 1.6, 2.1, -1.2],
    ['O4', 'O.3', 3.7, 1.3, 0], ['C2', 'C.3', 4.4, 2.6, 0], ...METHYL_H, ['H4', 'H', 5.4, 2.4, 0], ['H5', 'H', 4.1, 3.2, 0.9], ['H6', 'H', 4.1, 3.2, -0.9],
  ],
  [[1, 2, '1'], [2, 3, '1'], [3, 4, 'ar'], [3, 5, 'ar'], [3, 6, '1'], [6, 7, '1'], [1, 8, '1'], [1, 9, '1'], [1, 10, '1'], [7, 11, '1'], [7, 12, '1'], [7, 13, '1']],
);
/** Methanesulfonate with aromatic S–O.co2 bonds. */
const AR_SULFONATE = mol2Text(
  'methanesulfonate',
  [['C1', 'C.3', 0, 0, 0], ['S1', 'S.o2', 1.78, 0, 0], ['O1', 'O.co2', 2.3, 1.4, 0], ['O2', 'O.co2', 2.3, -0.7, 1.2], ['O3', 'O.co2', 2.3, -0.7, -1.2], ...METHYL_H],
  [[1, 2, '1'], [2, 3, 'ar'], [2, 4, 'ar'], [2, 5, 'ar'], [1, 6, '1'], [1, 7, '1'], [1, 8, '1']],
);

/** Orders and lengths of the bonds from the first `centre` atom to terminal O atoms. */
function terminalOxygens(mol: Molecule, centre: string) {
  const topo = getTopology(mol);
  const c = mol.atoms.findIndex((a) => a.element === centre);
  const out: { order: number; length: number }[] = [];
  topo.neighbors[c].forEach((x, k) => {
    if (mol.atoms[x].element === 'O' && topo.neighbors[x].length === 1) out.push({ order: mol.bonds[topo.atomBonds[c][k]].order, length: len(mol, c, x) });
  });
  return out;
}

/** P=O / S=O perception cut-offs of core/structure-bondorders.ts (halfway between its double and single references). */
const PO_DOUBLE_THRESHOLD = 1.54;
const SO_DOUBLE_THRESHOLD = 1.505;

describe("MOL2 'ar' phosphate / sulfonate → Clean → XYZ / PDB → re-import", () => {
  const cases = [
    ['phosphate monoester', AR_PHOSPHATE, 'P', 3, 1, PO_DOUBLE_THRESHOLD],
    ['phosphodiester', AR_PHOSPHODIESTER, 'P', 2, 1, PO_DOUBLE_THRESHOLD],
    ['sulfonate', AR_SULFONATE, 'S', 3, 2, SO_DOUBLE_THRESHOLD],
  ] as const;
  for (const [label, text, centre, nTerminal, nDouble, threshold] of cases) {
    const loaded = prepareMolecule(parseMolecule(text, 'mol2', label));
    const cleaned = minimize(loaded).mol;

    it(`${label}: the aromatic ${centre}–O bonds relax well below the ${centre}=O perception cut-off`, () => {
      const g = terminalOxygens(cleaned, centre);
      expect(g).toHaveLength(nTerminal);
      for (const { order, length } of g) {
        expect(order).toBe(1.5);
        expect(length).toBeCloseTo(idealBondLength(centre, 'O', 1.5), 1);
        expect(length).toBeLessThan(threshold - 0.015);
      }
    });

    for (const format of ['xyz', 'pdb'] as const) {
      it(`${label} via ${format.toUpperCase()}: ${nDouble} ${centre}=O, not all single`, () => {
        const back = prepareMolecule(parseMolecule(writeMolecule(cleaned, format), format, 'rt'));
        const orders = terminalOxygens(back, centre).map((t) => t.order).sort();
        expect(orders).toEqual([...Array(nTerminal - nDouble).fill(1), ...Array(nDouble).fill(2)]);
        const c = back.atoms.findIndex((a) => a.element === centre);
        expect(status(back, c)).toBe('ok');
      });
    }
  }
});

describe('aromatic S(II)–N ring bonds (isothiazole, thiadiazoles, benzothiadiazole)', () => {
  const RINGS: [string, string][] = [
    ['isothiazole', 'c1ccsn1'],
    ['1,2,4-thiadiazole', 'c1ncsn1'],
    ['1,2,5-thiadiazole', 'c1cnsn1'],
    ['2,1,3-benzothiadiazole', 'c1ccc2nsnc2c1'],
    ['1,2-benzisothiazole', 'c1ccc2sncc2c1'],
    ['2,1-benzisothiazole', 'c1ccc2c(c1)cns2'],
  ];
  const sn = (mol: Molecule) => {
    const topo = getTopology(mol);
    const out: number[] = [];
    for (const b of mol.bonds) {
      const i = topo.idToIndex.get(b.a)!, j = topo.idToIndex.get(b.b)!;
      const pair = [mol.atoms[i].element, mol.atoms[j].element].sort().join('');
      if (pair === 'NS') out.push(len(mol, i, j));
    }
    return out;
  };

  it('every form of the ring (SMILES mixed, Kekulé, all-aromatic) gets the aromatic S–N rest length', () => {
    const forms: [string, Molecule][] = [
      // SMILES reader: single bonds at the S, aromatic bonds elsewhere
      ['mixed', moleculeFromSmiles('c1ccsn1')],
      // Kekulé S1–N2=C3–C4=C5–S1 (Hückel-perceived), and all bonds aromatic (MOL2 'ar' / SDF 4)
      ['kekule', mk('isothiazole', [['S', 0, 1.2, 0], ['N', 1.2, 0.4, 0], ['C', 0.75, -0.9, 0], ['C', -0.7, -0.9, 0], ['C', -1.15, 0.4, 0]], [[0, 1], [1, 2, 2], [2, 3], [3, 4, 2], [4, 0]])],
      ['aromatic', mk('isothiazole', [['S', 0, 1.2, 0], ['N', 1.2, 0.4, 0], ['C', 0.75, -0.9, 0], ['C', -0.7, -0.9, 0], ['C', -1.15, 0.4, 0]], [[0, 1, 1.5], [1, 2, 1.5], [2, 3, 1.5], [3, 4, 1.5], [4, 0, 1.5]])],
    ];
    for (const [label, m] of forms) {
      const t = perceiveTyping(m, { inferFromGeometry: false });
      const topo = getTopology(m);
      const s = m.atoms.findIndex((a) => a.element === 'S');
      const n = topo.neighbors[s].find((x) => m.atoms[x].element === 'N')!;
      const order = m.bonds[topo.atomBonds[s][topo.neighbors[s].indexOf(n)]].order;
      expect(restLength(m, t, s, n, order), label).toBeCloseTo(idealBondLength('S', 'N', 1.5), 10);
    }
  });

  it('other S–N and ring S bonds keep their rest lengths', () => {
    const rest = (smiles: string, a: string, b: string) => {
      const m = moleculeFromSmiles(smiles);
      const t = perceiveTyping(m, { inferFromGeometry: false });
      const topo = getTopology(m);
      for (const bond of m.bonds) {
        const i = topo.idToIndex.get(bond.a)!, j = topo.idToIndex.get(bond.b)!;
        if ([m.atoms[i].element, m.atoms[j].element].sort().join('') === [a, b].sort().join('')) return restLength(m, t, i, j, bond.order);
      }
      throw new Error(`no ${a}–${b} bond in ${smiles}`);
    };
    // thiophene C–S: conjugation-shortened single (unchanged, ≈ 1.70 Å vs 1.71 observed)
    expect(rest('c1ccsc1', 'C', 'S')).toBeCloseTo(idealBondLength('C', 'S', 1) * 0.94, 10);
    // sulfonamide S(VI)–N and a saturated isothiazolidine S–N: the table single (1.63 Å)
    expect(rest('CS(=O)(=O)Nc1ccccc1', 'S', 'N')).toBe(idealBondLength('S', 'N', 1));
    expect(rest('C1CSNC1', 'S', 'N')).toBe(idealBondLength('S', 'N', 1));
  });

  for (const [label, smiles] of RINGS) {
    it(`${label}: minimised S–N ≈ 1.60–1.65 Å (was ≈ 1.53); XYZ / PDB round trips keep the S divalent`, () => {
      const m = minimize(moleculeFromSmiles(smiles)).mol;
      const lengths = sn(m);
      expect(lengths.length).toBeGreaterThan(0);
      for (const d of lengths) {
        expect(d).toBeGreaterThan(1.6);
        expect(d).toBeLessThan(1.65);
      }
      for (const format of ['xyz', 'pdb'] as const) {
        const back = prepareMolecule(parseMolecule(writeMolecule(m, format), format, 'rt'));
        // S(II): both S–N / C–S bonds single and the S valence exact (no S=N). Whether the ring's
        // C=N is perceived is up to the C=N cut-off of core/structure-bondorders.ts (1.375 Å), which
        // these minimised C=N bonds (≈ 1.370–1.375 Å) only just meet.
        const topo = getTopology(back);
        for (const b of back.bonds) {
          const els = [back.atoms[topo.idToIndex.get(b.a)!].element, back.atoms[topo.idToIndex.get(b.b)!].element].sort().join('');
          if (els === 'NS') expect(b.order, `${label} ${format}`).toBe(1);
        }
        expect(status(back, back.atoms.findIndex((a) => a.element === 'S')), `${label} ${format}`).toBe('ok');
      }
    });
  }
});
