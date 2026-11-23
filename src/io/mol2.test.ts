import { describe, expect, it } from 'vitest';
import { parseMol2, sybylAtomTypes, writeMol2 } from './mol2';
import { parseSdf } from './sdf';
import { ACETAMIDE_MOL2, BETAINE_SDF, DIPEPTIDE_MOL2, PYRIDINIUM_MOL } from './__fixtures__/fixtures';
import { buildMolecule, type AtomInput } from '../core/molecule';
import type { Molecule } from '../core/types';

const charges = (m: Molecule) => m.atoms.map((a) => a.charge ?? 0);

describe('parseMol2', () => {
  it('reads a small molecule with partial charges and an amide bond', () => {
    const m = parseMol2(ACETAMIDE_MOL2);
    expect(m.name).toBe('acetamide');
    expect(m.atoms).toHaveLength(9);
    expect(m.atoms.map((a) => a.element).join('')).toBe('CCONHHHHH');
    expect(m.atoms[3]).toMatchObject({ name: 'N1', x: 0.935, y: 1.106, z: 0 });
    expect(m.bonds.map((b) => b.order)).toEqual([1, 2, 1, 1, 1, 1, 1, 1]);
    // Gasteiger partial charges are not formal charges; generic 'UNL1' substructure is not a residue.
    expect(charges(m).every((c) => c === 0)).toBe(true);
    expect(m.atoms.every((a) => a.resName === undefined)).toBe(true);
    expect(m.meta).toMatchObject({ format: 'mol2', hasBondOrders: true, title: 'acetamide' });
    expect(parseMol2(ACETAMIDE_MOL2, 'file').name).toBe('file');
  });

  it('reads residues, chains, lone pairs, nc bonds and infers N.4 charges', () => {
    const m = parseMol2(DIPEPTIDE_MOL2);
    expect(m.atoms).toHaveLength(13); // lone pair dropped, second molecule ignored
    expect(m.bonds).toHaveLength(12); // LP bond and 'nc' bond dropped
    expect(m.atoms[0]).toMatchObject({ element: 'N', name: 'N', resName: 'ALA', resSeq: 1, chain: 'A', hetero: false, charge: 1 });
    expect(m.atoms[8]).toMatchObject({ resName: 'GLY', resSeq: 2, chain: 'A' });
    const carboxylate = m.bonds.filter((b) => b.order === 1.5);
    expect(carboxylate).toHaveLength(2);
    expect(charges(m).reduce((s, c) => s + c, 0)).toBe(1);
  });

  it('reads integral charge columns as formal charges', () => {
    const text = ACETAMIDE_MOL2.replace('N.am      1  UNL1       -0.3700', 'N.4       1  UNL1        1.0000')
      .replace(/(-?0\.\d{4})$/gm, '0.0000');
    const m = parseMol2(text);
    expect(m.atoms[3].charge).toBe(1);
  });

  it('gives friendly errors', () => {
    expect(() => parseMol2('not a mol2 file')).toThrow(/@<TRIPOS>MOLECULE/);
    expect(() => parseMol2('@<TRIPOS>MOLECULE\nx\n1 0\nSMALL\nNO_CHARGES\n\n@<TRIPOS>ATOM\n1 C1 abc 0 0 C.3\n')).toThrow(/coordinates/);
  });
});

describe('SYBYL atom typing', () => {
  it('types common functional groups', () => {
    const acetamide = parseMol2(ACETAMIDE_MOL2);
    expect(sybylAtomTypes(acetamide)).toEqual(['C.3', 'C.2', 'O.2', 'N.am', 'H', 'H', 'H', 'H', 'H']);
    const betaine = parseSdf(BETAINE_SDF);
    const t = sybylAtomTypes(betaine);
    expect(t.slice(0, 8)).toEqual(['O.co2', 'O.co2', 'N.4', 'C.3', 'C.3', 'C.3', 'C.3', 'C.2']);
    const pyr = sybylAtomTypes(parseSdf(PYRIDINIUM_MOL));
    expect(pyr.slice(0, 6)).toEqual(['N.ar', 'C.ar', 'C.ar', 'C.ar', 'C.ar', 'C.ar']);
  });

  it('distinguishes sp / sp2 / sp3, sulfur oxidation states and amines', () => {
    // H3C-C#N, dimethyl sulfone fragment, aniline-like N, thioether
    const m = buildMolecule(
      't',
      [
        { element: 'C', x: 0, y: 0, z: 0 }, // 0 nitrile C
        { element: 'N', x: 1, y: 0, z: 0 }, // 1 nitrile N
        { element: 'S', x: 3, y: 0, z: 0 }, // 2 sulfone S
        { element: 'O', x: 4, y: 0, z: 0 }, // 3
        { element: 'O', x: 3, y: 1, z: 0 }, // 4
        { element: 'S', x: 6, y: 0, z: 0 }, // 5 thioether S
        { element: 'N', x: 8, y: 0, z: 0 }, // 6 amine attached to sp2 C → N.pl3
        { element: 'C', x: 9, y: 0, z: 0 }, // 7 sp2 C
        { element: 'C', x: 10, y: 0, z: 0 }, // 8 sp2 C
        { element: 'N', x: 12, y: 0, z: 0 }, // 9 plain amine N.3
        { element: 'C', x: 13, y: 0, z: 0 }, // 10
        { element: 'P', x: 15, y: 0, z: 0 }, // 11
        { element: 'Fe', x: 17, y: 0, z: 0 }, // 12
        { element: 'X', x: 19, y: 0, z: 0 }, // 13
      ],
      [
        { a: 0, b: 1, order: 3 },
        { a: 2, b: 3, order: 2 },
        { a: 2, b: 4, order: 2 },
        { a: 6, b: 7 },
        { a: 7, b: 8, order: 2 },
        { a: 9, b: 10 },
      ],
    );
    const t = sybylAtomTypes(m);
    expect(t[0]).toBe('C.1');
    expect(t[1]).toBe('N.1');
    expect(t[2]).toBe('S.O2');
    expect(t[3]).toBe('O.2');
    expect(t[5]).toBe('S.3');
    expect(t[6]).toBe('N.pl3');
    expect(t[7]).toBe('C.2');
    expect(t[9]).toBe('N.3');
    expect(t[10]).toBe('C.3');
    expect(t[11]).toBe('P.3');
    expect(t[12]).toBe('Fe');
    expect(t[13]).toBe('Du');
  });
});

