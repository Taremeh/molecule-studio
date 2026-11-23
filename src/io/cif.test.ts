import { describe, expect, it } from 'vitest';
import { cellMatrix, parseCif, parseCifMolecule, parseSymOp } from './cif';
import { CCD_FIXTURE, CIF_FIXTURE, NACL_P1_CIF, P21C_CIF } from './__fixtures__/fixtures';
import type { Molecule } from '../core/types';

const bySerial = (mol: Molecule, serial: number) => mol.atoms.find((a) => a.serial === serial)!;

describe('CIF tokenizer / block parser', () => {
  const block = parseCif(CIF_FIXTURE);

  it('reads the data block name and key-value pairs', () => {
    expect(block.name).toBe('1ABC');
    expect(block.category('entry')!.get(0, 'id')).toBe('1ABC');
    // Quoted value containing '#' and a space.
    expect(block.category('struct')!.get(0, 'pdbx_descriptor')).toBe('Glycyl-seryl-lysine # not a comment');
  });

  it('reads ;-delimited text fields verbatim, even when their lines look like CIF syntax', () => {
    expect(block.category('struct')!.get(0, 'title')).toBe("Test structure: a 'quoted' title\nwith a continuation line");
    expect(block.category('pdbx_entry_details')!.get(0, 'compound_details')).toBe(
      'loop_\n_fake.tag value\n# this line is text, not a comment',
    );
    expect(block.category('fake')).toBeUndefined();
  });

  it('reads loops with quoted values and nulls', () => {
    const site = block.category('atom_site')!;
    expect(site.rowCount).toBe(17);
    expect(site.fields).toHaveLength(20);
    expect(site.get(12, 'label_atom_id')).toBe("C5'");
    expect(site.get(13, 'label_atom_id')).toBe("O5'"); // 'O5'' — inner quote not followed by whitespace
    expect(site.get(0, 'label_alt_id')).toBeNull(); // '.'
    expect(site.get(0, 'pdbx_formal_charge')).toBeNull(); // '?'
    expect(site.float(0, site.column('Cartn_x'))).toBe(10);
    expect(Number.isNaN(site.int(12, site.column('label_seq_id')))).toBe(true);
  });

  it('is case-insensitive for tags and only reads the first data block', () => {
    const b = parseCif('data_A\n_Cell.Length_A 5.0\ndata_B\n_cell.length_a 9.0\n');
    expect(b.category('cell')!.get(0, 'length_a')).toBe('5.0');
  });

  it('handles CRLF line endings and comments', () => {
    const b = parseCif('data_X\r\n# comment\r\n_a.b ;not-a-text-field\r\n_a.c\r\n;line1\r\nline2\r\n;\r\n');
    expect(b.category('a')!.get(0, 'b')).toBe(';not-a-text-field');
    expect(b.category('a')!.get(0, 'c')).toBe('line1\r\nline2');
  });

  it('throws on an unterminated text field', () => {
    expect(() => parseCif('data_X\n_a.b\n;never closed\n')).toThrow(/not terminated/);
  });
});

