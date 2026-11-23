/**
 * TEST ONLY — simple stand-ins for the molecule-geometry functions of core/geometry that the editor
 * uses (the vector helpers come from the real module). Merge with vi.importActual in vi.mock:
 *   vi.mock('../core/geometry', async () => ({ ...(await vi.importActual('../core/geometry')), ...(await import('./testing/fakeGeometry')) }))
 * Must not import core/geometry itself.
 */
import type { BondOrder, Molecule, Vec3 } from '../../core/types';
import { atomById, getTopology } from '../../core/molecule';
import { getElement } from '../../core/elements';

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [1, 0, 0];
};

function ideal(a: string, b: string, order: BondOrder): number {
  const f = order === 2 ? 0.87 : order === 3 ? 0.78 : order === 1.5 ? 0.93 : 1;
  return (getElement(a).covalentRadius + getElement(b).covalentRadius) * f;
}

/** Opposite to the mean neighbour direction (or preferDir / +x for a bare atom). */
export function suggestNewAtomPosition(mol: Molecule, anchorId: number, element: string, order: BondOrder = 1, preferDir?: Vec3): Vec3 {
  const topo = getTopology(mol);
  const i = topo.idToIndex.get(anchorId)!;
  const a = mol.atoms[i];
  let dir: Vec3 = [0, 0, 0];
  for (const j of topo.neighbors[i]) {
    const n = mol.atoms[j];
    dir = [dir[0] + a.x - n.x, dir[1] + a.y - n.y, dir[2] + a.z - n.z];
  }
  const d = Math.hypot(...dir) > 1e-6 ? norm(dir) : preferDir ? norm(preferDir) : ([1, 0, 0] as Vec3);
  const l = ideal(a.element, element, order);
  return [a.x + d[0] * l, a.y + d[1] * l, a.z + d[2] * l];
}

export function openValenceDirections(): Vec3[] {
  return [];
}

export function connectedComponent(mol: Molecule, atomId: number): Set<number> {
  const topo = getTopology(mol);
  const start = topo.idToIndex.get(atomId);
  const out = new Set<number>();
  if (start === undefined) return out;
  const stack = [start];
  const seen = new Set([start]);
  while (stack.length) {
    const i = stack.pop()!;
    out.add(mol.atoms[i].id);
    for (const j of topo.neighbors[i]) if (!seen.has(j)) (seen.add(j), stack.push(j));
  }
  return out;
}

export function fragmentSide(mol: Molecule, a: number, b: number): Set<number> {
  const topo = getTopology(mol);
  const ia = topo.idToIndex.get(a)!;
  const ib = topo.idToIndex.get(b)!;
  const seen = new Set([ia, ib]);
  const stack = [ib];
  const out = new Set<number>();
  while (stack.length) {
    const i = stack.pop()!;
    out.add(mol.atoms[i].id);
    for (const j of topo.neighbors[i]) if (!seen.has(j)) (seen.add(j), stack.push(j));
  }
  return out;
}

export function measureAtoms(mol: Molecule, ids: number[]): number {
  if (ids.length !== 2) return NaN;
  const a = atomById(mol, ids[0]);
  const b = atomById(mol, ids[1]);
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : NaN;
}
