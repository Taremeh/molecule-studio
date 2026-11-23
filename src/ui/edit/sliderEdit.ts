/**
 * One slider gesture of the geometry inspector = at most one undo entry.
 * OWNER: edit-ui.
 *
 * A gesture starts on pointer down on the slider (or with the first key-driven change) and pairs
 * store.beginTransient with exactly one endTransient (pointer release anywhere for a drag, key up
 * for a key-driven change, unmount) or cancelTransient (Escape during a pointer drag). Updates are
 * computed from the transient BASE molecule, so repeated updates never accumulate error. If the transient edit is ended elsewhere
 * mid-gesture (undo / redo / another edit / a document load), the rest of the gesture is ignored instead of
 * editing the molecule without an undo entry.
 */
import type { Molecule } from '../../core/types';
import { useStore } from '../../state/store';

export interface SliderEdit {
  /** Pointer down on the slider: the gesture ends on the next pointer release anywhere; Escape cancels it. */
  pointerDown(label: (mol: Molecule) => string): void;
  /** A new slider value; `apply` derives the molecule from the transient base. Starts a (keyboard) gesture if none is active. */
  change(label: (mol: Molecule) => string, apply: (base: Molecule) => Molecule): void;
  /** End of the gesture (release, unmount): one undo entry if anything changed. */
  finish(): void;
  /**
   * The slider's own key up / pointer up (its onCommit). Ends a key-driven gesture only: a pointer
   * drag ends on the pointer release, so a key released mid-drag (Escape, Ctrl+Z, Shift…) neither
   * splits it into two entries nor lets a cancelled drag start again.
   */
  keyUp(): void;
  /** Abort the gesture and restore the molecule from before it. */
  cancel(): void;
  /** True while a gesture is in progress. */
  readonly active: boolean;
}

interface Gesture {
  label: (mol: Molecule) => string;
  /** Transient base this gesture edits from; null once it no longer applies changes. */
  base: Molecule | null;
  pointer: boolean;
  detach: () => void;
}

type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export function createSliderEdit(target: ListenerTarget | null = typeof window !== 'undefined' ? window : null): SliderEdit {
  let current: Gesture | null = null;
  const store = () => useStore.getState();

  function start(label: (mol: Molecule) => string, pointer: boolean): Gesture | null {
    if (current) finish();
    const s = store();
    if (!s.molecule) return null;
    if (!s.transientBase) s.beginTransient();
    const g: Gesture = { label, base: store().transientBase, pointer, detach: () => {} };
    if (target) {
      // The slider may be released outside the input (and a key-up may be missed): finish on any
      // pointer release. All listeners go away when the gesture ends.
      const onRelease = () => {
        if (current === g) finish();
      };
      const onKey = (e: Event) => {
        if ((e as KeyboardEvent).key !== 'Escape' || current !== g || !g.base) return;
        // Escape cancels the drag (and must not also clear the selection / switch tools).
        e.preventDefault();
        e.stopPropagation();
        cancel();
      };
      target.addEventListener('pointerup', onRelease, true);
      target.addEventListener('pointercancel', onRelease, true);
      if (pointer) target.addEventListener('keydown', onKey, true);
      g.detach = () => {
        target.removeEventListener('pointerup', onRelease, true);
        target.removeEventListener('pointercancel', onRelease, true);
        if (pointer) target.removeEventListener('keydown', onKey, true);
      };
    }
    current = g;
    return g;
  }

  function finish() {
    const g = current;
    if (!g) return;
    current = null;
    g.detach();
    const s = store();
    if (g.base && s.transientBase === g.base && s.molecule) s.endTransient(g.label(s.molecule));
  }

  function cancel() {
    const g = current;
    if (!g) return;
    const s = store();
    if (g.base && s.transientBase === g.base) s.cancelTransient();
    g.base = null;
    // A cancelled pointer drag stays inert until the button is released, so moving on doesn't restart it.
    if (!g.pointer) {
      current = null;
      g.detach();
    }
  }

  return {
    pointerDown(label) {
      start(label, true);
    },
    change(label, apply) {
      const g = current ?? start(label, false); // keyboard interaction (arrow keys) has no pointer down
      if (!g || !g.base) return;
      const s = store();
      if (s.transientBase !== g.base) {
        g.base = null; // ended elsewhere (undo, redo, an edit committed meanwhile, a load): ignore the rest
        return;
      }
      s.updateTransient(apply(g.base));
    },
    finish,
    keyUp() {
      // Without a window to hear the release (no DOM), the slider's pointer up is the only end.
      if (current && (!current.pointer || !target)) finish();
    },
    cancel,
    get active() {
      return current !== null;
    },
  };
}
