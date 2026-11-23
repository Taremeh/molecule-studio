/**
 * Molecule construction helpers and cached topology.
 * Owned by the core (integration) layer — other modules import from here.
 */
import type { Atom, Bond, BondOrder, Chain, Molecule, MoleculeMeta, Residue, ResidueKind, Topology, Vec3 } from './types';

// ---------------------------------------------------------------------------
// Residue classification tables
// ---------------------------------------------------------------------------

export const AMINO_ACIDS: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  // common variants / protonation states / modified residues
  MSE: 'M', SEC: 'U', PYL: 'O', HSD: 'H', HSE: 'H', HSP: 'H', HID: 'H', HIE: 'H', HIP: 'H', CYX: 'C',
  CYM: 'C', ASH: 'D', GLH: 'E', LYN: 'K', ARN: 'R', TYM: 'Y', SEP: 'S', TPO: 'T', PTR: 'Y', HYP: 'P',
  MLY: 'K', CSO: 'C', KCX: 'K', UNK: 'X', ACE: 'X', NME: 'X', NH2: 'X',
};

export const NUCLEIC_ACIDS: Record<string, string> = {
  A: 'A', C: 'C', G: 'G', U: 'U', T: 'T', I: 'I', N: 'N',
  DA: 'A', DC: 'C', DG: 'G', DT: 'T', DU: 'U', DI: 'I',
  ADE: 'A', CYT: 'C', GUA: 'G', THY: 'T', URA: 'U',
  RA: 'A', RC: 'C', RG: 'G', RU: 'U', RA5: 'A', RA3: 'A', RC5: 'C', RC3: 'C', RG5: 'G', RG3: 'G', RU5: 'U', RU3: 'U',
  DA5: 'A', DA3: 'A', DC5: 'C', DC3: 'C', DG5: 'G', DG3: 'G', DT5: 'T', DT3: 'T',
  PSU: 'U', '5MC': 'C', '1MA': 'A', '2MG': 'G', M2G: 'G', OMC: 'C', OMG: 'G', H2U: 'U', '7MG': 'G',
};

export const WATER_NAMES = new Set(['HOH', 'WAT', 'H2O', 'DOD', 'TIP', 'TIP3', 'TIP4', 'TIP5', 'SOL', 'SPC', 'T3P', 'T4P', 'OH2']);

/**
 * Residue names of monatomic ions (PDB / CCD codes and the CHARMM names SOD, POT, CLA, CAL, CD2,
 * CES, LIT, RUB, BAR). Some are also names of molecules (CLA is the CCD code of chlorophyll a), so
 * computeTopology only keeps such a residue as an 'ion' when it holds a single heavy element (see
 * isMonatomicIonResidue).
 */
export const ION_NAMES = new Set([
  'NA', 'CL', 'K', 'MG', 'CA', 'ZN', 'FE', 'FE2', 'MN', 'CU', 'CU1', 'CO', 'NI', 'CD', 'HG', 'IOD', 'BR', 'F',
  'LI', 'RB', 'CS', 'SR', 'BA', 'AL', 'PB', 'AG', 'AU', 'PT', 'SOD', 'CLA', 'POT', 'CAL', 'MG2', 'ZN2', 'YB', 'GD',
  'CD2', 'CES', 'LIT', 'RUB', 'BAR',
]);

/**
 * Kind of a residue from its name. An ION_NAMES name gives 'ion'; getTopology then demotes the
 * residue to 'ligand' when its atoms are not a monatomic ion (chlorophyll a, CCD code CLA).
 */
export function classifyResidue(resName: string, hetero: boolean | undefined): ResidueKind {
  const r = resName.toUpperCase();
  if (WATER_NAMES.has(r)) return 'water';
  if (ION_NAMES.has(r)) return 'ion';
  return classifyNonIon(r, resName, hetero);
}

function classifyNonIon(r: string, resName: string, hetero: boolean | undefined): ResidueKind {
  if (r in AMINO_ACIDS && r !== 'UNK' && r !== 'ACE' && r !== 'NME' && r !== 'NH2') return 'protein';
  if (r in NUCLEIC_ACIDS) return 'nucleic';
  if (r === 'UNK' || r === 'ACE' || r === 'NME' || r === 'NH2') return hetero ? 'ligand' : 'protein';
  return hetero ? 'ligand' : resName ? 'ligand' : 'other';
}

