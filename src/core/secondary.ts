/**
 * Secondary structure assignment for proteins without HELIX/SHEET records.
 * OWNER: structure agent. CONTRACT: keep exported names & signatures.
 *
 * Implement a simplified DSSP: backbone H-bond energy E = 0.084·332·(1/rON + 1/rCH − 1/rOH − 1/rCN)
 * (H placed from the previous residue's C=O direction), H-bond if E < −0.5 kcal/mol; α-helix from
 * consecutive n=4 turns (min length 4), β-sheet from parallel/antiparallel bridges (ladders, min length 2..3).
 * Fallback for CA-only models: CA(i)–CA(i+3) distance / virtual torsion heuristics.
 *
 * Implementation notes (Kabsch & Sander 1983, as in the reference DSSP program):
 *  - H-bond(i→j) means C=O of residue i accepts from N–H of residue j. Each donor keeps its two
 *    best acceptors; a bond exists if it is one of those and E < −0.5 kcal/mol.
 *  - n-turn(i) = Hbond(i, i+n). Minimal helix: 4-turn(i−1) and 4-turn(i) → residues i..i+3 are H.
 *  - Bridges: parallel  [Hb(i−1,j) & Hb(j,i+1)] | [Hb(j−1,i) & Hb(i,j+1)]
 *             antiparallel [Hb(i,j) & Hb(j,i)] | [Hb(i−1,j+1) & Hb(j−1,i+1)]
 *    Consecutive bridges form ladders; ladders separated by small bulges are merged; residues in
 *    ladders with ≥ 2 bridges are E (isolated bridges are reported as coil). Helix wins over strand.
 *  - Reduction to three states: H → helix, E → sheet, everything else (incl. 3₁₀/π, turns,
 *    isolated bridges) → coil.
 */
import type { Atom, Molecule, SecondaryStructure } from './types';
import { getTopology } from './molecule';
import { SpatialGrid } from './structure-grid';

/** DSSP electrostatic coupling: 0.084 · 332 kcal·Å/mol (partial charges 0.42e / 0.20e). */
const HB_COUPLING = 0.084 * 332;
/** H-bond energy threshold (kcal/mol). */
export const HBOND_THRESHOLD = -0.5;
const HB_MIN_ENERGY = -9.9;
/** Only residue pairs with CA–CA below this distance can be H-bonded (as in DSSP). */
const MAX_CA_DISTANCE = 9;
/** Peptide C–N longer than this is a chain break (DSSP uses 2.5 Å). */
const MAX_PEPTIDE_BOND = 2.5;
/** CA–CA distance above which consecutive residues are treated as a break (CA-only / missing atoms). */
const MAX_CA_CA = 4.2;

/**
 * Returns a NEW molecule where every atom of protein residues has `ss` set ('helix' | 'sheet' | 'coil').
 * Non-protein atoms are left untouched. If the molecule already has ss (meta.hasSecondaryStructure)
 * and `force` is false, it is returned unchanged.
 */
export function assignSecondaryStructure(mol: Molecule, force = false): Molecule {
  if (!force && mol.meta.hasSecondaryStructure) return mol;
  const topo = getTopology(mol);
  const order: number[] = [];
  for (const ch of topo.chains) for (const ri of ch.residueIndices) if (topo.residues[ri].kind === 'protein') order.push(ri);
  if (order.length === 0) return mol;

  const bb = extractBackbone(mol, order);
  const codes = computeDssp(bb);

  // Chains with mostly CA-only residues: use the CA-trace heuristic for them.
  const caMode = new Uint8Array(order.length);
  let anyCA = false;
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end < order.length && bb.chain[end] === bb.chain[start]) end++;
    let full = 0;
    let withCA = 0;
    for (let k = start; k < end; k++) {
      if (bb.hasCA[k]) withCA++;
      if (bb.hasCA[k] && bb.hasN[k] && bb.hasC[k] && bb.hasO[k]) full++;
    }
    if (withCA >= 3 && full < 0.5 * withCA) {
      caMode.fill(1, start, end);
      anyCA = true;
    }
    start = end;
  }
  if (anyCA) {
    const ca = assignFromCATrace(bb, caMode);
    for (let k = 0; k < order.length; k++) if (caMode[k]) codes[k] = ca[k];
  }

  let changed = false;
  const atoms: Atom[] = mol.atoms.slice();
  for (let k = 0; k < order.length; k++) {
    const ss: SecondaryStructure = codes[k] === 'H' ? 'helix' : codes[k] === 'E' ? 'sheet' : 'coil';
    for (const ai of topo.residues[order[k]].atomIndices) {
      if (atoms[ai].ss === ss) continue;
      atoms[ai] = { ...atoms[ai], ss };
      changed = true;
    }
  }
  return changed ? { ...mol, atoms } : mol;
}

