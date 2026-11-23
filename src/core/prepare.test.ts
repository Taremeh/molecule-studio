import { describe, expect, it } from 'vitest';
import { prepareMolecule } from './prepare';
import { buildMolecule, getTopology } from './molecule';
import { evaluateSelection } from './selection';
import { parseMolecule } from '../io/formats';
import { parsePdb } from '../io/pdb';
import { SAMPLES } from '../io/samples';
import { BENZENE_SDF } from '../io/sampleData';
import { NACL_P1_CIF } from '../io/__fixtures__/fixtures';

const sampleText = (id: string) => {
  const s = SAMPLES.find((x) => x.id === id)!;
  if (s.source.kind !== 'embedded') throw new Error('not embedded');
  return s.source.text;
};

/** PubChem-style 2D record of calcium chloride: salts have no 3D conformer, so the app loads the 2D one. */
const CACL2_2D = `24854
  -OEChem-11222612002D

  3  0  0  0  0  0  0  0  0  0999 V2000
    2.0000    0.0000    0.0000 Ca  0  2  0  0  0  0  0  0  0  0  0  0
    3.0000    0.0000    0.0000 Cl  0  5  0  0  0  0  0  0  0  0  0  0
    4.0000    0.0000    0.0000 Cl  0  5  0  0  0  0  0  0  0  0  0  0
M  CHG  3   1   2   2  -1   3  -1
M  END
$$$$
`;