/**
 * True when the residue's heavy atoms are all of one element other than carbon: a single ion, or
 * copies of it that a file puts in one residue (alternate locations, repeated residue numbers).
 * Hydrogens are ignored.
 */
function isMonatomicIonResidue(atoms: readonly Atom[], indices: readonly number[]): boolean {
  let element: string | undefined;
  for (const k of indices) {
    const e = atoms[k].element;
    if (e === 'H' || e === 'D' || e === 'T') continue;
    if (e === 'C' || (element !== undefined && e !== element)) return false;
    element = e;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createMolecule(name = 'Untitled', meta: MoleculeMeta = {}): Molecule {
  return { name, atoms: [], bonds: [], nextAtomId: 1, nextBondId: 1, meta: { ...meta } };
}

/** Input shape for buildMolecule: atoms without ids, bonds referencing atom array indices. */
export interface AtomInput extends Omit<Atom, 'id'> {}
export interface BondInput {
  /** index into the atoms array */
  a: number;
  /** index into the atoms array */
  b: number;
  order?: BondOrder;
}

/**
 * Build a molecule from parsed atoms (no ids) and bonds that reference atom ARRAY INDICES.
 * Assigns ids 1..n to atoms and 1..m to bonds. Duplicate / self bonds are dropped.
 */
export function buildMolecule(name: string, atoms: AtomInput[], bonds: BondInput[] = [], meta: MoleculeMeta = {}): Molecule {
  const outAtoms: Atom[] = atoms.map((a, i) => ({ ...a, id: i + 1 }));
  const seen = new Set<string>();
  const outBonds: Bond[] = [];
  for (const b of bonds) {
    if (b.a === b.b || b.a < 0 || b.b < 0 || b.a >= atoms.length || b.b >= atoms.length) continue;
    const lo = Math.min(b.a, b.b);
    const hi = Math.max(b.a, b.b);
    const key = lo + ':' + hi;
    if (seen.has(key)) continue;
    seen.add(key);
    outBonds.push({ id: outBonds.length + 1, a: lo + 1, b: hi + 1, order: b.order ?? 1 });
  }
  return {
    name,
    atoms: outAtoms,
    bonds: outBonds,
    nextAtomId: outAtoms.length + 1,
    nextBondId: outBonds.length + 1,
    meta: { ...meta },
  };
}

/** Shallow structural copy (new arrays, same atom/bond objects). */
export function cloneMolecule(mol: Molecule): Molecule {
  return { ...mol, atoms: mol.atoms.slice(), bonds: mol.bonds.slice(), meta: { ...mol.meta } };
}

/** Deep copy (new atom and bond objects). */
export function deepCloneMolecule(mol: Molecule): Molecule {
  return {
    ...mol,
    atoms: mol.atoms.map((a) => ({ ...a })),
    bonds: mol.bonds.map((b) => ({ ...b })),
    meta: { ...mol.meta },
  };
}

// ---------------------------------------------------------------------------
// Structure identity across coordinate-only updates
// ---------------------------------------------------------------------------
//
// Drags, sliders and the minimiser produce a new Molecule object every frame that differs from the
// previous one only in atom coordinates. Data that does not depend on coordinates (topology, valence,
// selection index…) is therefore cached per *structure*: every molecule gets a `structureKey`, which
// is shared by molecules whose atoms (ids, order and every non-coordinate field) and bonds are equal.
// A new molecule is compared against a few remembered molecules: the two most recently used ones
// (typically the store's molecule and the drag base), then structures sharing its bonds array (edit
// ops that only move atoms keep it), then the most recently keyed structures. The comparison is
// exact, O(atoms + bonds), and mostly identity checks because edit ops reuse the Atom objects they do
// not move. Anything else gets a new key, i.e. a full recompute, as with plain per-object caching.

/**
 * Every Atom field except the coordinates. Molecules share a structureKey only if all of these are
 * equal for every atom (index by index), so any cache keyed by structure may depend on any of them.
 * The type check below fails to compile when Atom gains a field that is missing here.
 */
export const ATOM_STRUCTURE_FIELDS = [
  'id', 'element', 'name', 'resName', 'resSeq', 'iCode', 'chain', 'hetero', 'charge', 'bfactor', 'occupancy',
  'altLoc', 'serial', 'ss',
] as const satisfies readonly (keyof Atom)[];
/** Every Bond field (all of them are compared). */
export const BOND_STRUCTURE_FIELDS = ['id', 'a', 'b', 'order'] as const satisfies readonly (keyof Bond)[];

type MissingAtomField = Exclude<keyof Atom, 'x' | 'y' | 'z' | (typeof ATOM_STRUCTURE_FIELDS)[number]>;
type MissingBondField = Exclude<keyof Bond, (typeof BOND_STRUCTURE_FIELDS)[number]>;
// Compile-time completeness checks: a missing field turns `true` into a type error naming the field.
const atomFieldsComplete: [MissingAtomField] extends [never] ? true : MissingAtomField = true;
const bondFieldsComplete: [MissingBondField] extends [never] ? true : MissingBondField = true;
void atomFieldsComplete;
void bondFieldsComplete;

/** `!==` for optional numbers, except that NaN equals NaN (a NaN field must not defeat the cache). */
function differ(p: number | undefined, q: number | undefined): boolean {
  return p !== q && (p === p || q === q);
}

/** Atoms equal index by index in every field but x/y/z (hand-unrolled ATOM_STRUCTURE_FIELDS). */
function sameAtomsIgnoringCoordinates(a: readonly Atom[], b: readonly Atom[]): boolean {
  if (a === b) return true;
  const n = a.length;
  if (n !== b.length) return false;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (
      x.id !== y.id ||
      x.element !== y.element ||
      x.name !== y.name ||
      x.resName !== y.resName ||
      differ(x.resSeq, y.resSeq) ||
      x.iCode !== y.iCode ||
      x.chain !== y.chain ||
      x.hetero !== y.hetero ||
      differ(x.charge, y.charge) ||
      differ(x.bfactor, y.bfactor) ||
      differ(x.occupancy, y.occupancy) ||
      x.altLoc !== y.altLoc ||
      differ(x.serial, y.serial) ||
      x.ss !== y.ss
    ) {
      return false;
    }
  }
  return true;
}

function sameBonds(a: readonly Bond[], b: readonly Bond[]): boolean {
  if (a === b) return true;
  const m = a.length;
  if (m !== b.length) return false;
  for (let i = 0; i < m; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x.id !== y.id || x.a !== y.a || x.b !== y.b || x.order !== y.order) return false;
  }
  return true;
}

