import { describe, expect, it } from 'vitest';
import {
  ATOM_STRUCTURE_FIELDS,
  BOND_STRUCTURE_FIELDS,
  buildMolecule,
  cloneMolecule,
  createStructureCache,
  deepCloneMolecule,
  getTopology,
  sameStructure,
  structureKey,
  type AtomInput,
  type BondInput,
} from './molecule';
import { addAtom, addBond, removeBonds, setBondOrder, setCharge, setElement, setPositions, translateAtoms } from './edit';
import { applyCoordinates } from './minimize';
import { evaluateSelection, maskToIds } from './selection';
import { defaultRepresentations } from '../state/store';
import type { Atom, Molecule } from './types';

/** Two short protein chains with a ligand and a water, plus bonds. */
function smallProtein(): Molecule {
  const atoms: AtomInput[] = [];
  const bonds: BondInput[] = [];
  for (let r = 0; r < 6; r++) {
    const chain = r < 3 ? 'A' : 'B';
    const ss = r % 3 === 1 ? 'helix' : 'coil';
    const base = { resName: 'ALA', resSeq: r + 1, chain, hetero: false, ss } as const;
    const i = atoms.length;
    atoms.push(
      { ...base, element: 'N', name: 'N', x: r * 4, y: 0, z: 0, serial: i + 1, bfactor: 10 },
      { ...base, element: 'C', name: 'CA', x: r * 4 + 1.45, y: 0, z: 0, serial: i + 2, bfactor: 11 },
      { ...base, element: 'C', name: 'C', x: r * 4 + 2, y: 1.4, z: 0, serial: i + 3, bfactor: 12 },
      { ...base, element: 'O', name: 'O', x: r * 4 + 1.4, y: 2.4, z: 0, serial: i + 4, bfactor: 13 },
    );
    bonds.push({ a: i, b: i + 1 }, { a: i + 1, b: i + 2 }, { a: i + 2, b: i + 3, order: 2 });
    if (r % 3) bonds.push({ a: i - 2, b: i });
  }
  const l = atoms.length;
  atoms.push(
    { element: 'C', name: 'C1', resName: 'LIG', resSeq: 1, chain: 'L', hetero: true, x: 10, y: 6, z: 0 },
    { element: 'O', name: 'O1', resName: 'LIG', resSeq: 1, chain: 'L', hetero: true, x: 11.2, y: 6, z: 0, charge: -1 },
    { element: 'O', name: 'O', resName: 'HOH', resSeq: 1, chain: 'W', hetero: true, x: -8, y: -8, z: 0 },
  );
  bonds.push({ a: l, b: l + 1 });
  return buildMolecule('small', atoms, bonds);
}

/** Copy of `mol` with atom `index` replaced by `patch` applied to a fresh copy of it. */
function withAtom(mol: Molecule, index: number, patch: Partial<Atom>): Molecule {
  const atoms = mol.atoms.slice();
  atoms[index] = { ...atoms[index], ...patch };
  return { ...mol, atoms };
}

/** A different value of the same type for `field` of `a`. */
function otherValue(a: Atom, field: keyof Atom): unknown {
  const v = a[field];
  switch (field) {
    case 'hetero':
      return !v;
    case 'ss':
      return v === 'helix' ? 'sheet' : 'helix';
    case 'element':
      return v === 'N' ? 'C' : 'N';
    default:
      return typeof v === 'number' ? v + 1 : typeof v === 'string' ? v + 'X' : field === 'charge' || field === 'bfactor' || field === 'occupancy' || field === 'serial' || field === 'resSeq' ? 1 : 'Q';
  }
}

