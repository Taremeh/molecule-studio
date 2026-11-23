import { describe, expect, it } from 'vitest';
import { embed3D, moleculeFromSmiles, parseSmiles, parseSmilesDetailed } from './smiles';
import { getTopology } from './molecule';
import type { Molecule, Vec3 } from './types';
import { idealBondLength } from './geometry';
import { perceiveTyping, restLength } from './ff-model';
import { findSSSR } from './ff-rings';
import { maximumMatching } from './smiles-kekule';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formula(mol: Molecule): string {
  const counts = new Map<string, number>();
  for (const a of mol.atoms) counts.set(a.element, (counts.get(a.element) ?? 0) + 1);
  const keys = [...counts.keys()].sort();
  const order = counts.has('C') ? ['C', 'H', ...keys.filter((k) => k !== 'C' && k !== 'H')] : keys;
  return order.filter((k) => counts.has(k)).map((k) => k + (counts.get(k)! > 1 ? counts.get(k) : '')).join('');
}

function netCharge(mol: Molecule): number {
  return mol.atoms.reduce((s, a) => s + (a.charge ?? 0), 0);
}

function orders(mol: Molecule): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of mol.bonds) out[String(b.order)] = (out[String(b.order)] ?? 0) + 1;
  return out;
}

const P = (m: Molecule, i: number): Vec3 => [m.atoms[i].x, m.atoms[i].y, m.atoms[i].z];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function dihedral(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const sub = (x: Vec3, y: Vec3): Vec3 => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const cross = (x: Vec3, y: Vec3): Vec3 => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const dot = (x: Vec3, y: Vec3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const b1 = sub(c, b);
  const n1 = cross(sub(b, a), b1);
  const n2 = cross(b1, sub(d, c));
  const m = cross(n1, b1);
  return (Math.atan2(dot(m, n2) / Math.hypot(...b1), dot(n1, n2)) * 180) / Math.PI;
}

/** Max distance of the given atoms from their least-squares plane. */
function planeDeviation(m: Molecule, idx: number[]): number {
  const pts = idx.map((i) => P(m, i));
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) C[r][s] += (p[r] - c[r]) * (p[s] - c[s]);
  const tr = C[0][0] + C[1][1] + C[2][2];
  let v = [0.31, 0.52, 0.79];
  for (let it = 0; it < 300; it++) {
    const w = [0, 1, 2].map((r) => tr * v[r] - (C[r][0] * v[0] + C[r][1] * v[1] + C[r][2] * v[2]));
    const l = Math.hypot(w[0], w[1], w[2]);
    v = w.map((x) => x / l);
  }
  return Math.max(...pts.map((p) => Math.abs((p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1] + (p[2] - c[2]) * v[2])));
}

