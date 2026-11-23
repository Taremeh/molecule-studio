import { describe, expect, it, vi } from 'vitest';

vi.mock('../core/geometry', async () => ({
  ...(await vi.importActual<object>('../core/geometry')),
  ...(await import('./testing/fakeGeometry')),
}));

import { resolveMovedAtoms } from './moveSet';
import { ethane, mol, withHydrogens } from './testing/molecules';

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('resolveMovedAtoms', () => {
  it('carries terminal hydrogens of a grabbed heavy atom', () => {
    expect(sorted(resolveMovedAtoms(ethane(), [1], { selection: new Set(), wholeFragment: false }))).toEqual([1, 2, 3, 4]);
  });

  it('moves a grabbed hydrogen alone', () => {
    expect(sorted(resolveMovedAtoms(ethane(), [3], { selection: new Set(), wholeFragment: false }))).toEqual([3]);
  });

  it('moves the whole selection when the grabbed atom is selected', () => {
    const sel = new Set([1, 5, 99]);
    expect(sorted(resolveMovedAtoms(ethane(), [5], { selection: sel, wholeFragment: false }))).toEqual([1, 5]);
    // grabbing an unselected atom ignores the selection
    expect(sorted(resolveMovedAtoms(ethane(), [2], { selection: sel, wholeFragment: false }))).toEqual([2]);
  });

  it('moves the connected fragment with alt', () => {
    const a = withHydrogens('O', [0, 0, 0], 2);
    const b = withHydrogens('O', [3, 0, 0], 2, 3);
    const waters = mol([...a.atoms, ...b.atoms], [...a.bonds, ...b.bonds]);
    expect(sorted(resolveMovedAtoms(waters, [5], { selection: new Set(), wholeFragment: true }))).toEqual([4, 5, 6]);
  });

  it('moves both atoms of a grabbed bond with their hydrogens', () => {
    expect(sorted(resolveMovedAtoms(ethane(), [1, 5], { selection: new Set(), wholeFragment: false }))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
