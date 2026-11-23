/**
 * File format detection, parsing and writing.
 * OWNER: io agent. CONTRACT: keep exported names & signatures.
 * Individual parsers live in src/io/pdb.ts, cif.ts, sdf.ts, xyz.ts, mol2.ts; this module dispatches.
 *
 * Parsers return RAW molecules built with core/molecule.ts buildMolecule(): atoms with element,
 * coordinates and whatever metadata the format provides, bonds if the format has them. They do NOT
 * perceive bonds or secondary structure — app/actions.ts runs core/prepare.ts afterwards.
 * Set meta.format, meta.title, meta.hasBondOrders (SDF/MOL2: true), meta.hasSecondaryStructure
 * (PDB HELIX/SHEET or mmCIF struct_conf/struct_sheet_range present → set atom.ss on residues:
 * helix/sheet for listed ranges, 'coil' for all other protein residues).
 * Multi-model files (NMR ensembles, multi-record SDF): load only the FIRST model/record.
 * Atoms with altLoc: keep only the first altLoc (blank or 'A') per atom.
 *
 * Molecule name: the `name` argument (usually the file name or the fetched id) wins; without it the
 * name stored in the file is used (SDF header, MOL2 molecule name, PDB/mmCIF entry id).
 */
import type { Molecule } from '../core/types';
import { looksBinary, splitLines } from './common';
import { parsePdb, writePdb } from './pdb';
import { parseCifMolecule } from './cif';
import { parseSdf, writeSdf } from './sdf';
import { parseXyz, writeXyz } from './xyz';
import { parseMol2, writeMol2 } from './mol2';

export type FileFormat = 'pdb' | 'cif' | 'sdf' | 'xyz' | 'mol2';
export type WritableFormat = 'pdb' | 'sdf' | 'xyz' | 'mol2';

export const FORMAT_LABELS: Record<FileFormat, string> = {
  pdb: 'PDB',
  cif: 'mmCIF',
  sdf: 'SDF / MOL',
  xyz: 'XYZ',
  mol2: 'MOL2',
};

/** File extensions accepted by the file picker. */
export const ACCEPTED_EXTENSIONS = ['.pdb', '.ent', '.pdbqt', '.cif', '.mmcif', '.sdf', '.mol', '.sd', '.xyz', '.mol2'];

const EXTENSION_FORMATS: Record<string, FileFormat> = {
  pdb: 'pdb',
  ent: 'pdb',
  pdbqt: 'pdb',
  pqr: 'pdb',
  cif: 'cif',
  mmcif: 'cif',
  mcif: 'cif',
  sdf: 'sdf',
  sd: 'sdf',
  mol: 'sdf',
  mdl: 'sdf',
  xyz: 'xyz',
  mol2: 'mol2',
  ml2: 'mol2',
};

/** Format implied by a file name's extension (null if unknown). */
export function formatFromFilename(filename: string): FileFormat | null {
  const base = filename.trim().toLowerCase().replace(/\.(gz|txt)$/, '');
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_FORMATS[base.slice(dot + 1)] ?? null;
}

/** Guess the format from the text content (null if it does not look like a supported format). */
export function sniffFormat(text: string): FileFormat | null {
  const head = text.slice(0, 200_000);
  if (head.includes('@<TRIPOS>')) return 'mol2';
  if (/^data_/m.test(head) && /^(_atom_site\.|_chem_comp_atom\.|loop_)/m.test(head)) return 'cif';

  const lines = splitLines(head.slice(0, 20_000)).slice(0, 400);
  // SDF / MOL: versioned counts line on line 4, or record / block terminators.
  if (lines.length >= 4 && /V[23]000\s*$/i.test(lines[3])) return 'sdf';
  if (/^M {2}END\s*$/m.test(head) || /^\$\$\$\$\s*$/m.test(head)) return 'sdf';
  // PDB record names.
  let pdbScore = 0;
  for (const l of lines) {
    if (/^(ATOM  |HETATM|HEADER|CRYST1|MODEL |COMPND|REMARK|SEQRES|CONECT)/.test(l)) pdbScore++;
    if (pdbScore >= 2 || /^(ATOM  |HETATM)/.test(l)) return 'pdb';
  }
  // XYZ: an integer count line followed (after a comment line) by "El x y z" lines.
  const nonEmpty = lines.findIndex((l) => l.trim() !== '');
  if (nonEmpty >= 0 && /^\s*\d+\s*$/.test(lines[nonEmpty])) {
    const atomLine = lines[nonEmpty + 2] ?? '';
    if (/^\s*([A-Za-z]{1,3}|\d{1,3})\s+[-+]?\d*\.?\d+([eE][-+]?\d+)?\s+[-+]?\d*\.?\d+([eE][-+]?\d+)?\s+[-+]?\d*\.?\d+([eE][-+]?\d+)?/.test(atomLine)) return 'xyz';
  }
  // Molfile without a version tag: counts line on line 4 with integer columns.
  if (lines.length >= 5 && /^[\s\d]{6}/.test(lines[3]) && /^\s*-?\d+\.\d+\s+-?\d+\.\d+\s+-?\d+\.\d+\s+[A-Za-z*]/.test(lines[4])) return 'sdf';
  return null;
}

