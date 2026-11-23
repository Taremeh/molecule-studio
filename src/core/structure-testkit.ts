/**
 * Test-only geometry builders for the structure module (bonding, secondary structure, selection
 * tests). Not used by the app. OWNER: structure agent.
 */
import type { Vec3 } from './types';
import type { AtomInput } from './molecule';

// ---------------------------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------------------------

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => scale(a, 1 / norm(a));
export const distance = (a: Vec3, b: Vec3) => norm(sub(a, b));
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Any unit vector perpendicular to v. */
export function perpendicular(v: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(cross(v, ref));
}

/** Rotate v about a unit axis by `deg` degrees (Rodrigues). */
export function rotate(v: Vec3, axis: Vec3, deg: number): Vec3 {
  const t = rad(deg);
  const c = Math.cos(t);
  const s = Math.sin(t);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

/**
 * NeRF (natural extension reference frame): position of atom D given A, B, C, the bond length
 * |CD|, the angle B–C–D and the torsion A–B–C–D (degrees).
 */
export function placeAtom(a: Vec3, b: Vec3, c: Vec3, bond: number, angle: number, torsion: number): Vec3 {
  const bc = unit(sub(c, b));
  const nrm = unit(cross(sub(b, a), bc));
  const m2 = cross(nrm, bc);
  const th = rad(angle);
  const ph = rad(torsion);
  const d2: Vec3 = [-bond * Math.cos(th), bond * Math.sin(th) * Math.cos(ph), bond * Math.sin(th) * Math.sin(ph)];
  return [
    c[0] + bc[0] * d2[0] + m2[0] * d2[1] + nrm[0] * d2[2],
    c[1] + bc[1] * d2[0] + m2[1] * d2[1] + nrm[1] * d2[2],
    c[2] + bc[2] * d2[0] + m2[2] * d2[1] + nrm[2] * d2[2],
  ];
}

// ---------------------------------------------------------------------------------------------
// Small molecules
// ---------------------------------------------------------------------------------------------

export type XYZ = [string, number, number, number?];

export function atomsFrom(list: XYZ[], extra: Partial<AtomInput> = {}): AtomInput[] {
  return list.map(([element, x, y, z]) => ({ element, x, y, z: z ?? 0, ...extra }));
}

/** H on a trigonal (sp2) atom with two heavy neighbours: along the outward bisector. */
export function hTrigonal(c: Vec3, n1: Vec3, n2: Vec3, len = 1.08): Vec3 {
  return add(c, scale(unit(add(unit(sub(c, n1)), unit(sub(c, n2)))), len));
}

/**
 * Three tetrahedral H atoms on atom c bonded to x (methyl). `ref` fixes the rotation about the
 * c–x axis (default: any perpendicular).
 */
export function hMethyl(c: Vec3, x: Vec3, len = 1.09, ref?: Vec3): Vec3[] {
  const axis = unit(sub(c, x));
  const p = ref ? unit(sub(ref, scale(axis, dot(ref, axis)))) : perpendicular(axis);
  // H–C–X angle 109.47°: component along the axis is cos(70.53°) = 1/3.
  const out: Vec3[] = [];
  for (let k = 0; k < 3; k++) {
    const dir = add(scale(axis, 1 / 3), scale(rotate(p, axis, 120 * k), Math.sqrt(8) / 3));
    out.push(add(c, scale(dir, len)));
  }
  return out;
}

/** Two H atoms on a terminal trigonal atom c (=CH2), in the plane spanned by c–x and `inPlane`. */
export function hTerminalTrigonal(c: Vec3, x: Vec3, inPlane: Vec3, len = 1.08): Vec3[] {
  const axis = unit(sub(c, x));
  const p = unit(sub(inPlane, scale(axis, dot(inPlane, axis))));
  const h1 = add(scale(axis, Math.cos(rad(58.5))), scale(p, Math.sin(rad(58.5))));
  const h2 = add(scale(axis, Math.cos(rad(58.5))), scale(p, -Math.sin(rad(58.5))));
  return [add(c, scale(h1, len)), add(c, scale(h2, len))];
}

/** Append hydrogens to an atom list, returning the new list. */
export function withHydrogens(list: XYZ[], hs: Vec3[]): XYZ[] {
  return [...list, ...hs.map((h): XYZ => ['H', h[0], h[1], h[2]])];
}

export const vec = (a: XYZ): Vec3 => [a[1], a[2], a[3] ?? 0];

// ---------------------------------------------------------------------------------------------
// Peptide backbones
// ---------------------------------------------------------------------------------------------

/** Engh & Huber ideal backbone geometry. */
const BB = { nca: 1.458, cac: 1.525, cn: 1.329, co: 1.231, angNCaC: 111.2, angCaCN: 116.2, angCNCa: 121.7, angCaCO: 120.5 };

export interface BackboneResidue {
  N: Vec3;
  CA: Vec3;
  C: Vec3;
  O: Vec3;
}

/**
 * Build an ideal peptide backbone from per-residue (phi, psi) angles (omega = 180°).
 * Returns N, CA, C, O positions per residue.
 */
export function buildBackbone(phi: number[], psi: number[], omega = 180): BackboneResidue[] {
  const n = phi.length;
  const res: BackboneResidue[] = [];
  let N: Vec3 = [0, 0, 0];
  let CA: Vec3 = [BB.nca, 0, 0];
  const t = rad(180 - BB.angNCaC);
  let C: Vec3 = [CA[0] + BB.cac * Math.cos(t), BB.cac * Math.sin(t), 0];
  for (let i = 0; i < n; i++) {
    // Next N from this residue's psi; O lies anti to the next N.
    const nextN = placeAtom(N, CA, C, BB.cn, BB.angCaCN, psi[i]);
    const O = placeAtom(N, CA, C, BB.co, BB.angCaCO, psi[i] + 180);
    res.push({ N, CA, C, O });
    if (i === n - 1) break;
    const nextCA = placeAtom(CA, C, nextN, BB.nca, BB.angCNCa, omega);
    const nextC = placeAtom(C, nextN, nextCA, BB.cac, BB.angNCaC, phi[i + 1]);
    N = nextN;
    CA = nextCA;
    C = nextC;
  }
  return res;
}

/** Atom inputs (N, CA, C, O per residue) for a backbone, with residue/chain annotations. */
export function backboneAtoms(
  bb: BackboneResidue[],
  opts: { chain?: string; firstResSeq?: number; resName?: string | ((i: number) => string); caOnly?: boolean } = {},
): AtomInput[] {
  const out: AtomInput[] = [];
  bb.forEach((r, i) => {
    const resName = typeof opts.resName === 'function' ? opts.resName(i) : opts.resName ?? 'ALA';
    const base = { resName, resSeq: (opts.firstResSeq ?? 1) + i, chain: opts.chain ?? 'A', hetero: false };
    const names: (keyof BackboneResidue)[] = opts.caOnly ? ['CA'] : ['N', 'CA', 'C', 'O'];
    for (const name of names) {
      const p = r[name];
      out.push({ ...base, name, element: name === 'CA' ? 'C' : name[0], x: p[0], y: p[1], z: p[2] });
    }
  });
  return out;
}

/** Apply a rigid transform p → R·p + t (R given as a rotation about `axis` by `deg` through `origin`). */
export function transformAtoms(atoms: AtomInput[], axis: Vec3, deg: number, origin: Vec3, shift: Vec3): AtomInput[] {
  const ax = unit(axis);
  return atoms.map((a) => {
    const p = add(add(rotate(sub([a.x, a.y, a.z], origin), ax, deg), origin), shift);
    return { ...a, x: p[0], y: p[1], z: p[2] };
  });
}

/**
 * Local frame of an ideal β-strand: `axis` along the strand (first → last CA), `side` the
 * in-sheet direction in which the even residues' C=O point, `normal` perpendicular to the sheet,
 * and the CA centroid.
 */
export function strandFrame(bb: BackboneResidue[]): { axis: Vec3; side: Vec3; normal: Vec3; center: Vec3 } {
  const n = bb.length;
  const axis = unit(sub(bb[n - 1].CA, bb[0].CA));
  let center: Vec3 = [0, 0, 0];
  let co: Vec3 = [0, 0, 0];
  bb.forEach((r, i) => {
    center = add(center, scale(r.CA, 1 / n));
    const v = sub(r.O, r.C);
    co = add(co, scale(sub(v, scale(axis, dot(v, axis))), i % 2 ? -1 : 1));
  });
  const side = unit(co);
  return { axis, side, normal: unit(cross(axis, side)), center };
}

/**
 * Planar benzenoid (polycyclic aromatic) carbon skeleton from hexagon centres in axial
 * coordinates (q, r) of a pointy-top hexagonal lattice. Optionally adds H on 2-coordinate carbons.
 */
export function hexFlake(rings: [number, number][], withH = false, cc = 1.4): XYZ[] {
  const pts: [number, number][] = [];
  for (const [q, r] of rings) {
    const cx = cc * Math.sqrt(3) * (q + r / 2);
    const cy = cc * 1.5 * r;
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      const x = cx + cc * Math.cos(a);
      const y = cy + cc * Math.sin(a);
      if (!pts.some((p) => Math.hypot(p[0] - x, p[1] - y) < 0.1)) pts.push([x, y]);
    }
  }
  const out: XYZ[] = pts.map(([x, y]): XYZ => ['C', x, y, 0]);
  if (withH) {
    for (const p of pts) {
      const nb = pts.filter((q) => q !== p && Math.hypot(p[0] - q[0], p[1] - q[1]) < cc * 1.1);
      if (nb.length !== 2) continue;
      const h = hTrigonal([p[0], p[1], 0], [nb[0][0], nb[0][1], 0], [nb[1][0], nb[1][1], 0]);
      out.push(['H', h[0], h[1], h[2]]);
    }
  }
  return out;
}

/** Regular planar ring of `els` (first atom on +y) with side `side`, plus H on listed ring atoms. */
export function planarRing(els: string[], side: number, hOn: number[] = []): XYZ[] {
  const n = els.length;
  const R = side / (2 * Math.sin(Math.PI / n));
  const ring = els.map((el, k): XYZ => {
    const a = Math.PI / 2 + (2 * Math.PI * k) / n;
    return [el, R * Math.cos(a), R * Math.sin(a), 0];
  });
  const hs = hOn.map((k) => {
    const p = vec(ring[k]);
    return add(p, scale(unit(p), el(ring[k]) === 'N' ? 1.01 : 1.08));
  });
  return withHydrogens(ring, hs);
}
const el = (a: XYZ) => a[0];
