import { describe, expect, it } from 'vitest';
import {
  AROMATIC_OFFSET,
  BALL_STICK_BOND_RADIUS,
  DOUBLE_OFFSET,
  LICORICE_RADIUS,
  TRIPLE_OFFSET,
  buildStickLayout,
  chooseReferenceAtom,
} from './bondLayout';
import { acetylene, benzene, ethylene } from './testMolecules';

const all = (n: number) => new Uint8Array(n).fill(1);

describe('buildStickLayout', () => {
  it('ethylene: double bond = 4 offset sticks, singles = 2 halves', () => {
    const mol = ethylene();
    const L = buildStickLayout(mol, all(mol.atoms.length), 'ball-and-stick');
    expect(L.bonds.length).toBe(5);
    expect(L.count).toBe(4 + 4 * 2);
    // Bond 0 is C=C.
    const d = L.bondToDisplayed[0];
    expect(L.bondStickCount[d]).toBe(4);
    const s0 = L.bondFirstStick[d];
    const offsets = Array.from(L.offset.slice(s0, s0 + 4)).sort();
    expect(offsets[0]).toBeCloseTo(-DOUBLE_OFFSET);
    expect(offsets[3]).toBeCloseTo(DOUBLE_OFFSET);
    // Thinner than a single bond, and each half coloured by its own atom.
    for (let s = s0; s < s0 + 4; s++) {
      expect(L.radius[s]).toBeLessThan(BALL_STICK_BOND_RADIUS);
      expect(L.colorAtom[s]).toBe(L.t0[s] < 0.5 ? L.a[s] : L.b[s]);
    }
    // Reference atom for the plane is a substituent (an H here — no other heavy neighbours).
    expect([2, 3, 4, 5]).toContain(L.bondRef[d]);
    // Pick radius covers both cylinders.
    expect(L.bondPickRadius[d]).toBeGreaterThanOrEqual(DOUBLE_OFFSET);
  });

  it('acetylene: triple bond = centre + two offset cylinders', () => {
    const mol = acetylene();
    const L = buildStickLayout(mol, all(mol.atoms.length), 'ball-and-stick');
    const d = L.bondToDisplayed[0];
    expect(L.bondStickCount[d]).toBe(6);
    const s0 = L.bondFirstStick[d];
    const offs = new Set(Array.from(L.offset.slice(s0, s0 + 6)).map((x) => Math.round(x * 1000)));
    expect(offs).toEqual(new Set([0, Math.round(TRIPLE_OFFSET * 1000), -Math.round(TRIPLE_OFFSET * 1000)]));
  });

  it('benzene (aromatic): full bond + inner dashes referenced to a ring neighbour', () => {
    const mol = benzene();
    const L = buildStickLayout(mol, all(mol.atoms.length), 'ball-and-stick');
    expect(L.count).toBe(6 * 4 + 6 * 2);
    for (let k = 0; k < 6; k++) {
      const bi = mol.bonds.findIndex((b) => b.a === k + 1 && b.b === ((k + 1) % 6) + 1) ;
      const ring = bi >= 0 ? bi : mol.bonds.findIndex((b) => b.b === k + 1 && b.a === ((k + 1) % 6) + 1);
      const d = L.bondToDisplayed[ring];
      const ref = L.bondRef[d];
      // The reference must be a ring carbon (index < 6), not a hydrogen.
      expect(ref).toBeGreaterThanOrEqual(0);
      expect(ref).toBeLessThan(6);
      const s0 = L.bondFirstStick[d];
      const dashes = Array.from({ length: 4 }, (_, j) => s0 + j).filter((s) => L.offset[s] !== 0);
      expect(dashes.length).toBe(2);
      for (const s of dashes) {
        expect(L.offset[s]).toBeCloseTo(AROMATIC_OFFSET);
        expect(L.t0[s]).toBeGreaterThan(0.1);
        expect(L.t1[s]).toBeLessThan(0.9);
      }
    }
    expect(chooseReferenceAtom(mol, 0, 1, true)).toBe(5);
  });

  it('licorice draws every bond as a single bond', () => {
    const mol = benzene(2);
    const L = buildStickLayout(mol, all(mol.atoms.length), 'licorice');
    expect(L.count).toBe(mol.bonds.length * 2);
    for (let s = 0; s < L.count; s++) {
      expect(L.offset[s]).toBe(0);
      expect(L.radius[s]).toBeCloseTo(LICORICE_RADIUS, 6);
    }
  });

  it('only draws bonds whose two atoms are displayed', () => {
    const mol = ethylene();
    const mask = new Uint8Array([1, 1, 0, 0, 1, 0]); // hide three H
    const L = buildStickLayout(mol, mask, 'ball-and-stick');
    expect(L.bonds.length).toBe(2); // C=C and C2–H5
    expect(L.bondToDisplayed[1]).toBe(-1);
  });
});
