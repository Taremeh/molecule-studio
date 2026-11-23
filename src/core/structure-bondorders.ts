/**
 * Bond-order perception for small molecules / ligands whose bonds are all single
 * (XYZ files, PDB HETATM ligands, distance-perceived bonds). OWNER: structure agent.
 *
 * Algorithm (per connected component of non-polymer, non-metal atoms):
 *  1. Free valence of every atom = typical valence − current degree, capped by its hybridisation
 *     as seen in the geometry (sp3 → 0, sp2 → 1, sp → 2; from bond angles / planarity).
 *     Components without any H are treated as "implicit hydrogen" structures (typical for PDB
 *     ligands): there the valence alone over-estimates free valence and the geometry cap is what
 *     keeps sp3 atoms single.
 *  2. Triple bonds: pairs of atoms with free valence ≥ 2 that are linear/terminal and short.
 *  3. Double bonds: greedy matching on candidate bonds (short enough to be double, both atoms
 *     with free valence). Atoms with a single remaining candidate are served first (C=O, C=N of
 *     rings); otherwise the most double-like bond (shortest relative to reference lengths) wins.
 *     Then Edmonds' blossom augmentation repairs atoms the greedy pass left unsatisfied
 *     (fused aromatic systems), finding a maximum matching that keeps all matched atoms matched.
 *  4. Nitro groups get the charge-separated form (N⁺(=O)O⁻). Where hydrogens are explicit (formats
 *     without charges, e.g. XYZ), a terminal O left single beside a C=O becomes carboxylate /
 *     carbonate O⁻ and a four-bonded N ammonium N⁺ (N-oxide N⁺–O⁻); implicit-H ligands (COOH vs
 *     COO⁻) and metal-bound carboxylates stay neutral.
 *  5. 6-membered rings whose atoms each have exactly one double bond, inside the ring or in an
 *     already aromatic fused ring, become aromatic (order 1.5). 5-rings keep their Kekulé form.
 * Protein / nucleic residues are not perceived this way; standard residues get template orders
 * (structure-templates.ts).
 */
import type { Atom, Bond, BondOrder, Molecule } from './types';
import { getTopology } from './molecule';
import { moleculePositions } from './structure-grid';
import { allowedValences, covalentRadius, isHydrogen, isMetal } from './structure-chem';
import { protonationCharges, templateBondOrders } from './structure-templates';

interface RefLengths {
  single: number;
  double: number;
  triple?: number;
}

/** Typical bond lengths (Å) by element pair (alphabetical key), from standard organic structures. */
const REF_LENGTHS: Record<string, RefLengths> = {
  'C-C': { single: 1.54, double: 1.34, triple: 1.2 },
  'C-N': { single: 1.47, double: 1.28, triple: 1.16 },
  'C-O': { single: 1.43, double: 1.21, triple: 1.13 },
  'C-S': { single: 1.82, double: 1.61 },
  'C-P': { single: 1.84, double: 1.67 },
  'C-Se': { single: 1.95, double: 1.77 },
  'N-N': { single: 1.45, double: 1.25, triple: 1.1 },
  'N-O': { single: 1.4, double: 1.21 },
  'N-P': { single: 1.7, double: 1.57 },
  'N-S': { single: 1.68, double: 1.54 },
  'O-O': { single: 1.48, double: 1.21 },
  'O-P': { single: 1.6, double: 1.48 },
  'O-S': { single: 1.58, double: 1.43 },
  'O-Se': { single: 1.75, double: 1.61 },
  'S-S': { single: 2.05, double: 1.89 },
  'P-S': { single: 2.1, double: 1.95 },
};

function refLengths(a: string, b: string): RefLengths {
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  const ref = REF_LENGTHS[key];
  if (ref) return ref;
  const s = covalentRadius(a) + covalentRadius(b);
  return { single: s, double: 0.87 * s, triple: 0.78 * s };
}

/** Max length (Å) for a bond to be considered double: halfway between double and single. */
function doubleThreshold(r: RefLengths): number {
  return r.double + 0.5 * (r.single - r.double);
}

