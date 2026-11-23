/**
 * Allocation-free 3D math used by the renderer and the picker. Pure (no three.js, no DOM) so it can be
 * unit-tested in node. OWNER: render-core.
 *
 * Matrices are written in three.js / WebGL column-major order (the layout of Matrix4.elements and of
 * InstancedMesh.instanceMatrix.array): elements [0..3] are the first column (the image of local +X),
 * [4..7] the image of +Y, [8..11] the image of +Z, [12..14] the translation.
 */

/** Scratch vector type for out-parameters. */
export type V3 = { x: number; y: number; z: number };

export function v3(x = 0, y = 0, z = 0): V3 {
  return { x, y, z };
}

/**
 * Write `out = some unit vector perpendicular to the unit vector (ax, ay, az)`. Deterministic and
 * continuous except where the axis crosses between octant regions (fine for rendering).
 */
export function perpendicularUnit(ax: number, ay: number, az: number, out: V3): V3 {
  // Cross with the world axis that is least aligned with `a` (best conditioned).
  const fx = Math.abs(ax);
  const fy = Math.abs(ay);
  const fz = Math.abs(az);
  let px: number, py: number, pz: number;
  if (fx <= fy && fx <= fz) {
    // a × X = (0, az, -ay)
    px = 0;
    py = az;
    pz = -ay;
  } else if (fy <= fz) {
    // a × Y = (-az, 0, ax)
    px = -az;
    py = 0;
    pz = ax;
  } else {
    // a × Z = (ay, -ax, 0)
    px = ay;
    py = -ax;
    pz = 0;
  }
  const l = Math.hypot(px, py, pz) || 1;
  out.x = px / l;
  out.y = py / l;
  out.z = pz / l;
  return out;
}

/** Uniformly scaled, translated matrix for a unit sphere. */
export function writeSphereMatrix(out: Float32Array, offset: number, x: number, y: number, z: number, r: number): void {
  out[offset] = r;
  out[offset + 1] = 0;
  out[offset + 2] = 0;
  out[offset + 3] = 0;
  out[offset + 4] = 0;
  out[offset + 5] = r;
  out[offset + 6] = 0;
  out[offset + 7] = 0;
  out[offset + 8] = 0;
  out[offset + 9] = 0;
  out[offset + 10] = r;
  out[offset + 11] = 0;
  out[offset + 12] = x;
  out[offset + 13] = y;
  out[offset + 14] = z;
  out[offset + 15] = 1;
}

const _perp = v3();

/**
 * Matrix that maps the unit cylinder (radius 1 around +Y, from y = 0 to y = 1) onto the cylinder of
 * radius `r` from P0 to P1. Columns: X → u·r, Y → (P1 − P0), Z → w·r with u ⟂ axis and w = u × axis,
 * so the determinant is positive (winding / front faces are preserved) and the columns are orthogonal
 * (three's instanced normal transform supports non-uniform scale without shear).
 * `refPerp` (optional, unit, ⟂ axis) fixes the roll of the cylinder; otherwise a stable perpendicular is used.
 * A degenerate segment (length ≈ 0) writes a zero-scale matrix so the instance is invisible.
 */
export function writeCylinderMatrix(
  out: Float32Array,
  offset: number,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  r: number,
  refPerp?: V3,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) {
    for (let i = 0; i < 16; i++) out[offset + i] = 0;
    out[offset + 12] = x0;
    out[offset + 13] = y0;
    out[offset + 14] = z0;
    out[offset + 15] = 1;
    return;
  }
  const ax = dx / len;
  const ay = dy / len;
  const az = dz / len;
  const u = refPerp ?? perpendicularUnit(ax, ay, az, _perp);
  // w = u × a
  const wx = u.y * az - u.z * ay;
  const wy = u.z * ax - u.x * az;
  const wz = u.x * ay - u.y * ax;
  out[offset] = u.x * r;
  out[offset + 1] = u.y * r;
  out[offset + 2] = u.z * r;
  out[offset + 3] = 0;
  out[offset + 4] = dx;
  out[offset + 5] = dy;
  out[offset + 6] = dz;
  out[offset + 7] = 0;
  out[offset + 8] = wx * r;
  out[offset + 9] = wy * r;
  out[offset + 10] = wz * r;
  out[offset + 11] = 0;
  out[offset + 12] = x0;
  out[offset + 13] = y0;
  out[offset + 14] = z0;
  out[offset + 15] = 1;
}

/**
 * Offset direction for drawing multiple bonds A–B: the unit vector perpendicular to the bond axis that
 * lies in the plane (A, B, R) and points towards the reference atom R (typically a neighbour of A or B).
 * Note the perpendicular component of (R − A) equals that of (R − B) since A − B is along the axis.
 * Falls back to a stable arbitrary perpendicular if there is no reference or R is collinear with A–B.
 */
