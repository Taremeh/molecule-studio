/**
 * Limited-memory BFGS minimiser over the coordinates of the active atoms, with a backtracking
 * (Armijo) line search and a per-atom step cap so that large initial forces (stretched bonds,
 * overlapping atoms) can never blow the structure up. The state is incremental: `iterate(n)` can
 * be called repeatedly (interactive relaxation), and `reset()` drops the curvature history when the
 * landscape changes (e.g. a pinned atom was moved). OWNER: forcefield agent.
 */

export type EnergyFn = (x: Float64Array, g: Float64Array) => number;

export interface LbfgsOptions {
  /** History size (default 8). */
  memory?: number;
  /** Maximum displacement of any atom per iteration, Å (default 0.3). */
  maxStep?: number;
}

export class Lbfgs {
  private readonly f: EnergyFn;
  /** Full coordinate array (3 per atom), modified in place. */
  readonly x: Float64Array;
  private readonly atoms: Int32Array;
  private readonly dim: number;
  private readonly m: number;
  private readonly maxStep: number;
  private gFull: Float64Array;
  private g: Float64Array;
  private gNew: Float64Array;
  private d: Float64Array;
  private x0: Float64Array;
  private S: Float64Array[] = [];
  private Y: Float64Array[] = [];
  private rho: number[] = [];
  private alpha: Float64Array;
  private fx = NaN;
  private valid = false;
  /** Total energy evaluations (diagnostics). */
  evaluations = 0;

  constructor(f: EnergyFn, x: Float64Array, activeAtoms: Int32Array, opts: LbfgsOptions = {}) {
    this.f = f;
    this.x = x;
    this.atoms = activeAtoms;
    this.dim = activeAtoms.length * 3;
    this.m = opts.memory ?? 8;
    this.maxStep = opts.maxStep ?? 0.3;
    this.gFull = new Float64Array(x.length);
    this.g = new Float64Array(this.dim);
    this.gNew = new Float64Array(this.dim);
    this.d = new Float64Array(this.dim);
    this.x0 = new Float64Array(this.dim);
    this.alpha = new Float64Array(this.m);
  }

  /** Forget curvature history and cached energy (call after external coordinate changes). */
  reset(): void {
    this.S = [];
    this.Y = [];
    this.rho = [];
    this.valid = false;
  }

  private evalInto(gRed: Float64Array): number {
    this.evaluations++;
    const e = this.f(this.x, this.gFull);
    const atoms = this.atoms;
    for (let t = 0; t < atoms.length; t++) {
      const i = 3 * atoms[t];
      gRed[3 * t] = this.gFull[i];
      gRed[3 * t + 1] = this.gFull[i + 1];
      gRed[3 * t + 2] = this.gFull[i + 2];
    }
    return e;
  }

  private setX(base: Float64Array, dir: Float64Array, step: number): void {
    const atoms = this.atoms;
    for (let t = 0; t < atoms.length; t++) {
      const i = 3 * atoms[t];
      this.x[i] = base[3 * t] + step * dir[3 * t];
      this.x[i + 1] = base[3 * t + 1] + step * dir[3 * t + 1];
      this.x[i + 2] = base[3 * t + 2] + step * dir[3 * t + 2];
    }
  }

  /** Current energy (evaluates if needed). */
  energy(): number {
    if (!this.valid) {
      this.fx = this.evalInto(this.g);
      this.valid = true;
    }
    return this.fx;
  }

  /** RMS of the gradient over active coordinates. */
  rmsGradient(): number {
    this.energy();
    if (this.dim === 0) return 0;
    let s = 0;
    for (let r = 0; r < this.dim; r++) s += this.g[r] * this.g[r];
    return Math.sqrt(s / this.dim);
  }

