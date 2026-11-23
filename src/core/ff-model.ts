/**
 * Force-field atom typing and term construction (UFF-like, simplified). OWNER: forcefield agent.
 *
 * Typing is derived from the bond graph only (elements, bond orders, formal charges):
 *  - steric number = neighbours + missing hydrogens + lone pairs  →  sp / sp2 / sp3 / hypervalent
 *  - resonance: N with a lone pair next to a π system (amide, aniline, enamine) is planar sp2;
 *    O/S next to a π system (ester, phenol) are flagged "conjugated" (planarity torsion, shorter bond)
 *  - aromatic rings given in Kekulé form (alternating 1/2 orders) are detected with Hückel's rule
 *  - optional geometry inference for atoms whose valence is incomplete (typically PDB structures
 *    without hydrogens and without bond orders): planar / linear centres are recognised from the
 *    input coordinates, so cleaning a protein does not pucker aromatic side chains or stretch the
 *    peptide bond.
 *
 * Energy terms (kcal/mol, Å, radians):
 *   bond      E = kb (r − r0)²
 *   angle     E = ka/sin²θ0 · (cos θ − cos θ0)²   (UFF-style; ≈ ka (θ − θ0)² near θ0, but has no
 *                                                  spurious pyramidal minimum for flat sp3 centres)
 *             linear centres: E = 2ka (1 + cos θ); hypervalent / octahedral: E = (2ka/16)(1 − cos 4θ)
 *   torsion   E = V/2 [1 − d·cos(nφ)]       (sp2–sp2: n = 2, d = +1; sp3–sp3: n = 3, d = −1)
 *   improper  E = ko h²                     (h = distance of an sp2 centre from its neighbours' plane)
 *   non-bond  E = kr (d0 − r)²  for r < d0  (soft repulsion; pairs ≥ 3 bonds apart, 1–4 scaled)
 */
import type { Molecule } from './types';
import { getTopology } from './molecule';
import { getElement } from './elements';
import { idealBondLength, resonanceBondLength, resonanceEquivalents } from './geometry';
import { allowedValences, isCovalentElement, valenceElectrons } from './ff-chem';
import { edgeKey, ringEdgeSet, shortestPath, smallestRingThroughAngle, smallestRingThroughBond } from './ff-rings';

export const HYB_NONE = 0;
export const HYB_SP = 1;
export const HYB_SP2 = 2;
export const HYB_SP3 = 3;
/** Steric number ≥ 5 (PF5, SF6, XeF4 …): handled with a 4-fold angle term. */
export const HYB_HYPER = 5;

export interface Typing {
  n: number;
  nbrs: number[][];
  /** Bond orders parallel to nbrs. */
  nbrOrder: number[][];
  hyb: Int8Array;
  /** 1 = element with directional covalent bonds (gets angle/torsion terms). */
  covalent: Uint8Array;
  /** Lone-pair donor next to a π system (amide N, ester/phenol O, thioester S). */
  conj: Uint8Array;
  /** Member of an aromatic ring (explicit 1.5 bonds or Hückel-perceived Kekulé ring). */
  aromatic: Uint8Array;
  /** Valence incomplete (missing H / bond orders) and hybridisation taken from the coordinates. */
  inferred: Uint8Array;
  /** Implicit (missing) hydrogens per atom, from the valence model. */
  missingH: Int8Array;
  lonePairs: Int8Array;
  /** Bonds that belong to aromatic rings (edgeKey). */
  aromaticBonds: Set<number>;
  /** Bonds that lie on a ring (edgeKey). */
  ringEdges: Set<number>;
  /** Geometry inference was enabled. */
  infer: boolean;
}

export interface TypingOptions {
  /** Infer hybridisation (and bond rest lengths) of valence-incomplete atoms from coordinates. */
  inferFromGeometry?: boolean;
  /**
   * Only type these atoms (mask by index); the others get `covalent` only. Used for local
   * relaxation in big structures: atoms within ~8 bonds of the movable ones are all that matter.
   */
  region?: Uint8Array;
}

/** Mask of atoms within `depth` bonds of any seed atom. */
export function regionAround(nbrs: readonly (readonly number[])[], seeds: Iterable<number>, depth: number): Uint8Array {
  const mask = new Uint8Array(nbrs.length);
  let frontier: number[] = [];
  for (const s of seeds) if (!mask[s]) {
    mask[s] = 1;
    frontier.push(s);
  }
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: number[] = [];
    for (const v of frontier) for (const w of nbrs[v]) if (!mask[w]) {
      mask[w] = 1;
      next.push(w);
    }
    frontier = next;
  }
  return mask;
}

