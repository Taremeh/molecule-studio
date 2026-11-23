import { describe, expect, it } from 'vitest';
import { parseSdf, parseSdfRecord, writeSdf } from './sdf';
import { ACETATE_V3000, BETAINE_SDF, PYRIDINIUM_MOL } from './__fixtures__/fixtures';
import { buildMolecule } from '../core/molecule';
import type { Molecule } from '../core/types';

const orders = (m: Molecule) => m.bonds.map((b) => b.order);
const charges = (m: Molecule) => m.atoms.map((a) => a.charge ?? 0);

describe('parseSdf (V2000)', () => {
  const mol = parseSdf(BETAINE_SDF);

  it('reads the first record only', () => {
    expect(mol.atoms).toHaveLength(19);
    expect(mol.bonds).toHaveLength(18);
  });

  it('reads coordinates, elements and bond orders', () => {
    expect(mol.atoms[0]).toMatchObject({ element: 'O', x: 1.6647, y: 1.2167, z: -0.0588 });
    expect(mol.atoms.map((a) => a.element).join('')).toBe('OONCCCCC' + 'H'.repeat(11));
    expect(mol.bonds[1]).toMatchObject({ a: 2, b: 8, order: 2 });
    expect(orders(mol).filter((o) => o === 2)).toHaveLength(1);
  });

  it('reads charges (M  CHG) and sets hasBondOrders', () => {
    expect(mol.atoms[0].charge).toBe(-1);
    expect(mol.atoms[2].charge).toBe(1);
    expect(charges(mol).reduce((s, c) => s + c, 0)).toBe(0);
    expect(mol.meta.hasBondOrders).toBe(true);
    expect(mol.meta.format).toBe('sdf');
  });

  it('reads SD data items into title / externalId', () => {
    expect(mol.meta.externalId).toBe('247');
    expect(mol.meta.title).toBe('2-(trimethylazaniumyl)acetate');
    const rec = parseSdfRecord(BETAINE_SDF);
    expect(rec.properties.get('PUBCHEM_MOLECULAR_FORMULA')).toBe('C5H11NO2');
  });

  it('names the molecule from the argument, else the (non-numeric) header line', () => {
    expect(parseSdf(BETAINE_SDF, 'betaine').name).toBe('betaine');
    expect(parseSdf(PYRIDINIUM_MOL).name).toBe('Pyridinium');
    // PubChem headers are CIDs: fall back to the IUPAC name rather than a bare number
    expect(parseSdf(BETAINE_SDF).name).toBe('2-(trimethylazaniumyl)acetate');
  });

  it('M  CHG supersedes atom-block charge codes', () => {
    // Atom-block code 3 (+1) on O1 but M  CHG only charges atom 3 → O1 must end up neutral.
    const text = BETAINE_SDF.replace('O   0  5  0', 'O   0  3  0').replace('M  CHG  2   1  -1   3   1', 'M  CHG  1   3   1');
    const m = parseSdf(text);
    expect(m.atoms[0].charge).toBeUndefined();
    expect(m.atoms[2].charge).toBe(1);
    // Without any M  CHG line the atom-block codes are used (5 → −1, 3 → +1).
    const blockOnly = parseSdf(BETAINE_SDF.replace(/^M {2}CHG.*\n/m, ''));
    expect(blockOnly.atoms[0].charge).toBe(-1);
    expect(blockOnly.atoms[2].charge).toBe(1);
  });

  it('maps aromatic bond type 4 to order 1.5', () => {
    const pyr = parseSdf(PYRIDINIUM_MOL);
    expect(orders(pyr).slice(0, 6)).toEqual([1.5, 1.5, 1.5, 1.5, 1.5, 1.5]);
    expect(pyr.atoms[0]).toMatchObject({ element: 'N', charge: 1 });
  });

  it('tolerates CRLF and gives friendly errors', () => {
    expect(parseSdf(BETAINE_SDF.replace(/\n/g, '\r\n')).atoms).toHaveLength(19);
    expect(() => parseSdf('just a name\n')).toThrow(/header is incomplete/);
    const truncated = BETAINE_SDF.split('\n').slice(0, 10).join('\n');
    expect(() => parseSdf(truncated)).toThrow(/expected 19 atoms/);
  });

  it('reads query / unknown atoms as X and deuterium as H', () => {
    const text = PYRIDINIUM_MOL.replace('2.4000    0.0000    0.0000 H  ', '2.4000    0.0000    0.0000 D  ').replace(
      '-2.4700    0.0000    0.0000 H  ',
      '-2.4700    0.0000    0.0000 Q  ',
    );
    const m = parseSdf(text);
    expect(m.atoms[6].element).toBe('H');
    expect(m.atoms[9].element).toBe('X');
  });
});

