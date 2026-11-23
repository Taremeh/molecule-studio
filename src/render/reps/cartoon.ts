/**
 * Cartoon (ribbon) geometry for proteins and nucleic acids.
 * OWNER: advanced-render agent. CONTRACT: keep exported names & signatures.
 *
 * Protein: smooth spline (Catmull-Rom / B-spline) through CA atoms per continuous chain segment
 * (break where CA(i)–CA(i+1) > 4.2 Å). Orientation frames from the peptide plane (CA→O direction),
 * flipped to avoid twisting. Cross-sections: helix = wide flat ribbon (or elliptical tube) ~1.6 Å wide,
 * sheet = flat rectangle ~1.8 Å wide with an arrowhead at the strand's C-terminal end,
 * coil = round tube r ≈ 0.25 Å. Smooth transitions between sections.
 * Nucleic: tube through P atoms (or C4'/C3' fallback) + simple base slabs/sticks optional (the default layers
 * already draw bases as licorice, so a backbone tube is enough).
 * Only residues whose CA (or P) is in `mask` are drawn. Colors are per-residue from the CA/P atom's color.
 * Quality controls spline subdivisions (low 4, medium 8, high 12) and radial segments.
 * Use one merged BufferGeometry with per-vertex colors; MeshStandardMaterial({vertexColors:true}).
 * Each vertex also gets an integer attribute or a parallel array mapping to the atom index of its residue's CA
 * so picking can map hits → atoms (expose it via `object.userData.vertexAtomIndex: Int32Array`).
 *
 * Implementation
 *  1. Segments: per chain, consecutive polymer residues whose guide atom (CA; P → C4' → C3' for nucleic)
 *     is in the mask and within 4.2 Å (protein) / 8.0 Å (nucleic) of the previous guide atom.
 *  2. Guide points: CA positions; β-strand CAs get one [1 2 1]/4 smoothing pass, which removes the pleat
 *     zig-zag. Orientation: CA→O, orthogonalised to the local tangent and flipped whenever it points
 *     against the previous residue's (β-strand carbonyls alternate), then smoothed along strands. CA-only
 *     models fall back to the curvature direction. Nucleic tubes use rotation-minimizing frames.
 *  3. Frames: Catmull-Rom interpolation of positions and orientations with `sub` samples per residue.
 *  4. Cross-section: superellipse |x/a|^p + |y/b|^p = 1 (p = 2 ellipse for coil/helix, p = 6 rounded
 *     rectangle for sheets), blended with a smoothstep between residues of different type. The strand's
 *     last residue gets an arrowhead (1.5× sheet width, tapering to the coil tube), with a flat back face.
 *     Normals are analytic and include the slope term for tapering sections. Segments get flat end caps.
 */
import * as THREE from 'three';
import type { Molecule, Residue } from '../../core/types';
import { getTopology } from '../../core/molecule';
import { srgbToLinear } from '../colors';
import {
  anyPerpendicular,
  catmullRom,
  normalize3,
  orthonormalize,
  rotationMinimizingFrames,
  smoothstep,
  smoothstepDeriv,
} from './spline';