// ---------------------------------------------------------------------------------------------
// Backbone extraction
// ---------------------------------------------------------------------------------------------

export interface Backbone {
  /** Number of residues. */
  m: number;
  /** Interleaved xyz per residue (NaN when the atom is missing). */
  N: Float64Array;
  CA: Float64Array;
  C: Float64Array;
  O: Float64Array;
  /** Amide hydrogen, placed DSSP-style (NaN when it cannot be placed or the residue is Pro). */
  H: Float64Array;
  hasN: Uint8Array;
  hasCA: Uint8Array;
  hasC: Uint8Array;
  hasO: Uint8Array;
  /** Chain id per residue. */
  chain: string[];
  /** Contiguous segment id (increments at chain changes and chain breaks). */
  segment: Int32Array;
}

const O_NAMES = ['O', 'OT1', 'O1', 'OXT'];

function extractBackbone(mol: Molecule, order: number[]): Backbone {
  const topo = getTopology(mol);
  const m = order.length;
  const mk = () => new Float64Array(3 * m).fill(NaN);
  const bb: Backbone = {
    m,
    N: mk(),
    CA: mk(),
    C: mk(),
    O: mk(),
    H: mk(),
    hasN: new Uint8Array(m),
    hasCA: new Uint8Array(m),
    hasC: new Uint8Array(m),
    hasO: new Uint8Array(m),
    chain: new Array(m),
    segment: new Int32Array(m),
  };
  const isPro = new Uint8Array(m);
  const set = (arr: Float64Array, k: number, a: Atom) => {
    arr[3 * k] = a.x;
    arr[3 * k + 1] = a.y;
    arr[3 * k + 2] = a.z;
  };
  for (let k = 0; k < m; k++) {
    const res = topo.residues[order[k]];
    bb.chain[k] = res.chain;
    if (res.oneLetter === 'P') isPro[k] = 1;
    let oRank = O_NAMES.length;
    for (const ai of res.atomIndices) {
      const a = mol.atoms[ai];
      const name = (a.name ?? '').toUpperCase();
      if (name === 'N' && !bb.hasN[k]) {
        set(bb.N, k, a);
        bb.hasN[k] = 1;
      } else if (name === 'CA' && !bb.hasCA[k] && a.element === 'C') {
        set(bb.CA, k, a);
        bb.hasCA[k] = 1;
      } else if (name === 'C' && !bb.hasC[k]) {
        set(bb.C, k, a);
        bb.hasC[k] = 1;
      } else {
        const r = O_NAMES.indexOf(name);
        if (r >= 0 && r < oRank) {
          set(bb.O, k, a);
          bb.hasO[k] = 1;
          oRank = r;
        }
      }
    }
  }

  // Segments: break on chain change, long peptide bond or (if atoms are missing) long CA–CA.
  let seg = 0;
  for (let k = 0; k < m; k++) {
    if (k > 0) {
      let connected = bb.chain[k] === bb.chain[k - 1];
      if (connected) {
        if (bb.hasC[k - 1] && bb.hasN[k]) connected = dist3(bb.C, k - 1, bb.N, k) <= MAX_PEPTIDE_BOND;
        else if (bb.hasCA[k - 1] && bb.hasCA[k]) connected = dist3(bb.CA, k - 1, bb.CA, k) <= MAX_CA_CA;
        else connected = false;
      }
      if (!connected) seg++;
    }
    bb.segment[k] = seg;
  }

  // Amide H: N + unit(C(i−1) − O(i−1)) · 1 Å.
  for (let k = 1; k < m; k++) {
    if (isPro[k] || !bb.hasN[k] || bb.segment[k] !== bb.segment[k - 1] || !bb.hasC[k - 1] || !bb.hasO[k - 1]) continue;
    const dx = bb.C[3 * k - 3] - bb.O[3 * k - 3];
    const dy = bb.C[3 * k - 2] - bb.O[3 * k - 2];
    const dz = bb.C[3 * k - 1] - bb.O[3 * k - 1];
    const l = Math.hypot(dx, dy, dz);
    if (!(l > 0)) continue;
    bb.H[3 * k] = bb.N[3 * k] + dx / l;
    bb.H[3 * k + 1] = bb.N[3 * k + 1] + dy / l;
    bb.H[3 * k + 2] = bb.N[3 * k + 2] + dz / l;
  }
  return bb;
}

