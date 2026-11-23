/**
 * External database links for loaded structures. Pure.
 */
import type { MoleculeMeta } from '../../core/types';

const PDB_ID = /^[0-9][A-Za-z0-9]{3}$/;

/**
 * Link to the source database entry, when the metadata allows it:
 *  - AlphaFold DB models → alphafold.ebi.ac.uk/entry/{UniProt}
 *  - PubChem compounds (numeric CID) → pubchem.ncbi.nlm.nih.gov/compound/{cid}
 *  - PDB entries (fetched from RCSB, or a PDB/mmCIF file whose header carries a 4-char id)
 *    → rcsb.org/structure/{id}
 */
export function externalLink(meta: MoleculeMeta): { href: string; label: string; idLabel: string } | null {
  const id = meta.externalId?.trim();
  if (!id) return null;
  const source = meta.source?.toLowerCase() ?? '';
  const format = meta.format?.toLowerCase() ?? '';
  if (source === 'alphafold') {
    // Accept 'P69905' as well as model ids like 'AF-P69905-F1'.
    const acc = id.replace(/^AF-/i, '').replace(/-F\d+.*$/i, '');
    if (/^[A-Z0-9]{6,10}$/i.test(acc)) return { href: `https://alphafold.ebi.ac.uk/entry/${acc.toUpperCase()}`, label: `AlphaFold ${acc.toUpperCase()}`, idLabel: 'UniProt' };
    return null;
  }
  if (source === 'pubchem') {
    return /^\d+$/.test(id) ? { href: `https://pubchem.ncbi.nlm.nih.gov/compound/${id}`, label: `PubChem CID ${id}`, idLabel: 'PubChem CID' } : null;
  }
  const pdbLike = source === 'pdb' || source === 'rcsb' || format === 'pdb' || format === 'cif';
  if (pdbLike && PDB_ID.test(id)) return { href: `https://www.rcsb.org/structure/${id.toUpperCase()}`, label: `RCSB ${id.toUpperCase()}`, idLabel: 'PDB id' };
  return null;
}