  /**
   * Run up to `maxIter` iterations; stops early when the RMS gradient drops below `tol`
   * or no further decrease is possible. Returns iterations done and whether it converged.
   */
  iterate(maxIter: number, tol: number): { steps: number; converged: boolean; energy: number } {
    if (this.dim === 0) return { steps: 0, converged: true, energy: this.energy() };
    let steps = 0;
    let fx = this.energy();
    const g = this.g;
    const d = this.d;
    for (; steps < maxIter; steps++) {
      if (this.rmsGradient() < tol) return { steps, converged: true, energy: fx };
      // --- search direction: two-loop recursion ---
      const k = this.S.length;
      for (let r = 0; r < this.dim; r++) d[r] = -g[r];
      if (k > 0) {
        for (let h = k - 1; h >= 0; h--) {
          const a = this.rho[h] * dotN(this.S[h], d);
          this.alpha[h] = a;
          axpy(-a, this.Y[h], d);
        }
        const sy = dotN(this.S[k - 1], this.Y[k - 1]);
        const yy = dotN(this.Y[k - 1], this.Y[k - 1]);
        const gamma = yy > 0 ? sy / yy : 1;
        for (let r = 0; r < this.dim; r++) d[r] *= gamma;
        for (let h = 0; h < k; h++) {
          const b = this.rho[h] * dotN(this.Y[h], d);
          axpy(this.alpha[h] - b, this.S[h], d);
        }
      }
      let gd = dotN(g, d);
      if (!(gd < 0) || !Number.isFinite(gd)) {
        this.S = [];
        this.Y = [];
        this.rho = [];
        for (let r = 0; r < this.dim; r++) d[r] = -g[r];
        gd = dotN(g, d);
      }
      // --- cap the largest per-atom displacement ---
      let maxDisp = 0;
      for (let t = 0; t < this.atoms.length; t++) {
        const l = Math.hypot(d[3 * t], d[3 * t + 1], d[3 * t + 2]);
        if (l > maxDisp) maxDisp = l;
      }
      let step = maxDisp > this.maxStep ? this.maxStep / maxDisp : 1;
      // --- backtracking line search (Armijo) ---
      for (let t = 0; t < this.atoms.length; t++) {
        const i = 3 * this.atoms[t];
        this.x0[3 * t] = this.x[i];
        this.x0[3 * t + 1] = this.x[i + 1];
        this.x0[3 * t + 2] = this.x[i + 2];
      }
      let fNew = NaN;
      let ok = false;
      for (let ls = 0; ls < 25; ls++) {
        this.setX(this.x0, d, step);
        fNew = this.evalInto(this.gNew);
        if (Number.isFinite(fNew) && fNew <= fx + 1e-4 * step * gd) {
          ok = true;
          break;
        }
        // Quadratic interpolation of the step, safeguarded to [0.1, 0.5] of the current one.
        const denom = 2 * (fNew - fx - gd * step);
        let next = Number.isFinite(fNew) && denom > 0 ? (-gd * step * step) / denom : 0.5 * step;
        next = Math.min(0.5 * step, Math.max(0.1 * step, next));
        step = next;
      }
      if (!ok) {
        this.setX(this.x0, d, 0);
        this.valid = false;
        if (this.S.length > 0) {
          // Bad curvature model: retry from steepest descent.
          this.S = [];
          this.Y = [];
          this.rho = [];
          fx = this.energy();
          continue;
        }
        // No decrease possible along the gradient: numerically converged.
        fx = this.energy();
        return { steps, converged: this.rmsGradient() < tol * 10, energy: fx };
      }
      // --- update history ---
      const s = new Float64Array(this.dim);
      const y = new Float64Array(this.dim);
      for (let r = 0; r < this.dim; r++) {
        s[r] = step * d[r];
        y[r] = this.gNew[r] - g[r];
      }
      const sy = dotN(s, y);
      if (sy > 1e-10) {
        if (this.S.length >= this.m) {
          this.S.shift();
          this.Y.shift();
          this.rho.shift();
        }
        this.S.push(s);
        this.Y.push(y);
        this.rho.push(1 / sy);
      }
      g.set(this.gNew);
      fx = fNew;
      this.fx = fNew;
      this.valid = true;
    }
    return { steps, converged: this.rmsGradient() < tol, energy: fx };
  }
}

function dotN(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function axpy(a: number, x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < x.length; i++) y[i] += a * x[i];
}
