/**
 * Helpers for working with selection-language query strings in the UI. Pure functions.
 */

/**
 * Compact selection query for a set of atom ids, using ranges for consecutive runs of 3 or more:
 * [1,2,3,5,7,8,9,10] → "id 1 to 3 or id 5 or id 7 to 10". Empty → "none".
 * Atom ids (unlike indices) are stable across edits, so layers built from this keep pointing at
 * the same atoms.
 */
export function idsToQuery(ids: Iterable<number>): string {
  const sorted = [...new Set(ids)].filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return 'none';
  const terms: string[] = [];
  let singles: number[] = [];
  const flushSingles = () => {
    if (singles.length) terms.push('id ' + singles.join(' '));
    singles = [];
  };
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i + 1 >= 3) {
      flushSingles();
      terms.push(`id ${sorted[i]} to ${sorted[j]}`);
    } else {
      for (let k = i; k <= j; k++) singles.push(sorted[k]);
    }
    i = j + 1;
  }
  flushSingles();
  return terms.join(' or ');
}

/** Characters that end a token in the selection language (whitespace, parentheses, operators). */
const TOKEN_BREAK = /[\s()!,&|]/;

/** The token being typed at the end of the query and where it starts. */
export function lastToken(query: string): { start: number; token: string } {
  let start = query.length;
  while (start > 0 && !TOKEN_BREAK.test(query[start - 1])) start--;
  return { start, token: query.slice(start) };
}

/**
 * Apply an autocomplete suggestion to a partial query and append a space so the next token's
 * suggestions show up. Supports both suggestion styles: a full query that extends the partial
 * text ("protein and chain") is used as-is; otherwise the suggestion replaces the last token
 * ("protein and ch" + "chain" → "protein and chain ").
 */
export function applySuggestion(query: string, suggestion: string): string {
  const s = suggestion.trim();
  if (!s) return query;
  let next: string;
  if (query.length > 0 && s.toLowerCase().startsWith(query.toLowerCase()) && /[\s()!,&|]/.test(query)) {
    next = s;
  } else {
    const { start } = lastToken(query);
    next = query.slice(0, start) + s;
  }
  return next.endsWith(' ') ? next : next + ' ';
}

/** True if the query refers to the current user selection ('selected' / 'sele' keywords). */
export function mentionsSelected(query: string): boolean {
  return /(^|[\s()!,&|])(selected|sele)(?=$|[\s()!,&|])/i.test(query);
}

/** Short display name for a layer created from a query. */
export function layerNameFromQuery(query: string, max = 28): string {
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return 'Layer';
  return q.length > max ? q.slice(0, max - 1) + '…' : q;
}
