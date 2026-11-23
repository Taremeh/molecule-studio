import { describe, expect, it } from 'vitest';
import { buildMolecule, getTopology, type AtomInput, type BondInput } from './molecule';
import type { BondOrder, Molecule } from './types';
import { idealBondLength } from './geometry';
import { createForceField, createMinimizer, forceFieldEnergy, minimize, seededRandom } from './minimize';
import { buildModel, perceiveTyping, restLength, HYB_SP, HYB_SP2, HYB_SP3 } from './ff-model';
import { FFEvaluator } from './ff-energy';
import { moleculeFromSmiles } from './smiles';

// ---------------------------------------------------------------------------
// hand-built test molecules
// ---------------------------------------------------------------------------

function mol(name: string, atoms: [string, number, number, number][], bonds: [number, number, BondOrder?][], source = 'editor'): Molecule {
  const a: AtomInput[] = atoms.map(([element, x, y, z]) => ({ element, x, y, z }));
  const b: BondInput[] = bonds.map(([i, j, o]) => ({ a: i, b: j, order: o ?? 1 }));
  return buildMolecule(name, a, b, { source });
}

function ethane(stretch = 0): Molecule {
  const d = 1.54 + stretch;
  return mol(
    'ethane',
    [
      ['C', 0, 0, 0],
      ['C', d, 0, 0],
      ['H', -0.36, 1.03, 0],
      ['H', -0.36, -0.51, 0.89],
      ['H', -0.36, -0.51, -0.89],
      ['H', d + 0.36, -1.03, 0],
      ['H', d + 0.36, 0.51, 0.89],
      ['H', d + 0.36, 0.51, -0.89],
    ],
    [[0, 1], [0, 2], [0, 3], [0, 4], [1, 5], [1, 6], [1, 7]],
  );
}

function benzene(perturb = 0, seed = 1, aromatic = true): Molecule {
  const rnd = seededRandom(seed);
  const atoms: [string, number, number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const t = (k * Math.PI) / 3;
    atoms.push(['C', 1.39 * Math.cos(t), 1.39 * Math.sin(t), (rnd() - 0.5) * perturb]);
  }
  for (let k = 0; k < 6; k++) {
    const t = (k * Math.PI) / 3;
    atoms.push(['H', 2.47 * Math.cos(t), 2.47 * Math.sin(t), (rnd() - 0.5) * perturb]);
  }
  const bonds: [number, number, BondOrder?][] = [];
  for (let k = 0; k < 6; k++) bonds.push([k, (k + 1) % 6, aromatic ? 1.5 : k % 2 === 0 ? 2 : 1]);
  for (let k = 0; k < 6; k++) bonds.push([k, k + 6]);
  return mol('benzene', atoms, bonds);
}

/** N-methylacetamide + acetonitrile fragment + a clashing water: exercises every term type. */
function mixed(): Molecule {
  return mol(
    'mixed',
    [
      ['C', 0, 0, 0], // 0 carbonyl C
      ['O', 0.6, 1.0, 0.1], // 1
      ['N', 0.75, -1.1, 0], // 2
      ['C', -1.5, 0.05, 0], // 3 methyl C
      ['C', 2.2, -1.1, 0.1], // 4 N-methyl
      ['H', 0.25, -2.0, -0.1], // 5 N-H
      ['H', -1.9, 1.0, 0.3], // 6
      ['H', -1.9, -0.4, -0.9], // 7
      ['H', -1.85, -0.6, 0.8], // 8
      ['H', 2.6, -2.1, 0], // 9
      ['H', 2.6, -0.5, 0.9], // 10
      ['H', 2.5, -0.6, -0.8], // 11
      ['C', 3.0, 1.2, 0.3], // 12 nitrile C (bonded to 4 → propionitrile-like)
      ['N', 3.6, 2.1, 0.5], // 13
      ['O', 1.2, 1.9, 1.2], // 14 water O (clash with carbonyl O)
      ['H', 1.9, 2.4, 0.8], // 15
      ['H', 0.6, 2.6, 1.4], // 16
    ],
    [
      [0, 1, 2], [0, 2], [0, 3], [2, 4], [2, 5], [3, 6], [3, 7], [3, 8], [4, 9], [4, 10], [4, 12], [12, 13, 3],
      [14, 15], [14, 16],
    ],
  );
}

