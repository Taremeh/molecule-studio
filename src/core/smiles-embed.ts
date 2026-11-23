/**
 * 3D coordinate generation for a molecular graph (SMILES, flat 2D files). OWNER: forcefield agent.
 *
 * Constructive embedding, then force-field minimisation:
 *  1. Ring systems (rings sharing atoms, from the SSSR) are laid out first: the first ring as a
 *     regular polygon, fused rings as regular polygons on the shared edge (opposite side), spiro rings
 *     in the perpendicular plane through the shared atom. sp3 ring atoms get an alternating ±0.25 Å
 *     pucker (chair for cyclohexane). Bridged / caged systems that cannot be drawn this way are
 *     embedded by classical multidimensional scaling of topological distances followed by a
 *     force-field relaxation of the ring system alone.
 *  2. The rest of the molecule grows outwards along a breadth-first tree with ideal bond lengths and
 *     VSEPR directions (tetrahedral / trigonal / linear completion of the already placed neighbours),
 *     preferring anti (zig-zag) torsions for heavy substituents. Tetrahedral (@/@@) stereo is enforced
 *     by assigning substituents to the appropriate slots; double-bond (/ \) stereo by choosing the
 *     cis or trans slot. Attached ring systems are placed rigidly along the bond.
 *  3. The whole molecule is minimised with the force field (core/minimize). Remaining stereo errors
 *     are repaired (branch swap by a 180° rotation, or reflection of a ring-fusion atom) and the
 *     structure is re-minimised. Several deterministic seeds (different torsion choices / puckers)
 *     are tried for small molecules or when clashes remain; the lowest-energy clash-free result wins.
 *  4. Disconnected fragments are embedded separately and placed side by side; the result is
 *     centred and aligned to its principal axes (proper rotation, chirality preserved).
 */
import type { Atom, Bond, Molecule, Vec3 } from './types';
import { getTopology } from './molecule';
import { getElement } from './elements';
import { HYB_HYPER, HYB_NONE, HYB_SP, HYB_SP2, HYB_SP3, perceiveTyping, restLength, type Typing } from './ff-model';
import { edgeKey, findSSSR } from './ff-rings';
import { Lbfgs } from './ff-optim';
import { createForceField, seededRandom, type ForceFieldContext } from './minimize';

export interface StereoSpec {
  /**
   * Tetrahedral centres: `nbrs` are the four neighbour indices in SMILES order. sign = +1 for '@@'
   * (looking from nbrs[0], the other three are clockwise), −1 for '@' (anticlockwise). Equivalent:
   * sign = sign of (p1−c)·((p2−c)×(p3−c)).
   */
  centres: { atom: number; nbrs: number[]; sign: 1 | -1 }[];
  /** Double bonds a=b with reference neighbours x (on a) and y (on b): cis = x and y on the same side. */
  doubleBonds: { a: number; b: number; x: number; y: number; cis: boolean }[];
}

export interface EmbedOptions {
  /** Derive double-bond (and, for 3D input, tetrahedral) stereo from the input coordinates. */
  useInputDoubleBondStereo?: boolean;
  /** Override the number of seeds tried per fragment. */
  seeds?: number;
}

// ---------------------------------------------------------------------------
// small vector helpers (local, allocation-light enough for embedding)
// ---------------------------------------------------------------------------

