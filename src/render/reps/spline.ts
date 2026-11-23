/**
 * Small spline / frame helpers for the cartoon representation. Pure math, no three.js.
 * OWNER: render-advanced.
 *
 * Points are stored flat (x0, y0, z0, x1, ...) in Float64Arrays.
 */

/**
 * Uniform Catmull-Rom spline (tension 0.5) through `n` points, evaluated on interval `k` (between point k
 * and k+1) at parameter u ∈ [0, 1]. The curve passes through every control point. Missing neighbours at the
 * ends are replaced by linear extrapolation (p₋₁ = 2p₀ − p₁, pₙ = 2pₙ₋₁ − pₙ₋₂), which gives natural ends.
 *
 * Writes the position to out[o..o+2] and, if `dout` is given, the derivative dp/du to dout[d..d+2].
 */
export function catmullRom(
  pts: ArrayLike<number>,
  n: number,
  k: number,
  u: number,
  out: Float64Array,
  o: number,
  dout?: Float64Array,
  d = 0,
): void {
  const u2 = u * u;
  const u3 = u2 * u;
  for (let c = 0; c < 3; c++) {
    const p1 = pts[k * 3 + c];
    const p2 = k + 1 < n ? pts[(k + 1) * 3 + c] : 2 * p1 - pts[(k - 1) * 3 + c];
    const p0 = k > 0 ? pts[(k - 1) * 3 + c] : 2 * p1 - p2;
    const p3 = k + 2 < n ? pts[(k + 2) * 3 + c] : 2 * p2 - p1;
    const a = -p0 + p2;
    const b = 2 * p0 - 5 * p1 + 4 * p2 - p3;
    const e = -p0 + 3 * p1 - 3 * p2 + p3;
    out[o + c] = 0.5 * (2 * p1 + a * u + b * u2 + e * u3);
    if (dout) dout[d + c] = 0.5 * (a + 2 * b * u + 3 * e * u2);
  }
}

/** Hermite smoothstep on [0, 1]. */
export function smoothstep(u: number): number {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return x * x * (3 - 2 * x);
}

/** Derivative of smoothstep with respect to u. */
export function smoothstepDeriv(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  return 6 * u * (1 - u);
}

export function normalize3(v: Float64Array, o: number): number {
  const l = Math.hypot(v[o], v[o + 1], v[o + 2]);
  if (l > 1e-12) {
    v[o] /= l;
    v[o + 1] /= l;
    v[o + 2] /= l;
  }
  return l;
}

/** Remove the component of v (at o) along unit vector t (at to) and normalise. Returns the length before normalising. */
export function orthonormalize(v: Float64Array, o: number, t: Float64Array, to: number): number {
  const dot = v[o] * t[to] + v[o + 1] * t[to + 1] + v[o + 2] * t[to + 2];
  v[o] -= dot * t[to];
  v[o + 1] -= dot * t[to + 1];
  v[o + 2] -= dot * t[to + 2];
  return normalize3(v, o);
}

/** Any unit vector perpendicular to the unit vector t (at to), written to out[o..]. */
export function anyPerpendicular(t: Float64Array, to: number, out: Float64Array, o: number): void {
  const x = t[to], y = t[to + 1], z = t[to + 2];
  // Cross with the coordinate axis least aligned with t.
  if (Math.abs(x) < 0.6) {
    out[o] = 0; out[o + 1] = z; out[o + 2] = -y;
  } else {
    out[o] = -z; out[o + 1] = 0; out[o + 2] = x;
  }
  normalize3(out, o);
}

/**
 * Rotation-minimizing frames by the double-reflection method (Wang, Jüttler, Zheng & Liu 2008).
 * Given sample positions `pos` and unit tangents `tan` (m samples, flat), and an initial unit reference
 * vector already stored in ref[0..2] (perpendicular to tan[0..2]), fills ref for all samples.
 */
export function rotationMinimizingFrames(pos: Float64Array, tan: Float64Array, m: number, ref: Float64Array): void {
  for (let i = 0; i + 1 < m; i++) {
    const o = i * 3;
    const q = o + 3;
    const v1x = pos[q] - pos[o], v1y = pos[q + 1] - pos[o + 1], v1z = pos[q + 2] - pos[o + 2];
    const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
    let rx = ref[o], ry = ref[o + 1], rz = ref[o + 2];
    let tx = tan[o], ty = tan[o + 1], tz = tan[o + 2];
    if (c1 > 1e-12) {
      // Reflect r and t in the plane bisecting the two sample points.
      const fr = (2 / c1) * (v1x * rx + v1y * ry + v1z * rz);
      rx -= fr * v1x; ry -= fr * v1y; rz -= fr * v1z;
      const ft = (2 / c1) * (v1x * tx + v1y * ty + v1z * tz);
      tx -= ft * v1x; ty -= ft * v1y; tz -= ft * v1z;
    }
    // Second reflection maps the reflected tangent onto the next tangent.
    const v2x = tan[q] - tx, v2y = tan[q + 1] - ty, v2z = tan[q + 2] - tz;
    const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
    if (c2 > 1e-12) {
      const f = (2 / c2) * (v2x * rx + v2y * ry + v2z * rz);
      rx -= f * v2x; ry -= f * v2y; rz -= f * v2z;
    }
    ref[q] = rx; ref[q + 1] = ry; ref[q + 2] = rz;
    // Guard against drift: keep it exactly perpendicular and unit length.
    if (orthonormalize(ref, q, tan, q) < 1e-9) anyPerpendicular(tan, q, ref, q);
  }
}
