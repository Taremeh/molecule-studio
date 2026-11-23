import { describe, expect, it } from 'vitest';
import { SAMPLES, SAMPLE_CATEGORIES, formatAtomCount, searchSamples, type SampleEntry } from './samples';
import { parseMolecule } from './formats';
import { PDB_ID_PATTERN } from './fetch';
import { getTopology } from '../core/molecule';
import type { Atom, Molecule } from '../core/types';

const embeddedSamples = SAMPLES.filter((s) => s.source.kind === 'embedded');
const load = (id: string): Molecule => {
  const s = SAMPLES.find((x) => x.id === id)!;
  if (s.source.kind !== 'embedded') throw new Error('not embedded');
  return parseMolecule(s.source.text, s.source.format, s.name);
};

const dist = (a: Atom, b: Atom) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function angle(a: Atom, b: Atom, c: Atom): number {
  const u = [a.x - b.x, a.y - b.y, a.z - b.z];
  const v = [c.x - b.x, c.y - b.y, c.z - b.z];
  const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}
function dihedral(a: Atom, b: Atom, c: Atom, d: Atom): number {
  const sub = (p: Atom, q: Atom) => [p.x - q.x, p.y - q.y, p.z - q.z];
  const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const b1 = sub(b, a), b2 = sub(c, b), b3 = sub(d, c);
  const n1 = cross(b1, b2), n2 = cross(b2, b3);
  const m1 = cross(n1, b2.map((x) => x / Math.hypot(...b2)));
  return (Math.atan2(dot(m1, n2), dot(n1, n2)) * 180) / Math.PI;
}
const formula = (m: Molecule) => {
  const c: Record<string, number> = {};
  for (const a of m.atoms) c[a.element] = (c[a.element] ?? 0) + 1;
  return c;
};
/** Bonded neighbours (atom objects) of atom index i. */
const neighbours = (m: Molecule, i: number) => getTopology(m).neighbors[i].map((j) => m.atoms[j]);
const bondTo = (m: Molecule, a: Atom, b: Atom) => m.bonds.find((x) => (x.a === a.id && x.b === b.id) || (x.a === b.id && x.b === a.id));

describe('sample gallery', () => {
  it('has unique ids, valid categories and complete entries', () => {
    const ids = new Set(SAMPLES.map((s) => s.id));
    expect(ids.size).toBe(SAMPLES.length);
    expect(SAMPLES.length).toBeGreaterThanOrEqual(16);
    const cats = new Set(SAMPLE_CATEGORIES.map((c) => c.id));
    for (const s of SAMPLES) {
      expect(cats.has(s.category)).toBe(true);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(10);
      expect(s.approxAtoms).toBeGreaterThan(0);
      if (s.source.kind === 'pdb') expect(s.source.id).toMatch(PDB_ID_PATTERN);
      if (s.source.kind === 'pubchem') expect(s.source.query.trim().length).toBeGreaterThan(0);
    }
    for (const c of SAMPLE_CATEGORIES) expect(SAMPLES.some((s) => s.category === c.id)).toBe(true);
  });

  it('includes the required offline molecules', () => {
    for (const id of ['water', 'methane', 'ammonia', 'ethanol', 'benzene', 'acetic-acid']) {
      expect(embeddedSamples.some((s) => s.id === id)).toBe(true);
    }
  });

  it('searches names, tags and PDB ids', () => {
    expect(searchSamples('1hsg').map((s) => s.id)).toEqual(['1hsg']);
    expect(searchSamples('neurotransmitter').map((s) => s.id).sort()).toEqual(['dopamine', 'serotonin']);
    expect(searchSamples('').length).toBe(SAMPLES.length);
    expect(searchSamples('offline drug')).toEqual([]);
  });

  it('formats atom counts', () => {
    expect(formatAtomCount(3)).toBe('3 atoms');
    expect(formatAtomCount(1)).toBe('1 atom');
    expect(formatAtomCount(1686)).toBe('~1.7k atoms');
    expect(formatAtomCount(23_456)).toBe('~23k atoms');
  });
});

