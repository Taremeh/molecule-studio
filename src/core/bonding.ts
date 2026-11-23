/**
 * Bond perception from coordinates and bond-order heuristics.
 * OWNER: structure agent. CONTRACT: keep exported names & signatures.
 */
import type { Bond, Molecule } from './types';
import { getTopology } from './molecule';
import { SpatialGrid, moleculePositions } from './structure-grid';
import { covalentRadius, isHydrogen, isMetal } from './structure-chem';
import { assignBondOrders } from './structure-bondorders';

export interface PerceiveOptions {
  /** Added to the sum of covalent radii (default 0.45 Å). */
  tolerance?: number;
}

/** Default slack added to rcov(a) + rcov(b). */
export const BOND_TOLERANCE = 0.45;
/** Stricter slack for metals and ion residues (coordination bonds only when really close). */
export const METAL_BOND_TOLERANCE = 0.3;
/** Pairs closer than this are overlapping duplicates, not bonds. */
export const MIN_BOND_DISTANCE = 0.4;

/**
 * Alkali and alkaline-earth metals: as positively charged atoms without file bonds they are
 * monatomic cations whose contacts to anions are ionic, never covalent bonds. Be is left out: its
 * halides and oxide are covalent networks (BeF₂ glass, wurtzite BeO).
 */
const IONIC_CATIONS = new Set(['Li', 'Na', 'K', 'Rb', 'Cs', 'Fr', 'Mg', 'Ca', 'Sr', 'Ba', 'Ra']);

/**
 * Add distance-based bonds: d < rcov(a) + rcov(b) + tolerance and d > 0.4 Å.
 * - Keeps all existing bonds (e.g. from CONECT / SDF) and never duplicates them.
 * - Uses a uniform spatial grid (cell ≈ 2.5–3 Å) → O(n); must handle 100k+ atoms in well under a second.
 * - Skips pairs with different non-empty altLoc; skips bonds between different water residues;
 *   H forms at most one bond (keep the closest); metal/ion residues bond only when d < rcov sum + 0.3.
 * - Within protein/nucleic chains, residues are linked (C–N peptide, O3'–P) by distance as normal.
 * - Ionic contacts are not bonds: an alkali / alkaline-earth cation (positive formal charge, no
 *   file bonds, not in a residue with carbon but no file bonds — Na⁺ in rock salt, K⁺ in K₂SO₄,
 *   Mg²⁺ in MgO, but not the Mg of chlorophyll from an mmCIF) never bonds to a negatively charged
 *   atom in salts and lattices, i.e. structures without protein / nucleic residues. Crystal CIFs
 *   carry such charges in their type symbols (Na1+, Cl1-, O2-), so ionic lattices come out
 *   bond-less like the rock-salt SDF sample. In protein / nucleic structures only contacts between
 *   two monatomic ions (Na⁺…Cl⁻) are ionic; Ca²⁺ / Mg²⁺ / Na⁺ on a charged O⁻ of Asp / Glu, a
 *   phosphate or a ligand (Maestro-prepared PDBs, CCD charges) stay coordination bonds.
 *   Everything else is unaffected: covalent bonds inside polyatomic ions (N–O of nitrate, S–O of
 *   sulfate, N–H of ammonium, Si–F of SiF₆²⁻ even when written with oxidation states) and metal
 *   coordination (Zn–S of Cys, heme Fe–N, Zn²⁺–Cl⁻).
 * Returns a NEW molecule (unchanged if nothing was added).
 */
