/**
 * Global application state (zustand). OWNER: integration. All modules read/write state ONLY through
 * this store's actions. Non-React code uses `useStore.getState()` / `useStore.subscribe(...)`.
 *
 * Change tracking for the renderer:
 *  - `documentId` increments when a new document is loaded/created (renderer resets the camera).
 *  - `moleculeVersion` increments on every molecule change (commit, transient update, undo/redo).
 *  - `structureVersion` increments only when atoms/bonds are added/removed or elements/orders change
 *    (i.e. NOT for pure coordinate updates) — the renderer can use this to choose a fast path.
 */
import { create } from 'zustand';
import type {
  AppMode,
  EditOverlay,
  HoverInfo,
  MeasureKind,
  Measurement,
  Molecule,
  PanelId,
  Representation,
  Toast,
  ToastKind,
  ToolId,
  ViewSettings,
  BondOrder,
} from '../core/types';
import { ATOM_STYLES, EDIT_TOOLS, EMPTY_OVERLAY, VIEW_TOOLS } from '../core/types';
import { createMolecule, getTopology, isMacromolecule, uid } from '../core/molecule';

export interface HistoryEntry {
  molecule: Molecule;
  label: string;
}

export interface AppState {
  // ---- document ----
  molecule: Molecule | null;
  documentId: number;
  moleculeVersion: number;
  structureVersion: number;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Snapshot taken by beginTransient (drag in progress), null otherwise. */
  transientBase: Molecule | null;

  // ---- representations ----
  reps: Representation[];

  // ---- interaction ----
  selection: ReadonlySet<number>;
  hovered: HoverInfo | null;
  mode: AppMode;
  tool: ToolId;
  /** Element used by add-atom / element tools. */
  editElement: string;
  /** Order used by add-bond tool and add-atom bonds. */
  editBondOrder: BondOrder;
  /** Fragment template id for the fragment tool. */
  editFragment: string;
  /** Measurement kind for the measure tool. */
  measureKind: MeasureKind;
  /** Atom ids clicked so far by the measure tool. */
  pendingMeasure: number[];
  measurements: Measurement[];
  editOverlay: EditOverlay;
  /** Context-sensitive hint shown in the status bar (set by the editor controller). */
  hint: string | null;

  // ---- view / UI ----
  view: ViewSettings;
  panels: Record<PanelId, boolean>;
  toasts: Toast[];
  loading: string | null;

  // ---- actions: document ----
  /** Replace the document with a loaded molecule (resets history, selection, measurements, reps). */
  loadMolecule: (mol: Molecule) => void;
  /** Start an empty molecule in edit mode. */
  newDocument: () => void;
  /** Apply an edit with an undo entry. No-op if mol === current molecule. During a transient edit, ends it (one entry back to its base). */
  commit: (mol: Molecule, label: string) => void;
  /** Begin a transient edit (drag). Stores the current molecule as base for one undo entry. */
  beginTransient: () => void;
  /** Update the molecule during a transient edit (no history entry). */
  updateTransient: (mol: Molecule) => void;
  /** Finish the transient edit: pushes ONE undo entry (base → current) if anything changed. */
  endTransient: (label: string) => void;
  /** Abort the transient edit and restore the base molecule. */
  cancelTransient: () => void;
  undo: () => void;
  redo: () => void;
  setMoleculeName: (name: string) => void;

  // ---- actions: representations ----
  setReps: (reps: Representation[]) => void;
  addRep: (rep: Partial<Representation>) => string;
  updateRep: (id: string, patch: Partial<Representation>) => void;
  removeRep: (id: string) => void;
  duplicateRep: (id: string) => void;
  moveRep: (id: string, delta: -1 | 1) => void;

  // ---- actions: selection & interaction ----
  setSelection: (ids: Iterable<number>) => void;
  addToSelection: (ids: Iterable<number>) => void;
  removeFromSelection: (ids: Iterable<number>) => void;
  toggleSelected: (id: number) => void;
  clearSelection: () => void;
  setHovered: (h: HoverInfo | null) => void;
  setMode: (mode: AppMode) => void;
  setTool: (tool: ToolId) => void;
  setEditElement: (el: string) => void;
  setEditBondOrder: (order: BondOrder) => void;
  setEditFragment: (id: string) => void;
  setMeasureKind: (k: MeasureKind) => void;
  setPendingMeasure: (ids: number[]) => void;
  addMeasurement: (kind: MeasureKind, atomIds: number[]) => void;
  removeMeasurement: (id: string) => void;
  clearMeasurements: () => void;
  setEditOverlay: (o: Partial<EditOverlay>) => void;
  clearEditOverlay: () => void;
  setHint: (hint: string | null) => void;

