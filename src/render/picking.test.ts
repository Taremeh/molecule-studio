import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Picker, nearestMaskedAtom, type PickRay } from './picking';
import { AtomRep } from './reps/atoms';
import { LinesRep } from './reps/lines';
import { buildMolecule, type AtomInput } from '../core/molecule';
import type { Molecule } from '../core/types';
import { ethylene } from './testMolecules';

const all = (n: number) => new Uint8Array(n).fill(1);
const grey = (n: number) => new Float32Array(n * 3).fill(0.5);
/** 1 px = 0.002 · t Å (≈ a 35° FOV on a 600 px tall canvas). */
const px = (t: number) => 0.002 * t;

function down(x: number, y: number, z = 20): PickRay {
  return { ox: x, oy: y, oz: z, dx: 0, dy: 0, dz: -1 };
}

function picker(mol: Molecule, style: 'ball-and-stick' | 'spacefill' | 'licorice' | 'lines') {
  const p = new Picker();
  if (style === 'lines') {
    const rep = new LinesRep(mol, all(mol.atoms.length), grey(mol.atoms.length), { scale: 1, opacity: 1 });
    p.setSources(mol, [], [rep.pickData()], []);
  } else {
    const rep = new AtomRep(mol, all(mol.atoms.length), grey(mol.atoms.length), { style, quality: 'low', scale: 1, opacity: 1 });
    p.setSources(mol, [rep.pickData()], [], []);
  }
  return p;
}

describe('Picker (spheres / capsules)', () => {
  const mol = ethylene();

  it('picks the atom under the pointer with the hit point on its surface', () => {
    const p = picker(mol, 'ball-and-stick');
    const hit = p.pick(down(0, 0), px)!;
    expect(hit.kind).toBe('atom');
    expect(hit.index).toBe(0);
    const r = 0.25 * 1.7; // ~ball-and-stick carbon radius
    expect(hit.point[2]).toBeGreaterThan(0.3);
    expect(hit.point[2]).toBeLessThan(r + 0.2);
  });

  it('picks a bond between two atoms', () => {
    const p = picker(mol, 'ball-and-stick');
    // Middle of the C=C bond, between the two offset cylinders' pick radius.
    const hit = p.pick(down(0.665, 0.05), px)!;
    expect(hit.kind).toBe('bond');
    expect(mol.bonds[hit.index].order).toBe(2);
  });

  it('prefers an atom when the pointer is within ~2 px of it, even over a nearer bond', () => {
    const p = picker(mol, 'licorice');
    // Licorice: atom and bond radius are equal (0.2), so near the atom the capsule is hit at the same
    // depth. A point just outside the C1 sphere along the bond (within 2 px) must return the atom.
    const hit = p.pick(down(0.205, 0), px)!;
    expect(hit.kind).toBe('atom');
    expect(hit.index).toBe(0);
    // Well along the bond it is the bond.
    expect(p.pick(down(0.66, 0), px)!.kind).toBe('bond');
  });

  it('returns null on empty space and for empty sources', () => {
    const p = picker(mol, 'ball-and-stick');
    expect(p.pick(down(5, 5), px)).toBeNull();
    const empty = new Picker();
    expect(empty.pick(down(0, 0), px)).toBeNull();
    empty.setSources(null, [], [], []);
    expect(empty.pick(down(0, 0), px)).toBeNull();
  });

  it('spacefill uses vdW radii and has no bonds', () => {
    const p = picker(mol, 'spacefill');
    const hit = p.pick(down(0.665, 0), px)!;
    expect(hit.kind).toBe('atom');
  });

  it('sees coordinate changes after invalidate()', () => {
    const rep = new AtomRep(mol, all(6), grey(6), { style: 'ball-and-stick', quality: 'low', scale: 1, opacity: 1 });
    const p = new Picker();
    p.setSources(mol, [rep.pickData()], [], []);
    expect(p.pick(down(10, 0), px)).toBeNull();
    const atoms = mol.atoms.slice();
    atoms[0] = { ...atoms[0], x: 10 };
    const moved = { ...mol, atoms };
    rep.updateCoordinates(moved, null);
    p.setSources(moved, [rep.pickData()], [], []);
    expect(p.pick(down(10, 0), px)?.index).toBe(0);
  });
});

