/**
 * Small hand-built molecules for render-core unit tests (idealised geometries, Å).
 * OWNER: render-core. Not used by the app.
 */
import { buildMolecule, type AtomInput, type BondInput } from '../core/molecule';
import type { BondOrder, Molecule } from '../core/types';

function atom(element: string, x: number, y: number, z: number, extra: Partial<AtomInput> = {}): AtomInput {
  return { element, x, y, z, ...extra };
}

/** Planar ethylene in the xy plane; C=C along x (1.33 Å), C–H 1.09 Å at 121.5°. */
export function ethylene(): Molecule {
  const ch = 1.09;
  const a = (121.5 * Math.PI) / 180;
  const hx = Math.cos(Math.PI - a) * ch;
  const hy = Math.sin(Math.PI - a) * ch;
  const atoms = [
    atom('C', 0, 0, 0),
    atom('C', 1.33, 0, 0),
    atom('H', -hx, hy, 0),
    atom('H', -hx, -hy, 0),
    atom('H', 1.33 + hx, hy, 0),
    atom('H', 1.33 + hx, -hy, 0),
  ];
  const bonds: BondInput[] = [
    { a: 0, b: 1, order: 2 },
    { a: 0, b: 2 },
    { a: 0, b: 3 },
    { a: 1, b: 4 },
    { a: 1, b: 5 },
  ];
  return buildMolecule('ethylene', atoms, bonds, { hasBondOrders: true });
}

/** Linear acetylene along x. */
export function acetylene(): Molecule {
  return buildMolecule(
    'acetylene',
    [atom('C', 0, 0, 0), atom('C', 1.2, 0, 0), atom('H', -1.06, 0, 0), atom('H', 2.26, 0, 0)],
    [
      { a: 0, b: 1, order: 3 },
      { a: 0, b: 2 },
      { a: 1, b: 3 },
    ],
    { hasBondOrders: true },
  );
}

/** Benzene centred at the origin in the xy plane, aromatic (1.5) ring bonds. */
export function benzene(order: BondOrder = 1.5): Molecule {
  const atoms: AtomInput[] = [];
  const bonds: BondInput[] = [];
  for (let k = 0; k < 6; k++) {
    const t = (k * Math.PI) / 3;
    atoms.push(atom('C', 1.39 * Math.cos(t), 1.39 * Math.sin(t), 0));
  }
  for (let k = 0; k < 6; k++) {
    const t = (k * Math.PI) / 3;
    atoms.push(atom('H', 2.48 * Math.cos(t), 2.48 * Math.sin(t), 0));
  }
  for (let k = 0; k < 6; k++) {
    bonds.push({ a: k, b: (k + 1) % 6, order: order === 1.5 ? 1.5 : k % 2 === 0 ? 2 : 1 });
    bonds.push({ a: k, b: k + 6 });
  }
  return buildMolecule('benzene', atoms, bonds, { hasBondOrders: true });
}

/** Two residues of a peptide-like chain with residue info (for label tests). */
export function dipeptide(): Molecule {
  const res = (resSeq: number, resName: string) => ({ resName, resSeq, chain: 'A' });
  const atoms: AtomInput[] = [
    atom('N', 0, 0, 0, { name: 'N', ...res(1, 'ALA') }),
    atom('C', 1.46, 0, 0, { name: 'CA', ...res(1, 'ALA') }),
    atom('C', 2.0, 1.4, 0, { name: 'C', ...res(1, 'ALA') }),
    atom('O', 1.3, 2.4, 0, { name: 'O', ...res(1, 'ALA') }),
    atom('H', -0.5, -0.9, 0, { name: 'H', ...res(1, 'ALA') }),
    atom('N', 3.3, 1.5, 0, { name: 'N', ...res(2, 'GLY') }),
    atom('C', 3.9, 2.8, 0, { name: 'CA', ...res(2, 'GLY') }),
  ];
  return buildMolecule('dipeptide', atoms, [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 2, b: 3, order: 2 },
    { a: 0, b: 4 },
    { a: 2, b: 5 },
    { a: 5, b: 6 },
  ]);
}

/** Same molecule with atom `index` moved by (dx, dy, dz): new molecule, new atom object, others shared. */
export function moveAtom(mol: Molecule, index: number, dx: number, dy: number, dz: number): Molecule {
  const atoms = mol.atoms.slice();
  const a = atoms[index];
  atoms[index] = { ...a, x: a.x + dx, y: a.y + dy, z: a.z + dz };
  return { ...mol, atoms };
}
