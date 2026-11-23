/**
 * Search-box input classification (shell UI). Pure, no DOM / store access.
 *
 * One search box accepts several kinds of identifiers; we detect which one the user typed so a single
 * Enter does the right thing:
 *  - PDB id:      4 characters, digit first (e.g. 1CRN). All-digit strings are treated as PubChem CIDs
 *                 instead (e.g. 2244 = aspirin), because the fetcher interprets digits as a CID.
 *  - UniProt id:  accession format (e.g. P69905) → AlphaFold DB model.
 *  - SMILES:      only when the text tokenizes as SMILES and is unlikely to be a name (see looksLikeSmiles).
 *  - otherwise:   PubChem compound name / CID.
 */

export type SearchKind = 'pdb' | 'pubchem' | 'alphafold' | 'smiles';

/** RCSB PDB id: digit + 3 alphanumerics. */
export const PDB_ID_RE = /^[0-9][A-Za-z0-9]{3}$/;

/** UniProt accession (official regex from uniprot.org/help/accession_numbers). */
export const UNIPROT_RE = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

export function isPdbId(text: string): boolean {
  return PDB_ID_RE.test(text.trim());
}

export function isUniprotId(text: string): boolean {
  return UNIPROT_RE.test(text.trim().toUpperCase());
}

/** Organic-subset atoms allowed outside brackets (two-letter symbols first). */
const ORGANIC_TWO = ['Cl', 'Br'];
const ORGANIC_ONE = new Set(['B', 'C', 'N', 'O', 'P', 'S', 'F', 'I', 'b', 'c', 'n', 'o', 'p', 's', '*']);
const BOND_AND_SYNTAX = new Set(['-', '=', '#', '$', ':', '/', '\\', '.', '(', ')']);

/**
 * Heuristic: does the text look like a SMILES string rather than a compound name?
 * Requirements: no whitespace, every character is valid SMILES syntax (organic-subset atoms or
 * bracket atoms, bonds, branches, ring-closure digits), balanced brackets/parentheses, every
 * ring-closure label used an even number of times, at least one atom, and aromatic (lowercase)
 * atoms only together with ring closures (so name prefixes like "coc…" stay names). Bare 1–2 letter
 * uppercase strings (NO, CO) are left to PubChem because they are more likely formulas / names.
 */
export function looksLikeSmiles(text: string): boolean {
  const s = text.trim();
  if (!s || /\s/.test(s)) return false;
  let atoms = 0;
  let aromatic = 0;
  let depth = 0;
  const ringCounts = new Map<string, number>();
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '[') {
      const end = s.indexOf(']', i + 1);
      if (end < 0) return false;
      const inner = s.slice(i + 1, end);
      // Bracket atom: optional isotope, element symbol (or aromatic), optional chirality / H count / charge / class.
      if (!/^\d*(?:[A-Z][a-z]?|[bcnops]|se|as|\*)(?:@{1,2}|@[A-Z]{2}\d*)?(?:H\d*)?(?:[+-]+\d*)?(?::\d+)?$/.test(inner)) return false;
      atoms++;
      i = end + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (ORGANIC_TWO.includes(two)) {
      atoms++;
      i += 2;
      continue;
    }
    if (ORGANIC_ONE.has(ch)) {
      atoms++;
      if (ch >= 'a' && ch <= 'z') aromatic++;
      i++;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      ringCounts.set(ch, (ringCounts.get(ch) ?? 0) + 1);
      i++;
      continue;
    }
    if (ch === '%') {
      const label = s.slice(i + 1, i + 3);
      if (!/^\d\d$/.test(label)) return false;
      ringCounts.set('%' + label, (ringCounts.get('%' + label) ?? 0) + 1);
      i += 3;
      continue;
    }
    if (BOND_AND_SYNTAX.has(ch)) {
      if (ch === '(') depth++;
      if (ch === ')' && --depth < 0) return false;
      i++;
      continue;
    }
    return false;
  }
  if (atoms === 0 || depth !== 0) return false;
  for (const n of ringCounts.values()) if (n % 2 !== 0) return false;
  // Aromatic (lowercase) atoms only exist in rings: "coc" is a name prefix (cocaine), not SMILES.
  if (aromatic > 0 && ringCounts.size === 0) return false;
  // Short all-uppercase words (NO, CO, CN) are ambiguous: prefer a PubChem name lookup.
  if (/^[A-Z]{1,2}$/.test(s)) return false;
  return true;
}

/** Classify the search text. Returns null for empty input. */
export function detectSearchKind(text: string): SearchKind | null {
  const s = text.trim();
  if (!s) return null;
  if (isPdbId(s) && /[A-Za-z]/.test(s)) return 'pdb';
  if (isUniprotId(s)) return 'alphafold';
  if (looksLikeSmiles(s)) return 'smiles';
  return 'pubchem';
}

/** Short human description of what Enter will do, e.g. "Fetch PDB entry 1CRN". */
export function describeSearch(kind: SearchKind, text: string): string {
  const s = text.trim();
  switch (kind) {
    case 'pdb':
      return `Fetch PDB entry ${s.toUpperCase()} from RCSB`;
    case 'alphafold':
      return `Fetch the AlphaFold model for UniProt ${s.toUpperCase()}`;
    case 'smiles':
      return 'Build a 3D structure from this SMILES';
    case 'pubchem':
      return /^\d+$/.test(s) ? `Fetch PubChem compound CID ${s}` : `Search PubChem for “${s}”`;
  }
}

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  pdb: 'PDB',
  pubchem: 'PubChem',
  alphafold: 'AlphaFold',
  smiles: 'SMILES',
};
