/**
 * XYZ reader / writer.
 *
 *   <atom count>
 *   <comment>            → meta.title
 *   <El|Z> <x> <y> <z> [extra columns ignored]
 *
 * Multi-frame trajectories: only the first frame is read. Files without the count / comment header
 * (bare "El x y z" lines) are tolerated.
 */
import type { Molecule, MoleculeMeta } from '../core/types';
import { buildMolecule, type AtomInput } from '../core/molecule';
import { normalizeElement, symbolFromAtomicNumber } from './elementSymbols';
import { collapseSpaces, fmtFixed, padRight, pickName, splitLines, tokens } from './common';

function xyzElement(token: string): string {
  const c = token.charCodeAt(0);
  if (c >= 48 && c <= 57) return symbolFromAtomicNumber(parseInt(token, 10));
  return normalizeElement(token);
}

function isAtomLine(t: string[]): boolean {
  return t.length >= 4 && /^[A-Za-z]/.test(t[0]) && t.slice(1, 4).every((v) => Number.isFinite(Number(v)));
}

/** Parse the first frame of an XYZ file. */
export function parseXyz(text: string, name?: string): Molecule {
  const lines = splitLines(text);
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  if (first >= lines.length) throw new Error('The XYZ file is empty.');

  const headTok = tokens(lines[first]);
  const count = headTok.length >= 1 && /^\d+$/.test(headTok[0]) ? parseInt(headTok[0], 10) : NaN;
  let title = '';
  let i: number;
  let limit: number;
  if (Number.isFinite(count)) {
    title = (lines[first + 1] ?? '').trim();
    i = first + 2;
    limit = count;
  } else if (isAtomLine(headTok)) {
    // Bare coordinate list without header.
    i = first;
    limit = Infinity;
  } else {
    throw new Error('Invalid XYZ file: the first line should contain the number of atoms.');
  }

  const atoms: AtomInput[] = [];
  for (; i < lines.length && atoms.length < limit; i++) {
    const t = tokens(lines[i]);
    if (t.length === 0) {
      if (limit === Infinity) break;
      continue;
    }
    if (t.length < 4) {
      if (limit === Infinity) break;
      throw new Error(`Invalid XYZ file: line ${i + 1} should look like "C 0.000 0.000 0.000".`);
    }
    const x = Number(t[1]), y = Number(t[2]), z = Number(t[3]);
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
      // Fortran-style exponents (1.0D-03) are occasionally used.
      const fx = Number(t[1].replace(/[dD]/, 'e')), fy = Number(t[2].replace(/[dD]/, 'e')), fz = Number(t[3].replace(/[dD]/, 'e'));
      if (!(Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(fz))) {
        if (limit === Infinity) break;
        throw new Error(`Invalid XYZ file: could not read the coordinates on line ${i + 1}.`);
      }
      atoms.push({ element: xyzElement(t[0]), x: fx, y: fy, z: fz });
      continue;
    }
    atoms.push({ element: xyzElement(t[0]), x, y, z });
  }
  if (Number.isFinite(count) && atoms.length < count && atoms.length === 0) {
    throw new Error(`Invalid XYZ file: expected ${count} atoms but found none.`);
  }

  const meta: MoleculeMeta = { format: 'xyz' };
  if (title) meta.title = collapseSpaces(title);
  const shortTitle = title && title.length <= 40 && !/[=:]/.test(title) ? title : undefined;
  return buildMolecule(pickName('Untitled', name, shortTitle), atoms, [], meta);
}

/** Serialize as XYZ (count, molecule name as the comment line, element x y z with 6 decimals). */
export function writeXyz(mol: Molecule): string {
  const out: string[] = [String(mol.atoms.length), collapseSpaces(mol.name)];
  for (const a of mol.atoms) {
    out.push(padRight(a.element, 2) + ' ' + fmtFixed(a.x, 6, 14) + ' ' + fmtFixed(a.y, 6, 14) + ' ' + fmtFixed(a.z, 6, 14));
  }
  return out.join('\n') + '\n';
}
