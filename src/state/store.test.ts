import { beforeEach, describe, expect, it } from 'vitest';
import type { Molecule } from '../core/types';
import { buildMolecule } from '../core/molecule';
import { useStore } from './store';

const S = () => useStore.getState();

/** A chain of `n` carbons (structure is irrelevant here, only the atom count). */
function chain(n: number): Molecule {
  const atoms = Array.from({ length: n }, (_, i) => ({ element: 'C', x: i * 1.5, y: 0, z: 0 }));
  const bonds = Array.from({ length: Math.max(0, n - 1) }, (_, i) => ({ a: i, b: i + 1, order: 1 as const }));
  return buildMolecule(`chain ${n}`, atoms, bonds);
}

/** Same molecule with atom `i` moved (a new molecule, like a drag or a geometry edit produces). */
function moved(mol: Molecule, i: number, dx = 0.1): Molecule {
  const atoms = mol.atoms.slice();
  atoms[i] = { ...atoms[i], x: atoms[i].x + dx };
  return { ...mol, atoms };
}

beforeEach(() => {
  S().loadMolecule(chain(3));
});

describe('undo history', () => {
  it('keeps 100 steps for small molecules', () => {
    S().loadMolecule(chain(50));
    for (let k = 0; k < 120; k++) S().commit(moved(S().molecule!, k % 50), `Edit ${k}`);
    expect(S().past).toHaveLength(100);
    expect(S().past.at(-1)!.label).toBe('Edit 119');
  });

  it('bounds the snapshots of a large molecule by their total atom count', () => {
    // Every snapshot pins its molecule and the derived caches keyed by it (topology, valence, …):
    // about 50 MB for a 100k-atom molecule, so 100 of them exhaust the heap.
    const big = chain(100_000);
    S().loadMolecule(big);
    for (let k = 0; k < 40; k++) {
      S().beginTransient();
      S().updateTransient(moved(S().molecule!, k));
      S().endTransient(`Move ${k}`);
    }
    const kept = S().past.reduce((n, e) => n + e.molecule.atoms.length, 0);
    expect(S().past.length).toBeGreaterThan(1);
    expect(S().past.length).toBeLessThan(40);
    expect(kept).toBeLessThanOrEqual(1_000_000);
    // The most recent steps are the ones kept, and undo still walks back through them.
    expect(S().past.at(-1)!.label).toBe('Move 39');
    const n = S().past.length;
    for (let k = 0; k < n; k++) S().undo();
    expect(S().past).toHaveLength(0);
    expect(S().future).toHaveLength(n);
    expect(S().molecule!.atoms[39 - n + 1].x).toBeCloseTo(big.atoms[39 - n + 1].x, 9);
  });

  it('always keeps the last step, even for a molecule above the budget', () => {
    // 1.2M atoms (sharing one atom object keeps the test fast; only the count matters here).
    const one = chain(1).atoms[0];
    const huge: Molecule = { ...chain(1), atoms: new Array(1_200_000).fill(one), bonds: [] };
    S().loadMolecule(huge);
    S().commit(moved(huge, 0), 'One');
    S().commit(moved(S().molecule!, 1), 'Two');
    expect(S().past.map((e) => e.label)).toEqual(['Two']);
    S().undo();
    expect(S().molecule!.atoms[1].x).toBe(huge.atoms[1].x);
  });
});