const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
const vadd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
function vnorm(a: Vec3): Vec3 {
  const l = vlen(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [1, 0, 0];
}
/** Some unit vector perpendicular to a (unit). */
function perpendicular(a: Vec3): Vec3 {
  const ax = Math.abs(a[0]), ay = Math.abs(a[1]), az = Math.abs(a[2]);
  const other: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return vnorm(vcross(a, other));
}
/** Rotate p about the unit axis through origin o by angle t (radians), Rodrigues. */
function rotateAbout(p: Vec3, o: Vec3, k: Vec3, t: number): Vec3 {
  const v = vsub(p, o);
  const c = Math.cos(t), s = Math.sin(t);
  const kv = vcross(k, v);
  const kd = vdot(k, v);
  return [
    o[0] + v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    o[1] + v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    o[2] + v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}
/** 3×3 rotation (row-major) taking unit vector a onto unit vector b. */
function rotationFromTo(a: Vec3, b: Vec3): number[] {
  const c = vdot(a, b);
  if (c > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let k: Vec3;
  let s: number;
  if (c < -1 + 1e-12) {
    k = perpendicular(a);
    s = 0;
  } else {
    const ax = vcross(a, b);
    s = vlen(ax);
    k = vscale(ax, 1 / s);
  }
  const C = 1 - c;
  const [x, y, z] = k;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}
const mapply = (m: number[], v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

function dihedralDeg(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const b0 = vsub(a, b);
  const b1 = vnorm(vsub(c, b));
  const b2 = vsub(d, c);
  const v = vsub(b0, vscale(b1, vdot(b0, b1)));
  const w = vsub(b2, vscale(b1, vdot(b2, b1)));
  return (Math.atan2(vdot(vcross(b1, v), w), vdot(v, w)) * 180) / Math.PI;
}

/** Signed volume (p1−c)·((p2−c)×(p3−c)). */
function chiralVolume(c: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): number {
  return vdot(vsub(p1, c), vcross(vsub(p2, c), vsub(p3, c)));
}

const TETRA_HALF = (54.7356 * Math.PI) / 180; // half of the tetrahedral angle
const COS_TET = -1 / 3;
const SIN_TET = Math.sqrt(8 / 9);

// ---------------------------------------------------------------------------
// VSEPR directions
// ---------------------------------------------------------------------------

function stericNumber(h: number, total: number): number {
  if (h === HYB_SP) return 2;
  if (h === HYB_SP2) return 3;
  if (h === HYB_SP3) return 4;
  if (h === HYB_HYPER) return 6;
  return Math.max(total, 4);
}

/** Evenly spread fallback: greedily pick sphere points maximising the minimum angle. */
function spreadDirections(existing: Vec3[], need: number, rnd: () => number): Vec3[] {
  const cand: Vec3[] = [];
  const N = 96;
  const rot = rnd() * Math.PI * 2;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const t = i * 2.399963 + rot;
    cand.push([r * Math.cos(t), y, r * Math.sin(t)]);
  }
  const chosen: Vec3[] = [];
  const all = existing.slice();
  for (let k = 0; k < need; k++) {
    let best = cand[0];
    let bestScore = -Infinity;
    for (const c of cand) {
      let m = Infinity;
      for (const e of all) m = Math.min(m, -vdot(c, e));
      if (!all.length) m = 0;
      if (m > bestScore) {
        bestScore = m;
        best = c;
      }
    }
    chosen.push(best);
    all.push(best);
  }
  return chosen;
}

/**
 * Unit directions for new substituents of an atom, given unit vectors to its placed neighbours,
 * ordered by preference. `ref` (unit, ⟂ to the single placed bond) points towards the torsion
 * reference atom; the first slot is anti to it. May return more slots than needed (free choice).
 */
function freeDirections(hyb: number, placed: Vec3[], need: number, ref: Vec3 | null, rnd: () => number): Vec3[] {
  const k = placed.length;
  const sn = stericNumber(hyb, k + need);
  if (need <= 0) return [];
  if (k + need > sn || hyb === HYB_NONE) return spreadDirections(placed, need, rnd);
  if (k === 0) {
    if (sn === 2) return [v3(1, 0, 0), v3(-1, 0, 0)];
    if (sn === 3) return [v3(1, 0, 0), v3(-0.5, Math.sqrt(3) / 2, 0), v3(-0.5, -Math.sqrt(3) / 2, 0)];
    if (sn === 4) {
      const s = 1 / Math.sqrt(3);
      return [v3(s, s, s), v3(s, -s, -s), v3(-s, s, -s), v3(-s, -s, s)];
    }
    return [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 1, 0), v3(0, -1, 0), v3(0, 0, 1), v3(0, 0, -1)];
  }
  if (k === 1) {
    const u = placed[0];
    const w = ref ?? perpendicular(u);
    const v = vcross(u, w);
    if (sn === 2) return [vscale(u, -1)];
    if (sn === 3) {
      const c = -0.5, s = Math.sqrt(3) / 2;
      return [vadd(vscale(u, c), vscale(w, -s)), vadd(vscale(u, c), vscale(w, s))];
    }
    if (sn === 4) {
      const out: Vec3[] = [];
      for (const t of [0, (2 * Math.PI) / 3, (-2 * Math.PI) / 3]) {
        const perp = vadd(vscale(w, -Math.cos(t)), vscale(v, Math.sin(t)));
        out.push(vnorm(vadd(vscale(u, COS_TET), vscale(perp, SIN_TET))));
      }
      return out;
    }
    return [vscale(u, -1), w, vscale(w, -1), v, vscale(v, -1)];
  }
  if (k === 2) {
    const [u1, u2] = placed;
    const sum = vadd(u1, u2);
    const bis = vlen(sum) > 1e-6 ? vnorm(vscale(sum, -1)) : perpendicular(u1);
    if (sn === 3) return [bis];
    if (sn === 4) {
      let nrm = vcross(u1, u2);
      nrm = vlen(nrm) > 1e-6 ? vnorm(nrm) : perpendicular(bis);
      const c = Math.cos(TETRA_HALF), s = Math.sin(TETRA_HALF);
      return [vnorm(vadd(vscale(bis, c), vscale(nrm, s))), vnorm(vadd(vscale(bis, c), vscale(nrm, -s)))];
    }
    return spreadDirections(placed, need, rnd);
  }
  if (k === 3 && sn === 4) {
    const sum = vadd(vadd(placed[0], placed[1]), placed[2]);
    if (vlen(sum) > 1e-3) return [vnorm(vscale(sum, -1))];
    return [vnorm(vcross(vsub(placed[1], placed[0]), vsub(placed[2], placed[0])))];
  }
  return spreadDirections(placed, need, rnd);
}

// ---------------------------------------------------------------------------
// Embedding of one connected fragment
// ---------------------------------------------------------------------------

interface RingSystem {
  atoms: number[];
  rings: number[][];
  /** Laid out by MDS + relaxation (bridged / caged). */
  bridged: boolean;
}

class FragmentEmbedder {
  readonly mol: Molecule;
  readonly n: number;
  readonly typing: Typing;
  readonly nbrs: number[][];
  readonly stereo: StereoSpec;
  readonly systems: RingSystem[] = [];
  readonly atomSystem: Int32Array;
  readonly ringBond = new Set<number>();
  private readonly bondLen = new Map<number, number>();
  private readonly ctx: ForceFieldContext;
  private readonly centreOf = new Map<number, StereoSpec['centres'][number]>();
  private readonly isH: Uint8Array;
  private readonly weight: Int32Array;

  constructor(mol: Molecule, stereo: StereoSpec) {
    this.mol = mol;
    this.n = mol.atoms.length;
    this.typing = perceiveTyping(mol, { inferFromGeometry: false });
    this.nbrs = this.typing.nbrs;
    this.stereo = stereo;
    for (const c of stereo.centres) this.centreOf.set(c.atom, c);
    const topo = getTopology(mol);
    for (const b of mol.bonds) {
      const i = topo.idToIndex.get(b.a)!, j = topo.idToIndex.get(b.b)!;
      this.bondLen.set(edgeKey(i, j, this.n), restLength(mol, this.typing, i, j, b.order));
    }
    this.isH = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) if (mol.atoms[i].element === 'H') this.isH[i] = 1;
    // Ring systems: rings that share at least one atom.
    const rings = findSSSR(this.nbrs);
    this.atomSystem = new Int32Array(this.n).fill(-1);
    const parent = rings.map((_, k) => k);
    const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
    const owner = new Map<number, number>();
    rings.forEach((r, k) => {
      for (const a of r) {
        const o = owner.get(a);
        if (o === undefined) owner.set(a, k);
        else parent[find(k)] = find(o);
      }
      for (let t = 0; t < r.length; t++) this.ringBond.add(edgeKey(r[t], r[(t + 1) % r.length], this.n));
    });
    const sysIndex = new Map<number, number>();
    rings.forEach((r, k) => {
      const root = find(k);
      let s = sysIndex.get(root);
      if (s === undefined) {
        s = this.systems.length;
        sysIndex.set(root, s);
        this.systems.push({ atoms: [], rings: [], bridged: false });
      }
      this.systems[s].rings.push(r);
      for (const a of r) {
        if (this.atomSystem[a] === -1) {
          this.atomSystem[a] = s;
          this.systems[s].atoms.push(a);
        }
      }
    });
    // Heavy-atom weight of each atom's subtree is approximated by its heavy-neighbour count + ring membership.
    this.weight = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      let w = 0;
      for (const j of this.nbrs[i]) if (!this.isH[j]) w++;
      this.weight[i] = w + (this.atomSystem[i] >= 0 ? 4 : 0);
    }
    this.ctx = createForceField(mol, { inferFromGeometry: false });
  }

  length(i: number, j: number): number {
    return this.bondLen.get(edgeKey(i, j, this.n)) ?? 1.5;
  }

  private planarAtom(i: number): boolean {
    const h = this.typing.hyb[i];
    return h === HYB_SP2 || h === HYB_SP || this.typing.aromatic[i] === 1;
  }

  // ---- ring-system layout -----------------------------------------------------------

  private ringNormal(ring: number[], pos: Map<number, Vec3>): Vec3 {
    // Newell's method on the placed atoms of the ring
    let nx = 0, ny = 0, nz = 0;
    const pts = ring.filter((a) => pos.has(a)).map((a) => pos.get(a)!);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      nx += (p[1] - q[1]) * (p[2] + q[2]);
      ny += (p[2] - q[2]) * (p[0] + q[0]);
      nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    const nrm: Vec3 = [nx, ny, nz];
    return vlen(nrm) > 1e-9 ? vnorm(nrm) : [0, 0, 1];
  }

  /** Planar fused / spiro layout; null when the system is bridged or overlaps itself. */
  private layoutPolygons(sys: RingSystem, puckerSign: number, randomPucker: boolean, rnd: () => number): Map<number, Vec3> | null {
    const pos = new Map<number, Vec3>();
    const rings = sys.rings;
    const ringNormals: (Vec3 | null)[] = rings.map(() => null);
    const shared = rings.map((r, k) => {
      let c = 0;
      rings.forEach((o, l) => {
        if (l !== k && o.some((a) => r.includes(a))) c++;
      });
      return c;
    });
    let start = 0;
    for (let k = 1; k < rings.length; k++)
      if (shared[k] > shared[start] || (shared[k] === shared[start] && rings[k].length > rings[start].length)) start = k;
    {
      const r = rings[start];
      const m = r.length;
      let L = 0;
      for (let t = 0; t < m; t++) L += this.length(r[t], r[(t + 1) % m]);
      L /= m;
      const R = L / (2 * Math.sin(Math.PI / m));
      for (let t = 0; t < m; t++) {
        const a = (2 * Math.PI * t) / m;
        pos.set(r[t], [R * Math.cos(a), R * Math.sin(a), 0]);
      }
      ringNormals[start] = [0, 0, 1];
    }
    const done = new Set<number>([start]);
    while (done.size < rings.length) {
      let pick = -1;
      let pickRot: number[] = [];
      let pickCnt = 0;
      let pickScore = -1;
      for (let k = 0; k < rings.length; k++) {
        if (done.has(k)) continue;
        const r = rings[k];
        const m = r.length;
        const placedFlags = r.map((a) => pos.has(a));
        const cnt = placedFlags.filter(Boolean).length;
        if (cnt === 0) continue;
        if (cnt === m) {
          pick = k;
          pickCnt = m;
          pickRot = r;
          pickScore = 99;
          break;
        }
        // rotate so that the placed atoms form a prefix
        let s = -1;
        for (let t = 0; t < m; t++) if (placedFlags[t] && !placedFlags[(t + m - 1) % m]) s = t;
        if (s < 0) continue;
        let run = 0;
        while (run < m && placedFlags[(s + run) % m]) run++;
        if (run !== cnt) return null; // placed atoms not contiguous: bridged
        const score = cnt === 2 ? 3 : cnt > 2 ? 2 : 1;
        if (score > pickScore) {
          pickScore = score;
          pick = k;
          pickCnt = cnt;
          pickRot = Array.from({ length: m }, (_, t) => r[(s + t) % m]);
        }
      }
      if (pick < 0) return null;
      done.add(pick);
      const rr = pickRot;
      const m = rr.length;
      if (pickCnt === m) {
        ringNormals[pick] = this.ringNormal(rr, pos);
        continue;
      }
      const newPts: [number, Vec3][] = [];
      if (pickCnt === 1) {
        // spiro: new ring in the plane bisecting the free tetrahedral directions of the shared atom
        const sAtom = rr[0];
        const sp = pos.get(sAtom)!;
        const placedN = this.nbrs[sAtom].filter((x) => pos.has(x));
        if (placedN.length < 2) return null;
        const u1 = vnorm(vsub(pos.get(placedN[0])!, sp));
        const u2 = vnorm(vsub(pos.get(placedN[1])!, sp));
        const bis = vnorm(vscale(vadd(u1, u2), -1));
        const nrm = vnorm(vcross(u1, u2));
        let L = 0;
        for (let t = 0; t < m; t++) L += this.length(rr[t], rr[(t + 1) % m]);
        L /= m;
        const R = L / (2 * Math.sin(Math.PI / m));
        const C = vadd(sp, vscale(bis, R));
        const e1 = vscale(bis, -1);
        for (let t = 1; t < m; t++) {
          const a = (2 * Math.PI * t) / m;
          newPts.push([rr[t], vadd(C, vadd(vscale(e1, R * Math.cos(a)), vscale(nrm, R * Math.sin(a))))]);
        }
      } else {
        const p0 = pos.get(rr[0])!, p1 = pos.get(rr[1])!;
        // plane normal from an already placed ring containing this edge
        let N: Vec3 | null = null;
        let adjCentroid: Vec3 | null = null;
        for (const k of done) {
          if (k === pick || !ringNormals[k]) continue;
          const o = rings[k];
          if (o.includes(rr[0]) && o.includes(rr[1])) {
            N = ringNormals[k];
            let c: Vec3 = [0, 0, 0];
            for (const a of o) c = vadd(c, pos.get(a)!);
            adjCentroid = vscale(c, 1 / o.length);
            break;
          }
        }
        if (!N) N = this.ringNormal(rr, pos);
        const e = vsub(p1, p0);
        const L = vlen(e);
        const w = vnorm(vcross(N, e));
        const apothem = L / (2 * Math.tan(Math.PI / m));
        const R = L / (2 * Math.sin(Math.PI / m));
        const M = vscale(vadd(p0, p1), 0.5);
        const polygon = (C: Vec3) => {
          const e1 = vnorm(vsub(p0, C));
          const d1 = vsub(p1, C);
          const e2 = vnorm(vsub(d1, vscale(e1, vdot(d1, e1))));
          return (t: number): Vec3 => {
            const a = (2 * Math.PI * t) / m;
            return vadd(C, vadd(vscale(e1, R * Math.cos(a)), vscale(e2, R * Math.sin(a))));
          };
        };
        const cPlus = vadd(M, vscale(w, apothem));
        const cMinus = vadd(M, vscale(w, -apothem));
        let C: Vec3;
        if (pickCnt >= 3) {
          const p2 = pos.get(rr[2])!;
          const dp = vlen(vsub(polygon(cPlus)(2), p2));
          const dm = vlen(vsub(polygon(cMinus)(2), p2));
          C = dp <= dm ? cPlus : cMinus;
        } else {
          const ref = adjCentroid ?? [0, 0, 0];
          C = vlen(vsub(cPlus, ref)) >= vlen(vsub(cMinus, ref)) ? cPlus : cMinus;
        }
        const f = polygon(C);
        for (let t = pickCnt; t < m; t++) newPts.push([rr[t], f(t)]);
      }
      for (const [a, p] of newPts) {
        for (const [b, q] of pos) if (b !== a && vlen(vsub(p, q)) < 0.6) return null;
        pos.set(a, p);
      }
      ringNormals[pick] = this.ringNormal(rr, pos);
    }

    // A cage drawn with polygons comes out as an "unfolded net": closing bonds far too long.
    for (const r of rings) {
      for (let t = 0; t < r.length; t++) {
        const a = r[t], b = r[(t + 1) % r.length];
        if (Math.abs(vlen(vsub(pos.get(a)!, pos.get(b)!)) - this.length(a, b)) > 0.4) return null;
      }
    }

    // Pucker saturated ring atoms: alternate ± along the local ring normal (chair for 6-rings);
    // later seeds use random puckers for medium / large rings (avoids eclipsed macrocycles).
    const colour = new Map<number, number>();
    const first = sys.atoms[0];
    colour.set(first, 1);
    const queue = [first];
    const inSys = new Set(sys.atoms);
    while (queue.length) {
      const a = queue.shift()!;
      for (const b of this.nbrs[a]) {
        if (!inSys.has(b) || colour.has(b) || !this.ringBond.has(edgeKey(a, b, this.n))) continue;
        colour.set(b, -colour.get(a)!);
        queue.push(b);
      }
    }
    const normalOf = new Map<number, Vec3>();
    const sizeOf = new Map<number, number>();
    rings.forEach((r, k) => {
      for (const a of r) {
        if (!normalOf.has(a)) normalOf.set(a, ringNormals[k] ?? [0, 0, 1]);
        sizeOf.set(a, Math.min(sizeOf.get(a) ?? Infinity, r.length));
      }
    });
    for (const a of sys.atoms) {
      if (this.planarAtom(a)) continue;
      const nrm = normalOf.get(a)!;
      const size = sizeOf.get(a) ?? 6;
      const amp = size <= 6 ? 0.25 : Math.min(0.75, 0.25 + 0.06 * (size - 6));
      const sign = randomPucker && size >= 7 ? rnd() * 2 - 1 : puckerSign * (colour.get(a) ?? 1);
      pos.set(a, vadd(pos.get(a)!, vscale(nrm, amp * sign)));
    }

    // Stereocentres with three ring neighbours (ring fusions, macro-ring junctions): their only free
    // substituent points away from the ring atoms, so chirality is set by which side of the plane
    // of the three ring neighbours the centre sits on. Choose that side now.
    for (const a of sys.atoms) {
      const spec = this.centreOf.get(a);
      if (!spec) continue;
      const ringN = this.nbrs[a].filter((x) => inSys.has(x));
      if (ringN.length !== 3 || this.nbrs[a].length !== 4) continue;
      const [q1, q2, q3] = ringN.map((x) => pos.get(x)!);
      const nrm = vnorm(vcross(vsub(q2, q1), vsub(q3, q1)));
      const centroid = vscale(vadd(vadd(q1, q2), q3), 1 / 3);
      const pa = pos.get(a)!;
      const inPlane = vsub(pa, vscale(nrm, vdot(vsub(pa, q1), nrm)));
      const trial = (side: number) => {
        const c = vadd(vadd(inPlane, vscale(vsub(inPlane, centroid), 0)), vscale(nrm, 0.4 * side));
        let sum: Vec3 = [0, 0, 0];
        for (const q of [q1, q2, q3]) sum = vadd(sum, vnorm(vsub(q, c)));
        const free = vadd(c, vnorm(vscale(sum, -1)));
        const where = (x: number) => (inSys.has(x) ? pos.get(x)! : free);
        const p = spec.nbrs.map(where);
        return { c, ok: Math.sign(chiralVolume(c, p[1], p[2], p[3])) === spec.sign };
      };
      const up = trial(1);
      pos.set(a, up.ok ? up.c : trial(-1).c);
    }
    return pos;
  }

  /** Bridged / caged ring systems: classical MDS of topological distances, then FF relaxation. */
  private layoutMds(sys: RingSystem, rnd: () => number): Map<number, Vec3> {
    const atoms = sys.atoms;
    const k = atoms.length;
    const local = new Map<number, number>();
    atoms.forEach((a, t) => local.set(a, t));
    const D = new Float64Array(k * k);
    for (let s = 0; s < k; s++) {
      const dist = new Int32Array(k).fill(-1);
      dist[s] = 0;
      const q = [s];
      for (let qi = 0; qi < q.length; qi++) {
        const v = q[qi];
        for (const w of this.nbrs[atoms[v]]) {
          const lw = local.get(w);
          if (lw === undefined || dist[lw] >= 0) continue;
          dist[lw] = dist[v] + 1;
          q.push(lw);
        }
      }
      for (let t = 0; t < k; t++) {
        const d = dist[t] < 0 ? k : dist[t];
        // typical through-space distance for a topological distance d
        const r = d === 0 ? 0 : d === 1 ? 1.53 : d === 2 ? 2.5 : 1.53 * Math.pow(d, 0.75) + 0.3;
        D[s * k + t] = r * r;
      }
    }
    // double centring: B = −½ J D² J
    const rowMean = new Float64Array(k);
    let all = 0;
    for (let s = 0; s < k; s++) {
      let m = 0;
      for (let t = 0; t < k; t++) m += D[s * k + t];
      rowMean[s] = m / k;
      all += m;
    }
    all /= k * k;
    const B = new Float64Array(k * k);
    for (let s = 0; s < k; s++) for (let t = 0; t < k; t++) B[s * k + t] = -0.5 * (D[s * k + t] - rowMean[s] - rowMean[t] + all);
    // top-3 eigenvectors by orthogonal (subspace) iteration
    const V = [new Float64Array(k), new Float64Array(k), new Float64Array(k)];
    for (const v of V) for (let s = 0; s < k; s++) v[s] = rnd() - 0.5;
    const lambda = [0, 0, 0];
    for (let it = 0; it < 200; it++) {
      for (let e = 0; e < 3; e++) {
        const v = V[e];
        const w = new Float64Array(k);
        for (let s = 0; s < k; s++) {
          let acc = 0;
          for (let t = 0; t < k; t++) acc += B[s * k + t] * v[t];
          w[s] = acc;
        }
        for (let f = 0; f < e; f++) {
          let d = 0;
          for (let s = 0; s < k; s++) d += w[s] * V[f][s];
          for (let s = 0; s < k; s++) w[s] -= d * V[f][s];
        }
        let l = 0;
        for (let s = 0; s < k; s++) l += w[s] * w[s];
        l = Math.sqrt(l) || 1;
        lambda[e] = l;
        for (let s = 0; s < k; s++) v[s] = w[s] / l;
      }
    }
    const start = new Map<number, Vec3>();
    atoms.forEach((a, s) => {
      start.set(a, [V[0][s] * Math.sqrt(lambda[0]), V[1][s] * Math.sqrt(lambda[1]), V[2][s] * Math.sqrt(Math.max(lambda[2], 0.3))]);
    });
    // Relax the ring system on its own (ring atoms only) with the force field, from the MDS start
    // and from a few random compact starts; keep the lowest-energy result.
    const sub = this.subMolecule(atoms, start);
    const ctx = createForceField(sub, { inferFromGeometry: false });
    const radius = 1.2 * Math.cbrt(k);
    let best: Float64Array | null = null;
    let bestE = Infinity;
    for (let trial = 0; trial < 6; trial++) {
      for (let s = 0; s < k; s++) {
        const p = start.get(atoms[s])!;
        for (let c = 0; c < 3; c++) ctx.x[3 * s + c] = trial === 0 ? p[c] : (rnd() * 2 - 1) * radius;
      }
      ctx.evaluator.invalidate();
      const opt = new Lbfgs((x, g) => ctx.evaluator.evaluate(x, g), ctx.x, ctx.activeAtoms);
      const e = opt.iterate(1500, 0.02).energy;
      if (e < bestE - 1e-6) {
        bestE = e;
        best = ctx.x.slice();
      }
      if (bestE < 0.5 * k) break;
    }
    const pos = new Map<number, Vec3>();
    atoms.forEach((a, s) => pos.set(a, [best![3 * s], best![3 * s + 1], best![3 * s + 2]]));
    return pos;
  }

  private subMolecule(atoms: number[], pos: Map<number, Vec3>): Molecule {
    const local = new Map<number, number>();
    atoms.forEach((a, t) => local.set(a, t));
    const outAtoms: Atom[] = atoms.map((a, t) => {
      const src = this.mol.atoms[a];
      const p = pos.get(a)!;
      return { id: t + 1, element: src.element, charge: src.charge, x: p[0], y: p[1], z: p[2] };
    });
    const outBonds: Bond[] = [];
    for (const b of this.mol.bonds) {
      const topo = getTopology(this.mol);
      const i = local.get(topo.idToIndex.get(b.a)!);
      const j = local.get(topo.idToIndex.get(b.b)!);
      if (i === undefined || j === undefined) continue;
      outBonds.push({ id: outBonds.length + 1, a: i + 1, b: j + 1, order: b.order });
    }
    return { name: 'ring', atoms: outAtoms, bonds: outBonds, nextAtomId: outAtoms.length + 1, nextBondId: outBonds.length + 1, meta: { source: 'smiles' } };
  }

  private layoutSystem(s: number, seed: number, rnd: () => number): Map<number, Vec3> {
    const sys = this.systems[s];
    const puckerSign = seed % 2 === 0 ? 1 : -1;
    const poly = sys.bridged ? null : this.layoutPolygons(sys, puckerSign, seed >= 2, rnd);
    if (poly) return poly;
    sys.bridged = true;
    return this.layoutMds(sys, rnd);
  }

  // ---- constructive growth -------------------------------------------------------------

  /** Initial coordinates for one seed. */
  build(seed: number): Float64Array {
    const n = this.n;
    const rnd = seededRandom(seed * 7919 + 13);
    const pos: (Vec3 | null)[] = new Array(n).fill(null);
    const sysPlaced = new Uint8Array(this.systems.length);
    const queue: number[] = [];
    const place = (a: number, p: Vec3) => {
      pos[a] = p;
      queue.push(a);
    };

    // root
    if (this.systems.length) {
      let best = 0;
      for (let s = 1; s < this.systems.length; s++) if (this.systems[s].atoms.length > this.systems[best].atoms.length) best = s;
      const lay = this.layoutSystem(best, seed, rnd);
      sysPlaced[best] = 1;
      for (const a of this.systems[best].atoms) place(a, lay.get(a)!);
    } else {
      let root = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < n; i++) {
        const score = (this.isH[i] ? -100 : 0) + this.nbrs[i].length * 10 - this.eccentricity(i);
        if (score > bestScore) {
          bestScore = score;
          root = i;
        }
      }
      place(root, [0, 0, 0]);
    }

    for (let qi = 0; qi < queue.length; qi++) {
      const A = queue[qi];
      const pa = pos[A]!;
      const P = this.nbrs[A].filter((x) => pos[x]);
      const U = this.nbrs[A].filter((x) => !pos[x]);
      if (!U.length) continue;
      const dirsPlaced = P.map((p) => vnorm(vsub(pos[p]!, pa)));
      // torsion reference: a placed neighbour of the single placed neighbour
      let ref: Vec3 | null = null;
      if (P.length === 1) {
        const Pn = P[0];
        const u = dirsPlaced[0];
        const cands = this.nbrs[Pn].filter((x) => x !== A && pos[x]);
        cands.sort((x, y) => this.isH[x] - this.isH[y]);
        for (const R of cands) {
          const rv = vsub(pos[R]!, pos[Pn]!);
          const perp = vsub(rv, vscale(u, vdot(rv, u)));
          if (vlen(perp) > 1e-3) {
            ref = vnorm(perp);
            break;
          }
        }
      }
      const slots = freeDirections(this.typing.hyb[A], dirsPlaced, U.length, ref, rnd);
      // heavy substituents first (they get the anti slot), larger branches first
      const order = U.slice().sort((x, y) => this.isH[x] - this.isH[y] || this.weight[y] - this.weight[x] || x - y);
      const slotOf = order.map((_, k) => Math.min(k, slots.length - 1));
      // seed variation: occasionally rotate the slot assignment (gauche conformers)
      if (seed > 0 && slots.length >= 2 && P.length === 1 && (this.typing.hyb[A] === HYB_SP3 || this.typing.hyb[A] === HYB_SP2) && rnd() < 0.35) {
        const shift = 1 + Math.floor(rnd() * (slots.length - 1));
        for (let k = 0; k < slotOf.length; k++) slotOf[k] = (slotOf[k] + shift) % slots.length;
      }
      this.applyCentreStereo(A, pa, order, slots, slotOf, pos);
      this.applyDoubleBondStereo(A, pa, P, order, slots, slotOf, pos);

      for (let k = 0; k < order.length; k++) {
        const u = order[k];
        const d = slots[slotOf[k]];
        const s = this.atomSystem[u];
        if (s >= 0 && !sysPlaced[s]) {
          sysPlaced[s] = 1;
          this.attachSystem(s, u, A, d, pos, place, seed, rnd);
        } else if (!pos[u]) {
          place(u, vadd(pa, vscale(d, this.length(A, u))));
        }
      }
    }
    const x = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const p = pos[i] ?? [rnd() * 3, rnd() * 3, rnd() * 3];
      x[3 * i] = p[0];
      x[3 * i + 1] = p[1];
      x[3 * i + 2] = p[2];
    }
    return x;
  }

  private eccentricity(s: number): number {
    if (this.n > 400) return 0;
    const dist = new Int32Array(this.n).fill(-1);
    dist[s] = 0;
    const q = [s];
    let max = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const v = q[qi];
      for (const w of this.nbrs[v]) if (dist[w] < 0 && !this.isH[w]) {
        dist[w] = dist[v] + 1;
        max = Math.max(max, dist[w]);
        q.push(w);
      }
    }
    return max;
  }

  /** Make the substituent→slot assignment at a stereocentre reproduce the requested chirality. */
  private applyCentreStereo(A: number, pa: Vec3, order: number[], slots: Vec3[], slotOf: number[], pos: (Vec3 | null)[]): void {
    const spec = this.centreOf.get(A);
    if (!spec) return;
    const where = (x: number): Vec3 | null => {
      if (pos[x]) return pos[x];
      const k = order.indexOf(x);
      return k >= 0 ? vadd(pa, slots[slotOf[k]]) : null;
    };
    const sign = () => {
      const p = spec.nbrs.map(where);
      if (p.some((q) => !q)) return 0;
      return Math.sign(chiralVolume(pa, p[1]!, p[2]!, p[3]!));
    };
    if (sign() === 0 || sign() === spec.sign) return;
    if (order.length >= 2) {
      const a = order.length - 1, b = order.length - 2;
      const t = slotOf[a];
      slotOf[a] = slotOf[b];
      slotOf[b] = t;
    } else if (order.length === 1 && slots.length >= 2) {
      slotOf[0] = slotOf[0] === 0 ? 1 : 0;
    }
  }

  /** Pick the cis / trans slot for substituents of a stereo double bond. */
  private applyDoubleBondStereo(A: number, pa: Vec3, P: number[], order: number[], slots: Vec3[], slotOf: number[], pos: (Vec3 | null)[]): void {
    for (const c of this.stereo.doubleBonds) {
      let Q: number, refQ: number, mine: number;
      if (c.a === A) {
        Q = c.b;
        refQ = c.y;
        mine = c.x;
      } else if (c.b === A) {
        Q = c.a;
        refQ = c.x;
        mine = c.y;
      } else continue;
      if (!P.includes(Q) || !pos[refQ]) continue;
      const k = order.indexOf(mine);
      if (k < 0) continue;
      const ok = (slot: number) => {
        const phi = dihedralDeg(pos[refQ]!, pos[Q]!, pa, vadd(pa, slots[slot]));
        return c.cis ? Math.abs(phi) < 90 : Math.abs(phi) > 90;
      };
      if (ok(slotOf[k])) continue;
      for (let s = 0; s < slots.length; s++) {
        if (s === slotOf[k] || !ok(s)) continue;
        const other = slotOf.indexOf(s);
        if (other >= 0) slotOf[other] = slotOf[k];
        slotOf[k] = s;
        break;
      }
    }
  }

  /** Place ring system s rigidly so that its atom u sits at A + d·r(A,u) with its exocyclic bond along −d. */
  private attachSystem(
    s: number,
    u: number,
    A: number,
    d: Vec3,
    pos: (Vec3 | null)[],
    place: (a: number, p: Vec3) => void,
    seed: number,
    rnd: () => number,
  ): void {
    const sys = this.systems[s];
    const lay = this.layoutSystem(s, seed, rnd);
    const inSys = new Set(sys.atoms);
    const pu = lay.get(u)!;
    const ringN = this.nbrs[u].filter((x) => inSys.has(x));
    const local = ringN.map((x) => vnorm(vsub(lay.get(x)!, pu)));
    const extra = this.nbrs[u].length - ringN.length;
    const slots = freeDirections(this.typing.hyb[u], local, Math.max(1, extra), null, rnd);
    let slot = 0;
    if (slots.length >= 2 && local.length >= 2) {
      // equatorial preference: the slot most in the local ring plane
      const nrm = vnorm(vcross(local[0], local[1]));
      if (Math.abs(vdot(slots[1], nrm)) < Math.abs(vdot(slots[0], nrm))) slot = 1;
      // stereo at u: A takes `slot`, the other substituent the remaining one
      const spec = this.centreOf.get(u);
      if (spec) {
        const others = this.nbrs[u].filter((x) => !inSys.has(x) && x !== A);
        const where = (x: number, sl: number): Vec3 | null => {
          if (inSys.has(x)) return lay.get(x)!;
          if (x === A) return vadd(pu, slots[sl]);
          if (others.length === 1 && x === others[0]) return vadd(pu, slots[sl === 0 ? 1 : 0]);
          return null;
        };
        const signFor = (sl: number) => {
          const p = spec.nbrs.map((x) => where(x, sl));
          if (p.some((q) => !q)) return 0;
          return Math.sign(chiralVolume(pu, p[1]!, p[2]!, p[3]!));
        };
        const sg = signFor(slot);
        if (sg !== 0 && sg !== spec.sign) slot = slot === 0 ? 1 : 0;
      }
    }
    const e = slots[slot];
    const target = vscale(d, -1);
    const rot = rotationFromTo(e, target);
    const anchor = vadd(pos[A]!, vscale(d, this.length(A, u)));
    const placedNow = new Map<number, Vec3>();
    for (const a of sys.atoms) placedNow.set(a, vadd(anchor, mapply(rot, vsub(lay.get(a)!, pu))));
    // torsion about the A–u bond
    const refs = this.nbrs[A].filter((x) => x !== u && pos[x]);
    refs.sort((x, y) => this.isH[x] - this.isH[y]);
    if (refs.length && ringN.length) {
      const R = refs[0];
      const w = ringN[0];
      const cur = dihedralDeg(pos[R]!, pos[A]!, anchor, placedNow.get(w)!);
      const conj = this.planarAtom(A) && this.planarAtom(u);
      let want = conj ? 180 : 90;
      if (seed > 0) want += (Math.floor(rnd() * 3) - 1) * (conj ? 30 : 60);
      const axis = vnorm(vsub(anchor, pos[A]!));
      const t = ((want - cur) * Math.PI) / 180;
      for (const [a, p] of placedNow) placedNow.set(a, rotateAbout(p, anchor, axis, -t));
      // rotateAbout sign convention check: fix if needed so that the dihedral really becomes `want`
      const after = dihedralDeg(pos[R]!, pos[A]!, anchor, placedNow.get(w)!);
      if (Math.abs(((after - want + 540) % 360) - 180) > 1) {
        for (const [a, p] of placedNow) placedNow.set(a, rotateAbout(p, anchor, axis, 2 * t));
      }
    }
    place(u, placedNow.get(u)!);
    for (const a of sys.atoms) if (a !== u) place(a, placedNow.get(a)!);
  }

  // ---- optimisation, stereo repair, scoring ---------------------------------------------

  minimise(x: Float64Array, maxIter: number, tol: number): number {
    const ctx = this.ctx;
    ctx.x.set(x);
    ctx.evaluator.invalidate();
    const opt = new Lbfgs((xx, g) => ctx.evaluator.evaluate(xx, g), ctx.x, ctx.activeAtoms);
    const r = opt.iterate(maxIter, tol);
    x.set(ctx.x);
    return r.energy;
  }

  energy(x: Float64Array): number {
    this.ctx.evaluator.invalidate();
    return this.ctx.evaluator.evaluate(x, null);
  }

  private p(x: Float64Array, i: number): Vec3 {
    return [x[3 * i], x[3 * i + 1], x[3 * i + 2]];
  }

  private chiralityOk(x: Float64Array, c: StereoSpec['centres'][number]): boolean {
    const v = chiralVolume(this.p(x, c.atom), this.p(x, c.nbrs[1]), this.p(x, c.nbrs[2]), this.p(x, c.nbrs[3]));
    return Math.sign(v) === c.sign;
  }

  /** Atoms reachable from `start` without passing through `block` (the branch hanging off block). */
  private branch(block: number, start: number): number[] {
    const seen = new Set<number>([block, start]);
    const out = [start];
    for (let q = 0; q < out.length; q++) {
      for (const w of this.nbrs[out[q]]) if (!seen.has(w)) {
        seen.add(w);
        out.push(w);
      }
    }
    return out;
  }

  /**
   * Repair inverted stereocentres / double bonds. Returns true if coordinates were changed.
   * `aggressive` also reflects ring-junction centres of MDS-embedded (bridged / macrocyclic)
   * systems; the caller must verify the result, since in a rigid cage that move is impossible.
   */
  fixStereo(x: Float64Array, aggressive = false): boolean {
    let changed = false;
    const wrong = this.stereo.centres.filter((c) => !this.chiralityOk(x, c));
    // A wrong centre inside a bridged system cannot be fixed locally; mirroring everything can.
    const unfixable = (c: StereoSpec['centres'][number]) => {
      const free = this.nbrs[c.atom].filter((j) => !this.ringBond.has(edgeKey(c.atom, j, this.n)));
      const s = this.atomSystem[c.atom];
      return free.length < 2 && (free.length === 0 || (s >= 0 && this.systems[s].bridged));
    };
    const stuck = wrong.filter(unfixable).length;
    if (stuck > 0) {
      const stuckAll = this.stereo.centres.filter(unfixable);
      const wrongStuck = stuckAll.filter((c) => !this.chiralityOk(x, c)).length;
      if (wrongStuck > stuckAll.length / 2) {
        for (let i = 0; i < this.n; i++) x[3 * i] = -x[3 * i];
        changed = true;
      }
    }
    for (const c of this.stereo.centres) {
      if (this.chiralityOk(x, c)) continue;
      const A = c.atom;
      const pa = this.p(x, A);
      const free = this.nbrs[A].filter((j) => !this.ringBond.has(edgeKey(A, j, this.n)));
      if (free.length >= 2) {
        // swap two branches by a 180° rotation about their bisector (keeps their own chirality)
        free.sort((a, b) => this.branch(A, a).length - this.branch(A, b).length);
        const [b1, b2] = free;
        const axis = vnorm(vadd(vnorm(vsub(this.p(x, b1), pa)), vnorm(vsub(this.p(x, b2), pa))));
        for (const a of [...this.branch(A, b1), ...this.branch(A, b2)]) {
          const q = rotateAbout(this.p(x, a), pa, axis, Math.PI);
          x[3 * a] = q[0];
          x[3 * a + 1] = q[1];
          x[3 * a + 2] = q[2];
        }
        changed = true;
      } else if (free.length === 1 && (aggressive || !(this.atomSystem[A] >= 0 && this.systems[this.atomSystem[A]].bridged))) {
        // ring-fusion atom: reflect it (and its substituent) through the plane of its ring neighbours
        const ringN = this.nbrs[A].filter((j) => j !== free[0]);
        if (ringN.length !== 3) continue;
        const [a, b, d] = ringN.map((j) => this.p(x, j));
        const nrm = vnorm(vcross(vsub(b, a), vsub(d, a)));
        for (const t of [A, ...this.branch(A, free[0])]) {
          const q = this.p(x, t);
          const h = vdot(vsub(q, a), nrm);
          const r = vsub(q, vscale(nrm, 2 * h));
          x[3 * t] = r[0];
          x[3 * t + 1] = r[1];
          x[3 * t + 2] = r[2];
        }
        changed = true;
      }
    }
    for (const c of this.stereo.doubleBonds) {
      if (this.ringBond.has(edgeKey(c.a, c.b, this.n))) continue;
      const phi = dihedralDeg(this.p(x, c.x), this.p(x, c.a), this.p(x, c.b), this.p(x, c.y));
      const isCis = Math.abs(phi) < 90;
      if (isCis === c.cis) continue;
      const side = this.branch(c.a, c.b);
      const pa = this.p(x, c.a);
      const axis = vnorm(vsub(this.p(x, c.b), pa));
      for (const t of side) {
        if (t === c.b) continue;
        const q = rotateAbout(this.p(x, t), pa, axis, Math.PI);
        x[3 * t] = q[0];
        x[3 * t + 1] = q[1];
        x[3 * t + 2] = q[2];
      }
      changed = true;
    }
    return changed;
  }

  stereoErrors(x: Float64Array): number {
    let e = 0;
    for (const c of this.stereo.centres) if (!this.chiralityOk(x, c)) e++;
    for (const c of this.stereo.doubleBonds) {
      const phi = dihedralDeg(this.p(x, c.x), this.p(x, c.a), this.p(x, c.b), this.p(x, c.y));
      if ((Math.abs(phi) < 90) !== c.cis) e++;
    }
    return e;
  }

  /** Non-bonded pairs (≥ 3 bonds apart) that are clearly too close. */
  clashes(x: Float64Array): number {
    const n = this.n;
    if (n > 600) return 0;
    const near = new Set<number>();
    for (let i = 0; i < n; i++) {
      for (const j of this.nbrs[i]) {
        near.add(edgeKey(i, j, n));
        for (const k of this.nbrs[j]) if (k !== i) near.add(edgeKey(i, k, n));
      }
    }
    let c = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (near.has(edgeKey(i, j, n))) continue;
        const dx = x[3 * i] - x[3 * j], dy = x[3 * i + 1] - x[3 * j + 1], dz = x[3 * i + 2] - x[3 * j + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const heavy = !this.isH[i] && !this.isH[j];
        const lim = heavy ? 2.2 : this.isH[i] && this.isH[j] ? 1.4 : 1.6;
        if (d < lim) c++;
      }
    }
    return c;
  }
}

