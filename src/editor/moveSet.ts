/**
 * Which atoms move when the user drags an atom (or a bond) with the move tool. Pure.
 */
import type { Molecule } from '../core/types';
import { getTopology } from '../core/molecule';
import { connectedComponent } from '../core/geometry';

export interface MoveSetOptions {
  /** Current selection. Grabbing a selected atom moves the whole selection rigidly. */
  selection: ReadonlySet<number>;
  /** Alt-drag: move the whole connected fragment of the grabbed atom(s). */
  wholeFragment: boolean;
}

/**
 * - Alt-drag: the connected fragment(s) of the grabbed atoms.
 * - Grabbed atom(s) all selected: the selection (existing atoms only).
 * - Otherwise: the grabbed atoms plus their terminal hydrogens, which ride along so that bond
 *   lengths to hydrogens are preserved (dragging a carbon should not leave its H behind).
 */
export function resolveMovedAtoms(mol: Molecule, grabbed: readonly number[], opts: MoveSetOptions): Set<number> {
  const topo = getTopology(mol);
  const present = grabbed.filter((id) => topo.idToIndex.has(id));
  const out = new Set<number>();
  if (present.length === 0) return out;

  if (opts.wholeFragment) {
    for (const id of present) {
      if (out.has(id)) continue;
      for (const x of connectedComponent(mol, id)) out.add(x);
      out.add(id);
    }
    return out;
  }

  if (opts.selection.size > 0 && present.every((id) => opts.selection.has(id))) {
    for (const id of opts.selection) if (topo.idToIndex.has(id)) out.add(id);
    return out;
  }

  for (const id of present) {
    out.add(id);
    const i = topo.idToIndex.get(id)!;
    if (mol.atoms[i].element === 'H') continue;
    for (const j of topo.neighbors[i]) {
      if (mol.atoms[j].element === 'H' && topo.neighbors[j].length === 1) out.add(mol.atoms[j].id);
    }
  }
  return out;
}
