import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildMolecule, type AtomInput } from '../../core/molecule';
import type { Molecule, SecondaryStructure } from '../../core/types';
import { computeAtomColors } from '../colors';
import { ARROW_WIDTH_FACTOR, SECTIONS, buildCartoon, extractSegments } from './cartoon';
import { catmullRom } from './spline';

// ---------------------------------------------------------------------------
// Ideal backbone builder (NeRF) with Engh & Huber geometry
// ---------------------------------------------------------------------------

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const deg = Math.PI / 180;

/** Place D from A, B, C given |CD|, angle BCD and dihedral ABCD (degrees). */
function place(a: V, b: V, c: V, len: number, angle: number, torsion: number): V {
  const bc = norm(sub(c, b));
  const n = norm(cross(sub(b, a), bc));
  const m = cross(n, bc);
  const d2 = [-len * Math.cos(angle * deg), len * Math.sin(angle * deg) * Math.cos(torsion * deg), len * Math.sin(angle * deg) * Math.sin(torsion * deg)];
  return [c[0] + d2[0] * bc[0] + d2[1] * m[0] + d2[2] * n[0], c[1] + d2[0] * bc[1] + d2[1] * m[1] + d2[2] * n[1], c[2] + d2[0] * bc[2] + d2[1] * m[2] + d2[2] * n[2]];
}

const PHI_PSI: Record<SecondaryStructure, [number, number]> = {
  helix: [-57, -47],
  sheet: [-120, 130],
  coil: [-70, 145],
};

/** Backbone atoms (N, CA, C, O) for the given per-residue secondary structure. */
function backbone(ss: SecondaryStructure[], chain = 'A', offset: V = [0, 0, 0], firstSeq = 1): AtomInput[] {
  const out: AtomInput[] = [];
  let N: V = [0, 0, 0];
  let CA: V = [1.458, 0, 0];
  let C: V = place([0, 1, 0], N, CA, 1.525, 111.2, -60);
  const res: { N: V; CA: V; C: V }[] = [{ N, CA, C }];
  for (let i = 1; i < ss.length; i++) {
    const psi = PHI_PSI[ss[i - 1]][1];
    const phi = PHI_PSI[ss[i]][0];
    const n2 = place(N, CA, C, 1.329, 116.2, psi);
    const ca2 = place(CA, C, n2, 1.458, 121.7, 180);
    const c2 = place(C, n2, ca2, 1.525, 111.2, phi);
    N = n2;
    CA = ca2;
    C = c2;
    res.push({ N, CA, C });
  }
  res.forEach((r, i) => {
    const next = res[i + 1];
    const O = next ? place(next.N, r.CA, r.C, 1.231, 120.5, 180) : place(r.N, r.CA, r.C, 1.231, 120.5, PHI_PSI[ss[i]][1] + 180);
    for (const [name, p] of [['N', r.N], ['CA', r.CA], ['C', r.C], ['O', O]] as const) {
      out.push({
        element: name[0],
        name,
        x: p[0] + offset[0],
        y: p[1] + offset[1],
        z: p[2] + offset[2],
        resName: 'ALA',
        resSeq: firstSeq + i,
        chain,
        ss: ss[i],
      });
    }
  });
  return out;
}

const repeat = (s: SecondaryStructure, n: number) => Array<SecondaryStructure>(n).fill(s);
const allMask = (mol: Molecule) => new Uint8Array(mol.atoms.length).fill(1);
const caIndices = (mol: Molecule) => mol.atoms.flatMap((a, i) => (a.name === 'CA' ? [i] : []));

function build(mol: Molecule, mask = allMask(mol), scale = 1, quality: 'low' | 'medium' | 'high' = 'medium') {
  const colors = computeAtomColors(mol, 'secondary', '#ffffff');
  return buildCartoon(mol, mask, colors, { opacity: 1, quality, scale }) as THREE.Mesh | null;
}

