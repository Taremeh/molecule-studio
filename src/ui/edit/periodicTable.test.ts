import { describe, expect, it } from 'vitest';
import type { ElementInfo } from '../../core/elements';
import { ELEMENTS } from '../../core/elements';
import { fBlockMarkers, formatMass, formatValences, periodicCells, searchElements } from './periodicTable';

function el(p: Partial<ElementInfo> & Pick<ElementInfo, 'number' | 'symbol' | 'name'>): ElementInfo {
  return {
    mass: 1,
    covalentRadius: 1,
    vdwRadius: 2,
    color: '#888888',
    valences: [],
    category: 'unknown',
    tableRow: 0,
    tableCol: 0,
    ...p,
  };
}

const SAMPLE: ElementInfo[] = [
  el({ number: 0, symbol: 'X', name: 'Unknown' }),
  el({ number: 1, symbol: 'H', name: 'Hydrogen', tableRow: 1, tableCol: 1, valences: [1], mass: 1.008 }),
  el({ number: 6, symbol: 'C', name: 'Carbon', tableRow: 2, tableCol: 14, valences: [4], mass: 12.011 }),
  el({ number: 17, symbol: 'Cl', name: 'Chlorine', tableRow: 3, tableCol: 17, valences: [1, 3, 5, 7] }),
  el({ number: 20, symbol: 'Ca', name: 'Calcium', tableRow: 4, tableCol: 2 }),
  el({ number: 26, symbol: 'Fe', name: 'Iron', tableRow: 4, tableCol: 8 }),
  el({ number: 55, symbol: 'Cs', name: 'Caesium', tableRow: 6, tableCol: 1 }),
  el({ number: 57, symbol: 'La', name: 'Lanthanum', tableRow: 9, tableCol: 3 }),
  el({ number: 71, symbol: 'Lu', name: 'Lutetium', tableRow: 9, tableCol: 17 }),
  el({ number: 99, symbol: 'Zz', name: 'Duplicate', tableRow: 4, tableCol: 8 }),
  el({ number: 118, symbol: 'Og', name: 'Oganesson', tableRow: 7, tableCol: 18, mass: 294 }),
];

describe('periodicCells', () => {
  it('skips the dummy element and resolves cell collisions by atomic number', () => {
    const cells = periodicCells(SAMPLE);
    expect(cells.find((c) => c.el.symbol === 'X')).toBeUndefined();
    const fe = cells.filter((c) => c.row === 4 && c.col === 8);
    expect(fe).toHaveLength(1);
    expect(fe[0].el.symbol).toBe('Fe');
    expect(cells.map((c) => c.el.number)).toEqual([1, 6, 17, 20, 26, 55, 57, 71, 118]);
  });

  it('never places two real elements in the same cell', () => {
    const cells = periodicCells(ELEMENTS);
    const keys = new Set(cells.map((c) => `${c.row}:${c.col}`));
    expect(keys.size).toBe(cells.length);
    expect(cells.every((c) => c.el.number > 0)).toBe(true);
  });

  it('adds an f-block marker only where group 3 is empty', () => {
    const cells = periodicCells(SAMPLE);
    const markers = fBlockMarkers(cells);
    expect(markers).toEqual([{ row: 6, col: 3, label: '57–71', title: 'Lanthanides' }]);
    const withLaInMain = [...cells, { el: SAMPLE[7], row: 6, col: 3 }];
    expect(fBlockMarkers(withLaInMain)).toEqual([]);
  });
});

describe('element search', () => {
  it('ranks exact symbols first, then symbol prefixes, then names', () => {
    const res = searchElements('c', SAMPLE).map((e) => e.symbol);
    expect(res[0]).toBe('C');
    expect(res).toContain('Cl');
    expect(res).toContain('Ca');
    expect(searchElements('iron', SAMPLE)[0].symbol).toBe('Fe');
    expect(searchElements('26', SAMPLE)[0].symbol).toBe('Fe');
    expect(searchElements('FE', SAMPLE)[0].symbol).toBe('Fe');
    expect(searchElements('  ', SAMPLE)).toEqual([]);
    expect(searchElements('x', SAMPLE)).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats masses and valences', () => {
    expect(formatMass(SAMPLE[2])).toBe('12.011');
    expect(formatMass(SAMPLE[10])).toBe('[294]');
    expect(formatValences(SAMPLE[3])).toBe('1 · 3 · 5 · 7');
    expect(formatValences(SAMPLE[5])).toBe('not checked');
  });
});