function bondLength(m: Molecule, i: number, j: number): number {
  const a = m.atoms[i], b = m.atoms[j];
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function planeDeviation(m: Molecule, idx: number[]): number {
  // Max distance from the least-squares plane (via the normal of the best-fit through 3 spread atoms).
  const pts = idx.map((i) => [m.atoms[i].x, m.atoms[i].y, m.atoms[i].z]);
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  // covariance + smallest eigenvector by inverse-free power iteration on (trace·I − C)
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) C[r][s] += (p[r] - c[r]) * (p[s] - c[s]);
  const tr = C[0][0] + C[1][1] + C[2][2];
  let v = [0.3, 0.5, 0.8];
  for (let it = 0; it < 200; it++) {
    const w = [0, 1, 2].map((r) => tr * v[r] - (C[r][0] * v[0] + C[r][1] * v[1] + C[r][2] * v[2]));
    const l = Math.hypot(w[0], w[1], w[2]);
    v = w.map((x) => x / l);
  }
  return Math.max(...pts.map((p) => Math.abs((p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1] + (p[2] - c[2]) * v[2])));
}

// ---------------------------------------------------------------------------

describe('force-field typing', () => {
  it('assigns hybridisation from bond orders and resonance', () => {
    const m = mixed();
    const t = perceiveTyping(m);
    expect(t.hyb[0]).toBe(HYB_SP2); // carbonyl C
    expect(t.hyb[2]).toBe(HYB_SP2); // amide N (resonance)
    expect(t.conj[2]).toBe(1);
    expect(t.hyb[3]).toBe(HYB_SP3);
    expect(t.hyb[12]).toBe(HYB_SP); // nitrile C
    expect(t.hyb[14]).toBe(HYB_SP3); // water
  });

  it('perceives Kekulé benzene as aromatic', () => {
    const m = benzene(0, 1, false);
    const t = perceiveTyping(m);
    for (let i = 0; i < 6; i++) expect(t.aromatic[i]).toBe(1);
    // Both Kekulé bond types get the aromatic rest length.
    expect(restLength(m, t, 0, 1, 2)).toBeCloseTo(idealBondLength('C', 'C', 1.5), 6);
    expect(restLength(m, t, 1, 2, 1)).toBeCloseTo(idealBondLength('C', 'C', 1.5), 6);
  });

  it('shortens the amide C–N bond', () => {
    const m = mixed();
    const t = perceiveTyping(m);
    const r = restLength(m, t, 0, 2, 1);
    expect(r).toBeLessThan(idealBondLength('C', 'N', 1));
    expect(r).toBeGreaterThan(idealBondLength('C', 'N', 2));
  });
});

describe('rest lengths vs idealBondLength', () => {
  it('the minimiser relaxes polar bonds to the length the geometry inspector calls ideal', () => {
    // Dimethyl sulfate-like fragment: S(=O)(=O)(OC)(OC) plus a P–F, an S–N, a Si–O and a peroxide.
    const m = mol(
      'polar',
      [
        ['S', 0, 0, 0],
        ['O', 1.4, 0, 0],
        ['O', -1.4, 0, 0],
        ['O', 0, 1.6, 0],
        ['C', 0, 2.6, 1],
        ['P', 3, 3, 0],
        ['F', 4.5, 3, 0],
        ['O', 3, 4.6, 0],
        ['N', 0, -1.6, 0],
        ['Si', 6, 0, 0],
        ['O', 6, 1.6, 0],
        ['O', 6, 3.1, 0],
      ],
      [
        [1, 2, 2],
        [1, 3, 2],
        [1, 4],
        [4, 5],
        [6, 7],
        [6, 8, 2],
        [1, 9],
        [10, 11],
        [11, 12],
      ],
    );
    const t = perceiveTyping(m);
    const pairs: [number, number, BondOrder][] = [
      [0, 1, 2], // S=O
      [0, 3, 1], // S–O
      [5, 6, 1], // P–F
      [5, 7, 2], // P=O
      [0, 8, 1], // S–N
      [9, 10, 1], // Si–O
      [10, 11, 1], // O–O
    ];
    for (const [i, j, o] of pairs) {
      expect(restLength(m, t, i, j, o)).toBeCloseTo(idealBondLength(m.atoms[i].element, m.atoms[j].element, o), 6);
    }
  });
});

