/**
 * Uniform grid over axis-aligned bounding boxes, with ray traversal (3D-DDA, Amanatides & Woo 1987).
 * Used to accelerate picking of spheres / capsules / triangles. Pure (no three.js). OWNER: render-core.
 *
 * Layout is CSR-like: `cellStart[c] .. cellStart[c + 1]` indexes `cellItems`. Items whose AABB spans
 * several cells are stored in each of them; a per-query stamp avoids testing an item twice.
 */

export interface GridBuildOptions {
  /** Desired average number of items per cell (default 2). */
  itemsPerCell?: number;
  /** Hard cap on the number of cells (default 2M). */
  maxCells?: number;
  /** Lower bound for the cell edge in world units (default 0.5). */
  minCellSize?: number;
}

/** Returns the ray parameter of a hit (> 0) or a negative number / Infinity for a miss. */
export type ItemTest = (item: number) => number;

export class UniformGrid {
  readonly itemCount: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly cellSize: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly cellStart: Int32Array;
  readonly cellItems: Int32Array;
  private stamp: Uint32Array;
  private query = 0;

  /**
   * @param boxes 6 floats per item: minX, minY, minZ, maxX, maxY, maxZ
   */
  constructor(boxes: Float32Array | Float64Array, count: number, opts: GridBuildOptions = {}) {
    this.itemCount = count;
    this.stamp = new Uint32Array(count);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let sumExtent = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      if (boxes[o] < minX) minX = boxes[o];
      if (boxes[o + 1] < minY) minY = boxes[o + 1];
      if (boxes[o + 2] < minZ) minZ = boxes[o + 2];
      if (boxes[o + 3] > maxX) maxX = boxes[o + 3];
      if (boxes[o + 4] > maxY) maxY = boxes[o + 4];
      if (boxes[o + 5] > maxZ) maxZ = boxes[o + 5];
      sumExtent += Math.max(boxes[o + 3] - boxes[o], boxes[o + 4] - boxes[o + 1], boxes[o + 5] - boxes[o + 2]);
    }
    if (count === 0) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 1;
    }
    // Pad so items on the boundary are strictly inside.
    const pad = 1e-3;
    minX -= pad; minY -= pad; minZ -= pad;
    maxX += pad; maxY += pad; maxZ += pad;
    const ex = maxX - minX;
    const ey = maxY - minY;
    const ez = maxZ - minZ;
    const perCell = opts.itemsPerCell ?? 2;
    const maxCells = opts.maxCells ?? 2_000_000;
    // Cell edge from the average density, but not much smaller than the typical item.
    const volume = Math.max(ex * ey * ez, 1e-9);
    let cs = Math.cbrt((volume * perCell) / Math.max(1, count));
    const meanExtent = count ? sumExtent / count : 1;
    cs = Math.max(cs, meanExtent * 0.75, opts.minCellSize ?? 0.5);
    let nx = Math.max(1, Math.ceil(ex / cs));
    let ny = Math.max(1, Math.ceil(ey / cs));
    let nz = Math.max(1, Math.ceil(ez / cs));
    while (nx * ny * nz > maxCells) {
      cs *= 1.25;
      nx = Math.max(1, Math.ceil(ex / cs));
      ny = Math.max(1, Math.ceil(ey / cs));
      nz = Math.max(1, Math.ceil(ez / cs));
    }
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.cellSize = cs;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;

    const cells = nx * ny * nz;
    const counts = new Int32Array(cells + 1);
    const inv = 1 / cs;
    const clampI = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
    // Pass 1: count entries per cell.
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      const x0 = clampI(Math.floor((boxes[o] - minX) * inv), nx);
      const y0 = clampI(Math.floor((boxes[o + 1] - minY) * inv), ny);
      const z0 = clampI(Math.floor((boxes[o + 2] - minZ) * inv), nz);
      const x1 = clampI(Math.floor((boxes[o + 3] - minX) * inv), nx);
      const y1 = clampI(Math.floor((boxes[o + 4] - minY) * inv), ny);
      const z1 = clampI(Math.floor((boxes[o + 5] - minZ) * inv), nz);
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++) {
          const row = (z * ny + y) * nx;
          for (let x = x0; x <= x1; x++) counts[row + x + 1]++;
        }
    }
    // Prefix sum → cellStart.
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const cellStart = counts;
    const fill = cellStart.slice(0, cells);
    const items = new Int32Array(cellStart[cells]);
    // Pass 2: fill.
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      const x0 = clampI(Math.floor((boxes[o] - minX) * inv), nx);
      const y0 = clampI(Math.floor((boxes[o + 1] - minY) * inv), ny);
      const z0 = clampI(Math.floor((boxes[o + 2] - minZ) * inv), nz);
      const x1 = clampI(Math.floor((boxes[o + 3] - minX) * inv), nx);
      const y1 = clampI(Math.floor((boxes[o + 4] - minY) * inv), ny);
      const z1 = clampI(Math.floor((boxes[o + 5] - minZ) * inv), nz);
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++) {
          const row = (z * ny + y) * nx;
          for (let x = x0; x <= x1; x++) items[fill[row + x]++] = i;
        }
    }
    this.cellStart = cellStart;
    this.cellItems = items;
  }

  /**
   * Find the nearest item hit along the ray O + tD (t in (0, tMax]). `test` is called at most once per
   * item and returns the hit parameter (≤ 0 / NaN / Infinity = miss).
   * Returns the nearest item index and its t, or item −1 if nothing was hit.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    test: ItemTest,
    tMax = Infinity,
  ): { item: number; t: number } {
    let best = tMax;
    let bestItem = -1;
    if (this.itemCount === 0) return { item: -1, t: Infinity };
    const { nx, ny, nz, cellSize: cs } = this;
    const maxX = this.minX + nx * cs;
    const maxY = this.minY + ny * cs;
    const maxZ = this.minZ + nz * cs;

    // Slab test against the grid bounds.
    let tEnter = 0;
    let tExit = tMax;
    const slab = (o: number, d: number, lo: number, hi: number): boolean => {
      if (Math.abs(d) < 1e-15) return o >= lo && o <= hi;
      let t0 = (lo - o) / d;
      let t1 = (hi - o) / d;
      if (t0 > t1) {
        const tmp = t0;
        t0 = t1;
        t1 = tmp;
      }
      if (t0 > tEnter) tEnter = t0;
      if (t1 < tExit) tExit = t1;
      return tEnter <= tExit;
    };
    if (!slab(ox, dx, this.minX, maxX) || !slab(oy, dy, this.minY, maxY) || !slab(oz, dz, this.minZ, maxZ)) {
      return { item: -1, t: Infinity };
    }

    // Entry cell.
    const px = ox + dx * tEnter;
    const py = oy + dy * tEnter;
    const pz = oz + dz * tEnter;
    const clampI = (v: number, n: number) => (v < 0 ? 0 : v >= n ? n - 1 : v);
    let ix = clampI(Math.floor((px - this.minX) / cs), nx);
    let iy = clampI(Math.floor((py - this.minY) / cs), ny);
    let iz = clampI(Math.floor((pz - this.minZ) / cs), nz);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    // Ray parameter at which we cross the next cell boundary on each axis.
    const nextBoundary = (i: number, step: number, o: number, d: number, min: number): number => {
      if (step === 0) return Infinity;
      const edge = min + (step > 0 ? i + 1 : i) * cs;
      return (edge - o) / d;
    };
    let tNextX = nextBoundary(ix, stepX, ox, dx, this.minX);
    let tNextY = nextBoundary(iy, stepY, oy, dy, this.minY);
    let tNextZ = nextBoundary(iz, stepZ, oz, dz, this.minZ);
    const tDeltaX = stepX ? cs / Math.abs(dx) : Infinity;
    const tDeltaY = stepY ? cs / Math.abs(dy) : Infinity;
    const tDeltaZ = stepZ ? cs / Math.abs(dz) : Infinity;

    const q = ++this.query;
    if (q === 0xffffffff) {
      this.stamp.fill(0);
      this.query = 1;
    }
    const stamp = this.stamp;
    const qq = this.query;
    const start = this.cellStart;
    const items = this.cellItems;

    for (;;) {
      const c = (iz * ny + iy) * nx + ix;
      for (let k = start[c], e = start[c + 1]; k < e; k++) {
        const it = items[k];
        if (stamp[it] === qq) continue;
        stamp[it] = qq;
        const t = test(it);
        if (t > 0 && t < best) {
          best = t;
          bestItem = it;
        }
      }
      const tCellExit = Math.min(tNextX, tNextY, tNextZ);
      // Any item hit later than this cell's exit could still be beaten by items in later cells,
      // but nothing in later cells can be hit before tCellExit.
      if (best <= tCellExit || tCellExit > tExit) break;
      if (tNextX <= tNextY && tNextX <= tNextZ) {
        ix += stepX;
        if (ix < 0 || ix >= nx) break;
        tNextX += tDeltaX;
      } else if (tNextY <= tNextZ) {
        iy += stepY;
        if (iy < 0 || iy >= ny) break;
        tNextY += tDeltaY;
      } else {
        iz += stepZ;
        if (iz < 0 || iz >= nz) break;
        tNextZ += tDeltaZ;
      }
    }
    return bestItem >= 0 ? { item: bestItem, t: best } : { item: -1, t: Infinity };
  }
}
