import { describe, expect, it } from 'vitest';
import { FRAGMENTS, FRAGMENT_CATEGORIES, getFragment, type FragmentTemplate } from './templates';
import { buildMolecule } from './molecule';
import type { Molecule } from './types';
import { allowedValences } from './ff-chem';
import { perceiveTyping, restLength } from './ff-model';
import { forceFieldEnergy, minimize } from './minimize';

function toMolecule(f: FragmentTemplate): Molecule {
  return buildMolecule(
    f.id,
    f.atoms.map((a) => ({ element: a.element, x: a.x, y: a.y, z: a.z, charge: a.charge })),
    f.bonds.map((b) => ({ a: b.a, b: b.b, order: b.order })),
    { source: 'editor' },
  );
}

/** Valence (bond-order sum) as a Kekulé structure would count it: k aromatic bonds count k + 1. */
function valence(f: FragmentTemplate, i: number): number {
  let sum = 0;
  let arom = 0;
  for (const b of f.bonds) {
    if (b.a !== i && b.b !== i) continue;
    if (b.order === 1.5) arom++;
    else sum += b.order;
  }
  return sum + (arom ? arom + 1 : 0);
}

const dist = (f: FragmentTemplate, i: number, j: number) =>
  Math.hypot(f.atoms[i].x - f.atoms[j].x, f.atoms[i].y - f.atoms[j].y, f.atoms[i].z - f.atoms[j].z);