/**
 * True if the molecules differ at most in atom coordinates: same atoms in the same order with equal
 * non-coordinate fields (ATOM_STRUCTURE_FIELDS) and equal bonds (same order, ids, endpoints, orders).
 * Molecule-level fields (name, meta, nextAtomId…) are not compared.
 */
export function sameStructure(a: Molecule, b: Molecule): boolean {
  if (a === b) return true;
  if (a.atoms.length !== b.atoms.length || a.bonds.length !== b.bonds.length) return false;
  return sameBonds(a.bonds, b.bonds) && sameAtomsIgnoringCoordinates(a.atoms, b.atoms);
}

/** Opaque identity of a molecule's structure (see structureKey). Use only as a cache key. */
export interface StructureKey {
  readonly __structureKey: true;
}

/**
 * A structure with up to two (weakly held) member molecules to compare new molecules against.
 * It holds nothing strongly, not even its key (read from a live member via structureKeys), so the
 * data cached for a structure dies with the last molecule of that structure.
 */
interface StructureEntry {
  /** The oldest member still alive (kept while alive: often the drag base / undo snapshot). */
  anchor: WeakRef<Molecule>;
  /** The most recently matched member. */
  latest: WeakRef<Molecule>;
}

const structureKeys = new WeakMap<Molecule, StructureKey>();
const entryOfKey = new WeakMap<StructureKey, StructureEntry>();
/** Most recently keyed / matched structures, newest first. */
const recentStructures: StructureEntry[] = [];
const MAX_RECENT_STRUCTURES = 4;
/** Structures by bonds array: coordinate-only edits keep the bonds array, so this finds the parent in O(1). */
const structuresByBonds = new WeakMap<readonly Bond[], StructureEntry[]>();
const MAX_STRUCTURES_PER_BONDS = 4;

