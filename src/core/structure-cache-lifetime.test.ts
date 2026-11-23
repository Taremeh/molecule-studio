/**
 * Lifetime of the structure-keyed caches (core/molecule structureKey / createStructureCache): sharing
 * cached data across coordinate-only updates must not keep dead molecules or their data alive.
 * Uses a forced full GC (node's --expose_gc, enabled at runtime for this worker).
 */
import { describe, expect, it } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { buildMolecule, getTopology, structureKey, type AtomInput, type BondInput } from './molecule';
import { analyzeValence, findRings, moleculeSummary } from './chemistry';
import { evaluateSelection, selectionIndexIdentity } from './selection';
import { addAtom, setCharge, setElement, translateAtoms } from './edit';
import type { Molecule } from './types';

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;

/** Full GCs across a few macrotasks (WeakRef targets stay alive until the end of the creating job). */
async function collect(): Promise<void> {
  for (let k = 0; k < 4; k++) {
    await new Promise((r) => setTimeout(r, 0));
    gc();
  }
}

function protein(residues = 30): Molecule {
  const atoms: AtomInput[] = [];
  const bonds: BondInput[] = [];
  for (let r = 0; r < residues; r++) {
    const base = { resName: 'ALA', resSeq: r + 1, chain: 'A', ss: r % 3 ? 'helix' : 'coil' } as const;
    const i = atoms.length;
    atoms.push(
      { ...base, element: 'N', name: 'N', x: r * 3.8, y: 0, z: 0 },
      { ...base, element: 'C', name: 'CA', x: r * 3.8 + 1.46, y: 0, z: 0 },
      { ...base, element: 'C', name: 'C', x: r * 3.8 + 2, y: 1.4, z: 0 },
      { ...base, element: 'O', name: 'O', x: r * 3.8 + 1.4, y: 2.4, z: 0 },
    );
    bonds.push({ a: i, b: i + 1 }, { a: i + 1, b: i + 2 }, { a: i + 2, b: i + 3, order: 2 });
    if (r) bonds.push({ a: i - 2, b: i });
  }
  const l = atoms.length;
  for (let k = 0; k < 6; k++) {
    const t = (k * Math.PI) / 3;
    atoms.push({ element: 'C', name: `C${k + 1}`, resName: 'LIG', resSeq: 1, chain: 'L', hetero: true, x: 1.4 * Math.cos(t), y: 8 + 1.4 * Math.sin(t), z: 0 });
    bonds.push({ a: l + k, b: l + ((k + 1) % 6), order: 1.5 });
  }
  return buildMolecule('p', atoms, bonds);
}

/** Every structure cache, as the viewer / panels use them. */
function useAllCaches(m: Molecule): object[] {
  evaluateSelection(m, 'protein');
  evaluateSelection(m, 'within 4 of ligand');
  findRings(m);
  return [getTopology(m), analyzeValence(m), moleculeSummary(m), selectionIndexIdentity(m)];
}

describe('structure cache lifetime', () => {
  it('does not keep short-lived structures (hover previews, load intermediates) or their data alive', async () => {
    const base = protein();
    const baseData = useAllCaches(base);
    const refs: WeakRef<object>[] = [];
    (() => {
      // more variants than the caches remember; most share the base's bonds array (element/charge previews)
      for (let k = 0; k < 10; k++) {
        const id = base.atoms[k].id;
        const v = k % 3 === 0 ? setElement(base, [id], 'S') : k % 3 === 1 ? setCharge(base, id, 1) : addAtom(base, 'C', [k, 9, 9], { bondTo: id }).mol;
        refs.push(new WeakRef(v), ...useAllCaches(v).map((d) => new WeakRef(d)));
      }
      useAllCaches(base); // the store's molecule is in use again
    })();
    await collect();
    expect(refs.filter((r) => r.deref() !== undefined).length).toBe(0);
    // the live molecule keeps its data, and coordinate-only updates still share it
    expect(useAllCaches(base)).toEqual(baseData);
    const moved = translateAtoms(base, [1, 2], [0.5, 0, 0]);
    useAllCaches(moved).forEach((d, i) => expect(d).toBe(baseData[i]));
  });

  it('lets a replaced document, its drag frames and all their cached data go', async () => {
    const refs: WeakRef<object>[] = [];
    (() => {
      const doc = protein(60);
      refs.push(new WeakRef(doc), new WeakRef(structureKey(doc)), ...useAllCaches(doc).map((d) => new WeakRef(d)));
      for (let f = 1; f <= 3; f++) {
        const frame = translateAtoms(doc, [1], [0.1 * f, 0, 0]);
        refs.push(new WeakRef(frame), ...useAllCaches(frame).map((d) => new WeakRef(d)));
        useAllCaches(doc); // the viewer / feedback alternate between the frame and the drag base
      }
    })();
    // a new document is loaded and used: only the most recently used molecule is held strongly
    const next = protein(5);
    useAllCaches(next);
    await collect();
    expect(refs.filter((r) => r.deref() !== undefined).length).toBe(0);
    expect(getTopology(next).residues.length).toBe(6);
  });
});
