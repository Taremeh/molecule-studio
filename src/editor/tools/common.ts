/**
 * Helpers shared by the tool modules.
 */
import type { Molecule, Vec3 } from '../../core/types';
import type { AppState } from '../../state/store';
import type { ViewerApi } from '../../render/viewerApi';
import { atomById, bondById, getTopology, isMacromolecule } from '../../core/molecule';
import { shouldShowUnderValence } from '../../core/chemistry';
import { connectedComponent, normalize, sub } from '../../core/geometry';
import type { OpResult } from '../ops';
import type { Hit, PointerState, ToolEnv } from './types';

/**
 * Effective auto-hydrogen mode: the user setting, but only for molecules where explicit hydrogens
 * are meaningful (same policy as the open-valence markers — PDB structures usually lack H, and
 * hydrogenating only the edited atoms would be inconsistent).
 */
export function autoHydrogens(s: AppState, mol: Molecule): boolean {
  return s.view.autoHydrogens && shouldShowUnderValence(mol);
}

export function hitKey(hit: Hit): string {
  if (!hit) return 'none';
  return hit.kind === 'atom' ? `a${hit.atomId}` : `b${hit.bondId}`;
}

export function hitAtomId(hit: Hit): number | undefined {
  return hit && hit.kind === 'atom' ? hit.atomId : undefined;
}

export function isToggleModifier(p: PointerState): boolean {
  return p.shift || p.ctrl || p.meta;
}

export function atomPos(mol: Molecule, id: number): Vec3 | null {
  const a = atomById(mol, id);
  return a ? [a.x, a.y, a.z] : null;
}

/** Commit an op result (or toast its reason). Returns true on success. */
export function commitResult(env: ToolEnv, res: OpResult): boolean {
  const s = env.state();
  if (!res.ok) {
    s.toast(res.reason, 'warning', 2800);
    return false;
  }
  s.commit(res.mol, res.label);
  if (res.warning) s.toast(res.warning, 'warning', 3500);
  return true;
}

export function warn(env: ToolEnv, message: string) {
  env.state().toast(message, 'warning', 2800);
}

/** Select tool click semantics (also used by the move tool). */
export function selectByClick(env: ToolEnv, hit: Hit, p: PointerState) {
  const s = env.state();
  const mol = s.molecule;
  if (!mol) return;
  const toggle = isToggleModifier(p);
  if (!hit) {
    if (!toggle) s.clearSelection();
    return;
  }
  if (hit.kind === 'atom' && hit.atomId !== undefined) {
    if (!atomById(mol, hit.atomId)) return;
    if (toggle) s.toggleSelected(hit.atomId);
    else s.setSelection([hit.atomId]);
    return;
  }
  const bond = hit.bondId !== undefined ? bondById(mol, hit.bondId) : undefined;
  if (!bond) return;
  if (!toggle) s.setSelection([bond.a, bond.b]);
  else if (s.selection.has(bond.a) && s.selection.has(bond.b)) s.removeFromSelection([bond.a, bond.b]);
  else s.addToSelection([bond.a, bond.b]);
}

/** The residue (macromolecules) or connected fragment (small molecules) containing an atom. */
export function groupOf(mol: Molecule, atomId: number): number[] {
  const topo = getTopology(mol);
  const idx = topo.idToIndex.get(atomId);
  if (idx === undefined) return [];
  const r = topo.atomResidue[idx];
  if (r >= 0 && isMacromolecule(mol)) return topo.residues[r].atomIndices.map((i) => mol.atoms[i].id);
  const comp = connectedComponent(mol, atomId);
  comp.add(atomId);
  return [...comp];
}

export function groupName(mol: Molecule, atomId: number): string {
  const topo = getTopology(mol);
  const idx = topo.idToIndex.get(atomId);
  return idx !== undefined && topo.atomResidue[idx] >= 0 && isMacromolecule(mol) ? 'residue' : 'fragment';
}

/** Atom id a hit refers to (for a bond: its first atom). */
export function hitPrimaryAtom(mol: Molecule, hit: Hit): number | undefined {
  if (!hit) return undefined;
  if (hit.kind === 'atom') return hit.atomId;
  return hit.bondId !== undefined ? bondById(mol, hit.bondId)?.a : undefined;
}

/** Double-click: select (optionally) and frame the residue / fragment of the clicked atom. */
export function selectGroupAndFocus(env: ToolEnv, hit: Hit, p: PointerState, select: boolean) {
  const s = env.state();
  const mol = s.molecule;
  if (!mol) return;
  const id = hitPrimaryAtom(mol, hit);
  if (id === undefined) return;
  const ids = groupOf(mol, id);
  if (!ids.length) return;
  if (select) {
    if (isToggleModifier(p)) s.addToSelection(ids);
    else s.setSelection(ids);
  }
  env.viewer.focusAtoms(ids, true);
}

/**
 * World-space unit vector for a screen-space direction (ux, uy) at `origin` (on the camera-facing
 * plane through origin). Screen y grows downwards; the unprojection takes care of the sign.
 */
export function screenDirToWorld(viewer: ViewerApi, origin: Vec3, ux: number, uy: number): Vec3 {
  const sp = viewer.worldToScreen(origin);
  const w0 = viewer.screenToWorldOnPlane(sp.x, sp.y, origin);
  const w1 = viewer.screenToWorldOnPlane(sp.x + ux * 40, sp.y + uy * 40, origin);
  return normalize(sub(w1, w0));
}

/**
 * Where the pointer sits relative to an atom's projected centre, quantised to 8 sectors so hover
 * previews only change when the pointer crosses a sector boundary. sector −1 = dead centre.
 */
export function pointerSector(viewer: ViewerApi, origin: Vec3, p: PointerState): { sector: number; dir: Vec3 } {
  const sp = viewer.worldToScreen(origin);
  const dx = p.x - sp.x;
  const dy = p.y - sp.y;
  if (Math.hypot(dx, dy) < 3) return { sector: -1, dir: screenDirToWorld(viewer, origin, 1, 0) };
  const step = Math.PI / 4;
  const sector = ((Math.round(Math.atan2(dy, dx) / step) % 8) + 8) % 8;
  return { sector, dir: screenDirToWorld(viewer, origin, Math.cos(sector * step), Math.sin(sector * step)) };
}

/** Position for a new atom / fragment placed on empty space: the camera plane through the view target. */
export function placementPoint(env: ToolEnv, mol: Molecule, p: PointerState): Vec3 {
  if (mol.atoms.length === 0) return [0, 0, 0];
  return env.viewer.screenToWorldOnPlane(p.x, p.y, env.viewer.getTarget());
}

/** Hydrogen among `ids` whose projection is closest to the pointer. */
export function closestOnScreen(viewer: ViewerApi, mol: Molecule, ids: number[], p: PointerState): number {
  let best = ids[0];
  let bestD = Infinity;
  for (const id of ids) {
    const pos = atomPos(mol, id);
    if (!pos) continue;
    const sp = viewer.worldToScreen(pos);
    const d = Math.hypot(sp.x - p.x, sp.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}