function dist3(a: Float64Array, i: number, b: Float64Array, j: number): number {
  return Math.hypot(a[3 * i] - b[3 * j], a[3 * i + 1] - b[3 * j + 1], a[3 * i + 2] - b[3 * j + 2]);
}

/**
 * DSSP H-bond energy (kcal/mol) between donor N–H and acceptor C=O, given the four positions.
 * Exported for tests.
 */
export function hbondEnergy(
  n: ArrayLike<number>,
  h: ArrayLike<number>,
  c: ArrayLike<number>,
  o: ArrayLike<number>,
): number {
  const rON = Math.hypot(o[0] - n[0], o[1] - n[1], o[2] - n[2]);
  const rCH = Math.hypot(c[0] - h[0], c[1] - h[1], c[2] - h[2]);
  const rOH = Math.hypot(o[0] - h[0], o[1] - h[1], o[2] - h[2]);
  const rCN = Math.hypot(c[0] - n[0], c[1] - n[1], c[2] - n[2]);
  if (rON < 0.5 || rCH < 0.5 || rOH < 0.5 || rCN < 0.5) return HB_MIN_ENERGY;
  const e = HB_COUPLING * (1 / rON + 1 / rCH - 1 / rOH - 1 / rCN);
  return Math.max(HB_MIN_ENERGY, e);
}

// ---------------------------------------------------------------------------------------------
// DSSP core
// ---------------------------------------------------------------------------------------------

/** One DSSP code per residue: 'H' (α-helix), 'E' (strand), 'B' (isolated bridge) or ' '. */
export type DsspCode = 'H' | 'E' | 'B' | ' ';

