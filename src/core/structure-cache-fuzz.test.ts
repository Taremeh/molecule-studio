/**
 * Randomised check of the structure-keyed caches (getTopology, analyzeValence, moleculeSummary, rings,
 * selection index and results): after arbitrary sequences of edit ops, undo-like revisits, drags and
 * relaxation, the cached answer for a molecule must equal a fresh computation. The fresh computation
 * uses a twin whose atoms carry a unique altLoc (read by no cached computation, compared by
 * sameStructure), so it never matches a remembered structure.
 */
import { describe, expect, it } from 'vitest';
import { bondBetween, cloneMolecule, deepCloneMolecule, getTopology } from './molecule';
import { analyzeValence, findRings, isAtomInRing, moleculeSummary, ringBondMask } from './chemistry';
import { evaluateSelection } from './selection';
import * as E from './edit';
import { applyCoordinates, createMinimizer, minimize } from './minimize';
import { assignSecondaryStructure } from './secondary';
import { prepareMolecule } from './prepare';
import { moleculeFromSmiles } from './smiles';
import { parseMolecule } from '../io/formats';
import { DIPEPTIDE_MOL2, PDB_FIXTURE, PYRIDINIUM_MOL } from '../io/__fixtures__/fixtures';
import type { Atom, BondOrder, Molecule, Vec3 } from './types';

const QUERIES = [
  'protein', 'backbone', 'sidechain', 'water', 'ligand', 'ion', 'hetero', 'organic', 'hydrogen', 'helix', 'sheet', 'coil',
  'aromatic', 'polar', 'element C', 'element N O', 'name CA', 'resname ALA', 'chain A', 'resid 1 to 5', 'index 0 to 3',
  'id 1 2 3', 'serial 1 to 10', 'bfactor > 10', 'occupancy < 1', 'charge < 0', 'same residue as element O',
  'bonded to element N', 'same fragment as index 0', 'bychain index 0', 'x > 0', 'y 0 to 5', 'within 3 of index 0',
  'exwithin 3 of element O', 'not within 2 of hydrogen', 'same residue as within 3 of index 0', 'bonded to (z < 1)', 'CA',
  'carbn', 'element Q',
];

