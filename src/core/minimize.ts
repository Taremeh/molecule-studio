/**
 * Lightweight force-field geometry optimisation ("Clean up geometry", live relaxation while dragging,
 * and SMILES 3D embedding). A UFF-like simplified force field is enough:
 *   - harmonic bond stretch to idealBondLength (k ≈ 300–700 kcal/mol/Å²)
 *   - harmonic angle bend to hybridisation-based ideal angles (sp3 109.47°, sp2 120°, sp 180°)
 *   - torsion term for sp2–sp2 (planarity of conjugated / aromatic systems), and a weak sp3 3-fold term
 *   - soft repulsive (or LJ-like) term for non-bonded pairs separated by ≥ 3 bonds (use a cutoff grid)
 *   - out-of-plane / planarity for sp2 centres
 * Optimiser: FIRE or L-BFGS (or steepest descent with adaptive step). Must handle 1–2000 movable atoms
 * interactively (a few ms per step for ~200 atoms).
 * OWNER: forcefield agent. CONTRACT: keep exported names & signatures.
 *
 * Implementation: typing and terms in ff-model.ts, energy/gradient in ff-energy.ts, L-BFGS in
 * ff-optim.ts. Energies are in kcal/mol (relative; only differences are meaningful).
 */
import type { Atom, Molecule, Vec3 } from './types';
import { getTopology } from './molecule';
import { buildModel, perceiveTyping, regionAround, HYB_SP, HYB_SP3, type FFModel, type Typing } from './ff-model';
import { FFEvaluator, type EnergyBreakdown } from './ff-energy';
import { Lbfgs } from './ff-optim';

export interface MinimizeOptions {
  /** Maximum optimisation steps (default 500). */
  maxSteps?: number;
  /** Atom ids that must not move. */
  fixed?: Set<number>;
  /** If given, only these atom ids may move (all others fixed); energy terms still include their neighbours. */
  movable?: Set<number>;
  /** Convergence threshold on RMS gradient (default 0.05). */
  tolerance?: number;
  /**
   * Infer the hybridisation of valence-incomplete atoms (missing hydrogens / bond orders, typical of
   * PDB files) from the current coordinates. Default: on unless the molecule comes from SMILES or
   * was built in the editor (there the bond graph is authoritative).
   */
  inferFromGeometry?: boolean;
  /**
   * Harmonic tether of every movable atom to its starting position (kcal/mol/Å²). It keeps an
   * experimental structure in place (the force field has no H-bonds / dispersion / crystal contacts)
   * while bond lengths, angles and clashes are still fixed. Default: 2 for experimental structures
   * (same rule as inferFromGeometry), 0 for SMILES / editor molecules. Only used by minimize().
   */
  restraint?: number;
}

export interface MinimizeResult {
  mol: Molecule;
  energy: number;
  steps: number;
  converged: boolean;
}

/** Internal: everything needed to evaluate / optimise one molecule. */
export interface ForceFieldContext {
  mol: Molecule;
  typing: Typing;
  model: FFModel;
  evaluator: FFEvaluator;
  /** Flat coordinates [x0, y0, z0, x1, …] (modified in place by optimisers). */
  x: Float64Array;
  /** Indices of atoms that may move. */
  activeAtoms: Int32Array;
}

function autoInfer(mol: Molecule): boolean {
  const src = mol.meta.source;
  return src !== 'smiles' && src !== 'editor';
}

/** Build the force field for a molecule (exported for SMILES embedding and tests). */
export function createForceField(mol: Molecule, opts: MinimizeOptions = {}): ForceFieldContext {
  const n = mol.atoms.length;
  const topo = getTopology(mol);
  const active = new Uint8Array(n);
  if (opts.movable) {
    for (const id of opts.movable) {
      const i = topo.idToIndex.get(id);
      if (i !== undefined) active[i] = 1;
    }
  } else active.fill(1);
  if (opts.fixed) {
    for (const id of opts.fixed) {
      const i = topo.idToIndex.get(id);
      if (i !== undefined) active[i] = 0;
    }
  }
  // Local relaxation in a big structure: only atoms near the movable ones need typing.
  let region: Uint8Array | undefined;
  let nActive = 0;
  for (let i = 0; i < n; i++) nActive += active[i];
  if (nActive * 20 < n) {
    const seeds: number[] = [];
    for (let i = 0; i < n; i++) if (active[i]) seeds.push(i);
    region = regionAround(topo.neighbors, seeds, 8);
  }
  const typing = perceiveTyping(mol, { inferFromGeometry: opts.inferFromGeometry ?? autoInfer(mol), region });
  const model = buildModel(mol, typing, active);
  const evaluator = new FFEvaluator(model);
  const x = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const a = mol.atoms[i];
    x[3 * i] = a.x;
    x[3 * i + 1] = a.y;
    x[3 * i + 2] = a.z;
  }
  const act: number[] = [];
  for (let i = 0; i < n; i++) if (active[i]) act.push(i);
  return { mol, typing, model, evaluator, x, activeAtoms: Int32Array.from(act) };
}

