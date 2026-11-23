/**
 * Solvent-excluded (SES) molecular surface on a grid. Pure computation (no three.js, no DOM) so it runs
 * both in the surface Web Worker and on the main thread. OWNER: render-advanced.
 *
 * Definitions (radii r_i already include rep.scale, probe radius r_p):
 *   SAS sphere radius R_i = r_i + r_p.  s(p) = min_i (|p − c_i| − R_i)   (< 0 inside the SAS)
 *   The SES is the boundary of the region the probe cannot reach: a point p is inside the SES iff its
 *   distance D(p) to the nearest SAS-exterior point exceeds r_p. We extract the isosurface
 *   F(p) = D(p) − r_p = 0 (F > 0 inside) with surface nets.
 *
 * Algorithm
 *   1. Grid around the atoms (spacing h, coarsened so the voxel count stays below `maxVoxels`).
 *   2. s(p) and the arg-min atom k(p) by stamping each SAS sphere (+2h band) into the grid.
 *   3. Accessible probe positions (points on the SAS boundary):
 *      a. sphere patches — the radial projection of each SAS-boundary exterior voxel onto its nearest
 *         sphere (always accessible);
 *      b. saddles — the intersection circles of overlapping SAS spheres of surface atoms, sampled every
 *         ≤ h/2, keeping accessible samples, plus the exact triple points (probe touching three atoms)
 *         where an accessible arc ends.
 *   4. D(p) for interior voxels: if the radial projection of p onto sphere k(p) is accessible, D = −s(p)
 *      exactly (contact / convex part of the SES). Otherwise (re-entrant part) D = distance to the nearest
 *      probe position from step 3, obtained by stamping a ball of radius r_p + 2h around each one.
 *   5. Surface nets (one vertex per sign-changing cube at the mean of its edge crossings, a quad per
 *      sign-changing grid edge) → closed, welded, consistently wound mesh.
 *   6. Vertex refinement: contact vertices are snapped exactly onto their atom's vdW sphere (exact
 *      normal); re-entrant vertices take Newton steps on the trilinear F, with normals from the
 *      interpolated central-difference gradient. Each vertex is assigned the atom minimising |v − c_i| − r_i.
 *   With r_p = 0 this degenerates to the van der Waals surface.
 *
 *   Accuracy (vs. the analytic SES of small test systems): mean |error| ≈ 0.005 Å, max ≈ 0.1 Å at h = 0.8.
 */

export interface SurfaceInput {
  /** Atom centers, flat xyz (Å). */
  positions: Float32Array;
  /** Atom radii (Å), already multiplied by the representation scale. */
  radii: Float32Array;
  /** Probe radius (Å); 0 gives the van der Waals surface. */
  probeRadius: number;
  /** Requested grid spacing (Å). */
  spacing: number;
  /** Upper bound on grid points; spacing is increased to respect it (default 8M). */
  maxVoxels?: number;
}

export interface SurfaceMeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per-vertex closest atom (index into the input arrays). */
  atom: Int32Array;
  /** Grid spacing actually used (Å). */
  spacing: number;
  dims: [number, number, number];
}

export interface GridPlan {
  origin: [number, number, number];
  dims: [number, number, number];
  spacing: number;
}

export interface SurfaceWorkerRequest {
  id: number;
  input: SurfaceInput;
}

export type SurfaceWorkerResponse =
  | { id: number; ok: true; mesh: SurfaceMeshData | null }
  | { id: number; ok: false; error: string };

export const DEFAULT_MAX_VOXELS = 8_000_000;

class Aborted extends Error {}

/** Choose grid origin, dimensions and spacing (coarsened to stay under maxVoxels). */
export function planGrid(
  positions: ArrayLike<number>,
  radii: ArrayLike<number>,
  probe: number,
  spacing: number,
  maxVoxels = DEFAULT_MAX_VOXELS,
): GridPlan {
  const n = radii.length;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = positions[i * 3 + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
    if (radii[i] > maxR) maxR = radii[i];
  }
  maxR += probe;
  let h = Math.max(0.1, spacing);
  let dims: [number, number, number] = [0, 0, 0];
  let margin = 0;
  for (let iter = 0; iter < 50; iter++) {
    // SAS spheres are stamped with a 2h band; one more voxel keeps the border strictly exterior.
    margin = maxR + 3 * h;
    dims = [0, 1, 2].map((c) => Math.ceil((max[c] - min[c] + 2 * margin) / h) + 1) as [number, number, number];
    const total = dims[0] * dims[1] * dims[2];
    if (total <= maxVoxels) break;
    h *= Math.cbrt(total / maxVoxels) * 1.01;
  }
  return { origin: [min[0] - margin, min[1] - margin, min[2] - margin], dims, spacing: h };
}

/** Uniform cell grid over atom centers (counting sort), for neighbour queries within one cell. */
class AtomGrid {
  readonly cell: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly start: Int32Array;
  readonly items: Int32Array;

