import { describe, expect, it } from 'vitest';
import { externalLink } from './links';

describe('externalLink', () => {
  it('links PDB entries to RCSB', () => {
    expect(externalLink({ source: 'pdb', externalId: '1crn' })?.href).toBe('https://www.rcsb.org/structure/1CRN');
    expect(externalLink({ source: 'file', format: 'pdb', externalId: '4HHB' })?.href).toBe('https://www.rcsb.org/structure/4HHB');
  });
  it('links PubChem CIDs', () => {
    expect(externalLink({ source: 'pubchem', externalId: '2519' })?.href).toBe('https://pubchem.ncbi.nlm.nih.gov/compound/2519');
    expect(externalLink({ source: 'pubchem', externalId: 'caffeine' })).toBeNull();
  });
  it('links AlphaFold models by UniProt accession', () => {
    expect(externalLink({ source: 'alphafold', externalId: 'P69905' })?.href).toBe('https://alphafold.ebi.ac.uk/entry/P69905');
    expect(externalLink({ source: 'alphafold', externalId: 'AF-P69905-F1' })?.href).toBe('https://alphafold.ebi.ac.uk/entry/P69905');
  });
  it('returns null without a usable id', () => {
    expect(externalLink({ source: 'pdb' })).toBeNull();
    expect(externalLink({ source: 'file', format: 'sdf', externalId: '1CRN' })).toBeNull();
    expect(externalLink({ source: 'pdb', externalId: 'not-an-id' })).toBeNull();
  });
});
