/**
 * Shared helpers for the format parsers / writers (io layer only).
 */
import type { SecondaryStructure } from '../core/types';
import type { AtomInput } from '../core/molecule';
import { classifyResidue } from '../core/molecule';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Split text into lines, handling LF, CRLF and old-Mac CR line endings. */
export function splitLines(text: string): string[] {
  if (text.indexOf('\n') < 0) return text.indexOf('\r') >= 0 ? text.split('\r') : [text];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length && l.charCodeAt(l.length - 1) === 13) lines[i] = l.slice(0, -1);
  }
  return lines;
}

/** Split on runs of whitespace, ignoring leading/trailing whitespace. */
export function tokens(line: string): string[] {
  const t = line.trim();
  return t ? t.split(/\s+/) : [];
}

/** parseFloat that returns undefined for blank / invalid input. */
export function optFloat(s: string | undefined | null): number | undefined {
  if (s == null) return undefined;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : undefined;
}

/** parseInt (base 10) that returns undefined for blank / invalid input. */
export function optInt(s: string | undefined | null): number | undefined {
  if (s == null) return undefined;
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : undefined;
}

/** True if the text looks binary or compressed (NUL bytes / many replacement characters). */
export function looksBinary(text: string): boolean {
  const head = text.slice(0, 2048);
  if (head.indexOf('\0') >= 0) return true;
  let bad = 0;
  for (let i = 0; i < head.length; i++) if (head.charCodeAt(i) === 0xfffd) bad++;
  return bad > 8;
}

// ---------------------------------------------------------------------------
// Number formatting (fixed-width columns)
// ---------------------------------------------------------------------------

export function padLeft(s: string | number, width: number): string {
  const t = String(s);
  return t.length >= width ? t : ' '.repeat(width - t.length) + t;
}

export function padRight(s: string | number, width: number): string {
  const t = String(s);
  return t.length >= width ? t : t + ' '.repeat(width - t.length);
}

/**
 * Fixed-point number right-justified in `width` columns (like printf %width.decimalsf).
 * If the number does not fit, decimals are dropped progressively so columns never shift.
 */
export function fmtFixed(value: number, decimals: number, width: number): string {
  const v = Number.isFinite(value) ? value : 0;
  for (let d = decimals; d >= 0; d--) {
    let s = v.toFixed(d);
    if (s === '-' + (0).toFixed(d)) s = (0).toFixed(d); // avoid "-0.000"
    if (s.length <= width) return padLeft(s, width);
  }
  return v.toFixed(0).slice(0, width);
}

// ---------------------------------------------------------------------------
// Molecule naming
// ---------------------------------------------------------------------------

/** First non-blank candidate (trimmed), else the fallback. */
export function pickName(fallback: string, ...candidates: (string | undefined | null)[]): string {
  for (const c of candidates) {
    const t = c?.trim();
    if (t) return t;
  }
  return fallback;
}

/** Collapse whitespace runs into single spaces and trim. */
export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Alternate locations
// ---------------------------------------------------------------------------

/**
 * Keeps the first alternate location of every atom and drops the others.
 * - Atoms with a blank altLoc are always kept.
 * - For a non-blank altLoc, the first-seen copy of an atom (chain, residue number, insertion code,
 *   atom name) is kept and later copies are dropped.
 * - Microheterogeneity (a residue modelled as e.g. SER in altLoc A and THR in altLoc B): the residue
 *   name of the first altLoc atom of a residue wins; atoms of the other residue name are dropped.
 */
export class AltLocFilter {
  private seenAtoms = new Set<string>();
  private residueAltName = new Map<string, string>();

  accept(altLoc: string, chain: string, resSeq: number | undefined, iCode: string, resName: string, atomName: string): boolean {
    if (!altLoc) return true;
    const resKey = chain + '\u0001' + (resSeq ?? '') + '\u0001' + iCode;
    const firstName = this.residueAltName.get(resKey);
    if (firstName === undefined) this.residueAltName.set(resKey, resName);
    else if (firstName !== resName) return false;
    const atomKey = resKey + '\u0001' + atomName;
    if (this.seenAtoms.has(atomKey)) return false;
    this.seenAtoms.add(atomKey);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Secondary structure from file records
// ---------------------------------------------------------------------------

export interface SsRange {
  kind: 'helix' | 'sheet';
  chain: string;
  startSeq: number;
  startICode: string;
  endSeq: number;
  endICode: string;
}

/** Compare (resSeq, iCode) pairs; blank insertion code sorts before 'A'. */
function cmpRes(seqA: number, icA: string, seqB: number, icB: string): number {
  if (seqA !== seqB) return seqA - seqB;
  return icA < icB ? -1 : icA > icB ? 1 : 0;
}

/**
 * Set `ss` on every protein-residue atom: 'helix' / 'sheet' when its residue lies within one of the
 * ranges (same chain, inclusive), 'coil' otherwise. Mutates the (freshly parsed) atom inputs.
 * Helix wins over sheet when ranges overlap.
 */
export function applySecondaryStructure(atoms: AtomInput[], ranges: SsRange[]): void {
  const byChain = new Map<string, SsRange[]>();
  for (const r of ranges) {
    let list = byChain.get(r.chain);
    if (!list) byChain.set(r.chain, (list = []));
    list.push(r);
  }
  let lastKey = '';
  let lastSs: SecondaryStructure | undefined;
  for (const a of atoms) {
    if (a.resName === undefined) continue;
    const chain = a.chain ?? '';
    const seq = a.resSeq ?? 0;
    const ic = a.iCode ?? '';
    const key = chain + '\u0001' + seq + '\u0001' + ic + '\u0001' + a.resName;
    if (key !== lastKey) {
      lastKey = key;
      lastSs = undefined;
      if (classifyResidue(a.resName, a.hetero) === 'protein') {
        lastSs = 'coil';
        const list = byChain.get(chain);
        if (list) {
          for (const r of list) {
            if (cmpRes(seq, ic, r.startSeq, r.startICode) >= 0 && cmpRes(seq, ic, r.endSeq, r.endICode) <= 0) {
              lastSs = r.kind;
              if (r.kind === 'helix') break;
            }
          }
        }
      }
    }
    if (lastSs) a.ss = lastSs;
  }
}
