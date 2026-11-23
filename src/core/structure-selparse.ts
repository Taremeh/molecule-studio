/**
 * Selection language: tokenizer, keyword table and recursive-descent parser → AST.
 * Evaluation lives in core/selection.ts. OWNER: structure agent.
 *
 * Precedence: not > and > or (',' is or). Keyword arguments (`within … of <term>`,
 * `same residue as <term>`, `bonded to <term>`, `byres <term>`) bind to a single term, so
 * `within 5 of ligand and protein` = `(within 5 of ligand) and protein`.
 */

// ---------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------

export type FlagName =
  | 'protein' | 'nucleic' | 'water' | 'ion' | 'ligand' | 'hetero' | 'organic' | 'backbone' | 'sidechain'
  | 'hydrogen' | 'heavy' | 'helix' | 'sheet' | 'coil' | 'acidic' | 'basic' | 'polar' | 'hydrophobic'
  | 'aromatic' | 'charged';

export type ValueField = 'element' | 'name' | 'resname' | 'chain';
export type NumberField = 'resid' | 'index' | 'id' | 'serial';
export type PropField = 'bfactor' | 'occupancy' | 'charge' | 'x' | 'y' | 'z';
export type CompareOp = '<' | '<=' | '>' | '>=' | '==' | '!=';
export type SameWhat = 'residue' | 'chain' | 'fragment';

/** Integer list + inclusive ranges; resid values may carry an insertion code. */
export interface NumberSet {
  values: Set<number>;
  ranges: [number, number][];
  /** resid only: residue number + insertion code pairs, e.g. 100A → "100A". */
  withICode: Set<string>;
}

export type SelNode =
  | { t: 'all' }
  | { t: 'none' }
  | { t: 'not'; a: SelNode }
  | { t: 'and'; a: SelNode; b: SelNode }
  | { t: 'or'; a: SelNode; b: SelNode }
  | { t: 'flag'; flag: FlagName }
  | { t: 'values'; field: ValueField; values: string[] }
  | { t: 'numbers'; field: NumberField; set: NumberSet }
  | { t: 'compare'; field: PropField; op: CompareOp; value: number }
  | { t: 'propIn'; field: PropField; values: number[]; ranges: [number, number][] }
  | { t: 'within'; dist: number; exclusive: boolean; a: SelNode }
  | { t: 'same'; what: SameWhat; a: SelNode }
  | { t: 'bonded'; a: SelNode }
  | { t: 'selected' }
  | { t: 'bare'; word: string };

// ---------------------------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------------------------

type KeywordKind =
  | { k: 'all' }
  | { k: 'none' }
  | { k: 'flag'; flag: FlagName }
  | { k: 'values'; field: ValueField }
  | { k: 'numbers'; field: NumberField }
  | { k: 'prop'; field: PropField }
  | { k: 'within'; exclusive: boolean }
  | { k: 'same' }
  | { k: 'by'; what: SameWhat }
  | { k: 'bonded' }
  | { k: 'selected' }
  /** Structural words that only appear inside other constructs. */
  | { k: 'syntax' };

interface KeywordDef {
  names: string[];
  kind: KeywordKind;
  description: string;
  example: string;
}

const flag = (f: FlagName): KeywordKind => ({ k: 'flag', flag: f });

