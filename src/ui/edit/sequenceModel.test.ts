import { describe, expect, it } from 'vitest';
import { buildMolecule, getTopology, type AtomInput } from '../../core/molecule';
import type { SecondaryStructure } from '../../core/types';
import {
  allSelected,
  buildSequenceModel,
  rangeAtomIds,
  representativeAtomId,
  residueAtomIds,
  residueOfAtom,
  selectedResidueSet,
  sequenceTicks,
  visibleWindow,
} from './sequenceModel';

const AA = ['ALA', 'GLY', 'SER', 'LEU', 'LYS'];
const LETTER: Record<string, string> = { ALA: 'A', GLY: 'G', SER: 'S', LEU: 'L', LYS: 'K' };

/** Chain A: residues 1–12 and 15–25 (gap), backbone N/CA/C, helix 3–8, plus a water; chain B: DNA DA/DC. */
function testMolecule() {
  const atoms: AtomInput[] = [];
  const nums = [...Array.from({ length: 12 }, (_, i) => i + 1), ...Array.from({ length: 11 }, (_, i) => i + 15)];
  nums.forEach((resSeq, k) => {
    const resName = AA[k % AA.length];
    const ss: SecondaryStructure = resSeq >= 3 && resSeq <= 8 ? 'helix' : resSeq >= 20 ? 'sheet' : 'coil';
    for (const [name, element] of [
      ['N', 'N'],
      ['CA', 'C'],
      ['C', 'C'],
    ]) {
      atoms.push({ element, name, resName, resSeq, chain: 'A', ss, x: k, y: 0, z: 0 });
    }
  });
  atoms.push({ element: 'O', name: 'O', resName: 'HOH', resSeq: 301, chain: 'A', hetero: true, x: 0, y: 5, z: 0 });
  for (const [resSeq, resName] of [
    [1, 'DA'],
    [2, 'DC'],
  ] as const) {
    atoms.push({ element: 'P', name: 'P', resName, resSeq, chain: 'B', x: 0, y: 10, z: resSeq });
    atoms.push({ element: 'C', name: "C4'", resName, resSeq, chain: 'B', x: 1, y: 10, z: resSeq });
  }
  return { mol: buildMolecule('test', atoms), nums };
}

describe('buildSequenceModel', () => {
  it('builds one row per polymer chain and skips water', () => {
    const { mol, nums } = testMolecule();
    const model = buildSequenceModel(mol);
    expect(model.rows.map((r) => r.chainId)).toEqual(['A', 'B']);
    const [a, b] = model.rows;
    expect(a.kind).toBe('protein');
    expect(b.kind).toBe('nucleic');
    expect(a.residues).toHaveLength(nums.length);
    expect(a.residues.map((r) => r.letter).join('')).toBe(nums.map((_, k) => LETTER[AA[k % AA.length]]).join(''));
    expect(b.residues.map((r) => r.letter).join('')).toBe('AC');
    expect(model.maxLength).toBe(nums.length);
    // Secondary structure from the atoms; nucleic residues have none.
    expect(a.residues.find((r) => r.resSeq === 5)!.ss).toBe('helix');
    expect(a.residues.find((r) => r.resSeq === 22)!.ss).toBe('sheet');
    expect(a.residues.find((r) => r.resSeq === 1)!.ss).toBe('coil');
    expect(b.residues[0].ss).toBeUndefined();
    // Numbering gap 12 → 15.
    expect(a.residues.filter((r) => r.gapBefore).map((r) => r.resSeq)).toEqual([15]);
    // Reverse lookup.
    const r15 = a.residues[12];
    expect(model.rowOf[r15.resIndex]).toBe(0);
    expect(model.posOf[r15.resIndex]).toBe(12);
    const water = getTopology(mol).residues.find((r) => r.resName === 'HOH')!;
    expect(model.rowOf[water.index]).toBe(-1);
    // Cached per molecule object.
    expect(buildSequenceModel(mol)).toBe(model);
  });

  it('places residue-number ticks at the start and at multiples of ten', () => {
    const { mol } = testMolecule();
    const ticks = buildSequenceModel(mol).rows[0].ticks;
    expect(ticks.map((t) => t.text)).toEqual(['1', '10', '20']);
    expect(ticks.map((t) => t.pos)).toEqual([0, 9, 17]);
  });

  it('avoids crowded tick labels and skips insertion codes', () => {
    const res = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((resSeq) => ({ resSeq, iCode: '' }));
    expect(sequenceTicks(res).map((t) => t.text)).toEqual(['8', '20']);
    expect(sequenceTicks([{ resSeq: 1, iCode: '' }, ...Array.from({ length: 8 }, (_, i) => ({ resSeq: i + 2, iCode: '' })), { resSeq: 10, iCode: 'A' }]).map((t) => t.text)).toEqual(['1']);
    expect(sequenceTicks([])).toEqual([]);
  });
});

