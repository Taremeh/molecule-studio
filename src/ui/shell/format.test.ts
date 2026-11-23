import { describe, expect, it } from 'vitest';
import {
  bondOrderLabel,
  chargeSuffix,
  formatApprox,
  formatCharge,
  formatCoord,
  formatCount,
  formatKDa,
  formatMass,
  formulaParts,
  plural,
  readableTextColor,
  truncate,
} from './format';

describe('counts', () => {
  it('formats counts with separators', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(0)).toBe('0');
  });
  it('formats approximate counts', () => {
    expect(formatApprox(3)).toBe('3');
    expect(formatApprox(999)).toBe('999');
    expect(formatApprox(1000)).toBe('~1k');
    expect(formatApprox(1234)).toBe('~1.2k');
    expect(formatApprox(12345)).toBe('~12k');
    expect(formatApprox(2_500_000)).toBe('~2.5M');
  });
  it('pluralises', () => {
    expect(plural(1, 'atom')).toBe('1 atom');
    expect(plural(2, 'atom')).toBe('2 atoms');
    expect(plural(1500, 'residue')).toBe('1,500 residues');
    expect(plural(2, 'match', 'matches')).toBe('2 matches');
  });
});

describe('mass', () => {
  it('formats small molecule masses with 2 decimals (caffeine 194.19)', () => {
    expect(formatMass(194.194)).toBe('194.19 g/mol');
  });
  it('formats large masses with separators and kDa', () => {
    expect(formatMass(64458.31)).toBe('64,458.3 g/mol');
    expect(formatKDa(64458.31)).toBe('64.5 kDa');
    expect(formatKDa(194.19)).toBeNull();
  });
  it('handles empty molecules', () => {
    expect(formatMass(0)).toBe('—');
  });
});

describe('charges and coordinates', () => {
  it('formats charges with a sign', () => {
    expect(formatCharge(0)).toBe('0');
    expect(formatCharge(1)).toBe('+1');
    expect(formatCharge(-2)).toBe('−2');
    expect(chargeSuffix(1)).toBe('+');
    expect(chargeSuffix(-1)).toBe('−');
    expect(chargeSuffix(2)).toBe('2+');
    expect(chargeSuffix(undefined)).toBe('');
  });
  it('formats coordinates to 3 decimals without negative zero', () => {
    expect(formatCoord(1.23456)).toBe('1.235');
    expect(formatCoord(-0.5)).toBe('−0.500');
    expect(formatCoord(-0.0001)).toBe('0.000');
  });
});

describe('formulaParts', () => {
  it('splits a Hill formula into element runs and subscripts', () => {
    expect(formulaParts('C8H10N4O2')).toEqual([
      { text: 'C', sub: false },
      { text: '8', sub: true },
      { text: 'H', sub: false },
      { text: '10', sub: true },
      { text: 'N', sub: false },
      { text: '4', sub: true },
      { text: 'O', sub: false },
      { text: '2', sub: true },
    ]);
    expect(formulaParts('HCl')).toEqual([{ text: 'HCl', sub: false }]);
    expect(formulaParts('')).toEqual([]);
  });
});

describe('readableTextColor', () => {
  it('uses dark text on light colors and white on dark colors', () => {
    expect(readableTextColor('#ffffff')).toBe('#0b0f17'); // hydrogen
    expect(readableTextColor('#ffff30')).toBe('#0b0f17'); // sulfur
    expect(readableTextColor('#3050f8')).toBe('#ffffff'); // nitrogen
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('nonsense')).toBe('#0b0f17');
  });
});

describe('misc', () => {
  it('truncates', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
  it('labels bond orders', () => {
    expect(bondOrderLabel(1).name).toBe('single');
    expect(bondOrderLabel(1.5).name).toBe('aromatic');
    expect(bondOrderLabel(2).symbol).toBe('=');
    expect(bondOrderLabel(3).symbol).toBe('≡');
  });
});