function embedFragment(mol: Molecule, stereo: StereoSpec, seedsOverride?: number): Float64Array {
  const n = mol.atoms.length;
  if (n === 1) return new Float64Array(3);
  const emb = new FragmentEmbedder(mol, stereo);
  const maxSeeds = seedsOverride ?? (n <= 80 ? 8 : n <= 250 ? 3 : 1);
  const minSeeds = seedsOverride ?? (n <= 60 ? 4 : n <= 120 ? 2 : 1);
  const iters = n <= 200 ? 2000 : 1000;
  let best: { x: Float64Array; score: number[] } | null = null;
  for (let seed = 0; seed < maxSeeds; seed++) {
    const x = emb.build(seed);
    emb.minimise(x, iters, 0.02);
    for (let round = 0; round < 5 && emb.fixStereo(x); round++) emb.minimise(x, iters, 0.02);
    const err0 = emb.stereoErrors(x);
    if (err0 > 0) {
      // Junction centres of macrocycles: try reflections, keep them only if they really help.
      const backup = x.slice();
      const e0 = emb.energy(x);
      for (let round = 0; round < 4 && emb.fixStereo(x, true); round++) emb.minimise(x, iters, 0.02);
      const err1 = emb.stereoErrors(x);
      if (!(err1 < err0 && emb.energy(x) < e0 + 10 * (err0 - err1) + 10)) x.set(backup);
    }
    const score = [emb.stereoErrors(x), emb.clashes(x), emb.energy(x)];
    const better =
      !best ||
      score[0] < best.score[0] ||
      (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2] - 1e-6)));
    if (better) best = { x, score };
    if (seed + 1 >= minSeeds && best!.score[0] === 0 && best!.score[1] === 0) break;
  }
  // final polish of the winner
  emb.minimise(best!.x, iters, 0.005);
  return best!.x;
}