describe('residue ↔ atom mapping', () => {
  it('maps residues to atoms and back', () => {
    const { mol } = testMolecule();
    const model = buildSequenceModel(mol);
    const res = model.rows[0].residues[0];
    expect(residueAtomIds(mol, res.resIndex)).toEqual([1, 2, 3]);
    expect(representativeAtomId(mol, res.resIndex)).toBe(2); // CA
    const dna = model.rows[1].residues[0];
    const c4 = mol.atoms.find((a) => a.name === "C4'" && a.resSeq === 1)!;
    expect(representativeAtomId(mol, dna.resIndex)).toBe(c4.id);
    expect(residueOfAtom(mol, 5)).toBe(model.rows[0].residues[1].resIndex);
    expect(residueOfAtom(mol, undefined)).toBe(-1);
    expect(residueOfAtom(mol, 9999)).toBe(-1);
  });

  it('collects ranges in either direction', () => {
    const { mol } = testMolecule();
    const row = buildSequenceModel(mol).rows[0];
    expect(rangeAtomIds(mol, row, 2, 0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rangeAtomIds(mol, row, 1, 1)).toEqual([4, 5, 6]);
  });

  it('finds residues touched by the selection', () => {
    const { mol } = testMolecule();
    const model = buildSequenceModel(mol);
    const sel = new Set([2, 7, 9999]);
    const set = selectedResidueSet(mol, sel);
    expect([...set]).toEqual([model.rows[0].residues[0].resIndex, model.rows[0].residues[2].resIndex]);
    expect(allSelected(new Set([1, 2, 3]), [1, 2, 3])).toBe(true);
    expect(allSelected(new Set([1, 2]), [1, 2, 3])).toBe(false);
    expect(allSelected(new Set([1]), [])).toBe(false);
  });
});

describe('visibleWindow', () => {
  it('computes the visible slice of fixed-size items', () => {
    expect(visibleWindow(0, 100, 10, 50)).toEqual([0, 10]);
    expect(visibleWindow(0, 100, 10, 50, 2)).toEqual([0, 12]);
    expect(visibleWindow(105, 100, 10, 50)).toEqual([10, 21]);
    // With a 44 px label column before the first item.
    expect(visibleWindow(100, 100, 10, 50, 0, 44)).toEqual([5, 16]);
    expect(visibleWindow(0, 100, 10, 5)).toEqual([0, 5]);
    expect(visibleWindow(10_000, 100, 10, 50)).toEqual([50, 50]);
    expect(visibleWindow(0, 100, 10, 0)).toEqual([0, 0]);
  });
});

describe('sequence model cache', () => {
  it('is shared by coordinate-only updates and rebuilt when the structure changes', async () => {
    const { buildMolecule } = await import('../../core/molecule');
    const { buildSequenceModel } = await import('./sequenceModel');
    const atoms = Array.from({ length: 4 }, (_, i) => ({ element: 'C', name: 'CA', resName: 'ALA', resSeq: i + 1, chain: 'A', x: i * 3.8, y: 0, z: 0 }));
    const mol = buildMolecule('p', atoms, []);
    const model = buildSequenceModel(mol);
    const movedAtoms = mol.atoms.slice();
    movedAtoms[1] = { ...movedAtoms[1], x: movedAtoms[1].x + 0.5 };
    expect(buildSequenceModel({ ...mol, atoms: movedAtoms })).toBe(model);
    const renamed = mol.atoms.slice();
    renamed[1] = { ...renamed[1], resName: 'GLY' };
    const next = buildSequenceModel({ ...mol, atoms: renamed });
    expect(next).not.toBe(model);
    expect(next.rows[0].residues[1].letter).toBe('G');
  });
});