/** Force-field energy of the molecule as it is, with a per-term breakdown (kcal/mol). */
export function forceFieldEnergy(mol: Molecule, opts: MinimizeOptions = {}): EnergyBreakdown {
  const ctx = createForceField(mol, opts);
  const parts: EnergyBreakdown = { bond: 0, angle: 0, torsion: 0, improper: 0, nonbonded: 0, total: 0 };
  ctx.evaluator.evaluate(ctx.x, null, parts);
  return parts;
}

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * True if the start geometry sits on a symmetric saddle the gradient cannot leave: coincident atoms,
 * an sp3 centre lying in the plane of its neighbours (e.g. a molecule drawn flat), or a bent centre
 * that is exactly linear.
 */
function isDegenerate(ctx: ForceFieldContext): boolean {
  const { x, typing, activeAtoms } = ctx;
  const p = (i: number): Vec3 => [x[3 * i], x[3 * i + 1], x[3 * i + 2]];
  for (const i of activeAtoms) {
    const nb = typing.nbrs[i];
    const c = p(i);
    for (const j of nb) {
      const q = p(j);
      if (Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) < 0.05) return true;
    }
    if (!typing.covalent[i]) continue;
    if (typing.hyb[i] === HYB_SP3 && nb.length >= 3) {
      const a = p(nb[0]), b = p(nb[1]), d = p(nb[2]);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const ln = Math.hypot(nx, ny, nz);
      if (ln < 1e-6) return true;
      const h = Math.abs(((c[0] - a[0]) * nx + (c[1] - a[1]) * ny + (c[2] - a[2]) * nz) / ln);
      if (h < 0.02) return true;
    } else if (typing.hyb[i] !== HYB_SP && nb.length === 2) {
      const a = p(nb[0]), b = p(nb[1]);
      const u = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
      const v = [b[0] - c[0], b[1] - c[1], b[2] - c[2]];
      const cs = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2]) || 1);
      if (cs < -0.9998) return true;
    }
  }
  return allCoplanarWithSp3(ctx);
}

/**
 * Everything drawn in one plane (typical for molecules sketched on the camera plane): eclipsed
 * sp3 torsions are exact saddles there, so a kick is needed as well.
 */
function allCoplanarWithSp3(ctx: ForceFieldContext): boolean {
  const { x, typing, activeAtoms } = ctx;
  if (activeAtoms.length < 4) return false;
  let hasSp3 = false;
  for (const i of activeAtoms) if (typing.covalent[i] && typing.hyb[i] === HYB_SP3 && typing.nbrs[i].length >= 2) hasSp3 = true;
  if (!hasSp3) return false;
  const p = (i: number): Vec3 => [x[3 * i], x[3 * i + 1], x[3 * i + 2]];
  const a = p(activeAtoms[0]);
  // farthest atom from a, then the atom farthest from the line a–b
  let b = a, best = 0;
  for (const i of activeAtoms) {
    const q = p(i);
    const d = Math.hypot(q[0] - a[0], q[1] - a[1], q[2] - a[2]);
    if (d > best) { best = d; b = q; }
  }
  if (best < 1e-6) return true;
  const e = [(b[0] - a[0]) / best, (b[1] - a[1]) / best, (b[2] - a[2]) / best];
  let c = a, bestPerp = 0;
  for (const i of activeAtoms) {
    const q = p(i);
    const w = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
    const t = w[0] * e[0] + w[1] * e[1] + w[2] * e[2];
    const d = Math.hypot(w[0] - t * e[0], w[1] - t * e[1], w[2] - t * e[2]);
    if (d > bestPerp) { bestPerp = d; c = q; }
  }
  if (bestPerp < 1e-6) return true;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
  const ln = Math.hypot(nx, ny, nz);
  for (const i of activeAtoms) {
    const q = p(i);
    if (Math.abs(((q[0] - a[0]) * nx + (q[1] - a[1]) * ny + (q[2] - a[2]) * nz) / ln) > 0.01) return false;
  }
  return true;
}

/** Force-field energy plus k·|x − x₀|² for every active atom (x₀ = the input coordinates). */
function restrainedEnergy(ctx: ForceFieldContext, k: number) {
  const ref = ctx.x.slice();
  const atoms = ctx.activeAtoms;
  return (x: Float64Array, g: Float64Array): number => {
    let e = ctx.evaluator.evaluate(x, g);
    for (let t = 0; t < atoms.length; t++) {
      const i = 3 * atoms[t];
      for (let c = 0; c < 3; c++) {
        const d = x[i + c] - ref[i + c];
        e += k * d * d;
        g[i + c] += 2 * k * d;
      }
    }
    return e;
  };
}

