import { describe, expect, it } from 'vitest';
import {
  addAtom,
  addBond,
  addHydrogens,
  adjustHydrogens,
  attachFragment,
  canSetDihedral,
  centerMolecule,
  cycleBondOrder,
  mergeMolecules,
  removeAtoms,
  removeBonds,
  removeHydrogens,
  setAngle,
  setBondOrder,
  setCharge,
  setDihedral,
  setDistance,
  setElement,
  setPositions,
  translateAtoms,
} from './edit';
import { analyzeValence, molecularFormula } from './chemistry';
import { angle, distance, measureAtoms } from './geometry';
import { benzene, mk, ringAtoms, ringBonds, type AtomSpec } from './chem-fixtures';
import { bondBetween, buildMolecule, centroid, createMolecule, getTopology, neighborIds } from './molecule';
import type { Molecule, Vec3 } from './types';

/** Recursively freeze a molecule so any mutation by an edit op throws. */
function freeze(mol: Molecule): Molecule {
  for (const a of mol.atoms) Object.freeze(a);
  for (const b of mol.bonds) Object.freeze(b);
  Object.freeze(mol.atoms);
  Object.freeze(mol.bonds);
  Object.freeze(mol.meta);
  return Object.freeze(mol);
}

const P = (mol: Molecule, id: number): Vec3 => {
  const a = mol.atoms.find((x) => x.id === id)!;
  return [a.x, a.y, a.z];
};
const hydrogensOf = (mol: Molecule, id: number) => neighborIds(mol, id).filter((j) => mol.atoms.find((a) => a.id === j)!.element === 'H');
const allOk = (mol: Molecule) => [...analyzeValence(mol).values()].every((v) => v.status === 'ok');

/** Ethane with explicit H built by the editor ops themselves. */
function ethane(): Molecule {
  return freeze(addHydrogens(mk('ethane', [['C', 0, 0, 0], ['C', 1.52, 0, 0]], [[0, 1]])));
}

/** n-butane C1..C4 (ids 1–4) with hydrogens. */
function butane(): Molecule {
  const t = (109.47 * Math.PI) / 180;
  // planar zig-zag skeleton
  const atoms: AtomSpec[] = [['C', 0, 0, 0], ['C', 1.52, 0, 0]];
  atoms.push(['C', 1.52 - 1.52 * Math.cos(t), 1.52 * Math.sin(t), 0]);
  atoms.push(['C', atoms[2][1] + 1.52, atoms[2][2], 0]);
  return freeze(addHydrogens(mk('butane', atoms, [[0, 1], [1, 2], [2, 3]])));
}