describe('embedded samples', () => {
  it.each(embeddedSamples.map((s) => [s.id, s] as [string, SampleEntry]))('%s parses with the advertised atom count', (_id, s) => {
    if (s.source.kind !== 'embedded') return;
    const m = parseMolecule(s.source.text, s.source.format, s.name);
    expect(m.atoms).toHaveLength(s.approxAtoms!);
    expect(m.name).toBe(s.name);
    expect(m.meta.hasBondOrders).toBe(true);
  });

  it('have complete valences (explicit hydrogens, correct bond orders)', () => {
    const valence: Record<string, number> = { H: 1, C: 4, N: 3, O: 2 };
    for (const s of embeddedSamples) {
      if (s.id === 'nacl') continue;
      const m = load(s.id);
      const topo = getTopology(m);
      m.atoms.forEach((a, i) => {
        const sum = topo.atomBonds[i].reduce((acc, bi) => acc + m.bonds[bi].order, 0);
        expect(a.charge, `${s.id} atom ${i + 1} charge`).toBeUndefined();
        expect(sum, `${s.id} atom ${i + 1} (${a.element})`).toBe(valence[a.element]);
      });
    }
  });

  it('have the right formulas', () => {
    expect(formula(load('water'))).toEqual({ O: 1, H: 2 });
    expect(formula(load('methane'))).toEqual({ C: 1, H: 4 });
    expect(formula(load('ammonia'))).toEqual({ N: 1, H: 3 });
    expect(formula(load('ethanol'))).toEqual({ C: 2, O: 1, H: 6 });
    expect(formula(load('benzene'))).toEqual({ C: 6, H: 6 });
    expect(formula(load('acetic-acid'))).toEqual({ C: 2, O: 2, H: 4 });
    expect(formula(load('c60'))).toEqual({ C: 60 });
    expect(formula(load('nacl'))).toEqual({ Na: 32, Cl: 32 });
  });

  it('water: r(OH) 0.9572 Å, HOH 104.52°', () => {
    const [o, h1, h2] = load('water').atoms;
    expect(dist(o, h1)).toBeCloseTo(0.9572, 3);
    expect(dist(o, h2)).toBeCloseTo(0.9572, 3);
    expect(angle(h1, o, h2)).toBeCloseTo(104.52, 1);
  });

  it('methane: r(CH) 1.087 Å, tetrahedral angles', () => {
    const [c, ...hs] = load('methane').atoms;
    for (const h of hs) expect(dist(c, h)).toBeCloseTo(1.087, 3);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(angle(hs[i], c, hs[j])).toBeCloseTo(109.47, 1);
  });

  it('ammonia: r(NH) 1.012 Å, HNH 106.67°', () => {
    const [n, ...hs] = load('ammonia').atoms;
    for (const h of hs) expect(dist(n, h)).toBeCloseTo(1.012, 3);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(angle(hs[i], n, hs[j])).toBeCloseTo(106.67, 1);
  });

  it('ethanol: ideal bond lengths, sp3 angles, anti O–H', () => {
    const m = load('ethanol');
    const [c1, c2, o, ho] = m.atoms;
    expect(dist(c1, c2)).toBeCloseTo(1.512, 3);
    expect(dist(c2, o)).toBeCloseTo(1.431, 3);
    expect(dist(o, ho)).toBeCloseTo(0.971, 3);
    expect(angle(c1, c2, o)).toBeCloseTo(107.8, 1);
    expect(angle(c2, o, ho)).toBeCloseTo(108.5, 1);
    expect(Math.abs(dihedral(c1, c2, o, ho))).toBeCloseTo(180, 1);
    // Every angle around the two sp3 carbons is close to tetrahedral; C–H bonds 1.09–1.10 Å.
    for (const ci of [0, 1]) {
      const c = m.atoms[ci];
      const nb = neighbours(m, ci);
      expect(nb).toHaveLength(4);
      for (let i = 0; i < 4; i++) {
        if (nb[i].element === 'H') expect(dist(c, nb[i])).toBeGreaterThan(1.09);
        if (nb[i].element === 'H') expect(dist(c, nb[i])).toBeLessThan(1.1);
        for (let j = i + 1; j < 4; j++) {
          const ang = angle(nb[i], c, nb[j]);
          expect(ang).toBeGreaterThan(106);
          expect(ang).toBeLessThan(112.5);
        }
      }
    }
    // Staggered methyl: H–C1–C2–O dihedrals are 180 and ±60.
    const methylH = neighbours(m, 0).filter((a) => a.element === 'H');
    const dihs = methylH.map((h) => Math.round(dihedral(h, c1, c2, o))).map((d) => Math.abs(d)).sort((a, b) => a - b);
    expect(dihs).toEqual([60, 60, 180]);
  });

  it('benzene: planar D6h ring, r(CC) 1.397 Å, r(CH) 1.084 Å, alternating Kekulé bonds', () => {
    const m = load('benzene');
    const cs = m.atoms.slice(0, 6);
    const hs = m.atoms.slice(6);
    for (const a of m.atoms) expect(Math.abs(a.z)).toBeLessThan(1e-4);
    for (let k = 0; k < 6; k++) {
      expect(dist(cs[k], cs[(k + 1) % 6])).toBeCloseTo(1.397, 3);
      expect(dist(cs[k], hs[k])).toBeCloseTo(1.084, 3);
      expect(angle(cs[(k + 5) % 6], cs[k], cs[(k + 1) % 6])).toBeCloseTo(120, 2);
      expect(angle(cs[(k + 1) % 6], cs[k], hs[k])).toBeCloseTo(120, 2);
    }
    const ringOrders = m.bonds.filter((b) => b.a <= 6 && b.b <= 6).map((b) => b.order);
    expect(ringOrders.filter((o) => o === 2)).toHaveLength(3);
  });

  it('acetic acid: planar syn carboxyl with gas-phase geometry', () => {
    const m = load('acetic-acid');
    const [c1, c2, o1, o2, ho] = m.atoms;
    expect(dist(c1, c2)).toBeCloseTo(1.52, 3);
    expect(dist(c2, o1)).toBeCloseTo(1.214, 3);
    expect(bondTo(m, c2, o1)!.order).toBe(2);
    expect(dist(c2, o2)).toBeCloseTo(1.364, 3);
    expect(dist(o2, ho)).toBeCloseTo(0.97, 3);
    expect(angle(c1, c2, o1)).toBeCloseTo(126.6, 1);
    expect(angle(c1, c2, o2)).toBeCloseTo(110.6, 1);
    expect(angle(o1, c2, o2)).toBeCloseTo(122.8, 1);
    expect(angle(c2, o2, ho)).toBeCloseTo(106.9, 1);
    expect(Math.abs(dihedral(o1, c2, o2, ho))).toBeLessThan(0.1); // syn
    for (const a of [c1, c2, o1, o2, ho]) expect(Math.abs(a.z)).toBeLessThan(1e-4);
    for (const h of neighbours(m, 0).filter((a) => a.element === 'H')) {
      expect(dist(c1, h)).toBeCloseTo(1.09, 3);
      expect(angle(h, c1, c2)).toBeCloseTo(109.5, 1);
    }
  });

  it('C60: icosahedral cage with 30 double (1.401 Å) and 60 single (1.458 Å) bonds', () => {
    const m = load('c60');
    expect(m.bonds).toHaveLength(90);
    const topo = getTopology(m);
    m.atoms.forEach((_, i) => {
      const bs = topo.atomBonds[i].map((bi) => m.bonds[bi]);
      expect(bs).toHaveLength(3);
      expect(bs.filter((b) => b.order === 2)).toHaveLength(1);
    });
    for (const b of m.bonds) {
      const d = dist(m.atoms[b.a - 1], m.atoms[b.b - 1]);
      expect(d).toBeCloseTo(b.order === 2 ? 1.401 : 1.458, 3);
    }
    const r = m.atoms.map((a) => Math.hypot(a.x, a.y, a.z));
    for (const x of r) expect(x).toBeCloseTo(3.55, 1);
    expect(Math.max(...r) - Math.min(...r)).toBeLessThan(1e-3);
  });

  it('rock salt: neutral 4×4×4 lattice with Na–Cl = 2.820 Å and no bonds', () => {
    const m = load('nacl');
    expect(m.bonds).toHaveLength(0);
    expect(m.atoms.reduce((s, a) => s + (a.charge ?? 0), 0)).toBe(0);
    for (const a of m.atoms) expect(a.charge).toBe(a.element === 'Na' ? 1 : -1);
    let minNaCl = Infinity;
    let minSame = Infinity;
    for (let i = 0; i < m.atoms.length; i++) {
      for (let j = i + 1; j < m.atoms.length; j++) {
        const d = dist(m.atoms[i], m.atoms[j]);
        if (m.atoms[i].element === m.atoms[j].element) minSame = Math.min(minSame, d);
        else minNaCl = Math.min(minNaCl, d);
      }
    }
    expect(minNaCl).toBeCloseTo(2.8201, 3);
    expect(minSame).toBeCloseTo(2.8201 * Math.SQRT2, 3);
  });
});