describe('force-field gradient', () => {
  it('matches central finite differences for every term type', () => {
    const rnd = seededRandom(42);
    const base = mixed();
    // random distortion so that every term is away from its minimum
    const m: Molecule = { ...base, atoms: base.atoms.map((a) => ({ ...a, x: a.x + (rnd() - 0.5) * 0.3, y: a.y + (rnd() - 0.5) * 0.3, z: a.z + (rnd() - 0.5) * 0.3 })) };
    const ctx = createForceField(m);
    expect(ctx.model.torsionCount).toBeGreaterThan(0);
    expect(ctx.model.improperCount).toBeGreaterThan(0);
    const g = new Float64Array(ctx.x.length);
    const parts = { bond: 0, angle: 0, torsion: 0, improper: 0, nonbonded: 0, total: 0 };
    ctx.evaluator.evaluate(ctx.x, g, parts);
    expect(parts.nonbonded).toBeGreaterThan(0);
    const h = 1e-6;
    const x = ctx.x;
    let maxErr = 0;
    for (let c = 0; c < x.length; c++) {
      const x0 = x[c];
      x[c] = x0 + h;
      const ep = ctx.evaluator.evaluate(x, null);
      x[c] = x0 - h;
      const em = ctx.evaluator.evaluate(x, null);
      x[c] = x0;
      const fd = (ep - em) / (2 * h);
      maxErr = Math.max(maxErr, Math.abs(fd - g[c]) / Math.max(1, Math.abs(g[c])));
    }
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('gradient is correct near linear and planar configurations', () => {
    // A nearly linear sp3 angle and a nearly planar torsion
    const m = mol(
      'linear',
      [
        ['C', 0, 0, 0],
        ['C', 1.5, 0.001, 0],
        ['C', 3.0, 0.0, 0.002],
        ['C', 4.0, 1.0, 0.0001],
        ['O', -1.0, 0.0, 1.0],
      ],
      [[0, 1], [1, 2], [2, 3], [0, 4]],
    );
    const ctx = createForceField(m);
    const g = new Float64Array(ctx.x.length);
    ctx.evaluator.evaluate(ctx.x, g);
    const h = 1e-7;
    for (let c = 0; c < ctx.x.length; c++) {
      const x0 = ctx.x[c];
      ctx.x[c] = x0 + h;
      const ep = ctx.evaluator.evaluate(ctx.x, null);
      ctx.x[c] = x0 - h;
      const em = ctx.evaluator.evaluate(ctx.x, null);
      ctx.x[c] = x0;
      expect(Math.abs((ep - em) / (2 * h) - g[c])).toBeLessThan(1e-3 * Math.max(1, Math.abs(g[c])));
    }
  });
});

describe('minimize', () => {
  it('restores the ideal C–C length of a stretched ethane and lowers the energy', () => {
    const m = ethane(0.6);
    const e0 = forceFieldEnergy(m).total;
    const res = minimize(m, { maxSteps: 500, tolerance: 0.01 });
    expect(res.energy).toBeLessThan(e0);
    expect(res.converged).toBe(true);
    expect(bondLength(res.mol, 0, 1)).toBeCloseTo(idealBondLength('C', 'C', 1), 2);
    for (let h = 2; h < 8; h++) expect(bondLength(res.mol, h < 5 ? 0 : 1, h)).toBeCloseTo(idealBondLength('C', 'H', 1), 2);
    // staggered conformation: H–C–C–H dihedrals at ±60 / 180
    const t = forceFieldEnergy(res.mol).torsion;
    expect(t).toBeLessThan(0.05);
  });

  it('planarises a distorted benzene (aromatic and Kekulé input)', () => {
    for (const aromatic of [true, false]) {
      const m = benzene(0.5, 7, aromatic);
      expect(planeDeviation(m, [...Array(12).keys()])).toBeGreaterThan(0.1);
      const res = minimize(m, { maxSteps: 1000, tolerance: 0.005 });
      expect(planeDeviation(res.mol, [...Array(12).keys()])).toBeLessThan(0.01);
      const ideal = idealBondLength('C', 'C', 1.5);
      for (let k = 0; k < 6; k++) expect(bondLength(res.mol, k, (k + 1) % 6)).toBeCloseTo(ideal, 2);
    }
  });

  it('respects fixed and movable atoms', () => {
    const m = ethane(0.6);
    const res = minimize(m, { fixed: new Set([1, 2]) });
    expect(res.mol.atoms[0]).toBe(m.atoms[0]);
    expect(res.mol.atoms[1]).toBe(m.atoms[1]);
    expect(res.mol.atoms[3]).not.toBe(m.atoms[3]);
    const res2 = minimize(m, { movable: new Set([3]) }); // only one H (id 3) may move
    expect(res2.mol.atoms[0]).toBe(m.atoms[0]);
    expect(res2.mol.atoms[1]).toBe(m.atoms[1]);
    expect(bondLength(res2.mol, 0, 1)).toBeCloseTo(bondLength(m, 0, 1), 9);
    // fixed wins over movable
    const res3 = minimize(m, { movable: new Set([2, 3]), fixed: new Set([2]) }); // ids 2 (C2) and 3 (H)
    expect(res3.mol.atoms[1]).toBe(m.atoms[1]);
    expect(res3.mol.atoms[2]).not.toBe(m.atoms[2]);
  });

  it('keeps ids, bonds and other atom fields', () => {
    const m = ethane(0.3);
    const res = minimize(m);
    expect(res.mol.bonds).toBe(m.bonds);
    expect(res.mol.atoms.map((a) => a.id)).toEqual(m.atoms.map((a) => a.id));
    expect(res.mol).not.toBe(m);
  });

  it('leaves the exact eclipsed saddle of a chain drawn flat', () => {
    const flat = mol('flat-butane', [['C', 0, 0, 0], ['C', 1.53, 0, 0], ['C', 2.04, 1.44, 0], ['C', 3.57, 1.44, 0]], [[0, 1], [1, 2], [2, 3]]);
    const res = minimize(flat, { maxSteps: 2000, tolerance: 0.01 });
    expect(forceFieldEnergy(res.mol).torsion).toBeLessThan(0.05); // gauche or anti, not eclipsed
  });

  it('pops a molecule drawn flat into 3D (no saddle trapping)', () => {
    // neopentane drawn in a plane
    const m = mol(
      'flat',
      [
        ['C', 0, 0, 0],
        ['C', 1.5, 0, 0],
        ['C', -1.5, 0, 0],
        ['C', 0, 1.5, 0],
        ['C', 0, -1.5, 0],
      ],
      [[0, 1], [0, 2], [0, 3], [0, 4]],
    );
    const res = minimize(m, { maxSteps: 2000, tolerance: 0.01 });
    const topo = getTopology(res.mol);
    const p = (i: number) => res.mol.atoms[i];
    for (const a of [1, 2, 3])
      for (const b of [2, 3, 4]) {
        if (a >= b) continue;
        const u = [p(a).x - p(0).x, p(a).y - p(0).y, p(a).z - p(0).z];
        const v = [p(b).x - p(0).x, p(b).y - p(0).y, p(b).z - p(0).z];
        const ang = (Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v))) * 180) / Math.PI;
        expect(ang).toBeGreaterThan(105);
        expect(ang).toBeLessThan(114);
      }
    expect(topo.neighbors[0].length).toBe(4);
  });

  it('does not blow up on a hydrogen-free protein-like fragment and keeps its planar groups', () => {
    // Gly–Phe-like fragment without hydrogens or bond orders (as read from a PDB file).
    const ring: [string, number, number, number][] = [];
    for (let k = 0; k < 6; k++) {
      const t = (k * Math.PI) / 3;
      ring.push(['C', 4 + 1.39 * Math.cos(t), 1.39 * Math.sin(t), 0]);
    }
    const m = mol(
      'pdb-like',
      [
        ['N', -1.2, 0.5, 0.1], // 0
        ['C', 0, 0, 0], // 1 CA
        ['C', 1.2, 0.9, 0], // 2 C
        ['O', 1.1, 2.1, 0.05], // 3 O
        ['N', 2.4, 0.3, 0], // 4 N (next residue)
        ['C', 1.39 + 0.0, -1.2, 0.0], // 5 CB (bonded to ring atom 6 → index 9 below)
        ...ring, // 6..11
      ],
      [[0, 1], [1, 2], [2, 3], [2, 4], [1, 5], [5, 9], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 6]],
      'pdb',
    );
    const e0 = forceFieldEnergy(m).total;
    const res = minimize(m, { maxSteps: 1000 });
    expect(Number.isFinite(res.energy)).toBe(true);
    expect(res.energy).toBeLessThanOrEqual(e0 + 1e-9);
    // ring stays planar and keeps aromatic-like bond lengths
    expect(planeDeviation(res.mol, [6, 7, 8, 9, 10, 11])).toBeLessThan(0.05);
    for (let k = 0; k < 6; k++) expect(bondLength(res.mol, 6 + k, 6 + ((k + 1) % 6))).toBeGreaterThan(1.3);
    for (let k = 0; k < 6; k++) expect(bondLength(res.mol, 6 + k, 6 + ((k + 1) % 6))).toBeLessThan(1.45);
    // peptide C–N keeps its partial double-bond length, C=O stays short
    expect(bondLength(res.mol, 2, 4)).toBeLessThan(1.42);
    expect(bondLength(res.mol, 2, 3)).toBeLessThan(1.3);
  });

  it('tethers experimental structures (default) but not editor / SMILES molecules', () => {
    // n-butane in an eclipsed conformation: unrestrained it rotates far towards anti / gauche
    const atoms: [string, number, number, number][] = [
      ['C', 0, 0, 0], ['C', 1.53, 0, 0], ['C', 2.04, 1.44, 0], ['C', 3.5, 1.44, 0.3],
    ];
    const pdb = mol('butane', atoms, [[0, 1], [1, 2], [2, 3]], 'pdb');
    const free = minimize(pdb, { restraint: 0, maxSteps: 2000 });
    const tethered = minimize(pdb);
    const disp = (m: Molecule) => Math.max(...m.atoms.map((a, i) => Math.hypot(a.x - pdb.atoms[i].x, a.y - pdb.atoms[i].y, a.z - pdb.atoms[i].z)));
    expect(disp(tethered.mol)).toBeLessThan(disp(free.mol));
    expect(disp(tethered.mol)).toBeLessThan(0.5);
    // the tether is not part of the reported energy
    expect(tethered.energy).toBeCloseTo(forceFieldEnergy(tethered.mol, { inferFromGeometry: true }).total, 3);
  });

  it('handles empty, single-atom and metal-containing molecules', () => {
    expect(minimize(mol('empty', [], [])).steps).toBe(0);
    const one = minimize(mol('one', [['Na', 0, 0, 0]], []));
    expect(one.converged).toBe(true);
    // metal centre with ligands: no angle terms on Fe, must stay finite and keep ligands apart
    const fe = mol(
      'fe',
      [
        ['Fe', 0, 0, 0],
        ['N', 2, 0, 0],
        ['N', -2, 0, 0],
        ['N', 0, 2, 0],
        ['N', 0, -2, 0.1],
      ],
      [[0, 1], [0, 2], [0, 3], [0, 4]],
    );
    const r = minimize(fe, { maxSteps: 300 });
    expect(Number.isFinite(r.energy)).toBe(true);
    for (let a = 1; a < 5; a++) for (let b = a + 1; b < 5; b++) expect(bondLength(r.mol, a, b)).toBeGreaterThan(1.5);
  });
});