describe('parseSdf (V3000)', () => {
  const mol = parseSdf(ACETATE_V3000);

  it('reads atoms, continued lines, CHG and bonds', () => {
    expect(mol.atoms).toHaveLength(7);
    expect(mol.bonds).toHaveLength(6);
    expect(mol.atoms[3]).toMatchObject({ element: 'O', charge: -1, x: 1.152, y: -0.937 });
    expect(mol.bonds[1]).toMatchObject({ a: 2, b: 3, order: 2 });
    expect(mol.name).toBe('acetate');
  });
});

describe('writeSdf', () => {
  it('writes a valid V2000 record with charges and aromatic bonds', () => {
    const pyr = parseSdf(PYRIDINIUM_MOL);
    const text = writeSdf(pyr);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Pyridinium');
    expect(lines[3]).toBe(' 12 12  0  0  0  0  0  0  0  0999 V2000');
    expect(lines[4]).toBe('    1.3900    0.0000    0.0000 N   0  3  0  0  0  0  0  0  0  0  0  0');
    expect(lines[16]).toBe('  1  2  4  0  0  0  0');
    expect(text).toContain('\nM  CHG  1   1   1\n');
    expect(text.trimEnd().endsWith('M  END\n$$$$')).toBe(true);
  });

  it('round-trips atoms, coordinates, bonds, orders and charges', () => {
    for (const src of [BETAINE_SDF, PYRIDINIUM_MOL, ACETATE_V3000]) {
      const a = parseSdf(src);
      const b = parseSdf(writeSdf(a));
      expect(b.atoms.map((x) => x.element)).toEqual(a.atoms.map((x) => x.element));
      b.atoms.forEach((x, i) => {
        expect(x.x).toBeCloseTo(a.atoms[i].x, 3);
        expect(x.y).toBeCloseTo(a.atoms[i].y, 3);
        expect(x.z).toBeCloseTo(a.atoms[i].z, 3);
      });
      expect(b.bonds.map((x) => [x.a, x.b, x.order])).toEqual(a.bonds.map((x) => [x.a, x.b, x.order]));
      expect(charges(b)).toEqual(charges(a));
      expect(b.name).toBe(a.name);
    }
  });

  it('writes charges beyond ±3 through M  CHG only', () => {
    const m = buildMolecule('ion', [{ element: 'Fe', x: 0, y: 0, z: 0, charge: 4 }]);
    const text = writeSdf(m);
    expect(text.split('\n')[4].substring(36, 39)).toBe('  0');
    expect(parseSdf(text).atoms[0].charge).toBe(4);
  });

  it('switches to V3000 above 999 atoms and round-trips', () => {
    const atoms = Array.from({ length: 1200 }, (_, i) => ({ element: i % 2 ? 'O' : 'C', x: i * 0.1, y: -i * 0.05, z: 1, charge: i === 5 ? -1 : undefined }));
    const bonds = Array.from({ length: 1199 }, (_, i) => ({ a: i, b: i + 1, order: (i % 3 === 0 ? 2 : 1) as 1 | 2 }));
    const big = buildMolecule('chain', atoms, bonds);
    const text = writeSdf(big);
    expect(text).toContain('V3000');
    expect(text).toContain('M  V30 COUNTS 1200 1199 0 0 0');
    const back = parseSdf(text);
    expect(back.atoms).toHaveLength(1200);
    expect(back.bonds).toHaveLength(1199);
    expect(back.atoms[5].charge).toBe(-1);
    expect(back.bonds[3].order).toBe(2);
    expect(back.atoms[1100].x).toBeCloseTo(110, 3);
  });
});
