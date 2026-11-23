import { describe, expect, it } from 'vitest';
import { detectFormat, isFlat2D, parseMolecule, sniffFormat, writeMolecule, type FileFormat, type WritableFormat } from './formats';
import {
  ACETAMIDE_MOL2,
  ACETATE_V3000,
  BETAINE_SDF,
  CCD_FIXTURE,
  CIF_FIXTURE,
  DIPEPTIDE_MOL2,
  PDB_FIXTURE,
  PYRIDINIUM_MOL,
  WATER_XYZ,
} from './__fixtures__/fixtures';
import type { Molecule } from '../core/types';
import { getTopology } from '../core/molecule';

describe('detectFormat', () => {
  it('uses the extension first', () => {
    const cases: [string, FileFormat][] = [
      ['1crn.pdb', 'pdb'],
      ['PDB1CRN.ENT', 'pdb'],
      ['4v6x.cif', 'cif'],
      ['x.mmcif', 'cif'],
      ['ligands.sdf', 'sdf'],
      ['benzene.mol', 'sdf'],
      ['a.sd', 'sdf'],
      ['traj.xyz', 'xyz'],
      ['dock.mol2', 'mol2'],
      ['protein.pdb.txt', 'pdb'],
    ];
    for (const [name, fmt] of cases) expect(detectFormat(name, '')).toBe(fmt);
  });

  it('sniffs the content when the extension is unknown or missing', () => {
    const cases: [string, FileFormat][] = [
      [PDB_FIXTURE, 'pdb'],
      [CIF_FIXTURE, 'cif'],
      [CCD_FIXTURE, 'cif'],
      [BETAINE_SDF, 'sdf'],
      [PYRIDINIUM_MOL, 'sdf'],
      [ACETATE_V3000, 'sdf'],
      [ACETAMIDE_MOL2, 'mol2'],
      [DIPEPTIDE_MOL2, 'mol2'],
      [WATER_XYZ, 'xyz'],
      ['ATOM      1  CA  GLY A   1      11.104   6.134  -6.504  1.00  0.00           C', 'pdb'],
    ];
    for (const [text, fmt] of cases) {
      expect(detectFormat('pasted.txt', text)).toBe(fmt);
      expect(detectFormat(null, text)).toBe(fmt);
    }
  });

  it('returns null for unrecognised content', () => {
    expect(detectFormat(null, 'hello world\nthis is not a molecule')).toBeNull();
    expect(detectFormat('notes.docx')).toBeNull();
    expect(sniffFormat('')).toBeNull();
  });
});

describe('parseMolecule', () => {
  it('dispatches to every parser', () => {
    expect(parseMolecule(PDB_FIXTURE, 'pdb').atoms).toHaveLength(24);
    expect(parseMolecule(CIF_FIXTURE, 'cif').atoms).toHaveLength(14);
    expect(parseMolecule(BETAINE_SDF, 'sdf').atoms).toHaveLength(19);
    expect(parseMolecule(WATER_XYZ, 'xyz').atoms).toHaveLength(3);
    expect(parseMolecule(ACETAMIDE_MOL2, 'mol2').atoms).toHaveLength(9);
  });

  it('strips a byte-order mark', () => {
    expect(parseMolecule('﻿' + WATER_XYZ, 'xyz').atoms[0].element).toBe('O');
  });

  it('gives friendly errors', () => {
    expect(() => parseMolecule('   \n', 'pdb')).toThrow('The file is empty.');
    expect(() => parseMolecule('\u001f\u008b\b\0\0\0binary', 'pdb')).toThrow(/binary or compressed/);
    // Wrong format selected: the message points to the real one.
    expect(() => parseMolecule(PDB_FIXTURE, 'sdf')).toThrow(/looks like PDB/);
    expect(() => parseMolecule(ACETAMIDE_MOL2, 'pdb')).toThrow(/looks like MOL2/);
  });
});

/** Compare two molecules on what every format preserves. */
function expectSameAtoms(a: Molecule, b: Molecule) {
  expect(b.atoms.map((x) => x.element)).toEqual(a.atoms.map((x) => x.element));
  // PDB stores 3 decimals: allow the half-unit rounding error of the last digit.
  const tol = 0.0005 + 1e-9;
  b.atoms.forEach((x, i) => {
    expect(Math.abs(x.x - a.atoms[i].x)).toBeLessThanOrEqual(tol);
    expect(Math.abs(x.y - a.atoms[i].y)).toBeLessThanOrEqual(tol);
    expect(Math.abs(x.z - a.atoms[i].z)).toBeLessThanOrEqual(tol);
  });
}
const bondSet = (m: Molecule) => m.bonds.map((b) => `${Math.min(b.a, b.b)}-${Math.max(b.a, b.b)}`).sort();
const charges = (m: Molecule) => m.atoms.map((a) => a.charge ?? 0);

describe('cross-format round trips (parse → write → parse)', () => {
  const sources: [string, string, FileFormat][] = [
    ['crambin fragment', PDB_FIXTURE, 'pdb'],
    ['mmCIF', CIF_FIXTURE, 'cif'],
    ['betaine', BETAINE_SDF, 'sdf'],
    ['pyridinium', PYRIDINIUM_MOL, 'sdf'],
    ['acetate V3000', ACETATE_V3000, 'sdf'],
    ['acetamide', ACETAMIDE_MOL2, 'mol2'],
    ['dipeptide', DIPEPTIDE_MOL2, 'mol2'],
    ['water', WATER_XYZ, 'xyz'],
  ];
  const targets: WritableFormat[] = ['pdb', 'sdf', 'xyz', 'mol2'];

  for (const [label, text, fmt] of sources) {
    for (const target of targets) {
      it(`${label} (${fmt}) → ${target}`, () => {
        const a = parseMolecule(text, fmt, label);
        const b = parseMolecule(writeMolecule(a, target), target, label);
        expectSameAtoms(a, b);
        if (target === 'xyz') return; // XYZ stores elements and coordinates only
        // PDB keeps bonds of hetero / non-residue atoms only (polymer bonds are re-perceived on load).
        const polymer = getTopology(a).residues.some((r) => r.kind === 'protein' || r.kind === 'nucleic');
        if (target !== 'pdb' || !polymer) expect(bondSet(b)).toEqual(bondSet(a));
        expect(charges(b)).toEqual(charges(a));
        if (target !== 'pdb') expect(b.bonds.map((x) => x.order)).toEqual(a.bonds.map((x) => x.order));
      });
    }
  }
});

describe('writeMolecule', () => {
  it('rejects unknown formats', () => {
    const m = parseMolecule(WATER_XYZ, 'xyz');
    expect(() => writeMolecule(m, 'png' as WritableFormat)).toThrow(/Cannot export/);
  });
});

describe('isFlat2D', () => {
  it('flags MOL files with the 2D dimension code and zero z only', () => {
    const flat = PYRIDINIUM_MOL.replace('  MolStdio11222612003D', '  MolStdio11222612002D');
    expect(isFlat2D(flat, 'sdf', parseMolecule(flat, 'sdf'))).toBe(true);
    expect(isFlat2D(PYRIDINIUM_MOL, 'sdf', parseMolecule(PYRIDINIUM_MOL, 'sdf'))).toBe(false); // planar but 3D
    expect(isFlat2D(WATER_XYZ, 'xyz', parseMolecule(WATER_XYZ, 'xyz'))).toBe(false);
  });
});