describe('getTopology across coordinate-only updates', () => {
  it('reuses the topology after translateAtoms / setPositions / applyCoordinates', () => {
    const mol = smallProtein();
    const topo = getTopology(mol);
    const moved = translateAtoms(mol, [1, 2, 3], [0.5, 0, 0]);
    expect(moved).not.toBe(mol);
    expect(getTopology(moved)).toBe(topo);
    const placed = setPositions(mol, new Map([[5, [1, 2, 3]]]));
    expect(getTopology(placed)).toBe(topo);
    const x = new Float64Array(mol.atoms.length * 3).map((_, k) => k * 0.1);
    expect(getTopology(applyCoordinates(mol, x))).toBe(topo);
    // every atom moved (new Atom objects everywhere)
    const all = translateAtoms(mol, mol.atoms.map((a) => a.id), [1, 1, 1]);
    expect(all.atoms.every((a, i) => a !== mol.atoms[i])).toBe(true);
    expect(getTopology(all)).toBe(topo);
  });

  it('reuses it across a chain of drag frames, renames and equal-but-distinct arrays', () => {
    const mol = smallProtein();
    const topo = getTopology(mol);
    let frame = mol;
    for (let f = 1; f <= 20; f++) {
      frame = translateAtoms(mol, [1, 2], [0.1 * f, 0, 0]);
      expect(getTopology(frame)).toBe(topo);
    }
    // a committed drag result is the base of the next drag
    expect(getTopology(translateAtoms(frame, [7], [0, 1, 0]))).toBe(topo);
    expect(getTopology({ ...frame, name: 'renamed', meta: { title: 't' } })).toBe(topo);
    expect(getTopology(cloneMolecule(frame))).toBe(topo);
    const deep = deepCloneMolecule(frame);
    for (const a of deep.atoms) a.x += 3; // fresh objects, not shared with the store
    expect(getTopology(deep)).toBe(topo);
  });

  it('finds the drag base by its bonds array even after many other structures were seen', () => {
    const mol = smallProtein();
    const topo = getTopology(mol);
    // e.g. hover previews of the add-atom tool, each a different structure
    for (let k = 0; k < 20; k++) getTopology(addAtom(mol, 'C', [k, k, k]).mol);
    getTopology(smallProtein());
    expect(getTopology(translateAtoms(mol, [3], [0, 0, 1]))).toBe(topo);
  });

  it('recomputes when a residue / naming field changes, with correct content', () => {
    const mol = smallProtein();
    const topo = getTopology(mol);
    // CA of residue 1 (index 1) decides the residue's ss
    const helix = withAtom(mol, 1, { ss: 'helix', x: 99 });
    const t2 = getTopology(helix);
    expect(t2).not.toBe(topo);
    expect(topo.residues[0].ss).toBe('coil');
    expect(t2.residues[0].ss).toBe('helix');
    // atom 4 starts residue 2: moving it to residue 1 changes the residue split
    const regrouped = withAtom(mol, 4, { resSeq: 1 });
    const t3 = getTopology(regrouped);
    expect(t3).not.toBe(topo);
    expect(t3.residues[0].atomIndices).toEqual([0, 1, 2, 3, 4]);
    const renamed = withAtom(mol, 24, { resName: 'HOH' });
    expect(getTopology(renamed).residues.find((r) => r.chain === 'L')!.kind).toBe('water');
    expect(getTopology(withAtom(mol, 24, { chain: 'Z' }))).not.toBe(topo);
    expect(getTopology(withAtom(mol, 24, { hetero: false }))).not.toBe(topo);
    expect(getTopology(withAtom(mol, 24, { iCode: 'A' }))).not.toBe(topo);
    expect(getTopology(withAtom(mol, 1, { name: 'CB' }))).not.toBe(topo);
    expect(getTopology(setElement(mol, [2], 'N'))).not.toBe(topo);
    // the original is still served from its own cache
    expect(getTopology(mol)).toBe(topo);
  });

  it('recomputes when bonds change (endpoints, ids, orders, added / removed)', () => {
    const mol = smallProtein();
    const topo = getTopology(mol);
    const b0 = mol.bonds[0];
    const added = addBond(mol, 1, 4).mol;
    expect(getTopology(added)).not.toBe(topo);
    expect(getTopology(added).neighbors[0]).toContain(3);
    expect(getTopology(removeBonds(mol, [b0.id]))).not.toBe(topo);
    expect(getTopology(setBondOrder(mol, b0.id, 2))).not.toBe(topo);
    const rewired = { ...mol, bonds: mol.bonds.map((b, i) => (i === 0 ? { ...b, b: 3 } : b)) };
    expect(getTopology(rewired)).not.toBe(topo);
    expect(getTopology(rewired).neighbors[0]).toEqual([2]);
    const reId = { ...mol, bonds: mol.bonds.map((b, i) => (i === 0 ? { ...b, id: 999 } : b)) };
    expect(getTopology(reId).bondIdToIndex.get(999)).toBe(0);
    // same bonds in a different order → different bond indices
    const reordered = { ...mol, bonds: [mol.bonds[1], mol.bonds[0], ...mol.bonds.slice(2)] };
    expect(getTopology(reordered)).not.toBe(topo);
    expect(getTopology(reordered).bondIdToIndex.get(b0.id)).toBe(1);
  });

  it('recomputes when atoms are reordered, added or removed', () => {
    const mol = smallProtein();
    const topo = getTopology(mol);
    const swapped = { ...mol, atoms: [mol.atoms[1], mol.atoms[0], ...mol.atoms.slice(2)] };
    expect(getTopology(swapped)).not.toBe(topo);
    expect(getTopology(swapped).idToIndex.get(1)).toBe(1);
    expect(getTopology(addAtom(mol, 'C', [0, 0, 9]).mol)).not.toBe(topo);
    expect(getTopology({ ...mol, atoms: mol.atoms.slice(0, -1) })).not.toBe(topo);
  });
});

