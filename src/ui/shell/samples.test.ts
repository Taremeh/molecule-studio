import { describe, expect, it } from 'vitest';
import type { SampleEntry } from '../../io/samples';
import { filterSamples, groupSamples, pickQuickStart, sampleSourceLabel } from './samples';

const s = (id: string, category: SampleEntry['category'], extra: Partial<SampleEntry> = {}): SampleEntry => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  description: `${id} description`,
  category,
  source: { kind: 'pubchem', query: id },
  ...extra,
});

const GALLERY: SampleEntry[] = [
  s('water', 'small', { source: { kind: 'embedded', format: 'xyz', text: '' }, tags: ['solvent'] }),
  s('ethanol', 'small'),
  s('caffeine', 'small', { tags: ['drug', 'stimulant'] }),
  s('aspirin', 'small', { tags: ['drug'] }),
  s('crambin', 'protein', { source: { kind: 'pdb', id: '1crn' } }),
  s('ubiquitin', 'protein', { source: { kind: 'pdb', id: '1UBQ' } }),
  s('hemoglobin', 'protein', { source: { kind: 'pdb', id: '4HHB' } }),
  s('bdna', 'nucleic', { source: { kind: 'pdb', id: '1BNA' } }),
];

describe('filterSamples', () => {
  it('matches name, tags, description and pdb id (all words must match)', () => {
    expect(filterSamples(GALLERY, 'drug').map((x) => x.id)).toEqual(['caffeine', 'aspirin']);
    expect(filterSamples(GALLERY, '1crn').map((x) => x.id)).toEqual(['crambin']);
    expect(filterSamples(GALLERY, 'drug stimulant').map((x) => x.id)).toEqual(['caffeine']);
    expect(filterSamples(GALLERY, 'PROTEINS').length).toBe(3);
    expect(filterSamples(GALLERY, '').length).toBe(GALLERY.length);
    expect(filterSamples(GALLERY, 'zzz')).toEqual([]);
  });
  it('filters by category', () => {
    expect(filterSamples(GALLERY, '', 'nucleic').map((x) => x.id)).toEqual(['bdna']);
  });
});

describe('groupSamples', () => {
  it('groups in category order and omits empty groups', () => {
    const groups = groupSamples(GALLERY);
    expect(groups.map((g) => g.category)).toEqual(['small', 'protein', 'nucleic']);
    expect(groups[1].items.map((x) => x.id)).toEqual(['crambin', 'ubiquitin', 'hemoglobin']);
  });
});

describe('pickQuickStart', () => {
  it('spreads picks across categories round-robin, grouped by category', () => {
    expect(pickQuickStart(GALLERY, 6).map((x) => x.id)).toEqual(['water', 'ethanol', 'caffeine', 'crambin', 'ubiquitin', 'bdna']);
    expect(pickQuickStart(GALLERY, 3).map((x) => x.id)).toEqual(['water', 'crambin', 'bdna']);
  });
  it('returns everything when the gallery is small', () => {
    expect(pickQuickStart(GALLERY.slice(0, 2), 6).map((x) => x.id)).toEqual(['water', 'ethanol']);
    expect(pickQuickStart([], 6)).toEqual([]);
  });
});

describe('sampleSourceLabel', () => {
  it('describes the source', () => {
    expect(sampleSourceLabel(GALLERY[0])).toBe('Offline');
    expect(sampleSourceLabel(GALLERY[4])).toBe('PDB 1CRN');
    expect(sampleSourceLabel(GALLERY[1])).toBe('PubChem');
  });
});
