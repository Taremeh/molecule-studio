/**
 * Dispatch a classified search to the matching app action.
 */
import { openAlphaFold, openPdbId, openPubChem, openSmiles } from '../../app/actions';
import type { SearchKind } from './search';

export function runSearch(kind: SearchKind, text: string, signal?: AbortSignal): Promise<unknown> {
  const q = text.trim();
  switch (kind) {
    case 'pdb':
      return openPdbId(q.toUpperCase(), signal);
    case 'alphafold':
      return openAlphaFold(q.toUpperCase(), signal);
    case 'smiles':
      return openSmiles(q);
    case 'pubchem':
      return openPubChem(q, signal);
  }
}
