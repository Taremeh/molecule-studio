import { describe, expect, it } from 'vitest';
import { autodockTypeElement, decodeHybrid36, encodeHybrid36, inferPdbElement, parsePdb, pdbqtAtomType, writePdb } from './pdb';
import { detectFormat, parseMolecule, sniffFormat } from './formats';
import { buildMolecule } from '../core/molecule';
import type { Molecule } from '../core/types';
import { PDB_FIXTURE } from './__fixtures__/fixtures';


const atomBySerial = (mol: Molecule, serial: number) => mol.atoms.find((a) => a.serial === serial)!;

describe('parsePdb', () => {
  const mol = parsePdb(PDB_FIXTURE);

  it('reads only the first model and the first altLoc', () => {
    expect(mol.atoms).toHaveLength(24);
    expect(atomBySerial(mol, 1).x).toBeCloseTo(17.047, 3);
    expect(mol.atoms.some((a) => a.serial === 112 || a.serial === 113)).toBe(false);
    const cb = atomBySerial(mol, 12);
    expect(cb.altLoc).toBe('A');
    expect(cb.occupancy).toBeCloseTo(0.6, 2);
  });

  it('reads residue fields, B-factors and hetero flags', () => {
    const ca = atomBySerial(mol, 2);
    expect(ca).toMatchObject({ element: 'C', name: 'CA', resName: 'THR', resSeq: 1, chain: 'A', hetero: false });
    expect(ca.bfactor).toBeCloseTo(10.8, 2);
    expect(ca.y).toBeCloseTo(12.784, 3);
    expect(ca.z).toBeCloseTo(4.338, 3);
    const water = atomBySerial(mol, 22);
    expect(water).toMatchObject({ element: 'O', resName: 'HOH', resSeq: 201, hetero: true });
    expect(atomBySerial(mol, 20).element).toBe('S');
  });

  it('infers elements when columns 77-78 are blank and reads charges', () => {
    expect(atomBySerial(mol, 21).element).toBe('Zn');
    expect(atomBySerial(mol, 23).element).toBe('Cl');
    const calcium = atomBySerial(mol, 24);
    expect(calcium.element).toBe('Ca');
    expect(calcium.charge).toBe(2);
  });

  it('turns CONECT records into unique bonds and ignores unknown serials', () => {
    expect(mol.bonds).toHaveLength(1);
    const b = mol.bonds[0];
    const ids = [b.a, b.b].map((id) => mol.atoms.find((a) => a.id === id)!.serial).sort((x, y) => x! - y!);
    expect(ids).toEqual([20, 21]);
    expect(b.order).toBe(1);
  });

  it('assigns secondary structure from HELIX/SHEET records', () => {
    expect(mol.meta.hasSecondaryStructure).toBe(true);
    expect(atomBySerial(mol, 2).ss).toBe('sheet');
    expect(atomBySerial(mol, 9).ss).toBe('helix');
    expect(atomBySerial(mol, 16).ss).toBe('helix');
    expect(atomBySerial(mol, 22).ss).toBeUndefined(); // water is not protein
  });

  it('reads HEADER / TITLE / COMPND metadata', () => {
    expect(mol.meta.format).toBe('pdb');
    expect(mol.meta.externalId).toBe('1CRN');
    expect(mol.meta.title).toBe(
      'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN AT ATOMIC RESOLUTION. PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF CRAMBIN',
    );
    expect(mol.name).toBe('1CRN');
    expect(parsePdb(PDB_FIXTURE, 'my crambin').name).toBe('my crambin');
  });

  it('leaves hasSecondaryStructure unset without HELIX/SHEET and marks no ss', () => {
    const noSs = parsePdb(PDB_FIXTURE.split('\n').filter((l) => !/^(HELIX|SHEET)/.test(l)).join('\n'));
    expect(noSs.meta.hasSecondaryStructure).toBeUndefined();
    expect(noSs.atoms.every((a) => a.ss === undefined)).toBe(true);
  });

  it('tolerates CRLF line endings and trailing-whitespace-free short lines', () => {
    const crlf = parsePdb(PDB_FIXTURE.replace(/\n/g, '\r\n'));
    expect(crlf.atoms).toHaveLength(24);
    expect(crlf.atoms.map((a) => a.element)).toEqual(mol.atoms.map((a) => a.element));
    const short = parsePdb('ATOM      1  CA  GLY A   1      11.104   6.134  -6.504');
    expect(short.atoms).toHaveLength(1);
    expect(short.atoms[0]).toMatchObject({ element: 'C', name: 'CA', resName: 'GLY', x: 11.104, y: 6.134, z: -6.504 });
    expect(short.atoms[0].occupancy).toBeUndefined();
  });

  it('falls back to whitespace parsing for misaligned coordinates', () => {
    const m = parsePdb('HETATM    1  C1  LIG     1    1.5000  -2.2500  3.12500  1.00  0.00           C');
    expect(m.atoms[0]).toMatchObject({ x: 1.5, y: -2.25, z: 3.125 });
  });

  it('uses segment ids as chains when the chain column is blank (CHARMM/NAMD files)', () => {
    const m = parsePdb('ATOM      1  N   TIP3    1       0.000   0.000   0.000  1.00  0.00      WT1  O');
    expect(m.atoms[0]).toMatchObject({ resName: 'TIP3', chain: 'WT1', element: 'O' });
  });

  it('throws a friendly error when no coordinates can be read', () => {
    expect(() => parsePdb('ATOM      1  N   ALA A   1      xxxxxxx')).toThrow(/coordinates/);
  });
});