describe('parseCifMolecule', () => {
  const mol = parseCifMolecule(CIF_FIXTURE);

  it('reads the first model and first altLoc only', () => {
    expect(mol.atoms).toHaveLength(14);
    expect(mol.atoms.some((a) => a.x === 99)).toBe(false);
    expect(mol.atoms.some((a) => a.serial === 8 || a.serial === 10)).toBe(false);
    expect(bySerial(mol, 7)).toMatchObject({ altLoc: 'A', occupancy: 0.5 });
  });

  it('prefers auth_* identifiers and reads all atom fields', () => {
    expect(bySerial(mol, 1)).toMatchObject({ element: 'N', name: 'N', resName: 'GLY', resSeq: 11, chain: 'A', hetero: false, bfactor: 11 });
    const c5 = bySerial(mol, 13);
    expect(c5).toMatchObject({ element: 'C', name: "C5'", resName: 'ATP', resSeq: 401, chain: 'A', hetero: true });
    expect(bySerial(mol, 14).name).toBe("O5'");
    expect(bySerial(mol, 16)).toMatchObject({ resName: 'HOH', resSeq: 601, chain: 'A' });
  });

  it('reads formal charges and two-letter elements', () => {
    expect(bySerial(mol, 12).charge).toBe(1);
    expect(bySerial(mol, 15)).toMatchObject({ element: 'Zn', charge: 2 });
    expect(bySerial(mol, 1).charge).toBeUndefined();
  });

  it('assigns secondary structure from struct_conf (HELX only) and struct_sheet_range', () => {
    expect(mol.meta.hasSecondaryStructure).toBe(true);
    expect(bySerial(mol, 2).ss).toBe('helix');
    expect(bySerial(mol, 6).ss).toBe('helix');
    expect(bySerial(mol, 11).ss).toBe('sheet'); // LYS 13: TURN ignored, sheet applies
    expect(bySerial(mol, 13).ss).toBeUndefined();
  });

  it('reads entry id and title', () => {
    expect(mol.meta).toMatchObject({ format: 'cif', externalId: '1ABC', title: "Test structure: a 'quoted' title with a continuation line" });
    expect(mol.name).toBe('1ABC');
    expect(parseCifMolecule(CIF_FIXTURE, 'file name').name).toBe('file name');
  });

  it('reads chemical component files with ideal coordinates and bond orders', () => {
    const eoh = parseCifMolecule(CCD_FIXTURE);
    expect(eoh.atoms).toHaveLength(9);
    expect(eoh.bonds).toHaveLength(8);
    expect(eoh.meta).toMatchObject({ format: 'cif', title: 'ETHANOL', externalId: 'EOH', hasBondOrders: true });
    expect(eoh.atoms[0]).toMatchObject({ element: 'C', name: 'C1', resName: 'EOH', x: -0.445, y: 0.384 });
    expect(eoh.atoms.filter((a) => a.element === 'H')).toHaveLength(6);
  });

  it('gives friendly errors', () => {
    expect(() => parseCifMolecule('data_X\n_cell.length_a 5\n')).toThrow(/_atom_site/);
    expect(() => parseCifMolecule('hello world')).toThrow(/mmCIF/);
  });

  it('parses a large atom_site loop quickly', () => {
    const header = CIF_FIXTURE.slice(CIF_FIXTURE.indexOf('loop_\n_atom_site.group_PDB'), CIF_FIXTURE.indexOf('ATOM   1 '));
    const rows: string[] = [];
    for (let i = 1; i <= 100_000; i++) rows.push(`ATOM ${i} C CA . ALA A ${i} ? 1.000 2.000 3.000 1.00 10.00 ? ${i} ALA A CA 1`);
    const text = 'data_BIG\n' + header + rows.join('\n') + '\n#\n';
    const t0 = performance.now();
    const big = parseCifMolecule(text);
    expect(big.atoms).toHaveLength(100_000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('mmCIF without type symbols', () => {
  const site = (rows: string[]) =>
    ['data_T', 'loop_', '_atom_site.group_PDB', '_atom_site.id', '_atom_site.label_atom_id', '_atom_site.label_comp_id', '_atom_site.label_asym_id',
      '_atom_site.auth_seq_id', '_atom_site.Cartn_x', '_atom_site.Cartn_y', '_atom_site.Cartn_z', ...rows].join('\n') + '\n';

  it('infers single-atom CHARMM ions and heme iron from residue context', () => {
    const m = parseCifMolecule(
      site(['ATOM 1 CD CD2 B 1 0 0 0', 'ATOM 2 CA CAL C 2 5 0 0', 'ATOM 3 FE HEM D 3 10 0 0', 'ATOM 4 NA HEM D 3 12 0 0', 'ATOM 5 CA ALA A 1 20 0 0',
        'HETATM 6 CA CAL E 4 30 0 0', 'HETATM 7 CB CAL E 4 31.5 0 0', 'ATOM 8 CD CD2 F 5 40 0 0', 'ATOM 9 OD CD2 F 5 41.2 0 0',
        'ATOM 10 CL1 LIG G 6 50 0 0', 'HETATM 11 CL1 LIG G 7 55 0 0']),
    );
    // Multi-atom residues keep one-letter elements (CA of a 2-atom CAL, CD of a 2-atom CD2).
    expect(m.atoms.map((a) => a.element)).toEqual(['Cd', 'Ca', 'Fe', 'N', 'C', 'C', 'C', 'C', 'O', 'C', 'Cl']);
  });
});

describe('crystal (small-molecule) CIF', () => {
  it('reads a P1 cell from fractional coordinates with ionic charges', () => {
    const m = parseCifMolecule(NACL_P1_CIF);
    expect(m.atoms).toHaveLength(8);
    expect(m.atoms.filter((a) => a.element === 'Na')).toHaveLength(4);
    expect(m.atoms.filter((a) => a.element === 'Cl').every((a) => a.charge === -1)).toBe(true);
    expect(m.atoms[1]).toMatchObject({ name: 'Na1', x: 0 });
    expect(m.atoms[1].y).toBeCloseTo(2.8201, 4);
    expect(m.meta).toMatchObject({ format: 'cif', title: 'Na4 Cl4' });
    expect(m.name).toBe('NaCl');
  });

  it('expands the asymmetric unit with symmetry operators, keeping molecules intact', () => {
    const m = parseCifMolecule(P21C_CIF);
    expect(m.atoms).toHaveLength(8);
    expect(m.atoms.filter((a) => a.element === 'O')).toHaveLength(4);
    const d = (i: number, j: number) => Math.hypot(m.atoms[i].x - m.atoms[j].x, m.atoms[i].y - m.atoms[j].y, m.atoms[i].z - m.atoms[j].z);
    // Each symmetry copy (C, O pairs in order) keeps the asymmetric-unit C–O distance.
    const ref = d(0, 1);
    for (let k = 0; k < 8; k += 2) expect(d(k, k + 1)).toBeCloseTo(ref, 6);
    // Fractional → Cartesian with beta = 105°: x = a·fx + c·cosβ·fz, z = c·sinβ·fz.
    const beta = (105 * Math.PI) / 180;
    expect(m.atoms[0].x).toBeCloseTo(7 * 0.1 + 11 * Math.cos(beta) * 0.3, 6);
    expect(m.atoms[0].y).toBeCloseTo(9 * 0.2, 6);
    expect(m.atoms[0].z).toBeCloseTo(11 * Math.sin(beta) * 0.3, 6);
    expect(m.atoms[0].bfactor).toBeCloseTo(8 * Math.PI ** 2 * 0.025, 6);
    expect(m.meta).toMatchObject({ title: 'test carbonyl', externalId: '9999999' });
  });

  it('drops duplicate atoms on special positions', () => {
    const cif = P21C_CIF.replace('C1 C 0.1000(3) 0.2000(2) 0.3000(2)', 'Fe1 Fe 0 0 0').replace('C1 0.02', 'Fe1 0.02');
    const m = parseCifMolecule(cif);
    expect(m.atoms.filter((a) => a.element === 'Fe')).toHaveLength(2); // (0,0,0) and (0,1/2,1/2)
    expect(m.atoms.filter((a) => a.element === 'O')).toHaveLength(4);
  });

  it('expands high-symmetry cells (Fm-3m, 192 operators) exactly and quickly', () => {
    // All 48 signed axis permutations × 4 F-centring translations.
    const ax = ['x', 'y', 'z'];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const cents = [['', '', ''], ['', '+1/2', '+1/2'], ['+1/2', '', '+1/2'], ['+1/2', '+1/2', '']];
    const ops: string[] = [];
    for (const c of cents) for (const p of perms) for (let s = 0; s < 8; s++) ops.push(`'${[0, 1, 2].map((i) => ((s >> i) & 1 ? '-' : '') + ax[p[i]] + c[i]).join(',')}'`);
    const crystal = (a: number, sites: string[]) =>
      ['data_fm3m', `_cell_length_a ${a}`, `_cell_length_b ${a}`, `_cell_length_c ${a}`, '_cell_angle_alpha 90', '_cell_angle_beta 90', '_cell_angle_gamma 90',
        'loop_', '_space_group_symop_operation_xyz', ...ops,
        'loop_', '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z', ...sites].join('\n') + '\n';
    // Rock salt: Na on 4a (0,0,0), Cl on 4b (½,½,½) → 4 + 4 atoms out of 2 × 192 images.
    const salt = parseCifMolecule(crystal(5.64, ['Na1 Na 0 0 0', 'Cl1 Cl 0.5 0.5 0.5']));
    expect(salt.atoms.filter((a) => a.element === 'Na')).toHaveLength(4);
    expect(salt.atoms.filter((a) => a.element === 'Cl')).toHaveLength(4);
    // 125 atoms on general positions → 24 000 atoms; the duplicate check must not be quadratic.
    // (Offsets 0.011 / 0.023 / 0.037 mod 0.05 keep every symmetry image ≥ 0.2 Å from all others.)
    const sites: string[] = [];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) for (let k = 0; k < 5; k++) {
      sites.push(`C${sites.length} C ${0.011 + 0.05 * i} ${0.023 + 0.05 * j} ${0.037 + 0.05 * k}`);
    }
    const t0 = performance.now();
    const big = parseCifMolecule(crystal(100, sites));
    expect(big.atoms).toHaveLength(125 * 192);
    expect(performance.now() - t0).toBeLessThan(2500);
  });

  it('parses symmetry operators', () => {
    expect(parseSymOp('-x+1/2, y, -z')).toEqual({ r: [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], t: [0.5, 0, 0] });
    expect(parseSymOp('x-y,x,z+1/6')).toEqual({ r: [[1, -1, 0], [1, 0, 0], [0, 0, 1]], t: [0, 0, 1 / 6] });
    expect(parseSymOp("'1/2+x,-y,0.25+z'")).toEqual({ r: [[1, 0, 0], [0, -1, 0], [0, 0, 1]], t: [0.5, 0, 0.25] });
    expect(parseSymOp('a,b,c')).toBeNull();
    expect(parseSymOp('x,y')).toBeNull();
  });

  it('builds the cell matrix', () => {
    const m = cellMatrix(3, 4, 5, 90, 90, 90);
    expect(m[0][0]).toBeCloseTo(3, 9);
    expect(m[1][1]).toBeCloseTo(4, 9);
    expect(m[2][2]).toBeCloseTo(5, 9);
    expect(m[0][1]).toBeCloseTo(0, 9);
    const hex = cellMatrix(2, 2, 3, 90, 90, 120);
    expect(hex[0][1]).toBeCloseTo(-1, 9);
    expect(hex[1][1]).toBeCloseTo(Math.sqrt(3), 9);
  });

  it('reads formal charges from ionic type symbols (Na+, Na1+, Cl1-, O2-, Fe3+)', () => {
    const symbols = NACL_P1_CIF.replace(/Na\+/g, 'Na1+').replace(/Cl-/g, 'Cl1-');
    const m = parseCifMolecule(symbols);
    expect(m.atoms.map((a) => `${a.element}${a.charge}`)).toEqual([...Array(4).fill('Na1'), ...Array(4).fill('Cl-1')]);
    expect(parseCifMolecule(NACL_P1_CIF).atoms.map((a) => a.charge)).toEqual([1, 1, 1, 1, -1, -1, -1, -1]);
    const oxide = parseCifMolecule(symbols.replace(/Na1\+/g, 'Fe3+').replace(/Cl1-/g, 'O2-'));
    expect(oxide.atoms.map((a) => `${a.element}${a.charge}`)).toEqual([...Array(4).fill('Fe3'), ...Array(4).fill('O-2')]);
    // Plain symbols carry no charge.
    expect(parseCifMolecule(NACL_P1_CIF.replace(/Na\+/g, 'Na').replace(/Cl-/g, 'Cl')).atoms.every((a) => a.charge === undefined)).toBe(true);
  });

  it('requires a unit cell', () => {
    expect(() => parseCifMolecule(NACL_P1_CIF.replace(/_cell_length_[abc].*\n/g, ''))).toThrow(/unit cell/);
  });
});
