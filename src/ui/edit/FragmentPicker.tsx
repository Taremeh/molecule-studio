/**
 * Fragment template picker.
 * OWNER: edit-ui agent. See ARCHITECTURE.md § UI.
 *
 * Grid of FRAGMENTS grouped by category; each tile shows a small 2D drawing, the short label and
 * the name. Picking a fragment selects it and activates the fragment tool.
 */
import { memo, useMemo, useRef } from 'react';
import { useStore } from '../../state/store';
import { FRAGMENTS, type FragmentTemplate } from '../../core/templates';
import { getElement } from '../../core/elements';
import { sketchFragment, type FragmentSketch } from './fragmentSketch';
import { ensureContrast } from './colorContrast';
import { pickFragment } from './editCommands';
import { useFitInStage } from './useFitInStage';
import './FragmentPicker.css';

const CATEGORY_TITLES: Record<FragmentTemplate['category'], string> = {
  ring: 'Rings',
  group: 'Functional groups',
  chain: 'Chains',
  biomolecule: 'Biomolecules',
};
const CATEGORY_ORDER: FragmentTemplate['category'][] = ['ring', 'group', 'chain', 'biomolecule'];

/** Tile background per theme (matches --bg-elev-2) — used to keep heteroatom labels legible. */
const TILE_BG = { dark: '#182033', light: '#f0f3f9' } as const;

export default function FragmentPicker(props: { onPicked?: () => void } = {}) {
  const current = useStore((s) => s.editFragment);
  const theme = useStore((s) => s.view.theme);
  const rootRef = useRef<HTMLDivElement>(null);
  useFitInStage(rootRef);

  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({ cat, items: FRAGMENTS.filter((f) => f.category === cat) })).filter((g) => g.items.length > 0),
    [],
  );

  return (
    <div className="fp" ref={rootRef}>
      {groups.length === 0 && <div className="empty-hint">No fragment templates available.</div>}
      {groups.map((g) => (
        <section key={g.cat} className="fp-group">
          <h4 className="fp-group-title">{CATEGORY_TITLES[g.cat]}</h4>
          <div className="fp-grid">
            {g.items.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`fp-tile ${t.id === current ? 'is-current' : ''}`}
                title={t.description ? `${t.name} — ${t.description}` : t.name}
                aria-pressed={t.id === current}
                onClick={() => {
                  pickFragment(t.id);
                  props.onPicked?.();
                }}
              >
                <FragmentPreview template={t} theme={theme} />
                <span className="fp-label">{t.label}</span>
                <span className="fp-name">{t.name}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      <div className="fp-foot">Click an atom to attach (its hydrogen is replaced) or empty space to place.</div>
    </div>
  );
}

const sketchCache = new WeakMap<FragmentTemplate, FragmentSketch>();
function getSketch(t: FragmentTemplate): FragmentSketch {
  let s = sketchCache.get(t);
  if (!s) {
    s = sketchFragment(t, 44, 30, 5);
    sketchCache.set(t, s);
  }
  return s;
}

/** Line drawing of a fragment's heavy atoms (attachment shown as a dashed accent stub). */
export const FragmentPreview = memo(function FragmentPreview({ template, theme }: { template: FragmentTemplate; theme: 'dark' | 'light' }) {
  const s = getSketch(template);
  if (s.text !== undefined) {
    return (
      <svg className="fp-preview" width={s.width} height={s.height} viewBox={`0 0 ${s.width} ${s.height}`} aria-hidden="true">
        <line className="fp-stub" x1={4} y1={s.height / 2} x2={12} y2={s.height / 2} />
        <text className="fp-preview-text" x={14} y={s.height / 2} dominantBaseline="central">
          {s.text}
        </text>
      </svg>
    );
  }
  const bg = TILE_BG[theme];
  return (
    <svg className="fp-preview" width={s.width} height={s.height} viewBox={`0 0 ${s.width} ${s.height}`} aria-hidden="true">
      {s.stub && <line className="fp-stub" x1={s.stub.x1} y1={s.stub.y1} x2={s.stub.x2} y2={s.stub.y2} />}
      {s.bonds.map((b, i) => (
        <g key={i} className="fp-bond">
          {bondLines(b.x1, b.y1, b.x2, b.y2, b.nx, b.ny, b.order, b.inner).map((l, j) => (
            <line key={j} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} strokeDasharray={l[4] ? '1.6 1.4' : undefined} />
          ))}
        </g>
      ))}
      {s.atoms.map((a, i) =>
        a.label ? (
            <g key={i}>
              <circle className="fp-mask" cx={a.x} cy={a.y} r={a.label.length > 1 ? 5.5 : 4.2} />
              <text
                className="fp-atom"
                x={a.x}
                y={a.y}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ fill: ensureContrast(getElement(a.element).color, bg, 3) }}
              >
                {a.label}
              </text>
            </g>
        ) : null,
      )}
    </svg>
  );
});

type Seg = [number, number, number, number, boolean];

/** Screen-space line segments for a bond of the given order (inner = second line on the ring side). */
function bondLines(x1: number, y1: number, x2: number, y2: number, nx: number, ny: number, order: number, inner: boolean): Seg[] {
  if (order === 1) return [[x1, y1, x2, y2, false]];
  if (order === 3) {
    const o = 2;
    return [
      [x1, y1, x2, y2, false],
      [x1 + nx * o, y1 + ny * o, x2 + nx * o, y2 + ny * o, false],
      [x1 - nx * o, y1 - ny * o, x2 - nx * o, y2 - ny * o, false],
    ];
  }
  const dashed = order === 1.5;
  if (inner) {
    // Main line plus a shortened parallel line inside the ring.
    const o = 2.6;
    const t = 0.18;
    const dx = x2 - x1;
    const dy = y2 - y1;
    return [
      [x1, y1, x2, y2, false],
      [x1 + dx * t + nx * o, y1 + dy * t + ny * o, x2 - dx * t + nx * o, y2 - dy * t + ny * o, dashed],
    ];
  }
  const o = 1.3;
  return [
    [x1 + nx * o, y1 + ny * o, x2 + nx * o, y2 + ny * o, false],
    [x1 - nx * o, y1 - ny * o, x2 - nx * o, y2 - ny * o, dashed],
  ];
}