/**
 * Detect the format from the filename extension, falling back to sniffing the text content
 * (e.g. 'ATOM  '/'HETATM'/'HEADER' → pdb, 'data_' + '_atom_site' → cif, 'V2000'/'V3000'/'$$$$' → sdf,
 * '@<TRIPOS>' → mol2, first line integer + element lines → xyz). Returns null if unknown.
 */
export function detectFormat(filename: string | null, text?: string): FileFormat | null {
  if (filename) {
    const byExt = formatFromFilename(filename);
    if (byExt) return byExt;
  }
  return text ? sniffFormat(text) : null;
}

/** Parse text into a raw molecule. Throws Error with a user-friendly message on failure. */
export function parseMolecule(text: string, format: FileFormat, name?: string): Molecule {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // byte-order mark
  if (!text.trim()) throw new Error('The file is empty.');
  if (looksBinary(text)) {
    throw new Error('This file looks binary or compressed (e.g. .gz or BinaryCIF). Please provide an uncompressed text file.');
  }
  const label = FORMAT_LABELS[format] ?? format;
  let mol: Molecule;
  try {
    mol = dispatchParse(text, format, name);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Point users at the likely cause when the content is clearly another format.
    const sniffed = sniffFormat(text);
    if (sniffed && sniffed !== format) {
      throw new Error(`${msg} The content looks like ${FORMAT_LABELS[sniffed]} rather than ${label}.`);
    }
    throw e instanceof Error ? e : new Error(msg);
  }
  if (mol.atoms.length === 0) {
    const sniffed = sniffFormat(text);
    if (sniffed && sniffed !== format) {
      throw new Error(`No atoms found: the content looks like ${FORMAT_LABELS[sniffed]} rather than ${label}.`);
    }
  }
  return mol;
}

function dispatchParse(text: string, format: FileFormat, name?: string): Molecule {
  switch (format) {
    case 'pdb':
      return parsePdb(text, name);
    case 'cif':
      return parseCifMolecule(text, name);
    case 'sdf':
      return parseSdf(text, name);
    case 'xyz':
      return parseXyz(text, name);
    case 'mol2':
      return parseMol2(text, name);
    default:
      throw new Error(`Unsupported format "${String(format)}".`);
  }
}

/**
 * Serialize. PDB: ATOM/HETATM + CONECT for hetero / non-residue atoms (and all bonds if the
 * molecule has no residues); SDF: V2000 (V3000 if > 999 atoms) with bond orders (aromatic → 4) and
 * charges (M  CHG); XYZ: count/title/element x y z; MOL2: ATOM/BOND with SYBYL-ish atom types.
 */
export function writeMolecule(mol: Molecule, format: WritableFormat): string {
  switch (format) {
    case 'pdb':
      return writePdb(mol);
    case 'sdf':
      return writeSdf(mol);
    case 'xyz':
      return writeXyz(mol);
    case 'mol2':
      return writeMol2(mol);
    default:
      throw new Error(`Cannot export to "${String(format)}".`);
  }
}

export const WRITE_EXTENSIONS: Record<WritableFormat, string> = { pdb: 'pdb', sdf: 'sdf', xyz: 'xyz', mol2: 'mol2' };

/**
 * True if a MOL/SDF text carries 2D coordinates only: its header declares the '2D' dimension code
 * (line 2, columns 21–22) and every z coordinate is zero, as written by 2D sketchers and PubChem 2D
 * records. Callers can then embed the parsed molecule in 3D (core/smiles embed3D), as they do for
 * fetched records with `flat: true`. Planar molecules stored as 3D (benzene, water) are not flagged.
 */
export function isFlat2D(text: string, format: FileFormat, mol: Molecule): boolean {
  if (format !== 'sdf' || mol.atoms.length < 2) return false;
  const lines = splitLines(text.slice(0, 400));
  const dim = (lines[1] ?? '').substring(20, 22).toUpperCase();
  return dim === '2D' && mol.atoms.every((a) => Math.abs(a.z) < 1e-4);
}