export const KEYWORD_DEFS: KeywordDef[] = [
  { names: ['all', 'everything', '*'], kind: { k: 'all' }, description: 'Every atom', example: 'all' },
  { names: ['none'], kind: { k: 'none' }, description: 'No atoms', example: 'none' },
  { names: ['protein'], kind: flag('protein'), description: 'Amino-acid residues', example: 'protein' },
  { names: ['nucleic'], kind: flag('nucleic'), description: 'DNA / RNA residues', example: 'nucleic' },
  { names: ['water', 'waters', 'solvent'], kind: flag('water'), description: 'Water molecules (HOH, WAT, TIP3, …)', example: 'water' },
  { names: ['ion', 'ions'], kind: flag('ion'), description: 'Monatomic ions (NA, CL, ZN, MG, …)', example: 'ion' },
  { names: ['ligand', 'ligands'], kind: flag('ligand'), description: 'Small molecules bound to a macromolecule (not water or ions)', example: 'ligand' },
  { names: ['hetero'], kind: flag('hetero'), description: 'HETATM records', example: 'hetero and not water' },
  { names: ['organic'], kind: flag('organic'), description: 'Carbon-containing non-polymer molecules', example: 'organic' },
  { names: ['backbone'], kind: flag('backbone'), description: "Protein N CA C O and nucleic P OP1 OP2 O5' C5' C4' C3' O3'", example: 'backbone' },
  { names: ['sidechain', 'sidechains'], kind: flag('sidechain'), description: 'Protein atoms that are not backbone', example: 'sidechain and resname LYS' },
  { names: ['hydrogen', 'hydrogens'], kind: flag('hydrogen'), description: 'Hydrogen atoms', example: 'not hydrogen' },
  { names: ['heavy'], kind: flag('heavy'), description: 'Non-hydrogen atoms', example: 'heavy and ligand' },
  { names: ['helix', 'alpha'], kind: flag('helix'), description: 'Residues in α-helices', example: 'helix' },
  { names: ['sheet', 'strand'], kind: flag('sheet'), description: 'Residues in β-strands', example: 'sheet and chain A' },
  { names: ['coil', 'loop'], kind: flag('coil'), description: 'Protein residues outside helices and strands', example: 'coil' },
  { names: ['acidic'], kind: flag('acidic'), description: 'ASP GLU', example: 'acidic' },
  { names: ['basic'], kind: flag('basic'), description: 'LYS ARG HIS', example: 'basic' },
  { names: ['polar'], kind: flag('polar'), description: 'SER THR ASN GLN CYS TYR and charged residues', example: 'polar' },
  { names: ['hydrophobic'], kind: flag('hydrophobic'), description: 'ALA VAL LEU ILE MET PHE TRP PRO', example: 'hydrophobic and sidechain' },
  { names: ['aromatic'], kind: flag('aromatic'), description: 'PHE TYR TRP HIS, and atoms in aromatic rings of other molecules', example: 'aromatic' },
  { names: ['charged'], kind: flag('charged'), description: 'ASP GLU LYS ARG HIS', example: 'charged' },
  { names: ['element', 'elem'], kind: { k: 'values', field: 'element' }, description: 'Element symbols', example: 'element C N O' },
  { names: ['name', 'atomname'], kind: { k: 'values', field: 'name' }, description: 'Atom names; wildcards * and ?', example: 'name CA C*' },
  { names: ['resname', 'resn'], kind: { k: 'values', field: 'resname' }, description: 'Residue names; wildcards * and ?', example: 'resname HIS HEM' },
  { names: ['resid', 'resi', 'residue', 'resseq'], kind: { k: 'numbers', field: 'resid' }, description: 'Residue numbers, lists and ranges (insertion codes like 52A)', example: 'resid 10 to 20' },
  { names: ['chain'], kind: { k: 'values', field: 'chain' }, description: 'Chain identifiers (case-sensitive)', example: 'chain A B' },
  { names: ['index'], kind: { k: 'numbers', field: 'index' }, description: 'Atom index, 0-based', example: 'index 0 to 9' },
  { names: ['id'], kind: { k: 'numbers', field: 'id' }, description: 'Atom ids', example: 'id 1 2 3' },
  { names: ['serial'], kind: { k: 'numbers', field: 'serial' }, description: 'Atom serial numbers from the file', example: 'serial 100-200' },
  { names: ['bfactor', 'beta'], kind: { k: 'prop', field: 'bfactor' }, description: 'B-factor: compare (<, >, <=, >=, ==, !=) or values / ranges', example: 'bfactor > 50' },
  { names: ['occupancy', 'occ'], kind: { k: 'prop', field: 'occupancy' }, description: 'Occupancy', example: 'occupancy < 1' },
  { names: ['charge'], kind: { k: 'prop', field: 'charge' }, description: 'Formal charge', example: 'charge != 0' },
  { names: ['x'], kind: { k: 'prop', field: 'x' }, description: 'X coordinate (Å)', example: 'x < 0' },
  { names: ['y'], kind: { k: 'prop', field: 'y' }, description: 'Y coordinate (Å)', example: 'y > 10' },
  { names: ['z'], kind: { k: 'prop', field: 'z' }, description: 'Z coordinate (Å)', example: 'z 0 to 5' },
  { names: ['within'], kind: { k: 'within', exclusive: false }, description: 'Atoms within a distance (Å) of a selection, including it', example: 'within 5 of ligand' },
  { names: ['exwithin'], kind: { k: 'within', exclusive: true }, description: 'Like within, but excluding the selection itself', example: 'exwithin 4 of resname HEM' },
  { names: ['same'], kind: { k: 'same' }, description: 'Complete residues / chains / fragments of a selection', example: 'same residue as within 4 of ligand' },
  { names: ['byres'], kind: { k: 'by', what: 'residue' }, description: 'Same as "same residue as"', example: 'byres within 5 of ion' },
  { names: ['bychain'], kind: { k: 'by', what: 'chain' }, description: 'Same as "same chain as"', example: 'bychain resname HEM' },
  { names: ['bonded'], kind: { k: 'bonded' }, description: 'Atoms bonded to a selection', example: 'bonded to element S' },
  { names: ['selected', 'sele'], kind: { k: 'selected' }, description: 'The current selection in the viewer', example: 'byres selected' },
  { names: ['not', '!'], kind: { k: 'syntax' }, description: 'Negation (binds tightest)', example: 'protein and not backbone' },
  { names: ['and', '&'], kind: { k: 'syntax' }, description: 'Both conditions', example: 'chain A and helix' },
  { names: ['or', '|', ','], kind: { k: 'syntax' }, description: 'Either condition (lowest precedence)', example: 'water or ion' },
  { names: ['of', 'as', 'to'], kind: { k: 'syntax' }, description: 'Used inside within / same / bonded / ranges', example: 'resid 1 to 10' },
];

