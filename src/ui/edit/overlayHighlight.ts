/**
 * Temporary 3D highlight requested by a panel (e.g. hovering a row of the measurements list).
 * OWNER: edit-ui.
 *
 * `editOverlay` belongs to the editor controller (tool previews, the pending add-bond start atom…).
 * A panel highlight is added on top of the editor's highlights and removed again afterwards, so the
 * editor's overlay is never wiped. If the overlay's highlights were replaced in the meantime (the
 * editor showed a new preview), the newer state is left alone.
 */
import type { EditOverlay, HighlightColor } from '../../core/types';
import { EMPTY_OVERLAY } from '../../core/types';
import { useStore } from '../../state/store';

/** Highlight `atomIds`; returns the function that removes the highlight again. */
export function showTemporaryHighlight(atomIds: readonly number[], color: HighlightColor = 'target'): () => void {
  const s = useStore.getState();
  const previous = s.editOverlay;
  const highlights: EditOverlay['highlightAtoms'] = [...previous.highlightAtoms, ...atomIds.map((atomId) => ({ atomId, color }))];
  s.setEditOverlay({ highlightAtoms: highlights });
  const applied = useStore.getState().editOverlay;
  return () => {
    const cur = useStore.getState();
    if (cur.editOverlay.highlightAtoms !== highlights) return; // replaced meanwhile: keep the newer state
    if (cur.editOverlay === applied && previous === EMPTY_OVERLAY) cur.clearEditOverlay();
    else cur.setEditOverlay({ highlightAtoms: previous.highlightAtoms });
  };
}