  // ---- actions: view / UI ----
  setView: (patch: Partial<ViewSettings>) => void;
  setPanel: (id: PanelId, open: boolean) => void;
  togglePanel: (id: PanelId) => void;
  toast: (message: string, kind?: ToastKind, durationMs?: number) => void;
  dismissToast: (id: number) => void;
  setLoading: (message: string | null) => void;
}

export const DEFAULT_VIEW: ViewSettings = {
  theme: 'dark',
  background: '#0b0f17',
  projection: 'perspective',
  autoRotate: false,
  fog: true,
  labelMode: 'none',
  showHydrogens: true,
  quality: 'medium',
  showValence: true,
  autoHydrogens: true,
  relaxOnDrag: false,
  snapBonds: true,
};

export const THEME_BACKGROUNDS = { dark: '#0b0f17', light: '#f5f7fb' } as const;

export function makeRep(partial: Partial<Representation> = {}): Representation {
  return {
    id: partial.id ?? uid('rep'),
    name: partial.name,
    selection: partial.selection ?? 'all',
    style: partial.style ?? 'ball-and-stick',
    color: partial.color ?? 'element',
    uniformColor: partial.uniformColor ?? '#7dd3fc',
    opacity: partial.opacity ?? 1,
    visible: partial.visible ?? true,
    scale: partial.scale ?? 1,
  };
}

/** Sensible default layers for a freshly loaded molecule. */
export function defaultRepresentations(mol: Molecule): Representation[] {
  if (!isMacromolecule(mol)) {
    return [makeRep({ name: 'Molecule', selection: 'all', style: 'ball-and-stick', color: 'element' })];
  }
  const topo = getTopology(mol);
  const reps: Representation[] = [];
  const hasProt = topo.residues.some((r) => r.kind === 'protein');
  const hasNuc = topo.residues.some((r) => r.kind === 'nucleic');
  const hasLig = topo.residues.some((r) => r.kind === 'ligand');
  const hasIon = topo.residues.some((r) => r.kind === 'ion');
  const hasWater = topo.residues.some((r) => r.kind === 'water');
  const multiChain = topo.chains.filter((c) => c.residueIndices.some((ri) => topo.residues[ri].kind === 'protein' || topo.residues[ri].kind === 'nucleic')).length > 1;
  if (hasProt) reps.push(makeRep({ name: 'Protein', selection: 'protein', style: 'cartoon', color: multiChain ? 'chain' : 'secondary' }));
  if (hasNuc) reps.push(makeRep({ name: 'Nucleic acid', selection: 'nucleic', style: 'cartoon', color: multiChain ? 'chain' : 'residue' }));
  if (hasNuc) reps.push(makeRep({ name: 'Bases', selection: 'nucleic and not backbone', style: 'licorice', color: 'element', scale: 0.8 }));
  if (hasLig) reps.push(makeRep({ name: 'Ligands', selection: 'ligand', style: 'ball-and-stick', color: 'element' }));
  if (hasIon) reps.push(makeRep({ name: 'Ions', selection: 'ion', style: 'spacefill', color: 'element', scale: 0.6 }));
  if (hasWater) reps.push(makeRep({ name: 'Water', selection: 'water', style: 'lines', color: 'element', visible: false }));
  if (reps.length === 0) reps.push(makeRep({ name: 'All atoms', selection: 'all', style: 'lines', color: 'element' }));
  return reps;
}

function idsSet(ids: Iterable<number>): Set<number> {
  return new Set(ids);
}

/** Drop selection / measurement references to atoms that no longer exist. */
function pruneRefs(mol: Molecule | null, selection: ReadonlySet<number>, measurements: Measurement[], pending: number[]) {
  if (!mol) return { selection: new Set<number>(), measurements: [] as Measurement[], pendingMeasure: [] as number[] };
  const topo = getTopology(mol);
  const has = (id: number) => topo.idToIndex.has(id);
  let selChanged = false;
  for (const id of selection) if (!has(id)) { selChanged = true; break; }
  const sel = selChanged ? new Set([...selection].filter(has)) : selection;
  const ms = measurements.filter((m) => m.atomIds.every(has));
  const pm = pending.filter(has);
  return {
    selection: sel,
    measurements: ms.length === measurements.length ? measurements : ms,
    pendingMeasure: pm.length === pending.length ? pending : pm,
  };
}