function angleAt(mol: Molecule, a: number, j: number, c: number): number {
  const A = mol.atoms[a], J = mol.atoms[j], C = mol.atoms[c];
  const ux = A.x - J.x, uy = A.y - J.y, uz = A.z - J.z;
  const vx = C.x - J.x, vy = C.y - J.y, vz = C.z - J.z;
  const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
  if (lu < 1e-6 || lv < 1e-6) return NaN;
  const c0 = Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / (lu * lv)));
  return (Math.acos(c0) * 180) / Math.PI;
}

function dihedralAt(mol: Molecule, i: number, j: number, k: number, l: number): number {
  const p = (t: number) => mol.atoms[t];
  const b0x = p(i).x - p(j).x, b0y = p(i).y - p(j).y, b0z = p(i).z - p(j).z;
  let b1x = p(k).x - p(j).x, b1y = p(k).y - p(j).y, b1z = p(k).z - p(j).z;
  const b2x = p(l).x - p(k).x, b2y = p(l).y - p(k).y, b2z = p(l).z - p(k).z;
  const lb1 = Math.hypot(b1x, b1y, b1z) || 1;
  b1x /= lb1; b1y /= lb1; b1z /= lb1;
  const d0 = b0x * b1x + b0y * b1y + b0z * b1z;
  const vx = b0x - d0 * b1x, vy = b0y - d0 * b1y, vz = b0z - d0 * b1z;
  const d2 = b2x * b1x + b2y * b1y + b2z * b1z;
  const wx = b2x - d2 * b1x, wy = b2y - d2 * b1y, wz = b2z - d2 * b1z;
  const x = vx * wx + vy * wy + vz * wz;
  const cx = b1y * vz - b1z * vy, cy = b1z * vx - b1x * vz, cz = b1x * vy - b1y * vx;
  const y = cx * wx + cy * wy + cz * wz;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Hybridisation / resonance / aromaticity typing for every atom. */
export function perceiveTyping(mol: Molecule, opts: TypingOptions = {}): Typing {
  const topo = getTopology(mol);
  const n = mol.atoms.length;
  const nbrs = topo.neighbors;
  const region = opts.region;
  const inRegion = (i: number) => !region || region[i] === 1;
  const nbrOrder = topo.atomBonds.map((list, i) => (inRegion(i) ? list.map((bi) => mol.bonds[bi].order as number) : []));
  const hyb = new Int8Array(n);
  const covalent = new Uint8Array(n);
  const conj = new Uint8Array(n);
  const aromatic = new Uint8Array(n);
  const inferred = new Uint8Array(n);
  const missingH = new Int8Array(n);
  const lonePairs = new Int8Array(n);
  const hasPi = new Uint8Array(n);
  const ringEdges = ringEdgeSet(nbrs, region);
  const aromaticBonds = new Set<number>();
  const infer = !!opts.inferFromGeometry;

  // ---- pass 1: steric number from the valence model ------------------------------------
  for (let i = 0; i < n; i++) {
    const atom = mol.atoms[i];
    const el = atom.element;
    if (!isCovalentElement(el)) continue;
    covalent[i] = 1;
    if (!inRegion(i)) continue;
    const q = atom.charge ?? 0;
    const deg = nbrs[i].length;
    let sum = 0;
    let nAr = 0;
    for (const o of nbrOrder[i]) {
      if (o === 1.5) nAr++;
      else sum += o;
      if (o > 1) hasPi[i] = 1;
    }
    if (nAr > 0) {
      for (let k = 0; k < deg; k++) if (nbrOrder[i][k] === 1.5) aromaticBonds.add(edgeKey(i, nbrs[i][k], n));
      if (deg <= 3) {
        aromatic[i] = 1;
        hyb[i] = HYB_SP2;
        continue;
      }
    }
    // Aromatic bonds count as 1 each plus one shared π bond.
    const eff = Math.round(sum + nAr + (nAr > 0 ? 1 : 0));
    const allowed = allowedValences(el, q);
    const target = allowed.find((v) => v >= eff);
    const miss = el === 'H' || target === undefined ? 0 : target - eff;
    const ve = valenceElectrons(el) ?? 4;
    const lp = Math.max(0, Math.floor((ve - q - eff - miss) / 2));
    const sn = deg + miss + lp;
    missingH[i] = miss;
    lonePairs[i] = lp;
    hyb[i] = sn <= 2 ? HYB_SP : sn === 3 ? HYB_SP2 : sn === 4 ? HYB_SP3 : HYB_HYPER;
  }

  // ---- pass 2: resonance (lone pair next to a π system) ---------------------------------
  const hyb0 = hyb.slice();
  for (let i = 0; i < n; i++) {
    if (!covalent[i] || !inRegion(i) || aromatic[i] || hyb0[i] !== HYB_SP3 || lonePairs[i] < 1) continue;
    const el = mol.atoms[i].element;
    if (el !== 'N' && el !== 'O' && el !== 'S' && el !== 'Se') continue;
    if ((mol.atoms[i].charge ?? 0) > 0) continue;
    const list = nbrs[i];
    if (list.length < 1) continue;
    // Aziridine / epoxide atoms stay pyramidal.
    let threeRing = false;
    for (let a = 0; a < list.length && !threeRing; a++)
      for (let b = a + 1; b < list.length; b++) if (nbrs[list[a]].includes(list[b])) threeRing = true;
    if (threeRing) continue;
    let donor = false;
    for (const k of list) if (covalent[k] && hasPi[k] && (hyb0[k] === HYB_SP2 || hyb0[k] === HYB_SP) && nbrs[k].length >= 2) donor = true;
    if (!donor) continue;
    conj[i] = 1;
    if (el === 'N' && list.length + missingH[i] <= 3) hyb[i] = HYB_SP2;
  }

  // ---- pass 3: geometry inference for valence-incomplete atoms --------------------------
  if (infer) {
    for (let i = 0; i < n; i++) {
      if (!covalent[i] || !inRegion(i) || aromatic[i] || missingH[i] <= 0) continue;
      inferred[i] = 1;
      const list = nbrs[i];
      if (list.some((k) => !covalent[k])) continue;
      if (list.length === 3) {
        const s = angleAt(mol, list[0], i, list[1]) + angleAt(mol, list[0], i, list[2]) + angleAt(mol, list[1], i, list[2]);
        if (Number.isFinite(s)) hyb[i] = s > 350 ? HYB_SP2 : HYB_SP3;
      } else if (list.length === 2) {
        const th = angleAt(mol, list[0], i, list[1]);
        if (!Number.isFinite(th)) continue;
        if (th > 165) hyb[i] = HYB_SP;
        else if (th > 116 || ringIsPlanar(mol, nbrs, ringEdges, i, list[0], list[1])) hyb[i] = HYB_SP2;
        else hyb[i] = HYB_SP3;
      }
    }
  }

  // ---- pass 4: Hückel aromaticity for Kekulé / conjugated 5- and 6-rings -----------------
  const piCandidate = (v: number) =>
    covalent[v] === 1 && inRegion(v) && nbrs[v].length >= 2 && nbrs[v].length <= 3 && (hyb[v] === HYB_SP2 || conj[v] === 1);
  const tested = new Set<string>();
  for (let i = 0; i < n; i++) {
    if (!piCandidate(i)) continue;
    for (const j of nbrs[i]) {
      if (j < i || !piCandidate(j)) continue;
      const key = edgeKey(i, j, n);
      if (aromaticBonds.has(key) || !ringEdges.has(key)) continue;
      const path = shortestPath(nbrs, i, j, 5, -1, true, piCandidate);
      if (!path || path.length < 5) continue;
      const ringKey = path.slice().sort((a, b) => a - b).join(',');
      if (tested.has(ringKey)) continue;
      tested.add(ringKey);
      if (isHuckelRing(mol, path, nbrs, nbrOrder, conj, lonePairs)) {
        for (let t = 0; t < path.length; t++) {
          const a = path[t];
          aromaticBonds.add(edgeKey(a, path[(t + 1) % path.length], n));
          aromatic[a] = 1;
          hyb[a] = HYB_SP2;
        }
      }
    }
  }

  return { n, nbrs, nbrOrder, hyb, covalent, conj, aromatic, inferred, missingH, lonePairs, aromaticBonds, ringEdges, infer };
}

/** True if the small ring through a–i–c is (nearly) planar in the input coordinates. */
function ringIsPlanar(mol: Molecule, nbrs: number[][], ringEdges: Set<number>, i: number, a: number, c: number): boolean {
  if (!ringEdges.has(edgeKey(i, a, nbrs.length))) return false;
  const p = shortestPath(nbrs, a, c, 5, i);
  if (!p) return false;
  const ring = [i, ...p];
  const m = ring.length;
  for (let t = 0; t < m; t++) {
    const d = dihedralAt(mol, ring[t], ring[(t + 1) % m], ring[(t + 2) % m], ring[(t + 3) % m]);
    if (!Number.isFinite(d) || Math.abs(d) > 15) return false;
  }
  return true;
}

/** Hückel 4n+2 π-electron count for a ring given in Kekulé form (no aromatic orders). */
function isHuckelRing(mol: Molecule, ring: number[], nbrs: number[][], nbrOrder: number[][], conj: Uint8Array, lonePairs: Int8Array): boolean {
  const inRing = new Set(ring);
  let electrons = 0;
  for (let t = 0; t < ring.length; t++) {
    const a = ring[t];
    const prev = ring[(t + ring.length - 1) % ring.length];
    const next = ring[(t + 1) % ring.length];
    let ringDouble = false;
    let exoDouble = false;
    for (let k = 0; k < nbrs[a].length; k++) {
      const o = nbrOrder[a][k];
      const b = nbrs[a][k];
      if (o === 1.5) return false; // mixed representation: leave as given
      if (o >= 2) {
        if (b === prev || b === next) ringDouble = true;
        else if (!inRing.has(b)) exoDouble = true;
      }
    }
    const q = mol.atoms[a].charge ?? 0;
    if (ringDouble) electrons += 1;
    else if (exoDouble) electrons += 0;
    else if (conj[a] || (lonePairs[a] > 0 && mol.atoms[a].element !== 'C')) electrons += 2;
    else if (mol.atoms[a].element === 'C' && q === 1) electrons += 0;
    else if (mol.atoms[a].element === 'C' && q === -1) electrons += 2;
    else if (mol.atoms[a].element === 'B' && q === 0) electrons += 0;
    else return false;
  }
  return electrons % 4 === 2;
}

/**
 * Rest length of bond i–j: idealBondLength(elA, elB, order) with small conjugation corrections
 * (aromatic rings in Kekulé form → aromatic length; amide/ester/aniline/conjugated single bonds
 * shortened by 3–7 %). Delocalised terminal groups (carboxylate C(=O)O⁻, nitro N⁺(=O)O⁻, also
 * written with 1.5 bonds) get their experimental resonance length (geometry resonanceBondLength:
 * C–O 1.255, N–O 1.22 Å), not the longer aromatic one, so a relaxed carboxylate still reads as
 * C=O + C–O⁻ after an XYZ / PDB round trip (geometry idealBondLengthInMolecule applies the same
 * rule for the inspector). S(II)–N bonds of aromatic five-rings get the aromatic S–N length in
 * every representation (also the SMILES reader's mixed form with single bonds at the S). For
 * valence-incomplete atoms under geometry inference (missing bond orders) the observed length is
 * trusted within the single…triple range.
 */
export function restLength(mol: Molecule, t: Typing, i: number, j: number, order: number): number {
  const ei = mol.atoms[i].element;
  const ej = mol.atoms[j].element;
  const n = t.n;
  if (order !== 3) {
    const eq = resonanceEquivalents(mol, i, j);
    if (eq > 0) return resonanceBondLength(ei, ej, eq);
  }
  if (order === 1.5 || t.aromaticBonds.has(edgeKey(i, j, n))) return idealBondLength(ei, ej, 1.5);
  const bo = (order === 2 || order === 3 ? order : 1) as 1 | 2 | 3;
  // idealBondLength already holds the experimental polar-bond lengths (POLAR_BOND_LENGTHS), so the
  // geometry inspector's "ideal" value and the minimiser agree.
  const base = idealBondLength(ei, ej, bo);
  if (bo !== 1) return base;
  if (t.infer && t.inferred[i] && t.inferred[j]) {
    const A = mol.atoms[i], B = mol.atoms[j];
    const r = Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
    if (Number.isFinite(r) && r > 0.5) return Math.min(1.04 * base, Math.max(0.76 * base, r));
    return base;
  }
  if (t.nbrs[i].length < 2 || t.nbrs[j].length < 2 || !t.covalent[i] || !t.covalent[j]) return base;
  if ((ei === 'S' && ej === 'N' && isAromaticRingSulfur(t, i)) || (ej === 'S' && ei === 'N' && isAromaticRingSulfur(t, j))) {
    // S(II)–N ring bond of an aromatic ring written with single bonds at the S (the SMILES reader's
    // form of isothiazole / thiadiazoles: S–N single, the other ring bonds 1.5). The table's S–N
    // single is the sulfonamide S(VI) value, and conjugation-shortened (1.63 × 0.94) it gave
    // ≈ 1.53 Å vs ≈ 1.62–1.63 Å observed; use the aromatic S–N length, as the Kekulé and 1.5 forms do.
    return idealBondLength(ei, ej, 1.5);
  }
  const hi = t.hyb[i], hj = t.hyb[j];
  const piI = hi === HYB_SP || hi === HYB_SP2;
  const piJ = hj === HYB_SP || hj === HYB_SP2;
  if (piI && piJ) {
    if (hi === HYB_SP || hj === HYB_SP) return base * 0.95;
    if (t.conj[i] || t.conj[j]) return base * 0.93;
    return base * 0.97;
  }
  if ((t.conj[i] && piJ) || (t.conj[j] && piI)) return base * 0.94;
  if (hi === HYB_SP || hj === HYB_SP) return base * 0.96;
  return base;
}

/**
 * Divalent S(II) lone-pair donor (two single bonds, two lone pairs) whose two bonds both lie on
 * rings and lead to aromatic atoms: the thiophene-type S of a five-membered aromatic ring given in
 * the mixed form (single bonds at the S, aromatic bonds elsewhere).
 */
function isAromaticRingSulfur(t: Typing, s: number): boolean {
  const list = t.nbrs[s];
  if (list.length !== 2 || !t.conj[s] || t.lonePairs[s] < 2 || t.missingH[s] !== 0) return false;
  for (let k = 0; k < 2; k++) {
    if (t.nbrOrder[s][k] !== 1) return false;
    const x = list[k];
    if (!t.aromatic[x] || !t.ringEdges.has(edgeKey(s, x, t.n))) return false;
  }
  return true;
}

/** Ideal sp3 angle (degrees) for a centre, by element / lone pairs. */
function sp3Angle(el: string, lp: number, conj: boolean): number {
  if (lp <= 0) return 109.47;
  switch (el) {
    case 'N':
      return 107.5;
    case 'O':
      return conj ? 115 : 107.5;
    case 'S':
      return conj ? 100 : 97;
    case 'Se':
    case 'Te':
      return 95;
    case 'P':
    case 'As':
    case 'Sb':
      return 99;
    default:
      return 109.47;
  }
}

// ---------------------------------------------------------------------------
// Model (term lists)
// ---------------------------------------------------------------------------

export const ANGLE_HARMONIC = 0;
export const ANGLE_LINEAR = 1;
export const ANGLE_COS4 = 2;

/** Force constants (kcal/mol, Å, rad). */
export const FF_PARAMS = {
  kBond: 350,
  kBondMultiple: 450,
  kBondMetal: 100,
  kAngle: 60,
  kAngleH: 40,
  kImproper: 40,
  kRepel: 40,
  scaleRepel: 0.8,
  scaleRepel14: 0.75,
  factor14: 0.5,
  scalePolarH: 0.6,
  scaleMetal: 0.5,
  scaleSoft13: 0.6,
  vTorsionDouble: 40,
  vTorsionAromatic: 25,
  vTorsionAmide: 20,
  vTorsionConjugated: 5,
  vTorsionEsterLike: 4,
  vTorsionSp3: 2,
};

export interface FFModel {
  n: number;
  /** 1 = atom may move (receives gradient). */
  active: Uint8Array;
  bondCount: number;
  bI: Int32Array;
  bJ: Int32Array;
  bK: Float64Array;
  bR0: Float64Array;
  angleCount: number;
  aI: Int32Array;
  aJ: Int32Array;
  aK: Int32Array;
  aType: Uint8Array;
  aKf: Float64Array;
  /** cos θ0 (harmonic-in-cosine terms). */
  aT0: Float64Array;
  torsionCount: number;
  tI: Int32Array;
  tJ: Int32Array;
  tK: Int32Array;
  tL: Int32Array;
  tV: Float64Array;
  tN: Int8Array;
  tD: Int8Array;
  improperCount: number;
  oC: Int32Array;
  oA: Int32Array;
  oB: Int32Array;
  oD: Int32Array;
  oK: Float64Array;
  /** Per-atom vdW radius. */
  vdw: Float64Array;
  /** 0 normal, 1 polar hydrogen, 2 H-bond acceptor (N/O/F/S), 3 metal / non-covalent. */
  nbClass: Uint8Array;
  /** For active atoms: sorted lists of excluded partners (1–2, 1–3), 1–4 partners and soft 1–3 partners. */
  excl: (Int32Array | null)[];
  pair14: (Int32Array | null)[];
  soft13: (Int32Array | null)[];
  /** Largest repulsion distance d0 of any pair (Å). */
  cutoff: number;
  typing: Typing;
}

class Buf {
  a: number[] = [];
  push(...v: number[]) {
    for (const x of v) this.a.push(x);
  }
}

/** Build all energy terms that involve at least one active atom. */
export function buildModel(mol: Molecule, typing: Typing, active: Uint8Array): FFModel {
  const n = mol.atoms.length;
  const { nbrs, nbrOrder, hyb, covalent, conj, ringEdges, aromaticBonds } = typing;
  const P = FF_PARAMS;
  const isH = (i: number) => mol.atoms[i].element === 'H';
  const angleCentre = (j: number) => covalent[j] === 1 && hyb[j] !== HYB_NONE;
  const idToIndex = getTopology(mol).idToIndex;

  // ---- bonds ----
  const bI = new Buf(), bJ = new Buf(), bK = new Buf(), bR0 = new Buf();
  for (const b of mol.bonds) {
    const i = idToIndex.get(b.a);
    const j = idToIndex.get(b.b);
    if (i === undefined || j === undefined || i === j) continue;
    if (!active[i] && !active[j]) continue;
    const metal = !covalent[i] || !covalent[j];
    bI.push(i);
    bJ.push(j);
    bK.push(metal ? P.kBondMetal : b.order === 1 ? P.kBond : P.kBondMultiple);
    bR0.push(restLength(mol, typing, i, j, b.order));
  }

  // ---- angles ----
  const aI = new Buf(), aJ = new Buf(), aK = new Buf(), aType = new Buf(), aKf = new Buf(), aT0 = new Buf();
  const ringCache = new Map<string, number>();
  const angleRing = (a: number, j: number, c: number) => {
    const key = a < c ? `${a},${j},${c}` : `${c},${j},${a}`;
    let r = ringCache.get(key);
    if (r === undefined) {
      r = smallestRingThroughAngle(nbrs, ringEdges, a, j, c, 7);
      ringCache.set(key, r);
    }
    return r;
  };
  for (let j = 0; j < n; j++) {
    if (!angleCentre(j)) continue;
    let touches = active[j] === 1;
    if (!touches) for (const k of nbrs[j]) if (active[k]) touches = true;
    if (!touches) continue;
    const list = nbrs[j].filter((k) => covalent[k]);
    if (list.length < 2) continue;
    const el = mol.atoms[j].element;
    const h = hyb[j];
    const pairs: [number, number, number][] = []; // a, c, ringSize
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) pairs.push([list[x], list[y], angleRing(list[x], j, list[y])]);

    const ideal: number[] = new Array(pairs.length).fill(109.47);
    let type = ANGLE_HARMONIC;
    if (h === HYB_SP && list.length === 2) {
      type = ANGLE_LINEAR;
      ideal[0] = 180;
    } else if (h === HYB_HYPER || list.length > 4 || (h === HYB_SP && list.length > 2)) {
      type = ANGLE_COS4;
      ideal.fill(90);
    } else if (h === HYB_SP2 && list.length <= 3) {
      // 7-rings only constrain aromatic-type centres (azulene, tropylium: regular heptagon)
      const ringAngle = (s: number) =>
        s === 3 ? 60 : s === 4 ? 90 : s === 5 ? 108 : s === 6 ? 120 : s === 7 && typing.aromatic[j] ? 128.57 : 0;
      let fixedSum = 0;
      let free = 0;
      for (let p = 0; p < pairs.length; p++) {
        const ra = ringAngle(pairs[p][2]);
        if (ra) {
          ideal[p] = ra;
          fixedSum += ra;
        } else free++;
      }
      if (list.length === 3) {
        const rem = free ? Math.max(90, Math.min(160, (360 - fixedSum) / free)) : 0;
        for (let p = 0; p < pairs.length; p++) if (!ringAngle(pairs[p][2])) ideal[p] = rem;
      } else {
        for (let p = 0; p < pairs.length; p++) if (!ringAngle(pairs[p][2])) ideal[p] = 120;
      }
    } else {
      // sp3 (or sp2 with an unusual neighbour count)
      const base = sp3Angle(el, typing.lonePairs[j], !!conj[j]);
      let smallest = 0;
      for (const p of pairs) if (p[2] >= 3 && p[2] <= 5 && (smallest === 0 || p[2] < smallest)) smallest = p[2];
      const exo = smallest === 3 ? 117 : smallest === 4 ? 113 : smallest === 5 ? 111 : base;
      for (let p = 0; p < pairs.length; p++) {
        const s = pairs[p][2];
        ideal[p] = s === 3 ? 60 : s === 4 ? 88 : s === 5 ? 104.5 : exo;
      }
    }
    for (let p = 0; p < pairs.length; p++) {
      const [a, c] = pairs[p];
      if (!active[a] && !active[j] && !active[c]) continue;
      const k = isH(a) || isH(c) ? P.kAngleH : P.kAngle;
      aI.push(a);
      aJ.push(j);
      aK.push(c);
      aType.push(type);
      const th0 = (ideal[p] * Math.PI) / 180;
      const s0 = Math.sin(th0);
      aKf.push(type === ANGLE_HARMONIC ? k / Math.max(0.25, s0 * s0) : 2 * k);
      aT0.push(Math.cos(th0));
    }
  }

  // ---- torsions ----
  const tI = new Buf(), tJ = new Buf(), tK = new Buf(), tL = new Buf(), tV = new Buf(), tN = new Buf(), tD = new Buf();
  const heteroPi = (k: number, exclude: number) => {
    for (let x = 0; x < nbrs[k].length; x++) {
      const b = nbrs[k][x];
      if (b === exclude) continue;
      const e = mol.atoms[b].element;
      if (nbrOrder[k][x] >= 2 && (e === 'O' || e === 'N' || e === 'S')) return true;
    }
    return false;
  };
  for (const bond of mol.bonds) {
    const j = idToIndex.get(bond.a);
    const k = idToIndex.get(bond.b);
    if (j === undefined || k === undefined) continue;
    if (!covalent[j] || !covalent[k]) continue;
    // a torsion i–j–k–l touches an active atom only if one is within one bond of j or k
    let touches = active[j] === 1 || active[k] === 1;
    if (!touches) for (const x of nbrs[j]) if (active[x]) touches = true;
    if (!touches) for (const x of nbrs[k]) if (active[x]) touches = true;
    if (!touches) continue;
    const hj = hyb[j], hk = hyb[k];
    if (hj !== HYB_SP2 && hj !== HYB_SP3) continue;
    if (hk !== HYB_SP2 && hk !== HYB_SP3) continue;
    const nj = nbrs[j].filter((x) => x !== k && covalent[x]);
    const nk = nbrs[k].filter((x) => x !== j && covalent[x]);
    if (!nj.length || !nk.length) continue;
    const key = edgeKey(j, k, n);
    const inRing = ringEdges.has(key);
    if (inRing && smallestRingThroughBond(nbrs, ringEdges, j, k, 3) === 3) continue;
    let V = 0, per = 0, d = 0;
    if (hj === HYB_SP2 && hk === HYB_SP2) {
      per = 2;
      d = 1;
      if (aromaticBonds.has(key)) V = P.vTorsionAromatic;
      else if (bond.order === 2) V = P.vTorsionDouble;
      else if (typing.inferred[j] && typing.inferred[k] && inRing) V = P.vTorsionAromatic;
      else if ((conj[j] && heteroPi(k, j)) || (conj[k] && heteroPi(j, k))) V = P.vTorsionAmide;
      else if (typing.inferred[j] && typing.inferred[k]) V = P.vTorsionAmide;
      else V = P.vTorsionConjugated;
    } else if (hj === HYB_SP3 && hk === HYB_SP3) {
      per = 3;
      d = -1;
      const ej = mol.atoms[j].element, ek = mol.atoms[k].element;
      const soft = (e: string) => e === 'O' || e === 'S' || e === 'Se';
      V = soft(ej) || soft(ek) ? 1.0 : ej === 'N' || ek === 'N' ? 1.8 : P.vTorsionSp3;
    } else {
      // sp2–sp3: only the lone-pair donor case (ester / phenol / thioester planarity)
      const sp3 = hj === HYB_SP3 ? j : k;
      if (!conj[sp3]) continue;
      per = 2;
      d = 1;
      V = P.vTorsionEsterLike;
    }
    const quads: [number, number][] = [];
    for (const i of nj) for (const l of nk) if (i !== l) quads.push([i, l]);
    if (!quads.length) continue;
    const Veach = V / quads.length;
    for (const [i, l] of quads) {
      if (!active[i] && !active[j] && !active[k] && !active[l]) continue;
      tI.push(i);
      tJ.push(j);
      tK.push(k);
      tL.push(l);
      tV.push(Veach);
      tN.push(per);
      tD.push(d);
    }
  }

  // ---- impropers (planarity of sp2 centres) ----
  const oC = new Buf(), oA = new Buf(), oB = new Buf(), oD = new Buf(), oK = new Buf();
  for (let c = 0; c < n; c++) {
    if (!covalent[c] || hyb[c] !== HYB_SP2 || nbrs[c].length !== 3) continue;
    const [a, b, d] = nbrs[c];
    if (!covalent[a] || !covalent[b] || !covalent[d]) continue;
    if (!active[c] && !active[a] && !active[b] && !active[d]) continue;
    oC.push(c);
    oA.push(a);
    oB.push(b);
    oD.push(d);
    oK.push(P.kImproper);
  }

  // ---- non-bonded parameters and exclusions ----
  const vdw = new Float64Array(n);
  const nbClass = new Uint8Array(n);
  let maxVdw = 0;
  for (let i = 0; i < n; i++) {
    const el = mol.atoms[i].element;
    vdw[i] = getElement(el).vdwRadius || 2.0;
    if (!covalent[i]) nbClass[i] = 3;
    else if (el === 'H') {
      const p = nbrs[i][0];
      const pe = p === undefined ? '' : mol.atoms[p].element;
      nbClass[i] = pe === 'N' || pe === 'O' || pe === 'S' || pe === 'F' ? 1 : 0;
    } else if (el === 'N' || el === 'O' || el === 'F' || el === 'S') nbClass[i] = 2;
    if (vdw[i] > maxVdw) maxVdw = vdw[i];
  }
  const excl: (Int32Array | null)[] = new Array(n).fill(null);
  const pair14: (Int32Array | null)[] = new Array(n).fill(null);
  const soft13: (Int32Array | null)[] = new Array(n).fill(null);
  const softCentre = (m: number) => !covalent[m] || hyb[m] === HYB_HYPER || nbrs[m].length > 4;
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    const ex = new Set<number>([i]);
    const soft = new Set<number>();
    const d2: number[] = [];
    for (const m of nbrs[i]) ex.add(m);
    for (const m of nbrs[i]) {
      for (const x of nbrs[m]) {
        if (ex.has(x)) continue;
        if (softCentre(m)) soft.add(x);
        else {
          ex.add(x);
          d2.push(x);
        }
      }
    }
    for (const x of soft) if (ex.has(x)) soft.delete(x);
    const p14 = new Set<number>();
    for (const m of d2) for (const x of nbrs[m]) if (!ex.has(x) && !soft.has(x)) p14.add(x);
    ex.delete(i);
    excl[i] = Int32Array.from([...ex].sort((a, b) => a - b));
    pair14[i] = p14.size ? Int32Array.from([...p14].sort((a, b) => a - b)) : null;
    soft13[i] = soft.size ? Int32Array.from([...soft].sort((a, b) => a - b)) : null;
  }

  return {
    n,
    active,
    bondCount: bI.a.length,
    bI: Int32Array.from(bI.a),
    bJ: Int32Array.from(bJ.a),
    bK: Float64Array.from(bK.a),
    bR0: Float64Array.from(bR0.a),
    angleCount: aI.a.length,
    aI: Int32Array.from(aI.a),
    aJ: Int32Array.from(aJ.a),
    aK: Int32Array.from(aK.a),
    aType: Uint8Array.from(aType.a),
    aKf: Float64Array.from(aKf.a),
    aT0: Float64Array.from(aT0.a),
    torsionCount: tI.a.length,
    tI: Int32Array.from(tI.a),
    tJ: Int32Array.from(tJ.a),
    tK: Int32Array.from(tK.a),
    tL: Int32Array.from(tL.a),
    tV: Float64Array.from(tV.a),
    tN: Int8Array.from(tN.a),
    tD: Int8Array.from(tD.a),
    improperCount: oC.a.length,
    oC: Int32Array.from(oC.a),
    oA: Int32Array.from(oA.a),
    oB: Int32Array.from(oB.a),
    oD: Int32Array.from(oD.a),
    oK: Float64Array.from(oK.a),
    vdw,
    nbClass,
    excl,
    pair14,
    soft13,
    cutoff: Math.max(1, 2 * maxVdw * FF_PARAMS.scaleRepel),
    typing,
  };
}