/** Structural checks shared by all tests. */
function checkMesh(mesh: THREE.Mesh) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const col = g.getAttribute('color');
  const idx = g.getIndex()!;
  const vai = mesh.userData.vertexAtomIndex as Int32Array;
  expect(pos.count).toBeGreaterThan(0);
  expect(vai).toBeInstanceOf(Int32Array);
  expect(vai.length).toBe(pos.count);
  expect(nrm.count).toBe(pos.count);
  expect(col.count).toBe(pos.count);
  for (let i = 0; i < pos.count * 3; i++) {
    expect(Number.isFinite(pos.array[i])).toBe(true);
    expect(Number.isFinite(nrm.array[i])).toBe(true);
    expect(col.array[i]).toBeGreaterThanOrEqual(0);
    expect(col.array[i]).toBeLessThanOrEqual(1);
  }
  for (let i = 0; i < nrm.count; i++) expect(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))).toBeCloseTo(1, 4);
  expect(idx.count % 3).toBe(0);
  for (let i = 0; i < idx.count; i++) expect(idx.array[i]).toBeLessThan(pos.count);
  // Triangle winding agrees with the vertex normals (outward-facing).
  let agree = 0;
  let total = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.array[t], i1 = idx.array[t + 1], i2 = idx.array[t + 2];
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1).sub(a);
    c.fromBufferAttribute(pos, i2).sub(a);
    const face = b.cross(c);
    if (face.lengthSq() < 1e-12) continue; // degenerate (e.g. zero-width annulus edge)
    n.fromBufferAttribute(nrm, i0).add(new THREE.Vector3().fromBufferAttribute(nrm, i1)).add(new THREE.Vector3().fromBufferAttribute(nrm, i2));
    total++;
    if (face.dot(n) > 0) agree++;
  }
  expect(agree / total).toBeGreaterThan(0.99);
  return { pos, vai };
}

/** Max distance of the vertices from a densely sampled Catmull-Rom curve through `pts`. */
function maxDistanceFromCurve(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, pts: Float64Array, filter?: (i: number) => boolean) {
  const n = pts.length / 3;
  const samples: number[] = [];
  const o = new Float64Array(3);
  for (let k = 0; k < n - 1; k++) for (let s = 0; s < 40; s++) {
    catmullRom(pts, n, k, s / 40, o, 0);
    samples.push(o[0], o[1], o[2]);
  }
  samples.push(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1], pts[(n - 1) * 3 + 2]);
  let max = 0;
  for (let i = 0; i < pos.count; i++) {
    if (filter && !filter(i)) continue;
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let best = Infinity;
    for (let s = 0; s < samples.length; s += 3) best = Math.min(best, (x - samples[s]) ** 2 + (y - samples[s + 1]) ** 2 + (z - samples[s + 2]) ** 2);
    max = Math.max(max, Math.sqrt(best));
  }
  return max;
}

function caPoints(mol: Molecule): Float64Array {
  const cas = caIndices(mol);
  const p = new Float64Array(cas.length * 3);
  cas.forEach((ai, i) => {
    p[i * 3] = mol.atoms[ai].x;
    p[i * 3 + 1] = mol.atoms[ai].y;
    p[i * 3 + 2] = mol.atoms[ai].z;
  });
  return p;
}

describe('test backbone builder', () => {
  it('produces ideal α-helix geometry', () => {
    const mol = buildMolecule('h', backbone(repeat('helix', 12)));
    const p = caPoints(mol);
    const d = (i: number, j: number) => Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);
    expect(d(0, 1)).toBeCloseTo(3.8, 1); // trans peptide CA–CA
    expect(d(0, 3)).toBeGreaterThan(4.8); // i → i+3 ≈ 5.0–5.4 Å in an α-helix
    expect(d(0, 3)).toBeLessThan(5.6);
    expect(d(0, 4)).toBeGreaterThan(5.8); // i → i+4 ≈ 6.2 Å
    expect(d(0, 4)).toBeLessThan(6.6);
  });
});