describe('PDB element inference', () => {
  it('follows the column-13/14 convention', () => {
    expect(inferPdbElement(' CA ', 'ALA', false)).toBe('C');
    expect(inferPdbElement('1HG1', 'THR', false)).toBe('H');
    expect(inferPdbElement('HG21', 'THR', false)).toBe('H');
    expect(inferPdbElement('FE  ', 'HEM', true)).toBe('Fe');
    expect(inferPdbElement(' NA ', 'HEM', true)).toBe('N');
    expect(inferPdbElement('NA  ', 'HEM', true)).toBe('N'); // heme pyrrole N written left-justified
    expect(inferPdbElement('NA  ', 'NA', true)).toBe('Na');
    expect(inferPdbElement('CA  ', 'CA', true)).toBe('Ca');
    expect(inferPdbElement('SE  ', 'MSE', true)).toBe('Se');
    expect(inferPdbElement('BR1 ', 'LIG', true)).toBe('Br');
    expect(inferPdbElement(' D1 ', 'LIG', true)).toBe('H');
  });

  it('recognises monatomic ions written by MD packages (ATOM records, charge suffixes, CHARMM names)', () => {
    // GROMACS / AMBER / CHARMM write ions as ATOM records, often without element columns.
    expect(inferPdbElement('NA  ', 'NA', false)).toBe('Na');
    expect(inferPdbElement(' NA ', 'NA', false)).toBe('Na');
    expect(inferPdbElement('CL  ', 'CL', false)).toBe('Cl');
    expect(inferPdbElement('MG  ', 'MG', false)).toBe('Mg');
    expect(inferPdbElement('ZN  ', 'ZN', false)).toBe('Zn');
    expect(inferPdbElement('Na+ ', 'Na+', true)).toBe('Na');
    expect(inferPdbElement('Cl- ', 'Cl-', false)).toBe('Cl');
    expect(inferPdbElement('ZN2 ', 'ZN2', true)).toBe('Zn');
    expect(inferPdbElement(' SOD', 'SOD', false)).toBe('Na');
    expect(inferPdbElement(' CLA', 'CLA', false)).toBe('Cl');
    expect(inferPdbElement(' POT', 'POT', false)).toBe('K');
    expect(inferPdbElement(' CAL', 'CAL', false)).toBe('Ca');
    // Ordinary atoms are unaffected.
    expect(inferPdbElement(' CA ', 'ALA', false)).toBe('C');
    expect(inferPdbElement(' N  ', 'NA', false)).toBe('N');
    expect(inferPdbElement(' I  ', 'IOD', true)).toBe('I');
    // Groups named like their residue are not superheavy "ions" (NH2 → Nh, BH4 → Bh, NO3 → No).
    expect(inferPdbElement('NH2 ', 'NH2', false)).toBe('N');
    expect(inferPdbElement('NH2 ', 'NH2', true)).toBe('N');
    expect(inferPdbElement('BH4 ', 'BH4', true)).toBe('B');
    expect(inferPdbElement('NO3 ', 'NO3', false)).toBe('N');
    const m = parsePdb('ATOM      1 SOD  SOD I   1       0.000   0.000   0.000  1.00  0.00      IONS\nATOM      2  NA   NA X   2       5.000   0.000   0.000  1.00  0.00\n');
    expect(m.atoms.map((a) => a.element)).toEqual(['Na', 'Na']);
  });
});