/** Copy optimised coordinates back into a new molecule (only changed atoms get new objects). */
export function applyCoordinates(mol: Molecule, x: Float64Array, atoms?: Iterable<number>): Molecule {
  const out: Atom[] = mol.atoms.slice();
  let changed = false;
  const visit = (i: number) => {
    const a = mol.atoms[i];
    const nx = x[3 * i], ny = x[3 * i + 1], nz = x[3 * i + 2];
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return;
    if (nx === a.x && ny === a.y && nz === a.z) return;
    out[i] = { ...a, x: nx, y: ny, z: nz };
    changed = true;
  };
  if (atoms) for (const i of atoms) visit(i);
  else for (let i = 0; i < mol.atoms.length; i++) visit(i);
  return changed ? { ...mol, atoms: out } : mol;
}

/** Run a full minimisation and return the optimised molecule (new object). */
export function minimize(mol: Molecule, opts: MinimizeOptions = {}): MinimizeResult {
  if (mol.atoms.length === 0) return { mol, energy: 0, steps: 0, converged: true };
  const ctx = createForceField(mol, opts);
  const maxSteps = opts.maxSteps ?? 500;
  const tol = opts.tolerance ?? 0.05;
  if (ctx.activeAtoms.length === 0) {
    return { mol, energy: ctx.evaluator.evaluate(ctx.x, null), steps: 0, converged: true };
  }
  if (isDegenerate(ctx)) {
    // Small deterministic kick off the saddle (invisible after relaxation).
    const rnd = seededRandom(0x5eed + mol.atoms.length);
    for (const i of ctx.activeAtoms) for (let c = 0; c < 3; c++) ctx.x[3 * i + c] += (rnd() - 0.5) * 0.1;
  }
  const kRestraint = opts.restraint ?? (autoInfer(mol) ? 2 : 0);
  const energyFn = kRestraint > 0 ? restrainedEnergy(ctx, kRestraint) : (x: Float64Array, g: Float64Array) => ctx.evaluator.evaluate(x, g);
  const opt = new Lbfgs(energyFn, ctx.x, ctx.activeAtoms);
  const res = opt.iterate(maxSteps, tol);
  const energy = ctx.evaluator.evaluate(ctx.x, null); // report the force-field energy without the tether
  return { mol: applyCoordinates(mol, ctx.x, ctx.activeAtoms), energy, steps: res.steps, converged: res.converged };
}

/** Incremental minimiser for interactive use (e.g. relax neighbours while an atom is dragged). */
export interface Minimizer {
  /** Pin an atom to a position (e.g. the dragged atom follows the pointer). */
  setFixedPosition(atomId: number, position: Vec3): void;
  /** Run n optimisation steps; returns the current energy. */
  step(n: number): number;
  /** Current coordinates of all movable atoms. */
  positions(): Map<number, Vec3>;
}

/**
 * Interactive minimiser. Force-field terms are built once; each `step(n)` runs up to n L-BFGS
 * iterations (cheap: one or two energy evaluations each). Pinned atoms (setFixedPosition) stop
 * moving on their own and follow the given positions; `positions()` returns the movable and the
 * pinned atoms, ready for a transient store update.
 */
export function createMinimizer(mol: Molecule, opts: MinimizeOptions = {}): Minimizer {
  const ctx = createForceField(mol, opts);
  const tol = opts.tolerance ?? 0.05;
  const topo = getTopology(mol);
  const pinned = new Set<number>();
  if (ctx.activeAtoms.length && isDegenerate(ctx)) {
    // e.g. a molecule sketched on the camera plane: an invisible kick lets sp3 centres leave the plane
    const rnd = seededRandom(0x5eed + mol.atoms.length);
    for (const i of ctx.activeAtoms) for (let c = 0; c < 3; c++) ctx.x[3 * i + c] += (rnd() - 0.5) * 0.04;
  }
  const makeOpt = () => {
    const act: number[] = [];
    for (let i = 0; i < ctx.model.n; i++) if (ctx.model.active[i]) act.push(i);
    return new Lbfgs((x, g) => ctx.evaluator.evaluate(x, g), ctx.x, Int32Array.from(act));
  };
  let opt = makeOpt();
  let lastEnergy = NaN;

  return {
    setFixedPosition(atomId: number, position: Vec3) {
      const i = topo.idToIndex.get(atomId);
      if (i === undefined) return;
      ctx.x[3 * i] = position[0];
      ctx.x[3 * i + 1] = position[1];
      ctx.x[3 * i + 2] = position[2];
      if (!pinned.has(i)) {
        pinned.add(i);
        ctx.evaluator.track(i);
        if (ctx.model.active[i]) {
          ctx.model.active[i] = 0;
          ctx.evaluator.invalidate();
          opt = makeOpt();
          return;
        }
      }
      opt.reset();
    },
    step(n: number) {
      if (n <= 0) return Number.isFinite(lastEnergy) ? lastEnergy : (lastEnergy = opt.energy());
      lastEnergy = opt.iterate(n, tol).energy;
      return lastEnergy;
    },
    positions() {
      const out = new Map<number, Vec3>();
      const x = ctx.x;
      for (let i = 0; i < ctx.model.n; i++) {
        if (!ctx.model.active[i] && !pinned.has(i)) continue;
        out.set(mol.atoms[i].id, [x[3 * i], x[3 * i + 1], x[3 * i + 2]]);
      }
      return out;
    },
  };
}