export function bondOffsetDirection(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  ref: V3 | null,
  out: V3,
): V3 {
  let ux = bx - ax;
  let uy = by - ay;
  let uz = bz - az;
  const ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-9) {
    out.x = 1;
    out.y = 0;
    out.z = 0;
    return out;
  }
  ux /= ul;
  uy /= ul;
  uz /= ul;
  if (ref) {
    const vx = ref.x - ax;
    const vy = ref.y - ay;
    const vz = ref.z - az;
    const d = vx * ux + vy * uy + vz * uz;
    const nx = vx - d * ux;
    const ny = vy - d * uy;
    const nz = vz - d * uz;
    const nl = Math.hypot(nx, ny, nz);
    const vl = Math.hypot(vx, vy, vz);
    // Require a non-negligible perpendicular part (≈ > 3° away from collinear).
    if (nl > 1e-6 && nl > 0.05 * vl) {
      out.x = nx / nl;
      out.y = ny / nl;
      out.z = nz / nl;
      return out;
    }
  }
  return perpendicularUnit(ux, uy, uz, out);
}

// ---------------------------------------------------------------------------
// Ray intersection. Rays: origin O, unit direction D. Return the ray parameter t of the first hit in
// front of the origin (t > 0), or -1 for no hit. Hits whose entry point lies behind the origin (the
// origin is inside the primitive) are reported as misses: for picking, the camera inside an atom
// should not pick that atom.
// ---------------------------------------------------------------------------

export function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): number {
  const lx = cx - ox;
  const ly = cy - oy;
  const lz = cz - oz;
  const b = lx * dx + ly * dy + lz * dz; // projection of the center onto the ray
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const h = b * b - c;
  if (h < 0) return -1;
  const t = b - Math.sqrt(h);
  return t > 0 ? t : -1;
}

/**
 * Ray vs capsule (cylinder of radius r from A to B with hemispherical caps).
 * Analytic: solve the infinite-cylinder quadratic, accept the body hit if it lies between the caps,
 * otherwise intersect the cap sphere on the side of the hit (after I. Quilez).
 */
export function rayCapsule(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number,
): number {
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const oax = ox - ax;
  const oay = oy - ay;
  const oaz = oz - az;
  const baba = bax * bax + bay * bay + baz * baz;
  if (baba < 1e-18) return raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r);
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const a = baba - bard * bard;
  if (a < 1e-12 * baba) {
    // Ray parallel to the axis: only the caps can be hit first.
    const t1 = raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, r);
    const t2 = raySphere(ox, oy, oz, dx, dy, dz, bx, by, bz, r);
    if (t1 < 0) return t2;
    if (t2 < 0) return t1;
    return Math.min(t1, t2);
  }
  const b = baba * rdoa - baoa * bard;
  const c = baba * oaoa - baoa * baoa - r * r * baba;
  const h = b * b - a * c;
  if (h < 0) return -1;
  const t = (-b - Math.sqrt(h)) / a;
  const y = baoa + t * bard;
  if (y > 0 && y < baba) return t > 0 ? t : -1;
  // Caps: sphere at A if the body hit is below A, else at B.
  const cx = y <= 0 ? ax : bx;
  const cy = y <= 0 ? ay : by;
  const cz = y <= 0 ? az : bz;
  return raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r);
}

/** Möller–Trumbore ray/triangle intersection (double sided). */
export function rayTriangle(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  v0x: number,
  v0y: number,
  v0z: number,
  v1x: number,
  v1y: number,
  v1z: number,
  v2x: number,
  v2y: number,
  v2z: number,
): number {
  const e1x = v1x - v0x;
  const e1y = v1y - v0y;
  const e1z = v1z - v0z;
  const e2x = v2x - v0x;
  const e2y = v2y - v0y;
  const e2z = v2z - v0z;
  // p = d × e2
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det;
  const tx = ox - v0x;
  const ty = oy - v0y;
  const tz = oz - v0z;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  // q = t × e1
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0 ? t : -1;
}

/**
 * Closest approach between a ray (O + tD, t ≥ 0, D unit) and a segment A–B.
 * Writes into `out`: x = squared distance, y = ray parameter t, z = segment parameter s ∈ [0, 1].
 */
export function raySegmentClosest(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  out: V3,
): V3 {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const wx = ox - ax;
  const wy = oy - ay;
  const wz = oz - az;
  const uu = ux * ux + uy * uy + uz * uz;
  const ud = ux * dx + uy * dy + uz * dz;
  const uw = ux * wx + uy * wy + uz * wz;
  const dw = dx * wx + dy * wy + dz * wz;
  // Minimise |W + tD − sU|² over t ≥ 0, s ∈ [0, 1].
  const denom = uu - ud * ud; // uu·dd − ud², dd = 1
  let s: number;
  let t: number;
  if (uu < 1e-18) {
    s = 0;
    t = Math.max(0, -dw);
  } else {
    s = denom > 1e-12 * uu ? (uw - ud * dw) / denom : 0;
    s = Math.min(1, Math.max(0, s));
    t = s * ud - dw;
    if (t < 0) {
      t = 0;
      s = Math.min(1, Math.max(0, uw / uu));
    }
  }
  const cx = wx + t * dx - s * ux;
  const cy = wy + t * dy - s * uy;
  const cz = wz + t * dz - s * uz;
  out.x = cx * cx + cy * cy + cz * cz;
  out.y = t;
  out.z = s;
  return out;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** sRGB transfer function → linear (IEC 61966-2-1). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Camera distance at which a sphere of radius `radius` fits a perspective view with vertical field of
 * view `fovDeg` and the given aspect (width / height), with a relative `margin`.
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.05): number {
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  const half = Math.min(halfV, halfH);
  return (radius * margin) / Math.sin(half);
}

/** Relative luminance (0..1) of an sRGB hex colour; used to pick overlay ink colours. */
export function hexLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