describe('atoms and bonds', () => {
  it('addAtom assigns ids, names and bonds without mutating the input', () => {
    const base = freeze(mk('m', [['C', 0, 0, 0], ['C', 1.5, 0, 0]], [[0, 1]]));
    const { mol, atomId } = addAtom(base, 'c', [3, 0, 0], { bondTo: 2, order: 2, charge: -1 });
    expect(atomId).toBe(3);
    expect(mol.nextAtomId).toBe(4);
    expect(mol.nextBondId).toBe(3);
    const a = mol.atoms[2];
    expect(a).toMatchObject({ id: 3, element: 'C', name: 'C3', charge: -1, x: 3 });
    expect(bondBetween(mol, 2, 3)?.order).toBe(2);
    expect(mol.atoms[0]).toBe(base.atoms[0]); // reused objects
    expect(base.atoms).toHaveLength(2);
    // unknown anchor: atom added without a bond
    const r2 = addAtom(base, 'O', [0, 3, 0], { bondTo: 77 });
    expect(r2.mol.bonds).toHaveLength(1);
  });

  it('copies residue info from the anchor and marks the new atom hetero', () => {
    const base = buildMolecule('p', [{ element: 'C', x: 0, y: 0, z: 0, name: 'CB', resName: 'ALA', resSeq: 5, chain: 'B', hetero: false }]);
    const { mol, atomId } = addAtom(base, 'O', [1.4, 0, 0], { bondTo: 1 });
    expect(mol.atoms.find((x) => x.id === atomId)).toMatchObject({ resName: 'ALA', resSeq: 5, chain: 'B', hetero: true, name: 'O1' });
    // hydrogens copy the anchor's hetero flag instead
    const h = addHydrogens(base);
    expect(h.atoms[1]).toMatchObject({ element: 'H', resName: 'ALA', hetero: false });
    expect(getTopology(h).residues).toHaveLength(1);
  });

  it('generates unique names', () => {
    let mol = freeze(mk('m', [['C', 0, 0, 0]]));
    const names: string[] = [];
    for (let k = 0; k < 3; k++) {
      const r = addAtom(mol, 'C', [k + 1, 0, 0]);
      mol = r.mol;
      names.push(mol.atoms.at(-1)!.name!);
    }
    expect(names).toEqual(['C2', 'C3', 'C4']);
    mol = removeAtoms(mol, [2]);
    expect(addAtom(mol, 'C', [9, 9, 9]).mol.atoms.at(-1)!.name).toBe('C5');
  });

  it('removeAtoms keeps ids stable and never reuses them', () => {
    const eth = ethane();
    const ids = eth.atoms.map((a) => a.id);
    const out = removeAtoms(eth, [1, 999]);
    expect(out.atoms.map((a) => a.id)).toEqual(ids.filter((i) => i !== 1));
    expect(out.bonds.every((b) => b.a !== 1 && b.b !== 1)).toBe(true);
    expect(out.nextAtomId).toBe(eth.nextAtomId);
    expect(addAtom(out, 'C', [0, 0, 0]).atomId).toBe(eth.nextAtomId);
    expect(removeAtoms(eth, [999])).toBe(eth); // no-op returns the same object
  });

  it('addBond / setBondOrder / cycleBondOrder / removeBonds', () => {
    const base = freeze(mk('m', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['O', 3, 0, 0]], [[0, 1]]));
    const r = addBond(base, 2, 3, 2);
    expect(r.bondId).toBe(2);
    expect(bondBetween(r.mol, 3, 2)?.order).toBe(2);
    expect(addBond(base, 1, 1).bondId).toBe(-1);
    expect(addBond(base, 1, 42).mol).toBe(base);
    const again = addBond(r.mol, 3, 2, 1);
    expect(again.bondId).toBe(2);
    expect(again.mol.bonds).toHaveLength(2);
    expect(bondBetween(again.mol, 2, 3)?.order).toBe(1);
    expect(setBondOrder(base, 1, 1)).toBe(base);
    let m = base;
    const seen: number[] = [];
    for (let k = 0; k < 3; k++) {
      m = cycleBondOrder(m, 1);
      seen.push(m.bonds[0].order);
    }
    expect(seen).toEqual([2, 3, 1]);
    expect(cycleBondOrder(setBondOrder(base, 1, 1.5), 1).bonds[0].order).toBe(2);
    expect(removeBonds(r.mol, [1]).bonds.map((b) => b.id)).toEqual([2]);
  });

  it('setElement renames generated names; setCharge; translate / setPositions', () => {
    const base = freeze(mk('m', [['C', 0, 0, 0], ['C', 1.5, 0, 0]], [[0, 1]]));
    const named = addAtom(base, 'C', [3, 0, 0]).mol; // name 'C1'
    const o = setElement(named, [3], 'O');
    expect(o.atoms[2]).toMatchObject({ element: 'O', name: 'O1' });
    expect(setElement(base, [1], 'C')).toBe(base);
    const q = setCharge(base, 1, 1);
    expect(q.atoms[0].charge).toBe(1);
    expect('charge' in setCharge(q, 1, 0).atoms[0]).toBe(false);
    expect(setCharge(base, 1, 0)).toBe(base);
    const t = translateAtoms(base, [2], [0, 1, 0]);
    expect(P(t, 2)).toEqual([1.5, 1, 0]);
    expect(t.atoms[0]).toBe(base.atoms[0]);
    expect(translateAtoms(base, [2], [0, 0, 0])).toBe(base);
    expect(P(setPositions(base, new Map([[1, [5, 5, 5] as Vec3]])), 1)).toEqual([5, 5, 5]);
  });
});