export function computeDssp(bb: Backbone): DsspCode[] {
  const { m } = bb;
  const codes: DsspCode[] = new Array(m).fill(' ');
  if (m < 2) return codes;

  // ---- H-bonds: two best acceptors per donor ----------------------------------------------
  const acc1 = new Int32Array(m).fill(-1);
  const acc2 = new Int32Array(m).fill(-1);
  const e1 = new Float64Array(m);
  const e2 = new Float64Array(m);
  const caList: number[] = [];
  for (let k = 0; k < m; k++) if (bb.hasCA[k]) caList.push(k);
  const grid = new SpatialGrid(bb.CA, MAX_CA_DISTANCE, caList);
  const n = [0, 0, 0], h = [0, 0, 0], c = [0, 0, 0], o = [0, 0, 0];
  for (const don of caList) {
    if (Number.isNaN(bb.H[3 * don])) continue;
    for (let d = 0; d < 3; d++) {
      n[d] = bb.N[3 * don + d];
      h[d] = bb.H[3 * don + d];
    }
    grid.forEachWithin(bb.CA[3 * don], bb.CA[3 * don + 1], bb.CA[3 * don + 2], MAX_CA_DISTANCE, (acc) => {
      if (acc === don || !bb.hasC[acc] || !bb.hasO[acc]) return;
      // The C=O of the preceding residue belongs to the donor's own peptide group.
      if (acc === don - 1 && bb.segment[acc] === bb.segment[don]) return;
      for (let d = 0; d < 3; d++) {
        c[d] = bb.C[3 * acc + d];
        o[d] = bb.O[3 * acc + d];
      }
      const e = hbondEnergy(n, h, c, o);
      if (e < e1[don]) {
        e2[don] = e1[don];
        acc2[don] = acc1[don];
        e1[don] = e;
        acc1[don] = acc;
      } else if (e < e2[don]) {
        e2[don] = e;
        acc2[don] = acc;
      }
    });
  }
  /** C=O of `a` H-bonded to N–H of `d`. */
  const hb = (a: number, d: number): boolean => {
    if (a < 0 || d < 0 || a >= m || d >= m) return false;
    return (acc1[d] === a && e1[d] < HBOND_THRESHOLD) || (acc2[d] === a && e2[d] < HBOND_THRESHOLD);
  };
  const sameSeg = (i: number, j: number) => i >= 0 && j >= 0 && i < m && j < m && bb.segment[i] === bb.segment[j];

  // ---- β bridges and ladders --------------------------------------------------------------
  const candidates = new Set<number>();
  const addPair = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= m || y >= m) return;
    const i = Math.min(x, y);
    const j = Math.max(x, y);
    if (j - i >= 3) candidates.add(i * m + j);
  };
  for (let d = 0; d < m; d++) {
    for (const [a, e] of [[acc1[d], e1[d]], [acc2[d], e2[d]]] as const) {
      if (a < 0 || e >= HBOND_THRESHOLD) continue;
      // Every bridge pattern term Hb(x, y) maps the H-bond (a → d) back to a residue pair (i, j).
      addPair(a + 1, d); // parallel Hb(i−1, j)
      addPair(d - 1, a); // parallel Hb(j, i+1)
      addPair(a, d); // antiparallel Hb(i, j) / Hb(j, i)
      addPair(a + 1, d - 1); // antiparallel Hb(i−1, j+1) / Hb(j−1, i+1)
    }
  }
  type Bridge = { i: number; j: number; parallel: boolean };
  const bridges: Bridge[] = [];
  for (const key of candidates) {
    const i = Math.floor(key / m);
    const j = key - i * m;
    if (!sameSeg(i - 1, i + 1) || !sameSeg(j - 1, j + 1)) continue;
    if ((hb(i - 1, j) && hb(j, i + 1)) || (hb(j - 1, i) && hb(i, j + 1))) bridges.push({ i, j, parallel: true });
    else if ((hb(i, j) && hb(j, i)) || (hb(i - 1, j + 1) && hb(j - 1, i + 1))) bridges.push({ i, j, parallel: false });
  }
  bridges.sort((p, q) => p.i - q.i || p.j - q.j);

  // Ladders: i strand ascending; j strand stored ascending (antiparallel ladders grow downwards in j).
  type Ladder = { parallel: boolean; i: number[]; j: number[] };
  const ladders: Ladder[] = [];
  for (const br of bridges) {
    let extended = false;
    for (const L of ladders) {
      if (L.parallel !== br.parallel) continue;
      const li = L.i[L.i.length - 1];
      if (br.i !== li + 1 || !sameSeg(li, br.i)) continue;
      if (br.parallel) {
        const lj = L.j[L.j.length - 1];
        if (br.j === lj + 1 && sameSeg(lj, br.j)) {
          L.i.push(br.i);
          L.j.push(br.j);
          extended = true;
        }
      } else {
        const lj = L.j[0];
        if (br.j === lj - 1 && sameSeg(lj, br.j)) {
          L.i.push(br.i);
          L.j.unshift(br.j);
          extended = true;
        }
      }
      if (extended) break;
    }
    if (!extended) ladders.push({ parallel: br.parallel, i: [br.i], j: [br.j] });
  }

  // Merge ladders linked by β-bulges (gap ≤ 4 residues on one strand, ≤ 1 on the other).
  for (let a = 0; a < ladders.length; a++) {
    for (let b = a + 1; b < ladders.length; b++) {
      const A = ladders[a];
      const B = ladders[b];
      if (A.parallel !== B.parallel) continue;
      const ibi = A.i[0], iei = A.i[A.i.length - 1], jbi = A.j[0], jei = A.j[A.j.length - 1];
      const ibj = B.i[0], iej = B.i[B.i.length - 1], jbj = B.j[0], jej = B.j[B.j.length - 1];
      if (!sameSeg(Math.min(ibi, ibj), Math.max(iei, iej)) || !sameSeg(Math.min(jbi, jbj), Math.max(jei, jej))) continue;
      const gapI = ibj - iei;
      if (gapI <= 0 || gapI >= 6) continue;
      const gapJ = A.parallel ? jbj - jei : jbi - jej;
      if (gapJ < 0) continue;
      const bulge = (gapJ < 6 && gapI < 3) || gapJ < 3;
      if (!bulge) continue;
      A.i = [...A.i, ...B.i];
      A.j = A.parallel ? [...A.j, ...B.j] : [...B.j, ...A.j];
      ladders.splice(b, 1);
      b--;
    }
  }
  for (const L of ladders) {
    const code: DsspCode = L.i.length > 1 ? 'E' : 'B';
    for (const strand of [L.i, L.j]) {
      const lo = Math.min(...strand);
      const hi = Math.max(...strand);
      for (let k = lo; k <= hi; k++) if (codes[k] !== 'E') codes[k] = code;
    }
  }

  // ---- α-helices (overwrite strands) --------------------------------------------------------
  const turn4 = new Uint8Array(m);
  for (let i = 0; i + 4 < m; i++) if (sameSeg(i, i + 4) && hb(i, i + 4)) turn4[i] = 1;
  for (let i = 1; i + 4 < m; i++) {
    if (turn4[i - 1] && turn4[i]) for (let k = i; k <= i + 3; k++) codes[k] = 'H';
  }
  return codes;
}

