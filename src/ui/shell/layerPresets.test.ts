import { describe, expect, it } from 'vitest';
import { buildMolecule, type AtomInput } from '../../core/molecule';
import { drawnAtomCount, layerPresets, maskHasPolymer, moleculeContent } from './layerPresets';

function residue(resName: string, resSeq: number, chain: string, x: number, hetero = false): AtomInput[] {
  return [
    { element: 'N', name: 'N', resName, resSeq, chain, hetero, x, y: 0, z: 0 },
    { element: 'C', name: 'CA', resName, resSeq, chain, hetero, x: x + 1.46, y: 0, z: 0 },
    { element: 'C', name: 'C', resName, resSeq, chain, hetero, x: x + 2.0, y: 1.4, z: 0 },
  ];
}

const protein = buildMolecule('prot', [
  ...residue('ALA', 1, 'A', 0),
  ...residue('GLY', 2, 'A', 3.8),
  ...residue('SER', 3, 'A', 7.6),
  { element: 'C', name: 'C1', resName: 'LIG', resSeq: 100, chain: 'A', hetero: true, x: 2, y: 4, z: 0 },
]);

const twoChains = buildMolecule('dimer', [...residue('ALA', 1, 'A', 0), ...residue('ALA', 1, 'B', 10)]);

const ethanol = buildMolecule('ethanol', [
  { element: 'C', x: 0, y: 0, z: 0 },
  { element: 'C', x: 1.52, y: 0, z: 0 },
  { element: 'O', x: 2.0, y: 1.35, z: 0 },
]);

const byId = (list: ReturnType<typeof layerPresets>, id: string) => list.find((p) => p.id === id)!;

describe('moleculeContent', () => {
  it('detects protein, ligands and polymer chains', () => {
    expect(moleculeContent(protein)).toEqual({ protein: true, nucleic: false, ligand: true, polymerChains: 1 });
    expect(moleculeContent(twoChains).polymerChains).toBe(2);
    expect(moleculeContent(ethanol)).toEqual({ protein: false, nucleic: false, ligand: false, polymerChains: 0 });
    expect(moleculeContent(null).protein).toBe(false);
  });
});

describe('layerPresets', () => {
  it('enables polymer / ligand presets for a protein–ligand complex', () => {
    const p = layerPresets(protein, new Set());
    expect(byId(p, 'cartoon').disabledReason).toBeUndefined();
    expect(byId(p, 'cartoon').rep).toMatchObject({ style: 'cartoon', selection: 'protein', color: 'secondary' });
    expect(byId(p, 'ligand-sticks').disabledReason).toBeUndefined();
    expect(byId(p, 'binding-site').disabledReason).toBeUndefined();
    expect(byId(p, 'surface').rep).toMatchObject({ selection: 'protein', color: 'hydrophobicity' });
  });

  it('colors cartoons by chain for multi-chain structures', () => {
    expect(byId(layerPresets(twoChains, new Set()), 'cartoon').rep.color).toBe('chain');
  });

  it('disables polymer / ligand presets for small molecules', () => {
    const p = layerPresets(ethanol, new Set());
    expect(byId(p, 'cartoon').disabledReason).toBeTruthy();
    expect(byId(p, 'ligand-sticks').disabledReason).toBeTruthy();
    expect(byId(p, 'binding-site').disabledReason).toBeTruthy();
    expect(byId(p, 'ball-and-stick').disabledReason).toBeUndefined();
    expect(byId(p, 'surface').rep).toMatchObject({ selection: 'all', style: 'surface' });
  });

  it('builds a stable id query from the current selection', () => {
    const none = byId(layerPresets(ethanol, new Set()), 'selection');
    expect(none.disabledReason).toBeTruthy();
    const sel = byId(layerPresets(ethanol, new Set([1, 2, 3])), 'selection');
    expect(sel.disabledReason).toBeUndefined();
    expect(sel.rep.selection).toBe('id 1 to 3');
    expect(sel.rep.name).toBe('Selection (3 atoms)');
  });
});

describe('maskHasPolymer', () => {
  it('detects polymer atoms in a mask', () => {
    const n = protein.atoms.length;
    const ligandOnly = new Uint8Array(n);
    ligandOnly[n - 1] = 1;
    expect(maskHasPolymer(protein, ligandOnly)).toBe(false);
    const withCA = new Uint8Array(n);
    withCA[1] = 1;
    expect(maskHasPolymer(protein, withCA)).toBe(true);
    expect(maskHasPolymer(ethanol, new Uint8Array(3).fill(1))).toBe(false);
  });
});

describe('drawnAtomCount', () => {
  const methanol = buildMolecule('methanol', [
    { element: 'C', x: 0, y: 0, z: 0 },
    { element: 'O', x: 1.43, y: 0, z: 0 },
    { element: 'H', x: -0.5, y: 0.9, z: 0 },
    { element: 'H', x: -0.5, y: -0.9, z: 0 },
    { element: 'H', x: -0.4, y: 0, z: 1 },
    { element: 'H', x: 1.8, y: 0.9, z: 0 },
  ]);

  it('counts every masked atom while hydrogens are shown', () => {
    expect(drawnAtomCount(methanol, new Uint8Array(6).fill(1), false)).toBe(6);
  });

  it('leaves out hydrogens the renderer hides', () => {
    expect(drawnAtomCount(methanol, new Uint8Array(6).fill(1), true)).toBe(2);
    expect(drawnAtomCount(methanol, Uint8Array.from([0, 1, 0, 0, 0, 1]), true)).toBe(1);
  });
});