describe('hydrogens', () => {
  it('addHydrogens on a bare carbon gives CH4: 4 H at 1.09 Å with tetrahedral angles', () => {
    const c = freeze(createMoleculeWith([['C', 0.5, -1, 2]]));
    const mol = addHydrogens(c);
    expect(molecularFormula(mol)).toBe('CH4');
    const hs = hydrogensOf(mol, 1);
    expect(hs).toHaveLength(4);
    for (const h of hs) expect(distance(P(mol, 1), P(mol, h))).toBeCloseTo(1.09, 9);
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++) expect(angle(P(mol, hs[i]), P(mol, 1), P(mol, hs[j]))).toBeCloseTo(109.4712, 3);
    expect(allOk(mol)).toBe(true);
    expect(mol.atoms.slice(1).map((a) => a.name)).toEqual(['H1', 'H2', 'H3', 'H4']);
    expect(addHydrogens(mol)).toBe(mol); // nothing left to fill
  });

  it('ethane comes out staggered with all valences satisfied', () => {
    const eth = ethane();
    expect(molecularFormula(eth)).toBe('C2H6');
    expect(allOk(eth)).toBe(true);
    const h1 = hydrogensOf(eth, 1);
    const h2 = hydrogensOf(eth, 2);
    for (const a of h1)
      for (const b of h2) {
        const d = Math.abs(measureAtoms(eth, [a, 1, 2, b]));
        expect(Math.min(Math.abs(d - 60), Math.abs(d - 180))).toBeLessThan(1e-6);
      }
  });

  it('benzene without H → C6H6 with in-plane hydrogens', () => {
    const bare = freeze(mk('c6', ringAtoms(Array(6).fill('C'), 1.39), ringBonds(6, 1.5)));
    const mol = addHydrogens(bare);
    expect(molecularFormula(mol)).toBe('C6H6');
    for (const a of mol.atoms) expect(a.z).toBeCloseTo(0, 9);
    expect(allOk(mol)).toBe(true);
  });

  it('ethylene gets planar CH2 groups', () => {
    const mol = addHydrogens(mk('c2', [['C', 0, 0, 0], ['C', 1.33, 0, 0]], [[0, 1, 2]]));
    expect(molecularFormula(mol)).toBe('C2H4');
    // all H–C=C–H dihedrals are 0° or 180° (planar), and H–C–H is 120°
    for (const a of hydrogensOf(mol, 1))
      for (const b of hydrogensOf(mol, 2)) {
        const d = Math.abs(measureAtoms(mol, [a, 1, 2, b]));
        expect(Math.min(d, Math.abs(180 - d))).toBeLessThan(1e-6);
      }
    const [ha, hb] = hydrogensOf(mol, 1);
    expect(measureAtoms(mol, [ha, 1, hb])).toBeCloseTo(120, 6);
    expect(allOk(mol)).toBe(true);
  });

  it('only fills the requested atoms and skips hydrogens in the list', () => {
    const base = freeze(mk('cc', [['C', 0, 0, 0], ['O', 1.43, 0, 0], ['H', -0.4, 1, 0]], [[0, 1], [0, 2]]));
    const mol = addHydrogens(base, [2, 3]);
    expect(molecularFormula(mol)).toBe('CH2O'); // only O got its H
    expect(hydrogensOf(mol, 2)).toHaveLength(1);
    expect(distance(P(mol, 2), P(mol, hydrogensOf(mol, 2)[0]))).toBeCloseTo(0.96, 9);
  });

  it('removeHydrogens: all, or attached to given atoms', () => {
    const eth = ethane();
    expect(molecularFormula(removeHydrogens(eth))).toBe('C2');
    expect(molecularFormula(removeHydrogens(eth, [1]))).toBe('C2H3');
    const oneH = hydrogensOf(eth, 2)[0];
    expect(molecularFormula(removeHydrogens(eth, [oneH]))).toBe('C2H5');
  });

  it('adjustHydrogens after C→O on methane: CH4 → OH2 with O–H 0.96 Å', () => {
    const ch4 = freeze(addHydrogens(createMoleculeWith([['C', 0, 0, 0]])));
    const o = setElement(ch4, [1], 'O');
    expect(analyzeValence(o).get(1)?.status).toBe('over');
    const water = adjustHydrogens(o, [1]);
    expect(molecularFormula(water)).toBe('H2O');
    const hs = hydrogensOf(water, 1);
    expect(hs).toHaveLength(2);
    for (const h of hs) expect(distance(P(water, 1), P(water, h))).toBeCloseTo(0.96, 9);
    expect(allOk(water)).toBe(true);
  });

  it('adjustHydrogens after forming a C–C bond between two methanes removes the crowded H', () => {
    let mol = addHydrogens(createMoleculeWith([['C', 0, 0, 0]]));
    mol = mergeMolecules(mol, mol, [2.2, 0, 0]).mol; // second CH4, one H points at the first C? not necessarily
    const r = addBond(mol, 1, 6, 1);
    const fixed = adjustHydrogens(r.mol, [1, 6]);
    expect(molecularFormula(fixed)).toBe('C2H6');
    expect(allOk(fixed)).toBe(true);
    // the removed H on C1 was the one pointing towards C6
    for (const h of hydrogensOf(fixed, 1)) expect(angle(P(fixed, 6), P(fixed, 1), P(fixed, h))).toBeGreaterThan(60);
  });

  it('adjustHydrogens adds H when under-valent and prefers the lower valence on ties (S)', () => {
    const n = adjustHydrogens(mk('n', [['N', 0, 0, 0], ['C', 1.47, 0, 0]], [[0, 1]]), [1]);
    expect(molecularFormula(n)).toBe('CH2N');
    // H2S + extra bond to C: thiol (remove one H) rather than SH3
    const mol = mk('h2s', [['S', 0, 0, 0], ['H', 1.34, 0, 0], ['H', 0, 1.34, 0], ['C', 0, 0, 1.82]], [[0, 1], [0, 2], [0, 3]]);
    const thiol = adjustHydrogens(mol, [1]);
    expect(hydrogensOf(thiol, 1)).toHaveLength(1);
    // N+ (ammonium from ammonia)
    const nh3 = addHydrogens(createMoleculeWith([['N', 0, 0, 0]]));
    expect(hydrogensOf(adjustHydrogens(setCharge(nh3, 1, 1), [1]), 1)).toHaveLength(4);
    // unchecked metals are left alone; ok atoms unchanged (same object)
    const ok = ethane();
    expect(adjustHydrogens(ok, [1, 2])).toBe(ok);
  });

  it('handles a whole protein-sized molecule in one pass', () => {
    const atoms = Array.from({ length: 3000 }, (_, i) => ({ element: 'C', x: i * 1.52, y: (i % 2) * 0.9, z: 0, resName: 'LIG', resSeq: 1 + Math.floor(i / 10), chain: 'A' }));
    const bonds = Array.from({ length: 2999 }, (_, i) => ({ a: i, b: i + 1 }));
    const mol = addHydrogens(buildMolecule('chain', atoms, bonds));
    expect(mol.atoms).toHaveLength(3000 + 2 * 3000 + 2);
    expect(new Set(mol.atoms.map((a) => a.id)).size).toBe(mol.atoms.length);
    expect(allOk(mol)).toBe(true);
  });
});

