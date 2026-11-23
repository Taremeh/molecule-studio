/**
 * Tiny 2D line drawings of fragment templates for the fragment picker. The heavy atoms are
 * projected onto their best-fit plane (the two principal axes of their coordinates), rotated so
 * the attachment bond points to the left, and scaled into a small box.
 * OWNER: edit-ui.
 */
import type { BondOrder, Vec3 } from '../../core/types';
import type { FragmentTemplate } from '../../core/templates';

/**
 * Eigen-decomposition of a symmetric 3×3 matrix with the cyclic Jacobi method.
 * Returns eigenvalues in DESCENDING order and the matching unit eigenvectors.
 */
export function symmetricEigen3(m: readonly (readonly number[])[]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        // Rotation angle that zeroes a[p][q]: t = tan(φ) is the smaller root of t² + 2θt − 1 = 0.
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = theta === 0 ? 1 : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => [v[0][i], v[1][i], v[2][i]] as Vec3),
  };
}

export interface SketchAtom {
  x: number;
  y: number;
  element: string;
  /** Text label for heteroatoms, e.g. 'N', 'OH', 'NH₂'. Carbons are drawn as plain vertices. */
  label?: string;
}

export interface SketchBond {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  order: BondOrder;
  /** Unit normal (screen space) towards the side where the second line of a double/aromatic bond goes. */
  nx: number;
  ny: number;
  /** True: second line drawn on the inner (ring) side; false: lines drawn symmetrically. */
  inner: boolean;
}

export interface FragmentSketch {
  width: number;
  height: number;
  atoms: SketchAtom[];
  bonds: SketchBond[];
  /** Short line showing where the fragment attaches. */
  stub?: { x1: number; y1: number; x2: number; y2: number };
  /** Set when the fragment has a single heavy atom: show this text instead of a drawing. */
  text?: string;
}

const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉';
const sub = (n: number) => String(n).split('').map((d) => SUBSCRIPTS[+d]).join('');

/** Pixels per Å at most (keeps 2-atom groups from becoming huge). */
const MAX_SCALE = 11;
/** Length of the attachment stub in Å. */
const STUB_LEN = 0.85;

export function sketchFragment(t: FragmentTemplate, width = 44, height = 30, pad = 4): FragmentSketch {
  const heavy: number[] = [];
  t.atoms.forEach((a, i) => {
    if (a.element !== 'H') heavy.push(i);
  });
  if (heavy.length <= 1) return { width, height, atoms: [], bonds: [], text: t.label };

  const P: Vec3[] = t.atoms.map((a) => [a.x, a.y, a.z]);
  // Principal axes of the heavy-atom coordinates.
  const c: Vec3 = [0, 0, 0];
  for (const i of heavy) for (let k = 0; k < 3; k++) c[k] += P[i][k] / heavy.length;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const i of heavy) {
    const d = [P[i][0] - c[0], P[i][1] - c[1], P[i][2] - c[2]];
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) cov[r][s] += d[r] * d[s];
  }
  const { vectors } = symmetricEigen3(cov);
  const [e1, e2] = vectors;
  const project = (p: Vec3): [number, number] => {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return [d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2], d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2]];
  };
  const uv = new Map<number, [number, number]>();
  for (const i of heavy) uv.set(i, project(P[i]));

  // Rotate so the attachment direction (attach atom → replaced H) points left.
  let stub: [[number, number], [number, number]] | undefined;
  const att = t.attachAtom;
  const hyd = t.attachHydrogen;
  if (uv.has(att) && hyd >= 0 && hyd < P.length && hyd !== att) {
    const a2 = uv.get(att)!;
    const h2 = project(P[hyd]);
    const dx = h2[0] - a2[0];
    const dy = h2[1] - a2[1];
    const len3 = Math.hypot(P[hyd][0] - P[att][0], P[hyd][1] - P[att][1], P[hyd][2] - P[att][2]);
    const len2 = Math.hypot(dx, dy);
    if (len3 > 0 && len2 > 0.2 * len3) {
      const rot = Math.PI - Math.atan2(dy, dx);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      for (const [i, [x, y]] of uv) uv.set(i, [x * cos - y * sin, x * sin + y * cos]);
      const a3 = uv.get(att)!;
      stub = [a3, [a3[0] - STUB_LEN, a3[1]]];
    }
  }

  // Fit into the box (y axis points down on screen).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const pts = [...uv.values(), ...(stub ? [stub[1]] : [])];
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const sx = (width - 2 * pad) / Math.max(maxX - minX, 1e-6);
  const sy = (height - 2 * pad) / Math.max(maxY - minY, 1e-6);
  const scale = Math.min(sx, sy, MAX_SCALE);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const toScreen = ([x, y]: [number, number]): [number, number] => [width / 2 + (x - midX) * scale, height / 2 - (y - midY) * scale];

  // Hydrogen counts on heteroatoms (excluding the H replaced on attachment) for labels like "OH".
  const hCount = new Map<number, number>();
  for (const b of t.bonds) {
    for (const [x, y] of [
      [b.a, b.b],
      [b.b, b.a],
    ]) {
      if (t.atoms[y]?.element === 'H' && t.atoms[x]?.element !== 'H' && y !== hyd) hCount.set(x, (hCount.get(x) ?? 0) + 1);
    }
  }

  const screen = new Map<number, [number, number]>();
  const atoms: SketchAtom[] = [];
  for (const i of heavy) {
    const [x, y] = toScreen(uv.get(i)!);
    screen.set(i, [x, y]);
    const el = t.atoms[i].element;
    const h = hCount.get(i) ?? 0;
    const charge = t.atoms[i].charge ?? 0;
    const label = el === 'C' ? undefined : `${el}${h ? 'H' + (h > 1 ? sub(h) : '') : ''}${charge > 0 ? '⁺' : charge < 0 ? '⁻' : ''}`;
    atoms.push({ x, y, element: el, label });
  }

  let cx = 0, cy = 0;
  for (const [x, y] of screen.values()) {
    cx += x / screen.size;
    cy += y / screen.size;
  }
  const bonds: SketchBond[] = [];
  for (const b of t.bonds) {
    const p = screen.get(b.a);
    const q = screen.get(b.b);
    if (!p || !q) continue;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    const side = (cx - (p[0] + q[0]) / 2) * nx + (cy - (p[1] + q[1]) / 2) * ny;
    const inner = Math.abs(side) > 0.3 * len;
    if (side < 0) {
      nx = -nx;
      ny = -ny;
    }
    bonds.push({ x1: p[0], y1: p[1], x2: q[0], y2: q[1], order: b.order, nx, ny, inner });
  }

  const result: FragmentSketch = { width, height, atoms, bonds };
  if (stub) {
    const [x1, y1] = toScreen(stub[0]);
    const [x2, y2] = toScreen(stub[1]);
    result.stub = { x1, y1, x2, y2 };
  }
  return result;
}
