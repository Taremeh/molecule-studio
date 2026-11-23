/**
 * Core shared data types. This file is the contract between all modules.
 * See ARCHITECTURE.md for conventions.
 *
 * Conventions
 * - Coordinates are in Ångström, in world space (the 3D scene renders molecule
 *   coordinates directly; there is no centering transform).
 * - Molecules are IMMUTABLE by convention: never mutate a Molecule, Atom or Bond
 *   that is stored in the app state. Edit functions return a new Molecule
 *   (shallow-copying arrays and replacing only changed Atom/Bond objects).
 *   Derived data (topology, selection masks) is cached per Molecule object in
 *   WeakMaps, which is only valid because of this rule.
 * - Atoms are referenced by their stable `id` (never re-used within a document).
 *   Arrays indexed "by atom index" (masks, colors) follow `molecule.atoms` order.
 */

export type Vec3 = [number, number, number];

/** 1 single, 2 double, 3 triple, 1.5 aromatic. */
export type BondOrder = 1 | 1.5 | 2 | 3;

export type SecondaryStructure = 'helix' | 'sheet' | 'coil';

export interface Atom {
  /** Stable unique id within the molecule document. */
  id: number;
  /** Normalized element symbol, e.g. 'C', 'Cl', 'Fe'. Unknown → 'X'. */
  element: string;
  x: number;
  y: number;
  z: number;
  /** Atom name from the file, e.g. 'CA', 'OG1'. */
  name?: string;
  /** Residue name, e.g. 'ALA', 'HOH', 'LIG'. */
  resName?: string;
  /** Residue sequence number. */
  resSeq?: number;
  /** PDB insertion code. */
  iCode?: string;
  /** Chain identifier, e.g. 'A'. */
  chain?: string;
  /** True for HETATM records. */
  hetero?: boolean;
  /** Formal charge (integer). */
  charge?: number;
  bfactor?: number;
  occupancy?: number;
  altLoc?: string;
  /** Serial number from the source file (for display / export). */
  serial?: number;
  /** Secondary structure of the residue this atom belongs to (proteins). */
  ss?: SecondaryStructure;
}

export interface Bond {
  /** Stable unique id within the molecule document. */
  id: number;
  /** Atom id (not index). */
  a: number;
  /** Atom id (not index). */
  b: number;
  order: BondOrder;
}

export interface MoleculeMeta {
  /** Where it came from, e.g. 'file', 'pdb', 'pubchem', 'sample', 'smiles', 'editor'. */
  source?: string;
  /** Original format, e.g. 'pdb', 'cif', 'sdf', 'xyz', 'mol2'. */
  format?: string;
  /** Free-text title / compound name / PDB header. */
  title?: string;
  /** PDB id, PubChem CID, etc. */
  externalId?: string;
  /** True if the file provided explicit bond orders (SDF/MOL2). */
  hasBondOrders?: boolean;
  /** True if secondary structure came from the file (HELIX/SHEET records). */
  hasSecondaryStructure?: boolean;
}

export interface Molecule {
  name: string;
  atoms: Atom[];
  bonds: Bond[];
  /** Next free atom id. Always > max(atom.id). */
  nextAtomId: number;
  /** Next free bond id. Always > max(bond.id). */
  nextBondId: number;
  meta: MoleculeMeta;
}

// ---------------------------------------------------------------------------
// Topology (derived, cached) — see core/molecule.ts getTopology()
// ---------------------------------------------------------------------------

export type ResidueKind = 'protein' | 'nucleic' | 'water' | 'ion' | 'ligand' | 'other';

export interface Residue {
  /** Index in topology.residues. */
  index: number;
  /** Unique key `${chain}:${resSeq}${iCode}:${resName}`. */
  key: string;
  chain: string;
  resSeq: number;
  iCode: string;
  resName: string;
  kind: ResidueKind;
  /** Atom indices (into molecule.atoms) belonging to this residue. */
  atomIndices: number[];
  /** One-letter code for protein / nucleic residues ('X' if unknown). */
  oneLetter: string;
  /** Secondary structure (from the CA/first atom's ss), proteins only. */
  ss?: SecondaryStructure;
}

export interface Chain {
  id: string;
  /** Residue indices (into topology.residues) in file order. */
  residueIndices: number[];
}

export interface Topology {
  /** atom id → atom index */
  idToIndex: Map<number, number>;
  /** atom index → bonded atom indices */
  neighbors: number[][];
  /** atom index → indices into molecule.bonds */
  atomBonds: number[][];
  /** bond id → bond index */
  bondIdToIndex: Map<number, number>;
  residues: Residue[];
  /** atom index → residue index (-1 if the atom has no residue info) */
  atomResidue: Int32Array;
  chains: Chain[];
}

// ---------------------------------------------------------------------------
// Representations ("layers")
// ---------------------------------------------------------------------------

export type RepStyle =
  | 'ball-and-stick'
  | 'spacefill'
  | 'licorice'
  | 'lines'
  | 'cartoon'
  | 'surface';

