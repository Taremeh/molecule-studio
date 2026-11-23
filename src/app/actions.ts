/**
 * High-level app actions used by the UI (loading, exporting, common edit commands).
 * OWNER: integration. UI components should call these rather than re-implementing the flows.
 */
import { useStore } from '../state/store';
import type { Molecule } from '../core/types';
import { prepareMolecule } from '../core/prepare';
import { getTopology } from '../core/molecule';
import { detectFormat, isFlat2D, parseMolecule, writeMolecule, WRITE_EXTENSIONS, type FileFormat, type WritableFormat } from '../io/formats';
import { fetchFromAlphaFold, fetchFromPdb, fetchFromPubChem, type FetchedStructure } from '../io/fetch';
import type { SampleEntry } from '../io/samples';
import { moleculeFromSmiles, embed3D } from '../core/smiles';
import { getViewer } from '../render/viewerApi';
import { addHydrogens, removeHydrogens, centerMolecule, removeAtoms } from '../core/edit';
import { minimize } from '../core/minimize';
import { planDeleteAtoms } from '../editor/feedback';
import { applyDelete } from '../editor/ops';
import { autoHydrogens } from '../editor/tools/common';

const store = () => useStore.getState();

function isAbort(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
}

function errorMessage(e: unknown): string {
  if (isAbort(e)) return 'Cancelled';
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Ticket of the latest withLoading call: only it may clear the loading indicator. */
let loadingTicket = 0;

async function withLoading<T>(message: string, fn: () => Promise<T>): Promise<T | undefined> {
  const ticket = ++loadingTicket;
  store().setLoading(message);
  // Let React paint the loading state before heavy synchronous parsing.
  await new Promise((r) => setTimeout(r, 16));
  try {
    return await fn();
  } catch (e) {
    // A cancelled download is the user's choice, not an error.
    if (isAbort(e)) {
      store().toast('Cancelled', 'info', 1500);
      return undefined;
    }
    console.error(e);
    store().toast(errorMessage(e), 'error', 6000);
    return undefined;
  } finally {
    // An older, slower operation must not hide the indicator of a newer one still in progress.
    if (ticket === loadingTicket) store().setLoading(null);
  }
}

/**
 * Ticket of the latest document request (load or new molecule). A slower, older request (e.g. a
 * download still running when the user drops a file) is superseded: its result and errors are dropped.
 */
let documentTicket = 0;

/** Read / fetch / parse a molecule under the loading indicator and load it, unless superseded meanwhile. */
function loadDocument(message: string, read: () => Promise<{ mol: Molecule; flat?: boolean }>): Promise<Molecule | undefined> {
  const ticket = ++documentTicket;
  return withLoading(message, async () => {
    let parsed: { mol: Molecule; flat?: boolean };
    try {
      parsed = await read();
    } catch (e) {
      if (ticket !== documentTicket) return undefined;
      throw e;
    }
    if (ticket !== documentTicket) return undefined;
    return finishLoad(parsed.mol, { flat: parsed.flat });
  });
}

function finishLoad(mol: Molecule, opts: { flat?: boolean } = {}) {
  // 2D drawings get 3D coordinates first, so bond and bond-order perception never work on
  // drawing-unit distances.
  const m = prepareMolecule(opts.flat ? embed3D(mol) : mol);
  store().loadMolecule(m);
  const n = m.atoms.length;
  store().toast(`Loaded ${m.name} · ${n.toLocaleString()} atoms`, 'success', 2500);
  return m;
}

function parseText(text: string, format: FileFormat | null, name: string, source: string): { mol: Molecule; flat: boolean } {
  const fmt = format ?? detectFormat(name, text);
  if (!fmt) throw new Error(`Could not recognise the file format of "${name}". Supported: PDB, mmCIF, SDF/MOL, XYZ, MOL2.`);
  const mol = parseMolecule(text, fmt, name.replace(/\.[^.]+$/, ''));
  mol.meta = { ...mol.meta, source, format: fmt };
  if (mol.atoms.length === 0) throw new Error(`No atoms found in "${name}".`);
  // 2D drawings (MOL/SDF from sketchers) get real 3D coordinates.
  return { mol, flat: isFlat2D(text, fmt, mol) };
}

/** Parse text in a known or detected format and load it. */
export function openText(text: string, format: FileFormat | null, name: string, source = 'file'): Promise<Molecule | undefined> {
  return loadDocument(`Reading ${name}…`, async () => parseText(text, format, name, source));
}

/** Read and load a local file. Reading happens under the loading indicator; failures are toasted. */
export function openFile(file: File): Promise<Molecule | undefined> {
  return loadDocument(`Reading ${file.name}…`, async () => {
    let text: string;
    try {
      text = await file.text();
    } catch {
      // e.g. a dropped folder, or a file that was moved after it was picked
      throw new Error(`Could not read “${file.name}”. Choose a structure file (folders can't be opened).`);
    }
    return parseText(text, null, file.name, 'file');
  });
}

function parseFetched(f: FetchedStructure): { mol: Molecule; flat?: boolean } {
  const mol = parseMolecule(f.text, f.format, f.name);
  mol.meta = { ...mol.meta, source: f.source, format: f.format, externalId: f.externalId ?? mol.meta.externalId };
  if (mol.atoms.length === 0) throw new Error(`No atoms found in ${f.name}.`);
  return { mol, flat: f.flat };
}

export function openPdbId(id: string, signal?: AbortSignal) {
  return loadDocument(`Fetching ${id.toUpperCase()} from the PDB…`, async () => parseFetched(await fetchFromPdb(id.trim(), signal)));
}

export function openPubChem(query: string, signal?: AbortSignal) {
  return loadDocument(`Searching PubChem for “${query}”…`, async () => parseFetched(await fetchFromPubChem(query.trim(), signal)));
}

export function openAlphaFold(uniprot: string, signal?: AbortSignal) {
  return loadDocument(`Fetching AlphaFold model ${uniprot.toUpperCase()}…`, async () => parseFetched(await fetchFromAlphaFold(uniprot.trim(), signal)));
}

export function openSmiles(smiles: string, name?: string) {
  return loadDocument('Building 3D structure from SMILES…', async () => ({ mol: moleculeFromSmiles(smiles.trim(), name || smiles.trim()) }));
}

export async function openSample(sample: SampleEntry) {
  const src = sample.source;
  switch (src.kind) {
    case 'embedded':
      return openText(src.text, src.format, sample.name, 'sample');
    case 'pdb':
      return openPdbId(src.id);
    case 'pubchem':
      return loadDocument(`Fetching ${sample.name} from PubChem…`, async () => {
        const f = await fetchFromPubChem(src.query);
        return parseFetched({ ...f, name: sample.name });
      });
    case 'smiles':
      return openSmiles(src.smiles, sample.name);
  }
}

export function newMolecule() {
  // Supersedes a load still in progress: its result will be dropped, so its indicator (which covers
  // the stage and blocks editing the new molecule) goes away now rather than when it finishes.
  documentTicket++;
  if (store().loading !== null) {
    loadingTicket++;
    store().setLoading(null);
  }
  store().newDocument();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeName(name: string) {
  return (name || 'molecule').replace(/[^\w.-]+/g, '_').slice(0, 60);
}

export function exportMolecule(format: WritableFormat) {
  const mol = store().molecule;
  if (!mol || mol.atoms.length === 0) {
    store().toast('Nothing to export', 'warning');
    return;
  }
  try {
    const text = writeMolecule(mol, format);
    downloadBlob(new Blob([text], { type: 'chemical/x-' + format }), `${safeName(mol.name)}.${WRITE_EXTENSIONS[format]}`);
    store().toast(`Exported ${format.toUpperCase()}`, 'success', 2000);
  } catch (e) {
    store().toast(errorMessage(e), 'error');
  }
}

export async function exportScreenshot(scale = 2, transparent = false) {
  const viewer = getViewer();
  const mol = store().molecule;
  if (!viewer) return;
  try {
    const blob = await viewer.screenshot({ scale, transparent });
    downloadBlob(blob, `${safeName(mol?.name ?? 'scene')}.png`);
    store().toast('Saved image', 'success', 2000);
  } catch (e) {
    store().toast(errorMessage(e), 'error');
  }
}

// ---------------------------------------------------------------------------
// Common edit commands (toolbar buttons / shortcuts)
// ---------------------------------------------------------------------------

function selectedOrAll(): number[] | undefined {
  const sel = store().selection;
  return sel.size ? [...sel] : undefined;
}

export function cmdAddHydrogens() {
  const mol = store().molecule;
  if (!mol) return;
  const next = addHydrogens(mol, selectedOrAll());
  const added = next.atoms.length - mol.atoms.length;
  if (added <= 0) return store().toast('No open valences to fill', 'info');
  store().commit(next, 'Add hydrogens');
  store().toast(`Added ${added} hydrogen${added === 1 ? '' : 's'}`, 'success', 2000);
}

export function cmdRemoveHydrogens() {
  const mol = store().molecule;
  if (!mol) return;
  const next = removeHydrogens(mol, selectedOrAll());
  const removed = mol.atoms.length - next.atoms.length;
  if (removed <= 0) return store().toast('No hydrogens to remove', 'info');
  store().commit(next, 'Remove hydrogens');
}

/** Whole-molecule clean-up limit; with a selection only the selected atoms move. */
const CLEAN_ALL_LIMIT = 5000;
const CLEAN_SELECTION_LIMIT = 2000;

export async function cmdCleanGeometry() {
  const start = store();
  const mol = start.molecule;
  if (!mol || mol.atoms.length === 0) return;
  const sel = start.selection;
  if (sel.size > CLEAN_SELECTION_LIMIT) {
    store().toast(`Geometry clean-up moves at most ${CLEAN_SELECTION_LIMIT.toLocaleString()} atoms. Select a smaller region.`, 'warning');
    return;
  }
  if (sel.size === 0 && mol.atoms.length > CLEAN_ALL_LIMIT) {
    store().toast(`Geometry clean-up of a whole structure is limited to ${CLEAN_ALL_LIMIT.toLocaleString()} atoms. Select a region first.`, 'warning');
    return;
  }
  const doc = start.documentId;
  await withLoading('Optimising geometry…', async () => {
    // Minimise the molecule as it is now: it may have changed while the loading state painted.
    const s = store();
    if (s.documentId !== doc || !s.molecule || s.transientBase) return;
    const current = s.molecule;
    const index = getTopology(current).idToIndex;
    const movable = sel.size ? new Set([...sel].filter((id) => index.has(id))) : undefined;
    if (movable && movable.size === 0) return;
    const res = minimize(current, { maxSteps: 1000, movable });
    store().commit(res.mol, 'Clean up geometry');
    store().toast(`Geometry optimised (${res.steps} steps${res.converged ? '' : ', not fully converged'})`, 'success', 2500);
  });
}

export function cmdCenter() {
  const mol = store().molecule;
  if (!mol) return;
  store().commit(centerMolecule(mol), 'Center molecule');
  getViewer()?.focusAtoms();
}

/**
 * Delete the selected atoms (edit mode). Uses the editor's delete plan so hydrogens of deleted atoms
 * go with them and remaining neighbours get their hydrogens back (when auto-hydrogens applies).
 */
export function cmdDeleteSelection() {
  const s = store();
  const mol = s.molecule;
  if (!mol || s.selection.size === 0 || s.mode !== 'edit') return;
  const res = applyDelete(mol, planDeleteAtoms(mol, s.selection), autoHydrogens(s, mol));
  if (res.ok) s.commit(res.mol, res.label);
  else {
    const n = s.selection.size;
    s.commit(removeAtoms(mol, s.selection), `Delete ${n} atom${n === 1 ? '' : 's'}`);
  }
  store().clearSelection();
}

export function focusSelection() {
  const sel = store().selection;
  getViewer()?.focusAtoms(sel.size ? [...sel] : undefined, true);
}