/**
 * The molecule most recently passed to a structure cache (held strongly: it is the one in use, nearly
 * always the store's current molecule; this is the only molecule the structure caches keep alive) and
 * the one before it (held weakly). New molecules are usually derived from one of them, e.g. a drag
 * frame from the drag base. Alternating between the two swaps their WeakRefs (no allocation on the
 * cache fast path).
 */
let usedNow: Molecule | null = null;
let usedNowRef: WeakRef<Molecule> | null = null;
let usedBefore: WeakRef<Molecule> | null = null;

function noteUse(mol: Molecule): void {
  if (mol === usedNow) return;
  if (usedBefore?.deref() === mol) {
    const ref = usedBefore;
    usedBefore = usedNowRef;
    usedNowRef = ref;
  } else {
    usedBefore = usedNowRef;
    usedNowRef = new WeakRef(mol);
  }
  usedNow = mol;
}

function touch(list: StructureEntry[], entry: StructureEntry, max: number): void {
  const at = list.indexOf(entry);
  if (at === 0) return;
  if (at > 0) list.splice(at, 1);
  list.unshift(entry);
  if (list.length > max) list.length = max;
}

/** The live member of `entry` with the same structure as `mol`, null if none ('dead': no member is alive). */
function matchEntry(entry: StructureEntry, mol: Molecule): Molecule | null | 'dead' {
  const latest = entry.latest.deref();
  const anchor = entry.anchor.deref();
  if (!latest && !anchor) return 'dead';
  if (!anchor) entry.anchor = entry.latest;
  if (latest && sameStructure(latest, mol)) return latest;
  return anchor && anchor !== latest && sameStructure(anchor, mol) ? anchor : null;
}

/** First entry of `list` (not in `tried`) matching `mol`, with the matching member; drops dead entries. */
function findEntry(
  list: StructureEntry[],
  mol: Molecule,
  tried: Set<StructureEntry>,
): { entry: StructureEntry; member: Molecule } | undefined {
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (tried.has(entry)) continue;
    tried.add(entry);
    const m = matchEntry(entry, mol);
    if (m === 'dead') list.splice(i--, 1);
    else if (m) return { entry, member: m };
  }
  return undefined;
}

/**
 * Key shared by all molecules with the same structure (sameStructure), e.g. the frames of a drag.
 * Exact: two molecules get the same key only if sameStructure() holds for them. Molecules whose
 * structure was not seen recently get a fresh key (a cache miss, never a wrong hit).
 */
export function structureKey(mol: Molecule): StructureKey {
  const known = structureKeys.get(mol);
  if (known) {
    noteUse(mol);
    return known;
  }
  const tried = new Set<StructureEntry>();
  let found: StructureEntry | undefined;
  let key: StructureKey | undefined;
  for (const prev of [usedNow, usedBefore?.deref()]) {
    const k = prev && structureKeys.get(prev);
    const entry = k && entryOfKey.get(k);
    if (!entry || tried.has(entry)) continue;
    tried.add(entry);
    if (sameStructure(prev, mol)) {
      found = entry;
      key = k;
      break;
    }
  }
  const byBonds = structuresByBonds.get(mol.bonds);
  if (!found) {
    const hit = (byBonds && findEntry(byBonds, mol, tried)) || findEntry(recentStructures, mol, tried);
    if (hit) {
      found = hit.entry;
      key = structureKeys.get(hit.member);
    }
  }
  const ref = new WeakRef(mol);
  if (found && key) {
    found.latest = ref;
    if (!found.anchor.deref()) found.anchor = ref;
  } else {
    key = Object.freeze({}) as StructureKey;
    found = { anchor: ref, latest: ref };
    entryOfKey.set(key, found);
  }
  touch(recentStructures, found, MAX_RECENT_STRUCTURES);
  if (byBonds) touch(byBonds, found, MAX_STRUCTURES_PER_BONDS);
  else structuresByBonds.set(mol.bonds, [found]);
  structureKeys.set(mol, key);
  noteUse(mol);
  return key;
}

/**
 * Cache for data derived from a molecule's structure but NOT from its coordinates: the value is
 * computed once per structureKey and shared by every molecule with that structure (coordinate-only
 * updates hit). `compute` must not read x/y/z, nor molecule-level fields (name, meta, nextAtomId…,
 * which sameStructure does not compare), and must not return undefined.
 */