describe('Picker.moveAtoms (incremental drags)', () => {
  it('finds moved atoms and bonds without rebuilding the grid', () => {
    const mol = ethylene();
    const rep = new AtomRep(mol, all(6), grey(6), { style: 'ball-and-stick', quality: 'low', scale: 1, opacity: 1 });
    const p = new Picker();
    p.setSources(mol, [rep.pickData()], [], []);
    expect(p.pick(down(0, 0), px)?.index).toBe(0); // builds the grid
    const grid = (p as unknown as { grid: unknown }).grid;
    // Drag C1 far away (outside the original grid bounds).
    const atoms = mol.atoms.slice();
    atoms[0] = { ...atoms[0], x: 25, y: 3 };
    const moved = { ...mol, atoms };
    rep.updateCoordinates(moved, new Int32Array([0]));
    p.moveAtoms(moved, new Int32Array([0]), []);
    expect(p.pick(down(25, 3), px)?.index).toBe(0);
    expect(p.pick(down(0, 0), px)).toBeNull();
    // The long C1=C2 bond now spans x = 1.33 … 25: hit in the middle.
    const mid = p.pick(down(13, 1.5), px)!;
    expect(mid.kind).toBe('bond');
    expect((p as unknown as { grid: unknown }).grid).toBe(grid); // not rebuilt
    // Unknown changes force a rebuild.
    p.moveAtoms(moved, null, []);
    expect(p.pick(down(25, 3), px)?.index).toBe(0);
    expect((p as unknown as { grid: unknown }).grid).not.toBe(grid);
  });
});

describe('Picker (lines)', () => {
  const mol = ethylene();
  it('uses a pixel tolerance around atoms and bonds', () => {
    const p = picker(mol, 'lines');
    // 3 px from C1 at t ≈ 20 Å → 0.12 Å.
    const a = p.pick(down(0.12, 0), px)!;
    expect(a.kind).toBe('atom');
    expect(a.index).toBe(0);
    // Middle of the C=C bond, 2 px off the line → bond.
    const b = p.pick(down(0.665, 0.08), px)!;
    expect(b.kind).toBe('bond');
    // 10 px off → nothing.
    expect(p.pick(down(0.665, 0.4), px)).toBeNull();
  });
});

describe('Picker (meshes)', () => {
  it('maps a mesh hit to the atom of the nearest vertex, with a nearest-atom fallback', () => {
    const mol = ethylene();
    // A quad in the plane z = 1 over C1 (x < 0.66) and C2 (x > 0.66).
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 1, 1.33, -1, 1, 1.33, 1, 1, 0, 1, 1], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    mesh.userData.vertexAtomIndex = new Int32Array([0, 1, 1, 0]);
    const p = new Picker();
    p.setSources(mol, [], [], [{ object: mesh, mol, mask: all(6) }]);
    const h1 = p.pick(down(0.2, -0.8), px)!;
    expect(h1.kind).toBe('atom');
    expect(h1.index).toBe(0);
    expect(h1.point[2]).toBeCloseTo(1, 6);
    expect(p.pick(down(1.2, -0.9), px)!.index).toBe(1);

    // Without a vertex map → nearest atom of the mask to the hit point.
    const mesh2 = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    const p2 = new Picker();
    const mask = new Uint8Array([0, 1, 0, 0, 0, 0]);
    p2.setSources(mol, [], [], [{ object: mesh2, mol, mask }]);
    expect(p2.pick(down(0.1, 0.1), px)!.index).toBe(1);
    expect(nearestMaskedAtom(mol, mask, 0, 0, 0)).toBe(1);
  });
});

describe('Picker performance', () => {
  function cloud(n: number, seed = 1): Molecule {
    let s = seed;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    // Protein-like density: 50k atoms in a ~80 Å cube.
    const side = Math.cbrt(n / 0.1);
    const atoms: AtomInput[] = [];
    for (let i = 0; i < n; i++) atoms.push({ element: i % 5 === 0 ? 'O' : 'C', x: rand() * side, y: rand() * side, z: rand() * side });
    // Chain bonds between consecutive atoms that happen to be close.
    const bonds = [];
    for (let i = 1; i < n; i++) {
      const a = atoms[i - 1];
      const b = atoms[i];
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 3) bonds.push({ a: i - 1, b: i });
    }
    return buildMolecule('cloud', atoms, bonds);
  }

  it('picks 50k atoms in well under 4 ms (ball-and-stick and lines)', () => {
    const mol = cloud(50_000);
    const side = Math.cbrt(50_000 / 0.1);
    for (const style of ['ball-and-stick', 'lines'] as const) {
      const p = picker(mol, style);
      p.pick(down(side / 2, side / 2, side * 3), px); // builds the grid
      let s = 9;
      const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const N = 200;
      // Best of 3 batches: the full suite runs many test files in parallel, so a single batch can be
      // slowed by CPU contention that has nothing to do with the picker.
      let per = Infinity;
      for (let batch = 0; batch < 3; batch++) {
        const t0 = performance.now();
        for (let k = 0; k < N; k++) p.pick(down(rand() * side, rand() * side, side * 3), (t) => 0.0008 * t);
        per = Math.min(per, (performance.now() - t0) / N);
      }
      expect(per).toBeLessThan(4);
    }
  });
});
