import { describe, expect, it } from 'vitest';
import type { AtomInput } from './molecule';
import { buildMolecule, getTopology } from './molecule';
import { perceiveBondOrders, perceiveBonds } from './bonding';
import { augmentMatching } from './structure-bondorders';
import { covalentRadius } from './structure-chem';
import type { Molecule, Vec3 } from './types';
import {
  type XYZ,
  add,
  atomsFrom,
  hMethyl,
  hTerminalTrigonal,
  hTrigonal,
  hexFlake,
  placeAtom,
  planarRing,
  scale,
  unit,
  vec,
  withHydrogens,
} from './structure-testkit';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const fromXYZ = (list: XYZ[], extra: Partial<AtomInput> = {}) => buildMolecule('test', atomsFrom(list, extra));

/** Bond list as sorted "i-j:order" strings (atom indices). */
function bondSet(mol: Molecule): string[] {
  const t = getTopology(mol);
  return mol.bonds
    .map((b) => {
      const i = t.idToIndex.get(b.a)!;
      const j = t.idToIndex.get(b.b)!;
      return `${Math.min(i, j)}-${Math.max(i, j)}:${b.order}`;
    })
    .sort();
}

function orderOf(mol: Molecule, i: number, j: number): number | undefined {
  const a = mol.atoms[i].id;
  const b = mol.atoms[j].id;
  return mol.bonds.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a))?.order;
}

function countOrders(mol: Molecule) {
  const c = { 1: 0, 1.5: 0, 2: 0, 3: 0 } as Record<number, number>;
  for (const b of mol.bonds) c[b.order]++;
  return c;
}

const prepare = (m: Molecule) => perceiveBondOrders(perceiveBonds(m));

// ---------------------------------------------------------------------------------------------
// Test molecules (coordinates from ideal geometry; ring systems relaxed to literature bond lengths)
// ---------------------------------------------------------------------------------------------

function benzeneHeavy(side = 1.39): XYZ[] {
  const R = side; // hexagon circumradius = side
  return Array.from({ length: 6 }, (_, k): XYZ => ['C', R * Math.cos((k * Math.PI) / 3), R * Math.sin((k * Math.PI) / 3), 0]);
}

function benzene(): XYZ[] {
  const c = benzeneHeavy();
  const hs = c.map((a) => {
    const p = vec(a);
    return add(p, scale(unit(p), 1.09));
  });
  return withHydrogens(c, hs);
}

function ethane(): XYZ[] {
  const c1: Vec3 = [0, 0, 0];
  const c2: Vec3 = [1.53, 0, 0];
  return withHydrogens([['C', ...c1], ['C', ...c2]], [...hMethyl(c1, c2), ...hMethyl(c2, c1)]);
}

function ethylene(withH = true): XYZ[] {
  const c1: Vec3 = [0, 0, 0];
  const c2: Vec3 = [1.33, 0, 0];
  const heavy: XYZ[] = [['C', ...c1], ['C', ...c2]];
  if (!withH) return heavy;
  return withHydrogens(heavy, [...hTerminalTrigonal(c1, c2, [0, 1, 0]), ...hTerminalTrigonal(c2, c1, [0, 1, 0])]);
}

function ethanol(): XYZ[] {
  const c1: Vec3 = [0, 0, 0];
  const c2: Vec3 = [1.52, 0, 0];
  const o = placeAtom([0, 1, 0], c1, c2, 1.43, 109.5, 180);
  const ho = placeAtom(c1, c2, o, 0.96, 108.5, 180);
  const h2a = placeAtom(o, c1, c2, 1.09, 109.5, 120);
  const h2b = placeAtom(o, c1, c2, 1.09, 109.5, -120);
  return withHydrogens([['C', ...c1], ['C', ...c2], ['O', ...o]], [...hMethyl(c1, c2, 1.09, o), h2a, h2b, ho]);
}

/** CH3–C(=O)–OH, planar heavy atoms. Indices: 0 CH3, 1 C, 2 O(=), 3 O(H). */
function aceticAcid(withH = true): XYZ[] {
  const cm: Vec3 = [0, 0, 0];
  const c: Vec3 = [1.5, 0, 0];
  const o1 = placeAtom([0, -1, 0], cm, c, 1.21, 123, 0);
  const o2 = placeAtom([0, -1, 0], cm, c, 1.34, 112, 180);
  const heavy: XYZ[] = [['C', ...cm], ['C', ...c], ['O', ...o1], ['O', ...o2]];
  if (!withH) return heavy;
  const h = placeAtom(cm, c, o2, 0.97, 106, 180);
  return withHydrogens(heavy, [...hMethyl(cm, c), h]);
}

/** CH3–C≡N. Indices 0 CH3, 1 C, 2 N. */
function acetonitrile(withH = true): XYZ[] {
  const heavy: XYZ[] = [['C', 0, 0, 0], ['C', 1.46, 0, 0], ['N', 2.62, 0, 0]];
  return withH ? withHydrogens(heavy, hMethyl([0, 0, 0], [1.46, 0, 0])) : heavy;
}

/** H–C≡C–H */
function acetylene(): XYZ[] {
  return [['C', 0, 0, 0], ['C', 1.2, 0, 0], ['H', -1.06, 0, 0], ['H', 2.26, 0, 0]];
}

/** Caffeine heavy atoms N1 C2 N3 C4 C5 C6 N7 C8 N9 O2 O6 C10 C12 C14 (+ H8). */
const CAFFEINE: XYZ[] = [
  ['N', -0.004, 1.407], ['C', -1.199, 0.678], ['N', -1.167, -0.702], ['C', 0.025, -1.376], ['C', 1.206, -0.7],
  ['C', 1.216, 0.718], ['N', 2.217, -1.654], ['C', 1.635, -2.861], ['N', 0.316, -2.704], ['O', -2.27, 1.263],
  ['O', 2.278, 1.335], ['C', -0.028, 2.875], ['C', -2.43, -1.458], ['C', 3.652, -1.388],
];
const CAFFEINE_H8: Vec3 = [2.157, -3.809, 0];

function caffeine(withH = true): XYZ[] {
  if (!withH) return CAFFEINE;
  const p = CAFFEINE.map(vec);
  return withHydrogens(CAFFEINE, [CAFFEINE_H8, ...hMethyl(p[11], p[0]), ...hMethyl(p[12], p[2]), ...hMethyl(p[13], p[6])]);
}

const PYRIDINE: XYZ[] = [['N', 0, 1.36], ['C', -1.165, 0.702], ['C', -1.191, -0.688], ['C', 0, -1.39], ['C', 1.191, -0.688], ['C', 1.165, 0.702]];

function pyridine(): XYZ[] {
  const p = PYRIDINE.map(vec);
  const hs = [1, 2, 3, 4, 5].map((k) => hTrigonal(p[k], p[k - 1], p[(k + 1) % 6]));
  return withHydrogens(PYRIDINE, hs);
}

/** Imidazole N1(H) C2 N3 C4 C5. */
const IMIDAZOLE: XYZ[] = [['N', -0.014, 1.152], ['C', -1.094, 0.343], ['N', -0.693, -0.913], ['C', 0.686, -0.938], ['C', 1.115, 0.356]];

function imidazole(): XYZ[] {
  const p = IMIDAZOLE.map(vec);
  const hs = [0, 1, 3, 4].map((k) => hTrigonal(p[k], p[(k + 4) % 5], p[(k + 1) % 5], k === 0 ? 1.01 : 1.08));
  return withHydrogens(IMIDAZOLE, hs);
}

/** Indole N1 C2 C3 C3a C4 C5 C6 C7 C7a (heavy atoms only). */
const INDOLE: XYZ[] = [
  ['N', 1.634, -2.219], ['C', 2.886, -1.671], ['C', 2.784, -0.314], ['C', 1.392, 0.014], ['C', 0.686, 1.219],
  ['C', -0.695, 1.203], ['C', -1.385, -0.014], ['C', -0.697, -1.21], ['C', 0.692, -1.213],
];