// ---------------------------------------------------------------------------
// Public entry: all fragments, arranged side by side
// ---------------------------------------------------------------------------

function inputStereo(mol: Molecule): StereoSpec {
  const out: StereoSpec = { centres: [], doubleBonds: [] };
  const n = mol.atoms.length;
  if (n < 4) return out;
  const topo = getTopology(mol);
  const P = (i: number): Vec3 => [mol.atoms[i].x, mol.atoms[i].y, mol.atoms[i].z];
  let minZ = Infinity, maxZ = -Infinity, ext = 0;
  for (const a of mol.atoms) {
    minZ = Math.min(minZ, a.z);
    maxZ = Math.max(maxZ, a.z);
    ext = Math.max(ext, Math.abs(a.x - mol.atoms[0].x), Math.abs(a.y - mol.atoms[0].y));
  }
  if (ext < 0.01 && maxZ - minZ < 0.01) return out;
  const typing = perceiveTyping(mol);
  for (const b of mol.bonds) {
    if (b.order !== 2) continue;
    const a = topo.idToIndex.get(b.a)!, c = topo.idToIndex.get(b.b)!;
    if (typing.ringEdges.has(edgeKey(a, c, n))) continue;
    const pick = (atom: number, other: number) => {
      const list = topo.neighbors[atom].filter((x) => x !== other);
      list.sort((x, y) => (mol.atoms[x].element === 'H' ? 1 : 0) - (mol.atoms[y].element === 'H' ? 1 : 0));
      return list[0] ?? -1;
    };
    const x = pick(a, c), y = pick(c, a);
    if (x < 0 || y < 0) continue;
    const phi = Math.abs(dihedralDeg(P(x), P(a), P(c), P(y)));
    if (!Number.isFinite(phi)) continue;
    if (phi < 30) out.doubleBonds.push({ a, b: c, x, y, cis: true });
    else if (phi > 150) out.doubleBonds.push({ a, b: c, x, y, cis: false });
  }
  if (maxZ - minZ > 0.3) {
    for (let i = 0; i < n; i++) {
      const nb = topo.neighbors[i];
      if (nb.length !== 4 || typing.hyb[i] !== HYB_SP3) continue;
      const v = chiralVolume(P(i), P(nb[1]), P(nb[2]), P(nb[3]));
      if (Math.abs(v) > 0.2) out.centres.push({ atom: i, nbrs: nb.slice(), sign: v > 0 ? 1 : -1 });
    }
  }
  return out;
}