let twinCounter = 0;
/** Same molecule, but a structure no cache has seen (unique altLoc on every atom). */
function freshTwin(m: Molecule): Molecule {
  const tag = '\u0000' + ++twinCounter;
  return { ...m, atoms: m.atoms.map((a) => ({ ...a, altLoc: (a.altLoc ?? '') + tag })), bonds: m.bonds.map((b) => ({ ...b })) };
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

function check(m: Molecule, rnd: () => number, ctx: string): void {
  // Query the caches for m first (they may hit a remembered structure), then for the fresh twin.
  const steps = [0, 1, 2, 3].sort(() => rnd() - 0.5);
  const got: unknown[] = [];
  const queries = QUERIES.filter(() => rnd() < 0.4);
  const run = (x: Molecule) => {
    const out: unknown[] = [];
    for (const k of steps) {
      if (k === 0) out.push(getTopology(x));
      if (k === 1) out.push(analyzeValence(x), moleculeSummary(x));
      if (k === 2) out.push(ringBondMask(x), findRings(x), x.atoms.map((a) => isAtomInRing(x, a.id)));
      if (k === 3) out.push(queries.map((q) => evaluateSelection(x, q)));
    }
    return out;
  };
  got.push(...run(m));
  expect(got, ctx).toEqual(run(freshTwin(m)));
}

function withAtom(mol: Molecule, index: number, patch: Partial<Atom>): Molecule {
  const atoms = mol.atoms.slice();
  const next = { ...atoms[index], ...patch } as Atom;
  for (const k of Object.keys(patch) as (keyof Atom)[]) if (patch[k] === undefined) delete next[k];
  atoms[index] = next;
  return { ...mol, atoms };
}

const ELEMENTS = ['C', 'N', 'O', 'S', 'H', 'Cl', 'Na'];
const ORDERS: BondOrder[] = [1, 1.5, 2, 3];
const FIELD_VALUES: Record<string, unknown[]> = {
  ss: ['helix', 'sheet', 'coil', undefined], resName: ['ALA', 'GLY', 'HOH', 'LIG', 'NA', undefined], chain: ['A', 'B', undefined],
  name: ['CA', 'N', 'O', 'CB', undefined], resSeq: [1, 2, 3, undefined], iCode: ['A', '', undefined], hetero: [true, false, undefined],
  bfactor: [10, 11, NaN, undefined], occupancy: [1, 0.5, undefined], serial: [1, 2, undefined],
};

function mutate(m: Molecule, rnd: () => number): Molecule {
  const n = m.atoms.length;
  if (n === 0) return E.addAtom(m, 'C', [0, 0, 0]).mol;
  const atom = () => m.atoms[Math.floor(rnd() * n)];
  const ids = (p: number) => m.atoms.filter(() => rnd() < p).map((a) => a.id);
  switch (Math.floor(rnd() * 20)) {
    case 0:
      return E.translateAtoms(m, ids(0.1), [rnd(), rnd(), rnd()]);
    case 1: {
      const pos = new Map<number, Vec3>();
      for (const id of ids(0.2)) pos.set(id, [rnd() * 5, rnd() * 5, rnd() * 5]);
      return E.setPositions(m, pos);
    }
    case 2:
      return E.setElement(m, [atom().id], pick(rnd, ELEMENTS));
    case 3:
      return E.setCharge(m, atom().id, Math.floor(rnd() * 3) - 1);
    case 4:
      return E.addAtom(m, pick(rnd, ELEMENTS), [rnd(), rnd(), rnd()], { bondTo: atom().id }).mol;
    case 5:
      return E.removeAtoms(m, [atom().id]);
    case 6: {
      const a = atom().id, b = atom().id;
      return a === b || bondBetween(m, a, b) ? m : E.addBond(m, a, b, pick(rnd, ORDERS)).mol;
    }
    case 7:
      return m.bonds.length ? E.removeBonds(m, [pick(rnd, m.bonds).id]) : m;
    case 8:
      return m.bonds.length ? E.setBondOrder(m, pick(rnd, m.bonds).id, pick(rnd, ORDERS)) : m;
    case 9: {
      const f = pick(rnd, Object.keys(FIELD_VALUES));
      return withAtom(m, Math.floor(rnd() * n), { [f]: pick(rnd, FIELD_VALUES[f]) } as Partial<Atom>);
    }
    case 10: {
      const d = deepCloneMolecule(m);
      for (const a of d.atoms) a.x += 1; // fresh objects, never seen by a cache
      return d;
    }
    case 11:
      return cloneMolecule(m);
    case 12:
      return E.addHydrogens(m, ids(0.3));
    case 13:
      return E.removeHydrogens(m, ids(0.5));
    case 14:
      return E.attachFragment(m, 'benzene', { anchorAtomId: atom().id }).mol;
    case 15:
      return assignSecondaryStructure(m, true);
    case 16:
      return applyCoordinates(m, new Float64Array(n * 3).map((_, k) => m.atoms[Math.floor(k / 3)][(['x', 'y', 'z'] as const)[k % 3]] + rnd() * 0.1));
    case 17:
      return minimize(m, { maxSteps: 2 }).mol;
    case 18: {
      const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
      const atoms = m.atoms.slice();
      [atoms[i], atoms[j]] = [atoms[j], atoms[i]];
      return { ...m, atoms };
    }
    default:
      return E.adjustHydrogens(m, ids(0.3));
  }
}

describe('structure caches agree with a fresh computation', () => {
  const starts = [
    prepareMolecule(parseMolecule(PDB_FIXTURE, 'pdb')),
    prepareMolecule(parseMolecule(DIPEPTIDE_MOL2, 'mol2')),
    prepareMolecule(parseMolecule(PYRIDINIUM_MOL, 'sdf')),
    moleculeFromSmiles('CC(=O)[O-].[Na+]'),
    moleculeFromSmiles('Cn1cnc2c1c(=O)n(C)c(=O)n2C'),
  ];
  for (let seed = 1; seed <= 6; seed++) {
    it(`random edit session ${seed}`, () => {
      const rnd = rng(seed * 104729);
      const history: Molecule[] = [starts[seed % starts.length]];
      for (let step = 0; step < 120; step++) {
        const from = rnd() < 0.8 ? history[history.length - 1] : pick(rnd, history); // undo / redo
        if (rnd() < 0.15) check(from, rnd, `seed ${seed} step ${step} revisit`);
        let next: Molecule;
        try {
          next = mutate(from, rnd);
        } catch {
          continue; // an op refused this input
        }
        check(next, rnd, `seed ${seed} step ${step}`);
        if (rnd() < 0.2 && next.atoms.length) {
          // a drag: frames from the same base
          const moved = next.atoms.filter(() => rnd() < 0.1).map((a) => a.id);
          for (let f = 1; f <= 3; f++) check(E.translateAtoms(next, moved.length ? moved : [next.atoms[0].id], [0.1 * f, 0, 0]), rnd, `seed ${seed} step ${step} frame ${f}`);
        }
        if (rnd() < 0.05 && next.atoms.length > 2) {
          try {
            const mz = createMinimizer(next, { movable: new Set(next.atoms.slice(0, 5).map((a) => a.id)) });
            mz.step(2);
            check(E.setPositions(next, mz.positions()), rnd, `seed ${seed} step ${step} relax`);
          } catch {
            /* the minimiser may refuse odd structures */
          }
        }
        history.push(next);
        if (history.length > 30) history.shift();
      }
    });
  }
});
