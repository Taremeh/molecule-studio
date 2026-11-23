/**
 * Uniform spatial grid for fixed-radius neighbour queries (bond perception, `within` selections,
 * backbone H-bond search). OWNER: structure agent.
 *
 * Points are bucketed into cubic cells with a counting sort (O(n) build, two typed arrays, no
 * per-cell allocations). A query visits only the cells overlapping the query sphere's bounding box,
 * so with a cell size close to the query radius each query touches ≤ 27 cells.
 */
import type { Molecule } from './types';

/** Upper bound on the number of cells; sparse inputs get larger cells instead of a huge grid. */
const MAX_CELLS = 1 << 22;

export class SpatialGrid {
  readonly cellSize: number;
  /** Number of points stored in the grid. */
  readonly size: number;
  private readonly ox: number;
  private readonly oy: number;
  private readonly oz: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly inv: number;
  /** cellStart[c]..cellStart[c+1] indexes `items` for cell c. */
  private readonly cellStart: Int32Array;
  /** Point ids (indices into the source position array) sorted by cell. */
  private readonly items: Int32Array;
  /** Coordinates of `items`, same order (xyz interleaved) — keeps the inner loop cache friendly. */
  private readonly coords: Float64Array;

  /**
   * @param xyz      interleaved coordinates [x0,y0,z0,x1,...] of all points
   * @param cellSize desired cell edge length (Å); enlarged automatically for very sparse inputs
   * @param subset   optional point ids to insert (default: all points)
   */
  constructor(xyz: ArrayLike<number>, cellSize: number, subset?: ArrayLike<number>) {
    const count = subset ? subset.length : Math.floor(xyz.length / 3);
    this.size = count;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < count; k++) {
      const i = subset ? subset[k] : k;
      const x = fin(xyz[3 * i]), y = fin(xyz[3 * i + 1]), z = fin(xyz[3 * i + 2]);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    if (count === 0) minX = minY = minZ = maxX = maxY = maxZ = 0;

    let cs = Math.max(cellSize, 1e-3);
    const cap = Math.min(MAX_CELLS, Math.max(4096, 8 * count));
    let nx = 1, ny = 1, nz = 1;
    for (;;) {
      nx = Math.floor((maxX - minX) / cs) + 1;
      ny = Math.floor((maxY - minY) / cs) + 1;
      nz = Math.floor((maxZ - minZ) / cs) + 1;
      if (nx * ny * nz <= cap) break;
      cs *= Math.cbrt((nx * ny * nz) / cap) * 1.01;
    }
    this.cellSize = cs;
    this.inv = 1 / cs;
    this.ox = minX;
    this.oy = minY;
    this.oz = minZ;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;

    // Counting sort of points into cells.
    const nCells = nx * ny * nz;
    const cellOf = new Int32Array(count);
    const start = new Int32Array(nCells + 1);
    for (let k = 0; k < count; k++) {
      const i = subset ? subset[k] : k;
      const c = this.cellIndex(fin(xyz[3 * i]), fin(xyz[3 * i + 1]), fin(xyz[3 * i + 2]));
      cellOf[k] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < nCells; c++) start[c + 1] += start[c];
    const fill = start.slice(0, nCells);
    const items = new Int32Array(count);
    const coords = new Float64Array(3 * count);
    for (let k = 0; k < count; k++) {
      const i = subset ? subset[k] : k;
      const slot = fill[cellOf[k]]++;
      items[slot] = i;
      coords[3 * slot] = fin(xyz[3 * i]);
      coords[3 * slot + 1] = fin(xyz[3 * i + 1]);
      coords[3 * slot + 2] = fin(xyz[3 * i + 2]);
    }
    this.cellStart = start;
    this.items = items;
    this.coords = coords;
  }

  private cellIndex(x: number, y: number, z: number): number {
    const cx = clampInt(Math.floor((x - this.ox) * this.inv), this.nx);
    const cy = clampInt(Math.floor((y - this.oy) * this.inv), this.ny);
    const cz = clampInt(Math.floor((z - this.oz) * this.inv), this.nz);
    return (cz * this.ny + cy) * this.nx + cx;
  }

  /**
   * Calls `cb(id, d2)` for every stored point within `radius` of (x, y, z) (inclusive),
   * where d2 is the squared distance. Order is unspecified.
   */
  forEachWithin(x: number, y: number, z: number, radius: number, cb: (id: number, d2: number) => void): void {
    const r2 = radius * radius;
    const inv = this.inv;
    const x0 = Math.max(0, Math.floor((x - radius - this.ox) * inv));
    const x1 = Math.min(this.nx - 1, Math.floor((x + radius - this.ox) * inv));
    const y0 = Math.max(0, Math.floor((y - radius - this.oy) * inv));
    const y1 = Math.min(this.ny - 1, Math.floor((y + radius - this.oy) * inv));
    const z0 = Math.max(0, Math.floor((z - radius - this.oz) * inv));
    const z1 = Math.min(this.nz - 1, Math.floor((z + radius - this.oz) * inv));
    const { cellStart, items, coords, nx, ny } = this;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cy = y0; cy <= y1; cy++) {
        const row = (cz * ny + cy) * nx;
        const s = cellStart[row + x0];
        const e = cellStart[row + x1 + 1];
        // Cells x0..x1 of one row are contiguous in `items`.
        for (let k = s; k < e; k++) {
          const dx = coords[3 * k] - x;
          const dy = coords[3 * k + 1] - y;
          const dz = coords[3 * k + 2] - z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 <= r2) cb(items[k], d2);
        }
      }
    }
  }

  /** True if any stored point lies within `radius` of (x, y, z). Stops at the first hit. */
  anyWithin(x: number, y: number, z: number, radius: number): boolean {
    const r2 = radius * radius;
    const inv = this.inv;
    const x0 = Math.max(0, Math.floor((x - radius - this.ox) * inv));
    const x1 = Math.min(this.nx - 1, Math.floor((x + radius - this.ox) * inv));
    const y0 = Math.max(0, Math.floor((y - radius - this.oy) * inv));
    const y1 = Math.min(this.ny - 1, Math.floor((y + radius - this.oy) * inv));
    const z0 = Math.max(0, Math.floor((z - radius - this.oz) * inv));
    const z1 = Math.min(this.nz - 1, Math.floor((z + radius - this.oz) * inv));
    if (x0 > x1 || y0 > y1 || z0 > z1) return false;
    const { cellStart, coords, nx, ny } = this;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cy = y0; cy <= y1; cy++) {
        const row = (cz * ny + cy) * nx;
        const e = cellStart[row + x1 + 1];
        for (let k = cellStart[row + x0]; k < e; k++) {
          const dx = coords[3 * k] - x;
          const dy = coords[3 * k + 1] - y;
          const dz = coords[3 * k + 2] - z;
          if (dx * dx + dy * dy + dz * dz <= r2) return true;
        }
      }
    }
    return false;
  }
}

function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function clampInt(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

const positionCache = new WeakMap<Molecule, Float64Array>();

/** Interleaved atom coordinates [x0,y0,z0,...] in `mol.atoms` order (cached per molecule object). */
export function moleculePositions(mol: Molecule): Float64Array {
  let p = positionCache.get(mol);
  if (p) return p;
  const n = mol.atoms.length;
  p = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const a = mol.atoms[i];
    p[3 * i] = a.x;
    p[3 * i + 1] = a.y;
    p[3 * i + 2] = a.z;
  }
  positionCache.set(mol, p);
  return p;
}
