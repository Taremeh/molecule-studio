import { describe, expect, it } from 'vitest';
import { parseMolecule, writeMolecule } from '../io/formats';
import { analyzeValence } from './chemistry';
import { minimize } from './minimize';
import { buildMolecule, getTopology } from './molecule';
import { prepareMolecule } from './prepare';
import { assignBondOrders } from './structure-bondorders';
import { moleculeFromSmiles } from './smiles';
import type { Molecule } from './types';

/** SMILES → 3D → minimise → XYZ text → parse → prepare (bonds and orders perceived from coordinates). */
function xyzRoundTrip(smiles: string): { before: Molecule; after: Molecule } {
  const before = minimize(moleculeFromSmiles(smiles)).mol;
  const after = prepareMolecule(parseMolecule(writeMolecule(before, 'xyz'), 'xyz', 'rt'));
  return { before, after };
}

const charges = (m: Molecule) =>
  m.atoms
    .filter((a) => a.charge)
    .map((a) => `${a.element}${a.charge! > 0 ? '+' : ''}${a.charge}`)
    .sort();

const valenceProblems = (m: Molecule) => [...analyzeValence(m).values()].filter((v) => v.status !== 'ok' && v.status !== 'unchecked');

const dist = (m: Molecule, i: number, j: number) => Math.hypot(m.atoms[i].x - m.atoms[j].x, m.atoms[i].y - m.atoms[j].y, m.atoms[i].z - m.atoms[j].z);

/** Number of O atoms bonded to exactly one heavy atom and one H (hydroxyl O–H). */
function hydroxyls(m: Molecule): number {
  const t = getTopology(m);
  let c = 0;
  m.atoms.forEach((a, i) => {
    if (a.element !== 'O') return;
    const nb = t.neighbors[i].map((j) => m.atoms[j].element);
    if (nb.length === 2 && nb.filter((e) => e === 'H').length === 1) c++;
  });
  return c;
}