/** One fixed-column ATOM / HETATM record (chain A), with optional element columns. */
function pdbLine(record: 'ATOM' | 'HETATM', serial: number, nameField: string, resName: string, resSeq: number, x: number, element = ''): string {
  const res = resName.length >= 4 ? resName : resName.padStart(3) + ' ';
  return (
    record.padEnd(6) + String(serial).padStart(5) + ' ' + nameField.padEnd(4) + ' ' + res + 'A' + String(resSeq).padStart(4) + '    ' +
    x.toFixed(3).padStart(8) + '   0.000   0.000  1.00  0.00' + ' '.repeat(10) + element.padStart(2)
  ).trimEnd();
}

describe('PDB element inference from residue context', () => {
  it('reads heme iron in ATOM records without turning protein carbons into metals', () => {
    expect(inferPdbElement('FE  ', 'HEM', false)).toBe('Fe');
    // CHARMM / NAMD write cofactors as ATOM records and shift short names to column 14.
    expect(inferPdbElement(' FE ', 'HEM', false)).toBe('Fe');
    expect(inferPdbElement(' FE ', 'HEME', false)).toBe('Fe');
    expect(inferPdbElement(' FE ', 'HEM', true)).toBe('Fe');
    expect(inferPdbElement('FE1 ', 'SF4', false)).toBe('Fe');
    expect(inferPdbElement(' CU1', 'CUA', false)).toBe('Cu');
    // The other heme atoms keep their one-letter elements.
    for (const field of ['NA  ', ' NA ', 'CHA ', 'CAA ', 'CMA ', 'C1A ', 'O1A ']) expect(inferPdbElement(field, 'HEM', false)).toBe(field.trim()[0]);
    // Other ligands written as ATOM records: two-letter elements from column 13, one-letter from 14.
    expect(inferPdbElement('CL1 ', 'LIG', false)).toBe('Cl');
    expect(inferPdbElement(' CL1', 'LIG', false)).toBe('C');
    expect(inferPdbElement('BR  ', 'LIG', false)).toBe('Br');
    expect(inferPdbElement('CD11', 'LIG', false)).toBe('C'); // 4-character names start in column 13 anyway
    expect(inferPdbElement(' FE ', 'LIG', false)).toBe('F'); // convention: column 14 = one-letter element
    // Standard residues (also AMBER / GROMACS / CHARMM variants): CA, CD … are carbon in any column and record.
    for (const res of ['ARG', 'GLU', 'LYS', 'PRO', 'ILE', 'GLN', 'HISD', 'NLYS', 'GLUP', 'CPRO']) {
      for (const field of ['CD  ', ' CD ']) {
        expect(inferPdbElement(field, res, false)).toBe('C');
        expect(inferPdbElement(field, res, true)).toBe('C');
      }
    }
    for (const res of ['ALA', 'GLY', 'UNK', 'HSD', 'CALA']) expect(inferPdbElement('CA  ', res, false)).toBe('C');
    expect(inferPdbElement('NE  ', 'ARG', false)).toBe('N');
    expect(inferPdbElement('HG21', 'ILE', false)).toBe('H');
    expect(inferPdbElement('CD1 ', 'ILE', true)).toBe('C');
    // Selenium of seleno amino acids, also as ATOM records.
    expect(inferPdbElement('SE  ', 'MSE', false)).toBe('Se');
    expect(inferPdbElement(' SE ', 'SEC', false)).toBe('Se');
    expect(inferPdbElement(' SD ', 'MET', false)).toBe('S');
    // A first letter that is no element falls back to the two-letter table instead of X.
    expect(inferPdbElement(' MG ', 'CLA', false)).toBe('Mg'); // chlorophyll a
    expect(inferPdbElement(' ZN ', 'LIG', false)).toBe('Zn');
    expect(inferPdbElement(' MW ', 'TIP4', false)).toBe('X'); // TIP4P virtual site
  });

  it('never reads GROMACS virtual sites of standard residues as metals', () => {
    // pdb2gmx -vsite dummy masses (N-terminal MN1/MN2, Lys MNZ1/MNZ2) have no element: not manganese.
    for (const [field, res] of [[' MN1', 'MET'], [' MN2', 'GLY'], ['MNZ1', 'LYS'], ['MNZ2', 'LYS'], ['MN1 ', 'NALA'], [' MN1', 'ALA']]) {
      expect(inferPdbElement(field, res, false)).toBe('X');
      expect(inferPdbElement(field, res, true)).toBe('X');
    }
    // Ligands and ions keep the two-letter fallback.
    expect(inferPdbElement(' MN ', 'LIG', false)).toBe('Mn');
  });

  it('reads HETATM UNK (and caps) as ligands, like the residue classification does', () => {
    // Many tools name a ligand UNK; as HETATM it is no amino acid, so column-13 FE / CL / BR are metals / halogens.
    expect(inferPdbElement('FE  ', 'UNK', true)).toBe('Fe');
    expect(inferPdbElement('CL1 ', 'UNK', true)).toBe('Cl');
    expect(inferPdbElement('BR  ', 'UNK', true)).toBe('Br');
    expect(inferPdbElement('ZN  ', 'UNK', true)).toBe('Zn');
    expect(inferPdbElement(' C1 ', 'UNK', true)).toBe('C');
    // ATOM UNK is an unknown amino acid (CA-only traces): carbon.
    expect(inferPdbElement('CA  ', 'UNK', false)).toBe('C');
    expect(inferPdbElement('CD  ', 'UNK', false)).toBe('C');
    // HETATM caps keep their one-letter elements.
    for (const [f, r] of [[' CH3', 'ACE'], ['CH3 ', 'ACE'], [' C  ', 'ACE'], [' N  ', 'NME'], [' N  ', 'NH2']]) {
      expect(inferPdbElement(f, r, true)).toBe(f.trim()[0]);
    }
  });

  it('parses a heme written as ATOM records without element columns', () => {
    const m = parsePdb(
      [pdbLine('ATOM', 1, 'FE  ', 'HEM', 1, 0), pdbLine('ATOM', 2, ' NA ', 'HEM', 1, 2), pdbLine('ATOM', 3, 'CHA ', 'HEM', 1, 3), pdbLine('ATOM', 4, ' CA ', 'ALA', 2, 9)].join('\n'),
    );
    expect(m.atoms.map((a) => a.element)).toEqual(['Fe', 'N', 'C', 'C']);
  });

  it('reads single-atom CHARMM ions whose residue name carries the charge (ZN2, CD2, CAL)', () => {
    const ions = parsePdb(
      [
        pdbLine('ATOM', 1, ' ZN ', 'ZN2', 1, 0),
        pdbLine('ATOM', 2, ' CD ', 'CD2', 2, 5),
        pdbLine('ATOM', 3, ' CA ', 'CAL', 3, 10),
        pdbLine('HETATM', 4, 'CA  ', 'CAL', 4, 15),
        pdbLine('ATOM', 5, ' CU ', 'CU1', 5, 20),
        pdbLine('ATOM', 6, ' NA ', 'SOD', 6, 25),
        pdbLine('ATOM', 7, ' CL ', 'CLA', 7, 30),
      ].join('\n'),
    );
    expect(ions.atoms.map((a) => a.element)).toEqual(['Zn', 'Cd', 'Ca', 'Ca', 'Cu', 'Na', 'Cl']);
    // Never in multi-atom residues, against element columns, or for residue names unrelated to the atom.
    const others = parsePdb(
      [
        pdbLine('HETATM', 1, ' CA ', 'CAL', 1, 0),
        pdbLine('HETATM', 2, ' CB ', 'CAL', 1, 1.5),
        pdbLine('HETATM', 3, ' CD ', 'CD2', 2, 5),
        pdbLine('HETATM', 4, ' OD ', 'CD2', 2, 6.2),
        pdbLine('ATOM', 5, ' CD ', 'CD2', 3, 10, 'C'),
        pdbLine('ATOM', 6, ' CA ', 'UNK', 4, 15), // CA-only trace
        pdbLine('ATOM', 7, ' CA ', 'ALA', 5, 19),
        pdbLine('HETATM', 8, ' CA ', 'LIG', 6, 25),
        pdbLine('HETATM', 9, ' C  ', 'C1', 7, 30),
      ].join('\n'),
    );
    expect(others.atoms.map((a) => a.element)).toEqual(['C', 'C', 'C', 'O', 'C', 'C', 'C', 'C', 'C']);
  });
});

