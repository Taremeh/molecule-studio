import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValenceInfo } from '../../core/chemistry';

// Valence analysis belongs to core/chemistry; mock it so the tooltip wording is tested in isolation.
const mocks = vi.hoisted(() => ({
  valenceOf: vi.fn((): ValenceInfo | undefined => undefined),
  shouldShowUnderValence: vi.fn(() => true),
}));
vi.mock('../../core/chemistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/chemistry')>()),
  valenceOf: mocks.valenceOf,
  shouldShowUnderValence: mocks.shouldShowUnderValence,
}));

import { buildMolecule } from '../../core/molecule';
import { getElement } from '../../core/elements';
import { idealBondLength } from '../../core/geometry';
import { describeHover, formatCharge } from './hoverInfo';

function formaldehydeLike() {
  return buildMolecule(
    'h2co',
    [
      { element: 'C', x: 0, y: 0, z: 0, name: 'C1' },
      { element: 'O', x: 1.23, y: 0, z: 0, charge: -1 },
      { element: 'C', name: 'CA', resName: 'ALA', resSeq: 42, chain: 'A', bfactor: 23.44, occupancy: 0.5, serial: 1234, x: 5, y: 0, z: 0 },
    ],
    [{ a: 0, b: 1, order: 2 }],
  );
}

const at = (atomId: number) => ({ kind: 'atom' as const, atomId, clientX: 10, clientY: 10 });

beforeEach(() => {
  mocks.valenceOf.mockReset().mockReturnValue(undefined);
  mocks.shouldShowUnderValence.mockReset().mockReturnValue(true);
});

describe('describeHover', () => {
  it('describes a bond as "C–O · double · 1.23 Å"', () => {
    const m = formaldehydeLike();
    const c = describeHover(m, { kind: 'bond', bondId: 1, clientX: 0, clientY: 0 }, 'view')!;
    expect(c.kind).toBe('bond');
    expect(c.title).toBe('C–O · double · 1.23 Å');
    expect(c.badges.map((b) => b.symbol)).toEqual(['C', 'O']);
    expect(c.lines.map((l) => l.text)).toEqual(['C1 – O2']);
  });

  it('adds the ideal length in edit mode', () => {
    const m = formaldehydeLike();
    const c = describeHover(m, { kind: 'bond', bondId: 1, clientX: 0, clientY: 0 }, 'edit')!;
    const ideal = idealBondLength('C', 'O', 2);
    expect(c.lines[1].text).toContain(`Ideal ${ideal.toFixed(2)} Å`);
  });

  it('describes a protein atom with residue, B-factor and occupancy', () => {
    const c = describeHover(formaldehydeLike(), at(3), 'view')!;
    expect(c.title).toBe(getElement('C').name);
    expect(c.aside).toBe('CA #1234');
    expect(c.lines.map((l) => l.text)).toEqual(['ALA 42 · chain A', 'B 23.4 · occ 0.50']);
  });

  it('shows formal charges', () => {
    const c = describeHover(formaldehydeLike(), at(2), 'view')!;
    expect(c.lines.map((l) => l.text)).toContain('Charge −1');
    expect(formatCharge(2)).toBe('+2');
  });

  it('reports valence status only in edit mode', () => {
    const m = formaldehydeLike();
    mocks.valenceOf.mockReturnValue({ atomId: 1, element: 'C', bondOrderSum: 5, allowed: [4], status: 'over', openValence: 0, message: 'C has 5 bonds (max 4)' });
    expect(describeHover(m, at(1), 'view')!.lines).toEqual([]);
    const edit = describeHover(m, at(1), 'edit')!;
    expect(edit.lines).toEqual([{ text: 'C has 5 bonds (max 4)', tone: 'error' }]);

    mocks.valenceOf.mockReturnValue({ atomId: 1, element: 'C', bondOrderSum: 2, allowed: [4], status: 'under', openValence: 2 });
    expect(describeHover(m, at(1), 'edit')!.lines).toEqual([{ text: '2 open valences', tone: 'warn' }]);
    mocks.shouldShowUnderValence.mockReturnValue(false);
    expect(describeHover(m, at(1), 'edit')!.lines).toEqual([]);

    mocks.valenceOf.mockReturnValue({ atomId: 1, element: 'C', bondOrderSum: 4, allowed: [4], status: 'ok', openValence: 0 });
    expect(describeHover(m, at(1), 'edit')!.lines).toEqual([{ text: 'Valence OK (4)', tone: 'ok' }]);
  });

  it('returns null when there is nothing to describe', () => {
    const m = formaldehydeLike();
    expect(describeHover(m, null, 'view')).toBeNull();
    expect(describeHover(null, at(1), 'view')).toBeNull();
    expect(describeHover(m, at(99), 'view')).toBeNull();
    expect(describeHover(m, { kind: 'bond', bondId: 7, clientX: 0, clientY: 0 }, 'view')).toBeNull();
  });
});