describe('assignBondOrders: carboxylates without stored charges (XYZ round trip)', () => {
  it.each([
    ['benzoate', 'c1ccccc1C(=O)[O-]'],
    ['glycine zwitterion', '[NH3+]CC(=O)[O-]'],
    ['acetate', 'CC(=O)[O-]'],
    ['citrate', 'OC(CC(=O)[O-])(CC(=O)[O-])C(=O)[O-]'],
    ['oxalate', '[O-]C(=O)C(=O)[O-]'],
    ['carbonate', '[O-]C([O-])=O'],
    ['tetramethylammonium acetate', 'C[N+](C)(C)C.CC(=O)[O-]'],
    // The ammonium rule must not leave an amine N-oxide at +1: its terminal O is O⁻.
    ['trimethylamine N-oxide', 'C[N+](C)(C)[O-]'],
  ])('%s gets its carboxylate charges back and no valence problems', (_name, smiles) => {
    const { before, after } = xyzRoundTrip(smiles);
    expect(after.atoms).toHaveLength(before.atoms.length);
    expect(after.bonds).toHaveLength(before.bonds.length);
    expect(charges(after)).toEqual(charges(before));
    expect(valenceProblems(after)).toEqual([]);
  });

  it.each([
    ['acetate', 'CC(=O)[O-]'],
    ['benzoate', 'c1ccccc1C(=O)[O-]'],
  ])('%s keeps a carboxylate geometry after a later Clean (equal C–O lengths)', (_name, smiles) => {
    const { after } = xyzRoundTrip(smiles);
    const cleaned = minimize(after).mol;
    const t = getTopology(cleaned);
    const c = cleaned.atoms.findIndex((a, i) => a.element === 'C' && t.neighbors[i].filter((j) => cleaned.atoms[j].element === 'O').length === 2);
    const [d1, d2] = t.neighbors[c].filter((j) => cleaned.atoms[j].element === 'O').map((j) => dist(cleaned, c, j));
    expect(Math.abs(d1 - d2)).toBeLessThan(0.03);
  });

  it('acetic acid stays neutral with its O–H', () => {
    const { after } = xyzRoundTrip('CC(=O)O');
    expect(charges(after)).toEqual([]);
    expect(hydroxyls(after)).toBe(1);
    expect(valenceProblems(after)).toEqual([]);
  });

  it.each([
    ['neutral glycine', 'NCC(=O)O', 1],
    ['methyl acetate', 'CC(=O)OC', 0],
    ['acetamide', 'CC(N)=O', 0],
    ['oxalic acid', 'OC(=O)C(=O)O', 2],
  ])('%s stays neutral', (_name, smiles, oh) => {
    const { after } = xyzRoundTrip(smiles);
    expect(charges(after)).toEqual([]);
    expect(hydroxyls(after)).toBe(oh);
    expect(valenceProblems(after)).toEqual([]);
  });

  /** Heavy atoms of the round-tripped molecule only, optionally as one PDB-style ligand residue. */
  const heavyOnly = (smiles: string, resName?: string): Molecule => {
    const before = minimize(moleculeFromSmiles(smiles)).mol;
    const heavy = before.atoms
      .filter((a) => a.element !== 'H')
      .map(({ element, x, y, z }) => ({ element, x, y, z, ...(resName ? { resName, resSeq: 1, chain: 'A', hetero: true } : {}) }));
    return prepareMolecule(buildMolecule('heavy', heavy, [], { format: resName ? 'pdb' : 'xyz' }));
  };

  it('implicit hydrogens: PDB ligands keep COO / COOH neutral (ambiguous), so do acids stripped of their H', () => {
    // A PDB ligand without H: the carboxylate and the acid look the same, nothing is charged.
    for (const s of ['CC(=O)[O-]', 'c1ccccc1C(=O)[O-]', '[O-]C(=O)C(=O)[O-]', 'CC(=O)O']) expect(charges(heavyOnly(s, 'LIG'))).toEqual([]);
    // Residue-less H-free components keep an acid's C=O / C–O length difference: oxalic acid stays neutral.
    expect(charges(heavyOnly('OC(=O)C(=O)O'))).toEqual([]);
    expect(charges(heavyOnly('[O-]C(=O)C(=O)[O-]'))).toEqual(['O-1', 'O-1']);
    // A quaternary N without hydrogens in the component is not charged either.
    expect(charges(heavyOnly('C[N+](C)(C)C', 'LIG'))).toEqual([]);
  });

  it('heavy-atom-only residue-less files: only species that need no H at all get O⁻', () => {
    // Glycine / benzoate / acetate / betaine without their H atoms (crystal CIF or XYZ without H) are
    // implicit-H structures: a lone O⁻ would give the neutral zwitterions a net charge of −1.
    for (const s of ['[NH3+]CC(=O)[O-]', 'c1ccccc1C(=O)[O-]', 'CC(=O)[O-]', 'C[N+](C)(C)CC(=O)[O-]']) expect(charges(heavyOnly(s))).toEqual([]);
    // Oxalate and carbonate have no H to miss.
    expect(charges(heavyOnly('[O-]C([O-])=O'))).toEqual(['O-1', 'O-1']);
    // Hydrogen oxalate: the delocalised half is the carboxylate, the C=O / C–OH half stays neutral.
    expect(charges(heavyOnly('OC(=O)C(=O)[O-]'))).toEqual(['O-1']);
  });

  it('leaves metal-bound carboxylates / carbonates and N→B adducts neutral (metal / B would need the counter-charge)', () => {
    const net = (m: Molecule) => m.atoms.reduce((s, a) => s + (a.charge ?? 0), 0);
    // Calcite-like CO₃ with each O on a Ca (crystal CIF with plain type symbols: Ca–O bonds by distance).
    const atoms: { element: string; x: number; y: number; z: number }[] = [{ element: 'C', x: 0, y: 0, z: 0 }];
    for (let k = 0; k < 3; k++) {
      const t = (2 * Math.PI * k) / 3;
      atoms.push({ element: 'O', x: 1.285 * Math.cos(t), y: 1.285 * Math.sin(t), z: 0 });
      atoms.push({ element: 'Ca', x: 3.645 * Math.cos(t), y: 3.645 * Math.sin(t), z: 0 });
    }
    const calcite = prepareMolecule(buildMolecule('calcite', atoms, [], { format: 'cif' }));
    expect(calcite.bonds.filter((b) => [b.a, b.b].some((id) => calcite.atoms[id - 1].element === 'Ca'))).toHaveLength(3);
    expect(charges(calcite)).toEqual([]);
    expect(valenceProblems(calcite)).toEqual([]);
    // Acetate with explicit H bridging two Cu (paddlewheel-like XYZ), and as an MD ligand residue on a Zn.
    const ac = minimize(moleculeFromSmiles('CC(=O)[O-]')).mol;
    const t = getTopology(ac);
    const c = ac.atoms.findIndex((a, i) => a.element === 'C' && t.neighbors[i].some((j) => ac.atoms[j].element === 'O'));
    const metals = t.neighbors[c]
      .filter((j) => ac.atoms[j].element === 'O')
      .map((j) => {
        const [o, cc] = [ac.atoms[j], ac.atoms[c]];
        const d = dist(ac, c, j);
        return { element: 'Cu', x: o.x + (1.97 * (o.x - cc.x)) / d, y: o.y + (1.97 * (o.y - cc.y)) / d, z: o.z + (1.97 * (o.z - cc.z)) / d };
      });
    const heavy = ac.atoms.map(({ element, x, y, z }) => ({ element, x, y, z }));
    const cu = prepareMolecule(buildMolecule('Cu2(OAc)', [...heavy, ...metals], [], { format: 'xyz' }));
    expect(cu.bonds.filter((b) => [b.a, b.b].some((id) => cu.atoms[id - 1].element === 'Cu'))).toHaveLength(2);
    expect(charges(cu)).toEqual([]);
    const lig = { resName: 'ACT', resSeq: 1, chain: 'A', hetero: true };
    const zn = prepareMolecule(
      buildMolecule('ACT on ZN', [...heavy.map((a) => ({ ...a, ...lig })), { ...metals[0], element: 'Zn', name: 'ZN', resName: 'ZN', resSeq: 2, chain: 'A', hetero: true }], [], { format: 'pdb' }),
    );
    expect(zn.bonds.some((b) => [b.a, b.b].some((id) => zn.atoms[id - 1].element === 'Zn'))).toBe(true);
    expect(net(zn)).toBe(0);
    // Ammonia borane H₃N–BH₃: a lone N⁺ (without B⁻) would make it a cation.
    expect(net(xyzRoundTrip('[NH3+][BH3-]').after)).toBe(0);
  });

  it('keeps charges the file gives', () => {
    const before = minimize(moleculeFromSmiles('CC(=O)[O-]')).mol;
    const charged = { ...before, bonds: before.bonds.map((b) => ({ ...b, order: 1 as const })) };
    const after = assignBondOrders(charged);
    expect(charges(after)).toEqual(['O-1']);
    // The O⁻ stays single and the other O takes the double bond.
    const o = after.atoms.findIndex((a) => a.charge === -1);
    expect(after.bonds.filter((b) => b.a === o + 1 || b.b === o + 1).map((b) => b.order)).toEqual([1]);
  });
});
