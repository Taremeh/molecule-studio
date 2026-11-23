import { describe, expect, it } from 'vitest';
import { parseXyz, writeXyz } from './xyz';
import { WATER_XYZ } from './__fixtures__/fixtures';
import { buildMolecule } from '../core/molecule';

describe('parseXyz', () => {
  const mol = parseXyz(WATER_XYZ);

  it('reads the first frame only, with atomic numbers and extra columns', () => {
    expect(mol.atoms).toHaveLength(3);
    expect(mol.atoms.map((a) => a.element)).toEqual(['O', 'H', 'H']);
    expect(mol.atoms[0]).toMatchObject({ x: 0, y: 0, z: 0.1173 });
    expect(mol.atoms[1]).toMatchObject({ x: 0, y: 0.7572, z: -0.4692 });
    expect(mol.bonds).toHaveLength(0);
  });

  it('uses the comment line as title (and as name only when it looks like one)', () => {
    expect(mol.meta).toMatchObject({ format: 'xyz', title: 'water, energy=-76.4 Hartree' });
    expect(mol.name).toBe('Untitled');
    expect(parseXyz('1\nHelium atom\nHe 0 0 0\n').name).toBe('Helium atom');
    expect(parseXyz(WATER_XYZ, 'water.xyz').name).toBe('water.xyz');
  });

  it('normalizes element case and labels', () => {
    const m = parseXyz('4\n\nCL 0 0 0\nc1 1 0 0\nfe 2 0 0\n26 3 0 0\n');
    expect(m.atoms.map((a) => a.element)).toEqual(['Cl', 'C', 'Fe', 'Fe']);
  });

  it('accepts files without a header and Fortran exponents', () => {
    const m = parseXyz('C 0.0 0.0 0.0\nO 1.2D+00 0.0 0.0\n');
    expect(m.atoms).toHaveLength(2);
    expect(m.atoms[1].x).toBeCloseTo(1.2, 6);
  });

  it('gives friendly errors', () => {
    expect(() => parseXyz('')).toThrow(/empty/);
    expect(() => parseXyz('hello\nworld\n')).toThrow(/number of atoms/);
    expect(() => parseXyz('2\n\nC 0 0 0\nO 1.2 zero 0\n')).toThrow(/line 4/);
  });
});

describe('writeXyz', () => {
  it('round-trips elements and coordinates', () => {
    const m = buildMolecule('Ethyne', [
      { element: 'C', x: 0, y: 0, z: 0.6013 },
      { element: 'C', x: 0, y: 0, z: -0.6013 },
      { element: 'H', x: 0, y: 0, z: 1.6644 },
      { element: 'H', x: 0, y: 0, z: -1.6644 },
    ]);
    const text = writeXyz(m);
    expect(text.split('\n')[0]).toBe('4');
    expect(text.split('\n')[1]).toBe('Ethyne');
    const back = parseXyz(text);
    expect(back.name).toBe('Ethyne');
    expect(back.atoms.map((a) => a.element)).toEqual(['C', 'C', 'H', 'H']);
    back.atoms.forEach((a, i) => {
      expect(a.x).toBeCloseTo(m.atoms[i].x, 6);
      expect(a.z).toBeCloseTo(m.atoms[i].z, 6);
    });
  });
});