/** Proper rotation to principal axes (largest spread along x), centred at the origin. */
function alignPrincipal(x: Float64Array): void {
  const n = x.length / 3;
  if (n === 0) return;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += x[3 * i];
    cy += x[3 * i + 1];
    cz += x[3 * i + 2];
  }
  cx /= n; cy /= n; cz /= n;
  for (let i = 0; i < n; i++) {
    x[3 * i] -= cx;
    x[3 * i + 1] -= cy;
    x[3 * i + 2] -= cz;
  }
  if (n < 3) return;
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++)
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) C[3 * r + s] += x[3 * i + r] * x[3 * i + s];
  // Jacobi eigen-decomposition of the symmetric 3×3 covariance
  const V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 30; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = C[3 * p + q];
      if (Math.abs(apq) < 1e-12) continue;
      const theta = (C[3 * q + q] - C[3 * p + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = C[3 * k + p], akq = C[3 * k + q];
        C[3 * k + p] = c * akp - s * akq;
        C[3 * k + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = C[3 * p + k], aqk = C[3 * q + k];
        C[3 * p + k] = c * apk - s * aqk;
        C[3 * q + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[3 * k + p], vkq = V[3 * k + q];
        V[3 * k + p] = c * vkp - s * vkq;
        V[3 * k + q] = s * vkp + c * vkq;
      }
    }
  }
  const evals = [C[0], C[4], C[8]];
  const idx = [0, 1, 2].sort((a, b) => evals[b] - evals[a]);
  const axes = idx.map((k) => [V[k], V[3 + k], V[6 + k]] as Vec3);
  // proper rotation: third axis = first × second
  axes[2] = vcross(axes[0], axes[1]);
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [x[3 * i], x[3 * i + 1], x[3 * i + 2]];
    x[3 * i] = vdot(p, axes[0]);
    x[3 * i + 1] = vdot(p, axes[1]);
    x[3 * i + 2] = vdot(p, axes[2]);
  }
}

