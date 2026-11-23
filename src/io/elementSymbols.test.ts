import { describe, expect, it } from 'vitest';
import { ELEMENT_SYMBOLS, atomicNumber, exactElement, normalizeElement, symbolFromAtomicNumber } from './elementSymbols';

describe('element symbols', () => {
  it('covers elements 1–118 in order', () => {
    expect(ELEMENT_SYMBOLS).toHaveLength(119);
    expect(new Set(ELEMENT_SYMBOLS).size).toBe(119);
    expect([1, 6, 7, 8, 26, 30, 53, 79, 92, 118].map(symbolFromAtomicNumber)).toEqual(['H', 'C', 'N', 'O', 'Fe', 'Zn', 'I', 'Au', 'U', 'Og']);
    expect(symbolFromAtomicNumber(0)).toBe('X');
    expect(symbolFromAtomicNumber(200)).toBe('X');
    expect(atomicNumber('Cl')).toBe(17);
    expect(atomicNumber('Q')).toBe(0);
  });

  it('normalizes raw element text like core normalizeElementSymbol', () => {
    expect(normalizeElement('CL')).toBe('Cl');
    expect(normalizeElement('c')).toBe('C');
    expect(normalizeElement(' FE')).toBe('Fe');
    expect(normalizeElement('O1-')).toBe('O');
    expect(normalizeElement('Na1+')).toBe('Na');
    expect(normalizeElement('CX')).toBe('C');
    expect(normalizeElement('D')).toBe('H');
    expect(normalizeElement('')).toBe('X');
    expect(normalizeElement('Qq')).toBe('X');
    expect(exactElement('ca')).toBe('Ca');
    expect(exactElement('Cx')).toBeUndefined();
  });
});