function tripleThreshold(r: RefLengths): number {
  return r.triple === undefined ? -Infinity : r.triple + 0.5 * (r.double - r.triple);
}

/** Elements whose hybridisation can be read from geometry (no hypervalent states). */
const SECOND_ROW = new Set(['B', 'C', 'N', 'O']);
/** Elements that may expand their valence (S(VI), P(V), …) towards terminal O/S. */
const HYPERVALENT = new Set(['P', 'S', 'Se', 'As', 'Te', 'Cl', 'Br', 'I']);
/** Maximum component size for the blossom augmentation pass (greedy only beyond). */
const MAX_BLOSSOM_VERTICES = 50000;
const MAX_RING = 8;
/**
 * Largest length difference (Å) between the two C–O bonds of a carboxylate (delocalised: ≤ 0.03 in
 * crystal structures, 0 after minimisation) read as C(=O)O⁻ without hydrogens; acids differ by ≈ 0.1.
 */
const DELOCALISED_CO_SPREAD = 0.05;

export function assignBondOrders(mol: Molecule): Molecule {
  const n = mol.atoms.length;
  const bonds = mol.bonds;
  if (n === 0 || bonds.length === 0) return mol;
  const atoms = mol.atoms;
  const topo = getTopology(mol);
  const pos = moleculePositions(mol);

  // ---- eligibility ------------------------------------------------------------------------
  const elig = new Uint8Array(n);
  const metal = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = atoms[i];
    if (isMetal(a.element)) {
      metal[i] = 1;
      continue;
    }
    const ri = topo.atomResidue[i];
    const kind = ri >= 0 ? topo.residues[ri].kind : undefined;
    if (kind === 'protein' || kind === 'nucleic' || kind === 'water' || kind === 'ion') continue;
    if (allowedValences(a.element, a.charge ?? 0).length === 0) continue;
    elig[i] = 1;
  }

  const other = (bi: number, i: number) => {
    const b = bonds[bi];
    const ia = topo.idToIndex.get(b.a)!;
    return ia === i ? topo.idToIndex.get(b.b)! : ia;
  };

  // ---- components over eligible–eligible bonds; skip ones that already carry bond orders ----
  const comp = new Int32Array(n).fill(-1);
  const compSkip: boolean[] = [];
  const compHasH: boolean[] = [];
  const compAtoms: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (!elig[s] || comp[s] >= 0) continue;
    const c = compAtoms.length;
    const list = [s];
    comp[s] = c;
    let skip = false;
    let hasH = false;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      if (isHydrogen(atoms[i].element)) hasH = true;
      for (const bi of topo.atomBonds[i]) {
        const j = other(bi, i);
        if (metal[j]) continue;
        if (bonds[bi].order !== 1) skip = true;
        if (!elig[j] || comp[j] >= 0) continue;
        comp[j] = c;
        list.push(j);
      }
    }
    compAtoms.push(list);
    compSkip.push(skip || list.length < 2);
    compHasH.push(hasH);
  }
  const active = (i: number) => elig[i] === 1 && comp[i] >= 0 && !compSkip[comp[i]];
  // Standard amino acids / nucleotides get their orders from residue templates instead.
  const templated = templateBondOrders(mol);
  if (!compSkip.some((s) => !s) && templated.size === 0) return mol;

  // ---- per-atom neighbourhood (non-metal neighbours only; metal coordination is ignored) -----
  const nbr: number[][] = new Array(n);
  const nbrBond: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!active(i)) continue;
    nbr[i] = [];
    nbrBond[i] = [];
    for (const bi of topo.atomBonds[i]) {
      const j = other(bi, i);
      if (metal[j] || j === i) continue;
      nbr[i].push(j);
      nbrBond[i].push(bi);
    }
  }
  const bondLen = (bi: number) => {
    const b = bonds[bi];
    const i = topo.idToIndex.get(b.a)!;
    const j = topo.idToIndex.get(b.b)!;
    return dist(pos, i, j);
  };
  const ends = (bi: number): [number, number] => [topo.idToIndex.get(bonds[bi].a)!, topo.idToIndex.get(bonds[bi].b)!];
  const heavy = (i: number) => !isHydrogen(atoms[i].element);
  /** Bond usable for multiple-bond assignment: both ends active heavy atoms. */
  const usable = (bi: number) => {
    const [i, j] = ends(bi);
    return i !== j && active(i) && active(j) && heavy(i) && heavy(j);
  };

  // ---- rings (smallest ring through each usable bond, size ≤ 8) -----------------------------
  const rings = findRings(n, bonds.length, (i) => (active(i) && heavy(i) ? nbr[i] : null), nbrBond, usable, ends);
  const inPlanarSmallRing = new Uint8Array(n);
  for (const r of rings) {
    if (r.atoms.length <= 5 && ringPlanarity(pos, r.atoms) < 0.1) for (const i of r.atoms) inPlanarSmallRing[i] = 1;
  }

  // ---- free valences ------------------------------------------------------------------------
  const free = new Int32Array(n);
  const nitro = new Uint8Array(n);
  const isTerminalChalcogen = (j: number, bi: number, i: number) => {
    const ej = atoms[j].element;
    if ((ej !== 'O' && ej !== 'S' && ej !== 'Se') || !active(j) || nbr[j].length !== 1) return false;
    return bondLen(bi) <= doubleThreshold(refLengths(atoms[i].element, ej));
  };
  for (let i = 0; i < n; i++) {
    if (!active(i) || !heavy(i)) continue;
    const a = atoms[i];
    const deg = nbr[i].length;
    if (deg === 0) continue;
    const allowed = allowedValences(a.element, a.charge ?? 0);
    let need = deg;
    let terminalO = 0;
    for (let k = 0; k < deg; k++) if (isTerminalChalcogen(nbr[i][k], nbrBond[i][k], i)) terminalO++;
    if (HYPERVALENT.has(a.element) && allowed.length > 1) need = deg + terminalO;
    let target = allowed.find((v) => v >= need) ?? allowed[allowed.length - 1];
    if (a.element === 'N' && !a.charge && deg === 3 && terminalO >= 2) {
      // Nitro / nitrate: written as N⁺(=O)–O⁻.
      nitro[i] = 1;
      target = 4;
    }
    let f = Math.max(0, target - deg);
    f = Math.min(f, geometryLimit(pos, i, a.element, nbr[i], inPlanarSmallRing[i] === 1));
    free[i] = f;
  }

  const ord = new Float64Array(bonds.length);
  for (let bi = 0; bi < bonds.length; bi++) ord[bi] = bonds[bi].order;
  for (const [bi, o] of templated) ord[bi] = o;

  // ---- triple bonds ---------------------------------------------------------------------------
  const triples: { bi: number; score: number }[] = [];
  for (let bi = 0; bi < bonds.length; bi++) {
    if (!usable(bi)) continue;
    const [i, j] = ends(bi);
    if (free[i] < 2 || free[j] < 2 || nbr[i].length > 2 || nbr[j].length > 2) continue;
    const ref = refLengths(atoms[i].element, atoms[j].element);
    const d = bondLen(bi);
    if (ref.triple === undefined || d > tripleThreshold(ref)) continue;
    triples.push({ bi, score: (d - ref.triple) / (ref.double - ref.triple) });
  }
  triples.sort((p, q) => p.score - q.score);
  for (const { bi } of triples) {
    const [i, j] = ends(bi);
    if (free[i] < 2 || free[j] < 2) continue;
    ord[bi] = 3;
    free[i] -= 2;
    free[j] -= 2;
  }

  // ---- double bonds: greedy ---------------------------------------------------------------------
  const initFree = free.slice();
  const cBond: number[] = [];
  const cU: number[] = [];
  const cV: number[] = [];
  const cScore: number[] = [];
  const atomCands: number[][] = new Array(n);
  for (let bi = 0; bi < bonds.length; bi++) {
    if (ord[bi] !== 1 || !usable(bi)) continue;
    const [i, j] = ends(bi);
    if (free[i] < 1 || free[j] < 1) continue;
    const ref = refLengths(atoms[i].element, atoms[j].element);
    const d = bondLen(bi);
    if (d > doubleThreshold(ref)) continue;
    const c = cBond.length;
    cBond.push(bi);
    cU.push(i);
    cV.push(j);
    cScore.push((d - ref.double) / (ref.single - ref.double));
    (atomCands[i] ??= []).push(c);
    (atomCands[j] ??= []).push(c);
  }
  const nc = cBond.length;
  const live = new Uint8Array(nc).fill(1);
  const liveCount = new Int32Array(n);
  for (let c = 0; c < nc; c++) {
    liveCount[cU[c]]++;
    liveCount[cV[c]]++;
  }
  const queue: number[] = [];
  const kill = (c: number) => {
    if (!live[c]) return;
    live[c] = 0;
    liveCount[cU[c]]--;
    liveCount[cV[c]]--;
    queue.push(cU[c], cV[c]);
  };
  const take = (c: number) => {
    const i = cU[c];
    const j = cV[c];
    ord[cBond[c]] = 2;
    free[i]--;
    free[j]--;
    kill(c);
    for (const w of [i, j]) if (free[w] <= 0) for (const c2 of atomCands[w]) kill(c2);
  };
  // Atoms whose free valence must be satisfied. With explicit hydrogens that is every atom; in
  // implicit-H structures a non-terminal N/O/S may carry an H instead of a double bond, so only
  // carbons and terminal atoms (C=O, C=S, C=N:) are required to pair up.
  const mustMatch = (i: number) => compHasH[comp[i]] || atoms[i].element === 'C' || nbr[i].length === 1;
  const forced = (w: number) => free[w] >= 1 && liveCount[w] >= 1 && liveCount[w] <= free[w] && mustMatch(w);
  for (let i = 0; i < n; i++) if (atomCands[i]) queue.push(i);
  const sorted = Array.from({ length: nc }, (_, c) => c).sort((p, q) => cScore[p] - cScore[q]);
  let ptr = 0;
  for (;;) {
    while (queue.length) {
      const w = queue.pop()!;
      if (!forced(w)) continue;
      let best = -1;
      for (const c of atomCands[w]) if (live[c] && (best < 0 || cScore[c] < cScore[best])) best = c;
      if (best >= 0) {
        take(best);
        queue.push(w);
      }
    }
    while (ptr < nc && !live[sorted[ptr]]) ptr++;
    if (ptr >= nc) break;
    take(sorted[ptr]);
  }

  // ---- double bonds: blossom augmentation for atoms the greedy pass left unsatisfied -----------
  for (let c = 0; c < compAtoms.length; c++) {
    if (compSkip[c]) continue;
    augmentComponent(compAtoms[c]);
  }

  function augmentComponent(list: number[]) {
    // Vertices: atoms that entered the double-bond phase wanting exactly one double bond.
    const partner = (i: number): number => {
      // -1 exposed, -2 matched outside the vertex set (fixed), otherwise partner atom index.
      for (const c of atomCands[i] ?? []) if (ord[cBond[c]] === 2) return cU[c] === i ? cV[c] : cU[c];
      for (const bi of nbrBond[i]) if (ord[bi] === 2 || ord[bi] === 3) return -2;
      return -1;
    };
    const cand = list.filter((i) => initFree[i] === 1 && atomCands[i]?.length);
    const status = new Map<number, number>();
    for (const i of cand) status.set(i, partner(i));
    const verts: number[] = [];
    const local = new Map<number, number>();
    for (const i of cand) {
      const p = status.get(i)!;
      const ok = p >= 0 ? initFree[p] === 1 : p === -1 && mustMatch(i);
      if (ok) {
        local.set(i, verts.length);
        verts.push(i);
      }
    }
    if (verts.length < 2 || verts.length > MAX_BLOSSOM_VERTICES) return;
    const roots: number[] = [];
    const match = new Int32Array(verts.length).fill(-1);
    const adj: number[][] = verts.map(() => []);
    const edgeBond = new Map<number, number>();
    for (let v = 0; v < verts.length; v++) {
      const i = verts[v];
      for (const c of atomCands[i]) {
        const j = cU[c] === i ? cV[c] : cU[c];
        const w = local.get(j);
        if (w === undefined) continue;
        adj[v].push(w);
        edgeBond.set(v * verts.length + w, cBond[c]);
      }
      const p = status.get(i)!;
      if (p >= 0) match[v] = local.get(p) ?? -1;
      else roots.push(v);
    }
    if (roots.length === 0) return;
    const before = match.slice();
    augmentMatching(verts.length, adj, match, roots);
    for (let v = 0; v < verts.length; v++) {
      if (before[v] === match[v]) continue;
      if (before[v] >= 0) ord[edgeBond.get(v * verts.length + before[v])!] = 1;
    }
    for (let v = 0; v < verts.length; v++) if (match[v] >= 0) ord[edgeBond.get(v * verts.length + match[v])!] = 2;
  }

  // ---- nitro groups: N⁺(=O)O⁻ -----------------------------------------------------------------
  const newCharge = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (!nitro[i]) continue;
    if (!nbrBond[i].some((bi) => ord[bi] === 2)) continue;
    newCharge.set(i, 1);
    for (let k = 0; k < nbr[i].length; k++) {
      const j = nbr[i][k];
      if (atoms[j].element === 'O' && nbr[j].length === 1 && ord[nbrBond[i][k]] === 1 && !atoms[j].charge) newCharge.set(j, -1);
    }
  }

  // ---- charges of formats that store none (XYZ): carboxylate C(=O)O⁻, ammonium N⁺ ------------
  // Only where the hydrogens are known to be explicit (see explicitH): there a terminal O left
  // single next to a C=O carries no H, so it is a carboxylate / carbonate O⁻, and a four-bonded
  // N is an ammonium N⁺ (glycine zwitterion). With implicit hydrogens (PDB ligands) COOH and COO⁻
  // look the same, so they are left as they are.
  const terminalO = (j: number) => atoms[j].element === 'O' && active(j) && nbr[j].length === 1 && !atoms[j].charge;
  /**
   * O bonded to a metal (nbr leaves metals out): metal carboxylates / carbonates / N-oxides in the
   * covalent form of XYZ, CIF and MD files (Cu acetate, calcite, a Zn-bound ligand). An O⁻ there
   * without the metal's charge would give the neutral complex a wrong net charge; left as it is.
   */
  const metalBound = (j: number) => topo.atomBonds[j].some((bi) => metal[other(bi, j)] === 1);
  const terminalOMetal = (i: number) => nbr[i].some((j) => atoms[j].element === 'O' && nbr[j].length === 1 && metalBound(j));
  const compResidueless = new Int8Array(compAtoms.length).fill(-1);
  const compSaturated = new Int8Array(compAtoms.length).fill(-1);
  /**
   * Every atom of component c has a full valence with the orders assigned so far, terminal single
   * O (the possible O⁻ / OH) aside: an H-free component that needs no implicit hydrogens.
   */
  const saturated = (c: number) => {
    if (compSaturated[c] < 0) {
      compSaturated[c] = compAtoms[c].every((k) => {
        let sum = 0;
        for (const bi of nbrBond[k]) sum += ord[bi];
        if (atoms[k].element === 'O' && nbr[k].length === 1 && sum === 1) return true;
        return allowedValences(atoms[k].element, newCharge.get(k) ?? atoms[k].charge ?? 0).includes(sum);
      })
        ? 1
        : 0;
    }
    return compSaturated[c] === 1;
  };
  /**
   * Hydrogens of component c are explicit for a C–O⁻ candidate `excess` Å longer than its C=O:
   * the component has H atoms; or it has none and needs none (oxalate, carbonate: every other atom
   * saturated, unlike heavy-atom-only glycine or benzoate), no residue information (all-atom formats:
   * XYZ, crystal CIF; never PDB / mmCIF ligands) and a delocalised geometry, the C–O as short as
   * the C=O (a C–OH is ≈ 0.1 Å longer, so an acid stripped of its H is kept).
   */
  const explicitH = (c: number, excess: number) => {
    if (compHasH[c]) return true;
    if (Math.abs(excess) > DELOCALISED_CO_SPREAD) return false;
    if (compResidueless[c] < 0) compResidueless[c] = compAtoms[c].every((k) => topo.atomResidue[k] < 0) ? 1 : 0;
    return compResidueless[c] === 1 && saturated(c);
  };
  for (let i = 0; i < n; i++) {
    if (!active(i) || atoms[i].charge || newCharge.has(i)) continue;
    const el = atoms[i].element;
    if (el === 'N') {
      // Ammonium N⁺; an amine N-oxide's terminal O (no H here) is its O⁻. N→B adducts
      // (H₃N–BH₃) and metal-bound N-oxides are left as they are (their partner would need a charge too).
      if (nbr[i].length !== 4 || !compHasH[comp[i]] || !nbrBond[i].every((bi) => ord[bi] === 1)) continue;
      if (nbr[i].some((j) => atoms[j].element === 'B') || terminalOMetal(i)) continue;
      newCharge.set(i, 1);
      for (const j of nbr[i]) if (terminalO(j)) newCharge.set(j, -1);
      continue;
    }
    if (el !== 'C') continue;
    let carbonyl = -1;
    for (let k = 0; k < nbr[i].length; k++) if (ord[nbrBond[i][k]] === 2 && terminalO(nbr[i][k])) carbonyl = nbrBond[i][k];
    if (carbonyl < 0 || terminalOMetal(i)) continue;
    for (let k = 0; k < nbr[i].length; k++) {
      const j = nbr[i][k];
      const bi = nbrBond[i][k];
      if (ord[bi] === 1 && terminalO(j) && !newCharge.has(j) && explicitH(comp[i], bondLen(bi) - bondLen(carbonyl))) newCharge.set(j, -1);
    }
  }

  // ---- aromatic 6-rings ------------------------------------------------------------------------
  const doubleBondOf = new Int32Array(n).fill(-1);
  const multiCount = new Int32Array(n);
  for (let bi = 0; bi < bonds.length; bi++) {
    if (ord[bi] < 2) continue;
    const [i, j] = ends(bi);
    for (const w of [i, j]) {
      multiCount[w] += ord[bi] === 2 ? 1 : 2;
      doubleBondOf[w] = bi;
    }
  }
  const six = rings.filter((r) => r.atoms.length === 6 && r.atoms.every((i) => multiCount[i] === 1 && ord[doubleBondOf[i]] === 2));
  const aromatic = new Uint8Array(bonds.length);
  const done = new Uint8Array(six.length);
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = 0; k < six.length; k++) {
      if (done[k]) continue;
      const r = six[k];
      const ringBonds = new Set(r.bonds);
      if (!r.atoms.every((i) => ringBonds.has(doubleBondOf[i]) || aromatic[doubleBondOf[i]])) continue;
      done[k] = 1;
      changed = true;
      for (const bi of r.bonds) aromatic[bi] = 1;
    }
  }
  for (let bi = 0; bi < bonds.length; bi++) if (aromatic[bi]) ord[bi] = 1.5;

  // ---- protonation states of standard residues with explicit hydrogens -------------------------
  if (templated.size) for (const [i, c] of protonationCharges(mol, ord)) if (!newCharge.has(i)) newCharge.set(i, c);

  // ---- build the result ---------------------------------------------------------------------------
  let changedAny = false;
  const outBonds: Bond[] = bonds.map((b, bi) => {
    if (ord[bi] === b.order) return b;
    changedAny = true;
    return { ...b, order: ord[bi] as BondOrder };
  });
  let outAtoms: Atom[] = atoms;
  if (newCharge.size) {
    changedAny = true;
    outAtoms = atoms.map((a, i) => (newCharge.has(i) ? { ...a, charge: newCharge.get(i) } : a));
  }
  if (!changedAny) return mol;
  return { ...mol, atoms: outAtoms, bonds: outBonds };
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