export interface CartoonOptions {
  opacity: number;
  quality: 'low' | 'medium' | 'high';
  /** Width/thickness multiplier (rep.scale). */
  scale: number;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const QUALITY = {
  low: { sub: 4, radial: 8 },
  medium: { sub: 8, radial: 12 },
  high: { sub: 12, radial: 16 },
} as const;

/** Above this many vertices, subdivisions are reduced (very large assemblies such as ribosomes). */
const MAX_VERTICES = 4_000_000;

/** Maximum guide-atom distance between consecutive residues of a continuous segment (Å). */
export const PROTEIN_MAX_GAP = 4.2;
export const NUCLEIC_MAX_GAP = 8.0;

interface Section {
  /** Half-width along the orientation vector W (Å, before scale). */
  a: number;
  /** Half-thickness along the ribbon normal N (Å, before scale). */
  b: number;
  /** Superellipse exponent (2 = ellipse; larger = boxier). */
  p: number;
}

type SectionKind = 'coil' | 'helix' | 'sheet' | 'nucleic';

/** Cross-sections (half extents): coil tube r 0.25, helix 1.6 × 0.3, sheet 1.8 × 0.35, nucleic tube r 0.4. */
export const SECTIONS: Readonly<Record<SectionKind, Section>> = {
  coil: { a: 0.25, b: 0.25, p: 2 },
  helix: { a: 0.8, b: 0.15, p: 2 },
  sheet: { a: 0.9, b: 0.175, p: 6 },
  nucleic: { a: 0.4, b: 0.4, p: 2 },
};
export const ARROW_WIDTH_FACTOR = 1.5;

const PROTEIN_GUIDE = ['CA'];
const PROTEIN_ORIENT = ['O', 'OT1', 'O1', 'OXT'];
const NUCLEIC_GUIDE = ['P', "C4'", 'C4*', "C3'", 'C3*', "C1'", 'C1*'];

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

export interface Segment {
  kind: 'protein' | 'nucleic';
  /** Guide atom index (CA / P) per residue. */
  guide: number[];
  /** Orientation atom index (O) per residue, -1 if missing (or nucleic). */
  orient: number[];
  ss: SectionKind[];
}

/** Index of the first atom of `res` whose name matches the earliest entry of `names`, or -1. */
function findNamed(mol: Molecule, res: Residue, names: readonly string[]): number {
  let best = -1;
  let bestRank = names.length;
  for (const ai of res.atomIndices) {
    const name = mol.atoms[ai].name;
    if (!name) continue;
    const rank = names.indexOf(name.trim().toUpperCase());
    if (rank >= 0 && rank < bestRank) {
      best = ai;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  return best;
}

function dist(mol: Molecule, i: number, j: number): number {
  const a = mol.atoms[i];
  const b = mol.atoms[j];
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Continuous drawable backbone segments (≥ 2 residues) of the masked polymer residues. */
export function extractSegments(mol: Molecule, mask: Uint8Array): Segment[] {
  const topo = getTopology(mol);
  const segments: Segment[] = [];
  const emit = (seg: Segment | null) => {
    if (seg && seg.guide.length >= 2) segments.push(seg);
  };
  for (const chain of topo.chains) {
    let cur: Segment | null = null;
    for (const ri of chain.residueIndices) {
      const res = topo.residues[ri];
      const kind = res.kind;
      const guide = kind === 'protein' || kind === 'nucleic' ? findNamed(mol, res, kind === 'protein' ? PROTEIN_GUIDE : NUCLEIC_GUIDE) : -1;
      const ga = guide >= 0 ? mol.atoms[guide] : undefined;
      if (!ga || !mask[guide] || !Number.isFinite(ga.x + ga.y + ga.z) || (kind !== 'protein' && kind !== 'nucleic')) {
        emit(cur);
        cur = null;
        continue;
      }
      const protein = kind === 'protein';
      if (cur) {
        const prev = cur.guide[cur.guide.length - 1];
        if (cur.kind !== kind || dist(mol, prev, guide) > (protein ? PROTEIN_MAX_GAP : NUCLEIC_MAX_GAP)) {
          emit(cur);
          cur = null;
        }
      }
      if (!cur) cur = { kind, guide: [], orient: [], ss: [] };
      cur.guide.push(guide);
      cur.orient.push(protein ? findNamed(mol, res, PROTEIN_ORIENT) : -1);
      cur.ss.push(protein ? (res.ss ?? mol.atoms[guide].ss ?? 'coil') : 'nucleic');
    }
    emit(cur);
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Frames along a segment
// ---------------------------------------------------------------------------

interface Frames {
  count: number;
  pos: Float64Array;
  tan: Float64Array;
  /** Width direction (unit, ⊥ tan). */
  wv: Float64Array;
  /** Thickness direction = tan × wv. */
  nv: Float64Array;
  a: Float64Array;
  b: Float64Array;
  p: Float64Array;
  /** d(a)/ds and d(b)/ds per unit arc length (for normals of tapering sections). */
  da: Float64Array;
  db: Float64Array;
  /** Residue index within the segment (for color / picking). */
  res: Int32Array;
  /** 1 if this frame starts a new ring strip joined to the previous one by a flat annulus (arrow base). */
  step: Uint8Array;
  arrows: number;
}

function guideTangents(P: Float64Array, n: number): Float64Array {
  const T = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    for (let c = 0; c < 3; c++) T[i * 3 + c] = P[i1 * 3 + c] - P[i0 * 3 + c];
    if (normalize3(T, i * 3) < 1e-9) {
      T[i * 3] = 1;
      T[i * 3 + 1] = 0;
      T[i * 3 + 2] = 0;
    }
  }
  return T;
}

/** Per-residue orientation (width direction) for a protein segment. */
function proteinOrientations(mol: Molecule, seg: Segment, P: Float64Array, GT: Float64Array): Float64Array {
  const n = seg.guide.length;
  const W = new Float64Array(n * 3);
  const valid = new Uint8Array(n);
  const atoms = mol.atoms;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const oi = seg.orient[i];
    if (oi >= 0) {
      const ca = atoms[seg.guide[i]];
      const ox = atoms[oi];
      W[o] = ox.x - ca.x;
      W[o + 1] = ox.y - ca.y;
      W[o + 2] = ox.z - ca.z;
    } else if (i > 0 && i < n - 1) {
      // CA-only fallback: binormal of the CA trace (≈ helix axis direction / in the sheet plane).
      const cx = P[o - 3] + P[o + 3] - 2 * P[o];
      const cy = P[o - 2] + P[o + 4] - 2 * P[o + 1];
      const cz = P[o - 1] + P[o + 5] - 2 * P[o + 2];
      const tx = GT[o], ty = GT[o + 1], tz = GT[o + 2];
      W[o] = ty * cz - tz * cy;
      W[o + 1] = tz * cx - tx * cz;
      W[o + 2] = tx * cy - ty * cx;
    }
    valid[i] = orthonormalize(W, o, GT, o) > 1e-6 ? 1 : 0;
  }
  // Fill residues without a usable orientation from their neighbours.
  let firstValid = -1;
  for (let i = 0; i < n; i++) if (valid[i]) { firstValid = i; break; }
  for (let i = 0; i < n; i++) {
    if (valid[i]) continue;
    const o = i * 3;
    const src = firstValid < 0 ? -1 : i < firstValid ? firstValid : i - 1;
    if (src < 0) anyPerpendicular(GT, o, W, o);
    else {
      W[o] = W[src * 3];
      W[o + 1] = W[src * 3 + 1];
      W[o + 2] = W[src * 3 + 2];
      if (orthonormalize(W, o, GT, o) < 1e-6) anyPerpendicular(GT, o, W, o);
    }
    if (firstValid < 0 || i > firstValid) valid[i] = 1;
  }
  // Consistent orientation: flip whenever a residue's vector opposes the previous one.
  for (let i = 1; i < n; i++) {
    const o = i * 3;
    if (W[o] * W[o - 3] + W[o + 1] * W[o - 2] + W[o + 2] * W[o - 1] < 0) {
      W[o] = -W[o];
      W[o + 1] = -W[o + 1];
      W[o + 2] = -W[o + 2];
    }
  }
  // Flatten strands: average orientations within β-strands.
  const src = W.slice();
  for (let i = 1; i < n - 1; i++) {
    if (seg.ss[i] !== 'sheet') continue;
    const o = i * 3;
    for (let c = 0; c < 3; c++) W[o + c] = src[o - 3 + c] + 2 * src[o + c] + src[o + 3 + c];
    if (orthonormalize(W, o, GT, o) < 1e-6) for (let c = 0; c < 3; c++) W[o + c] = src[o + c];
  }
  return W;
}

function sectionOf(kind: SectionKind): Section {
  return SECTIONS[kind];
}

function segmentFrames(mol: Molecule, seg: Segment, sub: number, scale: number): Frames {
  const n = seg.guide.length;
  const atoms = mol.atoms;
  const protein = seg.kind === 'protein';
  const ss = seg.ss;

  // Guide points.
  const P = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = atoms[seg.guide[i]];
    P[i * 3] = a.x;
    P[i * 3 + 1] = a.y;
    P[i * 3 + 2] = a.z;
  }
  if (protein) {
    // One [1 2 1]/4 pass over strand residues cancels the alternating ±pleat offset of the CAs.
    const src = P.slice();
    for (let i = 1; i < n - 1; i++) {
      if (ss[i] !== 'sheet') continue;
      for (let c = 0; c < 3; c++) P[i * 3 + c] = 0.25 * src[(i - 1) * 3 + c] + 0.5 * src[i * 3 + c] + 0.25 * src[(i + 1) * 3 + c];
    }
  }
  const GT = guideTangents(P, n);
  const W = protein ? proteinOrientations(mol, seg, P, GT) : null;

  // Arrowheads: the interval following the last residue of each strand (or the last interval if the
  // strand ends the segment).
  const arrowAt = new Uint8Array(Math.max(0, n - 1));
  if (protein) {
    for (let k = 0; k < n; k++) {
      if (ss[k] !== 'sheet' || (k + 1 < n && ss[k + 1] === 'sheet')) continue;
      const interval = k < n - 1 ? k : k - 1;
      if (interval >= 0) arrowAt[interval] = 1;
    }
  }
  let arrows = 0;
  for (let k = 0; k < arrowAt.length; k++) arrows += arrowAt[k];

  const count = (n - 1) * sub + 1 + arrows;
  const f: Frames = {
    count,
    pos: new Float64Array(count * 3),
    tan: new Float64Array(count * 3),
    wv: new Float64Array(count * 3),
    nv: new Float64Array(count * 3),
    a: new Float64Array(count),
    b: new Float64Array(count),
    p: new Float64Array(count),
    da: new Float64Array(count),
    db: new Float64Array(count),
    res: new Int32Array(count),
    step: new Uint8Array(count),
    arrows,
  };

  const d = new Float64Array(3);
  let fi = 0;
  const emit = (k: number, u: number, a: number, b: number, p: number, dadu: number, dbdu: number, res: number, step: boolean) => {
    const o = fi * 3;
    catmullRom(P, n, k, u, f.pos, o, d, 0);
    const speed = Math.hypot(d[0], d[1], d[2]);
    if (speed > 1e-9) {
      f.tan[o] = d[0] / speed;
      f.tan[o + 1] = d[1] / speed;
      f.tan[o + 2] = d[2] / speed;
    } else {
      // Degenerate (coincident guide points): reuse the guide tangent.
      f.tan[o] = GT[k * 3];
      f.tan[o + 1] = GT[k * 3 + 1];
      f.tan[o + 2] = GT[k * 3 + 2];
    }
    if (W) {
      catmullRom(W, n, k, u, f.wv, o);
      if (orthonormalize(f.wv, o, f.tan, o) < 1e-6) {
        if (fi > 0) {
          f.wv[o] = f.wv[o - 3];
          f.wv[o + 1] = f.wv[o - 2];
          f.wv[o + 2] = f.wv[o - 1];
          if (orthonormalize(f.wv, o, f.tan, o) < 1e-6) anyPerpendicular(f.tan, o, f.wv, o);
        } else anyPerpendicular(f.tan, o, f.wv, o);
      }
    }
    const inv = speed > 1e-9 ? 1 / speed : 0;
    f.a[fi] = a * scale;
    f.b[fi] = b * scale;
    f.p[fi] = p;
    f.da[fi] = dadu * scale * inv;
    f.db[fi] = dbdu * scale * inv;
    f.res[fi] = res;
    f.step[fi] = step ? 1 : 0;
    fi++;
  };

  for (let k = 0; k < n - 1; k++) {
    const s0 = sectionOf(ss[k]);
    if (arrowAt[k]) {
      // Arrowhead: body ends at full sheet width, then a flat step out to 1.5× and a linear taper
      // down to the section of the next residue (coil tube).
      const end = k + 1 < n && ss[k + 1] !== 'sheet' ? sectionOf(ss[k + 1]) : SECTIONS.coil;
      const sheet = SECTIONS.sheet;
      const a0 = sheet.a * ARROW_WIDTH_FACTOR;
      const b0 = sheet.b;
      emit(k, 0, s0.a, s0.b, s0.p, 0, 0, k, false);
      for (let s = 0; s < sub; s++) {
        const u = s / sub;
        emit(k, u, a0 + (end.a - a0) * u, b0 + (end.b - b0) * u, sheet.p + (end.p - sheet.p) * u, end.a - a0, end.b - b0, k, s === 0);
      }
      continue;
    }
    const s1 = sectionOf(ss[k + 1]);
    for (let s = 0; s < sub; s++) {
      const u = s / sub;
      const t = smoothstep(u);
      const dt = smoothstepDeriv(u);
      emit(
        k,
        u,
        s0.a + (s1.a - s0.a) * t,
        s0.b + (s1.b - s0.b) * t,
        s0.p + (s1.p - s0.p) * t,
        (s1.a - s0.a) * dt,
        (s1.b - s0.b) * dt,
        u < 0.5 ? k : k + 1,
        false,
      );
    }
  }
  // Final frame at the last guide point.
  {
    const k = n - 2;
    const last = arrowAt[k] ? (ss[n - 1] !== 'sheet' ? sectionOf(ss[n - 1]) : SECTIONS.coil) : sectionOf(ss[n - 1]);
    emit(k, 1, last.a, last.b, last.p, 0, 0, n - 1, false);
  }

  // Nucleic tubes: twist-free frames.
  if (!W) {
    anyPerpendicular(f.tan, 0, f.wv, 0);
    rotationMinimizingFrames(f.pos, f.tan, count, f.wv);
  }
  // Thickness direction N = T × W.
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const tx = f.tan[o], ty = f.tan[o + 1], tz = f.tan[o + 2];
    const wx = f.wv[o], wy = f.wv[o + 1], wz = f.wv[o + 2];
    f.nv[o] = ty * wz - tz * wy;
    f.nv[o + 1] = tz * wx - tx * wz;
    f.nv[o + 2] = tx * wy - ty * wx;
    normalize3(f.nv, o);
  }
  return f;
}

// ---------------------------------------------------------------------------
// Mesh assembly
// ---------------------------------------------------------------------------

/** Superellipse helpers: unit-section offset g and (unnormalised) normal factors for exponent p. */
function spow(c: number, e: number): number {
  return c === 0 ? 0 : c > 0 ? Math.pow(c, e) : -Math.pow(-c, e);
}

/**
 * @param mask   1 for atoms (by index) included in the representation's selection
 * @param colors per-atom sRGB colors (length atoms × 3) from computeAtomColors
 * @returns null if nothing to draw
 */
export function buildCartoon(mol: Molecule, mask: Uint8Array, colors: Float32Array, opts: CartoonOptions): THREE.Object3D | null {
  const segments = extractSegments(mol, mask);
  if (segments.length === 0) return null;

  const q = QUALITY[opts.quality] ?? QUALITY.medium;
  let sub: number = q.sub;
  let radial: number = q.radial;
  const scale = opts.scale > 0 && Number.isFinite(opts.scale) ? opts.scale : 1;

  // Keep giant assemblies within a sane vertex budget.
  let intervals = 0;
  for (const s of segments) intervals += s.guide.length - 1;
  while (intervals * sub * radial > MAX_VERTICES && (sub > 2 || radial > 8)) {
    if (sub > 2) sub = Math.max(2, sub - 2);
    else radial = Math.max(8, radial - 4);
  }

  const frames = segments.map((s) => segmentFrames(mol, s, sub, scale));

  // Allocate buffers.
  let vCount = 0;
  let tCount = 0;
  for (const f of frames) {
    vCount += f.count * radial + f.arrows * 2 * radial + 2 * (radial + 1);
    tCount += (f.count - 1) * 2 * radial + 2 * radial;
  }
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const vcolors = new Float32Array(vCount * 3);
  const vertexAtomIndex = new Int32Array(vCount);
  const indices = vCount > 65535 ? new Uint32Array(tCount * 3) : new Uint16Array(tCount * 3);

  const cosT = new Float64Array(radial);
  const sinT = new Float64Array(radial);
  for (let j = 0; j < radial; j++) {
    const th = (2 * Math.PI * j) / radial;
    cosT[j] = Math.cos(th);
    sinT[j] = Math.sin(th);
  }

  // Linearised residue colors (three.js vertex colors live in linear-sRGB).
  const linColor = (atom: number, out: Float64Array) => {
    out[0] = srgbToLinear(colors[atom * 3] ?? 0.7);
    out[1] = srgbToLinear(colors[atom * 3 + 1] ?? 0.7);
    out[2] = srgbToLinear(colors[atom * 3 + 2] ?? 0.7);
  };

  let vi = 0;
  let ii = 0;
  const col = new Float64Array(3);

  const pushVertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, atom: number) => {
    const o = vi * 3;
    positions[o] = x;
    positions[o + 1] = y;
    positions[o + 2] = z;
    normals[o] = nx;
    normals[o + 1] = ny;
    normals[o + 2] = nz;
    vcolors[o] = col[0];
    vcolors[o + 1] = col[1];
    vcolors[o + 2] = col[2];
    vertexAtomIndex[vi] = atom;
    return vi++;
  };
  const tri = (a: number, b: number, c: number) => {
    indices[ii++] = a;
    indices[ii++] = b;
    indices[ii++] = c;
  };

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const f = frames[si];
    const ringStart = new Int32Array(f.count);
    let lastRes = -1;

    // Tube rings.
    for (let i = 0; i < f.count; i++) {
      const o = i * 3;
      const atom = seg.guide[f.res[i]];
      if (f.res[i] !== lastRes) {
        linColor(atom, col);
        lastRes = f.res[i];
      }
      const px = f.pos[o], py = f.pos[o + 1], pz = f.pos[o + 2];
      const tx = f.tan[o], ty = f.tan[o + 1], tz = f.tan[o + 2];
      const wx = f.wv[o], wy = f.wv[o + 1], wz = f.wv[o + 2];
      const nx = f.nv[o], ny = f.nv[o + 1], nz = f.nv[o + 2];
      const a = f.a[i], b = f.b[i], p = f.p[i], da = f.da[i], db = f.db[i];
      const ellipse = Math.abs(p - 2) < 1e-6;
      const e = 2 / p;
      ringStart[i] = vi;
      for (let j = 0; j < radial; j++) {
        const c = cosT[j];
        const s = sinT[j];
        const gx = ellipse ? c : spow(c, e);
        const gy = ellipse ? s : spow(s, e);
        let mx = (ellipse ? c : spow(c, 2 - e)) / a;
        let my = (ellipse ? s : spow(s, 2 - e)) / b;
        const ml = Math.hypot(mx, my) || 1;
        mx /= ml;
        my /= ml;
        const ox = a * gx;
        const oy = b * gy;
        // Slope of the section along the curve tilts the normal towards ∓T.
        const slope = mx * da * gx + my * db * gy;
        let vx = mx * wx + my * nx - slope * tx;
        let vy = mx * wy + my * ny - slope * ty;
        let vz = mx * wz + my * nz - slope * tz;
        const vl = Math.hypot(vx, vy, vz) || 1;
        vx /= vl;
        vy /= vl;
        vz /= vl;
        pushVertex(px + wx * ox + nx * oy, py + wy * ox + ny * oy, pz + wz * ox + nz * oy, vx, vy, vz, atom);
      }
    }

    // Connect consecutive rings (tube quads) or, at an arrow base, a flat annulus facing backwards.
    for (let i = 1; i < f.count; i++) {
      const A = ringStart[i - 1];
      const B = ringStart[i];
      if (f.step[i]) {
        const o = i * 3;
        const tx = -f.tan[o], ty = -f.tan[o + 1], tz = -f.tan[o + 2];
        linColor(seg.guide[f.res[i]], col);
        const atom = seg.guide[f.res[i]];
        const a0 = vi;
        for (let j = 0; j < radial; j++) {
          const s = (A + j) * 3;
          pushVertex(positions[s], positions[s + 1], positions[s + 2], tx, ty, tz, atom);
        }
        const b0 = vi;
        for (let j = 0; j < radial; j++) {
          const s = (B + j) * 3;
          pushVertex(positions[s], positions[s + 1], positions[s + 2], tx, ty, tz, atom);
        }
        for (let j = 0; j < radial; j++) {
          const j1 = (j + 1) % radial;
          tri(a0 + j, a0 + j1, b0 + j1);
          tri(a0 + j, b0 + j1, b0 + j);
        }
        continue;
      }
      for (let j = 0; j < radial; j++) {
        const j1 = (j + 1) % radial;
        tri(A + j, A + j1, B + j1);
        tri(A + j, B + j1, B + j);
      }
    }

    // End caps (flat fans with normals ∓T).
    for (const end of [0, f.count - 1]) {
      const o = end * 3;
      const sign = end === 0 ? -1 : 1;
      const tx = sign * f.tan[o], ty = sign * f.tan[o + 1], tz = sign * f.tan[o + 2];
      const atom = seg.guide[f.res[end]];
      linColor(atom, col);
      const center = pushVertex(f.pos[o], f.pos[o + 1], f.pos[o + 2], tx, ty, tz, atom);
      const r0 = vi;
      const R = ringStart[end];
      for (let j = 0; j < radial; j++) {
        const s = (R + j) * 3;
        pushVertex(positions[s], positions[s + 1], positions[s + 2], tx, ty, tz, atom);
      }
      for (let j = 0; j < radial; j++) {
        const j1 = (j + 1) % radial;
        if (end === 0) tri(center, r0 + j1, r0 + j);
        else tri(center, r0 + j, r0 + j1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(vcolors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const opacity = Math.max(0, Math.min(1, opts.opacity));
  const transparent = opacity < 1;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.5,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent,
    opacity,
    depthWrite: !transparent,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'cartoon';
  mesh.userData.vertexAtomIndex = vertexAtomIndex;
  mesh.userData.kind = 'cartoon';
  return mesh;
}
