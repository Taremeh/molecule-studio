/**
 * Sample-gallery helpers (filtering, grouping, quick-start picks). Pure functions.
 */
import type { SampleEntry } from '../../io/samples';

export type SampleCategory = SampleEntry['category'];

export const CATEGORY_ORDER: SampleCategory[] = ['small', 'protein', 'nucleic', 'material'];

export const CATEGORY_LABELS: Record<SampleCategory, string> = {
  small: 'Small molecules',
  protein: 'Proteins',
  nucleic: 'Nucleic acids',
  material: 'Materials',
};

/** Singular badge text for cards. */
export const CATEGORY_BADGES: Record<SampleCategory, string> = {
  small: 'Small molecule',
  protein: 'Protein',
  nucleic: 'Nucleic acid',
  material: 'Material',
};

/** Where a sample comes from (for a small source hint on cards). */
export function sampleSourceLabel(s: SampleEntry): string {
  switch (s.source.kind) {
    case 'embedded':
      return 'Offline';
    case 'pdb':
      return `PDB ${s.source.id.toUpperCase()}`;
    case 'pubchem':
      return 'PubChem';
    case 'smiles':
      return 'SMILES';
  }
}

/**
 * Case-insensitive search over name, description, tags, id, category and PDB id.
 * Every whitespace-separated word of the query must match somewhere.
 */
export function filterSamples(samples: readonly SampleEntry[], query: string, category: SampleCategory | 'all' = 'all'): SampleEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return samples.filter((s) => {
    if (category !== 'all' && s.category !== category) return false;
    if (words.length === 0) return true;
    const hay = [
      s.name,
      s.description,
      s.id,
      CATEGORY_LABELS[s.category],
      ...(s.tags ?? []),
      s.source.kind === 'pdb' ? s.source.id : '',
      s.source.kind === 'pubchem' ? s.source.query : '',
    ]
      .join(' ')
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Group samples by category in CATEGORY_ORDER, omitting empty groups. */
export function groupSamples(samples: readonly SampleEntry[]): { category: SampleCategory; items: SampleEntry[] }[] {
  return CATEGORY_ORDER.map((category) => ({ category, items: samples.filter((s) => s.category === category) })).filter((g) => g.items.length > 0);
}

/**
 * Pick `n` quick-start samples spread across categories (round-robin in CATEGORY_ORDER, keeping the
 * gallery order within each category), returned grouped by category order.
 */
export function pickQuickStart(samples: readonly SampleEntry[], n: number): SampleEntry[] {
  const groups = groupSamples(samples).map((g) => g.items.slice());
  const picked: SampleEntry[] = [];
  let round = 0;
  while (picked.length < n) {
    let any = false;
    for (const g of groups) {
      if (round < g.length && picked.length < n) {
        picked.push(g[round]);
        any = true;
      }
    }
    if (!any) break;
    round++;
  }
  const order = (s: SampleEntry) => CATEGORY_ORDER.indexOf(s.category) * 1e6 + samples.indexOf(s);
  return picked.sort((a, b) => order(a) - order(b));
}