describe('buildCartoon', () => {
  it('builds a closed ribbon for an ideal helix', () => {
    const mol = buildMolecule('helix', backbone(repeat('helix', 20)));
    const mesh = build(mol)!;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    const { pos, vai } = checkMesh(mesh);
    const cas = new Set(caIndices(mol));
    for (const v of vai) expect(cas.has(v)).toBe(true);
    // Every residue is represented.
    expect(new Set(vai).size).toBe(20);
    // Helix ribbon half-width is 0.8 Å around the CA spline.
    const max = maxDistanceFromCurve(pos, caPoints(mol));
    expect(max).toBeGreaterThan(SECTIONS.helix.a - 0.05);
    expect(max).toBeLessThan(SECTIONS.helix.a + 0.05);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.vertexColors).toBe(true);
    expect(mat.transparent).toBe(false);
    expect(mat.side).toBe(THREE.DoubleSide);
  });

  it('scales the cross-section and honours opacity', () => {
    const mol = buildMolecule('helix', backbone(repeat('helix', 10)));
    const colors = computeAtomColors(mol, 'chain', '#ffffff');
    const mesh = buildCartoon(mol, allMask(mol), colors, { opacity: 0.5, quality: 'low', scale: 2 }) as THREE.Mesh;
    checkMesh(mesh);
    const max = maxDistanceFromCurve(mesh.geometry.getAttribute('position'), caPoints(mol));
    expect(max).toBeCloseTo(2 * SECTIONS.helix.a, 1);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBe(0.5);
    expect(mat.depthWrite).toBe(false);
  });

  it('draws a coil as a round tube of radius 0.25', () => {
    const mol = buildMolecule('coil', backbone(repeat('coil', 10)));
    const mesh = build(mol)!;
    const { pos } = checkMesh(mesh);
    expect(maxDistanceFromCurve(pos, caPoints(mol))).toBeCloseTo(SECTIONS.coil.a, 2);
  });

  it('draws β-strands with an arrowhead on the last strand residue', () => {
    const ss: SecondaryStructure[] = [...repeat('coil', 3), ...repeat('sheet', 7), ...repeat('coil', 3)];
    const mol = buildMolecule('strand', backbone(ss));
    const mesh = build(mol)!;
    const { pos, vai } = checkMesh(mesh);
    const cas = caIndices(mol);
    // Guide points: strand CAs smoothed with [1 2 1]/4, as in the implementation.
    const raw = caPoints(mol);
    const g = raw.slice();
    for (let i = 1; i < ss.length - 1; i++) if (ss[i] === 'sheet') for (let c = 0; c < 3; c++) g[i * 3 + c] = 0.25 * raw[(i - 1) * 3 + c] + 0.5 * raw[i * 3 + c] + 0.25 * raw[(i + 1) * 3 + c];
    const lastStrand = cas[9];
    const arrow = maxDistanceFromCurve(pos, g, (i) => vai[i] === lastStrand);
    const arrowHalfWidth = SECTIONS.sheet.a * ARROW_WIDTH_FACTOR;
    expect(arrow).toBeGreaterThan(arrowHalfWidth - 0.05);
    expect(arrow).toBeLessThan(arrowHalfWidth + 0.05);
    const body = maxDistanceFromCurve(pos, g, (i) => vai[i] === cas[6]);
    expect(body).toBeGreaterThan(SECTIONS.sheet.a - 0.05);
    expect(body).toBeLessThan(SECTIONS.sheet.a + 0.05);
    // The smoothing flattens the pleat: smoothed strand guide points are nearly collinear.
    const mid = [5, 6, 7].map((i) => new THREE.Vector3(g[i * 3], g[i * 3 + 1], g[i * 3 + 2]));
    const dev = new THREE.Line3(mid[0], mid[2]).closestPointToPoint(mid[1], true, new THREE.Vector3()).distanceTo(mid[1]);
    expect(dev).toBeLessThan(0.3);
  });

  it('breaks segments at chain gaps and honours the mask', () => {
    const atoms = [...backbone(repeat('helix', 10)), ...backbone(repeat('helix', 10), 'A', [30, 0, 0], 20)];
    const mol = buildMolecule('gap', atoms);
    expect(extractSegments(mol, allMask(mol)).map((s) => s.guide.length)).toEqual([10, 10]);
    const mesh = build(mol)!;
    const { pos } = checkMesh(mesh);
    // No geometry spans the 30 Å gap between the two pieces (first ends near x≈?, second starts at x≥30).
    const firstMaxX = Math.max(...backbone(repeat('helix', 10)).map((a) => a.x));
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      expect(x < firstMaxX + 1.5 || x > 30 - 1.5).toBe(true);
    }

    // Mask: only residues 3..8 of the first piece.
    const mask = new Uint8Array(mol.atoms.length);
    const cas = caIndices(mol);
    for (let r = 2; r < 8; r++) mask[cas[r]] = 1;
    const part = build(mol, mask)!;
    const { vai } = checkMesh(part);
    expect([...new Set(vai)].sort((a, b) => a - b)).toEqual(cas.slice(2, 8));
    // A single isolated residue cannot form a ribbon.
    const one = new Uint8Array(mol.atoms.length);
    one[cas[4]] = 1;
    expect(build(mol, one)).toBeNull();
  });

  it('separates chains and uses CA-only orientation fallbacks', () => {
    const atoms = [...backbone(repeat('helix', 8), 'A'), ...backbone(repeat('sheet', 8), 'B', [0, 40, 0])].filter((a) => a.name === 'CA');
    const mol = buildMolecule('ca-only', atoms);
    expect(extractSegments(mol, allMask(mol))).toHaveLength(2);
    checkMesh(build(mol)!);
  });

  it('draws nucleic acids as a tube through the phosphates', () => {
    const atoms: AtomInput[] = [];
    for (let i = 0; i < 12; i++) {
      const t = i * 36 * deg; // B-DNA: 36° twist, 3.4 Å rise, P radius ≈ 8.9 Å → P–P ≈ 6.4 Å
      atoms.push({ element: 'P', name: 'P', x: 8.9 * Math.cos(t), y: 8.9 * Math.sin(t), z: 3.4 * i, resName: 'DA', resSeq: i + 1, chain: 'B' });
      atoms.push({ element: 'C', name: "C4'", x: 7.5 * Math.cos(t + 0.2), y: 7.5 * Math.sin(t + 0.2), z: 3.4 * i + 1, resName: 'DA', resSeq: i + 1, chain: 'B' });
    }
    const mol = buildMolecule('dna', atoms);
    const mesh = build(mol)!;
    const { pos, vai } = checkMesh(mesh);
    const ps = mol.atoms.flatMap((a, i) => (a.name === 'P' ? [i] : []));
    expect([...new Set(vai)].sort((a, b) => a - b)).toEqual(ps);
    const p = new Float64Array(ps.flatMap((i) => [mol.atoms[i].x, mol.atoms[i].y, mol.atoms[i].z]));
    expect(maxDistanceFromCurve(pos, p)).toBeCloseTo(SECTIONS.nucleic.a, 2);
  });

  it('returns null when there is nothing to draw', () => {
    const lig = buildMolecule('lig', [{ element: 'C', x: 0, y: 0, z: 0, name: 'C1', resName: 'LIG', resSeq: 1, hetero: true }]);
    expect(build(lig)).toBeNull();
    const mol = buildMolecule('helix', backbone(repeat('helix', 5)));
    expect(build(mol, new Uint8Array(mol.atoms.length))).toBeNull();
  });

  it('handles 10k residues quickly', () => {
    // 50 chains × 200 residues with mixed secondary structure.
    const pattern: SecondaryStructure[] = [...repeat('coil', 4), ...repeat('helix', 14), ...repeat('coil', 4), ...repeat('sheet', 6), ...repeat('coil', 2)];
    const ss = Array.from({ length: 200 }, (_, i) => pattern[i % pattern.length]);
    const one = backbone(ss);
    const atoms: AtomInput[] = [];
    for (let c = 0; c < 50; c++) {
      const chain = String.fromCharCode(65 + (c % 26)) + (c >= 26 ? '2' : '');
      for (const a of one) atoms.push({ ...a, chain, x: a.x + (c % 10) * 60, y: a.y + Math.floor(c / 10) * 60 });
    }
    const mol = buildMolecule('big', atoms);
    const colors = computeAtomColors(mol, 'chain', '#ffffff');
    const mask = allMask(mol);
    buildCartoon(mol, mask, colors, { opacity: 1, quality: 'low', scale: 1 }); // warm up the JIT
    const t0 = performance.now();
    const mesh = buildCartoon(mol, mask, colors, { opacity: 1, quality: 'medium', scale: 1 }) as THREE.Mesh;
    const ms = performance.now() - t0;
    const verts = mesh.geometry.getAttribute('position').count;
    console.log(`cartoon: 10k residues → ${verts} vertices in ${ms.toFixed(0)} ms`);
    expect(new Set(mesh.userData.vertexAtomIndex as Int32Array).size).toBe(10000);
    expect(ms).toBeLessThan(3000); // ≈ 90 ms on an idle laptop (target < 300 ms); loose bound for loaded CI machines
  });
});
