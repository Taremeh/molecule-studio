/**
 * Bottom sequence strip for proteins / nucleic acids.
 * OWNER: edit-ui agent. See ARCHITECTURE.md § UI.
 *
 * One row per polymer chain (chain badge + one-letter codes, residue numbers every 10), colored by
 * secondary structure; residues containing selected atoms are highlighted, and the residue under
 * the 3D hover is outlined. Click selects a residue, shift-click extends a range from the last
 * clicked residue, ctrl/cmd-click toggles; double-click focuses. Hover shows the residue in 3D.
 *
 * Fast for very long sequences: cells are fixed-size and only the visible window (plus overscan)
 * of rows and columns is rendered; events are delegated to the scroll container.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useStore } from '../state/store';
import { getViewer } from '../render/viewerApi';
import {
  allSelected,
  buildSequenceModel,
  rangeAtomIds,
  representativeAtomId,
  residueAtomIds,
  residueOfAtom,
  selectedResidueSet,
  visibleWindow,
} from './edit/sequenceModel';
import './SequenceViewer.css';

/** Geometry (px) — mirrored into CSS variables on the root element. */
const CELL_W = 14;
const ROW_H = 25;
const LABEL_W = 46;
const PAD_Y = 2;
const OVERSCAN_COLS = 40;
const OVERSCAN_ROWS = 1;

interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export default function SequenceViewer() {
  const molecule = useStore((s) => s.molecule);
  const documentId = useStore((s) => s.documentId);
  const selection = useStore((s) => s.selection);
  const hoveredAtom = useStore((s) => (s.hovered?.kind === 'atom' ? s.hovered.atomId ?? -1 : -1));

  const scrollRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<Viewport>({ left: 0, top: 0, width: 1600, height: 64 });
  const [expanded, setExpanded] = useState(false);
  const anchor = useRef<{ row: number; pos: number } | null>(null);
  const hoverRef = useRef<{ row: number; pos: number } | null>(null);
  const frame = useRef(0);

  const model = useMemo(() => (molecule ? buildSequenceModel(molecule) : null), [molecule]);
  const selectedRes = useMemo(() => (molecule ? selectedResidueSet(molecule, selection) : new Set<number>()), [molecule, selection]);
  const hoveredRes = molecule && hoveredAtom >= 0 ? residueOfAtom(molecule, hoveredAtom) : -1;

  const hasRows = !!model && model.rows.length > 0;

  // Track scroll position and size (rAF-throttled) to render only the visible window.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = () => {
      frame.current = 0;
      setVp((cur) => {
        const next = { left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight };
        return cur.left === next.left && cur.top === next.top && cur.width === next.width && cur.height === next.height ? cur : next;
      });
    };
    const schedule = () => {
      if (!frame.current) frame.current = requestAnimationFrame(read);
    };
    read();
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', schedule);
      ro.disconnect();
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [hasRows]);

  // New document: forget the range anchor and scroll back to the start.
  useEffect(() => {
    anchor.current = null;
    scrollRef.current?.scrollTo({ left: 0, top: 0 });
  }, [documentId]);

  // When the selection changes elsewhere (3D view, query) and none of it is visible, scroll to it.
  const prevSelection = useRef(selection);
  useEffect(() => {
    if (prevSelection.current === selection) return;
    prevSelection.current = selection;
    const el = scrollRef.current;
    if (!el || !model || selectedRes.size === 0) return;
    let first: { row: number; pos: number } | null = null;
    for (const ri of selectedRes) {
      const row = model.rowOf[ri];
      if (row < 0) continue;
      const pos = model.posOf[ri];
      const x = LABEL_W + pos * CELL_W;
      const y = PAD_Y + row * ROW_H;
      const visible = x >= el.scrollLeft + LABEL_W && x + CELL_W <= el.scrollLeft + el.clientWidth && y >= el.scrollTop && y + ROW_H <= el.scrollTop + el.clientHeight;
      if (visible) return;
      if (!first || row < first.row || (row === first.row && pos < first.pos)) first = { row, pos };
    }
    if (!first) return;
    el.scrollTo({
      left: Math.max(0, first.pos * CELL_W - (el.clientWidth - LABEL_W) / 3),
      top: Math.max(0, PAD_Y + first.row * ROW_H - (el.clientHeight - ROW_H) / 2),
      behavior: 'smooth',
    });
  }, [selection, selectedRes, model]);

  const pendingHover = useRef<{ hit: { row: number; pos: number } | null; x: number; y: number } | null>(null);
  const hoverFrame = useRef(0);
  const applyHover = () => {
    hoverFrame.current = 0;
    const p = pendingHover.current;
    pendingHover.current = null;
    const s = useStore.getState();
    const m = s.molecule;
    const res = p?.hit && m ? buildSequenceModel(m).rows[p.hit.row]?.residues[p.hit.pos] : undefined;
    const atomId = res && m ? representativeAtomId(m, res.resIndex) : undefined;
    if (!p || atomId === undefined) {
      if (p && hoverRef.current) {
        hoverRef.current = null;
        s.setHovered(null);
      }
      return;
    }
    hoverRef.current = p.hit;
    s.setHovered({ kind: 'atom', atomId, clientX: p.x, clientY: p.y });
  };

  // Clear our hover on unmount.
  useEffect(
    () => () => {
      if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
      if (hoverRef.current) useStore.getState().setHovered(null);
    },
    [],
  );

  if (!molecule || !model || model.rows.length === 0) return null;
  const mol = molecule;
  const rows = model.rows;

  const contentWidth = LABEL_W + model.maxLength * CELL_W + 24;
  const contentHeight = PAD_Y * 2 + rows.length * ROW_H;
  const [r0, r1] = visibleWindow(vp.top, vp.height, ROW_H, rows.length, OVERSCAN_ROWS, PAD_Y);

  const cellAt = (target: EventTarget | null): { row: number; pos: number } | null => {
    const cell = (target as HTMLElement | null)?.closest?.('[data-pos]') as HTMLElement | null;
    if (!cell) return null;
    const row = Number(cell.dataset.row);
    const pos = Number(cell.dataset.pos);
    return rows[row]?.residues[pos] ? { row, pos } : null;
  };

  const onClick = (e: React.MouseEvent) => {
    const hit = cellAt(e.target);
    if (!hit) return;
    const s = useStore.getState();
    const row = rows[hit.row];
    const ids = residueAtomIds(mol, row.residues[hit.pos].resIndex);
    const a = anchor.current;
    if (e.shiftKey && a && a.row === hit.row && row.residues[a.pos]) {
      s.addToSelection(rangeAtomIds(mol, row, a.pos, hit.pos));
      return; // keep the anchor so the range can be adjusted
    }
    if (e.shiftKey) s.addToSelection(ids);
    else if (e.metaKey || e.ctrlKey) {
      if (allSelected(s.selection, ids)) s.removeFromSelection(ids);
      else s.addToSelection(ids);
    } else s.setSelection(ids);
    anchor.current = hit;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = cellAt(e.target);
    if (!hit) return;
    getViewer()?.focusAtoms(residueAtomIds(mol, rows[hit.row].residues[hit.pos].resIndex), true);
  };

  // Hover → store.hovered on the residue's representative atom (at most once per frame).
  const onPointerMove = (e: React.PointerEvent) => {
    pendingHover.current = { hit: cellAt(e.target), x: e.clientX, y: e.clientY };
    if (!hoverFrame.current) hoverFrame.current = requestAnimationFrame(applyHover);
  };

  // A plain vertical wheel scrolls the strip horizontally when there is nothing to scroll vertically.
  const onWheel = (e: React.WheelEvent) => {
    const el = scrollRef.current;
    if (!el || e.shiftKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if (el.scrollHeight > el.clientHeight + 1) return;
    el.scrollLeft += e.deltaY;
  };

  const onPointerLeave = () => {
    pendingHover.current = null;
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = 0;
    if (!hoverRef.current) return;
    hoverRef.current = null;
    useStore.getState().setHovered(null);
  };

  const rootStyle = {
    '--seq-cell-w': `${CELL_W}px`,
    '--seq-row-h': `${ROW_H}px`,
    '--seq-label-w': `${LABEL_W}px`,
    height: expanded ? Math.min(contentHeight + 14, Math.round(window.innerHeight * 0.4)) : undefined,
  } as CSSProperties;

  return (
    <div className={`seq ${expanded ? 'is-expanded' : ''}`} style={rootStyle} aria-label="Sequence">
      <div
        ref={scrollRef}
        className="seq-scroll"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
      >
        <div className="seq-content" style={{ width: contentWidth, height: contentHeight }}>
          {rows.slice(r0, r1).map((row, k) => {
            const ri = r0 + k;
            const [c0, c1] = visibleWindow(vp.left, vp.width, CELL_W, row.residues.length, OVERSCAN_COLS, LABEL_W);
            const cells: React.ReactElement[] = [];
            for (let p = c0; p < c1; p++) {
              const r = row.residues[p];
              let cls = 'seq-cell';
              if (r.ss === 'helix') cls += ' ss-helix';
              else if (r.ss === 'sheet') cls += ' ss-sheet';
              if (selectedRes.has(r.resIndex)) cls += ' is-selected';
              if (r.resIndex === hoveredRes) cls += ' is-hovered';
              if (r.gapBefore) cls += ' is-gap';
              cells.push(
                <span key={p} className={cls} style={{ left: LABEL_W + p * CELL_W }} data-row={ri} data-pos={p}>
                  {r.letter}
                </span>,
              );
            }
            return (
              <div key={`${ri}:${row.chainId}`} className="seq-row" style={{ top: PAD_Y + ri * ROW_H, width: contentWidth }}>
                <div className="seq-chain" title={`Chain ${row.chainId || '(none)'} · ${row.residues.length.toLocaleString()} ${row.kind === 'nucleic' ? 'nucleotides' : 'residues'}`}>
                  <span className={`seq-chain-badge kind-${row.kind}`}>{row.chainId || '–'}</span>
                </div>
                {row.ticks
                  .filter((t) => t.pos >= c0 && t.pos < c1)
                  .map((t) => (
                    <span key={`t${t.pos}`} className="seq-tick" style={{ left: LABEL_W + t.pos * CELL_W }}>
                      {t.text}
                    </span>
                  ))}
                {cells}
              </div>
            );
          })}
        </div>
      </div>
      {contentHeight > 60 && (
        <button
          type="button"
          className="seq-expand icon-btn"
          title={expanded ? 'Collapse the sequence strip' : `Show all ${rows.length} chains`}
          aria-label={expanded ? 'Collapse sequence' : 'Expand sequence'}
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      )}
    </div>
  );
}