function dist(p: Float64Array, i: number, j: number): number {
  const dx = p[3 * i] - p[3 * j];
  const dy = p[3 * i + 1] - p[3 * j + 1];
  const dz = p[3 * i + 2] - p[3 * j + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Angle j–i–k at atom i, degrees. */
function angleAt(p: Float64Array, i: number, j: number, k: number): number {
  const ax = p[3 * j] - p[3 * i], ay = p[3 * j + 1] - p[3 * i + 1], az = p[3 * j + 2] - p[3 * i + 2];
  const bx = p[3 * k] - p[3 * i], by = p[3 * k + 1] - p[3 * i + 1], bz = p[3 * k + 2] - p[3 * i + 2];
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (la === 0 || lb === 0) return 0;
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/**
 * Upper bound on the number of extra bond orders an atom can take, from its geometry
 * (second-row elements only; P/S/halogens can be hypervalent with tetrahedral geometry).
 *  - 4+ neighbours: sp3 → 0
 *  - 3 neighbours: planar (angle sum ≥ 345°) → 1, pyramidal → 0
 *  - 2 neighbours: linear (≥ 160°) → 2, ≥ 115° → 1, in a planar 3–5 ring → 1,
 *    N/O ≥ 104° → 1 (lone pairs compress sp2 angles; bond lengths decide), else 0
 *  - terminal: unrestricted (bond length decides)
 */
function geometryLimit(p: Float64Array, i: number, el: string, nb: number[], planarSmallRing: boolean): number {
  if (!SECOND_ROW.has(el)) return 3;
  const deg = nb.length;
  if (deg >= 4) return 0;
  if (deg === 3) {
    const sum = angleAt(p, i, nb[0], nb[1]) + angleAt(p, i, nb[0], nb[2]) + angleAt(p, i, nb[1], nb[2]);
    return sum >= 345 ? 1 : 0;
  }
  if (deg === 2) {
    const a = angleAt(p, i, nb[0], nb[1]);
    if (a >= 160) return 2;
    if (a >= 115 || planarSmallRing) return 1;
    if ((el === 'N' || el === 'O') && a >= 104) return 1;
    return 0;
  }
  return 3;
}

/** Max distance (Å) of ring atoms from their best plane (Newell normal through the centroid). */
function ringPlanarity(p: Float64Array, ring: number[]): number {
  let cx = 0, cy = 0, cz = 0;
  for (const i of ring) {
    cx += p[3 * i];
    cy += p[3 * i + 1];
    cz += p[3 * i + 2];
  }
  cx /= ring.length;
  cy /= ring.length;
  cz /= ring.length;
  let nx = 0, ny = 0, nz = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    nx += (p[3 * a + 1] - p[3 * b + 1]) * (p[3 * a + 2] + p[3 * b + 2]);
    ny += (p[3 * a + 2] - p[3 * b + 2]) * (p[3 * a] + p[3 * b]);
    nz += (p[3 * a] - p[3 * b]) * (p[3 * a + 1] + p[3 * b + 1]);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return 0;
  nx /= len;
  ny /= len;
  nz /= len;
  let max = 0;
  for (const i of ring) {
    const d = Math.abs((p[3 * i] - cx) * nx + (p[3 * i + 1] - cy) * ny + (p[3 * i + 2] - cz) * nz);
    if (d > max) max = d;
  }
  return max;
}

// ---------------------------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------------------------

export interface Ring {
  /** Atom indices in ring order. */
  atoms: number[];
  /** Bond indices, bonds[k] joins atoms[k] and atoms[k+1 mod size]. */
  bonds: number[];
}

/**
 * Smallest ring through every usable bond (BFS from one end to the other without that bond),
 * deduplicated. For ordinary fused/bridged organic ring systems this yields the SSSR-like set
 * of rings a chemist would draw.
 */
function findRings(
  n: number,
  nBonds: number,
  neighbours: (i: number) => number[] | null,
  nbrBond: number[][],
  usable: (bi: number) => boolean,
  ends: (bi: number) => [number, number],
): Ring[] {
  const prev = new Int32Array(n).fill(-1);
  const prevBond = new Int32Array(n).fill(-1);
  const depth = new Int32Array(n);
  const stamp = new Int32Array(n);
  let curStamp = 0;
  const seen = new Set<string>();
  const out: Ring[] = [];
  const queue: number[] = [];
  for (let bi = 0; bi < nBonds; bi++) {
    if (!usable(bi)) continue;
    const [s, t] = ends(bi);
    curStamp++;
    queue.length = 0;
    queue.push(s);
    stamp[s] = curStamp;
    depth[s] = 0;
    prev[s] = -1;
    let found = false;
    for (let qh = 0; qh < queue.length && !found; qh++) {
      const u = queue[qh];
      if (depth[u] >= MAX_RING - 1) break;
      const nb = neighbours(u);
      if (!nb) continue;
      for (let k = 0; k < nb.length; k++) {
        const w = nb[k];
        const wb = nbrBond[u][k];
        if (wb === bi || !usable(wb) || stamp[w] === curStamp) continue;
        stamp[w] = curStamp;
        prev[w] = u;
        prevBond[w] = wb;
        depth[w] = depth[u] + 1;
        if (w === t) {
          found = true;
          break;
        }
        queue.push(w);
      }
    }
    if (!found) continue;
    // Path t → s, then close with bond bi.
    const ringAtoms: number[] = [];
    const ringBonds: number[] = [];
    for (let v = t; v !== s; v = prev[v]) {
      ringAtoms.push(v);
      ringBonds.push(prevBond[v]);
    }
    ringAtoms.push(s);
    ringBonds.push(bi);
    const key = ringAtoms.slice().sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ atoms: ringAtoms, bonds: ringBonds });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Edmonds' blossom algorithm (maximum cardinality matching in general graphs)
// ---------------------------------------------------------------------------------------------

/**
 * Augments `match` (match[v] = partner or -1) by searching an augmenting path from each exposed
 * root. Matched vertices stay matched (possibly with new partners). Classic O(V³) formulation
 * with blossom contraction via base[] (cf. Edmonds 1965).
 */
export function augmentMatching(nv: number, adj: number[][], match: Int32Array, roots: number[]): void {
  const p = new Int32Array(nv);
  const base = new Int32Array(nv);
  const used = new Uint8Array(nv);
  const blossom = new Uint8Array(nv);
  const mark = new Int32Array(nv);
  let markStamp = 0;
  const q = new Int32Array(nv);

  const lca = (a0: number, b0: number): number => {
    markStamp++;
    let a = a0;
    for (;;) {
      a = base[a];
      mark[a] = markStamp;
      if (match[a] === -1) break;
      a = p[match[a]];
    }
    let b = b0;
    for (;;) {
      b = base[b];
      if (mark[b] === markStamp) return b;
      b = p[match[b]];
    }
  };
  const markPath = (v0: number, b: number, child0: number) => {
    let v = v0;
    let child = child0;
    while (base[v] !== b) {
      blossom[base[v]] = 1;
      blossom[base[match[v]]] = 1;
      p[v] = child;
      child = match[v];
      v = p[match[v]];
    }
  };
  const findPath = (root: number): number => {
    used.fill(0);
    p.fill(-1);
    for (let i = 0; i < nv; i++) base[i] = i;
    used[root] = 1;
    let qh = 0;
    let qt = 0;
    q[qt++] = root;
    while (qh < qt) {
      const v = q[qh++];
      for (const to of adj[v]) {
        if (base[v] === base[to] || match[v] === to) continue;
        if (to === root || (match[to] !== -1 && p[match[to]] !== -1)) {
          const cur = lca(v, to);
          blossom.fill(0);
          markPath(v, cur, to);
          markPath(to, cur, v);
          for (let i = 0; i < nv; i++) {
            if (blossom[base[i]]) {
              base[i] = cur;
              if (!used[i]) {
                used[i] = 1;
                q[qt++] = i;
              }
            }
          }
        } else if (p[to] === -1) {
          p[to] = v;
          if (match[to] === -1) return to;
          used[match[to]] = 1;
          q[qt++] = match[to];
        }
      }
    }
    return -1;
  };

  for (const root of roots) {
    if (match[root] !== -1) continue;
    let v = findPath(root);
    while (v !== -1) {
      const pv = p[v];
      const ppv = match[pv];
      match[v] = pv;
      match[pv] = v;
      v = ppv;
    }
  }
}