describe('writeMol2', () => {
  it('writes sections, SYBYL types and bond types', () => {
    const text = writeMol2(parseMol2(ACETAMIDE_MOL2));
    expect(text.startsWith('@<TRIPOS>MOLECULE\nacetamide\n')).toBe(true);
    expect(text).toContain('@<TRIPOS>ATOM');
    expect(text).toContain('@<TRIPOS>BOND');
    expect(text).toContain('@<TRIPOS>SUBSTRUCTURE');
    expect(text).toMatch(/ N\.am /);
    expect(text).toMatch(/^\s+3\s+2\s+4 am$/m);
    expect(text).toContain('NO_CHARGES');
  });

  it('round-trips atoms, coordinates, bonds, orders and charges', () => {
    const inputs = [parseMol2(ACETAMIDE_MOL2), parseMol2(DIPEPTIDE_MOL2), parseSdf(BETAINE_SDF), parseSdf(PYRIDINIUM_MOL)];
    for (const a of inputs) {
      const b = parseMol2(writeMol2(a));
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

  it('keeps residues and chains through a round trip', () => {
    const a = parseMol2(DIPEPTIDE_MOL2);
    const b = parseMol2(writeMol2(a));
    b.atoms.forEach((x, i) => {
      expect(x.resName).toBe(a.atoms[i].resName);
      expect(x.resSeq).toBe(a.atoms[i].resSeq);
      expect(x.chain).toBe(a.atoms[i].chain);
      expect(x.name).toBe(a.atoms[i].name);
    });
  });

  it('keeps residue names that end or start with digits (MK1, PO4, 2MG) through a round trip', () => {
    const atom = (name: string, element: string, resName: string, resSeq: number, x: number) => ({
      name, element, resName, resSeq, chain: 'B', x, y: 0, z: 0, hetero: true,
    });
    const a = buildMolecule('complex', [
      atom('C1', 'C', 'MK1', 902, 0), atom('N1', 'N', 'MK1', 902, 1.4),
      atom('P', 'P', 'PO4', 147, 5), atom('O1', 'O', 'PO4', 147, 6.5),
      atom('P', 'P', '2MG', 10, 10), atom('N2', 'N', '2MG', 10, 12),
    ], [{ a: 0, b: 1 }, { a: 2, b: 3 }]);
    const b = parseMol2(writeMol2(a));
    expect(b.atoms.map((x) => `${x.resName} ${x.resSeq} ${x.chain}`)).toEqual(a.atoms.map((x) => `${x.resName} ${x.resSeq} ${x.chain}`));
  });

  it('keeps columns separated when atom / bond / substructure numbers exceed 99999', () => {
    // Water box with > 100k atoms: bond and substructure lines carry 6-digit numbers.
    const atoms: AtomInput[] = [];
    const bonds: { a: number; b: number }[] = [];
    for (let k = 0; atoms.length < 100_002; k++) {
      const x = (k % 50) * 3, y = Math.floor(k / 50) % 50 * 3, z = Math.floor(k / 2500) * 3;
      const o = atoms.length;
      atoms.push({ element: 'O', name: 'OH2', resName: 'HOH', resSeq: k + 1, x, y, z });
      atoms.push({ element: 'H', name: 'H1', resName: 'HOH', resSeq: k + 1, x: x + 0.96, y, z });
      atoms.push({ element: 'H', name: 'H2', resName: 'HOH', resSeq: k + 1, x: x - 0.24, y: y + 0.93, z });
      bonds.push({ a: o, b: o + 1 }, { a: o, b: o + 2 });
    }
    const a = buildMolecule('box', atoms, bonds);
    const b = parseMol2(writeMol2(a));
    expect(b.atoms).toHaveLength(a.atoms.length);
    expect(b.bonds).toHaveLength(a.bonds.length);
    const last = a.bonds.length - 1;
    expect([b.bonds[last].a, b.bonds[last].b]).toEqual([a.bonds[last].a, a.bonds[last].b]);
    expect(b.atoms.at(-1)).toMatchObject({ resName: 'HOH', resSeq: a.atoms.at(-1)!.resSeq });
  });
});