export function createStructureCache<T>(compute: (mol: Molecule) => T): (mol: Molecule) => T {
  const byMolecule = new WeakMap<Molecule, T>();
  const byKey = new WeakMap<StructureKey, T>();
  return (mol) => {
    let value = byMolecule.get(mol);
    if (value !== undefined) {
      if (mol !== usedNow) noteUse(mol);
      return value;
    }
    const key = structureKey(mol);
    value = byKey.get(key);
    if (value === undefined) {
      value = compute(mol);
      byKey.set(key, value);
    }
    byMolecule.set(mol, value);
    return value;
  };
}

// ---------------------------------------------------------------------------
// Topology (cached per structure: shared across coordinate-only updates)
// ---------------------------------------------------------------------------

const topologyOf = createStructureCache(computeTopology);

/**
 * Bonds, residues and chains of a molecule. Cached; the same Topology object is returned for every
 * molecule with the same structure (see structureKey), e.g. all frames of a drag. Do not mutate.
 */
export function getTopology(mol: Molecule): Topology {
  return topologyOf(mol);
}

function computeTopology(mol: Molecule): Topology {
  const n = mol.atoms.length;
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) idToIndex.set(mol.atoms[i].id, i);

  const neighbors: number[][] = new Array(n);
  const atomBonds: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    neighbors[i] = [];
    atomBonds[i] = [];
  }
  const bondIdToIndex = new Map<number, number>();
  for (let bi = 0; bi < mol.bonds.length; bi++) {
    const b = mol.bonds[bi];
    bondIdToIndex.set(b.id, bi);
    const ia = idToIndex.get(b.a);
    const ib = idToIndex.get(b.b);
    if (ia === undefined || ib === undefined) continue;
    neighbors[ia].push(ib);
    neighbors[ib].push(ia);
    atomBonds[ia].push(bi);
    atomBonds[ib].push(bi);
  }

  // Residues: consecutive atoms sharing chain/resSeq/iCode/resName form a residue.
  const residues: Residue[] = [];
  const atomResidue = new Int32Array(n).fill(-1);
  const chainMap = new Map<string, Chain>();
  const chains: Chain[] = [];
  const residueByKey = new Map<string, Residue>();
  for (let i = 0; i < n; i++) {
    const a = mol.atoms[i];
    if (a.resName === undefined && a.resSeq === undefined) continue;
    const chain = a.chain ?? '';
    const resSeq = a.resSeq ?? 0;
    const iCode = a.iCode ?? '';
    const resName = (a.resName ?? 'UNK').toUpperCase();
    const key = `${chain}:${resSeq}${iCode}:${resName}`;
    let res = residueByKey.get(key);
    if (!res) {
      const kind = classifyResidue(resName, a.hetero);
      res = {
        index: residues.length,
        key,
        chain,
        resSeq,
        iCode,
        resName,
        kind,
        atomIndices: [],
        oneLetter: kind === 'protein' ? AMINO_ACIDS[resName] ?? 'X' : kind === 'nucleic' ? NUCLEIC_ACIDS[resName] ?? 'N' : '',
      };
      residues.push(res);
      residueByKey.set(key, res);
      let ch = chainMap.get(chain);
      if (!ch) {
        ch = { id: chain, residueIndices: [] };
        chainMap.set(chain, ch);
        chains.push(ch);
      }
      ch.residueIndices.push(res.index);
    }
    res.atomIndices.push(i);
    atomResidue[i] = res.index;
    if (res.kind === 'protein' && a.ss && (res.ss === undefined || a.name === 'CA')) res.ss = a.ss;
  }
  // A residue named like an ion that holds a molecule (chlorophyll a as CLA) is not an ion.
  for (const res of residues) {
    if (res.kind !== 'ion' || isMonatomicIonResidue(mol.atoms, res.atomIndices)) continue;
    res.kind = classifyNonIon(res.resName, res.resName, mol.atoms[res.atomIndices[0]].hetero);
  }

  return { idToIndex, neighbors, atomBonds, bondIdToIndex, residues, atomResidue, chains };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function atomById(mol: Molecule, id: number): Atom | undefined {
  const idx = getTopology(mol).idToIndex.get(id);
  return idx === undefined ? undefined : mol.atoms[idx];
}