/**
 * Generate 3D coordinates for every atom of `mol` (graph + optional stereo constraints given as
 * atom indices). Returns a new molecule; atom ids, bonds and all other atom fields are kept.
 */
export function embedMolecule(mol: Molecule, stereo?: StereoSpec, opts: EmbedOptions = {}): Molecule {
  const n = mol.atoms.length;
  if (n === 0) return mol;
  const spec: StereoSpec = stereo ?? (opts.useInputDoubleBondStereo ? inputStereo(mol) : { centres: [], doubleBonds: [] });
  const topo = getTopology(mol);
  // connected components
  const comp = new Int32Array(n).fill(-1);
  const comps: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const list = [s];
    comp[s] = comps.length;
    for (let q = 0; q < list.length; q++)
      for (const w of topo.neighbors[list[q]]) if (comp[w] < 0) {
        comp[w] = comps.length;
        list.push(w);
      }
    list.sort((a, b) => a - b);
    comps.push(list);
  }
  const out = new Float64Array(3 * n);
  let cursorX = 0;
  // Large fragments first in a row; tiny ones (ions, waters) follow.
  const orderComps = comps.map((c, k) => k).sort((a, b) => comps[b].length - comps[a].length || a - b);
  for (const k of orderComps) {
    const atoms = comps[k];
    const local = new Map<number, number>();
    atoms.forEach((a, t) => local.set(a, t));
    const subAtoms: Atom[] = atoms.map((a, t) => ({ ...mol.atoms[a], id: t + 1 }));
    const subBonds: Bond[] = [];
    for (const b of mol.bonds) {
      const i = topo.idToIndex.get(b.a), j = topo.idToIndex.get(b.b);
      if (i === undefined || j === undefined) continue;
      const li = local.get(i), lj = local.get(j);
      if (li === undefined || lj === undefined) continue;
      subBonds.push({ id: subBonds.length + 1, a: li + 1, b: lj + 1, order: b.order });
    }
    const sub: Molecule = { name: mol.name, atoms: subAtoms, bonds: subBonds, nextAtomId: subAtoms.length + 1, nextBondId: subBonds.length + 1, meta: { source: 'smiles' } };
    const subSpec: StereoSpec = {
      centres: spec.centres
        .filter((c) => local.has(c.atom) && c.nbrs.every((x) => local.has(x)))
        .map((c) => ({ atom: local.get(c.atom)!, nbrs: c.nbrs.map((x) => local.get(x)!), sign: c.sign })),
      doubleBonds: spec.doubleBonds
        .filter((c) => [c.a, c.b, c.x, c.y].every((x) => local.has(x)))
        .map((c) => ({ a: local.get(c.a)!, b: local.get(c.b)!, x: local.get(c.x)!, y: local.get(c.y)!, cis: c.cis })),
    };
    const x = embedFragment(sub, subSpec, opts.seeds);
    alignPrincipal(x);
    let minX = Infinity, maxX = -Infinity, maxR = 0;
    for (let t = 0; t < atoms.length; t++) {
      const r = getElement(sub.atoms[t].element).vdwRadius || 1.5;
      minX = Math.min(minX, x[3 * t] - r);
      maxX = Math.max(maxX, x[3 * t] + r);
      maxR = Math.max(maxR, r);
    }
    const shift = cursorX === 0 && k === orderComps[0] ? 0 : cursorX - minX + 0.8;
    for (let t = 0; t < atoms.length; t++) {
      const a = atoms[t];
      out[3 * a] = x[3 * t] + shift;
      out[3 * a + 1] = x[3 * t + 1];
      out[3 * a + 2] = x[3 * t + 2];
    }
    cursorX = maxX + shift;
  }
  // centre the whole assembly
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += out[3 * i];
    cy += out[3 * i + 1];
    cz += out[3 * i + 2];
  }
  cx /= n; cy /= n; cz /= n;
  const atoms: Atom[] = mol.atoms.map((a, i) => ({ ...a, x: out[3 * i] - cx, y: out[3 * i + 1] - cy, z: out[3 * i + 2] - cz }));
  return { ...mol, atoms };
}