function createMoleculeWith(atoms: AtomSpec[]): Molecule {
  const m = mk('m', atoms);
  return { ...m, meta: { source: 'editor' } };
}

describe('internal coordinates', () => {
  it('setDistance hits the target and moves the smaller side', () => {
    const eth = ethane();
    const out = setDistance(eth, 1, 2, 1.8);
    expect(measureAtoms(out, [1, 2])).toBeCloseTo(1.8, 9);
    // the C–H lengths are untouched (rigid sides)
    for (const h of hydrogensOf(out, 2)) expect(measureAtoms(out, [2, h])).toBeCloseTo(1.09, 9);
    // a terminal H: only the H moves
    const h = hydrogensOf(eth, 1)[0];
    const o2 = setDistance(eth, 1, h, 1.2);
    expect(measureAtoms(o2, [1, h])).toBeCloseTo(1.2, 9);
    expect(P(o2, 1)).toEqual(P(eth, 1));
    // reversed arguments: still the H moves (smaller side)
    const o3 = setDistance(eth, h, 1, 1.3);
    expect(measureAtoms(o3, [1, h])).toBeCloseTo(1.3, 9);
    expect(P(o3, 1)).toEqual(P(eth, 1));
    expect(setDistance(eth, 1, 2, -1)).toBe(eth);
  });

  it('setDistance in a ring moves only b', () => {
    const bz = freeze(benzene());
    const out = setDistance(bz, 1, 2, 1.6);
    expect(measureAtoms(out, [1, 2])).toBeCloseTo(1.6, 9);
    const moved = out.atoms.filter((a, i) => a !== bz.atoms[i]).map((a) => a.id);
    expect(moved).toEqual([2]);
  });

  it('setAngle hits the target to 1e-6', () => {
    const but = butane();
    for (const target of [90, 125.3, 179, 60]) {
      const out = setAngle(but, 1, 2, 3, target);
      expect(Math.abs(measureAtoms(out, [1, 2, 3]) - target)).toBeLessThan(1e-6);
      expect(measureAtoms(out, [2, 3])).toBeCloseTo(measureAtoms(but, [2, 3]), 9);
      expect(measureAtoms(out, [3, 4])).toBeCloseTo(measureAtoms(but, [3, 4]), 9);
    }
    // ring angle: only c moves
    const bz = benzene();
    const out = setAngle(bz, 1, 2, 3, 110);
    expect(Math.abs(measureAtoms(out, [1, 2, 3]) - 110)).toBeLessThan(1e-6);
  });

  it('setAngle bends exactly collinear groups (CO2, alkyne) about some perpendicular axis', () => {
    const co2 = mk('co2', [['O', -1.16, 0, 0], ['C', 0, 0, 0], ['O', 1.16, 0, 0]], [[1, 2, 2], [2, 3, 2]], 'editor');
    for (const target of [120, 90, 179.5, 0]) {
      const out = setAngle(co2, 1, 2, 3, target);
      expect(Math.abs(measureAtoms(out, [1, 2, 3]) - target)).toBeLessThan(1e-6);
      expect(measureAtoms(out, [1, 2])).toBeCloseTo(1.16, 9);
      expect(measureAtoms(out, [2, 3])).toBeCloseTo(1.16, 9);
    }
    // slider-style: back to 180 and out again
    const back = setAngle(setAngle(co2, 1, 2, 3, 150), 1, 2, 3, 180);
    expect(measureAtoms(back, [1, 2, 3])).toBeCloseTo(180, 6);
    expect(measureAtoms(setAngle(back, 1, 2, 3, 140), [1, 2, 3])).toBeCloseTo(140, 6);
    // H–C≡C–H: the smaller side (one H) moves, the triple bond stays linear on the other end
    const hcch = mk('ethyne', [['H', -1.66, 0, 0], ['C', -0.6, 0, 0], ['C', 0.6, 0, 0], ['H', 1.66, 0, 0]], [[1, 2], [2, 3, 3], [3, 4]], 'editor');
    const bent = setAngle(hcch, 1, 2, 3, 150);
    expect(measureAtoms(bent, [1, 2, 3])).toBeCloseTo(150, 6);
    expect(measureAtoms(bent, [2, 3, 4])).toBeCloseTo(180, 6);
  });

  it('setDihedral on butane hits the target and rotates one rigid fragment', () => {
    const but = butane();
    expect(Math.abs(measureAtoms(but, [1, 2, 3, 4]))).toBeCloseTo(180, 6);
    for (const target of [60, -60, 0, 120.5, 180, -179.9]) {
      const out = setDihedral(but, 1, 2, 3, 4, target);
      const got = measureAtoms(out, [1, 2, 3, 4]);
      const diff = Math.abs(((got - target + 540) % 360) - 180);
      expect(diff).toBeLessThan(1e-6);
      // all bond lengths preserved
      for (const b of but.bonds) expect(measureAtoms(out, [b.a, b.b])).toBeCloseTo(measureAtoms(but, [b.a, b.b]), 9);
      // exactly one side of the C2–C3 bond moved (sides are equal → c's side: C3, C4 and their H)
      const c3Side = new Set([3, 4, ...hydrogensOf(but, 3), ...hydrogensOf(but, 4)]);
      for (const a of out.atoms) {
        const orig = but.atoms.find((x) => x.id === a.id)!;
        if (!c3Side.has(a.id)) expect(a).toBe(orig);
      }
    }
  });

  it('canSetDihedral explains why a dihedral cannot be changed', () => {
    const but = butane();
    expect(canSetDihedral(but, 1, 2, 3, 4)).toEqual({ ok: true });
    expect(canSetDihedral(but, 1, 3, 2, 4).reason).toBe('Atoms are not bonded in sequence');
    expect(canSetDihedral(but, 1, 2, 2, 4).reason).toBe('Atoms must be distinct');
    expect(canSetDihedral(but, 1, 2, 3, 99).reason).toBe('Atom not found');
    const ring = mk('cyclohexane', ringAtoms(Array(6).fill('C'), 1.5), ringBonds(6));
    const r = canSetDihedral(ring, 1, 2, 3, 4);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('is in a ring');
    expect(setDihedral(ring, 1, 2, 3, 4, 10)).toBe(ring);
    const linear = mk('lin', [['C', 0, 0, 0], ['C', 1.5, 0, 0], ['C', 3, 0, 0], ['C', 3, 1.5, 0]], [[0, 1], [1, 2], [2, 3]]);
    expect(canSetDihedral(linear, 1, 2, 3, 4).ok).toBe(false);
  });
});

