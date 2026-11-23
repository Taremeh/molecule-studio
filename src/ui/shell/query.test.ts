import { describe, expect, it } from 'vitest';
import { applySuggestion, idsToQuery, lastToken, layerNameFromQuery, mentionsSelected } from './query';

describe('idsToQuery', () => {
  it('compresses consecutive runs of 3+ into ranges, in ascending order', () => {
    expect(idsToQuery([1, 2, 3, 5, 7, 8, 9, 10])).toBe('id 1 to 3 or id 5 or id 7 to 10');
  });
  it('lists short runs as singles', () => {
    expect(idsToQuery([4, 5])).toBe('id 4 5');
    expect(idsToQuery([9, 2, 7])).toBe('id 2 7 9');
  });
  it('deduplicates and handles sets', () => {
    expect(idsToQuery(new Set([3, 1, 2, 2]))).toBe('id 1 to 3');
  });
  it('returns none for empty input', () => {
    expect(idsToQuery([])).toBe('none');
  });
  it('keeps singles between ranges grouped', () => {
    expect(idsToQuery([1, 3, 10, 11, 12, 20, 22])).toBe('id 1 3 or id 10 to 12 or id 20 22');
  });
});

describe('lastToken', () => {
  it('finds the token being typed', () => {
    expect(lastToken('protein and ch')).toEqual({ start: 12, token: 'ch' });
    expect(lastToken('not(prot')).toEqual({ start: 4, token: 'prot' });
    expect(lastToken('chain A ')).toEqual({ start: 8, token: '' });
    expect(lastToken('')).toEqual({ start: 0, token: '' });
  });
});

describe('applySuggestion', () => {
  it('replaces the last token with a token suggestion', () => {
    expect(applySuggestion('protein and ch', 'chain')).toBe('protein and chain ');
    expect(applySuggestion('resname HI', 'HIS')).toBe('resname HIS ');
    expect(applySuggestion('pro', 'protein')).toBe('protein ');
  });
  it('appends a value after a trailing space', () => {
    expect(applySuggestion('chain ', 'A')).toBe('chain A ');
  });
  it('accepts full-query suggestions that extend the partial text', () => {
    expect(applySuggestion('protein and ch', 'protein and chain')).toBe('protein and chain ');
    expect(applySuggestion('chain ', 'chain A')).toBe('chain A ');
  });
  it('works inside parentheses', () => {
    expect(applySuggestion('not (wat', 'water')).toBe('not (water ');
  });
});

describe('mentionsSelected', () => {
  it('detects the selected keyword as a whole word', () => {
    expect(mentionsSelected('selected')).toBe(true);
    expect(mentionsSelected('within 5 of sele')).toBe(true);
    expect(mentionsSelected('not(selected)')).toBe(true);
    expect(mentionsSelected('resname SEL')).toBe(false);
    expect(mentionsSelected('selenium')).toBe(false);
  });
});

describe('layerNameFromQuery', () => {
  it('normalises whitespace and truncates', () => {
    expect(layerNameFromQuery('  protein   and chain A ')).toBe('protein and chain A');
    expect(layerNameFromQuery('a'.repeat(40), 10)).toBe('aaaaaaaaa…');
    expect(layerNameFromQuery('')).toBe('Layer');
  });
});