/** True if atoms/bonds/elements/orders differ (not just coordinates). */
function structureChanged(a: Molecule | null, b: Molecule | null): boolean {
  if (!a || !b) return true;
  if (a.atoms.length !== b.atoms.length || a.bonds.length !== b.bonds.length) return true;
  for (let i = 0; i < a.atoms.length; i++) {
    const x = a.atoms[i];
    const y = b.atoms[i];
    if (x === y) continue;
    if (x.id !== y.id || x.element !== y.element || x.charge !== y.charge) return true;
  }
  for (let i = 0; i < a.bonds.length; i++) {
    const x = a.bonds[i];
    const y = b.bonds[i];
    if (x === y) continue;
    if (x.id !== y.id || x.a !== y.a || x.b !== y.b || x.order !== y.order) return true;
  }
  return false;
}

const MAX_HISTORY = 100;
/**
 * Upper bound on the atoms held by all undo snapshots together. Each snapshot keeps its molecule
 * alive, and with it every cache keyed by that molecule (topology, valence…): ~50 MB for a
 * 100k-atom protein, so 100 snapshots would exhaust the heap. Small molecules keep all 100 steps.
 */
const MAX_HISTORY_ATOMS = 1_000_000;

/** Append an undo entry, dropping the oldest ones beyond the step and atom budgets (the newest always stays). */
function pushHistory(past: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const out = [...past, entry];
  let start = Math.max(0, out.length - MAX_HISTORY);
  let atoms = 0;
  for (let i = out.length - 1; i >= start; i--) {
    atoms += out[i].molecule.atoms.length;
    if (atoms > MAX_HISTORY_ATOMS && i < out.length - 1) {
      start = i + 1;
      break;
    }
  }
  return start > 0 ? out.slice(start) : out;
}

let toastCounter = 0;