describe('regional typing (local relaxation in big structures)', () => {
  it('gives exactly the same energy and gradient as typing the whole molecule', () => {
    const m = moleculeFromSmiles('C'.repeat(30) + 'c1ccc(cc1)C(=O)NC' + 'C'.repeat(20));
    const topo = getTopology(m);
    const amideN = m.atoms.findIndex((a, i) => a.element === 'N');
    const movable = new Set([m.atoms[amideN].id, ...topo.neighbors[amideN].map((j) => m.atoms[j].id)]);
    const ctx = createForceField(m, { movable });
    expect(ctx.activeAtoms.length * 20).toBeLessThan(m.atoms.length); // region path taken
    const full = buildModel(m, perceiveTyping(m, { inferFromGeometry: false }), ctx.model.active.slice());
    const ev = new FFEvaluator(full);
    const g1 = new Float64Array(ctx.x.length), g2 = new Float64Array(ctx.x.length);
    const e1 = ctx.evaluator.evaluate(ctx.x, g1);
    const e2 = ev.evaluate(ctx.x, g2);
    expect(e1).toBeCloseTo(e2, 10);
    for (let c = 0; c < g1.length; c++) expect(g1[c]).toBeCloseTo(g2[c], 10);
    expect(ctx.model.torsionCount).toBe(full.torsionCount);
    expect(ctx.model.angleCount).toBe(full.angleCount);
  });
});