/** CIP label of a centre given its substituents in decreasing priority (a > b > c > d). */
function cip(m: Molecule, centre: number, a: number, b: number, c: number): 'R' | 'S' {
  // Looking with the lowest priority (d) away: a→b→c clockwise = R  ⇔  (a−x)·((b−x)×(c−x)) < 0
  const x = P(m, centre);
  const u = P(m, a).map((v, k) => v - x[k]);
  const v = P(m, b).map((w, k) => w - x[k]);
  const w = P(m, c).map((z, k) => z - x[k]);
  const t = u[0] * (v[1] * w[2] - v[2] * w[1]) + u[1] * (v[2] * w[0] - v[0] * w[2]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  return t < 0 ? 'R' : 'S';
}

function heavyNeighbour(m: Molecule, i: number, el: string, exclude: number[] = []): number {
  const topo = getTopology(m);
  return topo.neighbors[i].find((j) => m.atoms[j].element === el && !exclude.includes(j)) ?? -1;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

describe('parseSmiles: atoms, bonds and implicit hydrogens', () => {
  const cases: [string, string, number?][] = [
    ['c1ccccc1', 'C6H6'],
    ['C1=CC=CC=C1', 'C6H6'],
    ['Cn1cnc2c1c(=O)n(C)c(=O)n2C', 'C8H10N4O2'], // caffeine
    ['CC(=O)O', 'C2H4O2'], // acetic acid
    ['[NH4+]', 'H4N', 1],
    ['c1ccc2ccccc2c1', 'C10H8'], // naphthalene
    ['C1CC1', 'C3H6'],
    ['CCO', 'C2H6O'],
    ['c1cc[nH]c1', 'C4H5N'], // pyrrole
    ['c1ccnc1', 'C4H5N'], // pyrrole without [nH]: protonated automatically
    ['c1ccncc1', 'C5H5N'], // pyridine
    ['c1ccoc1', 'C4H4O'], // furan
    ['c1ccsc1', 'C4H4S'], // thiophene
    ['Cn1ccnc1', 'C4H6N2'], // N-methylimidazole
    ['O=c1cc[nH]cc1', 'C5H5NO'], // 4-pyridone
    ['c1ccc2c(c1)[nH]c1ccccc12', 'C12H9N'], // carbazole
    ['[cH-]1cccc1', 'C5H5', -1], // cyclopentadienide
    ['C[n+]1ccccc1', 'C6H8N', 1], // N-methylpyridinium
    ['c1ccccc1[N+](=O)[O-]', 'C6H5NO2', 0], // nitrobenzene
    ['OS(=O)(=O)O', 'H2O4S'],
    ['OP(=O)(O)O', 'H3O4P'],
    ['ClC(Cl)Cl', 'CHCl3'],
    ['B(O)(O)O', 'BH3O3'],
    ['N#N', 'N2'],
    ['[H][H]', 'H2'],
    ['[2H]C([2H])([2H])[2H]', 'CH4'], // isotopes parsed, element kept
    ['[13CH4]', 'CH4'],
    ['[Fe+2]', 'Fe', 2],
    ['[Cu++]', 'Cu', 2],
    ['[O-]C(=O)C', 'C2H3O2', -1],
    ['C%10CC%10', 'C3H6'],
    ['C1CCC2(CC1)CCCC2', 'C10H18'], // spiro
    ['[Na+].[Cl-]', 'ClNa', 0],
    ['CC(=O)Oc1ccccc1C(=O)O', 'C9H8O4'], // aspirin
    ['OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O', 'C6H12O6'], // glucose
  ];
  for (const [smi, f, q] of cases) {
    it(`${smi} → ${f}`, () => {
      const { mol } = parseSmiles(smi);
      expect(formula(mol)).toBe(f);
      if (q !== undefined) expect(netCharge(mol)).toBe(q);
    });
  }

  it('benzene has six aromatic (1.5) bonds and explicit hydrogens', () => {
    const { mol } = parseSmiles('c1ccccc1');
    expect(mol.atoms.length).toBe(12);
    expect(orders(mol)).toEqual({ '1.5': 6, '1': 6 });
    expect(mol.meta.source).toBe('smiles');
    expect(mol.meta.hasBondOrders).toBe(true);
    for (const a of mol.atoms) expect([a.x, a.y, a.z]).toEqual([0, 0, 0]);
  });

  it('naphthalene has 11 aromatic bonds', () => {
    expect(orders(parseSmiles('c1ccc2ccccc2c1').mol)['1.5']).toBe(11);
  });

  it('ring-closure bonds carry their order', () => {
    expect(orders(parseSmiles('C1=CC=CC=C1').mol)).toEqual({ '2': 3, '1': 9 });
    expect(orders(parseSmiles('C=1CCCCC1').mol)['2']).toBe(1);
    expect(orders(parseSmiles('C1CCCCC=1').mol)['2']).toBe(1);
    expect(orders(parseSmiles('C#1CCCCCCC1').mol)['3']).toBe(1);
  });

  it('pyrrole-type atoms are single-bonded, π atoms aromatic', () => {
    const { mol } = parseSmiles('c1cc[nH]c1');
    // N–C bonds single, the other three ring bonds aromatic
    expect(orders(mol)['1.5']).toBe(3);
    const caf = parseSmiles('Cn1cnc2c1c(=O)n(C)c(=O)n2C').mol;
    expect(orders(caf)['2']).toBe(2); // the two C=O
  });

  it('biphenyl inter-ring bond is single even without an explicit "-"', () => {
    const { mol } = parseSmiles('c1ccccc1c1ccccc1');
    expect(orders(mol)['1.5']).toBe(12);
  });

  it('reads charges, H counts and names', () => {
    const { mol } = parseSmiles('[NH4+]');
    expect(mol.atoms[0].charge).toBe(1);
    expect(mol.atoms.filter((a) => a.element === 'H').length).toBe(4);
    expect(parseSmiles('[O-]').mol.atoms[0].charge).toBe(-1);
    expect(parseSmiles('[Fe+3]').mol.atoms[0].charge).toBe(3);
    expect(parseSmiles('[Cl---]').mol.atoms[0].charge).toBe(-3);
    expect(parseSmiles('CCO', 'ethanol').mol.name).toBe('ethanol');
    expect(parseSmiles('CCO ethanol').mol.name).toBe('ethanol');
    expect(parseSmiles('CCO').mol.name).toBe('CCO');
    const names = parseSmiles('CCO').mol.atoms.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('records tetrahedral and double-bond stereo', () => {
    const d = parseSmilesDetailed('N[C@@H](C)C(=O)O');
    expect(d.stereo.centres).toHaveLength(1);
    expect(d.stereo.centres[0].sign).toBe(1);
    const e = parseSmilesDetailed('F/C=C/F');
    expect(e.stereo.doubleBonds).toEqual([{ a: 1, b: 2, x: 0, y: 3, cis: false }]);
    expect(parseSmilesDetailed('F/C=C\\F').stereo.doubleBonds[0].cis).toBe(true);
    expect(parseSmilesDetailed('C(\\F)=C/F').stereo.doubleBonds[0].cis).toBe(false);
  });
});

describe('parseSmiles: errors', () => {
  const bad: [string, RegExp][] = [
    ['', /empty/],
    ['C1CC', /ring bond 1 is never closed/],
    ['C[Xy]', /unknown element 'Xy'/],
    ['C[NH4+', /unterminated bracket/],
    ['C(C', /unclosed branch/],
    ['CC)C', /unmatched '\)'/],
    ['C==C', /two bond symbols/],
    ['=C', /no atom before/],
    ['CC=', /end of the SMILES/],
    ['c1cccc1', /Kekulé/],
    ['C1C1', /duplicate bond/],
    ['C()C', /empty branch/],
    ['CQ', /unexpected character 'Q'/],
    ['C[]', /empty bracket/],
    ['C1CC=1C#1', /./],
    ['C.', /'\.' must be followed/],
    ['NaCl', /\[Na\]/],
  ];
  for (const [smi, re] of bad) {
    it(`rejects ${JSON.stringify(smi)}`, () => {
      expect(() => parseSmiles(smi)).toThrow(re);
    });
  }
  it('reports the position', () => {
    expect(() => parseSmiles('CC(C)C)C')).toThrow(/position 7/);
    expect(() => moleculeFromSmiles('C1CC')).toThrow(/position 2/);
  });
});

describe('blossom matching', () => {
  it('finds a perfect matching on an odd-cycle graph (fused 5+6 ring)', () => {
    // indole π atoms (without N): 8 carbons, 5-ring + 6-ring sharing an edge
    const adj = [[1, 5], [0, 2], [1, 3], [2, 4, 8], [3, 5, 6], [0, 4], [4, 7], [6, 8], [3, 7]];
    const m = maximumMatching(9, adj);
    expect([...m].filter((x) => x === -1).length).toBe(1); // 9 vertices: one must stay unmatched
    const adj2 = [[1, 4], [0, 2], [1, 3], [2, 4], [3, 0, 5], [4]];
    expect([...maximumMatching(6, adj2)].every((x) => x >= 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3D embedding
// ---------------------------------------------------------------------------

function checkGeometry(mol: Molecule) {
  const topo = getTopology(mol);
  const t = perceiveTyping(mol);
  let maxDev = 0;
  let maxIdealDev = 0;
  for (const b of mol.bonds) {
    const i = topo.idToIndex.get(b.a)!;
    const j = topo.idToIndex.get(b.b)!;
    const d = dist(P(mol, i), P(mol, j));
    maxDev = Math.max(maxDev, Math.abs(d - restLength(mol, t, i, j, b.order)));
    // Kekulé input: bonds of perceived aromatic rings are compared with the aromatic length
    const n0 = mol.atoms.length;
    const effOrder = t.aromaticBonds.has(i < j ? i * n0 + j : j * n0 + i) ? 1.5 : b.order;
    maxIdealDev = Math.max(maxIdealDev, Math.abs(d - idealBondLength(mol.atoms[i].element, mol.atoms[j].element, effOrder)));
  }
  // aromatic rings (all bonds 1.5)
  let maxPlane = 0;
  for (const ring of findSSSR(topo.neighbors)) {
    const aromatic = ring.every((a, k) => {
      const b = ring[(k + 1) % ring.length];
      const bi = topo.atomBonds[a].find((x) => topo.idToIndex.get(mol.bonds[x].a) === b || topo.idToIndex.get(mol.bonds[x].b) === b);
      return bi !== undefined && mol.bonds[bi].order === 1.5;
    });
    if (aromatic) maxPlane = Math.max(maxPlane, planeDeviation(mol, ring));
  }
  // closest non-bonded heavy-atom pair (not 1–2 or 1–3)
  let minNb = Infinity;
  const n = mol.atoms.length;
  for (let i = 0; i < n; i++) {
    if (mol.atoms[i].element === 'H') continue;
    const near = new Set<number>([i]);
    for (const j of topo.neighbors[i]) {
      near.add(j);
      for (const k of topo.neighbors[j]) near.add(k);
    }
    for (let j = i + 1; j < n; j++) {
      if (mol.atoms[j].element === 'H' || near.has(j)) continue;
      minNb = Math.min(minNb, dist(P(mol, i), P(mol, j)));
    }
  }
  return { maxDev, maxIdealDev, maxPlane, minNb };
}

describe('moleculeFromSmiles: 3D embedding quality', () => {
  const drugs: Record<string, string> = {
    benzene: 'c1ccccc1',
    aspirin: 'CC(=O)Oc1ccccc1C(=O)O',
    ibuprofen: 'CC(C)Cc1ccc(cc1)[C@@H](C)C(=O)O',
    paracetamol: 'CC(=O)Nc1ccc(O)cc1',
    caffeine: 'Cn1cnc2c1c(=O)n(C)c(=O)n2C',
    dopamine: 'NCCc1ccc(O)c(O)c1',
    glucose: 'OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O',
    serotonin: 'NCCc1c[nH]c2ccc(O)cc12',
    nicotine: 'CN1CCC[C@H]1c1cccnc1',
    penicillinG: 'CC1([C@@H](N2[C@H](S1)[C@@H](C2=O)NC(=O)Cc3ccccc3)C(=O)O)C',
    morphine: 'CN1CC[C@]23[C@@H]4[C@H]1CC5=C2C(=C(C=C5)O)O[C@H]3[C@H](C=C4)O',
    cholesterol: 'C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C',
    adamantane: 'C1C2CC3CC1CC(C2)C3',
    cubane: 'C12C3C4C1C5C2C3C45',
  };
  for (const [name, smi] of Object.entries(drugs)) {
    it(`${name}: ideal bonds, planar aromatics, no clashes, stereo kept, < 1 s`, () => {
      const t0 = performance.now();
      const mol = moleculeFromSmiles(smi, name);
      const dt = performance.now() - t0;
      expect(dt).toBeLessThan(1000);
      expect(mol.name).toBe(name);
      expect(mol.meta.source).toBe('smiles');
      expect(mol.meta.hasBondOrders).toBe(true);
      const g = checkGeometry(mol);
      expect(g.maxDev).toBeLessThan(0.08); // vs. the force field's ideal (incl. conjugation)
      expect(g.maxIdealDev).toBeLessThan(0.12); // vs. plain idealBondLength
      expect(g.maxPlane).toBeLessThan(0.05);
      expect(g.minNb).toBeGreaterThan(2.0);
      const det = parseSmilesDetailed(smi);
      for (const c of det.stereo.centres) {
        const x = P(mol, c.atom);
        const [a, b, d] = [P(mol, c.nbrs[1]), P(mol, c.nbrs[2]), P(mol, c.nbrs[3])].map((p) => p.map((v, k) => v - x[k]));
        const vol = a[0] * (b[1] * d[2] - b[2] * d[1]) + a[1] * (b[2] * d[0] - b[0] * d[2]) + a[2] * (b[0] * d[1] - b[1] * d[0]);
        expect(Math.sign(vol)).toBe(c.sign);
      }
    });
  }

  it('benzene is a planar regular hexagon with C–H in plane', () => {
    const m = moleculeFromSmiles('c1ccccc1');
    expect(planeDeviation(m, [...Array(12).keys()])).toBeLessThan(0.01);
    for (let k = 0; k < 6; k++) expect(dist(P(m, k), P(m, (k + 1) % 6))).toBeCloseTo(idealBondLength('C', 'C', 1.5), 2);
  });

  it('ethane-like sp3 angles are tetrahedral and the conformation is staggered', () => {
    const m = moleculeFromSmiles('CC');
    const topo = getTopology(m);
    const h1 = topo.neighbors[0].filter((j) => j !== 1);
    const h2 = topo.neighbors[1].filter((j) => j !== 0);
    const ang = (a: Vec3, b: Vec3, c: Vec3) => {
      const u = a.map((v, k) => v - b[k]), w = c.map((v, k) => v - b[k]);
      return (Math.acos((u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w))) * 180) / Math.PI;
    };
    for (const h of h1) expect(ang(P(m, h), P(m, 0), P(m, 1))).toBeCloseTo(109.47, 0);
    const phi = Math.abs(dihedral(P(m, h1[0]), P(m, 0), P(m, 1), P(m, h2[0])));
    expect(Math.min(Math.abs(phi - 60), Math.abs(phi - 180))).toBeLessThan(5);
  });

  it('keeps absolute configuration: L-alanine is S, D-alanine is R', () => {
    for (const [smi, want] of [
      ['N[C@@H](C)C(=O)O', 'S'],
      ['C[C@@H](C(=O)O)N', 'S'],
      ['N[C@H](C)C(=O)O', 'R'],
    ] as const) {
      const m = moleculeFromSmiles(smi);
      const ca = m.atoms.findIndex((a, i) => a.element === 'C' && heavyNeighbour(m, i, 'N') >= 0);
      const n = heavyNeighbour(m, ca, 'N');
      const topo = getTopology(m);
      const cooh = topo.neighbors[ca].find((j) => m.atoms[j].element === 'C' && heavyNeighbour(m, j, 'O') >= 0)!;
      const me = topo.neighbors[ca].find((j) => m.atoms[j].element === 'C' && j !== cooh)!;
      // CIP priorities: N > COOH > CH3 > H
      expect(cip(m, ca, n, cooh, me)).toBe(want);
    }
  });

  it('reads chirality through ring closures: both L-proline SMILES are S', () => {
    for (const smi of ['C1C[C@H](NC1)C(=O)O', 'OC(=O)[C@@H]1CCCN1']) {
      const m = moleculeFromSmiles(smi);
      const topo = getTopology(m);
      const ca = m.atoms.findIndex(
        (a, i) => a.element === 'C' && heavyNeighbour(m, i, 'N') >= 0 && topo.neighbors[i].some((j) => heavyNeighbour(m, j, 'O') >= 0 && m.atoms[j].element === 'C'),
      );
      const n = heavyNeighbour(m, ca, 'N');
      const cooh = topo.neighbors[ca].find((j) => m.atoms[j].element === 'C' && heavyNeighbour(m, j, 'O') >= 0)!;
      const cb = topo.neighbors[ca].find((j) => m.atoms[j].element === 'C' && j !== cooh)!;
      expect(cip(m, ca, n, cooh, cb), smi).toBe('S');
    }
  });

  it('honours E/Z double-bond stereo', () => {
    const trans = moleculeFromSmiles('F/C=C/F');
    expect(Math.abs(dihedral(P(trans, 0), P(trans, 1), P(trans, 2), P(trans, 3)))).toBeGreaterThan(170);
    const cis = moleculeFromSmiles('F/C=C\\F');
    expect(Math.abs(dihedral(P(cis, 0), P(cis, 1), P(cis, 2), P(cis, 3)))).toBeLessThan(10);
    const stil = moleculeFromSmiles('c1ccccc1/C=C\\c1ccccc1'); // (Z)-stilbene
    const topo = getTopology(stil);
    const db = stil.bonds.find((b) => b.order === 2)!;
    const a = topo.idToIndex.get(db.a)!, b = topo.idToIndex.get(db.b)!;
    const x = topo.neighbors[a].find((j) => j !== b && stil.atoms[j].element === 'C')!;
    const y = topo.neighbors[b].find((j) => j !== a && stil.atoms[j].element === 'C')!;
    expect(Math.abs(dihedral(P(stil, x), P(stil, a), P(stil, b), P(stil, y)))).toBeLessThan(30);
  });

  it('places disconnected fragments side by side without overlap', () => {
    const m = moleculeFromSmiles('[Na+].[Cl-]');
    expect(dist(P(m, 0), P(m, 1))).toBeGreaterThan(3);
    const w = moleculeFromSmiles('CC(=O)[O-].[Na+].O');
    const n = w.atoms.length;
    const topo = getTopology(w);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (topo.neighbors[i].includes(j)) continue;
        expect(dist(P(w, i), P(w, j))).toBeGreaterThan(1.4);
      }
  });

  it('keeps ids / elements and centres the molecule', () => {
    const m = moleculeFromSmiles('CCO');
    expect(m.atoms.map((a) => a.id)).toEqual(parseSmiles('CCO').mol.atoms.map((a) => a.id));
    const c = m.atoms.reduce((s, a) => [s[0] + a.x, s[1] + a.y, s[2] + a.z], [0, 0, 0]).map((v) => v / m.atoms.length);
    for (const v of c) expect(Math.abs(v)).toBeLessThan(1e-6);
  });

  it('embeds larger molecules quickly (cyclic peptide-like, 100+ atoms)', () => {
    const t0 = performance.now();
    const m = moleculeFromSmiles('CC(C)C[C@H](NC(=O)[C@@H](Cc1ccccc1)NC(=O)[C@H](C)NC(=O)CN)C(=O)N[C@@H](CO)C(=O)O');
    expect(performance.now() - t0).toBeLessThan(1500);
    const g = checkGeometry(m);
    expect(g.maxDev).toBeLessThan(0.08);
    expect(g.minNb).toBeGreaterThan(2.0);
  });
});

describe('embed3D', () => {
  it('turns a flat 2D drawing into 3D and keeps E/Z from the drawing', () => {
    // (E)-but-2-ene drawn in the xy plane (2D depiction coordinates, no hydrogens)
    const parsed = parseSmiles('CC=CC').mol;
    const flat: Molecule = {
      ...parsed,
      meta: { source: 'pubchem' },
      atoms: parsed.atoms.map((a, i) => {
        const xy: [number, number][] = [[0, 0], [1.3, 0.75], [2.6, 0], [3.9, 0.75]];
        return i < 4 ? { ...a, x: xy[i][0], y: xy[i][1], z: 0 } : { ...a, x: 0.1 * i, y: -0.2 * i, z: 0 };
      }),
    };
    const m = embed3D(flat);
    expect(m.atoms.map((a) => a.id)).toEqual(flat.atoms.map((a) => a.id));
    expect(Math.abs(dihedral(P(m, 0), P(m, 1), P(m, 2), P(m, 3)))).toBeGreaterThan(170);
    const g = checkGeometry(m);
    expect(g.maxDev).toBeLessThan(0.08);
    // the methyl groups are tetrahedral → not flat any more
    expect(planeDeviation(m, [...Array(m.atoms.length).keys()])).toBeGreaterThan(0.5);
  });

  it('handles a molecule with all coordinates at zero', () => {
    const m = embed3D(parseSmiles('OC(=O)c1ccccc1').mol);
    const g = checkGeometry(m);
    expect(g.maxDev).toBeLessThan(0.08);
    expect(g.maxPlane).toBeLessThan(0.05);
  });
});
