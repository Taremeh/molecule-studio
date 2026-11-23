/**
 * Window-level drag & drop of structure files with a full-screen drop target overlay.
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 *
 * Listens on `window` so a file can be dropped anywhere. Nested drop zones (e.g. the File tab of the
 * load dialog) may handle a drop themselves by calling `preventDefault()` — the window handler then
 * only hides the overlay. The overlay itself is `pointer-events: none` so it never steals events.
 */
import { useEffect, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useStore } from '../state/store';
import { openFile } from '../app/actions';
import { FORMAT_LABELS } from '../io/formats';
import { useShell } from './shell/shellStore';
import './DropOverlay.css';

function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
  return false;
}

/** Load the first dropped file (warn if several were dropped). Exported for nested drop zones. */
export function openDroppedFiles(files: FileList | File[]) {
  const list = Array.from(files);
  if (list.length === 0) return;
  if (list.length > 1) useStore.getState().toast(`Opened ${list[0].name} — one file at a time is supported`, 'info');
  void openFile(list[0]);
}

export default function DropOverlay() {
  const [active, setActive] = useState(false);
  const hasMolecule = useStore((s) => s.molecule !== null && s.molecule.atoms.length > 0);
  // The load dialog's File tab has its own drop zone; don't cover it with the full-screen overlay.
  const loadOpen = useStore((s) => s.panels.load);
  const loadTab = useShell((s) => s.loadTab);
  const dialogDropZone = loadOpen && loadTab === 'file';

  useEffect(() => {
    // dragenter/dragleave fire for every child element crossed; count them to know when the drag
    // really left the window.
    let depth = 0;
    const reset = () => {
      depth = 0;
      setActive(false);
    };
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth++;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); // required to allow dropping
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      // Some browsers (Safari) report relatedTarget = null for every leave; also check the position.
      const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
      if (depth === 0 || (outside && e.relatedTarget === null)) reset();
    };
    const onDrop = (e: DragEvent) => {
      reset();
      if (!isFileDrag(e)) return;
      if (e.defaultPrevented) return; // handled by a nested drop zone
      e.preventDefault();
      if (e.dataTransfer?.files) openDroppedFiles(e.dataTransfer.files);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && reset();
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!active || dialogDropZone) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-frame">
        <div className="drop-card">
          <div className="drop-icon">
            <FileUp size={28} />
          </div>
          <div className="drop-title">Drop to open</div>
          <div className="drop-formats">{Object.values(FORMAT_LABELS).join(' · ')}</div>
          {hasMolecule && <div className="drop-note">Replaces the current molecule</div>}
        </div>
      </div>
    </div>
  );
}