export const useStore = create<AppState>()((set, get) => ({
  molecule: null,
  documentId: 0,
  moleculeVersion: 0,
  structureVersion: 0,
  past: [],
  future: [],
  transientBase: null,
  reps: [],
  selection: new Set<number>(),
  hovered: null,
  mode: 'view',
  tool: 'select',
  editElement: 'C',
  editBondOrder: 1,
  editFragment: 'benzene',
  measureKind: 'distance',
  pendingMeasure: [],
  measurements: [],
  editOverlay: EMPTY_OVERLAY,
  hint: null,
  view: { ...DEFAULT_VIEW },
  panels: { left: true, right: true, sequence: true, help: false, load: false, settings: false },
  toasts: [],
  loading: null,

  // ---------------- document ----------------
  loadMolecule: (mol) => {
    const s = get();
    // Empty documents open for building. A protein or nucleic acid opens for viewing even when the
    // previous document was being edited; small molecules stay in the current mode so a SMILES or
    // sample can be refined straight away.
    const mode: AppMode = mol.atoms.length === 0 ? 'edit' : s.mode === 'edit' && isMacromolecule(mol) ? 'view' : s.mode;
    set({
      molecule: mol,
      documentId: s.documentId + 1,
      moleculeVersion: s.moleculeVersion + 1,
      structureVersion: s.structureVersion + 1,
      past: [],
      future: [],
      transientBase: null,
      reps: defaultRepresentations(mol),
      selection: new Set(),
      hovered: null,
      measurements: [],
      pendingMeasure: [],
      editOverlay: EMPTY_OVERLAY,
      mode,
      tool: mol.atoms.length === 0 ? 'add-atom' : mode === 'edit' ? s.tool : 'select',
      panels: { ...s.panels, load: false },
    });
    if (get().mode === 'edit') get().setMode('edit');
  },

  newDocument: () => {
    const mol = createMolecule('New molecule', { source: 'editor' });
    get().loadMolecule(mol);
    set({ mode: 'edit', tool: 'add-atom', reps: [makeRep({ name: 'Molecule', selection: 'all', style: 'ball-and-stick' })] });
  },

  commit: (mol, label) => {
    const s = get();
    if (mol === s.molecule) return;
    // A commit while a drag is in progress (e.g. a shortcut pressed mid-drag) absorbs the drag: one
    // undo entry back to the state before it, and the transient edit ends here.
    const before = s.transientBase ?? s.molecule;
    const past = before ? pushHistory(s.past, { molecule: before, label }) : s.past;
    const refs = pruneRefs(mol, s.selection, s.measurements, s.pendingMeasure);
    set({
      molecule: mol,
      past,
      future: [],
      transientBase: null,
      moleculeVersion: s.moleculeVersion + 1,
      structureVersion: structureChanged(s.molecule, mol) ? s.structureVersion + 1 : s.structureVersion,
      ...refs,
    });
  },

  beginTransient: () => {
    const s = get();
    if (!s.molecule || s.transientBase) return;
    set({ transientBase: s.molecule });
  },

  updateTransient: (mol) => {
    const s = get();
    if (mol === s.molecule) return;
    set({
      molecule: mol,
      moleculeVersion: s.moleculeVersion + 1,
      structureVersion: structureChanged(s.molecule, mol) ? s.structureVersion + 1 : s.structureVersion,
    });
  },

  endTransient: (label) => {
    const s = get();
    const base = s.transientBase;
    if (!base) return;
    if (base === s.molecule) {
      set({ transientBase: null });
      return;
    }
    const refs = pruneRefs(s.molecule, s.selection, s.measurements, s.pendingMeasure);
    set({
      transientBase: null,
      past: pushHistory(s.past, { molecule: base, label }),
      future: [],
      ...refs,
    });
  },

  cancelTransient: () => {
    const s = get();
    const base = s.transientBase;
    if (!base) return;
    set({
      transientBase: null,
      molecule: base,
      moleculeVersion: s.moleculeVersion + 1,
      structureVersion: structureChanged(s.molecule, base) ? s.structureVersion + 1 : s.structureVersion,
    });
  },

  undo: () => {
    const s = get();
    if (s.transientBase) s.cancelTransient();
    const st = get();
    const entry = st.past[st.past.length - 1];
    if (!entry || !st.molecule) return;
    const refs = pruneRefs(entry.molecule, st.selection, st.measurements, st.pendingMeasure);
    set({
      molecule: entry.molecule,
      past: st.past.slice(0, -1),
      future: [...st.future, { molecule: st.molecule, label: entry.label }],
      moleculeVersion: st.moleculeVersion + 1,
      structureVersion: structureChanged(st.molecule, entry.molecule) ? st.structureVersion + 1 : st.structureVersion,
      ...refs,
    });
    get().toast(`Undid: ${entry.label}`, 'info', 1500);
  },

  redo: () => {
    // Like undo: a drag in progress is abandoned first, so its intermediate state never enters the history.
    if (get().transientBase) get().cancelTransient();
    const s = get();
    const entry = s.future[s.future.length - 1];
    if (!entry || !s.molecule) return;
    const refs = pruneRefs(entry.molecule, s.selection, s.measurements, s.pendingMeasure);
    set({
      molecule: entry.molecule,
      future: s.future.slice(0, -1),
      past: pushHistory(s.past, { molecule: s.molecule, label: entry.label }),
      moleculeVersion: s.moleculeVersion + 1,
      structureVersion: structureChanged(s.molecule, entry.molecule) ? s.structureVersion + 1 : s.structureVersion,
      ...refs,
    });
    get().toast(`Redid: ${entry.label}`, 'info', 1500);
  },

  setMoleculeName: (name) => {
    const s = get();
    if (!s.molecule || s.molecule.name === name) return;
    // The name is document metadata, not an edit: undo / redo of earlier edits must not revert it.
    const rename = (e: HistoryEntry): HistoryEntry => (e.molecule.name === name ? e : { ...e, molecule: { ...e.molecule, name } });
    set({ molecule: { ...s.molecule, name }, past: s.past.map(rename), future: s.future.map(rename), moleculeVersion: s.moleculeVersion + 1 });
  },

  // ---------------- representations ----------------
  setReps: (reps) => set({ reps }),
  addRep: (partial) => {
    const rep = makeRep(partial);
    set({ reps: [...get().reps, rep] });
    return rep.id;
  },
  updateRep: (id, patch) => set({ reps: get().reps.map((r) => (r.id === id ? { ...r, ...patch, id: r.id } : r)) }),
  removeRep: (id) => set({ reps: get().reps.filter((r) => r.id !== id) }),
  duplicateRep: (id) => {
    const reps = get().reps;
    const i = reps.findIndex((r) => r.id === id);
    if (i < 0) return;
    const copy = { ...reps[i], id: uid('rep'), name: (reps[i].name ?? 'Layer') + ' copy' };
    set({ reps: [...reps.slice(0, i + 1), copy, ...reps.slice(i + 1)] });
  },
  moveRep: (id, delta) => {
    const reps = get().reps.slice();
    const i = reps.findIndex((r) => r.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= reps.length) return;
    [reps[i], reps[j]] = [reps[j], reps[i]];
    set({ reps });
  },

  // ---------------- selection & interaction ----------------
  setSelection: (ids) => set({ selection: idsSet(ids) }),
  addToSelection: (ids) => {
    const next = new Set(get().selection);
    for (const id of ids) next.add(id);
    set({ selection: next });
  },
  removeFromSelection: (ids) => {
    const next = new Set(get().selection);
    for (const id of ids) next.delete(id);
    set({ selection: next });
  },
  toggleSelected: (id) => {
    const next = new Set(get().selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selection: next });
  },
  clearSelection: () => {
    if (get().selection.size === 0) return;
    set({ selection: new Set() });
  },
  setHovered: (h) => {
    const cur = get().hovered;
    if (cur === h) return;
    if (cur && h && cur.kind === h.kind && cur.atomId === h.atomId && cur.bondId === h.bondId && cur.clientX === h.clientX && cur.clientY === h.clientY) return;
    set({ hovered: h });
  },
  setMode: (mode) => {
    const s = get();
    const patch: Partial<AppState> = { mode, editOverlay: EMPTY_OVERLAY, hint: null, pendingMeasure: [] };
    if (mode === 'view' && !VIEW_TOOLS.includes(s.tool)) patch.tool = 'select';
    if (mode === 'edit') {
      if (!EDIT_TOOLS.includes(s.tool)) patch.tool = 'select';
      // Make sure atoms are pickable: editing needs an atom-based layer that is visible. Waters are
      // left out of the added layer (hundreds of loose O atoms would bury the structure).
      const hasWater = !!s.molecule && getTopology(s.molecule).residues.some((r) => r.kind === 'water');
      const editSel = hasWater ? 'not water' : 'all';
      const hasAtomRep = s.reps.some((r) => {
        const q = r.selection.trim();
        return r.visible && ATOM_STYLES.includes(r.style) && (q === 'all' || q === '' || q === editSel);
      });
      if (!hasAtomRep && s.molecule) {
        patch.reps = [...s.reps, makeRep({ name: 'Editable atoms', selection: editSel, style: s.molecule.atoms.length > 3000 ? 'lines' : 'ball-and-stick', color: 'element', scale: 0.9 })];
      }
    }
    set(patch);
  },
  setTool: (tool) => {
    const s = get();
    if (s.mode === 'view' && !VIEW_TOOLS.includes(tool)) return;
    set({ tool, editOverlay: EMPTY_OVERLAY, pendingMeasure: [], hint: null });
  },
  setEditElement: (el) => set({ editElement: el }),
  setEditBondOrder: (order) => set({ editBondOrder: order }),
  setEditFragment: (id) => set({ editFragment: id }),
  setMeasureKind: (k) => set({ measureKind: k, pendingMeasure: [] }),
  setPendingMeasure: (ids) => set({ pendingMeasure: ids }),
  addMeasurement: (kind, atomIds) => {
    const need = kind === 'distance' ? 2 : kind === 'angle' ? 3 : 4;
    if (atomIds.length !== need) return;
    const key = atomIds.join(',');
    const rev = [...atomIds].reverse().join(',');
    if (get().measurements.some((m) => m.kind === kind && (m.atomIds.join(',') === key || m.atomIds.join(',') === rev))) return;
    set({ measurements: [...get().measurements, { id: uid('m'), kind, atomIds: [...atomIds] }] });
  },
  removeMeasurement: (id) => set({ measurements: get().measurements.filter((m) => m.id !== id) }),
  clearMeasurements: () => set({ measurements: [], pendingMeasure: [] }),
  setEditOverlay: (o) => set({ editOverlay: { ...get().editOverlay, ...o } }),
  clearEditOverlay: () => {
    if (get().editOverlay === EMPTY_OVERLAY) return;
    set({ editOverlay: EMPTY_OVERLAY });
  },
  setHint: (hint) => {
    if (get().hint === hint) return;
    set({ hint });
  },

  // ---------------- view / UI ----------------
  setView: (patch) => {
    const cur = get().view;
    const next = { ...cur, ...patch };
    // Switching theme also switches the default backgrounds (unless the user picked a custom one).
    if (patch.theme && patch.theme !== cur.theme && patch.background === undefined) {
      if (cur.background === THEME_BACKGROUNDS[cur.theme]) next.background = THEME_BACKGROUNDS[patch.theme];
    }
    set({ view: next });
  },
  setPanel: (id, open) => set({ panels: { ...get().panels, [id]: open } }),
  togglePanel: (id) => set({ panels: { ...get().panels, [id]: !get().panels[id] } }),
  toast: (message, kind = 'info', durationMs = 3500) => {
    const id = ++toastCounter;
    set({ toasts: [...get().toasts.slice(-4), { id, kind, message }] });
    if (durationMs > 0) setTimeout(() => get().dismissToast(id), durationMs);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setLoading: (message) => set({ loading: message }),
}));

/** Convenience non-React accessor. */
export const getState = () => useStore.getState();