export function atomIndex(mol: Molecule, id: number): number {
  return getTopology(mol).idToIndex.get(id) ?? -1;
}

export function bondById(mol: Molecule, id: number): Bond | undefined {
  const idx = getTopology(mol).bondIdToIndex.get(id);
  return idx === undefined ? undefined : mol.bonds[idx];
}

/** Bond between two atom ids, if any. */
export function bondBetween(mol: Molecule, a: number, b: number): Bond | undefined {
  const topo = getTopology(mol);
  const ia = topo.idToIndex.get(a);
  if (ia === undefined) return undefined;
  for (const bi of topo.atomBonds[ia]) {
    const bond = mol.bonds[bi];
    if ((bond.a === a && bond.b === b) || (bond.a === b && bond.b === a)) return bond;
  }
  return undefined;
}

/** Atom ids bonded to the given atom id. */
export function neighborIds(mol: Molecule, id: number): number[] {
  const topo = getTopology(mol);
  const idx = topo.idToIndex.get(id);
  if (idx === undefined) return [];
  return topo.neighbors[idx].map((j) => mol.atoms[j].id);
}

export function atomPosition(a: Atom): Vec3 {
  return [a.x, a.y, a.z];
}

/** Centroid of the given atom ids (or all atoms). Returns [0,0,0] for empty input. */
export function centroid(mol: Molecule, ids?: Iterable<number>): Vec3 {
  let sx = 0, sy = 0, sz = 0, c = 0;
  if (ids) {
    const topo = getTopology(mol);
    for (const id of ids) {
      const idx = topo.idToIndex.get(id);
      if (idx === undefined) continue;
      const a = mol.atoms[idx];
      sx += a.x; sy += a.y; sz += a.z; c++;
    }
  } else {
    for (const a of mol.atoms) {
      sx += a.x; sy += a.y; sz += a.z; c++;
    }
  }
  return c ? [sx / c, sy / c, sz / c] : [0, 0, 0];
}

/** Axis-aligned bounding box of the given atom ids (or all). null if empty. */
export function boundingBox(mol: Molecule, ids?: Iterable<number>): { min: Vec3; max: Vec3 } | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  const visit = (a: Atom) => {
    any = true;
    if (a.x < min[0]) min[0] = a.x;
    if (a.y < min[1]) min[1] = a.y;
    if (a.z < min[2]) min[2] = a.z;
    if (a.x > max[0]) max[0] = a.x;
    if (a.y > max[1]) max[1] = a.y;
    if (a.z > max[2]) max[2] = a.z;
  };
  if (ids) {
    const topo = getTopology(mol);
    for (const id of ids) {
      const idx = topo.idToIndex.get(id);
      if (idx !== undefined) visit(mol.atoms[idx]);
    }
  } else mol.atoms.forEach(visit);
  return any ? { min, max } : null;
}

export function hasProtein(mol: Molecule): boolean {
  return getTopology(mol).residues.some((r) => r.kind === 'protein');
}

export function hasNucleic(mol: Molecule): boolean {
  return getTopology(mol).residues.some((r) => r.kind === 'nucleic');
}

/** True for macromolecules (proteins / nucleic acids with several residues). */
export function isMacromolecule(mol: Molecule): boolean {
  const topo = getTopology(mol);
  let count = 0;
  for (const r of topo.residues) if (r.kind === 'protein' || r.kind === 'nucleic') if (++count >= 3) return true;
  return false;
}

/** Human-readable label for an atom, e.g. "CA · ALA 42 · A" or "C3". */
export function atomLabel(mol: Molecule, id: number): string {
  const a = atomById(mol, id);
  if (!a) return `#${id}`;
  const name = a.name || `${a.element}${atomIndex(mol, id) + 1}`;
  if (a.resName) return `${name} · ${a.resName} ${a.resSeq ?? ''}${a.iCode ?? ''}${a.chain ? ' · ' + a.chain : ''}`;
  return name;
}

let uidCounter = 0;
/** Unique string id for reps / measurements. */
export function uid(prefix = 'id'): string {
  uidCounter++;
  return `${prefix}-${uidCounter.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