/** Naphthalene heavy atoms: two fused hexagons (C–C 1.40). */
function naphthalene(): XYZ[] {
  const r = 1.4;
  const h = (r * Math.sqrt(3)) / 2;
  return [
    ['C', 0, r / 2], ['C', 0, -r / 2], // fusion atoms 0, 1
    ['C', h, -r], ['C', 2 * h, -r / 2], ['C', 2 * h, r / 2], ['C', h, r],
    ['C', -h, -r], ['C', -2 * h, -r / 2], ['C', -2 * h, r / 2], ['C', -h, r],
  ];
}

/** Cyclohexane chair (C–C 1.53 Å, C–C–C 111.4°). */
function cyclohexane(withH: boolean): XYZ[] {
  const R = 1.459;
  const hz = 0.23;
  const c = Array.from({ length: 6 }, (_, k): XYZ => ['C', R * Math.cos((k * Math.PI) / 3), R * Math.sin((k * Math.PI) / 3), k % 2 ? hz : -hz]);
  if (!withH) return c;
  const p = c.map(vec);
  const hs: Vec3[] = [];
  for (let k = 0; k < 6; k++) {
    const prev = p[(k + 5) % 6];
    const next = p[(k + 1) % 6];
    // Axial H along ±z, equatorial H roughly outward.
    const ax = add(p[k], [0, 0, k % 2 ? 1.09 : -1.09]);
    const bis = unit(add(unit([p[k][0] - prev[0], p[k][1] - prev[1], p[k][2] - prev[2]]), unit([p[k][0] - next[0], p[k][1] - next[1], p[k][2] - next[2]])));
    const eq = add(p[k], scale(unit(add(scale(bis, 0.94), [0, 0, k % 2 ? -0.33 : 0.33])), 1.09));
    hs.push(ax, eq);
  }
  return withHydrogens(c, hs);
}

/** Nitrobenzene: ring 0–5, N 6, O 7, O 8, ring H. */
function nitrobenzene(): XYZ[] {
  const ring = benzeneHeavy();
  const p = ring.map(vec);
  const n: Vec3 = scale(unit(p[0]), 1.39 + 1.47);
  const o1 = placeAtom(p[1], p[0], n, 1.22, 118, 0);
  const o2 = placeAtom(p[1], p[0], n, 1.22, 118, 180);
  const hs = [1, 2, 3, 4, 5].map((k) => add(p[k], scale(unit(p[k]), 1.08)));
  return withHydrogens([...ring, ['N', ...n], ['O', ...o1], ['O', ...o2]], hs);
}

/** Dimethyl sulfoxide: S 0, O 1, C 2, C 3 + H. */
function dmso(): XYZ[] {
  const s: Vec3 = [0, 0, 0];
  const o: Vec3 = [0, 0, 1.49];
  const c1 = placeAtom([1, 0, 0], o, s, 1.8, 106.5, 0);
  const c2 = placeAtom(c1, o, s, 1.8, 106.5, 110);
  return withHydrogens([['S', ...s], ['O', ...o], ['C', ...c1], ['C', ...c2]], [...hMethyl(c1, s), ...hMethyl(c2, s)]);
}

// ---------------------------------------------------------------------------------------------
// perceiveBonds
// ---------------------------------------------------------------------------------------------

