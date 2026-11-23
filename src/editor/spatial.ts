/**
 * Uniform hash grid over atom positions for fast "atoms near this point" queries during drags
 * (bond suggestions and clash detection must stay interactive on 50k-atom structures).
 */
import type { Molecule, Vec3 } from '../core/types';

/** Spatial hash of integer cell coordinates (collisions only add candidates; callers distance-check). */
function cellHash(ix: number, iy: number, iz: number): number {
  return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
}

export class SpatialGrid {
  private readonly cells = new Map<number, number[]>();
  readonly cellSize: number;

  /**
   * @param mol     molecule whose atom positions are indexed (at construction time)
   * @param indices atom indices (into mol.atoms) to include
   * @param cellSize edge length of a grid cell in Å
   */
  constructor(mol: Molecule, indices: Iterable<number>, cellSize = 2.5) {
    this.cellSize = cellSize;
    const inv = 1 / cellSize;
    for (const i of indices) {
      const a = mol.atoms[i];
      const key = cellHash(Math.floor(a.x * inv), Math.floor(a.y * inv), Math.floor(a.z * inv));
      let bucket = this.cells.get(key);
      if (!bucket) this.cells.set(key, (bucket = []));
      bucket.push(i);
    }
  }

  /**
   * Candidate atom indices in all cells overlapping the cube of half-size `radius` around `p`.
   * The result is a superset of the atoms within `radius`; callers must check the actual distance.
   */
  query(p: Vec3, radius: number, out: number[] = []): number[] {
    const inv = 1 / this.cellSize;
    const x0 = Math.floor((p[0] - radius) * inv);
    const x1 = Math.floor((p[0] + radius) * inv);
    const y0 = Math.floor((p[1] - radius) * inv);
    const y1 = Math.floor((p[1] + radius) * inv);
    const z0 = Math.floor((p[2] - radius) * inv);
    const z1 = Math.floor((p[2] + radius) * inv);
    // Distinct cells can collide in the hash; dedupe buckets so no index is reported twice.
    const seen = new Set<number[]>();
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const bucket = this.cells.get(cellHash(ix, iy, iz));
          if (!bucket || seen.has(bucket)) continue;
          seen.add(bucket);
          for (const i of bucket) out.push(i);
        }
      }
    }
    return out;
  }
}
