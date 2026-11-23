/**
 * TEST ONLY — straightforward implementation of the core/edit contract subset used by the editor,
 * so editor tests are independent of the concurrently developed core/edit.ts.
 * Hydrogens added by adjustHydrogens are placed along fixed directions (geometry is not under test).
 * Used via vi.mock('../core/edit', () => import('./testing/fakeEdit')) together with fakeChemistry.
 */
import type { Atom, BondOrder, Molecule, Vec3 } from '../../core/types';
import { atomById, bondBetween, getTopology, neighborIds } from '../../core/molecule';
import { valenceOf } from './fakeChemistry';

export function addAtom(mol: Molecule, element: string, position: Vec3, opts: { bondTo?: number; order?: BondOrder; charge?: number } = {}) {
  const id = mol.nextAtomId;
  const atom: Atom = { id, element, x: position[0], y: position[1], z: position[2], name: `${element}${id}` };
  if (opts.charge) atom.charge = opts.charge;
  const out: Molecule = { ...mol, atoms: [...mol.atoms, atom], nextAtomId: id + 1 };
  if (opts.bondTo !== undefined && atomById(mol, opts.bondTo)) {
    out.bonds = [...mol.bonds, { id: mol.nextBondId, a: opts.bondTo, b: id, order: opts.order ?? 1 }];
    out.nextBondId = mol.nextBondId + 1;
  }
  return { mol: out, atomId: id };
}

export function removeAtoms(mol: Molecule, ids: Iterable<number>): Molecule {
  const set = new Set(ids);
  if (!set.size) return mol;
  return { ...mol, atoms: mol.atoms.filter((a) => !set.has(a.id)), bonds: mol.bonds.filter((b) => !set.has(b.a) && !set.has(b.b)) };
}

export function addBond(mol: Molecule, a: number, b: number, order: BondOrder = 1) {
  const existing = bondBetween(mol, a, b);
  if (existing) return { mol: setBondOrder(mol, existing.id, order), bondId: existing.id };
  return { mol: { ...mol, bonds: [...mol.bonds, { id: mol.nextBondId, a, b, order }], nextBondId: mol.nextBondId + 1 }, bondId: mol.nextBondId };
}

export function removeBonds(mol: Molecule, ids: Iterable<number>): Molecule {
  const set = new Set(ids);
  return { ...mol, bonds: mol.bonds.filter((b) => !set.has(b.id)) };
}

export function setBondOrder(mol: Molecule, bondId: number, order: BondOrder): Molecule {
  return { ...mol, bonds: mol.bonds.map((b) => (b.id === bondId ? { ...b, order } : b)) };
}

export function cycleBondOrder(mol: Molecule, bondId: number): Molecule {
  const b = mol.bonds.find((x) => x.id === bondId);
  if (!b) return mol;
  return setBondOrder(mol, bondId, b.order === 1 ? 2 : b.order === 2 ? 3 : b.order === 3 ? 1 : 2);
}

export function setElement(mol: Molecule, ids: Iterable<number>, element: string): Molecule {
  const set = new Set(ids);
  return { ...mol, atoms: mol.atoms.map((a) => (set.has(a.id) ? { ...a, element } : a)) };
}

export function setCharge(mol: Molecule, id: number, charge: number): Molecule {
  return { ...mol, atoms: mol.atoms.map((a) => (a.id === id ? { ...a, charge } : a)) };
}

export function translateAtoms(mol: Molecule, ids: Iterable<number>, d: Vec3): Molecule {
  const set = new Set(ids);
  return { ...mol, atoms: mol.atoms.map((a) => (set.has(a.id) ? { ...a, x: a.x + d[0], y: a.y + d[1], z: a.z + d[2] } : a)) };
}

export function setPositions(mol: Molecule, positions: Map<number, Vec3>): Molecule {
  return { ...mol, atoms: mol.atoms.map((a) => (positions.has(a.id) ? { ...a, x: positions.get(a.id)![0], y: positions.get(a.id)![1], z: positions.get(a.id)![2] } : a)) };
}

/** Moves only atom b along the a→b axis (enough for tests). */
export function setDistance(mol: Molecule, a: number, b: number, target: number): Molecule {
  const A = atomById(mol, a);
  const B = atomById(mol, b);
  if (!A || !B) return mol;
  const v: Vec3 = [B.x - A.x, B.y - A.y, B.z - A.z];
  const l = Math.hypot(...v) || 1;
  return setPositions(mol, new Map([[b, [A.x + (v[0] / l) * target, A.y + (v[1] / l) * target, A.z + (v[2] / l) * target]]]));
}

export function removeHydrogens(mol: Molecule, ids?: Iterable<number>): Molecule {
  if (!ids) return removeAtoms(mol, mol.atoms.filter((a) => a.element === 'H').map((a) => a.id));
  const hs: number[] = [];
  for (const id of ids) for (const n of neighborIds(mol, id)) if (atomById(mol, n)?.element === 'H') hs.push(n);
  return removeAtoms(mol, hs);
}

const H_DIRS: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
];

export function adjustHydrogens(mol: Molecule, ids: Iterable<number>): Molecule {
  let m = mol;
  for (const id of ids) {
    const info = valenceOf(m, id);
    const atom = atomById(m, id);
    if (!info || !atom || !info.allowed.length || atom.element === 'H') continue;
    const max = Math.max(...info.allowed);
    const sum = Math.floor(info.bondOrderSum + 1e-6);
    if (sum > max) {
      const hs = neighborIds(m, id).filter((n) => atomById(m, n)?.element === 'H');
      m = removeAtoms(m, hs.slice(0, sum - max));
    } else if (info.status === 'under') {
      for (let k = 0; k < info.openValence; k++) {
        const d = H_DIRS[(neighborIds(m, id).length + k) % H_DIRS.length];
        m = addAtom(m, 'H', [atom.x + d[0], atom.y + d[1], atom.z + d[2]], { bondTo: id }).mol;
      }
    }
  }
  return m;
}

export function addHydrogens(mol: Molecule, ids?: Iterable<number>): Molecule {
  return adjustHydrogens(mol, ids ?? mol.atoms.filter((a) => a.element !== 'H').map((a) => a.id));
}

export function attachFragment(mol: Molecule, _fragmentId: string, _opts: { anchorAtomId?: number; position?: Vec3 }) {
  return { mol, atomIds: [] as number[] };
}

export function setAngle(mol: Molecule): Molecule {
  return mol;
}

export function setDihedral(mol: Molecule): Molecule {
  return mol;
}

export function canSetDihedral() {
  return { ok: true };
}

export function mergeMolecules(mol: Molecule) {
  return { mol, atomIds: [] as number[] };
}

export function centerMolecule(mol: Molecule): Molecule {
  return mol;
}

/** Element counts, e.g. { C: 1, H: 4 } — handy for assertions. */
export function composition(mol: Molecule): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of mol.atoms) out[a.element] = (out[a.element] ?? 0) + 1;
  return out;
}

export { getTopology };