describe('prepareMolecule', () => {
  it('keeps the explicit (empty) bond table of ionic records such as the rock-salt sample', () => {
    const m = prepareMolecule(parseMolecule(sampleText('nacl'), 'sdf', 'NaCl'));
    expect(m.bonds).toHaveLength(0);
    expect(evaluateSelection(m, 'ion').count).toBe(64);
  });

  it('gives crystal CIF ionic lattices no bonds, like the rock-salt SDF sample', () => {
    for (const cif of [NACL_P1_CIF, NACL_P1_CIF.replace(/Na\+/g, 'Na1+').replace(/Cl-/g, 'Cl1-')]) {
      const m = prepareMolecule(parseMolecule(cif, 'cif', 'NaCl'));
      expect(m.bonds).toHaveLength(0);
      expect(evaluateSelection(m, 'ion').count).toBe(8);
    }
  });

  it('keeps the covalent bonds of polyatomic ions in crystal CIFs (sodium nitrate, oxidation-state symbols)', () => {
    // Nitrate in a P1 cell, Na⁺ 2.4 Å from O1; type symbols as Materials Project writes them.
    const cif = [
      'data_NaNO3', '_cell_length_a 8', '_cell_length_b 8', '_cell_length_c 8', '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
      'loop_', '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z',
      'N1 N5+ 0.5 0.5 0.5', 'O1 O2- 0.65625 0.5 0.5', 'O2 O2- 0.421875 0.635316 0.5', 'O3 O2- 0.421875 0.364684 0.5', 'Na1 Na1+ 0.95625 0.5 0.5',
    ].join('\n');
    const m = prepareMolecule(parseMolecule(cif, 'cif', 'NaNO3'));
    const pairs = m.bonds.map((b) => [m.atoms[b.a - 1].name, m.atoms[b.b - 1].name].sort().join('-')).sort();
    expect(pairs).toEqual(['N1-O1', 'N1-O2', 'N1-O3']);
  });

  it('keeps heme Fe–N and Zn–S(Cys) coordination of PDB entries', () => {
    const line = (rec: string, serial: number, name: string, res: string, seq: number, x: number, y: number, z: number, el: string) =>
      `${rec.padEnd(6)}${String(serial).padStart(5)} ${name.padEnd(4)} ${res.padStart(3)} A${String(seq).padStart(4)}    ${x.toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}  1.00  0.00          ${el.padStart(2)}`;
    const s = 2.33 / Math.sqrt(3);
    const pdb = [
      // Heme iron and its four pyrrole nitrogens as ATOM records without element columns (MD output).
      line('ATOM', 1, 'FE', 'HEM', 1, 0, 0, 0, ''),
      line('ATOM', 2, ' NA', 'HEM', 1, 2.0, 0, 0, ''),
      line('ATOM', 3, ' NB', 'HEM', 1, 0, 2.0, 0, ''),
      line('ATOM', 4, ' NC', 'HEM', 1, -2.0, 0, 0, ''),
      line('ATOM', 5, ' ND', 'HEM', 1, 0, -2.0, 0, ''),
      // Zinc site: Zn²⁺ (charge column) tetrahedrally bound to four Cys SG.
      line('HETATM', 6, 'ZN', 'ZN', 2, 20, 0, 0, 'ZN') + '2+',
      ...[[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]].map(([x, y, z], k) => line('ATOM', 7 + k, ' SG', 'CYS', 10 + k, 20 + s * x, s * y, s * z, 'S')),
    ].join('\n');
    const m = prepareMolecule(parsePdb(pdb));
    expect(m.atoms[0].element).toBe('Fe');
    expect(m.atoms[5]).toMatchObject({ element: 'Zn', charge: 2 });
    const pairs = m.bonds.map((b) => [m.atoms[b.a - 1].element, m.atoms[b.b - 1].element].sort().join('-')).sort();
    expect(pairs).toEqual([...Array(4).fill('Fe-N'), ...Array(4).fill('S-Zn')]);
  });

  it('keeps the bonds and orders of every embedded sample, and perceives the same bonds from their bare coordinates', () => {
    const orders = (m: ReturnType<typeof prepareMolecule>) => m.bonds.map((b) => `${b.a}-${b.b}:${b.order}`);
    const pairs = (m: ReturnType<typeof prepareMolecule>) => m.bonds.map((b) => `${Math.min(b.a, b.b)}-${Math.max(b.a, b.b)}`).sort();
    for (const s of SAMPLES) {
      if (s.source.kind !== 'embedded') continue;
      const raw = parseMolecule(s.source.text, s.source.format, s.name);
      expect(orders(prepareMolecule(raw)), s.id).toEqual(orders(raw));
      // Coordinates (and charges) only, as an XYZ export would give them: the rock salt stays bond-less.
      const bare = prepareMolecule(buildMolecule(s.name, raw.atoms.map((a) => ({ ...a })), [], { format: 'xyz' }));
      expect(pairs(bare), s.id).toEqual(pairs(raw));
    }
  });

  it('does not perceive bonds from the 2D coordinates of a bond-less salt record', () => {
    const m = prepareMolecule(parseMolecule(CACL2_2D, 'sdf', 'calcium chloride'));
    expect(m.bonds).toHaveLength(0);
  });

  it('perceives bonds and bond orders for a neutral 3D record without a bond table', () => {
    const withBonds = parseMolecule(BENZENE_SDF, 'sdf', 'benzene');
    const bare = buildMolecule('benzene', withBonds.atoms, [], { format: 'sdf', hasBondOrders: true });
    const m = prepareMolecule(bare);
    expect(m.bonds).toHaveLength(12);
    const cc = m.bonds.filter((b) => m.atoms[b.a - 1].element === 'C' && m.atoms[b.b - 1].element === 'C');
    expect(cc.map((b) => b.order)).toEqual([1.5, 1.5, 1.5, 1.5, 1.5, 1.5]);
  });

  it('keeps file bonds and orders of SDF records', () => {
    const raw = parseMolecule(BENZENE_SDF, 'sdf', 'benzene');
    const m = prepareMolecule(raw);
    expect(m.bonds.map((b) => [b.a, b.b, b.order])).toEqual(raw.bonds.map((b) => [b.a, b.b, b.order]));
  });

  it('adds distance bonds next to CONECT bonds and template orders for protein residues', () => {
    // Gly–Gly fragment plus a CONECT-bonded acetate ligand.
    const pdb = [
      'ATOM      1  N   GLY A   1      -1.195   0.539   0.000  1.00  0.00           N',
      'ATOM      2  CA  GLY A   1       0.000   1.383   0.000  1.00  0.00           C',
      'ATOM      3  C   GLY A   1       1.268   0.552   0.000  1.00  0.00           C',
      'ATOM      4  O   GLY A   1       1.226  -0.677   0.000  1.00  0.00           O',
      'ATOM      5  N   GLY A   2       2.419   1.218   0.000  1.00  0.00           N',
      'ATOM      6  CA  GLY A   2       3.687   0.493   0.000  1.00  0.00           C',
      'HETATM    7  C1  ACT A 101      10.000   0.000   0.000  1.00  0.00           C',
      'HETATM    8  C2  ACT A 101      11.520   0.000   0.000  1.00  0.00           C',
      'HETATM    9  O1  ACT A 101      12.150   1.080   0.000  1.00  0.00           O',
      'HETATM   10  O2  ACT A 101      12.150  -1.080   0.000  1.00  0.00           O',
      'CONECT    7    8',
      'CONECT    8    7    9   10',
      'END',
    ].join('\n');
    const m = prepareMolecule(parsePdb(pdb));
    const topo = getTopology(m);
    const order = (n1: string, r1: number, n2: string, r2: number) => {
      const i = m.atoms.findIndex((a) => a.name === n1 && a.resSeq === r1);
      const j = m.atoms.findIndex((a) => a.name === n2 && a.resSeq === r2);
      const bi = topo.atomBonds[i].find((b) => [m.bonds[b].a, m.bonds[b].b].includes(m.atoms[j].id));
      return bi === undefined ? undefined : m.bonds[bi].order;
    };
    expect(order('C', 1, 'O', 1)).toBe(2); // backbone carbonyl from the residue template
    expect(order('C', 1, 'N', 2)).toBe(1); // peptide bond perceived from distance
    expect(order('C1', 101, 'C2', 101)).toBe(1); // CONECT bonds kept
    expect([order('C2', 101, 'O1', 101), order('C2', 101, 'O2', 101)].sort()).toEqual([1, 2]);
  });
});