describe('createMinimizer', () => {
  it('relaxes neighbours around a dragged atom, cheaply', () => {
    const m = ethane(0);
    const min = createMinimizer(m, { movable: new Set([1, 3, 4, 5]) });
    // drag atom 2 (C2) away along +x by 0.8 Å
    min.setFixedPosition(2, [1.54 + 0.8, 0, 0]);
    const e1 = min.step(1);
    const e = min.step(50);
    expect(e).toBeLessThanOrEqual(e1);
    const pos = min.positions();
    expect(pos.get(2)).toEqual([2.34, 0, 0]);
    expect(pos.has(1)).toBe(true);
    expect(pos.has(6)).toBe(false); // H on C2 was not movable
    const c1 = pos.get(1)!;
    // C1 followed the pulled C2 (bond restored towards ideal)
    expect(c1[0]).toBeGreaterThan(0.3);
  });

  it('runs a step on ~200 atoms in a few ms', () => {
    // 10 benzene rings in a row (each 12 atoms) + 4 copies → ~240 atoms
    const atoms: [string, number, number, number][] = [];
    const bonds: [number, number, BondOrder?][] = [];
    for (let r = 0; r < 20; r++) {
      const off = atoms.length;
      const b = benzene(0.2, r + 1);
      for (const a of b.atoms) atoms.push([a.element, a.x + (r % 5) * 6, a.y + Math.floor(r / 5) * 6, a.z]);
      for (const bd of b.bonds) bonds.push([bd.a - 1 + off, bd.b - 1 + off, bd.order]);
    }
    const m = mol('many', atoms, bonds);
    expect(m.atoms.length).toBe(240);
    const min = createMinimizer(m);
    min.step(5); // warm-up (JIT, neighbour list)
    const t0 = performance.now();
    min.setFixedPosition(1, [m.atoms[0].x + 0.3, m.atoms[0].y, m.atoms[0].z]);
    min.step(20);
    const perStep = (performance.now() - t0) / 20;
    expect(perStep).toBeLessThan(5);
  });
});