describe('structureKey / sameStructure', () => {
  it('every non-coordinate Atom field is compared', () => {
    const full: Required<Atom> = {
      id: 1, element: 'C', x: 0, y: 0, z: 0, name: 'CA', resName: 'ALA', resSeq: 1, iCode: 'A', chain: 'A',
      hetero: false, charge: 0, bfactor: 5, occupancy: 1, altLoc: 'A', serial: 7, ss: 'coil',
    };
    // the list covers every field of a fully populated atom (Required<Atom> fails to compile otherwise)
    expect(new Set<string>([...ATOM_STRUCTURE_FIELDS, 'x', 'y', 'z'])).toEqual(new Set(Object.keys(full)));
    const mol: Molecule = { name: 'm', atoms: [full], bonds: [], nextAtomId: 2, nextBondId: 1, meta: {} };
    const key = structureKey(mol);
    for (const f of ATOM_STRUCTURE_FIELDS) {
      const changed = withAtom(mol, 0, { [f]: otherValue(full, f) });
      expect(sameStructure(mol, changed), f).toBe(false);
      expect(structureKey(changed), f).not.toBe(key);
      // undefined vs a value
      const cleared = withAtom(mol, 0, { [f]: undefined });
      expect(sameStructure(mol, cleared), `${f} cleared`).toBe(false);
    }
    for (const f of ['x', 'y', 'z'] as const) {
      const moved = withAtom(mol, 0, { [f]: 3 });
      expect(sameStructure(mol, moved)).toBe(true);
      expect(structureKey(mol)).toBe(key); // in use again (like the store's molecule)…
      expect(structureKey(moved)).toBe(key); // …so a coordinate-only copy of it shares the key
    }
  });

  it('NaN numeric fields do not defeat the cache, but NaN vs a number differs', () => {
    const mol = withAtom(smallProtein(), 3, { bfactor: NaN, occupancy: NaN });
    const key = structureKey(mol);
    const moved = translateAtoms(mol, [4], [1, 0, 0]); // atom 4 (index 3) is a new object with NaN fields
    expect(structureKey(moved)).toBe(key);
    expect(structureKey(withAtom(mol, 3, { bfactor: 1 }))).not.toBe(key);
    expect(sameStructure(mol, withAtom(mol, 3, { bfactor: undefined }))).toBe(false);
  });

  it('every Bond field is compared', () => {
    const mol = smallProtein();
    const key = structureKey(mol);
    expect(BOND_STRUCTURE_FIELDS).toEqual(['id', 'a', 'b', 'order']);
    for (const f of BOND_STRUCTURE_FIELDS) {
      const b = mol.bonds[2];
      const v = f === 'order' ? (b.order === 2 ? 1 : 2) : f === 'id' ? 999 : b[f] === 1 ? 2 : 1;
      const changed = { ...mol, bonds: mol.bonds.map((x, i) => (i === 2 ? { ...x, [f]: v } : x)) };
      expect(sameStructure(mol, changed), f).toBe(false);
      expect(structureKey(changed), f).not.toBe(key);
    }
  });

  it('keys agree with sameStructure on random variations', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const base = smallProtein();
    const variants: Molecule[] = [base];
    for (let k = 0; k < 120; k++) {
      const from = variants[Math.floor(rnd() * variants.length)];
      const i = Math.floor(rnd() * from.atoms.length);
      const op = Math.floor(rnd() * 6);
      let next: Molecule;
      if (op === 0) next = translateAtoms(from, [from.atoms[i].id], [rnd(), 0, 0]);
      else if (op === 1) next = setCharge(from, from.atoms[i].id, Math.round(rnd() * 2) - 1);
      else if (op === 2) next = setBondOrder(from, from.bonds[Math.floor(rnd() * from.bonds.length)].id, rnd() < 0.5 ? 1 : 2);
      else if (op === 3) next = withAtom(from, i, { ss: rnd() < 0.5 ? 'helix' : 'coil' });
      else if (op === 4) next = deepCloneMolecule(from);
      else next = withAtom(from, i, { bfactor: Math.round(rnd() * 3) });
      variants.push(next);
      structureKey(next);
    }
    for (let a = 0; a < variants.length; a += 3) {
      for (let b = a + 1; b < variants.length; b += 2) {
        const same = sameStructure(variants[a], variants[b]);
        if (!same) expect(structureKey(variants[a])).not.toBe(structureKey(variants[b]));
      }
    }
    // coordinate-only descendants of a molecule in use share its key
    const k = structureKey(base);
    expect(structureKey(translateAtoms(base, [1], [5, 5, 5]))).toBe(k);
  });

  it('createStructureCache computes once per structure', () => {
    let calls = 0;
    const count = createStructureCache((m: Molecule) => {
      calls++;
      return { atoms: m.atoms.length };
    });
    const mol = smallProtein();
    const v = count(mol);
    expect(count(mol)).toBe(v);
    expect(count(translateAtoms(mol, [1], [1, 0, 0]))).toBe(v);
    expect(count(setCharge(mol, 1, 1))).not.toBe(v);
    expect(calls).toBe(2);
  });

  it('is much cheaper than a recompute for a coordinate-only update of a large molecule', () => {
    const atoms: AtomInput[] = [];
    const bonds: BondInput[] = [];
    for (let i = 0; i < 100_000; i++) {
      atoms.push({ element: i % 4 ? 'C' : 'N', x: i % 50, y: (i / 50) % 50, z: i / 2500, name: i % 4 ? 'C' : 'N', resName: 'ALA', resSeq: i >> 2, chain: 'A', serial: i + 1, bfactor: 10 });
      if (i % 4) bonds.push({ a: i - 1, b: i });
    }
    const big = buildMolecule('big', atoms, bonds);
    const topo = getTopology(big);
    // reference: full recomputes for different structures of the same size, measured here and now
    let full = Infinity;
    let t0 = 0;
    for (let k = 1; k <= 3; k++) {
      const charged = setCharge(big, big.atoms[big.atoms.length - k].id, 1);
      t0 = performance.now();
      expect(getTopology(charged)).not.toBe(topo);
      full = Math.min(full, performance.now() - t0);
    }
    const ids = big.atoms.map((a) => a.id);
    let best = Infinity;
    for (let f = 0; f < 8; f++) {
      const moved = translateAtoms(big, ids, [f + 1, 0, 0]); // every atom object replaced
      t0 = performance.now();
      const hit = getTopology(moved);
      best = Math.min(best, performance.now() - t0);
      expect(hit).toBe(topo);
    }
    // The structural comparison reads 14 fields of every replaced atom: ~1 ms at 100k atoms when the
    // property accesses are monomorphic, ~10 ms after many atom shapes were seen (as in this file);
    // a recompute is 30-50 ms. Best-of-n on both sides and a relative bound, so that GC pauses and a
    // loaded machine do not make it flaky.
    expect(best).toBeLessThan(Math.max(4, full / 2));
  });
});