  constructor(pos: Float32Array, n: number, cell: number) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (z < z0) z0 = z;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (z > z1) z1 = z;
    }
    this.cell = cell;
    this.ox = x0;
    this.oy = y0;
    this.oz = z0;
    this.nx = Math.max(1, Math.floor((x1 - x0) / cell) + 1);
    this.ny = Math.max(1, Math.floor((y1 - y0) / cell) + 1);
    this.nz = Math.max(1, Math.floor((z1 - z0) / cell) + 1);
    const nc = this.nx * this.ny * this.nz;
    const cellOf = new Int32Array(n);
    const counts = new Int32Array(nc + 1);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < nc; c++) counts[c + 1] += counts[c];
    this.start = counts.slice();
    const fill = counts;
    this.items = new Int32Array(n);
    for (let i = 0; i < n; i++) this.items[fill[cellOf[i]]++] = i;
  }

  cellCoord(v: number, o: number, n: number): number {
    const c = Math.floor((v - o) / this.cell);
    return c < 0 ? 0 : c >= n ? n - 1 : c;
  }

  cellIndex(x: number, y: number, z: number): number {
    return (
      this.cellCoord(x, this.ox, this.nx) +
      this.nx * (this.cellCoord(y, this.oy, this.ny) + this.ny * this.cellCoord(z, this.oz, this.nz))
    );
  }
}

/** Growable Float32 / Int32 / Uint32 buffers. */
class GrowF32 {
  data: Float32Array;
  length = 0;
  constructor(cap: number) {
    this.data = new Float32Array(Math.max(16, cap));
  }
  push3(x: number, y: number, z: number) {
    if (this.length + 3 > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.length++] = x;
    this.data[this.length++] = y;
    this.data[this.length++] = z;
  }
  result(): Float32Array {
    return this.data.slice(0, this.length);
  }
}

class GrowU32 {
  data: Uint32Array;
  length = 0;
  constructor(cap: number) {
    this.data = new Uint32Array(Math.max(16, cap));
  }
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) {
      const d = new Uint32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  push4(a: number, b: number, c: number, d: number) {
    this.push3(a, b, c);
    if (this.length + 1 > this.data.length) {
      const nd = new Uint32Array(this.data.length * 2);
      nd.set(this.data);
      this.data = nd;
    }
    this.data[this.length++] = d;
  }
  result(): Uint32Array {
    return this.data.slice(0, this.length);
  }
}

/**
 * Compute the SES mesh. Returns null if there is nothing to triangulate (no atoms) or if `shouldAbort`
 * returned true (it is polled between phases and inside long loops).
 */
export function computeSurface(input: SurfaceInput, shouldAbort?: () => boolean): SurfaceMeshData | null {
  try {
    return computeSurfaceImpl(input, shouldAbort ?? (() => false));
  } catch (e) {
    if (e instanceof Aborted) return null;
    throw e;
  }
}