describe('hybrid-36', () => {
  it('encodes and decodes beyond the decimal range', () => {
    expect(encodeHybrid36(5, 99999)).toBe('99999');
    expect(encodeHybrid36(5, 100000)).toBe('A0000');
    expect(decodeHybrid36(5, 'A0000')).toBe(100000);
    expect(encodeHybrid36(4, 10000)).toBe('A000');
    expect(decodeHybrid36(4, 'A000')).toBe(10000);
    expect(decodeHybrid36(5, 'a0000')).toBe(100000 + 26 * 36 ** 4);
    for (const v of [1, 9999, 10000, 123456, 2_000_000, 50_000_000]) expect(decodeHybrid36(5, encodeHybrid36(5, v))).toBe(v);
    expect(decodeHybrid36(4, '  -5')).toBe(-5);
    expect(Number.isNaN(decodeHybrid36(5, '     '))).toBe(true);
  });
});

describe('writePdb', () => {
  const mol = parsePdb(PDB_FIXTURE);
  const text = writePdb(mol);
  const lines = text.split('\n');

  it('writes ATOM records with exact column layout', () => {
    const line = lines.find((l) => l.startsWith('ATOM') && l.includes(' CA  THR A   1'))!;
    expect(line).toBeDefined();
    expect(line.substring(0, 6)).toBe('ATOM  ');
    expect(line.substring(12, 16)).toBe(' CA ');
    expect(line.substring(17, 20)).toBe('THR');
    expect(line.charAt(21)).toBe('A');
    expect(line.substring(22, 26)).toBe('   1');
    expect(line.substring(30, 38)).toBe('  16.967');
    expect(line.substring(38, 46)).toBe('  12.784');
    expect(line.substring(46, 54)).toBe('   4.338');
    expect(line.substring(54, 60)).toBe('  1.00');
    expect(line.substring(60, 66)).toBe(' 10.80');
    expect(line.substring(76, 78)).toBe(' C');
    expect(line).toHaveLength(80);
    const ca = lines.find((l) => l.startsWith('HETATM') && l.substring(17, 20) === ' CA')!;
    expect(ca.substring(12, 16)).toBe('CA  '); // two-letter element starts in column 13
    expect(ca.substring(76, 80)).toBe('CA2+');
    const zn = lines.find((l) => l.startsWith('HETATM') && l.substring(17, 20) === ' ZN')!;
    expect(zn.substring(76, 78)).toBe('ZN');
  });

  it('writes TER after the polymer chain, HELIX/SHEET, CONECT for hetero bonds and END', () => {
    const ter = lines.findIndex((l) => l.startsWith('TER'));
    const firstHet = lines.findIndex((l) => l.startsWith('HETATM'));
    expect(ter).toBeGreaterThan(0);
    expect(ter).toBeLessThan(firstHet);
    expect(lines.filter((l) => l.startsWith('HELIX'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('SHEET'))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('CONECT'))).toHaveLength(2);
    expect(text.trimEnd().endsWith('END')).toBe(true);
  });

  it('round-trips atoms, residues, charges, secondary structure and bonds', () => {
    const back = parsePdb(text);
    expect(back.atoms).toHaveLength(mol.atoms.length);
    back.atoms.forEach((a, i) => {
      const o = mol.atoms[i];
      expect(a.element).toBe(o.element);
      expect(a.name).toBe(o.name);
      expect(a.resName).toBe(o.resName);
      expect(a.resSeq).toBe(o.resSeq);
      expect(a.chain).toBe(o.chain);
      expect(a.hetero).toBe(o.hetero);
      expect(a.charge).toBe(o.charge);
      expect(a.ss).toBe(o.ss);
      expect(a.x).toBeCloseTo(o.x, 3);
      expect(a.y).toBeCloseTo(o.y, 3);
      expect(a.z).toBeCloseTo(o.z, 3);
      expect(a.bfactor).toBeCloseTo(o.bfactor!, 2);
    });
    expect(back.meta.hasSecondaryStructure).toBe(true);
    expect(back.bonds).toHaveLength(1);
    expect(back.meta.title).toBe(mol.meta.title);
  });

  it('writes small molecules without residue info as HETATM UNL with unique names and all bonds', () => {
    const small = buildMolecule(
      'formaldehyde',
      [
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'O', x: 1.205, y: 0, z: 0 },
        { element: 'H', x: -0.55, y: 0.94, z: 0 },
        { element: 'H', x: -0.55, y: -0.94, z: 0 },
      ],
      [
        { a: 0, b: 1, order: 2 },
        { a: 0, b: 2 },
        { a: 0, b: 3 },
      ],
    );
    const out = writePdb(small);
    const het = out.split('\n').filter((l) => l.startsWith('HETATM'));
    expect(het.map((l) => l.substring(12, 16))).toEqual([' C1 ', ' O1 ', ' H1 ', ' H2 ']);
    expect(het.every((l) => l.substring(17, 26) === 'UNL A   1')).toBe(true);
    const back = parsePdb(out);
    expect(back.atoms.map((a) => a.element)).toEqual(['C', 'O', 'H', 'H']);
    expect(back.bonds.map((b) => [b.a, b.b])).toEqual([
      [1, 2],
      [1, 3],
      [1, 4],
    ]);
    expect(back.atoms[1].x).toBeCloseTo(1.205, 3);
  });

  it('never shifts columns for large or negative coordinates', () => {
    const m = buildMolecule('big', [{ element: 'C', x: -999.9999, y: 12345.678, z: -0.0001 }]);
    const line = writePdb(m).split('\n').find((l) => l.startsWith('HETATM'))!;
    expect(line.substring(30, 38)).toBe('-1000.00');
    expect(line.substring(38, 46)).toBe('12345.68');
    expect(line.substring(46, 54)).toBe('   0.000');
    expect(line.substring(76, 78)).toBe(' C');
  });
});