const KEYWORDS = new Map<string, KeywordKind>();
for (const d of KEYWORD_DEFS) for (const n of d.names) KEYWORDS.set(n, d.kind);

/** Words that can start a term (for suggestions / typo detection). */
export const TERM_KEYWORDS: string[] = KEYWORD_DEFS.filter((d) => d.kind.k !== 'syntax').flatMap((d) => d.names.filter((n) => /^[a-z]+$/.test(n)));
const ALL_WORD_KEYWORDS = [...TERM_KEYWORDS, 'and', 'or', 'not', 'of', 'as', 'to'];

export function keywordKind(word: string): KeywordKind | undefined {
  return KEYWORDS.get(word.toLowerCase());
}

/** Value lists stop at keywords; single-letter coordinate keywords are kept as values (chain X). */
function stopsValueList(word: string): boolean {
  const w = word.toLowerCase();
  return KEYWORDS.has(w) && w !== 'x' && w !== 'y' && w !== 'z' && w !== '*';
}

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

export type TokType = 'word' | 'string' | 'lparen' | 'rparen' | 'and' | 'or' | 'comma' | 'not' | 'cmp' | 'end';

export interface Token {
  type: TokType;
  text: string;
  start: number;
  end: number;
}

export class SelectionSyntaxError extends Error {}

const WORD_BREAK = new Set([' ', '\t', '\n', '\r', '(', ')', '&', '|', ',', '!', '<', '>', '=', '"']);

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  const push = (type: TokType, start: number, end: number, text = src.slice(start, end)) => out.push({ type, text, start, end });
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (ch === '(') push('lparen', i, ++i);
    else if (ch === ')') push('rparen', i, ++i);
    else if (two === '&&' || two === '||') {
      push(two === '&&' ? 'and' : 'or', i, i + 2);
      i += 2;
    } else if (ch === '&') push('and', i, ++i);
    else if (ch === '|') push('or', i, ++i);
    else if (ch === ',') push('comma', i, ++i);
    else if (two === '!=' || two === '<=' || two === '>=' || two === '==') {
      push('cmp', i, i + 2);
      i += 2;
    } else if (ch === '!') push('not', i, ++i);
    else if (ch === '<' || ch === '>') push('cmp', i, ++i);
    else if (ch === '=') push('cmp', i, ++i, '==');
    else if (ch === '"') {
      const close = src.indexOf('"', i + 1);
      if (close < 0) throw new SelectionSyntaxError(`Missing closing quote for "${src.slice(i + 1)}`);
      push('string', i, close + 1, src.slice(i + 1, close));
      i = close + 1;
    } else {
      const start = i;
      while (i < n && !WORD_BREAK.has(src[i])) i++;
      const text = src.slice(start, i);
      const low = text.toLowerCase();
      push(low === 'and' ? 'and' : low === 'or' ? 'or' : low === 'not' ? 'not' : 'word', start, i, text);
    }
  }
  out.push({ type: 'end', text: '', start: n, end: n });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Typo suggestions