function computeSurfaceImpl(input: SurfaceInput, shouldAbort: () => boolean): SurfaceMeshData | null {
  const pos = input.positions;
  const n = input.radii.length;
  if (n === 0) return null;
  const rp = Math.max(0, Number.isFinite(input.probeRadius) ? input.probeRadius : 1.4);
  const radii = new Float64Array(n);
  for (let i = 0; i < n; i++) radii[i] = input.radii[i] > 0 && Number.isFinite(input.radii[i]) ? input.radii[i] : 1.5;
  const check = () => {
    if (shouldAbort()) throw new Aborted();
  };

  const plan = planGrid(pos, radii, rp, input.spacing, input.maxVoxels ?? DEFAULT_MAX_VOXELS);
  if (!plan.dims.every((d) => Number.isFinite(d) && d >= 2)) return null; // non-finite coordinates
  const [nx, ny, nz] = plan.dims;
  const [ox, oy, oz] = plan.origin;
  const h = plan.spacing;
  const nxy = nx * ny;
  const N = nxy * nz;

  // SAS radii and a cell grid over atom centres (cell ≥ max SAS radius, so an atom whose SAS sphere
  // contains q lies within the 27 cells around q).
  const R = new Float64Array(n);
  const R2 = new Float64Array(n);
  let maxR = 0;
  for (let i = 0; i < n; i++) {
    R[i] = radii[i] + rp;
    R2[i] = R[i] * R[i];
    if (R[i] > maxR) maxR = R[i];
  }
  const grid = new AtomGrid(pos, n, maxR + h);
  const gs = grid.start;
  const gi = grid.items;

  // Neighbour lists (CSR): atoms whose SAS spheres overlap. Any sphere containing a point of sphere k's
  // surface overlaps sphere k, so accessibility tests of points on sphere k only need k's neighbours.
  const nbrStart = new Int32Array(n + 1);
  let nbr = new Int32Array(Math.max(16, n * 24));
  let nbrLen = 0;
  {
    const range = Math.ceil((2 * maxR) / grid.cell);
    for (let k = 0; k < n; k++) {
      if ((k & 4095) === 0) check();
      nbrStart[k] = nbrLen;
      const kx = pos[k * 3], ky = pos[k * 3 + 1], kz = pos[k * 3 + 2];
      const gx = grid.cellCoord(kx, grid.ox, grid.nx);
      const gy = grid.cellCoord(ky, grid.oy, grid.ny);
      const gz = grid.cellCoord(kz, grid.oz, grid.nz);
      for (let z = Math.max(0, gz - range); z <= Math.min(grid.nz - 1, gz + range); z++) {
        for (let y = Math.max(0, gy - range); y <= Math.min(grid.ny - 1, gy + range); y++) {
          const row = grid.nx * (y + grid.ny * z);
          for (let c = row + Math.max(0, gx - range); c <= row + Math.min(grid.nx - 1, gx + range); c++) {
            for (let t = gs[c], te = gs[c + 1]; t < te; t++) {
              const j = gi[t];
              if (j === k) continue;
              const dx = pos[j * 3] - kx, dy = pos[j * 3 + 1] - ky, dz = pos[j * 3 + 2] - kz;
              const rr = R[k] + R[j];
              if (dx * dx + dy * dy + dz * dz >= rr * rr) continue;
              if (nbrLen === nbr.length) {
                const grown = new Int32Array(nbr.length * 2);
                grown.set(nbr);
                nbr = grown;
              }
              nbr[nbrLen++] = j;
            }
          }
        }
      }
    }
    nbrStart[n] = nbrLen;
  }

  /**
   * First atom whose SAS sphere strictly contains q, or -1 if q is accessible. q must lie on (or inside)
   * the SAS sphere of `home`; `home`, e2 and e3 are excluded from the test.
   */
  let lastOcc = -1;
  const occluder = (qx: number, qy: number, qz: number, home: number, e2: number, e3: number): number => {
    if (lastOcc >= 0 && lastOcc !== home && lastOcc !== e2 && lastOcc !== e3) {
      const j = lastOcc;
      const dx = qx - pos[j * 3], dy = qy - pos[j * 3 + 1], dz = qz - pos[j * 3 + 2];
      if (dx * dx + dy * dy + dz * dz < R2[j] * (1 - 1e-7)) return j;
    }
    for (let t = nbrStart[home], te = nbrStart[home + 1]; t < te; t++) {
      const j = nbr[t];
      if (j === e2 || j === e3) continue;
      const dx = qx - pos[j * 3], dy = qy - pos[j * 3 + 1], dz = qz - pos[j * 3 + 2];
      if (dx * dx + dy * dy + dz * dz < R2[j] * (1 - 1e-7)) {
        lastOcc = j;
        return j;
      }
    }
    return -1;
  };

  // ---- 2. SAS signed distance and arg-min atom -------------------------------------------------------
  const BIG = 1e20;
  const F = new Float32Array(N).fill(BIG);
  const K = new Int32Array(N).fill(-1);
  const band = 2 * h;
  for (let a = 0; a < n; a++) {
    if ((a & 2047) === 0) check();
    const cx = pos[a * 3], cy = pos[a * 3 + 1], cz = pos[a * 3 + 2];
    const Ra = R[a];
    const reach = Ra + band;
    const reach2 = reach * reach;
    const k0 = Math.max(0, Math.ceil((cz - reach - oz) / h));
    const k1 = Math.min(nz - 1, Math.floor((cz + reach - oz) / h));
    for (let k = k0; k <= k1; k++) {
      const dz = oz + k * h - cz;
      const rz2 = reach2 - dz * dz;
      if (rz2 < 0) continue;
      const rz = Math.sqrt(rz2);
      const j0 = Math.max(0, Math.ceil((cy - rz - oy) / h));
      const j1 = Math.min(ny - 1, Math.floor((cy + rz - oy) / h));
      for (let j = j0; j <= j1; j++) {
        const dy = oy + j * h - cy;
        const ry2 = rz2 - dy * dy;
        if (ry2 < 0) continue;
        const rx = Math.sqrt(ry2);
        const i0 = Math.max(0, Math.ceil((cx - rx - ox) / h));
        const i1 = Math.min(nx - 1, Math.floor((cx + rx - ox) / h));
        const dyz2 = dy * dy + dz * dz;
        const base = k * nxy + j * nx;
        for (let i = i0; i <= i1; i++) {
          const idx = base + i;
          const t = F[idx] + Ra;
          if (t <= 0) continue; // |p − c| − R ≥ −R ≥ current value
          const dx = ox + i * h - cx;
          const d2 = dx * dx + dyz2;
          if (d2 < t * t) {
            F[idx] = Math.sqrt(d2) - Ra;
            K[idx] = a;
          }
        }
      }
    }
  }
  check();

  const outsideClamp = -(rp + band);
  const insideClamp = band;

  if (rp > 0) {
    // ---- 3. accessible probe positions ------------------------------------------------------------------
    const samples = new GrowF32(1024);
    const surfaceAtom = new Uint8Array(n);

    // 3a. Sphere patches. The radial projection q of an exterior voxel e onto its nearest SAS sphere k is
    //     always accessible: |q − c_j| ≥ |e − c_j| − s(e) ≥ R_j for every other atom j.
    for (let k = 1; k < nz - 1; k++) {
      check();
      for (let j = 1; j < ny - 1; j++) {
        const base = k * nxy + j * nx;
        for (let i = 1; i < nx - 1; i++) {
          const idx = base + i;
          const s = F[idx];
          const a = K[idx];
          if (s < 0 || a < 0) continue;
          if (!(F[idx - 1] < 0 || F[idx + 1] < 0 || F[idx - nx] < 0 || F[idx + nx] < 0 || F[idx - nxy] < 0 || F[idx + nxy] < 0)) continue;
          const vx = ox + i * h - pos[a * 3], vy = oy + j * h - pos[a * 3 + 1], vz = oz + k * h - pos[a * 3 + 2];
          const f = R[a] / (Math.hypot(vx, vy, vz) || 1);
          samples.push3(pos[a * 3] + vx * f, pos[a * 3 + 1] + vy * f, pos[a * 3 + 2] + vz * f);
          surfaceAtom[a] = 1;
        }
      }
    }

    // 3b. Saddles: a probe touching atoms k and j sits on the intersection circle of their SAS spheres.
    //     Circles of surface atoms are sampled every ≤ h/2; accessible samples are kept, and where an
    //     accessible arc ends the exact triple point (probe touching k, j and the occluding atom l, i.e. the
    //     centre of a concave spherical patch) is added.
    const tp = new Float64Array(3);
    /** Intersection point of SAS spheres k, j, l nearest to (px, py, pz); false if they do not meet. */
    const triplePoint = (k: number, j: number, l: number, px: number, py: number, pz: number): boolean => {
      const ckx = pos[k * 3], cky = pos[k * 3 + 1], ckz = pos[k * 3 + 2];
      let ux = pos[j * 3] - ckx, uy = pos[j * 3 + 1] - cky, uz = pos[j * 3 + 2] - ckz;
      const d = Math.hypot(ux, uy, uz);
      if (d < 1e-9) return false;
      ux /= d; uy /= d; uz /= d;
      const lx = pos[l * 3] - ckx, ly = pos[l * 3 + 1] - cky, lz = pos[l * 3 + 2] - ckz;
      const ii = ux * lx + uy * ly + uz * lz;
      let eyx = lx - ii * ux, eyy = ly - ii * uy, eyz = lz - ii * uz;
      const eyl = Math.hypot(eyx, eyy, eyz);
      if (eyl < 1e-9) return false; // collinear centres
      eyx /= eyl; eyy /= eyl; eyz /= eyl;
      const jj = eyx * lx + eyy * ly + eyz * lz;
      const ezx = uy * eyz - uz * eyy, ezy = uz * eyx - ux * eyz, ezz = ux * eyy - uy * eyx;
      // Trilateration in the frame (u, ey, ez) centred on c_k.
      const X = (d * d + R2[k] - R2[j]) / (2 * d);
      const Y = (R2[k] - R2[l] + ii * ii + jj * jj) / (2 * jj) - (ii / jj) * X;
      const z2 = R2[k] - X * X - Y * Y;
      if (z2 < 0) return false;
      const Z = Math.sqrt(z2);
      const bx = ckx + X * ux + Y * eyx, by = cky + X * uy + Y * eyy, bz = ckz + X * uz + Y * eyz;
      const side = (px - bx) * ezx + (py - by) * ezy + (pz - bz) * ezz >= 0 ? Z : -Z;
      tp[0] = bx + side * ezx;
      tp[1] = by + side * ezy;
      tp[2] = bz + side * ezz;
      return true;
    };
    const arcStep = Math.max(0.15, 0.5 * h);
    for (let k = 0; k < n; k++) {
      if (!surfaceAtom[k]) continue;
      if ((k & 1023) === 0) check();
      const ckx = pos[k * 3], cky = pos[k * 3 + 1], ckz = pos[k * 3 + 2];
      for (let t = nbrStart[k], te = nbrStart[k + 1]; t < te; t++) {
        const j = nbr[t];
        // Each pair once: from the lower index if both are surface atoms, else from the surface atom.
        if (surfaceAtom[j] && j < k) continue;
        let ux = pos[j * 3] - ckx, uy = pos[j * 3 + 1] - cky, uz = pos[j * 3 + 2] - ckz;
        const d = Math.hypot(ux, uy, uz);
        if (d <= Math.abs(R[k] - R[j]) || d < 1e-9) continue; // one sphere inside the other
        ux /= d; uy /= d; uz /= d;
        const x0 = (d * d + R2[k] - R2[j]) / (2 * d);
        const rho = Math.sqrt(Math.max(0, R2[k] - x0 * x0));
        const ccx = ckx + ux * x0, ccy = cky + uy * x0, ccz = ckz + uz * x0;
        // Orthonormal basis (e1, e2) of the circle plane.
        let e1x: number, e1y: number, e1z: number;
        if (Math.abs(ux) < 0.6) { e1x = 0; e1y = uz; e1z = -uy; } else { e1x = -uz; e1y = 0; e1z = ux; }
        const e1l = Math.hypot(e1x, e1y, e1z);
        e1x /= e1l; e1y /= e1l; e1z /= e1l;
        const e2x = uy * e1z - uz * e1y, e2y = uz * e1x - ux * e1z, e2z = ux * e1y - uy * e1x;
        const m = Math.max(8, Math.ceil((2 * Math.PI * rho) / arcStep));
        let firstAcc = false, firstOcc = -1, prevAcc = false, prevOcc = -1;
        let qpx = 0, qpy = 0, qpz = 0;
        for (let s = 0; s <= m; s++) {
          const th = (2 * Math.PI * (s % m)) / m;
          const co = Math.cos(th) * rho, si = Math.sin(th) * rho;
          const qx = ccx + co * e1x + si * e2x, qy = ccy + co * e1y + si * e2y, qz = ccz + co * e1z + si * e2z;
          let acc: boolean, occ: number;
          if (s === m) {
            acc = firstAcc;
            occ = firstOcc;
          } else {
            occ = occluder(qx, qy, qz, k, j, -1);
            acc = occ < 0;
            if (acc) samples.push3(qx, qy, qz);
            if (s === 0) {
              firstAcc = acc;
              firstOcc = occ;
            }
          }
          if (s > 0 && acc !== prevAcc) {
            const l = acc ? prevOcc : occ;
            if (l >= 0 && triplePoint(k, j, l, (qx + qpx) / 2, (qy + qpy) / 2, (qz + qpz) / 2) && occluder(tp[0], tp[1], tp[2], k, j, l) < 0) {
              samples.push3(tp[0], tp[1], tp[2]);
            }
          }
          prevAcc = acc;
          prevOcc = occ;
          qpx = qx; qpy = qy; qpz = qz;
        }
      }
    }

    // ---- 4a. contact region: exact D = −s when the radial projection is accessible ---------------------
    for (let k = 0; k < nz; k++) {
      check();
      for (let j = 0; j < ny; j++) {
        const base = k * nxy + j * nx;
        for (let i = 0; i < nx; i++) {
          const idx = base + i;
          const s = F[idx];
          if (s >= 0) {
            F[idx] = Math.max(-s - rp, outsideClamp);
            continue;
          }
          if (-s - rp >= insideClamp) {
            F[idx] = insideClamp;
            continue;
          }
          const a = K[idx];
          const px = ox + i * h, py = oy + j * h, pz = oz + k * h;
          const vx = px - pos[a * 3], vy = py - pos[a * 3 + 1], vz = pz - pos[a * 3 + 2];
          const vl = Math.hypot(vx, vy, vz);
          let accessible = false;
          if (vl > 1e-9) {
            const f = R[a] / vl;
            accessible = occluder(pos[a * 3] + vx * f, pos[a * 3 + 1] + vy * f, pos[a * 3 + 2] + vz * f, a, -1, -1) < 0;
          }
          F[idx] = accessible ? -s - rp : insideClamp;
        }
      }
    }

    // ---- 4b. re-entrant region: distance to the nearest probe position ---------------------------------
    const sd = samples.data;
    const ns = samples.length / 3;
    const reach = rp + band;
    const reach2 = reach * reach;
    for (let si = 0; si < ns; si++) {
      if ((si & 4095) === 0) check();
      const cx = sd[si * 3], cy = sd[si * 3 + 1], cz = sd[si * 3 + 2];
      const k0 = Math.max(0, Math.ceil((cz - reach - oz) / h));
      const k1 = Math.min(nz - 1, Math.floor((cz + reach - oz) / h));
      for (let k = k0; k <= k1; k++) {
        const dz = oz + k * h - cz;
        const rz2 = reach2 - dz * dz;
        if (rz2 < 0) continue;
        const rz = Math.sqrt(rz2);
        const j0 = Math.max(0, Math.ceil((cy - rz - oy) / h));
        const j1 = Math.min(ny - 1, Math.floor((cy + rz - oy) / h));
        for (let j = j0; j <= j1; j++) {
          const dy = oy + j * h - cy;
          const ry2 = rz2 - dy * dy;
          if (ry2 < 0) continue;
          const rx = Math.sqrt(ry2);
          const i0 = Math.max(0, Math.ceil((cx - rx - ox) / h));
          const i1 = Math.min(nx - 1, Math.floor((cx + rx - ox) / h));
          const dyz2 = dy * dy + dz * dz;
          const base = k * nxy + j * nx;
          for (let i = i0; i <= i1; i++) {
            const idx = base + i;
            const t = F[idx] + rp; // F = D − r_p; candidate D = |p − x|
            if (t <= 0) continue;
            const dx = ox + i * h - cx;
            const d2 = dx * dx + dyz2;
            if (d2 < t * t) F[idx] = Math.sqrt(d2) - rp;
          }
        }
      }
    }
  } else {
    // Van der Waals surface: F = −s.
    for (let idx = 0; idx < N; idx++) {
      const s = F[idx];
      F[idx] = s >= 0 ? Math.max(-s, outsideClamp) : Math.min(-s, insideClamp);
    }
  }
  check();

  // ---- 5. surface nets --------------------------------------------------------------------------------
  const cx1 = nx - 1;
  const cy1 = ny - 1;
  const cubesPerLayer = cx1 * cy1;
  let prevLayer = new Int32Array(cubesPerLayer).fill(-1);
  let curLayer = new Int32Array(cubesPerLayer).fill(-1);
  const estimate = Math.max(1024, Math.round(N ** (2 / 3) * 6));
  const vpos = new GrowF32(estimate * 3);
  // Quads (one per sign-changing grid edge), counter-clockwise seen from outside; triangulated at the end.
  const quads = new GrowU32(estimate * 4);

  // Corner offsets (index) and coordinates for the 8 cube corners, bit c ↔ (c & 1, c >> 1 & 1, c >> 2 & 1).
  const cornerOff = [0, 1, nx, nx + 1, nxy, nxy + 1, nxy + nx, nxy + nx + 1];
  const edges: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], // x
    [0, 2], [1, 3], [4, 6], [5, 7], // y
    [0, 4], [1, 5], [2, 6], [3, 7], // z
  ];
  const val = new Float64Array(8);

  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) quads.push4(a, d, c, b);
    else quads.push4(a, b, c, d);
  };

  let vCount = 0;
  for (let k = 0; k < nz - 1; k++) {
    if ((k & 7) === 0) check();
    // Vertices of cube layer k.
    for (let j = 0; j < cy1; j++) {
      for (let i = 0; i < cx1; i++) {
        const base = k * nxy + j * nx + i;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = F[base + cornerOff[c]];
          val[c] = v;
          if (v > 0) mask |= 1 << c;
        }
        const ci = j * cx1 + i;
        if (mask === 0 || mask === 255) {
          curLayer[ci] = -1;
          continue;
        }
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          const [c0, c1] = edges[e];
          const in0 = (mask >> c0) & 1;
          const in1 = (mask >> c1) & 1;
          if (in0 === in1) continue;
          const v0 = val[c0];
          const t = v0 / (v0 - val[c1]);
          sx += (c0 & 1) + ((c1 & 1) - (c0 & 1)) * t;
          sy += ((c0 >> 1) & 1) + (((c1 >> 1) & 1) - ((c0 >> 1) & 1)) * t;
          sz += ((c0 >> 2) & 1) + (((c1 >> 2) & 1) - ((c0 >> 2) & 1)) * t;
          cnt++;
        }
        vpos.push3(ox + (i + sx / cnt) * h, oy + (j + sy / cnt) * h, oz + (k + sz / cnt) * h);
        curLayer[ci] = vCount++;
      }
    }
    // z-edges from grid level k to k+1 (all four cubes in layer k).
    for (let j = 1; j < cy1; j++) {
      for (let i = 1; i < cx1; i++) {
        const g = k * nxy + j * nx + i;
        const in0 = F[g] > 0;
        if (in0 === F[g + nxy] > 0) continue;
        const ci = j * cx1 + i;
        quad(curLayer[ci - cx1 - 1], curLayer[ci - cx1], curLayer[ci], curLayer[ci - 1], !in0);
      }
    }
    // x- and y-edges at grid level k (cubes in layers k−1 and k).
    if (k >= 1) {
      for (let j = 0; j < cy1; j++) {
        for (let i = 0; i < cx1; i++) {
          const g = k * nxy + j * nx + i;
          const in0 = F[g] > 0;
          const ci = j * cx1 + i;
          if (j >= 1 && in0 !== F[g + 1] > 0) {
            // x-edge (i,j,k)→(i+1,j,k): cubes (j−1,k−1), (j,k−1), (j,k), (j−1,k) — CCW about +x.
            quad(prevLayer[ci - cx1], prevLayer[ci], curLayer[ci], curLayer[ci - cx1], !in0);
          }
          if (i >= 1 && in0 !== F[g + nx] > 0) {
            // y-edge (i,j,k)→(i,j+1,k): cubes (i−1,k−1), (i−1,k), (i,k), (i,k−1) — CCW about +y.
            quad(prevLayer[ci - 1], curLayer[ci - 1], curLayer[ci], prevLayer[ci], !in0);
          }
        }
      }
    }
    const tmp = prevLayer;
    prevLayer = curLayer;
    curLayer = tmp;
  }
  check();
  if (vCount === 0 || quads.length === 0) return null;

  const positions = vpos.result();

  // ---- closest atom per vertex: arg-min |v − c| − r (the atom whose vdW sphere is nearest) -------------
  const atom = new Int32Array(vCount);
  for (let v = 0; v < vCount; v++) {
    if ((v & 16383) === 0) check();
    const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
    let best = -1;
    let bestD = Infinity;
    const cx = grid.cellCoord(px, grid.ox, grid.nx);
    const cy = grid.cellCoord(py, grid.oy, grid.ny);
    const cz = grid.cellCoord(pz, grid.oz, grid.nz);
    for (let z = Math.max(0, cz - 1); z <= Math.min(grid.nz - 1, cz + 1); z++) {
      for (let y = Math.max(0, cy - 1); y <= Math.min(grid.ny - 1, cy + 1); y++) {
        const row = grid.nx * (y + grid.ny * z);
        for (let c = row + Math.max(0, cx - 1); c <= row + Math.min(grid.nx - 1, cx + 1); c++) {
          for (let t = gs[c], te = gs[c + 1]; t < te; t++) {
            const a = gi[t];
            const d = Math.hypot(px - pos[a * 3], py - pos[a * 3 + 1], pz - pos[a * 3 + 2]) - radii[a];
            if (d < bestD) {
              bestD = d;
              best = a;
            }
          }
        }
      }
    }
    if (best < 0) {
      const gi0 = Math.round((px - ox) / h), gj0 = Math.round((py - oy) / h), gk0 = Math.round((pz - oz) / h);
      best = K[Math.min(nz - 1, Math.max(0, gk0)) * nxy + Math.min(ny - 1, Math.max(0, gj0)) * nx + Math.min(nx - 1, Math.max(0, gi0))];
      if (best < 0) best = 0;
    }
    atom[v] = best;
  }
  check();

  // ---- snap vertices onto the surface ------------------------------------------------------------------
  // The mean of the edge crossings lies slightly off curved surfaces, and trilinear interpolation of the
  // (concave) contact distance field shrinks convex parts by ~h²/8r. Contact vertices — whose radial
  // projection onto their atom's SAS sphere is accessible — are therefore placed exactly on the atom's
  // vdW sphere (with the exact normal). Re-entrant vertices take two Newton steps on the trilinear
  // interpolant of F, limited to half a voxel so creases cannot pull them away.
  const normals = new Float32Array(vCount * 3);
  const exactNormal = new Uint8Array(vCount);
  const maxStep = 0.5 * h;
  for (let v = 0; v < vCount; v++) {
    if ((v & 16383) === 0) check();
    const a = atom[v];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    let dx = positions[v * 3] - ax, dy = positions[v * 3 + 1] - ay, dz = positions[v * 3 + 2] - az;
    const dl = Math.hypot(dx, dy, dz);
    if (dl > 1e-9) {
      dx /= dl;
      dy /= dl;
      dz /= dl;
      if (occluder(ax + dx * R[a], ay + dy * R[a], az + dz * R[a], a, -1, -1) < 0) {
        positions[v * 3] = ax + dx * radii[a];
        positions[v * 3 + 1] = ay + dy * radii[a];
        positions[v * 3 + 2] = az + dz * radii[a];
        normals[v * 3] = dx;
        normals[v * 3 + 1] = dy;
        normals[v * 3 + 2] = dz;
        exactNormal[v] = 1;
        continue;
      }
    }
    for (let iter = 0; iter < 2; iter++) {
      const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
      const gx = (px - ox) / h, gy = (py - oy) / h, gz = (pz - oz) / h;
      const i0 = Math.min(nx - 2, Math.max(0, Math.floor(gx)));
      const j0 = Math.min(ny - 2, Math.max(0, Math.floor(gy)));
      const k0 = Math.min(nz - 2, Math.max(0, Math.floor(gz)));
      const fx = gx - i0, fy = gy - j0, fz = gz - k0;
      const b = k0 * nxy + j0 * nx + i0;
      const c000 = F[b], c100 = F[b + 1], c010 = F[b + nx], c110 = F[b + nx + 1];
      const c001 = F[b + nxy], c101 = F[b + nxy + 1], c011 = F[b + nxy + nx], c111 = F[b + nxy + nx + 1];
      // Trilinear value and gradient (per voxel unit).
      const x00 = c000 + (c100 - c000) * fx, x10 = c010 + (c110 - c010) * fx;
      const x01 = c001 + (c101 - c001) * fx, x11 = c011 + (c111 - c011) * fx;
      const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
      const val = y0 + (y1 - y0) * fz;
      const dfx =
        (1 - fz) * ((1 - fy) * (c100 - c000) + fy * (c110 - c010)) + fz * ((1 - fy) * (c101 - c001) + fy * (c111 - c011));
      const dfy = (1 - fz) * (x10 - x00) + fz * (x11 - x01);
      const dfz = y1 - y0;
      const g2 = dfx * dfx + dfy * dfy + dfz * dfz;
      if (g2 < 1e-12) break;
      // Newton step Δg = −F ∇F / |∇F|² in voxel units, then × h for world units.
      let sx = (-val * dfx) / g2, sy = (-val * dfy) / g2, sz = (-val * dfz) / g2;
      const sl = Math.hypot(sx, sy, sz) * h;
      if (sl > maxStep) {
        const f = maxStep / sl;
        sx *= f;
        sy *= f;
        sz *= f;
      }
      positions[v * 3] = px + sx * h;
      positions[v * 3 + 1] = py + sy * h;
      positions[v * 3 + 2] = pz + sz * h;
      if (Math.abs(val) < 1e-4 * h) break;
    }
  }

  // ---- remaining normals: −∇F (central differences, interpolated trilinearly) ---------------------------
  const Fat = (i: number, j: number, k: number) =>
    F[(k < 0 ? 0 : k >= nz ? nz - 1 : k) * nxy + (j < 0 ? 0 : j >= ny ? ny - 1 : j) * nx + (i < 0 ? 0 : i >= nx ? nx - 1 : i)];
  for (let v = 0; v < vCount; v++) {
    if (exactNormal[v]) continue;
    const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
    const gx = (px - ox) / h, gy = (py - oy) / h, gz = (pz - oz) / h;
    const i0 = Math.min(nx - 2, Math.max(0, Math.floor(gx)));
    const j0 = Math.min(ny - 2, Math.max(0, Math.floor(gy)));
    const k0 = Math.min(nz - 2, Math.max(0, Math.floor(gz)));
    const fx = gx - i0, fy = gy - j0, fz = gz - k0;
    let nxv = 0, nyv = 0, nzv = 0;
    for (let c = 0; c < 8; c++) {
      const di = c & 1, dj = (c >> 1) & 1, dk = (c >> 2) & 1;
      const w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy) * (dk ? fz : 1 - fz);
      if (w === 0) continue;
      const i = i0 + di, j = j0 + dj, k = k0 + dk;
      nxv += w * (Fat(i + 1, j, k) - Fat(i - 1, j, k));
      nyv += w * (Fat(i, j + 1, k) - Fat(i, j - 1, k));
      nzv += w * (Fat(i, j, k + 1) - Fat(i, j, k - 1));
    }
    let l = Math.hypot(nxv, nyv, nzv);
    if (l < 1e-12) {
      // Flat field (should not happen near the surface): point away from the closest atom.
      const a = atom[v];
      nxv = -(px - pos[a * 3]);
      nyv = -(py - pos[a * 3 + 1]);
      nzv = -(pz - pos[a * 3 + 2]);
      l = Math.hypot(nxv, nyv, nzv) || 1;
    }
    normals[v * 3] = -nxv / l;
    normals[v * 3 + 1] = -nyv / l;
    normals[v * 3 + 2] = -nzv / l;
  }

  // ---- triangulate quads ----------------------------------------------------------------------------------
  // Split along the shorter diagonal, unless that folds the quad against the vertex normals (strongly
  // non-planar quads near re-entrant cusps): then take the split whose triangles agree best with them.
  const qd = quads.data;
  const nq = quads.length / 4;
  const indices = new Uint32Array(nq * 6);
  /** cos(angle) between the face normal of (x, y, z) and the mean of its vertex normals; 1 if degenerate. */
  const agree = (x: number, y: number, z: number): number => {
    const ux = positions[y * 3] - positions[x * 3], uy = positions[y * 3 + 1] - positions[x * 3 + 1], uz = positions[y * 3 + 2] - positions[x * 3 + 2];
    const vx = positions[z * 3] - positions[x * 3], vy = positions[z * 3 + 1] - positions[x * 3 + 1], vz = positions[z * 3 + 2] - positions[x * 3 + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-12) return 1;
    const mx = normals[x * 3] + normals[y * 3] + normals[z * 3];
    const my = normals[x * 3 + 1] + normals[y * 3 + 1] + normals[z * 3 + 1];
    const mz = normals[x * 3 + 2] + normals[y * 3 + 2] + normals[z * 3 + 2];
    const ml = Math.hypot(mx, my, mz);
    return ml < 1e-12 ? 1 : (fx * mx + fy * my + fz * mz) / (fl * ml);
  };
  for (let q = 0, o = 0; q < nq; q++, o += 6) {
    const a = qd[q * 4], b = qd[q * 4 + 1], c = qd[q * 4 + 2], d = qd[q * 4 + 3];
    const sA = Math.min(agree(a, b, c), agree(a, c, d));
    const sB = Math.min(agree(a, b, d), agree(b, c, d));
    let useA: boolean;
    if (sA > 0.2 && sB > 0.2) {
      const ac = (positions[a * 3] - positions[c * 3]) ** 2 + (positions[a * 3 + 1] - positions[c * 3 + 1]) ** 2 + (positions[a * 3 + 2] - positions[c * 3 + 2]) ** 2;
      const bd = (positions[b * 3] - positions[d * 3]) ** 2 + (positions[b * 3 + 1] - positions[d * 3 + 1]) ** 2 + (positions[b * 3 + 2] - positions[d * 3 + 2]) ** 2;
      useA = ac <= bd;
    } else useA = sA >= sB;
    if (useA) {
      indices[o] = a; indices[o + 1] = b; indices[o + 2] = c;
      indices[o + 3] = a; indices[o + 4] = c; indices[o + 5] = d;
    } else {
      indices[o] = a; indices[o + 1] = b; indices[o + 2] = d;
      indices[o + 3] = b; indices[o + 4] = c; indices[o + 5] = d;
    }
  }

  return { positions, normals, indices, atom, spacing: h, dims: [nx, ny, nz] };

}
