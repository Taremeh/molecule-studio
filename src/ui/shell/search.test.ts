import { describe, expect, it } from 'vitest';
import { describeSearch, detectSearchKind, isPdbId, isUniprotId, looksLikeSmiles } from './search';

describe('isPdbId', () => {
  it('accepts 4-character ids starting with a digit', () => {
    for (const id of ['1CRN', '1ubq', '4HHB', '6LU7', ' 1bna ']) expect(isPdbId(id)).toBe(true);
  });
  it('rejects other strings', () => {
    for (const id of ['CRN1', '1CR', '1CRNX', 'caffeine', '', '1-AB']) expect(isPdbId(id)).toBe(false);
  });
});

describe('isUniprotId', () => {
  it('accepts UniProt accessions (case-insensitive)', () => {
    for (const id of ['P69905', 'p04637', 'Q9Y6K9', 'A0A023GPI8', 'O15350']) expect(isUniprotId(id)).toBe(true);
  });
  it('rejects names and PDB ids', () => {
    for (const id of ['caffeine', '1CRN', 'P6990', 'ABCDEF', 'C8H10N4O2']) expect(isUniprotId(id)).toBe(false);
  });
});

describe('looksLikeSmiles', () => {
  it('recognises common SMILES', () => {
    for (const s of [
      'CCO',
      'c1ccccc1',
      'CC(=O)Oc1ccccc1C(=O)O',
      'Cn1cnc2c1c(=O)n(C)c(=O)n2C',
      'C[C@H](N)C(=O)O',
      '[Na+].[Cl-]',
      'C#N',
      'O=C=O',
      'ClC(Cl)Cl',
      'C1CC%10CC1CC%10',
      'F/C=C/F',
    ]) {
      expect(looksLikeSmiles(s), s).toBe(true);
    }
  });
  it('rejects compound names, formulas and malformed strings', () => {
    for (const s of [
      'caffeine',
      'benzene',
      'acetic acid',
      'ibuprofen',
      'ATP',
      'CO2', // unmatched ring-closure digit → formula, not SMILES
      'C6H6',
      'NO',
      'CO',
      '2244',
      'c1ccccc', // unclosed ring
      'CC(C',
      'CC)C',
      '[Na+',
      '1-octanol',
      'co', // prefix of "cocaine" — aromatic atoms without a ring
      'coc',
      'son',
      '',
    ]) {
      expect(looksLikeSmiles(s), s).toBe(false);
    }
  });
});

describe('detectSearchKind', () => {
  it('classifies typical inputs', () => {
    expect(detectSearchKind('1CRN')).toBe('pdb');
    expect(detectSearchKind('4hhb')).toBe('pdb');
    expect(detectSearchKind('2244')).toBe('pubchem'); // all digits → PubChem CID
    expect(detectSearchKind('P69905')).toBe('alphafold');
    expect(detectSearchKind('c1ccccc1')).toBe('smiles');
    expect(detectSearchKind('CCO')).toBe('smiles');
    expect(detectSearchKind('caffeine')).toBe('pubchem');
    expect(detectSearchKind('coc')).toBe('pubchem');
    expect(detectSearchKind('acetylsalicylic acid')).toBe('pubchem');
    expect(detectSearchKind('   ')).toBeNull();
  });
});

describe('describeSearch', () => {
  it('explains what Enter will do', () => {
    expect(describeSearch('pdb', '1crn')).toBe('Fetch PDB entry 1CRN from RCSB');
    expect(describeSearch('pubchem', '2244')).toBe('Fetch PubChem compound CID 2244');
    expect(describeSearch('pubchem', 'caffeine')).toContain('caffeine');
  });
});