export function perceiveBonds(mol: Molecule, opts: PerceiveOptions = {}): Molecule {
  const atoms = mol.atoms;
  const n = atoms.length;
  if (n < 2) return mol;
  const tol = opts.tolerance ?? BOND_TOLERANCE;
  const strictTol = Math.min(tol, METAL_BOND_TOLERANCE);
  const topo = getTopology(mol);
  const pos = moleculePositions(mol);

  // ---- per-atom properties -------------------------------------------------------------
  const rad = new Float64Array(n);
  const isH = new Uint8Array(n);
  /** 1 = metal or member of an ion residue → strict tolerance. */
  const strict = new Uint8Array(n);
  /** residue index for water atoms, -1 otherwise. */
  const waterRes = new Int32Array(n).fill(-1);
  /** altLoc as a small integer (0 = none). */
  const alt = new Int32Array(n);
  /** Sign of the formal charge (−1, 0, 1). */
  const sign = new Int8Array(n);
  /** 1 = positively charged alkali / alkaline-earth atom (monatomic cation once it has no file bonds). */
  const hardCation = new Uint8Array(n);
  let anyIonic = false;
  /**
   * Residue index → contains carbon and the file gives none of its atoms a bond (mmCIF, PDB without
   * CONECT). An alkali / alkaline-earth atom in such a residue may belong to an organometallic /
   * coordination compound (Mg of chlorophyll, written Mg²⁺ / N⁻ by some dictionaries and preparation
   * tools), so it is not taken for a free ion. Carbon-free residues (the rock salt exported to PDB as
   * one UNL residue) stay lattices; when the file bonds the residue but not the cation (a sodium salt
   * exported to PDB with CONECT), the cation is free.
   */
  const residueOpenOrganic = new Map<number, boolean>();
  const inOpenOrganicResidue = (ri: number): boolean => {
    if (ri < 0) return false;
    let c = residueOpenOrganic.get(ri);
    if (c === undefined) {
      const idx = topo.residues[ri].atomIndices;
      c = idx.some((k) => atoms[k].element === 'C') && idx.every((k) => topo.atomBonds[k].length === 0);
      residueOpenOrganic.set(ri, c);
    }
    return c;
  };
  /** Residue index → it has exactly one heavy atom (lazily computed). */
  const residueSingleHeavy = new Map<number, boolean>();
  /**
   * A free monatomic ion: no file bonds and in an ion residue (NA, CL, CAL…), or the only heavy atom
   * of another non-water residue (AMBER 'Na+', 'Cl-'), or without residue information.
   */
  const monatomicIon = (k: number): boolean => {
    if (topo.atomBonds[k].length) return false;
    const ri = topo.atomResidue[k];
    if (ri < 0) return true;
    const res = topo.residues[ri];
    if (res.kind === 'ion') return true;
    if (res.kind === 'water') return false;
    let single = residueSingleHeavy.get(ri);
    if (single === undefined) {
      single = res.atomIndices.filter((m) => !isHydrogen(atoms[m].element)).length === 1;
      residueSingleHeavy.set(ri, single);
    }
    return single;
  };
  const altCodes = new Map<string, number>();
  const radiusCache = new Map<string, number>();
  let maxRNormal = 0;
  let maxRAll = 0;
  const strictList: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = atoms[i];
    let r = radiusCache.get(a.element);
    if (r === undefined) {
      r = covalentRadius(a.element);
      radiusCache.set(a.element, r);
    }
    rad[i] = r;
    if (isHydrogen(a.element)) isH[i] = 1;
    const ri = topo.atomResidue[i];
    const kind = ri >= 0 ? topo.residues[ri].kind : undefined;
    if (kind === 'water') waterRes[i] = ri;
    if (isMetal(a.element) || kind === 'ion') {
      strict[i] = 1;
      strictList.push(i);
    } else if (r > maxRNormal) maxRNormal = r;
    if (r > maxRAll) maxRAll = r;
    const q = a.charge ?? 0;
    if (q) {
      sign[i] = q > 0 ? 1 : -1;
      if (q > 0 && IONIC_CATIONS.has(a.element) && !inOpenOrganicResidue(ri)) {
        hardCation[i] = 1;
        anyIonic = true;
      }
    }
    const al = a.altLoc?.trim();
    if (al) {
      let code = altCodes.get(al);
      if (code === undefined) {
        code = altCodes.size + 1;
        altCodes.set(al, code);
      }
      alt[i] = code;
    }
  }

  /**
   * Ionic contacts in structures with protein / nucleic residues are only those between monatomic
   * ions (Na⁺…Cl⁻): Ca²⁺ / Mg²⁺ / Na⁺ on an O⁻ of Asp / Glu, of a phosphate or of a ligand
   * (charges from preparation tools or the CCD) is metal coordination, as in files without charges.
   */
  const polymer = anyIonic && topo.residues.some((r) => r.kind === 'protein' || r.kind === 'nucleic');
  const ionic = (c: number, an: number) => hardCation[c] === 1 && sign[an] < 0 && (!polymer || (monatomicIon(c) && monatomicIon(an)));

  // ---- existing bonds -------------------------------------------------------------------
  const pairKey = (i: number, j: number) => (i < j ? i * n + j : j * n + i);
  const existing = new Set<number>();
  /** H atoms that already have a bond: they get no further bonds. */
  const hDone = new Uint8Array(n);
  for (const b of mol.bonds) {
    const ia = topo.idToIndex.get(b.a);
    const ib = topo.idToIndex.get(b.b);
    if (ia === undefined || ib === undefined) continue;
    existing.add(pairKey(ia, ib));
    if (isH[ia]) hDone[ia] = 1;
    if (isH[ib]) hDone[ib] = 1;
    // A cation the file bonds explicitly is part of a molecule, not a free ion.
    hardCation[ia] = 0;
    hardCation[ib] = 0;
  }

  // ---- candidate search -------------------------------------------------------------------
  const minD2 = MIN_BOND_DISTANCE * MIN_BOND_DISTANCE;
  /** New heavy–heavy pairs (flat i, j). */
  const pairs: number[] = [];
  /** For each H: best partner so far (heavy atoms preferred over H, then shortest). */
  const hBest = new Int32Array(n).fill(-1);
  const hBestD2 = new Float64Array(n);
  const hBestHeavy = new Uint8Array(n);

  const offerH = (h: number, p: number, d2: number) => {
    if (hDone[h]) return;
    const heavy = isH[p] ? 0 : 1;
    const cur = hBest[h];
    if (cur < 0 || heavy > hBestHeavy[h] || (heavy === hBestHeavy[h] && d2 < hBestD2[h])) {
      hBest[h] = p;
      hBestD2[h] = d2;
      hBestHeavy[h] = heavy;
    }
  };

  const consider = (i: number, j: number, d2: number, slack: number) => {
    if (d2 < minD2) return;
    const cut = rad[i] + rad[j] + slack;
    if (d2 >= cut * cut) return;
    if (alt[i] && alt[j] && alt[i] !== alt[j]) return;
    if (waterRes[i] >= 0 && waterRes[j] >= 0 && waterRes[i] !== waterRes[j]) return;
    if (anyIonic && (ionic(i, j) || ionic(j, i))) return;
    if (existing.has(pairKey(i, j))) return;
    if (isH[i] || isH[j]) {
      if (isH[i]) offerH(i, j, d2);
      if (isH[j]) offerH(j, i, d2);
      return;
    }
    pairs.push(i, j);
  };

  const grid = new SpatialGrid(pos, Math.min(Math.max(2 * maxRNormal + tol, 1.5), 3.2));

  // Phase A: pairs of "normal" atoms (each pair visited from its lower index).
  let curI = 0;
  let curSlack = tol;
  const visitNormal = (j: number, d2: number) => {
    if (j > curI && !strict[j]) consider(curI, j, d2, curSlack);
  };
  for (let i = 0; i < n; i++) {
    if (strict[i]) continue;
    curI = i;
    curSlack = tol;
    grid.forEachWithin(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], rad[i] + maxRNormal + tol, visitNormal);
  }
  // Phase B: pairs involving a metal / ion atom, searched from the strict atom with the strict slack.
  const visitStrict = (j: number, d2: number) => {
    if (j === curI || (strict[j] && j < curI)) return;
    consider(curI, j, d2, curSlack);
  };
  for (const i of strictList) {
    curI = i;
    curSlack = strictTol;
    grid.forEachWithin(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], rad[i] + maxRAll + strictTol, visitStrict);
  }

  // ---- hydrogens: one bond each, to the closest partner (H–H only if mutual, e.g. H₂) -----
  for (let h = 0; h < n; h++) {
    const p = hBest[h];
    if (p < 0 || hDone[h]) continue;
    if (isH[p]) {
      if (hBest[p] !== h || hDone[p] || p < h) continue;
      hDone[p] = 1;
    }
    hDone[h] = 1;
    pairs.push(h, p);
  }

  if (pairs.length === 0) return mol;

  // Deterministic output order (by lower atom index, then higher).
  const order: number[] = [];
  for (let k = 0; k < pairs.length; k += 2) {
    if (pairs[k] > pairs[k + 1]) {
      const t = pairs[k];
      pairs[k] = pairs[k + 1];
      pairs[k + 1] = t;
    }
    order.push(k);
  }
  order.sort((p, q) => pairs[p] - pairs[q] || pairs[p + 1] - pairs[q + 1]);

  let nextBondId = mol.nextBondId;
  const bonds: Bond[] = mol.bonds.slice();
  for (const k of order) {
    bonds.push({ id: nextBondId++, a: atoms[pairs[k]].id, b: atoms[pairs[k + 1]].id, order: 1 });
  }
  return { ...mol, bonds, nextBondId };
}

/**
 * Assign double/triple/aromatic bond orders for small molecules that only have single bonds
 * (XYZ files, PDB ligands): use bond lengths + valence saturation (e.g. a greedy/Kekulé assignment
 * maximising satisfied valences, then mark 6-rings with alternating orders as aromatic 1.5).
 * Only applies to atoms not in protein/nucleic residues. Returns a NEW molecule.
 *
 * Standard protein / nucleic residues are never perceived from geometry, but receive the orders of
 * their residue template (backbone C=O, ASP/GLU/ASN/GLN C=O, ARG CZ=NH2, aromatic PHE/TYR/TRP
 * rings, HIS, nucleobases, phosphate P=OP1) when all their bonds are single. Components / residues
 * that already carry non-single bonds are left as they are. Nitro groups are written N⁺(=O)O⁻
 * (formal charges set); with explicit hydrogens, carboxylates C(=O)O⁻ and ammonium N⁺ get their
 * charges too (XYZ stores none). Returns the input object when nothing changes.
 * See structure-bondorders.ts for the algorithm.
 */
export function perceiveBondOrders(mol: Molecule): Molecule {
  return assignBondOrders(mol);
}