describe('transient edits and undo / redo', () => {
  it('redo during a transient edit cancels the transient first (like undo)', () => {
    const a = S().molecule!;
    const b = moved(a, 0, 1);
    S().commit(b, 'Edit');
    S().undo();
    expect(S().molecule).toBe(a);
    // A drag (e.g. a geometry slider) is in progress when redo is pressed.
    S().beginTransient();
    S().updateTransient(moved(a, 2, 5));
    S().redo();
    expect(S().transientBase).toBeNull();
    expect(S().molecule).toBe(b);
    expect(S().past.map((e) => e.molecule)).toEqual([a]);
    // The drag's late end must not add a stray entry.
    S().endTransient('Late drag end');
    expect(S().past.map((e) => e.label)).toEqual(['Edit']);
    S().undo();
    expect(S().molecule).toBe(a);
  });

  it('a commit during a transient edit absorbs it: one entry back to the state before the drag', () => {
    const a = S().molecule!;
    S().beginTransient();
    const dragged = moved(a, 0, 1);
    S().updateTransient(dragged);
    const edited = moved(dragged, 2, 3); // e.g. a shortcut pressed mid-drag commits an edit
    S().commit(edited, 'Add hydrogens');
    expect(S().transientBase).toBeNull();
    expect(S().molecule).toBe(edited);
    expect(S().past.map((e) => [e.molecule, e.label])).toEqual([[a, 'Add hydrogens']]);
    // The drag's late end adds nothing.
    S().endTransient('Move atom');
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(S().molecule).toBe(a);
  });

  it('undo during a transient edit restores the base and undoes the previous step', () => {
    const a = S().molecule!;
    const b = moved(a, 0, 1);
    S().commit(b, 'Edit');
    S().beginTransient();
    S().updateTransient(moved(b, 1, 3));
    S().undo();
    expect(S().transientBase).toBeNull();
    expect(S().molecule).toBe(a);
    expect(S().future.map((e) => e.molecule)).toEqual([b]);
  });
});

describe('setMoleculeName', () => {
  it('a rename survives undo / redo of earlier edits (the name is not part of the edit history)', () => {
    const a = S().molecule!;
    S().commit(moved(a, 0), 'Edit 1');
    S().commit(moved(S().molecule!, 1), 'Edit 2');
    S().undo();
    S().setMoleculeName('My molecule');
    S().undo();
    expect(S().molecule!.name).toBe('My molecule');
    S().redo();
    S().redo();
    expect(S().molecule!.name).toBe('My molecule');
    expect(S().past.map((e) => e.label)).toEqual(['Edit 1', 'Edit 2']);
  });
});

/** A tiny protein-like molecule: `n` alanine residues (CA only is enough for classification) plus waters. */
function peptideWithWater(n: number, waters: number): Molecule {
  const atoms = [
    ...Array.from({ length: n }, (_, i) => ({ element: 'C', name: 'CA', resName: 'ALA', resSeq: i + 1, chain: 'A', x: i * 3.8, y: 0, z: 0 })),
    ...Array.from({ length: waters }, (_, i) => ({ element: 'O', name: 'O', resName: 'HOH', resSeq: 100 + i, chain: 'W', hetero: true, x: i * 3, y: 8, z: 0 })),
  ];
  return buildMolecule('peptide', atoms, []);
}

describe('mode on load', () => {
  it('opens a macromolecule in view mode even while editing', () => {
    S().setMode('edit');
    S().loadMolecule(peptideWithWater(5, 2));
    expect(S().mode).toBe('view');
    expect(S().tool).toBe('select');
    expect(S().reps.some((r) => r.name === 'Editable atoms')).toBe(false);
  });

  it('keeps edit mode for a small molecule', () => {
    S().setMode('edit');
    S().setTool('move');
    S().loadMolecule(chain(4));
    expect(S().mode).toBe('edit');
    expect(S().tool).toBe('move');
  });

  it('opens an empty document for building', () => {
    S().newDocument();
    expect(S().mode).toBe('edit');
    expect(S().tool).toBe('add-atom');
  });

  it('leaves waters out of the layer added for editing, and adds it only once', () => {
    S().loadMolecule(peptideWithWater(5, 3));
    S().setMode('edit');
    const added = S().reps.filter((r) => r.name === 'Editable atoms');
    expect(added).toHaveLength(1);
    expect(added[0].selection).toBe('not water');
    S().setMode('view');
    S().setMode('edit');
    expect(S().reps.filter((r) => r.name === 'Editable atoms')).toHaveLength(1);
  });
});