describe('residue classification: ions', () => {
  const at = (element: string, name: string, resName: string, resSeq: number, x: number, extra: Partial<AtomInput> = {}): AtomInput => ({
    element,
    name,
    resName,
    resSeq,
    chain: 'A',
    hetero: true,
    x,
    y: 0,
    z: 0,
    ...extra,
  });
  const kinds = (mol: Molecule) => getTopology(mol).residues.map((r) => `${r.resName}:${r.kind}`);
  /** Three alanines (a macromolecule for the default layers). */
  const peptide = (): AtomInput[] =>
    [1, 2, 3].flatMap((k) => [at('N', 'N', 'ALA', k, 10 * k, { hetero: false }), at('C', 'CA', 'ALA', k, 10 * k + 1.45, { hetero: false })]);
  /** Chlorophyll a core (CCD code CLA): Mg, its pyrrole N and carbons. */
  const chlorophyll = (resSeq: number): AtomInput[] => [
    at('Mg', 'MG', 'CLA', resSeq, 0),
    at('N', 'NA', 'CLA', resSeq, 2.05),
    at('N', 'NB', 'CLA', resSeq, -2.05),
    at('C', 'C1A', 'CLA', resSeq, 3.4),
    at('C', 'C2A', 'CLA', resSeq, 4.6),
    at('O', 'O1A', 'CLA', resSeq, 5.8),
  ];

  it('CLA is CHARMM chloride as a single atom, chlorophyll a (CCD CLA) as a molecule', () => {
    const mol = buildMolecule('PSII', [...peptide(), ...chlorophyll(601), at('Cl', 'CLA', 'CLA', 701, 40)]);
    expect(kinds(mol).slice(3)).toEqual(['CLA:ligand', 'CLA:ion']);
  });

  it('CHARMM single-atom ion names are ions (CD2, CES, LIT, RUB, BAR, SOD, POT, CAL)', () => {
    const names: [string, string][] = [['Cd', 'CD2'], ['Cs', 'CES'], ['Li', 'LIT'], ['Rb', 'RUB'], ['Ba', 'BAR'], ['Na', 'SOD'], ['K', 'POT'], ['Ca', 'CAL']];
    const mol = buildMolecule('ions', names.map(([el, r], k) => at(el, r === 'CD2' ? 'CD' : r, r, k + 1, 5 * k, { hetero: false })));
    expect(kinds(mol)).toEqual(names.map(([, r]) => `${r}:ion`));
  });

  it('several copies of one ion merged into a residue stay ions; waters, ligands, polymers are unaffected', () => {
    const mol = buildMolecule('mixed', [
      ...peptide(),
      at('Na', 'NA', 'NA', 1, 50),
      at('Na', 'NA', 'NA', 1, 55),
      at('Mg', 'MG', 'MG', 2, 60),
      at('H', 'H1', 'MG', 2, 61), // hydrogens do not count
      at('O', 'O', 'HOH', 3, 70),
      at('H', 'H1', 'HOH', 3, 71),
      at('C', 'C1', 'LIG', 4, 80),
      at('O', 'O1', 'LIG', 4, 81),
      at('C', 'CA', 'CA', 5, 90), // a carbon is never a monatomic ion (calcium misread as carbon)
      at('Cl', 'CL1', 'CL', 6, 100),
      at('O', 'O1', 'CL', 6, 101), // not a monatomic ion: two elements
    ]);
    expect(kinds(mol)).toEqual([
      'ALA:protein', 'ALA:protein', 'ALA:protein', 'NA:ion', 'MG:ion', 'HOH:water', 'LIG:ligand', 'CA:ligand', 'CL:ligand',
    ]);
  });

  it('the ion selection keyword and the default Ions layer follow the residue kind', () => {
    const mol = buildMolecule('PSII', [...peptide(), ...chlorophyll(601), at('Cl', 'CLA', 'CLA', 701, 40), at('O', 'O', 'HOH', 801, 50)]);
    const ids = (q: string) => maskToIds(mol, evaluateSelection(mol, q).mask);
    const cla = mol.atoms.filter((a) => a.resName === 'CLA');
    expect(ids('ion')).toEqual([cla[cla.length - 1].id]);
    expect(ids('ligand')).toEqual(cla.slice(0, -1).map((a) => a.id));
    expect(ids('water')).toEqual([mol.atoms[mol.atoms.length - 1].id]);
    const layers = defaultRepresentations(mol).map((r) => `${r.name}:${r.selection}`);
    expect(layers).toEqual(['Protein:protein', 'Ligands:ligand', 'Ions:ion', 'Water:water']);
    // Chlorophyll alone gives no Ions layer.
    const noIon = buildMolecule('LHC', [...peptide(), ...chlorophyll(601)]);
    expect(defaultRepresentations(noIon).map((r) => r.name)).toEqual(['Protein', 'Ligands']);
  });
});