describe('fragment templates', () => {
  it('provides the required set, with unique ids, and the store default "benzene"', () => {
    const ids = FRAGMENTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(FRAGMENTS.length).toBeGreaterThanOrEqual(25);
    for (const id of [
      'benzene', 'cyclohexane', 'cyclopentane', 'pyridine', 'pyrrole', 'furan', 'thiophene', 'naphthalene', 'imidazole',
      'methyl', 'ethyl', 'hydroxyl', 'amine', 'carbonyl', 'carboxyl', 'aldehyde', 'nitro', 'nitrile', 'amide', 'phenyl',
      'trifluoromethyl', 'sulfonyl', 'phosphate', 'glycine', 'alanine',
    ])
      expect(getFragment(id), id).toBeDefined();
    expect(getFragment('nope')).toBeUndefined();
    const cats = new Set(FRAGMENT_CATEGORIES.map((c) => c.id));
    for (const f of FRAGMENTS) expect(cats.has(f.category)).toBe(true);
  });

  for (const f of FRAGMENTS) {
    describe(f.id, () => {
      it('has valid indices, no duplicate bonds and a short label', () => {
        expect(f.label.length).toBeGreaterThan(0);
        expect(f.label.length).toBeLessThanOrEqual(8);
        expect(f.name.length).toBeGreaterThan(0);
        const seen = new Set<string>();
        for (const b of f.bonds) {
          expect(b.a).toBeGreaterThanOrEqual(0);
          expect(b.b).toBeGreaterThanOrEqual(0);
          expect(b.a).toBeLessThan(f.atoms.length);
          expect(b.b).toBeLessThan(f.atoms.length);
          expect(b.a).not.toBe(b.b);
          const key = [b.a, b.b].sort((x, y) => x - y).join(',');
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      });

      it('has consistent valences on every atom (formal charges included)', () => {
        for (let i = 0; i < f.atoms.length; i++) {
          const a = f.atoms[i];
          const allowed = allowedValences(a.element, a.charge ?? 0);
          expect(allowed, `${f.id} atom ${i} ${a.element}`).toContain(valence(f, i));
        }
        const q = f.atoms.reduce((s, a) => s + (a.charge ?? 0), 0);
        expect(q).toBe(0);
      });

      it('attachHydrogen is an H bonded to attachAtom (pointing where the anchor goes)', () => {
        expect(f.atoms[f.attachHydrogen].element).toBe('H');
        expect(f.atoms[f.attachAtom].element).not.toBe('H');
        const bond = f.bonds.find(
          (b) => (b.a === f.attachAtom && b.b === f.attachHydrogen) || (b.b === f.attachAtom && b.a === f.attachHydrogen),
        );
        expect(bond?.order).toBe(1);
        // the H is the only neighbour of itself
        expect(f.bonds.filter((b) => b.a === f.attachHydrogen || b.b === f.attachHydrogen)).toHaveLength(1);
        // documented frame: attach atom at the origin, H on +x
        const a = f.atoms[f.attachAtom];
        const h = f.atoms[f.attachHydrogen];
        expect(Math.hypot(a.x, a.y, a.z)).toBeLessThan(1e-9);
        expect(h.x).toBeGreaterThan(0.9);
        expect(Math.hypot(h.y, h.z)).toBeLessThan(1e-3);
      });

      it('has an accurate, relaxed 3D geometry', () => {
        const mol = toMolecule(f);
        const t = perceiveTyping(mol);
        for (const b of f.bonds) {
          const r0 = restLength(mol, t, b.a, b.b, b.order);
          expect(Math.abs(dist(f, b.a, b.b) - r0), `${f.id} bond ${b.a}-${b.b}`).toBeLessThan(0.03);
        }
        // no two atoms closer than 1.4 Å unless bonded (H…H in CH₃ ≈ 1.78 Å)
        for (let i = 0; i < f.atoms.length; i++)
          for (let j = i + 1; j < f.atoms.length; j++) {
            const bonded = f.bonds.some((b) => (b.a === i && b.b === j) || (b.a === j && b.b === i));
            if (!bonded) expect(dist(f, i, j)).toBeGreaterThan(1.4);
          }
        // re-minimising barely changes the energy (stored geometry is at a minimum)
        const e0 = forceFieldEnergy(mol).total;
        const e1 = minimize(mol, { maxSteps: 300, tolerance: 0.01 }).energy;
        expect(e0 - e1).toBeLessThan(0.5);
      });
    });
  }

  it('benzene / phenyl rings are planar and the attach C–H is in the ring plane', () => {
    for (const id of ['benzene', 'phenyl', 'pyridine', 'naphthalene']) {
      const f = getFragment(id)!;
      // all atoms lie in one plane through the origin
      const n = [0, 0, 0];
      const heavy = f.atoms.filter((a) => a.element !== 'H');
      const p1 = heavy[1], p2 = heavy[2];
      n[0] = p1.y * p2.z - p1.z * p2.y;
      n[1] = p1.z * p2.x - p1.x * p2.z;
      n[2] = p1.x * p2.y - p1.y * p2.x;
      const l = Math.hypot(n[0], n[1], n[2]);
      for (const a of f.atoms) expect(Math.abs((a.x * n[0] + a.y * n[1] + a.z * n[2]) / l)).toBeLessThan(0.02);
    }
  });

  it('cyclohexane attaches through an equatorial hydrogen', () => {
    const f = getFragment('cyclohexane')!;
    const ring = [0, 1, 2, 3, 4, 5];
    // mean-plane normal (Newell)
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 6; k++) {
      const p = f.atoms[ring[k]], q = f.atoms[ring[(k + 1) % 6]];
      nx += (p.y - q.y) * (p.z + q.z);
      ny += (p.z - q.z) * (p.x + q.x);
      nz += (p.x - q.x) * (p.y + q.y);
    }
    const l = Math.hypot(nx, ny, nz);
    const h = f.atoms[f.attachHydrogen];
    const cosToNormal = Math.abs((h.x * nx + h.y * ny + h.z * nz) / (l * Math.hypot(h.x, h.y, h.z)));
    expect(cosToNormal).toBeLessThan(0.5); // equatorial: far from the ring normal (axial would be ≈ 1)
  });

  it('L-alanine has the S configuration', () => {
    const f = getFragment('alanine')!;
    // atoms: 0 N, 1 CA, 2 CB, 3 C(=O), …
    const ca = f.atoms[1];
    const v = (i: number) => [f.atoms[i].x - ca.x, f.atoms[i].y - ca.y, f.atoms[i].z - ca.z];
    const [a, b, c] = [v(0), v(3), v(2)]; // N > COOH > CH3
    const t = a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    expect(t).toBeGreaterThan(0); // > 0 ⇔ S (see smiles.test.ts cip())
  });
});
