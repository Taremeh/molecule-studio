/**
 * Element quick picks + periodic table popover.
 * OWNER: edit-ui agent. See ARCHITECTURE.md § UI.
 *
 * Picking an element sets `editElement`; if the current tool does not use an element
 * (anything but add-atom / element), the add-atom tool is activated, like the element hot keys.
 */
import { useMemo, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { COMMON_ELEMENTS, getElement, type ElementInfo } from '../../core/elements';
import { readableTextColor } from './colorContrast';
import { CATEGORY_LABELS, CATEGORY_ORDER, fBlockMarkers, formatMass, formatValences, periodicCells, searchElements } from './periodicTable';
import { ELEMENT_HOTKEYS } from './hints';
import { useFitInStage } from './useFitInStage';
import { pickElement } from './editCommands';
import './ElementPalette.css';

export default function ElementPalette(props: { onPicked?: () => void } = {}) {
  const current = useStore((s) => s.editElement);
  const [hovered, setHovered] = useState<ElementInfo | null>(null);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useFitInStage(rootRef);

  const cells = useMemo(() => periodicCells(), []);
  const markers = useMemo(() => fBlockMarkers(cells), [cells]);
  const matches = useMemo(() => searchElements(query), [query]);
  const matchSet = useMemo(() => new Set(matches.map((e) => e.symbol)), [matches]);
  /** Grid rows up to the last used one; row 8 is the thin gap above the f-block. */
  const gridRows = useMemo(() => {
    const maxRow = Math.max(1, ...cells.map((c) => c.row));
    return Array.from({ length: maxRow }, (_, i) => (i + 1 === 8 ? '6px' : 'var(--ep-cell)')).join(' ');
  }, [cells]);
  const presentCategories = useMemo(() => {
    const present = new Set(cells.map((c) => c.el.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [cells]);

  const pick = (symbol: string) => {
    pickElement(symbol);
    props.onPicked?.();
  };

  const info = hovered ?? (query ? matches[0] : undefined) ?? getElement(current);

  return (
    <div className="ep" ref={rootRef} onMouseLeave={() => setHovered(null)}>
      <div className="ep-head">
        <ElementInfoCard el={info} />
        <input
          className="input ep-search"
          placeholder="Symbol, name or Z…"
          value={query}
          autoFocus
          aria-label="Search elements"
          title="Type a symbol, name or atomic number; Enter picks the first match"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) pick(matches[0].symbol);
          }}
        />
      </div>

      <div className="ep-quick" role="group" aria-label="Common elements">
        {COMMON_ELEMENTS.map((sym) => {
          const el = getElement(sym);
          const key = ELEMENT_HOTKEYS[sym];
          return (
            <button
              key={sym}
              type="button"
              className={`ep-quick-btn ${sym === current ? 'is-current' : ''}`}
              style={{ background: el.color, color: readableTextColor(el.color) }}
              title={`${el.name}${key ? ` (${key})` : ''}`}
              onClick={() => pick(sym)}
              onMouseEnter={() => setHovered(el)}
            >
              {sym}
              {key && <span className="ep-key">{key}</span>}
            </button>
          );
        })}
      </div>

      <div className={`ep-table ${query ? 'is-filtering' : ''}`} style={{ gridTemplateRows: gridRows }} aria-label="Periodic table">
        {cells.map(({ el, row, col }) => (
          <button
            key={el.symbol}
            type="button"
            className={`ep-cell cat-${el.category} ${el.symbol === current ? 'is-current' : ''} ${matchSet.has(el.symbol) ? 'is-match' : ''}`}
            style={{ gridRow: row, gridColumn: col }}
            title={`${el.number} ${el.name}`}
            onClick={() => pick(el.symbol)}
            onMouseEnter={() => setHovered(el)}
          >
            <span className="ep-cell-num">{el.number}</span>
            <span className="ep-cell-sym">{el.symbol}</span>
          </button>
        ))}
        {markers.map((m) => (
          <div key={m.title} className="ep-marker" style={{ gridRow: m.row, gridColumn: m.col }} title={`${m.title} (${m.label}) — see the rows below`}>
            {m.label}
          </div>
        ))}
      </div>

      <div className="ep-legend">
        {presentCategories.map((c) => (
          <span key={c} className="ep-legend-item">
            <span className={`ep-legend-dot cat-${c}`} />
            {CATEGORY_LABELS[c]}
          </span>
        ))}
      </div>
    </div>
  );
}

function ElementInfoCard({ el }: { el: ElementInfo }) {
  return (
    <div className="ep-info">
      <div className="ep-info-tile" style={{ background: el.color, color: readableTextColor(el.color) }}>
        <span className="ep-info-num">{el.number || ''}</span>
        <span className="ep-info-sym">{el.symbol}</span>
      </div>
      <div className="ep-info-text">
        <div className="ep-info-name">{el.name}</div>
        <div className="ep-info-meta">
          <span title="Standard atomic weight (g/mol)">{formatMass(el)} g/mol</span>
          <span title="Typical valences used by the valence check">valence {formatValences(el)}</span>
        </div>
        <div className="ep-info-cat">{CATEGORY_LABELS[el.category]}</div>
      </div>
    </div>
  );
}