// ---------------------------------------------------------------------------------------------
// CA-trace fallback (P-SEA-like criteria on virtual CA geometry)
// ---------------------------------------------------------------------------------------------

/**
 * Assign H/E/' ' from CA positions only, for the residues flagged in `use`. Helix: virtual torsion
 * CA(i..i+3) ≈ +50° and d(i, i+3) ≈ 5.3 Å in consecutive windows (helices ≥ 4 residues). Strand:
 * extended residues (d(i−1, i+1) ≥ 6 Å, virtual torsion ≈ −170°) with a CA within 5.5 Å on
 * another extended stretch (any CA-only chain), in runs of ≥ 3 residues. Loosely after P-SEA
 * (Labesse et al. 1997).
 */
function assignFromCATrace(bb: Backbone, use: Uint8Array): DsspCode[] {
  const { m, CA: ca, segment: seg } = bb;
  const codes: DsspCode[] = new Array(m).fill(' ');
  const ok = (k: number) => k >= 0 && k < m && use[k] === 1 && bb.hasCA[k] === 1;
  const contiguous = (a: number, b: number) => ok(a) && ok(b) && seg[a] === seg[b];

  const helixWin = new Uint8Array(m);
  const extended = new Uint8Array(m);
  for (let k = 0; k < m; k++) {
    if (!ok(k)) continue;
    if (contiguous(k, k + 3)) {
      const tau = dihedral(ca, k, k + 1, k + 2, k + 3);
      const d3 = dist3(ca, k, ca, k + 3);
      if (tau >= 30 && tau <= 80 && d3 >= 4.6 && d3 <= 6.0) helixWin[k] = 1;
    }
    if (contiguous(k - 1, k + 2)) {
      const tau = dihedral(ca, k - 1, k, k + 1, k + 2);
      const d2 = dist3(ca, k - 1, ca, k + 1);
      const dev = Math.abs(((tau + 170 + 540) % 360) - 180); // angular distance from −170°
      if (d2 >= 6.0 && dev <= 50) extended[k] = 1;
    }
  }
  // Strands need a partner: an extended residue ≥ 3 apart in sequence (or in another segment)
  // with CA–CA ≤ 5.5 Å.
  const extList: number[] = [];
  for (let k = 0; k < m; k++) if (extended[k]) extList.push(k);
  const sheetCand = new Uint8Array(m);
  if (extList.length) {
    const grid = new SpatialGrid(ca, 5.5, extList);
    for (const k of extList) {
      grid.forEachWithin(ca[3 * k], ca[3 * k + 1], ca[3 * k + 2], 5.5, (j) => {
        if (seg[j] !== seg[k] || Math.abs(j - k) >= 3) sheetCand[k] = 1;
      });
    }
  }
  markRuns(sheetCand, seg, 3, (k) => (codes[k] = 'E'));

  // Consecutive helical windows (k−1, k) mark residues k..k+2, mirroring DSSP, which leaves the
  // first and last residue of an ideal helix as coil; then drop helices shorter than 4.
  const helix = new Uint8Array(m);
  for (let k = 1; k < m; k++) {
    if (helixWin[k - 1] && helixWin[k]) for (let q = k; q <= k + 2 && q < m; q++) helix[q] = 1;
  }
  markRuns(helix, seg, 4, (k) => (codes[k] = 'H'));
  return codes;
}