/** Styles that draw individual atoms and therefore support picking / editing. */
export const ATOM_STYLES: readonly RepStyle[] = ['ball-and-stick', 'spacefill', 'licorice', 'lines'];

export type ColorScheme =
  | 'element'
  | 'chain'
  | 'residue'
  | 'secondary'
  | 'bfactor'
  | 'hydrophobicity'
  | 'rainbow'
  | 'uniform';

export interface Representation {
  id: string;
  /** Optional user-facing label. */
  name?: string;
  /** Selection query (see core/selection.ts). 'all' selects everything. */
  selection: string;
  style: RepStyle;
  color: ColorScheme;
  /** Hex '#rrggbb' used when color === 'uniform'. For 'element' scheme carbon atoms keep element color. */
  uniformColor: string;
  /** 0..1 */
  opacity: number;
  visible: boolean;
  /** Size multiplier, default 1. */
  scale: number;
}

// ---------------------------------------------------------------------------
// Measurements, hover, editing
// ---------------------------------------------------------------------------

export type MeasureKind = 'distance' | 'angle' | 'dihedral';

export interface Measurement {
  id: string;
  kind: MeasureKind;
  /** 2, 3 or 4 atom ids depending on kind. */
  atomIds: number[];
}

export interface HoverInfo {
  kind: 'atom' | 'bond';
  atomId?: number;
  bondId?: number;
  /** Pointer position in client (CSS pixel) coordinates. */
  clientX: number;
  clientY: number;
}

export type AppMode = 'view' | 'edit';

export type ToolId =
  | 'select' // click to select atoms, shift-click to add, shift-drag box select
  | 'measure' // click 2/3/4 atoms to add a distance/angle/dihedral measurement
  | 'move' // drag atoms (edit mode)
  | 'add-atom' // click empty space / atom to add atoms (edit mode)
  | 'add-bond' // drag atom→atom to bond, click bond to cycle order (edit mode)
  | 'delete' // click atom / bond to delete (edit mode)
  | 'element' // click atom to change its element (edit mode)
  | 'charge' // click atom: +1, shift-click: -1 (edit mode)
  | 'fragment'; // click atom / empty space to attach a fragment template (edit mode)

export const VIEW_TOOLS: readonly ToolId[] = ['select', 'measure'];
export const EDIT_TOOLS: readonly ToolId[] = [
  'select',
  'move',
  'add-atom',
  'add-bond',
  'delete',
  'element',
  'charge',
  'fragment',
  'measure',
];

export type HighlightColor = 'hover' | 'valid' | 'invalid' | 'delete' | 'target' | 'suggest';

/** Transient visual feedback drawn by the renderer while using edit tools. */
export interface EditOverlay {
  /** Preview atoms that would be created. */
  ghostAtoms: { position: Vec3; element: string; valid: boolean }[];
  /** Preview / suggested bonds. 'preview' = what will happen on release, 'suggest' = possible bond. */
  ghostBonds: { from: Vec3; to: Vec3; valid: boolean; order: BondOrder; style: 'preview' | 'suggest' }[];
  /** Highlighted existing atoms. */
  highlightAtoms: { atomId: number; color: HighlightColor }[];
  /** Highlighted existing bonds. */
  highlightBonds: { bondId: number; color: HighlightColor }[];
  /** Box-selection rectangle in client coordinates. */
  selectionRect: { x0: number; y0: number; x1: number; y1: number } | null;
}

export const EMPTY_OVERLAY: EditOverlay = {
  ghostAtoms: [],
  ghostBonds: [],
  highlightAtoms: [],
  highlightBonds: [],
  selectionRect: null,
};

export type LabelMode = 'none' | 'element' | 'name' | 'residue' | 'serial';

export interface ViewSettings {
  theme: 'dark' | 'light';
  /** Canvas background color (hex). */
  background: string;
  projection: 'perspective' | 'orthographic';
  autoRotate: boolean;
  fog: boolean;
  /** Labels drawn for selected atoms (or all atoms if the molecule is small, < 60 atoms, and nothing is selected). */
  labelMode: LabelMode;
  /** Global filter: hide hydrogens in all representations (ignored in edit mode). */
  showHydrogens: boolean;
  /** Rendering quality: sphere/cylinder tessellation, cartoon subdivision, surface grid resolution. */
  quality: 'low' | 'medium' | 'high';
  /** Edit mode: show valence problems (over-valent red, open valences amber). */
  showValence: boolean;
  /** Edit mode: automatically add / remove hydrogens on edited atoms to satisfy valence. */
  autoHydrogens: boolean;
  /** Edit mode: relax neighbouring geometry while dragging atoms. */
  relaxOnDrag: boolean;
  /** Edit mode: when a dragged atom is released within bonding distance of another atom, create the bond. */
  snapBonds: boolean;
}

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export type PanelId = 'left' | 'right' | 'sequence' | 'help' | 'load' | 'settings';
