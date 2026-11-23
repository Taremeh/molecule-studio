/**
 * Data model for the sequence strip: polymer chains as rows of one-letter residue codes, residue
 * number ticks, selection mapping between residues and atom ids, and windowing math.
 * OWNER: edit-ui.
 */
import type { Molecule, SecondaryStructure } from '../../core/types';
import { createStructureCache, getTopology } from '../../core/molecule';

export interface SeqResidue {
  /** Index into topology.residues. */
  resIndex: number;
  letter: string;
  resName: string;
  resSeq: number;
  iCode: string;
  ss?: SecondaryStructure;
  /** Residue numbering jumps (missing residues / chain break) before this residue. */
  gapBefore: boolean;
}

export interface SeqTick {
  /** Position in the row (0-based residue slot). */
  pos: number;
  text: string;
}

export interface SeqRow {
  chainId: string;
  kind: 'protein' | 'nucleic' | 'mixed';
  residues: SeqResidue[];
  ticks: SeqTick[];
}

export interface SequenceModel {
  rows: SeqRow[];
  /** Length of the longest row. */
  maxLength: number;
  /** residue index → row index (−1 if not shown). */
  rowOf: Int32Array;
  /** residue index → position in its row (−1 if not shown). */
  posOf: Int32Array;
}

/** Minimum number of slots between two tick labels (avoids overlapping numbers). */
const MIN_TICK_GAP = 5;

/**
 * Tick labels: the first residue's number, then every residue whose number is a multiple of 10
 * (without insertion code), skipping labels that would crowd the previous one.
 */
export function sequenceTicks(residues: readonly Pick<SeqResidue, 'resSeq' | 'iCode'>[]): SeqTick[] {
  const ticks: SeqTick[] = [];
  let last = -Infinity;
  for (let pos = 0; pos < residues.length; pos++) {
    const r = residues[pos];
    const isFirst = pos === 0;
    const isTen = r.resSeq % 10 === 0 && !r.iCode;
    if (!isFirst && !isTen) continue;
    if (!isFirst && pos - last < MIN_TICK_GAP) continue;
    ticks.push({ pos, text: `${r.resSeq}${r.iCode}` });
    last = pos;
  }
  return ticks;
}

/**
 * Rows for every chain that contains protein or nucleic residues (other residues are skipped).
 * Cached per structure: it reads only the topology, so coordinate-only updates (drags) reuse it.
 */
export const buildSequenceModel: (mol: Molecule) => SequenceModel = createStructureCache(buildSequenceModelUncached);

function buildSequenceModelUncached(mol: Molecule): SequenceModel {
  const topo = getTopology(mol);
  const rowOf = new Int32Array(topo.residues.length).fill(-1);
  const posOf = new Int32Array(topo.residues.length).fill(-1);
  const rows: SeqRow[] = [];
  let maxLength = 0;
  for (const chain of topo.chains) {
    const residues: SeqResidue[] = [];
    let hasProt = false;
    let hasNuc = false;
    for (const ri of chain.residueIndices) {
      const r = topo.residues[ri];
      if (r.kind !== 'protein' && r.kind !== 'nucleic') continue;
      if (r.kind === 'protein') hasProt = true;
      else hasNuc = true;
      const prev = residues[residues.length - 1];
      residues.push({
        resIndex: ri,
        letter: r.oneLetter || 'X',
        resName: r.resName,
        resSeq: r.resSeq,
        iCode: r.iCode,
        ss: r.kind === 'protein' ? r.ss : undefined,
        gapBefore: !!prev && r.resSeq - prev.resSeq > 1,
      });
    }
    if (!residues.length) continue;
    const rowIndex = rows.length;
    residues.forEach((r, pos) => {
      rowOf[r.resIndex] = rowIndex;
      posOf[r.resIndex] = pos;
    });
    rows.push({
      chainId: chain.id,
      kind: hasProt && hasNuc ? 'mixed' : hasProt ? 'protein' : 'nucleic',
      residues,
      ticks: sequenceTicks(residues),
    });
    maxLength = Math.max(maxLength, residues.length);
  }
  return { rows, maxLength, rowOf, posOf };
}

/** Atom ids of a residue. */
export function residueAtomIds(mol: Molecule, resIndex: number): number[] {
  const res = getTopology(mol).residues[resIndex];
  return res ? res.atomIndices.map((i) => mol.atoms[i].id) : [];
}

/** Atom ids of all residues in row positions [from, to] (inclusive, any order). */
export function rangeAtomIds(mol: Molecule, row: SeqRow, from: number, to: number): number[] {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(row.residues.length - 1, Math.max(from, to));
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) out.push(...residueAtomIds(mol, row.residues[p].resIndex));
  return out;
}

const REPRESENTATIVE_NAMES = ['CA', "C4'", 'P', "C1'", 'C4*', 'C1*'];

/** The atom that stands for a residue (CA for amino acids, C4′/P for nucleotides, else the first atom). */
export function representativeAtomId(mol: Molecule, resIndex: number): number | undefined {
  const res = getTopology(mol).residues[resIndex];
  if (!res || !res.atomIndices.length) return undefined;
  for (const name of REPRESENTATIVE_NAMES) {
    for (const i of res.atomIndices) if (mol.atoms[i].name === name) return mol.atoms[i].id;
  }
  return mol.atoms[res.atomIndices[0]].id;
}

/** Residue indices that contain at least one selected atom. */
export function selectedResidueSet(mol: Molecule, selection: ReadonlySet<number>): Set<number> {
  const topo = getTopology(mol);
  const out = new Set<number>();
  for (const id of selection) {
    const i = topo.idToIndex.get(id);
    if (i === undefined) continue;
    const r = topo.atomResidue[i];
    if (r >= 0) out.add(r);
  }
  return out;
}

/** Residue index of an atom id (−1 if none). */
export function residueOfAtom(mol: Molecule, atomId: number | undefined): number {
  if (atomId === undefined) return -1;
  const topo = getTopology(mol);
  const i = topo.idToIndex.get(atomId);
  return i === undefined ? -1 : topo.atomResidue[i];
}

/** True if every atom id is in the selection (empty list → false). */
export function allSelected(selection: ReadonlySet<number>, ids: readonly number[]): boolean {
  if (!ids.length) return false;
  for (const id of ids) if (!selection.has(id)) return false;
  return true;
}

/**
 * Half-open index range [start, end) of fixed-size items intersecting a scrolled viewport.
 * `offset` is the space before the first item (e.g. a sticky label column).
 */
export function visibleWindow(scroll: number, viewport: number, itemSize: number, count: number, overscan = 0, offset = 0): [number, number] {
  if (count <= 0 || itemSize <= 0) return [0, 0];
  const first = Math.floor((scroll - offset) / itemSize);
  const last = Math.ceil((scroll - offset + viewport) / itemSize);
  const start = Math.max(0, Math.min(count, first - overscan));
  const end = Math.max(start, Math.min(count, last + overscan));
  return [start, end];
}