/** Calls `mark(k)` for every k in runs of set flags (within one segment) of length ≥ minLen. */
function markRuns(flags: Uint8Array, seg: Int32Array, minLen: number, mark: (k: number) => void): void {
  const m = flags.length;
  for (let k = 0; k < m; ) {
    if (!flags[k]) {
      k++;
      continue;
    }
    let e = k + 1;
    while (e < m && flags[e] && seg[e] === seg[e - 1]) e++;
    if (e - k >= minLen) for (let q = k; q < e; q++) mark(q);
    k = e;
  }
}

/** Dihedral angle (degrees, −180..180) of points i, j, k, l in an interleaved coordinate array. */
function dihedral(p: Float64Array, i: number, j: number, k: number, l: number): number {
  const b1x = p[3 * j] - p[3 * i], b1y = p[3 * j + 1] - p[3 * i + 1], b1z = p[3 * j + 2] - p[3 * i + 2];
  const b2x = p[3 * k] - p[3 * j], b2y = p[3 * k + 1] - p[3 * j + 1], b2z = p[3 * k + 2] - p[3 * j + 2];
  const b3x = p[3 * l] - p[3 * k], b3y = p[3 * l + 1] - p[3 * k + 1], b3z = p[3 * l + 2] - p[3 * k + 2];
  const n1x = b1y * b2z - b1z * b2y, n1y = b1z * b2x - b1x * b2z, n1z = b1x * b2y - b1y * b2x;
  const n2x = b2y * b3z - b2z * b3y, n2y = b2z * b3x - b2x * b3z, n2z = b2x * b3y - b2y * b3x;
  // φ = atan2(|b2| · b1·(b2×b3), (b1×b2)·(b2×b3))  (IUPAC sign convention)
  const b2l = Math.hypot(b2x, b2y, b2z);
  const x = n1x * n2x + n1y * n2y + n1z * n2z;
  const y = b2l * (b1x * n2x + b1y * n2y + b1z * n2z);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