describe('perceiveBonds', () => {
  it('bonds ethanol correctly (8 bonds, no H–H, no 1–3 bonds)', () => {
    const mol = perceiveBonds(fromXYZ(ethanol()));
    expect(mol.bonds).toHaveLength(8);
    const els = mol.bonds.map((b) => [mol.atoms[b.a - 1].element, mol.atoms[b.b - 1].element].sort().join(''));
    expect(els.filter((e) => e === 'CH')).toHaveLength(5);
    expect(els.filter((e) => e === 'HO')).toHaveLength(1);
    expect(els.filter((e) => e === 'CC')).toHaveLength(1);
    expect(els.filter((e) => e === 'CO')).toHaveLength(1);
    expect(els).not.toContain('HH');
    expect(mol.bonds.every((b) => b.order === 1)).toBe(true);
    expect(mol.nextBondId).toBe(9);
  });

  it('bonds benzene: 6 ring + 6 C–H bonds', () => {
    const mol = perceiveBonds(fromXYZ(benzene()));
    expect(mol.bonds).toHaveLength(12);
    const topo = getTopology(mol);
    for (let i = 0; i < 6; i++) expect(topo.neighbors[i]).toHaveLength(3);
    for (let i = 6; i < 12; i++) expect(topo.neighbors[i]).toHaveLength(1);
  });

  it('returns the same molecule when nothing is added', () => {
    const mol = fromXYZ([['C', 0, 0, 0], ['C', 5, 0, 0]]);
    expect(perceiveBonds(mol)).toBe(mol);
    const once = perceiveBonds(fromXYZ(ethane()));
    expect(perceiveBonds(once)).toBe(once);
  });

  it('keeps existing bonds and never duplicates them', () => {
    const base = buildMolecule('co', atomsFrom([['C', 0, 0, 0], ['O', 1.22, 0, 0], ['H', -0.6, 0.9, 0], ['H', -0.6, -0.9, 0]]), [{ a: 0, b: 1, order: 2 }]);
    const mol = perceiveBonds(base);
    expect(mol.bonds).toHaveLength(3);
    expect(mol.bonds[0]).toBe(base.bonds[0]);
    expect(mol.bonds[0].order).toBe(2);
    expect(new Set(mol.bonds.map((b) => b.id)).size).toBe(3);
    expect(mol.bonds.slice(1).map((b) => b.id)).toEqual([2, 3]);
  });

  it('does not mutate the input molecule', () => {
    const base = fromXYZ(ethane());
    const before = JSON.stringify(base);
    perceiveBonds(base);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('ignores overlapping atoms closer than 0.4 Å', () => {
    const mol = perceiveBonds(fromXYZ([['C', 0, 0, 0], ['C', 0.3, 0, 0]]));
    expect(mol.bonds).toHaveLength(0);
  });

  it('respects the tolerance option', () => {
    const d = 2 * covalentRadius('C') + 0.3;
    const m = fromXYZ([['C', 0, 0, 0], ['C', d, 0, 0]]);
    expect(perceiveBonds(m).bonds).toHaveLength(1);
    expect(perceiveBonds(m, { tolerance: 0.2 }).bonds).toHaveLength(0);
  });

  it('gives each hydrogen at most one bond, to the closest heavy atom', () => {
    // H between two O atoms (1.0 and 1.25 Å) — both within cutoff.
    const mol = perceiveBonds(fromXYZ([['O', 0, 0, 0], ['H', 1.0, 0, 0], ['O', 2.25, 0, 0]]));
    expect(bondSet(mol)).toEqual(['0-1:1']);
  });

  it('prefers a heavy partner over another H, but bonds H₂', () => {
    // H close to another H (0.9 Å) and to a C (1.1 Å): bonds to C.
    const m1 = perceiveBonds(fromXYZ([['C', 0, 0, 0], ['H', 1.1, 0, 0], ['H', 1.1, 0.9, 0]]));
    expect(bondSet(m1)).toEqual(['0-1:1', '0-2:1']);
    const h2 = perceiveBonds(fromXYZ([['H', 0, 0, 0], ['H', 0.74, 0, 0]]));
    expect(bondSet(h2)).toEqual(['0-1:1']);
  });

  it('does not add bonds to an H that already has one', () => {
    const base = buildMolecule('x', atomsFrom([['O', 0, 0, 0], ['H', 0.96, 0, 0], ['N', 2.0, 0, 0]]), [{ a: 0, b: 1 }]);
    const mol = perceiveBonds(base);
    expect(bondSet(mol)).toEqual(['0-1:1']);
  });

  it('skips pairs with different altLocs but bonds blank/same altLocs', () => {
    const atoms = atomsFrom([
      ['C', 0, 0, 0],
      ['C', 1.53, 0, 0],
      ['C', 1.53, 0.3, 0],
    ]);
    atoms[1].altLoc = 'A';
    atoms[2].altLoc = 'B';
    const mol = perceiveBonds(buildMolecule('alt', atoms));
    // 0–1 and 0–2 bonded (blank vs A/B); 1–2 too close anyway, check 3-atom variant below.
    expect(bondSet(mol)).toEqual(['0-1:1', '0-2:1']);
    const atoms2 = atomsFrom([['C', 0, 0, 0], ['C', 1.5, 0, 0]]);
    atoms2[0].altLoc = 'A';
    atoms2[1].altLoc = 'B';
    expect(perceiveBonds(buildMolecule('alt2', atoms2)).bonds).toHaveLength(0);
    atoms2[1].altLoc = 'A';
    expect(perceiveBonds(buildMolecule('alt3', atoms2)).bonds).toHaveLength(1);
  });

  it('never bonds atoms of different water residues', () => {
    const water = (o: Vec3, resSeq: number): AtomInput[] =>
      atomsFrom([['O', o[0], o[1], o[2]], ['H', o[0] + 0.96, o[1], o[2]], ['H', o[0] - 0.24, o[1] + 0.93, o[2]]], {
        resName: 'HOH',
        resSeq,
        chain: 'W',
        hetero: true,
      });
    // Two clashing waters, O–O 1.6 Å (would bond by distance alone).
    const mol = perceiveBonds(buildMolecule('w', [...water([0, 0, 0], 1), ...water([0, 0, 1.6], 2)]));
    expect(bondSet(mol)).toEqual(['0-1:1', '0-2:1', '3-4:1', '3-5:1']);
    // Without residue info the same coordinates do bond O–O.
    const plain = perceiveBonds(buildMolecule('w', [...water([0, 0, 0], 1), ...water([0, 0, 1.6], 2)].map((a) => ({ ...a, resName: undefined, resSeq: undefined }))));
    expect(bondSet(plain)).toContain('0-3:1');
  });

  it('uses the stricter tolerance for metals and ion residues', () => {
    const rs = covalentRadius('Zn') + covalentRadius('N');
    const near = perceiveBonds(fromXYZ([['Zn', 0, 0, 0], ['N', rs + 0.2, 0, 0]]));
    expect(near.bonds).toHaveLength(1);
    const far = perceiveBonds(fromXYZ([['Zn', 0, 0, 0], ['N', rs + 0.38, 0, 0]]));
    expect(far.bonds).toHaveLength(0);
    // Same distance offset between two organic atoms bonds with the default tolerance.
    const rc = 2 * covalentRadius('C');
    expect(perceiveBonds(fromXYZ([['C', 0, 0, 0], ['C', rc + 0.38, 0, 0]])).bonds).toHaveLength(1);
    // Chloride in an ion residue is strict too.
    const rcl = covalentRadius('Cl') + covalentRadius('O');
    const cl = buildMolecule('ion', [
      { element: 'Cl', x: 0, y: 0, z: 0, resName: 'CL', resSeq: 1, hetero: true },
      { element: 'O', x: rcl + 0.38, y: 0, z: 0, resName: 'HOH', resSeq: 2, hetero: true },
    ]);
    expect(perceiveBonds(cl).bonds).toHaveLength(0);
  });

  it('links residues through the peptide bond', () => {
    const atoms: AtomInput[] = [
      { element: 'N', name: 'N', x: 0, y: 1.2, z: 0, resName: 'GLY', resSeq: 1, chain: 'A' },
      { element: 'C', name: 'CA', x: 0, y: 0, z: 0, resName: 'GLY', resSeq: 1, chain: 'A' },
      { element: 'C', name: 'C', x: 1.25, y: -0.8, z: 0, resName: 'GLY', resSeq: 1, chain: 'A' },
      { element: 'O', name: 'O', x: 1.25, y: -2.03, z: 0, resName: 'GLY', resSeq: 1, chain: 'A' },
      { element: 'N', name: 'N', x: 2.4, y: -0.1, z: 0, resName: 'GLY', resSeq: 2, chain: 'A' },
      { element: 'C', name: 'CA', x: 3.7, y: -0.7, z: 0, resName: 'GLY', resSeq: 2, chain: 'A' },
    ];
    const mol = perceiveBonds(buildMolecule('gg', atoms));
    expect(bondSet(mol)).toEqual(['0-1:1', '1-2:1', '2-3:1', '2-4:1', '4-5:1']);
  });

  it('handles 100k atoms quickly (synthetic cubic lattice)', () => {
    const n = 46;
    const step = 1.5;
    const atoms: AtomInput[] = [];
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) atoms.push({ element: 'C', x: x * step, y: y * step, z: z * step });
    const mol = buildMolecule('lattice', atoms);
    const t0 = performance.now();
    const out = perceiveBonds(mol);
    const ms = performance.now() - t0;
    // Each lattice point bonds its 6 axial neighbours (diagonals at 2.12 Å exceed 1.97 Å).
    expect(out.bonds).toHaveLength(3 * n * n * (n - 1));
    expect(ms).toBeLessThan(3000);
  });
});

// ---------------------------------------------------------------------------------------------
// perceiveBondOrders
// ---------------------------------------------------------------------------------------------

describe('perceiveBondOrders', () => {
  it('benzene → aromatic ring (with and without hydrogens)', () => {
    for (const list of [benzene(), benzeneHeavy()]) {
      const mol = prepare(fromXYZ(list));
      for (let k = 0; k < 6; k++) expect(orderOf(mol, k, (k + 1) % 6)).toBe(1.5);
      expect(countOrders(mol)[1.5]).toBe(6);
    }
  });

  it('ethylene → C=C', () => {
    expect(orderOf(prepare(fromXYZ(ethylene(true))), 0, 1)).toBe(2);
    expect(orderOf(prepare(fromXYZ(ethylene(false))), 0, 1)).toBe(2);
  });

  it('ethane / cyclohexane stay single', () => {
    expect(countOrders(prepare(fromXYZ(ethane())))[1]).toBe(7);
    for (const withH of [true, false]) {
      const mol = prepare(fromXYZ(cyclohexane(withH)));
      expect(mol.bonds.every((b) => b.order === 1)).toBe(true);
      expect(mol.bonds).toHaveLength(withH ? 18 : 6);
    }
  });

  it('acetic acid → one C=O, C–OH single', () => {
    for (const withH of [true, false]) {
      const mol = prepare(fromXYZ(aceticAcid(withH)));
      expect(orderOf(mol, 1, 2)).toBe(2);
      expect(orderOf(mol, 1, 3)).toBe(1);
      expect(orderOf(mol, 0, 1)).toBe(1);
    }
  });

  it('acetonitrile → C≡N, acetylene → C≡C', () => {
    for (const withH of [true, false]) {
      const mol = prepare(fromXYZ(acetonitrile(withH)));
      expect(orderOf(mol, 1, 2)).toBe(3);
      expect(orderOf(mol, 0, 1)).toBe(1);
    }
    expect(orderOf(prepare(fromXYZ(acetylene())), 0, 1)).toBe(3);
  });

  it('caffeine → C2=O, C6=O, C8=N9, C4=C5; no aromatic 6-ring (exocyclic C=O)', () => {
    for (const withH of [true, false]) {
      const mol = prepare(fromXYZ(caffeine(withH)));
      expect(orderOf(mol, 1, 9)).toBe(2); // C2=O2
      expect(orderOf(mol, 5, 10)).toBe(2); // C6=O6
      expect(orderOf(mol, 7, 8)).toBe(2); // C8=N9
      expect(orderOf(mol, 3, 4)).toBe(2); // C4=C5
      const c = countOrders(mol);
      expect(c[2]).toBe(4);
      expect(c[1.5]).toBe(0);
      expect(c[3]).toBe(0);
    }
  });

  it('naphthalene → all 11 ring bonds aromatic (fused rings)', () => {
    const mol = prepare(fromXYZ(naphthalene()));
    expect(mol.bonds).toHaveLength(11);
    expect(mol.bonds.every((b) => b.order === 1.5)).toBe(true);
  });

  it('pyridine → aromatic', () => {
    const mol = prepare(fromXYZ(pyridine()));
    for (let k = 0; k < 6; k++) expect(orderOf(mol, k, (k + 1) % 6)).toBe(1.5);
  });

  it('imidazole → Kekulé form C2=N3, C4=C5 (5-rings are not aromatised)', () => {
    const mol = prepare(fromXYZ(imidazole()));
    expect(orderOf(mol, 1, 2)).toBe(2);
    expect(orderOf(mol, 3, 4)).toBe(2);
    expect(orderOf(mol, 0, 1)).toBe(1);
    expect(orderOf(mol, 4, 0)).toBe(1);
  });

  it('indole (no H) → aromatic benzene ring, C2=C3, N1 single', () => {
    const mol = prepare(fromXYZ(INDOLE));
    for (const [i, j] of [[3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 3]]) expect(orderOf(mol, i, j)).toBe(1.5);
    expect(orderOf(mol, 1, 2)).toBe(2);
    expect(orderOf(mol, 0, 1)).toBe(1);
    expect(orderOf(mol, 0, 8)).toBe(1);
  });

  it('nitrobenzene → charge-separated nitro group and aromatic ring', () => {
    const mol = prepare(fromXYZ(nitrobenzene()));
    expect([orderOf(mol, 6, 7), orderOf(mol, 6, 8)].sort()).toEqual([1, 2]);
    expect(mol.atoms[6].charge).toBe(1);
    const oCharges = [mol.atoms[7].charge ?? 0, mol.atoms[8].charge ?? 0].sort();
    expect(oCharges).toEqual([-1, 0]);
    for (let k = 0; k < 6; k++) expect(orderOf(mol, k, (k + 1) % 6)).toBe(1.5);
  });

  it('DMSO → S=O (hypervalent sulfur)', () => {
    const mol = prepare(fromXYZ(dmso()));
    expect(orderOf(mol, 0, 1)).toBe(2);
    expect(orderOf(mol, 0, 2)).toBe(1);
  });

  it('leaves protein residues single and does not touch components with explicit orders', () => {
    const ring = benzeneHeavy();
    const prot = buildMolecule(
      'phe',
      atomsFrom(ring, { resName: 'PHE', resSeq: 1, chain: 'A' }).map((a, i) => ({ ...a, name: `C${i}` })),
    );
    const p = prepare(prot);
    expect(p.bonds).toHaveLength(6);
    expect(p.bonds.every((b) => b.order === 1)).toBe(true);

    const withOrders = perceiveBonds(fromXYZ(ethylene(true)));
    const edited = { ...withOrders, bonds: withOrders.bonds.map((b, i) => (i === withOrders.bonds.length - 1 ? { ...b, order: 2 as const } : b)) };
    expect(perceiveBondOrders(edited)).toBe(edited);
  });

  it('treats a ligand in a protein structure, leaving the protein alone', () => {
    const lig = atomsFrom(benzeneHeavy(), { resName: 'BNZ', resSeq: 900, chain: 'A', hetero: true }).map((a) => ({ ...a, x: a.x + 20 }));
    const prot = atomsFrom(benzeneHeavy(), { resName: 'PHE', resSeq: 1, chain: 'A' });
    const mol = prepare(buildMolecule('complex', [...prot, ...lig]));
    const topo = getTopology(mol);
    for (const b of mol.bonds) {
      const i = topo.idToIndex.get(b.a)!;
      expect(b.order).toBe(i < 6 ? 1 : 1.5);
    }
  });

  it('polycyclic aromatics → every C–C bond aromatic (pyrene, coronene, large flake)', () => {
    const shapes: [number, number][][] = [
      [[0, 0], [1, 0], [0, 1], [1, -1]], // pyrene
      [[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]], // coronene
      [[0, 0], [1, 0], [1, 1]], // phenanthrene
      Array.from({ length: 36 }, (_, k): [number, number] => [k % 6, Math.floor(k / 6)]), // 6×6 rhombus, C110
    ];
    for (const rings of shapes) {
      for (const withH of [false, true]) {
        const mol = prepare(fromXYZ(hexFlake(rings, withH)));
        const cc = mol.bonds.filter((b) => mol.atoms[b.a - 1].element === 'C' && mol.atoms[b.b - 1].element === 'C');
        expect(cc.length).toBeGreaterThan(0);
        expect(cc.every((b) => b.order === 1.5)).toBe(true);
      }
    }
  });

  it('CO₂ → O=C=O; p-benzoquinone → C=O and two ring C=C, not aromatic', () => {
    const co2 = prepare(fromXYZ([['O', -1.16, 0, 0], ['C', 0, 0, 0], ['O', 1.16, 0, 0]]));
    expect(co2.bonds.map((b) => b.order)).toEqual([2, 2]);
    const ring = planarRing(['C', 'C', 'C', 'C', 'C', 'C'], 1.42);
    const o1 = scale(unit(vec(ring[0])), 1.4 + 1.22);
    const o4 = scale(unit(vec(ring[3])), 1.4 + 1.22);
    const q = prepare(fromXYZ([...ring, ['O', ...o1], ['O', ...o4]]));
    expect(orderOf(q, 0, 6)).toBe(2);
    expect(orderOf(q, 3, 7)).toBe(2);
    expect(orderOf(q, 1, 2)).toBe(2);
    expect(orderOf(q, 4, 5)).toBe(2);
    expect(countOrders(q)[1.5]).toBe(0);
  });

  it('thiophene / furan / pyrrole (explicit H) → two ring double bonds, heteroatom single', () => {
    // Heteroatom first, then C2..C5 (relaxed to literature bond lengths).
    const rings: XYZ[][] = [
      [['S', 0, 1.39], ['C', -1.315, 0.264], ['C', -0.699, -0.959], ['C', 0.699, -0.959], ['C', 1.315, 0.264]],
      [['O', 0, 1.144], ['C', -1.108, 0.36], ['C', -0.717, -0.933], ['C', 0.717, -0.933], ['C', 1.108, 0.36]],
      [['N', 0, 1.162], ['C', -1.115, 0.37], ['C', -0.711, -0.951], ['C', 0.711, -0.951], ['C', 1.115, 0.37]],
    ];
    for (const ring of rings) {
      const p = ring.map(vec);
      const hOn = ring[0][0] === 'N' ? [0, 1, 2, 3, 4] : [1, 2, 3, 4];
      const hs = hOn.map((k) => hTrigonal(p[k], p[(k + 4) % 5], p[(k + 1) % 5], k === 0 ? 1.01 : 1.08));
      const mol = prepare(fromXYZ(withHydrogens(ring, hs)));
      expect(orderOf(mol, 1, 2)).toBe(2);
      expect(orderOf(mol, 3, 4)).toBe(2);
      expect(orderOf(mol, 0, 1)).toBe(1);
      expect(orderOf(mol, 2, 3)).toBe(1);
      expect(orderOf(mol, 4, 0)).toBe(1);
    }
  });

  it('phenol → aromatic ring with a single C–O', () => {
    const ring = benzene();
    const o = scale(unit(vec(ring[0])), 1.39 + 1.36);
    const list: XYZ[] = [...ring.slice(0, 6), ['O', ...o], ...ring.slice(7), ['H', o[0] + 0.5, o[1] + 0.8, 0]];
    const mol = prepare(fromXYZ(list));
    expect(orderOf(mol, 0, 6)).toBe(1);
    for (let k = 0; k < 6; k++) expect(orderOf(mol, k, (k + 1) % 6)).toBe(1.5);
  });

  it('returns the input when nothing changes', () => {
    const m = perceiveBonds(fromXYZ(ethane()));
    expect(perceiveBondOrders(m)).toBe(m);
  });
});

describe('augmentMatching (Edmonds blossom)', () => {
  it('finds an augmenting path through an odd cycle', () => {
    // 0–1, 1–2, triangle 2–3–4, 4–5; start with {1–2, 3–4}: only augmentable through the blossom.
    const adj = [[1], [0, 2], [1, 3, 4], [2, 4], [2, 3, 5], [4]];
    const match = Int32Array.from([-1, 2, 1, 4, 3, -1]);
    augmentMatching(6, adj, match, [0, 5]);
    expect([...match].every((m) => m >= 0)).toBe(true);
    for (let v = 0; v < 6; v++) {
      expect(match[match[v]]).toBe(v);
      expect(adj[v]).toContain(match[v]);
    }
  });

  it('leaves a maximum matching alone when no augmenting path exists', () => {
    // Star: centre 0 with leaves 1..3 — only one edge can be matched.
    const adj = [[1, 2, 3], [0], [0], [0]];
    const match = Int32Array.from([1, 0, -1, -1]);
    augmentMatching(4, adj, match, [2, 3]);
    expect([...match]).toEqual([1, 0, -1, -1]);
  });
});

describe('perceiveBondOrders: residue templates', () => {
  /** Residue from named atoms + bonds by name. */
  function residueMol(resName: string, atoms: [string, string, number, number][], bonds: [string, string][], extra: Partial<AtomInput> = {}) {
    const names = atoms.map((a) => a[0]);
    const input: AtomInput[] = atoms.map(([name, element, x, y]) => ({ name, element, x, y, z: 0, resName, resSeq: 1, chain: 'A', ...extra }));
    return buildMolecule(resName, input, bonds.map(([a, b]) => ({ a: names.indexOf(a), b: names.indexOf(b) })));
  }
  const byName = (mol: Molecule, a: string, b: string) => {
    const i = mol.atoms.findIndex((x) => x.name === a);
    const j = mol.atoms.findIndex((x) => x.name === b);
    return orderOf(mol, i, j);
  };

  function phe() {
    const ring = ['CG', 'CD1', 'CE1', 'CZ', 'CE2', 'CD2'].map((name, k): [string, string, number, number] => {
      const a = Math.PI / 2 + (k * Math.PI) / 3;
      return [name, 'C', 2 + 1.39 * Math.cos(a), -4.2 + 1.39 * Math.sin(a)];
    });
    return residueMol(
      'PHE',
      [['N', 'N', 0, 0], ['CA', 'C', 1.46, 0], ['C', 'C', 2.0, 1.4], ['O', 'O', 3.2, 1.5], ['CB', 'C', 2.0, -1.4], ...ring],
      [['N', 'CA'], ['CA', 'C'], ['C', 'O'], ['CA', 'CB'], ['CB', 'CG'], ['CG', 'CD1'], ['CD1', 'CE1'], ['CE1', 'CZ'], ['CZ', 'CE2'], ['CE2', 'CD2'], ['CD2', 'CG']],
    );
  }

  it('PHE: backbone C=O and aromatic ring, everything else single', () => {
    const mol = perceiveBondOrders(phe());
    expect(byName(mol, 'C', 'O')).toBe(2);
    for (const [a, b] of [['CG', 'CD1'], ['CD1', 'CE1'], ['CE1', 'CZ'], ['CZ', 'CE2'], ['CE2', 'CD2'], ['CD2', 'CG']]) expect(byName(mol, a, b)).toBe(1.5);
    for (const [a, b] of [['N', 'CA'], ['CA', 'C'], ['CA', 'CB'], ['CB', 'CG']]) expect(byName(mol, a, b)).toBe(1);
  });

  it('ASP: one carboxylate C=O; phosphate and cytosine C2=O2 in DNA', () => {
    const asp = perceiveBondOrders(residueMol('ASP', [['CG', 'C', 0, 0], ['OD1', 'O', 1.25, 0], ['OD2', 'O', -0.63, 1.09]], [['CG', 'OD1'], ['CG', 'OD2']]));
    expect(byName(asp, 'CG', 'OD1')).toBe(2);
    expect(byName(asp, 'CG', 'OD2')).toBe(1);
    const dc = perceiveBondOrders(
      residueMol('DC', [['P', 'P', 0, 0], ['OP1', 'O', 1.48, 0], ['OP2', 'O', -0.74, 1.28], ['C2', 'C', 10, 0], ['O2', 'O', 11.24, 0]], [['P', 'OP1'], ['P', 'OP2'], ['C2', 'O2']]),
    );
    expect(byName(dc, 'P', 'OP1')).toBe(2);
    expect(byName(dc, 'P', 'OP2')).toBe(1);
    expect(byName(dc, 'C2', 'O2')).toBe(2);
  });

  describe('residues with explicit hydrogens (MD / NMR files)', () => {
    type Named = [string, number, number, number];
    // Heavy atoms from PDB 1HSG (HIS A69, LYS A14, ARG A8, ASP A25).
    const HIS: Named[] = [
      ['N', 24.449, 42.689, 13.479], ['CA', 23.251, 43.368, 13.013], ['C', 22.009, 43.025, 13.836], ['O', 21.626, 41.865, 13.958],
      ['CB', 22.975, 43.009, 11.568], ['CG', 24.157, 43.172, 10.639], ['ND1', 25.294, 42.398, 10.762], ['CD2', 24.283, 43.886, 9.518],
      ['CE1', 26.075, 42.63, 9.723], ['NE2', 25.505, 43.532, 8.946],
    ];
    const LYS: Named[] = [
      ['N', 22.106, 36.199, 19.087], ['CA', 21.894, 36.545, 20.492], ['C', 20.442, 36.943, 20.615], ['O', 19.96, 37.808, 19.873],
      ['CB', 22.777, 37.724, 20.896], ['CG', 22.727, 38.056, 22.383], ['CD', 23.27, 39.45, 22.678], ['CE', 24.814, 39.49, 22.755], ['NZ', 25.394, 40.891, 22.572],
    ];
    const ARG: Named[] = [
      ['N', 26.992, 23.877, 6.169], ['CA', 25.757, 24.566, 6.593], ['C', 26.029, 26.025, 6.996], ['O', 26.947, 26.291, 7.775],
      ['CB', 25.087, 23.849, 7.776], ['CG', 24.646, 22.409, 7.505], ['CD', 23.728, 21.896, 8.637], ['NE', 22.952, 20.73, 8.23],
      ['CZ', 22.367, 19.871, 9.064], ['NH1', 22.376, 20.074, 10.37], ['NH2', 21.776, 18.789, 8.589],
    ];
    const ASP: Named[] = [
      ['N', 18.626, 30.444, 6.627], ['CA', 17.853, 29.516, 5.837], ['C', 16.945, 30.292, 4.886], ['O', 15.843, 30.678, 5.237],
      ['CB', 17.047, 28.642, 6.811], ['CG', 16.316, 27.513, 6.146], ['OD1', 16.236, 27.458, 4.905], ['OD2', 15.762, 26.696, 6.882],
    ];
    const v = (p: Named): Vec3 => [p[1], p[2], p[3]];
    const at = (res: Named[], name: string) => v(res.find((a) => a[0] === name)!);
    const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    /** H on an sp2 atom with two heavy neighbours (bisector, pointing away). */
    const hBisect = (res: Named[], n: string, a: string, b: string): Vec3 => {
      const p = at(res, n);
      return add(p, scale(unit(add(unit(sub3(p, at(res, a))), unit(sub3(p, at(res, b))))), 1.01));
    };
    /** Three tetrahedral H on a terminal sp3 atom bonded to `x`. */
    const hSp3 = (res: Named[], n: string, x: string): Vec3[] => {
      const p = at(res, n);
      const u = unit(sub3(p, at(res, x)));
      const q = unit(cross3(u, Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
      const w = cross3(u, q);
      const c = Math.cos((70.5 * Math.PI) / 180), s = Math.sin((70.5 * Math.PI) / 180);
      return [0, 120, 240].map((deg) => {
        const t = (deg * Math.PI) / 180;
        return add(p, scale(add(scale(u, c), add(scale(q, s * Math.cos(t)), scale(w, s * Math.sin(t)))), 1.01));
      });
    };
    /** Two H on a terminal sp2 N bonded to `x`, in the plane defined by `x` and `ref`. */
    const hSp2 = (res: Named[], n: string, x: string, ref: string): Vec3[] => {
      const p = at(res, n);
      const u = unit(sub3(p, at(res, x)));
      const normal = cross3(u, sub3(at(res, ref), at(res, x)));
      const w = unit(cross3(normal, u));
      return [1, -1].map((sgn) => add(p, scale(add(scale(u, 0.5), scale(w, sgn * Math.sqrt(3) / 2)), 1.01)));
    };
    const build = (resName: string, heavy: Named[], hs: [string, Vec3][]) => {
      const atoms: AtomInput[] = [
        ...heavy.map(([name, x, y, z]) => ({ name, element: name[0], x, y, z, resName, resSeq: 1, chain: 'A' })),
        ...hs.map(([name, p]) => ({ name, element: 'H', x: p[0], y: p[1], z: p[2], resName, resSeq: 1, chain: 'A' })),
      ];
      return perceiveBondOrders(perceiveBonds(buildMolecule(resName, atoms)));
    };
    const charge = (mol: Molecule, name: string) => mol.atoms.find((a) => a.name === name)!.charge ?? 0;
    const hN = (res: Named[]) => hSp3(res, 'N', 'CA').map((p, k): [string, Vec3] => [`H${k + 1}`, p]);

    it('HIS: picks the tautomer from the ring hydrogens (HID/HSD, HIE, HIP)', () => {
      const hd1: [string, Vec3] = ['HD1', hBisect(HIS, 'ND1', 'CG', 'CE1')];
      const he2: [string, Vec3] = ['HE2', hBisect(HIS, 'NE2', 'CD2', 'CE1')];
      const hid = build('HSD', HIS, [hd1]);
      expect([byName(hid, 'CG', 'CD2'), byName(hid, 'CE1', 'NE2'), byName(hid, 'ND1', 'CE1')]).toEqual([2, 2, 1]);
      const hie = build('HIS', HIS, [he2]);
      expect([byName(hie, 'CG', 'CD2'), byName(hie, 'ND1', 'CE1'), byName(hie, 'CE1', 'NE2')]).toEqual([2, 2, 1]);
      const hip = build('HIP', HIS, [hd1, he2]);
      expect(byName(hip, 'ND1', 'CE1') === 2 || byName(hip, 'CE1', 'NE2') === 2).toBe(true);
      expect(charge(hip, 'ND1') + charge(hip, 'NE2')).toBe(1);
    });

    it('protonated LYS / ARG / N-terminus get +1, deprotonated ASP gets −1', () => {
      const lys = build('LYS', LYS, [...hN(LYS), ...hSp3(LYS, 'NZ', 'CE').map((p, k): [string, Vec3] => [`HZ${k + 1}`, p])]);
      expect(charge(lys, 'NZ')).toBe(1);
      expect(charge(lys, 'N')).toBe(1);
      const arg = build('ARG', ARG, [
        ['HE', hBisect(ARG, 'NE', 'CD', 'CZ')],
        ...hSp2(ARG, 'NH1', 'CZ', 'NE').map((p, k): [string, Vec3] => [`HH1${k + 1}`, p]),
        ...hSp2(ARG, 'NH2', 'CZ', 'NE').map((p, k): [string, Vec3] => [`HH2${k + 1}`, p]),
      ]);
      expect(byName(arg, 'CZ', 'NH2')).toBe(2);
      expect(charge(arg, 'NH2')).toBe(1);
      expect(charge(arg, 'NH1') + charge(arg, 'NE')).toBe(0);
      const asp = build('ASP', ASP, [['H', hBisect(ASP, 'N', 'CA', 'CA')]]);
      expect(charge(asp, 'OD1') + charge(asp, 'OD2')).toBe(-1);
      expect(charge(asp, 'O')).toBe(0);
    });

    it('heavy-atom-only residues get no charges', () => {
      for (const [name, res] of [['LYS', LYS], ['ARG', ARG], ['ASP', ASP], ['HIS', HIS]] as const) {
        const mol = build(name, res, []);
        expect(mol.atoms.every((a) => !a.charge)).toBe(true);
      }
    });

    it('puts the template double bond on the equivalent atom the hydrogens / charges call for', () => {
      const hN1: [string, Vec3] = ['H', hBisect(ASP, 'N', 'CA', 'CA')];
      /** H on a terminal O, continuing the C–O direction. */
      const hOn = (res: Named[], o: string, c: string): Vec3 => add(at(res, o), scale(unit(sub3(at(res, o), at(res, c))), 0.97));
      // ASH / GLH with the acid H on OD1 (not the usual OD2): neutral, C=O moves to OD2.
      const ash = build('ASH', ASP, [hN1, ['HD1', hOn(ASP, 'OD1', 'CG')]]);
      expect([byName(ash, 'CG', 'OD1'), byName(ash, 'CG', 'OD2')]).toEqual([1, 2]);
      expect(ash.atoms.every((a) => !a.charge)).toBe(true);
      // Neutral ARG (ARN): one H on NH1, two on NH2 → CZ=NH1, no charge.
      const arn = build('ARN', ARG, [
        ['HE', hBisect(ARG, 'NE', 'CD', 'CZ')],
        ['HH11', hSp2(ARG, 'NH1', 'CZ', 'NE')[0]],
        ...hSp2(ARG, 'NH2', 'CZ', 'NE').map((p, k): [string, Vec3] => [`HH2${k + 1}`, p]),
      ]);
      expect([byName(arn, 'CZ', 'NH1'), byName(arn, 'CZ', 'NH2')]).toEqual([2, 1]);
      expect(arn.atoms.every((a) => !a.charge)).toBe(true);
      // A file charge on OD1: OD1 stays single, the residue carries −1 in total.
      const charged = buildMolecule('ASP', ASP.map(([name, x, y, z]) => ({ name, element: name[0], x, y, z, resName: 'ASP', resSeq: 1, chain: 'A', ...(name === 'OD1' ? { charge: -1 } : {}) })));
      const asp = perceiveBondOrders(perceiveBonds(charged));
      expect([byName(asp, 'CG', 'OD1'), byName(asp, 'CG', 'OD2')]).toEqual([1, 2]);
    });

    it('reads CHARMM (OT1/OT2) and GROMACS (OC1/OC2) C-terminal carboxylates', () => {
      const c = at(ASP, 'C');
      const ot2 = add(c, scale(unit(add(unit(sub3(c, at(ASP, 'CA'))), unit(sub3(c, at(ASP, 'O'))))), 1.25));
      for (const [o1, o2] of [['OT1', 'OT2'], ['OC1', 'OC2']]) {
        const heavy: Named[] = [...ASP.map((p): Named => (p[0] === 'O' ? [o1, p[1], p[2], p[3]] : p)), [o2, ...ot2]];
        const mol = build('ASP', heavy, [['H', hBisect(ASP, 'N', 'CA', 'CA')]]);
        expect(byName(mol, 'C', o1)).toBe(2);
        expect(charge(mol, o2)).toBe(-1);
      }
    });
  });

  it('skips templates for implausibly long bonds and for residues with explicit orders', () => {
    const long = perceiveBondOrders(residueMol('ASP', [['CG', 'C', 0, 0], ['OD1', 'O', 1.45, 0]], [['CG', 'OD1']]));
    expect(byName(long, 'CG', 'OD1')).toBe(1);
    const base = phe();
    const explicit = { ...base, bonds: base.bonds.map((b, i) => (i === 3 ? { ...b, order: 2 as const } : b)) };
    expect(perceiveBondOrders(explicit)).toBe(explicit);
  });
});

describe('perceiveBonds: ionic contacts', () => {
  /** Atom with a formal charge (0 = none). */
  const ch = (element: string, x: number, y: number, z: number, charge = 0, extra: Partial<AtomInput> = {}): AtomInput => ({
    element,
    x,
    y,
    z,
    ...(charge ? { charge } : {}),
    ...extra,
  });
  /** Distance well inside the strict (metal) cutoff of a pair. */
  const contact = (a: string, b: string) => covalentRadius(a) + covalentRadius(b) + 0.1;
  const elements = (mol: Molecule) =>
    mol.bonds.map((b) => [mol.atoms[b.a - 1].element, mol.atoms[b.b - 1].element].sort().join('-')).sort();

  it('does not bond an alkali / alkaline-earth cation to an anion (rock salt, MgO)', () => {
    const d = contact('Na', 'Cl');
    const nacl = (qNa: number, qCl: number) =>
      perceiveBonds(buildMolecule('NaCl', [ch('Na', 0, 0, 0, qNa), ch('Cl', d, 0, 0, qCl), ch('Na', d, d, 0, qNa), ch('Cl', 0, d, 0, qCl)]));
    expect(nacl(1, -1).bonds).toHaveLength(0);
    // Neutral atoms (no ionic information) still bond by distance, as before.
    expect(nacl(0, 0).bonds).toHaveLength(4);
    // Only opposite charges are ionic partners.
    expect(nacl(1, 0).bonds).toHaveLength(4);
    const e = contact('Mg', 'O');
    expect(perceiveBonds(buildMolecule('MgO', [ch('Mg', 0, 0, 0, 2), ch('O', e, 0, 0, -2)])).bonds).toHaveLength(0);
  });

  it('keeps the covalent bonds of polyatomic ions next to the cations', () => {
    // Sodium nitrate with formal charges: N⁺(=O)(O⁻)O⁻, Na⁺ in contact with one O⁻.
    const o = (k: number): Vec3 => [1.25 * Math.cos((2 * Math.PI * k) / 3), 1.25 * Math.sin((2 * Math.PI * k) / 3), 0];
    const [o0, o1, o2] = [o(0), o(1), o(2)];
    const na: Vec3 = [o0[0] + contact('Na', 'O'), 0, 0];
    const nitrate = perceiveBonds(
      buildMolecule('NaNO3', [ch('N', 0, 0, 0, 1), ch('O', ...o0, -1), ch('O', ...o1, -1), ch('O', ...o2), ch('Na', ...na, 1)]),
    );
    expect(elements(nitrate)).toEqual(['N-O', 'N-O', 'N-O']);
    // The same with crystal-CIF oxidation states (N5+, O2-).
    const ox = perceiveBonds(buildMolecule('NaNO3', [ch('N', 0, 0, 0, 5), ch('O', ...o0, -2), ch('O', ...o1, -2), ch('O', ...o2, -2), ch('Na', ...na, 1)]));
    expect(elements(ox)).toEqual(['N-O', 'N-O', 'N-O']);
    // Ammonium chloride with oxidation states (N3-, H1+, Cl1-): N–H bonds stay.
    const t = 1.03 / Math.sqrt(3);
    const nh4 = perceiveBonds(
      buildMolecule('NH4Cl', [
        ch('N', 0, 0, 0, -3),
        ch('H', t, t, t, 1),
        ch('H', -t, -t, t, 1),
        ch('H', -t, t, -t, 1),
        ch('H', t, -t, -t, 1),
        ch('Cl', 3.3 / Math.sqrt(3), 3.3 / Math.sqrt(3), 3.3 / Math.sqrt(3), -1),
      ]),
    );
    expect(elements(nh4)).toEqual(['H-N', 'H-N', 'H-N', 'H-N']);
    // K2SiF6 written with oxidation states (Si4+, F1-, K1+): Si–F stays, K–F is ionic.
    const f = 1.68;
    const sif6 = perceiveBonds(
      buildMolecule('K2SiF6', [
        ch('Si', 0, 0, 0, 4),
        ...([[f, 0, 0], [-f, 0, 0], [0, f, 0], [0, -f, 0], [0, 0, f], [0, 0, -f]] as Vec3[]).map((p) => ch('F', ...p, -1)),
        ch('K', f + contact('K', 'F'), 0, 0, 1),
      ]),
    );
    expect(elements(sif6)).toEqual(Array(6).fill('F-Si'));
  });

  it('keeps metal coordination: Zn–S(Cys), heme Fe–N, Zn²⁺–Cl⁻, Mg²⁺–water', () => {
    const d = covalentRadius('Zn') + covalentRadius('S') + 0.1;
    const s = d / Math.sqrt(3);
    const cys = (k: number, p: Vec3): AtomInput => ch('S', ...p, 0, { name: 'SG', resName: 'CYS', resSeq: k, chain: 'A' });
    const zn = perceiveBonds(
      buildMolecule('zinc finger', [
        ch('Zn', 0, 0, 0, 2, { name: 'ZN', resName: 'ZN', resSeq: 101, chain: 'A', hetero: true }),
        cys(1, [s, s, s]),
        cys(2, [-s, -s, s]),
        cys(3, [-s, s, -s]),
        ch('Cl', ...(scale([1, -1, -1], contact('Zn', 'Cl') / Math.sqrt(3)) as [number, number, number]), -1, {
          name: 'CL',
          resName: 'CL',
          resSeq: 102,
          chain: 'A',
          hetero: true,
        }),
      ]),
    );
    expect(elements(zn)).toEqual(['Cl-Zn', 'S-Zn', 'S-Zn', 'S-Zn']);
    // Heme iron with charged pyrrole nitrogens (Fe²⁺ / N⁻ as some component dictionaries write them).
    const fe = 2.0;
    const heme = perceiveBonds(
      buildMolecule('heme', [
        ch('Fe', 0, 0, 0, 2, { name: 'FE', resName: 'HEM', resSeq: 1, hetero: true }),
        ...([[fe, 0, 0, -1], [-fe, 0, 0, -1], [0, fe, 0, 0], [0, -fe, 0, 0]] as [number, number, number, number][]).map(([x, y, z, q], k) =>
          ch('N', x, y, z, q, { name: 'N' + 'ABCD'[k], resName: 'HEM', resSeq: 1, hetero: true }),
        ),
      ]),
    );
    expect(elements(heme)).toEqual(Array(4).fill('Fe-N'));
    // Mg²⁺ to neutral water oxygens is coordination as before.
    const w = contact('Mg', 'O');
    const mg = perceiveBonds(
      buildMolecule('Mg(H2O)', [
        ch('Mg', 0, 0, 0, 2, { resName: 'MG', resSeq: 1, hetero: true }),
        ch('O', w, 0, 0, 0, { resName: 'HOH', resSeq: 2, hetero: true }),
        ch('O', -w, 0, 0, 0, { resName: 'HOH', resSeq: 3, hetero: true }),
      ]),
    );
    expect(elements(mg)).toEqual(['Mg-O', 'Mg-O']);
  });

  it('treats a cation with file bonds as part of a molecule', () => {
    const d = contact('Li', 'O');
    const mol = buildMolecule('LiC', [ch('Li', 0, 0, 0, 1), ch('C', 2.0, 0, 0), ch('O', -d, 0, 0, -1)], [{ a: 0, b: 1, order: 1 }]);
    expect(elements(perceiveBonds(mol))).toEqual(['C-Li', 'Li-O']);
  });

  it('keeps Mg–N of chlorophyll written with Mg²⁺ / N⁻ (cation inside an organic residue)', () => {
    // Same charge pattern as the heme test above, with magnesium: mmCIF / prepared PDB entries give
    // no Mg–N connectivity, so the Mg is not a free ion just because the file has no bonds for it.
    const r = { resName: 'CLA', resSeq: 1, chain: 'A', hetero: true };
    const d = 2.05;
    const cla = perceiveBonds(
      buildMolecule('chlorophyll core', [
        ch('Mg', 0, 0, 0, 2, { name: 'MG', ...r }),
        ch('N', d, 0, 0, -1, { name: 'NA', ...r }),
        ch('N', -d, 0, 0, -1, { name: 'NC', ...r }),
        ch('N', 0, d, 0, 0, { name: 'NB', ...r }),
        ch('N', 0, -d, 0, 0, { name: 'ND', ...r }),
        ch('C', d + 1.38, 0, 0, 0, { name: 'C1A', ...r }),
      ]),
    );
    expect(elements(cla)).toEqual(['C-N', 'Mg-N', 'Mg-N', 'Mg-N', 'Mg-N']);
    // A carbon-free residue is still a lattice: the rock salt exported to PDB comes back as one UNL residue.
    const e = contact('Na', 'Cl');
    const unl = (k: number) => ({ resName: 'UNL', resSeq: 1, chain: 'A', hetero: true, name: k % 2 ? 'CL' : 'NA' });
    const lattice = perceiveBonds(
      buildMolecule('NaCl', [ch('Na', 0, 0, 0, 1, unl(0)), ch('Cl', e, 0, 0, -1, unl(1)), ch('Na', e, e, 0, 1, unl(2)), ch('Cl', 0, e, 0, -1, unl(3))]),
    );
    expect(lattice.bonds).toHaveLength(0);
    // A residue whose bonds the file gives (sodium acetate exported to PDB with CONECT): the
    // unbonded Na⁺ is a free ion, also when it shares the UNL residue with carbon.
    const acetate = buildMolecule(
      'NaOAc',
      [
        ch('C', 0, 0, 0, 0, unl(0)),
        ch('C', 1.52, 0, 0, 0, unl(0)),
        ch('O', 2.15, 1.08, 0, 0, unl(0)),
        ch('O', 2.15, -1.08, 0, -1, unl(0)),
        ch('Na', 2.15 + contact('Na', 'O') - 0.2, -1.08, 0, 1, unl(0)),
      ],
      [{ a: 0, b: 1, order: 1 }, { a: 1, b: 2, order: 2 }, { a: 1, b: 3, order: 1 }],
    );
    expect(elements(perceiveBonds(acetate))).toEqual(['C-C', 'C-O', 'C-O']);
  });

  describe('polymer files with formal charges (Maestro-prepared PDBs, CCD charges)', () => {
    const res = (resName: string, resSeq: number, hetero = false) => (name: string) => ({ name, resName, resSeq, chain: 'A', hetero });
    const ion = (element: string, p: Vec3, charge: number, resSeq: number) =>
      ch(element, ...p, charge, { name: element.toUpperCase(), resName: element.toUpperCase(), resSeq, chain: 'A', hetero: true });
    /** Asp side chain with OD2⁻ at (2.4, 0, 0), as preparation tools write it, and the backbone CA. */
    const aspartate = (): AtomInput[] => {
      const r = res('ASP', 10);
      return [
        ch('C', 1.6, 3.6, 0, 0, r('CA')),
        ch('C', 2.5, 2.4, 0, 0, r('CB')),
        ch('C', 3.1, 1.03, 0, 0, r('CG')),
        ch('O', 4.35, 1.0, 0, 0, r('OD1')),
        ch('O', 2.4, 0, 0, -1, r('OD2')),
      ];
    };

    it('keeps Ca²⁺ / Mg²⁺ coordination to charged Asp / Glu, phosphate and ligand oxygens', () => {
      // Ca²⁺ on Asp OD2⁻ (2.4 Å) in a protein.
      const ca = perceiveBonds(buildMolecule('Ca site', [ion('Ca', [0, 0, 0], 2, 201), ...aspartate()]));
      expect(elements(ca)).toEqual(['C-C', 'C-C', 'C-O', 'C-O', 'Ca-O']);
      // Mg²⁺ on Glu OE2⁻.
      const g = res('GLU', 11);
      const glu = perceiveBonds(
        buildMolecule('Mg site', [
          ion('Mg', [0, 0, 0], 2, 202),
          ch('C', 2.85, 1.0, 0, 0, g('CD')),
          ch('O', 4.1, 1.0, 0, 0, g('OE1')),
          ch('O', 2.1, 0, 0, -1, g('OE2')),
          ch('C', 2.2, 2.35, 0, 0, g('CG')),
        ]),
      );
      expect(elements(glu)).toEqual(['C-C', 'C-O', 'C-O', 'Mg-O']);
      // Mg²⁺ on a phosphate OP2⁻ of DNA.
      const d = res('DA', 5);
      const dna = perceiveBonds(
        buildMolecule('Mg-DNA', [
          ch('P', 0, 0, 0, 0, d('P')),
          ch('O', 1.48, 0, 0, 0, d('OP1')),
          ch('O', -0.5, 1.4, 0, -1, d('OP2')),
          ch('O', -0.5, -0.75, 1.25, 0, d("O5'")),
          ion('Mg', [-0.5, 3.5, 0], 2, 301),
        ]),
      );
      expect(elements(dna)).toEqual(['Mg-O', 'O-P', 'O-P', 'O-P']);
      // Mg²⁺ on the γ-phosphate O⁻ of an ATP ligand bound to a protein.
      const atp = res('ATP', 401, true);
      const kinase = perceiveBonds(
        buildMolecule('Mg-ATP', [
          ...aspartate().map((a) => (a.name === 'OD2' ? { ...a, charge: undefined } : a)).map((a) => ({ ...a, x: a.x + 20 })),
          ch('P', 0, 0, 0, 0, atp('PG')),
          ch('O', 1.48, 0, 0, 0, atp('O1G')),
          ch('O', -0.5, 1.4, 0, -1, atp('O2G')),
          ion('Mg', [-0.5, 3.5, 0], 2, 402),
        ]),
      );
      expect(elements(kinase)).toEqual(['C-C', 'C-C', 'C-O', 'C-O', 'Mg-O', 'O-P', 'O-P']);
    });

    it('still leaves contacts between monatomic ions bond-less (Na⁺ / Cl⁻ next to a protein)', () => {
      const e = contact('Na', 'Cl');
      const mol = perceiveBonds(buildMolecule('NaCl + Asp', [ion('Na', [10, 0, 0], 1, 501), ion('Cl', [10 + e, 0, 0], -1, 502), ...aspartate()]));
      expect(elements(mol)).toEqual(['C-C', 'C-C', 'C-O', 'C-O']);
      // Na⁺ on the Asp carboxylate is coordination in a protein, like Ca²⁺.
      const na = perceiveBonds(buildMolecule('Na site', [ion('Na', [0, 0, 0], 1, 501), ...aspartate()]));
      expect(elements(na)).toEqual(['C-C', 'C-C', 'C-O', 'C-O', 'Na-O']);
    });
  });
});
