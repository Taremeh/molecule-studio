/**
 * Energy and analytic gradient of the force-field model (see ff-model.ts for the functional forms).
 * Non-bonded pairs come from a Verlet list (cell grid, cutoff + skin) that is rebuilt only when an
 * atom has moved more than half the skin since the last build, so the energy is exact at every call.
 * OWNER: forcefield agent.
 */
import { FF_PARAMS, type FFModel } from './ff-model';

const SKIN = 1.0;

export interface EnergyBreakdown {
  bond: number;
  angle: number;
  torsion: number;
  improper: number;
  nonbonded: number;
  total: number;
}

function sortedHas(arr: Int32Array | null, v: number): boolean {
  if (!arr) return false;
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const x = arr[mid];
    if (x === v) return true;
    if (x < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export class FFEvaluator {
  readonly model: FFModel;
  /** Atoms whose coordinates may change between calls (active + externally pinned atoms). */
  private tracked: Int32Array;
  private ref: Float64Array;
  private hasList = false;
  private pI = new Int32Array(0);
  private pJ = new Int32Array(0);
  private pD0 = new Float64Array(0);
  private pK = new Float64Array(0);
  private pCount = 0;
  /** Number of neighbour-list builds (for tests / diagnostics). */
  rebuilds = 0;

  constructor(model: FFModel) {
    this.model = model;
    const t: number[] = [];
    for (let i = 0; i < model.n; i++) if (model.active[i]) t.push(i);
    this.tracked = Int32Array.from(t);
    this.ref = new Float64Array(model.n * 3);
  }

  /** Also watch these atoms' displacement for neighbour-list updates (pinned atoms moved externally). */
  track(atom: number): void {
    for (const t of this.tracked) if (t === atom) return;
    const next = new Int32Array(this.tracked.length + 1);
    next.set(this.tracked);
    next[this.tracked.length] = atom;
    this.tracked = next;
    this.hasList = false;
  }

  invalidate(): void {
    this.hasList = false;
  }

  private needsRebuild(x: Float64Array): boolean {
    if (!this.hasList) return true;
    const lim = (SKIN / 2) * (SKIN / 2);
    const r = this.ref;
    for (let t = 0; t < this.tracked.length; t++) {
      const i = 3 * this.tracked[t];
      const dx = x[i] - r[i], dy = x[i + 1] - r[i + 1], dz = x[i + 2] - r[i + 2];
      if (dx * dx + dy * dy + dz * dz > lim) return true;
    }
    return false;
  }

  private buildPairs(x: Float64Array): void {
    const m = this.model;
    const n = m.n;
    const P = FF_PARAMS;
    this.ref.set(x);
    this.hasList = true;
    this.rebuilds++;
    const cs = m.cutoff + SKIN;
    // Bounding box of active atoms, padded by the cell size: only atoms in it can interact.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let anyActive = false;
    for (let i = 0; i < n; i++) {
      if (!m.active[i]) continue;
      anyActive = true;
      const px = x[3 * i], py = x[3 * i + 1], pz = x[3 * i + 2];
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (pz < z0) z0 = pz;
      if (px > x1) x1 = px;
      if (py > y1) y1 = py;
      if (pz > z1) z1 = pz;
    }
    this.pCount = 0;
    if (!anyActive) return;
    x0 -= cs; y0 -= cs; z0 -= cs; x1 += cs; y1 += cs; z1 += cs;
    const nx = Math.max(1, Math.floor((x1 - x0) / cs) + 1);
    const ny = Math.max(1, Math.floor((y1 - y0) / cs) + 1);
    const nz = Math.max(1, Math.floor((z1 - z0) / cs) + 1);
    const cells = new Map<number, number[]>();
    const cellOf = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const px = x[3 * i], py = x[3 * i + 1], pz = x[3 * i + 2];
      if (px < x0 || py < y0 || pz < z0 || px > x1 || py > y1 || pz > z1) continue;
      const cx = Math.min(nx - 1, Math.floor((px - x0) / cs));
      const cy = Math.min(ny - 1, Math.floor((py - y0) / cs));
      const cz = Math.min(nz - 1, Math.floor((pz - z0) / cs));
      const key = cx + nx * (cy + ny * cz);
      cellOf[i] = key;
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(i);
    }
    const cs2 = cs * cs;
    const pI: number[] = [], pJ: number[] = [], pD0: number[] = [], pK: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!m.active[i]) continue;
      const key = cellOf[i];
      const cx = key % nx, cy = Math.floor(key / nx) % ny, cz = Math.floor(key / (nx * ny));
      const px = x[3 * i], py = x[3 * i + 1], pz = x[3 * i + 2];
      for (let dz = -1; dz <= 1; dz++) {
        const zz = cz + dz;
        if (zz < 0 || zz >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = cx + dx;
            if (xx < 0 || xx >= nx) continue;
            const list = cells.get(xx + nx * (yy + ny * zz));
            if (!list) continue;
            for (const j of list) {
              if (j === i || (m.active[j] && j < i)) continue;
              const ddx = x[3 * j] - px, ddy = x[3 * j + 1] - py, ddz = x[3 * j + 2] - pz;
              if (ddx * ddx + ddy * ddy + ddz * ddz > cs2) continue;
              const r2 = ddx * ddx + ddy * ddy + ddz * ddz;
              // quick reject with this pair's own largest possible d0
              const dMax = P.scaleRepel * (m.vdw[i] + m.vdw[j]) + SKIN;
              if (r2 > dMax * dMax) continue;
              if (sortedHas(m.excl[i], j)) continue;
              const ci = m.nbClass[i], cj = m.nbClass[j];
              let scale = P.scaleRepel;
              let k = P.kRepel;
              if (sortedHas(m.soft13[i], j)) scale = P.scaleSoft13;
              else if (sortedHas(m.pair14[i], j)) {
                scale = P.scaleRepel14;
                k *= P.factor14;
              }
              if (ci === 3 || cj === 3) scale = Math.min(scale, P.scaleMetal);
              else if ((ci === 1 && cj === 2) || (ci === 2 && cj === 1)) scale = Math.min(scale, P.scalePolarH);
              const d0 = scale * (m.vdw[i] + m.vdw[j]);
              if (r2 > (d0 + SKIN) * (d0 + SKIN)) continue;
              pI.push(i);
              pJ.push(j);
              pD0.push(d0);
              pK.push(k);
            }
          }
        }
      }
    }
    this.pI = Int32Array.from(pI);
    this.pJ = Int32Array.from(pJ);
    this.pD0 = Float64Array.from(pD0);
    this.pK = Float64Array.from(pK);
    this.pCount = pI.length;
  }

  /**
   * Energy at x (flat [x0,y0,z0,x1,…]); if g is given, it receives dE/dx (zero for inactive atoms).
   * If `parts` is given, it receives the per-term breakdown.
   */
  evaluate(x: Float64Array, g: Float64Array | null, parts?: EnergyBreakdown): number {
    const m = this.model;
    if (this.needsRebuild(x)) this.buildPairs(x);
    if (g) g.fill(0);
    let eBond = 0, eAngle = 0, eTors = 0, eImp = 0, eNb = 0;

    // ---- bonds ----
    {
      const I = m.bI, J = m.bJ, K = m.bK, R0 = m.bR0;
      for (let t = 0; t < m.bondCount; t++) {
        const i = 3 * I[t], j = 3 * J[t];
        let dx = x[j] - x[i], dy = x[j + 1] - x[i + 1], dz = x[j + 2] - x[i + 2];
        let r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r < 1e-9) {
          // Coincident atoms: pick a deterministic direction so the bond can open up.
          dx = 1e-9; dy = 0; dz = 0; r = 1e-9;
        }
        const dr = r - R0[t];
        eBond += K[t] * dr * dr;
        if (g) {
          const f = (2 * K[t] * dr) / r;
          g[i] -= f * dx; g[i + 1] -= f * dy; g[i + 2] -= f * dz;
          g[j] += f * dx; g[j + 1] += f * dy; g[j + 2] += f * dz;
        }
      }
    }

    // ---- angles ----
    {
      const I = m.aI, J = m.aJ, K = m.aK, T = m.aType, KF = m.aKf, T0 = m.aT0;
      for (let t = 0; t < m.angleCount; t++) {
        const a = 3 * I[t], j = 3 * J[t], c = 3 * K[t];
        const ux = x[a] - x[j], uy = x[a + 1] - x[j + 1], uz = x[a + 2] - x[j + 2];
        const vx = x[c] - x[j], vy = x[c + 1] - x[j + 1], vz = x[c + 2] - x[j + 2];
        const lu2 = ux * ux + uy * uy + uz * uz, lv2 = vx * vx + vy * vy + vz * vz;
        if (lu2 < 1e-16 || lv2 < 1e-16) continue;
        const lu = Math.sqrt(lu2), lv = Math.sqrt(lv2);
        let cs = (ux * vx + uy * vy + uz * vz) / (lu * lv);
        if (cs > 1) cs = 1;
        else if (cs < -1) cs = -1;
        let dEdc: number;
        const kf = KF[t];
        if (T[t] === 0) {
          const d = cs - T0[t];
          eAngle += kf * d * d;
          dEdc = 2 * kf * d;
        } else if (T[t] === 1) {
          eAngle += kf * (1 + cs);
          dEdc = kf;
        } else {
          // (kf/16)(1 − cos 4θ) = (kf/2)(c² − c⁴)
          const c2 = cs * cs;
          eAngle += 0.5 * kf * (c2 - c2 * c2);
          dEdc = kf * (cs - 2 * cs * c2);
        }
        if (g) {
          const inv = 1 / (lu * lv);
          // dc/du = v/(|u||v|) − c·u/|u|²,  dc/dv = u/(|u||v|) − c·v/|v|²
          const gux = dEdc * (vx * inv - (cs * ux) / lu2);
          const guy = dEdc * (vy * inv - (cs * uy) / lu2);
          const guz = dEdc * (vz * inv - (cs * uz) / lu2);
          const gvx = dEdc * (ux * inv - (cs * vx) / lv2);
          const gvy = dEdc * (uy * inv - (cs * vy) / lv2);
          const gvz = dEdc * (uz * inv - (cs * vz) / lv2);
          g[a] += gux; g[a + 1] += guy; g[a + 2] += guz;
          g[c] += gvx; g[c + 1] += gvy; g[c + 2] += gvz;
          g[j] -= gux + gvx; g[j + 1] -= guy + gvy; g[j + 2] -= guz + gvz;
        }
      }
    }

    // ---- torsions (Blondel & Karplus 1996 gradient, no singularity at φ = 0 / 180°) ----
    {
      const I = m.tI, J = m.tJ, K = m.tK, L = m.tL, V = m.tV, N = m.tN, D = m.tD;
      for (let t = 0; t < m.torsionCount; t++) {
        const i = 3 * I[t], j = 3 * J[t], k = 3 * K[t], l = 3 * L[t];
        const Fx = x[i] - x[j], Fy = x[i + 1] - x[j + 1], Fz = x[i + 2] - x[j + 2];
        const Gx = x[j] - x[k], Gy = x[j + 1] - x[k + 1], Gz = x[j + 2] - x[k + 2];
        const Hx = x[l] - x[k], Hy = x[l + 1] - x[k + 1], Hz = x[l + 2] - x[k + 2];
        const Ax = Fy * Gz - Fz * Gy, Ay = Fz * Gx - Fx * Gz, Az = Fx * Gy - Fy * Gx;
        const Bx = Hy * Gz - Hz * Gy, By = Hz * Gx - Hx * Gz, Bz = Hx * Gy - Hy * Gx;
        const A2 = Ax * Ax + Ay * Ay + Az * Az, B2 = Bx * Bx + By * By + Bz * Bz;
        const G2 = Gx * Gx + Gy * Gy + Gz * Gz;
        if (A2 < 1e-12 || B2 < 1e-12 || G2 < 1e-12) continue;
        const lG = Math.sqrt(G2);
        const AB = Math.sqrt(A2 * B2);
        const cosp = (Ax * Bx + Ay * By + Az * Bz) / AB;
        // (B × A)·G / |G|
        const BAx = By * Az - Bz * Ay, BAy = Bz * Ax - Bx * Az, BAz = Bx * Ay - By * Ax;
        const sinp = (BAx * Gx + BAy * Gy + BAz * Gz) / (AB * lG);
        const phi = Math.atan2(sinp, cosp);
        const nn = N[t];
        const vh = 0.5 * V[t];
        eTors += vh * (1 - D[t] * Math.cos(nn * phi));
        if (g) {
          const dEdphi = vh * D[t] * nn * Math.sin(nn * phi);
          const FG = Fx * Gx + Fy * Gy + Fz * Gz;
          const HG = Hx * Gx + Hy * Gy + Hz * Gz;
          const fa = (-lG / A2) * dEdphi; // dφ/dri = −|G|/A² · A
          const fb = (lG / B2) * dEdphi; // dφ/drl = +|G|/B² · B
          const ca = (FG / (A2 * lG)) * dEdphi;
          const cb = (HG / (B2 * lG)) * dEdphi;
          g[i] += fa * Ax; g[i + 1] += fa * Ay; g[i + 2] += fa * Az;
          g[l] += fb * Bx; g[l + 1] += fb * By; g[l + 2] += fb * Bz;
          // dφ/drj = |G|/A² A + FG/(A²|G|) A − HG/(B²|G|) B
          g[j] += -fa * Ax + ca * Ax - cb * Bx;
          g[j + 1] += -fa * Ay + ca * Ay - cb * By;
          g[j + 2] += -fa * Az + ca * Az - cb * Bz;
          // dφ/drk = HG/(B²|G|) B − FG/(A²|G|) A − |G|/B² B
          g[k] += cb * Bx - ca * Ax - fb * Bx;
          g[k + 1] += cb * By - ca * Ay - fb * By;
          g[k + 2] += cb * Bz - ca * Az - fb * Bz;
        }
      }
    }

    // ---- impropers: E = k h², h = signed distance of centre c from the plane (a, b, d) ----
    {
      const C = m.oC, A = m.oA, B = m.oB, Dd = m.oD, Kf = m.oK;
      for (let t = 0; t < m.improperCount; t++) {
        const c = 3 * C[t], a = 3 * A[t], b = 3 * B[t], d = 3 * Dd[t];
        const e1x = x[b] - x[a], e1y = x[b + 1] - x[a + 1], e1z = x[b + 2] - x[a + 2];
        const e2x = x[d] - x[a], e2y = x[d + 1] - x[a + 1], e2z = x[d + 2] - x[a + 2];
        const wx = x[c] - x[a], wy = x[c + 1] - x[a + 1], wz = x[c + 2] - x[a + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const ln = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (ln < 1e-8) continue;
        const ux = nx / ln, uy = ny / ln, uz = nz / ln;
        const h = wx * ux + wy * uy + wz * uz;
        eImp += Kf[t] * h * h;
        if (g) {
          const f = 2 * Kf[t] * h;
          // q = (w − h n̂)/|n|;  dh/dc = n̂, dh/db = e2 × q, dh/dd = q × e1, dh/da = −(sum)
          const qx = (wx - h * ux) / ln, qy = (wy - h * uy) / ln, qz = (wz - h * uz) / ln;
          const gbx = e2y * qz - e2z * qy, gby = e2z * qx - e2x * qz, gbz = e2x * qy - e2y * qx;
          const gdx = qy * e1z - qz * e1y, gdy = qz * e1x - qx * e1z, gdz = qx * e1y - qy * e1x;
          g[c] += f * ux; g[c + 1] += f * uy; g[c + 2] += f * uz;
          g[b] += f * gbx; g[b + 1] += f * gby; g[b + 2] += f * gbz;
          g[d] += f * gdx; g[d + 1] += f * gdy; g[d + 2] += f * gdz;
          g[a] -= f * (ux + gbx + gdx); g[a + 1] -= f * (uy + gby + gdy); g[a + 2] -= f * (uz + gbz + gdz);
        }
      }
    }

    // ---- non-bonded soft repulsion ----
    {
      const I = this.pI, J = this.pJ, D0 = this.pD0, K = this.pK;
      for (let t = 0; t < this.pCount; t++) {
        const i = 3 * I[t], j = 3 * J[t];
        let dx = x[j] - x[i], dy = x[j + 1] - x[i + 1], dz = x[j + 2] - x[i + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        const d0 = D0[t];
        if (r2 >= d0 * d0) continue;
        let r = Math.sqrt(r2);
        if (r < 1e-6) {
          // Exactly overlapping atoms: push apart along a direction that depends on the pair.
          dx = 1e-6 * Math.cos(t); dy = 1e-6 * Math.sin(t); dz = 0; r = 1e-6;
        }
        const dr = d0 - r;
        eNb += K[t] * dr * dr;
        if (g) {
          const f = (-2 * K[t] * dr) / r;
          g[i] -= f * dx; g[i + 1] -= f * dy; g[i + 2] -= f * dz;
          g[j] += f * dx; g[j + 1] += f * dy; g[j + 2] += f * dz;
        }
      }
    }

    if (g) {
      const act = m.active;
      for (let i = 0; i < m.n; i++) if (!act[i]) g[3 * i] = g[3 * i + 1] = g[3 * i + 2] = 0;
    }
    const total = eBond + eAngle + eTors + eImp + eNb;
    if (parts) {
      parts.bond = eBond;
      parts.angle = eAngle;
      parts.torsion = eTors;
      parts.improper = eImp;
      parts.nonbonded = eNb;
      parts.total = total;
    }
    return total;
  }
}