// ---------------------------------------------------------------------------------------------

/** Optimal string alignment distance (Levenshtein + adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** Closest keyword to a (probably misspelt) word, or null if nothing is close enough. */
export function suggestKeyword(word: string): string | null {
  const w = word.toLowerCase();
  if (w.length < 4 || KEYWORDS.has(w)) return null;
  const maxDist = w.length >= 6 ? 2 : 1;
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of ALL_WORD_KEYWORDS) {
    if (k.length < 3) continue;
    const dd = editDistance(w, k);
    if (dd < bestD) {
      bestD = dd;
      best = k;
    }
  }
  return bestD <= maxDist ? best : null;
}

export function unknownKeywordMessage(word: string, suggestion: string): string {
  return `Unknown keyword '${word}' — did you mean '${suggestion}'?`;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

export interface ParseResult {
  ast: SelNode;
  /** True if the query references the viewer selection (result depends on context). */
  usesSelection: boolean;
}

const INT_RE = /^[-+]?\d+$/;
const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
/** a-b, a:b, or a..b (the parser's internal form of 'a to b'). */
const INT_RANGE_RE = /^([-+]?\d+)(?:-|:|\.\.)([-+]?\d+)$/;
const NUM_RANGE_RE = /^([-+]?(?:\d+\.?\d*|\.\d+))(?::|\.\.)([-+]?(?:\d+\.?\d*|\.\d+))$/;
const RESID_ICODE_RE = /^([-+]?\d+)([A-Za-z])$/;

export function parseSelection(src: string): ParseResult {
  const toks = tokenize(src);
  let pos = 0;
  let usesSelection = false;
  /** Last bare word parsed, to explain "chian A"-style typos when the next token is unexpected. */
  let lastBare: string | null = null;

  const peek = () => toks[pos];
  const next = () => toks[pos++];
  function fail(msg: string): never {
    throw new SelectionSyntaxError(msg);
  }
  const show = (t: Token) => (t.type === 'end' ? 'end of query' : t.type === 'string' ? `"${t.text}"` : `'${t.text}'`);
  const isWordLike = (t: Token) => t.type === 'word' || t.type === 'string';

  function unexpected(t: Token): never {
    if (lastBare && isWordLike(t)) {
      const s = suggestKeyword(lastBare);
      if (s) fail(unknownKeywordMessage(lastBare, s));
    }
    if (t.type === 'rparen') fail(`Unexpected ')' — no matching '('`);
    if (t.type === 'cmp') fail(`Unexpected '${t.text}' — comparisons need a property first, e.g. 'bfactor > 50'`);
    return fail(`Unexpected ${show(t)} — combine selections with 'and' / 'or'`);
  }

  function parseOr(): SelNode {
    let left = parseAnd();
    while (peek().type === 'or' || peek().type === 'comma') {
      const op = next();
      if (peek().type === 'end' || peek().type === 'rparen') fail(`Expected a selection after '${op.text}'`);
      left = { t: 'or', a: left, b: parseAnd() };
    }
    return left;
  }

  function parseAnd(): SelNode {
    let left = parseNot();
    while (peek().type === 'and') {
      const op = next();
      if (peek().type === 'end' || peek().type === 'rparen') fail(`Expected a selection after '${op.text}'`);
      left = { t: 'and', a: left, b: parseNot() };
    }
    return left;
  }

  function parseNot(): SelNode {
    if (peek().type === 'not') {
      const op = next();
      if (peek().type === 'end' || peek().type === 'rparen' || peek().type === 'and' || peek().type === 'or' || peek().type === 'comma')
        fail(`Expected a selection after '${op.text}'`);
      return { t: 'not', a: parseNot() };
    }
    return parsePrimary();
  }

  /** A term argument (after 'of', 'as', 'to', byres). */
  function parseTermAfter(what: string): SelNode {
    const t = peek();
    if (t.type === 'end' || t.type === 'rparen' || t.type === 'and' || t.type === 'or' || t.type === 'comma' || t.type === 'cmp')
      fail(`Expected a selection after '${what}'`);
    return parseNot();
  }

  function expectWord(word: string, after: string, example: string) {
    const t = peek();
    if (t.type === 'word' && t.text.toLowerCase() === word) {
      next();
      return;
    }
    fail(`Expected '${word}' after '${after}', got ${show(t)} (e.g. '${example}')`);
  }

  function parsePrimary(): SelNode {
    const t = peek();
    lastBare = null;
    if (t.type === 'lparen') {
      next();
      if (peek().type === 'rparen') fail(`Empty parentheses '()'`);
      const inner = parseOr();
      if (peek().type !== 'rparen') {
        if (peek().type === 'end') fail(`Missing ')' to close '(' at position ${t.start + 1}`);
        unexpected(peek());
      }
      next();
      lastBare = null;
      return inner;
    }
    if (t.type === 'string') {
      next();
      lastBare = null;
      return { t: 'bare', word: t.text };
    }
    if (t.type !== 'word') {
      if (t.type === 'end') fail('Expected a selection');
      return unexpected(t);
    }
    next();
    const kw = keywordKind(t.text);
    if (!kw) return parseBare(t);
    const word = t.text.toLowerCase();
    switch (kw.k) {
      case 'all':
        return { t: 'all' };
      case 'none':
        return { t: 'none' };
      case 'flag':
        return { t: 'flag', flag: kw.flag };
      case 'selected':
        usesSelection = true;
        return { t: 'selected' };
      case 'values':
        return { t: 'values', field: kw.field, values: parseValueList(word) };
      case 'numbers':
        return { t: 'numbers', field: kw.field, set: parseNumberList(word, kw.field) };
      case 'prop':
        return parseProp(word, kw.field);
      case 'within': {
        const d = peek();
        if (d.type !== 'word' || !NUM_RE.test(d.text) || Number(d.text) < 0)
          fail(`Expected a distance in Å after '${word}', got ${show(d)} (e.g. '${word} 5 of ligand')`);
        next();
        expectWord('of', `${word} ${d.text}`, `${word} ${d.text} of ligand`);
        return { t: 'within', dist: Number(d.text), exclusive: kw.exclusive, a: parseTermAfter('of') };
      }
      case 'same': {
        const w = peek();
        const what = w.type === 'word' ? w.text.toLowerCase() : '';
        if (what !== 'residue' && what !== 'chain' && what !== 'fragment')
          fail(`Expected 'residue', 'chain' or 'fragment' after 'same', got ${show(w)} (e.g. 'same residue as ligand')`);
        next();
        expectWord('as', `same ${what}`, `same ${what} as ligand`);
        return { t: 'same', what: what as SameWhat, a: parseTermAfter('as') };
      }
      case 'by':
        return { t: 'same', what: kw.what, a: parseTermAfter(word) };
      case 'bonded':
        expectWord('to', 'bonded', 'bonded to element S');
        return { t: 'bonded', a: parseTermAfter('to') };
      case 'syntax':
      default:
        return fail(`Unexpected '${t.text}'${word === 'to' || word === 'of' || word === 'as' ? ` — '${word}' only appears inside ranges, within, same or bonded` : ''}`);
    }
  }

  function parseBare(t: Token): SelNode {
    const w = t.text;
    if (INT_RE.test(w)) return { t: 'numbers', field: 'resid', set: parseNumberTokens([w], 'resid', 'resid') };
    if (INT_RANGE_RE.test(w)) return { t: 'numbers', field: 'resid', set: parseNumberTokens([w], 'resid', 'resid') };
    lastBare = w;
    return { t: 'bare', word: w };
  }

  /** Words / strings up to the next operator or keyword; ',' continues the list when followed by a value. */
  function collectValues(): string[] {
    const vals: string[] = [];
    for (;;) {
      const t = peek();
      if (t.type === 'string') {
        vals.push(t.text);
        next();
        continue;
      }
      if (t.type === 'word' && !stopsValueList(t.text)) {
        vals.push(t.text);
        next();
        continue;
      }
      if (t.type === 'comma' && vals.length) {
        const after = toks[pos + 1];
        if (after.type === 'string' || (after.type === 'word' && !stopsValueList(after.text))) {
          next();
          continue;
        }
      }
      return vals;
    }
  }

  function parseValueList(word: string): string[] {
    const vals = collectValues();
    if (vals.length === 0) {
      const ex = word === 'chain' ? 'chain A' : word.startsWith('elem') ? 'element C N' : word.startsWith('res') ? 'resname ALA' : 'name CA';
      fail(`'${word}' needs at least one value, got ${show(peek())} (e.g. '${ex}')`);
    }
    return vals;
  }

  /** Numbers with optional 'a to b' / 'a - b' ranges. */
  function collectNumberTokens(word: string): string[] {
    const out: string[] = [];
    for (;;) {
      const t = peek();
      const isTo = t.type === 'word' && t.text.toLowerCase() === 'to';
      const isDash = t.type === 'word' && t.text === '-' && out.length > 0 && toks[pos + 1].type === 'word';
      if (isTo || isDash) {
        if (!out.length) fail(`Expected a number before 'to' after '${word}'`);
        next();
        const b = peek();
        if (b.type !== 'word' || stopsValueList(b.text)) fail(`Expected a number after '${t.text}', got ${show(b)}`);
        next();
        out[out.length - 1] = `${out[out.length - 1]}..${b.text}`;
        continue;
      }
      if (t.type === 'word' && !stopsValueList(t.text)) {
        out.push(t.text);
        next();
        continue;
      }
      if (t.type === 'comma' && out.length) {
        const after = toks[pos + 1];
        if (after.type === 'word' && !stopsValueList(after.text) && /^[-+\d]/.test(after.text)) {
          next();
          continue;
        }
      }
      return out;
    }
  }

  function parseNumberList(word: string, field: NumberField): NumberSet {
    const raw = collectNumberTokens(word);
    if (raw.length === 0) fail(`'${word}' needs at least one number, got ${show(peek())} (e.g. '${word} 1 to 10')`);
    return parseNumberTokens(raw, field, word);
  }

  function parseNumberTokens(raw: string[], field: NumberField, word: string): NumberSet {
    const set: NumberSet = { values: new Set(), ranges: [], withICode: new Set() };
    for (const r of raw) {
      let m: RegExpMatchArray | null;
      if (INT_RE.test(r)) set.values.add(parseInt(r, 10));
      else if ((m = r.match(INT_RANGE_RE))) {
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        set.ranges.push(a <= b ? [a, b] : [b, a]);
      } else if (field === 'resid' && (m = r.match(RESID_ICODE_RE))) set.withICode.add(`${parseInt(m[1], 10)}${m[2].toUpperCase()}`);
      else {
        const what = field === 'resid' ? 'residue number' : field === 'index' ? 'atom index' : field === 'id' ? 'atom id' : 'serial number';
        fail(`Invalid ${what} '${r.replace('..', ' to ')}' after '${word}'`);
      }
    }
    return set;
  }

  function parseProp(word: string, field: PropField): SelNode {
    const t = peek();
    if (t.type === 'cmp') {
      next();
      const v = peek();
      if (v.type !== 'word' || !NUM_RE.test(v.text)) fail(`Expected a number after '${word} ${t.text}', got ${show(v)}`);
      next();
      return { t: 'compare', field, op: t.text as CompareOp, value: Number(v.text) };
    }
    const raw = collectNumberTokens(word);
    if (raw.length === 0) fail(`'${word}' needs a comparison or values, got ${show(t)} (e.g. '${word} > 10' or '${word} 0 to 10')`);
    const values: number[] = [];
    const ranges: [number, number][] = [];
    for (const r of raw) {
      let m: RegExpMatchArray | null;
      if (NUM_RE.test(r)) values.push(Number(r));
      else if ((m = r.match(NUM_RANGE_RE))) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        ranges.push(a <= b ? [a, b] : [b, a]);
      } else fail(`Invalid number '${r.replace('..', ' to ')}' after '${word}'`);
    }
    return { t: 'propIn', field, values, ranges };
  }

  if (toks.length === 1) return { ast: { t: 'all' }, usesSelection: false };
  const ast = parseOr();
  if (peek().type !== 'end') unexpected(peek());
  return { ast, usesSelection };
}