describe('PDB performance', () => {
  it('parses a 100k-atom file quickly', () => {
    const base = 'ATOM  %%%%%  CA  ALA A####      11.104   6.134  -6.504  1.00 21.50           C  ';
    const lines: string[] = [];
    for (let i = 1; i <= 100_000; i++) {
      lines.push(base.replace('%%%%%', encodeHybrid36(5, i)).replace('####', encodeHybrid36(4, 1 + (i >> 3))));
    }
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(8_000_000);
    const t0 = performance.now();
    const m = parsePdb(text);
    const ms = performance.now() - t0;
    expect(m.atoms).toHaveLength(100_000);
    expect(ms).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// PDBQT (AutoDock / Vina): partial charge in columns 71–76, AutoDock atom type from column 78
// ---------------------------------------------------------------------------

/** Receptor as AutoDockTools writes it (polar H only, AD4 types incl. A, OA, SA, NA, HD and metals). */
const PDBQT_RECEPTOR = `
REMARK  receptor prepared for AutoDock
ATOM      1  N   SER A   1      -2.367   4.481 -16.909  1.00  0.00    -0.066 N
ATOM      2  CA  SER A   1      -1.874   3.856 -15.678  1.00  0.00     0.186 C
ATOM      3  OG  SER A   1      -0.612   3.172 -15.876  1.00  0.00    -0.398 OA
ATOM      4  HG  SER A   1      -0.135   3.081 -15.034  1.00  0.00     0.209 HD
ATOM      5  CG  PHE A   2       1.000   2.000   3.000  1.00  0.00    -0.056 A
ATOM      6  SD  MET A   3       4.000   2.000   3.000  1.00  0.00    -0.173 SA
ATOM      7  NE2 HIS A   4       7.000   2.000   3.000  1.00  0.00    -0.254 NA
HETATM    8 ZN    ZN A 501      10.000   2.000   3.000  1.00  0.00     2.000 Zn
HETATM    9 CA    CA A 502      13.000   2.000   3.000  1.00  0.00     2.000 Ca
HETATM   10 FE   HEM A 503      16.000   2.000   3.000  1.00  0.00     0.000 Fe
HETATM   11 MG    MG A 504      19.000   2.000   3.000  1.00  0.00     2.000 MG
HETATM   12 NA    NA A 505      22.000   2.000   3.000  1.00  0.00     1.000 Na
HETATM   13 NA    NA A 506      25.000   2.000   3.000  1.00  0.00     1.000 NA
HETATM   14 CL    CL A 507      28.000   2.000   3.000  1.00  0.00    -1.000 CL
TER
END
`.slice(1);

/** Docked ligand poses as Vina writes them (MODEL per pose, ROOT / BRANCH torsion tree, Open Babel-style signed charges). */
const PDBQT_LIGAND = `
MODEL 1
REMARK VINA RESULT:    -7.512      0.000      0.000
REMARK  Name = ligand
REMARK  1 active torsions:
ROOT
ATOM      1  C1  UNL     1       1.000   2.000   3.000  1.00  0.00    +0.034 A
ATOM      2  Cl1 UNL     1       2.700   2.000   3.000  1.00  0.00    -0.084 Cl
ATOM      3  Br1 UNL     1      -0.900   2.000   3.000  1.00  0.00    -0.060 Br
ATOM      4  N1  UNL     1       1.000   3.400   3.000  1.00  0.00    -0.200 NA
ATOM      5  O1  UNL     1       1.000   0.600   3.000  1.00  0.00    -0.300 OA
ATOM      6  H1  UNL     1       1.000   4.400   3.000  1.00  0.00    +0.200 HD
ENDROOT
BRANCH  10  11
ATOM      7  S1  UNL     1       4.000   2.000   3.000  1.00  0.00    -0.150 SA
ATOM      8  F1  UNL     1       5.000   2.000   3.000  1.00  0.00    -0.200 F
ATOM      9  I1  UNL     1       6.000   2.000   3.000  1.00  0.00    -0.050 I
ATOM     10  P1  UNL     1       7.000   2.000   3.000  1.00  0.00    +0.500 P
ATOM     11  C2  UNL     1       8.000   2.000   3.000  1.00  0.00    +0.100 C
ATOM     12  C3  UNL     1       9.000   2.000   3.000  1.00  0.00    +0.100 CG0
ENDBRANCH  10  11
TORSDOF 1
ENDMDL
MODEL 2
REMARK VINA RESULT:    -7.512      0.000      0.000
REMARK  Name = ligand
REMARK  1 active torsions:
ROOT
ATOM      1  C1  UNL     1      51.000   2.000   3.000  1.00  0.00    +0.034 A
ATOM      2  Cl1 UNL     1      52.700   2.000   3.000  1.00  0.00    -0.084 Cl
ATOM      3  Br1 UNL     1      49.100   2.000   3.000  1.00  0.00    -0.060 Br
ATOM      4  N1  UNL     1      51.000   3.400   3.000  1.00  0.00    -0.200 NA
ATOM      5  O1  UNL     1      51.000   0.600   3.000  1.00  0.00    -0.300 OA
ATOM      6  H1  UNL     1      51.000   4.400   3.000  1.00  0.00    +0.200 HD
ENDROOT
BRANCH  10  11
ATOM      7  S1  UNL     1      54.000   2.000   3.000  1.00  0.00    -0.150 SA
ATOM      8  F1  UNL     1      55.000   2.000   3.000  1.00  0.00    -0.200 F
ATOM      9  I1  UNL     1      56.000   2.000   3.000  1.00  0.00    -0.050 I
ATOM     10  P1  UNL     1      57.000   2.000   3.000  1.00  0.00    +0.500 P
ATOM     11  C2  UNL     1      58.000   2.000   3.000  1.00  0.00    +0.100 C
ATOM     12  C3  UNL     1      59.000   2.000   3.000  1.00  0.00    +0.100 CG0
ENDBRANCH  10  11
TORSDOF 1
ENDMDL
`.slice(1);

describe('PDBQT', () => {
  it('detects the layout of PDBQT records only', () => {
    expect(pdbqtAtomType(PDBQT_RECEPTOR.split('\n')[1])).toBe('N');
    expect(pdbqtAtomType(PDBQT_RECEPTOR.split('\n')[3])).toBe('OA');
    expect(pdbqtAtomType(PDBQT_LIGAND.split('\n').find((l) => l.includes('CG0'))!)).toBe('CG0');
    // plain PDB records (segment id in 73–76, element in 77–78, charge in 79–80) never match
    for (const line of PDB_FIXTURE.split('\n')) if (/^(ATOM|HETATM)/.test(line)) expect(pdbqtAtomType(line), line).toBeUndefined();
    expect(pdbqtAtomType('ATOM      1  N   SER A   1      -2.367   4.481 -16.909  1.00 20.00      PROA N1+')).toBeUndefined();
    expect(pdbqtAtomType('HETATM    9 CA    CA A 502      13.000   2.000   3.000  1.00  0.00          CA2+')).toBeUndefined();
  });

  it('maps AutoDock types to elements (NA is a nitrogen acceptor, CA calcium, A aromatic carbon)', () => {
    const cases: [string, string | undefined][] = [
      ['A', 'C'], ['C', 'C'], ['N', 'N'], ['NA', 'N'], ['NS', 'N'], ['OA', 'O'], ['OS', 'O'], ['SA', 'S'], ['S', 'S'],
      ['H', 'H'], ['HD', 'H'], ['HS', 'H'], ['P', 'P'], ['F', 'F'], ['I', 'I'], ['Cl', 'Cl'], ['CL', 'Cl'], ['Br', 'Br'],
      ['BR', 'Br'], ['Fe', 'Fe'], ['FE', 'Fe'], ['Zn', 'Zn'], ['ZN', 'Zn'], ['Mg', 'Mg'], ['MG', 'Mg'], ['Mn', 'Mn'],
      ['MN', 'Mn'], ['Ca', 'Ca'], ['CA', 'Ca'], ['G', 'C'], ['GA', 'C'], ['J', 'C'], ['Q', 'C'], ['CG0', 'C'],
      // Vina element-case types for other metals / elements
      ['Cu', 'Cu'], ['Na', 'Na'], ['K', 'K'], ['Hg', 'Hg'], ['Si', 'Si'], ['B', 'B'],
      // pseudo atoms and unknown all-capital types: left to the atom name
      ['W', undefined], ['Z', undefined], ['G0', undefined], ['CU', undefined], ['XX', undefined],
    ];
    for (const [type, el] of cases) expect(autodockTypeElement(type), type).toBe(el);
    // a sodium ion residue keeps sodium whatever the type's case; a ligand nitrogen typed NA stays N
    expect(autodockTypeElement('NA', 'NA', 'NA')).toBe('Na');
    expect(autodockTypeElement('NA', 'N1', 'UNL')).toBe('N');
    expect(autodockTypeElement('CA', 'CA', 'CA')).toBe('Ca');
  });

  it('reads receptor elements from the AutoDock types, not from the charge / type columns', () => {
    const mol = parseMolecule(PDBQT_RECEPTOR, detectFormat('receptor.pdbqt', PDBQT_RECEPTOR)!, 'receptor');
    expect(mol.atoms.map((a) => a.element)).toEqual(['N', 'C', 'O', 'H', 'C', 'S', 'N', 'Zn', 'Ca', 'Fe', 'Mg', 'Na', 'Na', 'Cl']);
    // the partial charge (columns 71–76) is neither a segment id nor a formal charge
    for (const a of mol.atoms) {
      expect(a.chain).toBe('A');
      expect(a.charge).toBeUndefined();
    }
    expect(mol.atoms[1]).toMatchObject({ name: 'CA', resName: 'SER', resSeq: 1, hetero: false });
  });

  it('reads docked ligand poses: first model, Cl / Br / acceptor types, no chain from the charge column', () => {
    const mol = parsePdb(PDBQT_LIGAND, 'ligand');
    expect(mol.atoms.map((a) => a.element)).toEqual(['C', 'Cl', 'Br', 'N', 'O', 'H', 'S', 'F', 'I', 'P', 'C', 'C']);
    expect(mol.atoms.every((a) => a.x < 20)).toBe(true); // the second pose is ignored
    for (const a of mol.atoms) {
      expect(a.chain).toBeUndefined();
      expect(a.charge).toBeUndefined();
    }
    // the same text sniffed without a file name
    expect(sniffFormat(PDBQT_LIGAND)).toBe('pdb');
    expect(parseMolecule(PDBQT_LIGAND, 'pdb').atoms.map((a) => a.element)).toEqual(mol.atoms.map((a) => a.element));
  });

  it('falls back to the atom name for pseudo atoms and unknown types; pdbqt: false reads plain PDB columns', () => {
    const lines = PDBQT_LIGAND.split('\n');
    const k = lines.findIndex((l) => l.includes(' Br1 '));
    const pseudo = lines.slice();
    pseudo[k] = pseudo[k].replace(/Br$/, 'W ');
    expect(parsePdb(pseudo.join('\n')).atoms[2].element).toBe('B'); // name 'Br1' in column 14 → one-letter convention
    expect(parsePdb(PDBQT_LIGAND, 'x', { pdbqt: false }).atoms[1].element).toBe('C'); // the old misreading of 'Cl'
  });

  it('leaves plain PDB parsing unchanged', () => {
    const plain = parsePdb(PDB_FIXTURE);
    expect(parsePdb(PDB_FIXTURE, undefined, { pdbqt: false })).toEqual(plain);
    // a segment id and element / charge columns are still read
    const line = 'HETATM    9 CA    CA A 502      13.000   2.000   3.000  1.00  0.00      IONSCA2+';
    const ion = parsePdb(line).atoms[0];
    expect(ion).toMatchObject({ element: 'Ca', charge: 2, chain: 'A' });
    const seg = parsePdb('ATOM      1  N   SER     1      -2.367   4.481 -16.909  1.00 20.00      PROA  N').atoms[0];
    expect(seg).toMatchObject({ element: 'N', chain: 'PROA' });
  });
});
