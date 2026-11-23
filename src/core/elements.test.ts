import { describe, expect, it } from 'vitest';
import { COMMON_ELEMENTS, ELEMENTS, elementByNumber, getElement, isKnownElement, isValenceUnchecked, normalizeElementSymbol } from './elements';

describe('periodic table data', () => {
  it('has the dummy X plus elements 1–118 in order with unique symbols', () => {
    expect(ELEMENTS).toHaveLength(119);
    expect(ELEMENTS[0]).toMatchObject({ number: 0, symbol: 'X', valences: [], category: 'unknown', tableRow: 0, tableCol: 0 });
    ELEMENTS.forEach((e, i) => expect(e.number).toBe(i));
    expect(new Set(ELEMENTS.map((e) => e.symbol)).size).toBe(119);
    expect(ELEMENTS[118].symbol).toBe('Og');
  });

  it('has sane ranges for every element', () => {
    for (const e of ELEMENTS.slice(1)) {
      expect(e.mass).toBeGreaterThan(0);
      expect(e.covalentRadius).toBeGreaterThan(0.2);
      expect(e.covalentRadius).toBeLessThan(2.7);
      expect(e.vdwRadius).toBeGreaterThanOrEqual(1.2);
      expect(e.vdwRadius).toBeLessThan(3.6);
      expect(e.color).toMatch(/^#[0-9a-f]{6}$/);
      if (e.electronegativity !== undefined) {
        expect(e.electronegativity).toBeGreaterThan(0.6);
        expect(e.electronegativity).toBeLessThanOrEqual(3.98);
      }
      expect(e.valences).toEqual([...e.valences].sort((a, b) => a - b));
    }
    // masses increase with Z except the well-known inversions (Ar/K, Co/Ni, Te/I, Th/Pa, U/Np, Pu/Am, …)
    expect(getElement('Ar').mass).toBeGreaterThan(getElement('K').mass);
    expect(getElement('Te').mass).toBeGreaterThan(getElement('I').mass);
  });

  it('matches reference values', () => {
    expect(getElement('H')).toMatchObject({ mass: 1.008, covalentRadius: 0.31, vdwRadius: 1.2, color: '#ffffff', valences: [1], electronegativity: 2.2 });
    expect(getElement('C')).toMatchObject({ mass: 12.011, covalentRadius: 0.76, vdwRadius: 1.7, color: '#909090', valences: [4], category: 'nonmetal' });
    expect(getElement('N')).toMatchObject({ mass: 14.007, covalentRadius: 0.71, vdwRadius: 1.55, color: '#3050f8' });
    expect(getElement('O')).toMatchObject({ mass: 15.999, covalentRadius: 0.66, vdwRadius: 1.52, color: '#ff0d0d', electronegativity: 3.44 });
    expect(getElement('S')).toMatchObject({ mass: 32.06, valences: [2, 4, 6], color: '#ffff30' });
    expect(getElement('Cl')).toMatchObject({ mass: 35.45, color: '#1ff01f', valences: [1, 3, 5, 7], category: 'halogen' });
    expect(getElement('Fe')).toMatchObject({ number: 26, mass: 55.845, covalentRadius: 1.32, color: '#e06633', valences: [], category: 'transition' });
    expect(getElement('Zn')).toMatchObject({ vdwRadius: 1.39, color: '#7d80b0' });
    expect(getElement('Au')).toMatchObject({ number: 79, mass: 196.97, color: '#ffd123' });
    expect(getElement('U')).toMatchObject({ number: 92, mass: 238.03, category: 'actinide' });
    expect(getElement('Pu').mass).toBe(244);
    expect(getElement('Tc').mass).toBe(98);
  });

  it('categorises elements', () => {
    const cat = (s: string) => getElement(s).category;
    expect(['He', 'Ne', 'Ar', 'Kr', 'Xe', 'Rn', 'Og'].map(cat)).toEqual(Array(7).fill('noble-gas'));
    expect(['Li', 'Na', 'K', 'Rb', 'Cs', 'Fr'].map(cat)).toEqual(Array(6).fill('alkali'));
    expect(['Be', 'Mg', 'Ca', 'Sr', 'Ba', 'Ra'].map(cat)).toEqual(Array(6).fill('alkaline-earth'));
    expect(['B', 'Si', 'Ge', 'As', 'Sb', 'Te'].map(cat)).toEqual(Array(6).fill('metalloid'));
    expect(['F', 'Cl', 'Br', 'I', 'At', 'Ts'].map(cat)).toEqual(Array(6).fill('halogen'));
    expect(['Al', 'Ga', 'Sn', 'Pb', 'Bi', 'Po'].map(cat)).toEqual(Array(6).fill('post-transition'));
    expect(['La', 'Ce', 'Lu'].map(cat)).toEqual(Array(3).fill('lanthanide'));
    expect(['Ac', 'Th', 'Lr'].map(cat)).toEqual(Array(3).fill('actinide'));
    expect(['Sc', 'Hg', 'Rf', 'Cn'].map(cat)).toEqual(Array(4).fill('transition'));
    expect(isValenceUnchecked('Na')).toBe(true);
    expect(isValenceUnchecked('P')).toBe(false);
  });

  it('lays out a standard periodic table (f-block on rows 9/10, columns 3–17)', () => {
    const cells = new Set<string>();
    for (const e of ELEMENTS.slice(1)) {
      const key = `${e.tableRow},${e.tableCol}`;
      expect(cells.has(key)).toBe(false);
      cells.add(key);
      expect(e.tableCol).toBeGreaterThanOrEqual(1);
      expect(e.tableCol).toBeLessThanOrEqual(18);
      expect([1, 2, 3, 4, 5, 6, 7, 9, 10]).toContain(e.tableRow);
    }
    const at = (s: string) => [getElement(s).tableRow, getElement(s).tableCol];
    expect(at('H')).toEqual([1, 1]);
    expect(at('He')).toEqual([1, 18]);
    expect(at('B')).toEqual([2, 13]);
    expect(at('Na')).toEqual([3, 1]);
    expect(at('Fe')).toEqual([4, 8]);
    expect(at('Ba')).toEqual([6, 2]);
    expect(at('Hf')).toEqual([6, 4]);
    expect(at('Rn')).toEqual([6, 18]);
    expect(at('La')).toEqual([9, 3]);
    expect(at('Lu')).toEqual([9, 17]);
    expect(at('Ac')).toEqual([10, 3]);
    expect(at('Lr')).toEqual([10, 17]);
    expect(at('Og')).toEqual([7, 18]);
    // placeholders for the f-block in the main table stay empty
    expect(cells.has('6,3')).toBe(false);
    expect(cells.has('7,3')).toBe(false);
    // group / period metadata
    expect(getElement('Cl')).toMatchObject({ group: 17, period: 3 });
    expect(getElement('Eu')).toMatchObject({ period: 6 });
    expect(getElement('Eu').group).toBeUndefined();
  });
});

describe('lookup helpers', () => {
  it('getElement / isKnownElement / elementByNumber', () => {
    expect(getElement('cl').symbol).toBe('Cl');
    expect(getElement('FE').symbol).toBe('Fe');
    expect(getElement('Qq').symbol).toBe('X');
    expect(isKnownElement('Na')).toBe(true);
    expect(isKnownElement('X')).toBe(false);
    expect(isKnownElement('Zz')).toBe(false);
    expect(elementByNumber(6).symbol).toBe('C');
    expect(elementByNumber(0).symbol).toBe('X');
    expect(elementByNumber(200).symbol).toBe('X');
    for (const s of COMMON_ELEMENTS) expect(isKnownElement(s)).toBe(true);
  });

  it('normalizeElementSymbol', () => {
    expect(normalizeElementSymbol('CL')).toBe('Cl');
    expect(normalizeElementSymbol('c')).toBe('C');
    expect(normalizeElementSymbol(' FE')).toBe('Fe');
    expect(normalizeElementSymbol('O1-')).toBe('O');
    expect(normalizeElementSymbol('Na+')).toBe('Na');
    expect(normalizeElementSymbol('CA')).toBe('Ca');
    expect(normalizeElementSymbol('C1')).toBe('C');
    expect(normalizeElementSymbol('Og')).toBe('Og');
    expect(normalizeElementSymbol('D')).toBe('H');
    expect(normalizeElementSymbol('T')).toBe('H');
    expect(normalizeElementSymbol('')).toBe('X');
    expect(normalizeElementSymbol('123')).toBe('X');
    expect(normalizeElementSymbol('Qq')).toBe('X');
    expect(normalizeElementSymbol('X')).toBe('X');
  });
});