describe('fragments, merge, center', () => {
  it('attachFragment methyl onto an ethane H gives propane with ideal geometry', () => {
    const eth = ethane();
    const h = hydrogensOf(eth, 2)[0];
    const { mol, atomIds } = attachFragment(eth, 'methyl', { anchorAtomId: h });
    expect(molecularFormula(mol)).toBe('C3H8');
    expect(atomIds).toHaveLength(4);
    expect(mol.atoms.some((a) => a.id === h)).toBe(false); // replaced H removed
    const c3 = atomIds.find((id) => mol.atoms.find((a) => a.id === id)!.element === 'C')!;
    expect(bondBetween(mol, 2, c3)).toBeDefined();
    expect(measureAtoms(mol, [2, c3])).toBeCloseTo(1.52, 6);
    expect(measureAtoms(mol, [1, 2, c3])).toBeCloseTo(109.47, 1);
    // new C–H bonds keep the template geometry, staggered against the anchor's substituents
    for (const nh of hydrogensOf(mol, c3)) {
      expect(measureAtoms(mol, [c3, nh])).toBeCloseTo(1.09, 2);
      expect(measureAtoms(mol, [2, c3, nh])).toBeGreaterThan(105);
    }
    let minHH = Infinity;
    const hs = mol.atoms.filter((a) => a.element === 'H');
    for (let i = 0; i < hs.length; i++)
      for (let j = i + 1; j < hs.length; j++) minHH = Math.min(minHH, distance([hs[i].x, hs[i].y, hs[i].z], [hs[j].x, hs[j].y, hs[j].z]));
    expect(minHH).toBeGreaterThan(1.7);
    expect(allOk(mol)).toBe(true);
    expect(mol.nextAtomId).toBe(eth.nextAtomId + 4);
  });

  it('attachFragment onto a heavy atom replaces one of its H; onto a bare atom uses an open valence', () => {
    const eth = ethane();
    const r = attachFragment(eth, 'methyl', { anchorAtomId: 1 });
    expect(molecularFormula(r.mol)).toBe('C3H8');
    expect(allOk(r.mol)).toBe(true);
    const bare = mk('ch3', [['C', 0, 0, 0], ['H', 1.09, 0, 0], ['H', -0.36, 1.03, 0], ['H', -0.36, -0.51, 0.89]], [[0, 1], [0, 2], [0, 3]]);
    const r2 = attachFragment(bare, 'methyl', { anchorAtomId: 1 });
    expect(molecularFormula(r2.mol)).toBe('C2H6');
    expect(allOk(r2.mol)).toBe(true);
    const newC = r2.atomIds.find((id) => r2.mol.atoms.find((a) => a.id === id)!.element === 'C')!;
    for (const hh of [2, 3, 4]) expect(measureAtoms(r2.mol, [hh, 1, newC])).toBeCloseTo(109.5, 0);
  });

  it('attachFragment without anchor places the full template centred at the position', () => {
    const empty = createMolecule('new');
    const { mol, atomIds } = attachFragment(empty, 'methyl', { position: [1, 2, 3] });
    expect(atomIds).toHaveLength(5);
    expect(molecularFormula(mol)).toBe('CH4');
    const c = centroid(mol);
    for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo([1, 2, 3][k], 9);
    expect(attachFragment(empty, 'no-such-fragment', {}).mol).toBe(empty);
    expect(attachFragment(mol, 'methyl', { anchorAtomId: 999 }).mol).toBe(mol);
  });

  it('mergeMolecules appends with fresh ids; centerMolecule', () => {
    const eth = ethane();
    const { mol, atomIds } = mergeMolecules(eth, eth, [10, 0, 0]);
    expect(mol.atoms).toHaveLength(16);
    expect(atomIds[0]).toBe(eth.nextAtomId);
    expect(new Set(mol.atoms.map((a) => a.id)).size).toBe(16);
    expect(new Set(mol.bonds.map((b) => b.id)).size).toBe(14);
    expect(P(mol, atomIds[0])[0]).toBeCloseTo(10, 9);
    const centered = centerMolecule(mol);
    const c = centroid(centered);
    for (const x of c) expect(Math.abs(x)).toBeLessThan(1e-9);
    expect(centerMolecule(centered)).not.toBe(undefined);
  });
});
