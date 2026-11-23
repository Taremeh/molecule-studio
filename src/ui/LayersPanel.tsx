/**
 * Representation layers list (style, color, selection, opacity, visibility, reorder, duplicate, delete) + add-layer presets + color legend.
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 *
 * A layer (VMD: "representation") = WHICH atoms (selection query) × HOW they are drawn (style,
 * color, size, opacity). Layers stack, e.g. cartoon for the protein + sticks for the ligand.
 * Each card shows a one-line summary when collapsed and the full controls when expanded.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, CircleAlert, Copy, Eye, EyeOff, Plus, Trash, Undo2 } from 'lucide-react';
import type { ColorScheme, Molecule, Representation } from '../core/types';
import { useStore } from '../state/store';
import { evaluateSelection, maskToIds } from '../core/selection';
import { COLOR_SCHEME_LABELS, colorLegend } from '../render/colors';
import { EmptyHint, IconButton, Popover, Section, Select, Slider } from './common';
import { REP_STYLE_INFO, REP_STYLE_ORDER, StyleIcon } from './shell/icons';
import { drawnAtomCount, layerPresets, maskHasPolymer } from './shell/layerPresets';
import { useMoleculeForQuery, useRafThrottle, useStructureMolecule } from './shell/hooks';
import { useShell } from './shell/shellStore';
import { idsToQuery, mentionsSelected } from './shell/query';
import { formatCount, plural } from './shell/format';
import './LayersPanel.css';

const COLOR_OPTIONS = (Object.keys(COLOR_SCHEME_LABELS) as ColorScheme[]).map((value) => ({ value, label: COLOR_SCHEME_LABELS[value] }));
/** Schemes rendered as a continuous gradient in the legend. */
const GRADIENT_SCHEMES = new Set<ColorScheme>(['bfactor', 'rainbow', 'hydrophobicity']);

export default function LayersPanel() {
  const reps = useStore((s) => s.reps);
  const mol = useStructureMolecule();
  const layerOpen = useShell((s) => s.layerOpen);
  const [deleted, setDeleted] = useState<{ rep: Representation; index: number } | null>(null);

  // The "deleted — undo" bar disappears after a few seconds.
  useEffect(() => {
    if (!deleted) return;
    const t = setTimeout(() => setDeleted(null), 6000);
    return () => clearTimeout(t);
  }, [deleted]);
  // ...and when another document is loaded.
  const documentId = useStore((s) => s.documentId);
  useEffect(() => setDeleted(null), [documentId]);

  const onDelete = (rep: Representation, index: number) => {
    useStore.getState().removeRep(rep.id);
    setDeleted({ rep, index });
  };

  const restore = () => {
    if (!deleted) return;
    const cur = useStore.getState().reps;
    const i = Math.min(deleted.index, cur.length);
    useStore.getState().setReps([...cur.slice(0, i), deleted.rep, ...cur.slice(i)]);
    setDeleted(null);
  };

  const hasAtoms = !!mol && mol.atoms.length > 0;

  return (
    <Section
      className="layers"
      title={
        <span className="layers-title">
          Layers {reps.length > 0 && <span className="layers-title-count">{reps.length}</span>}
        </span>
      }
      actions={<AddLayerMenu mol={mol} disabled={!mol} />}
    >
      {!mol ? (
        <EmptyHint>Layers control how atoms are drawn. Load a molecule to get started.</EmptyHint>
      ) : reps.length === 0 ? (
        <div className="layers-empty">
          <EmptyHint>No layers — nothing is drawn. Add one with the + button.</EmptyHint>
        </div>
      ) : (
        <div className="layers-list">
          {reps.map((rep, i) => (
            <LayerCard
              key={rep.id}
              rep={rep}
              index={i}
              total={reps.length}
              mol={mol}
              open={layerOpen[rep.id] ?? (reps.length <= 2 && i === 0)}
              onToggle={(open) => useShell.getState().setLayerOpen(rep.id, open)}
              onDelete={() => onDelete(rep, i)}
            />
          ))}
        </div>
      )}
      {deleted && (
        <div className="layers-undo" role="status">
          <span>Deleted “{deleted.rep.name ?? REP_STYLE_INFO[deleted.rep.style].label}”</span>
          <button type="button" className="layers-undo-btn" onClick={restore} title="Restore the deleted layer">
            <Undo2 size={13} /> Undo
          </button>
        </div>
      )}
      {hasAtoms && (
        <p className="layers-explainer">
          Each layer draws a set of atoms in one style. Stack layers to combine views — e.g. a cartoon for the protein plus sticks for its ligand.
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Add-layer menu
// ---------------------------------------------------------------------------

function AddLayerMenu({ mol, disabled }: { mol: Molecule | null; disabled: boolean }) {
  const selection = useStore((s) => s.selection);
  const presets = useMemo(() => layerPresets(mol, selection), [mol, selection]);
  return (
    <Popover
      align="right"
      className="layers-menu"
      trigger={(open, toggle) => (
        <button
          type="button"
          className={`btn btn-sm btn-ghost layers-add-btn ${open ? 'is-active' : ''}`}
          onClick={toggle}
          disabled={disabled}
          title="Add a layer from a preset"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Plus size={14} />
          <span>Add</span>
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Add layer">
          <div className="layers-menu-label">Add layer</div>
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className="menu-item layers-menu-item"
              disabled={!!p.disabledReason}
              title={p.disabledReason ?? p.description}
              onClick={() => {
                const id = useStore.getState().addRep(p.rep);
                useShell.getState().setLayerOpen(id, true);
                close();
              }}
            >
              <span className="layers-menu-icon">
                <StyleIcon style={p.style} />
              </span>
              <span className="layers-menu-text">
                <span>{p.label}</span>
                <span className="layers-menu-desc">{p.disabledReason ?? p.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Layer card
// ---------------------------------------------------------------------------

function LayerCard(props: {
  rep: Representation;
  index: number;
  total: number;
  mol: Molecule;
  open: boolean;
  onToggle: (open: boolean) => void;
  onDelete: () => void;
}) {
  const { rep, mol, open } = props;
  const update = (patch: Partial<Representation>) => useStore.getState().updateRep(rep.id, patch);
  const evalMol = useMoleculeForQuery(rep.selection) ?? mol;
  const committed = useMemo(() => evaluateSelection(evalMol, rep.selection), [evalMol, rep.selection]);
  // Hidden hydrogens (View mode, "Show hydrogens" off) are not drawn, so they are not counted.
  const hideH = useStore((s) => !s.view.showHydrogens && s.mode === 'view');
  const drawn = useMemo(
    () => (committed.error || !hideH ? committed.count : drawnAtomCount(evalMol, committed.mask, true)),
    [committed, evalMol, hideH],
  );
  const hiddenH = committed.count - drawn;
  const styleInfo = REP_STYLE_INFO[rep.style];
  const displayName = rep.name ?? styleInfo.label;

  return (
    <div className={`layers-card ${rep.visible ? '' : 'is-hidden'} ${open ? 'is-open' : ''}`}>
      <div
        className="layers-card-head"
        onClick={(e) => {
          // Clicks on the header background toggle the card; controls handle their own clicks.
          if ((e.target as HTMLElement).closest('button, input')) return;
          props.onToggle(!open);
        }}
      >
        <button
          type="button"
          className="layers-eye"
          aria-pressed={rep.visible}
          title={rep.visible ? 'Hide this layer' : 'Show this layer'}
          onClick={() => update({ visible: !rep.visible })}
        >
          {rep.visible ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <span className="layers-style-badge" title={styleInfo.label}>
          <StyleIcon style={rep.style} />
        </span>
        <LayerName rep={rep} placeholder={styleInfo.label} />
        <span
          className={`layers-count ${committed.error ? 'is-error' : drawn === 0 ? 'is-zero' : ''}`}
          title={
            committed.error
              ? `Invalid selection: ${committed.error}`
              : `${plural(drawn, 'atom')} in this layer${hiddenH > 0 ? ` · ${plural(hiddenH, 'hydrogen')} hidden (Show hydrogens is off in Settings)` : ''}`
          }
        >
          {committed.error ? <CircleAlert size={12} /> : formatCount(drawn)}
        </span>
        <button
          type="button"
          className="layers-chevron"
          aria-expanded={open}
          title={open ? 'Collapse layer settings' : 'Edit layer: atoms, style, color, size'}
          onClick={() => props.onToggle(!open)}
        >
          <ChevronDown size={15} />
        </button>
      </div>

      {!open && (
        <button type="button" className="layers-summary" onClick={() => props.onToggle(true)} title="Edit layer">
          <span>{styleInfo.label}</span>
          <span className="layers-summary-sep">·</span>
          <span>{COLOR_SCHEME_LABELS[rep.color]}</span>
          {rep.color === 'uniform' && <span className="layers-summary-dot" style={{ background: rep.uniformColor }} />}
          <span className="layers-summary-sep">·</span>
          <code className="layers-summary-query">{rep.selection || 'all'}</code>
        </button>
      )}

      {open && <LayerBody {...props} committedCount={committed.count} committedMask={committed.error ? null : committed.mask} displayName={displayName} update={update} />}
    </div>
  );
}

/** Inline-editable layer name (commits on Enter / blur, Escape reverts). */
function LayerName({ rep, placeholder }: { rep: Representation; placeholder: string }) {
  const [draft, setDraft] = useState(rep.name ?? '');
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(rep.name ?? '');
  }, [rep.name]);
  const commit = () => {
    const v = draft.trim();
    const next = v || undefined;
    if (next !== rep.name) useStore.getState().updateRep(rep.id, { name: next });
    if (!v) setDraft('');
  };
  return (
    <input
      className="layers-name"
      value={draft}
      placeholder={placeholder}
      aria-label="Layer name"
      title="Rename layer"
      maxLength={60}
      spellCheck={false}
      onFocus={(e) => {
        focused.current = true;
        cancelled.current = false;
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        if (cancelled.current) setDraft(rep.name ?? '');
        else commit();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function LayerBody(props: {
  rep: Representation;
  index: number;
  total: number;
  mol: Molecule;
  committedCount: number;
  committedMask: Uint8Array | null;
  displayName: string;
  update: (patch: Partial<Representation>) => void;
  onDelete: () => void;
}) {
  const { rep, mol, update } = props;
  const st = useStore.getState;
  const throttled = useRafThrottle((patch: Partial<Representation>) => st().updateRep(rep.id, patch));

  // Local slider / color values so dragging is smooth; store updates are coalesced per frame.
  const [opacity, setOpacity] = useState(rep.opacity);
  const [scale, setScale] = useState(rep.scale);
  const [color, setColor] = useState(rep.uniformColor);
  useEffect(() => setOpacity(rep.opacity), [rep.opacity]);
  useEffect(() => setScale(rep.scale), [rep.scale]);
  useEffect(() => setColor(rep.uniformColor), [rep.uniformColor]);

  const cartoonWithoutPolymer = rep.style === 'cartoon' && props.committedMask !== null && props.committedCount > 0 && !maskHasPolymer(mol, props.committedMask);

  return (
    <div className="layers-body">
      <div className="layers-field">
        <span className="layers-label">Atoms</span>
        <LayerQuery rep={rep} mol={mol} />
      </div>

      <div className="layers-field">
        <span className="layers-label">Style</span>
        <div className="layers-styles" role="radiogroup" aria-label="Drawing style">
          {REP_STYLE_ORDER.map((style) => {
            const info = REP_STYLE_INFO[style];
            const checked = rep.style === style;
            return (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={info.label}
                title={`${info.label} — ${info.description}`}
                className={`layers-style ${checked ? 'is-checked' : ''}`}
                onClick={() => !checked && update({ style })}
              >
                <StyleIcon style={style} size={17} />
              </button>
            );
          })}
        </div>
        <span className="layers-style-name">{REP_STYLE_INFO[rep.style].label}</span>
      </div>
      {cartoonWithoutPolymer && (
        <div className="layers-note">
          <CircleAlert size={13} /> Cartoon draws protein and nucleic-acid backbones — these atoms have none. Try Ball & stick or Sticks.
        </div>
      )}

      <div className="layers-field">
        <span className="layers-label">Color</span>
        <div className="layers-color-row">
          <Select className="layers-select" value={rep.color} options={COLOR_OPTIONS} onChange={(c) => update({ color: c })} title="Color scheme" />
          {rep.color === 'uniform' && (
            <label className="layers-color-swatch" title="Pick the layer color" style={{ background: color }}>
              <input
                type="color"
                value={color}
                aria-label="Layer color"
                onChange={(e) => {
                  setColor(e.target.value);
                  throttled({ uniformColor: e.target.value });
                }}
              />
            </label>
          )}
        </div>
      </div>
      <Legend mol={mol} scheme={rep.color} uniformColor={rep.uniformColor} />

      <div className="layers-sliders">
        <Slider
          label="Opacity"
          min={0.05}
          max={1}
          step={0.05}
          value={opacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => {
            setOpacity(v);
            throttled({ opacity: v });
          }}
        />
        <Slider
          label="Size"
          min={0.3}
          max={2.5}
          step={0.05}
          value={scale}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => {
            setScale(v);
            throttled({ scale: v });
          }}
        />
      </div>

      <div className="layers-card-actions">
        <IconButton icon={<ChevronUp />} title="Move layer up" disabled={props.index === 0} onClick={() => st().moveRep(rep.id, -1)} className="layers-action" />
        <IconButton icon={<ChevronDown />} title="Move layer down" disabled={props.index === props.total - 1} onClick={() => st().moveRep(rep.id, 1)} className="layers-action" />
        <span className="grow" />
        <IconButton
          icon={<Copy />}
          title="Duplicate layer"
          onClick={() => {
            st().duplicateRep(rep.id);
            // The copy is inserted right after this layer — open it so it can be tweaked.
            const reps = st().reps;
            const copy = reps[reps.findIndex((r) => r.id === rep.id) + 1];
            if (copy) useShell.getState().setLayerOpen(copy.id, true);
          }}
          className="layers-action"
        />
        <IconButton icon={<Trash />} title={`Delete layer “${props.displayName}”`} onClick={props.onDelete} className="layers-action layers-delete" />
      </div>
    </div>
  );
}

/**
 * Selection-query field with live validation. The count/error follows the draft as you type;
 * the layer updates on Enter or blur (if valid). Escape reverts.
 */
function LayerQuery({ rep, mol }: { rep: Representation; mol: Molecule }) {
  const [draft, setDraft] = useState(rep.selection);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(rep.selection);
  }, [rep.selection]);

  const deferred = useDeferredValue(draft);
  const evalMol = useMoleculeForQuery(deferred) ?? mol;
  const result = useMemo(() => evaluateSelection(evalMol, deferred.trim() || 'all'), [evalMol, deferred]);
  const dirty = draft.trim() !== rep.selection.trim();
  const usesSel = mentionsSelected(deferred);

  const commit = () => {
    const q = draft.trim() || 'all';
    if (q === rep.selection.trim()) return;
    const live = useStore.getState();
    const target = live.molecule ?? mol;
    if (mentionsSelected(q)) {
      // Layers are not re-evaluated when the selection changes: freeze the current selection into ids.
      const res = evaluateSelection(target, q, { selectedIds: live.selection });
      if (res.error) return;
      const frozen = idsToQuery(maskToIds(target, res.mask));
      setDraft(frozen);
      live.updateRep(rep.id, { selection: frozen });
      live.toast('Layers can’t follow the live selection — saved the currently selected atoms instead', 'info', 4000);
      return;
    }
    if (evaluateSelection(target, q).error) return; // keep the invalid draft visible with its error
    if (q !== draft) setDraft(q);
    live.updateRep(rep.id, { selection: q });
  };

  const error = usesSel ? undefined : result.error;
  return (
    <div className="layers-query">
      <div className="layers-query-box">
        <input
          className={`input layers-query-input ${error ? 'is-error' : ''}`}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-label="Atoms in this layer (selection query)"
          aria-invalid={!!error}
          title="Which atoms this layer draws, e.g. protein, ligand, chain A, resname HEM, within 5 of ligand. Enter applies, Esc reverts."
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(rep.selection);
            }
          }}
        />
        {!error && (
          <span className="layers-query-count" title={usesSel ? 'Uses the current selection' : `${plural(result.count, 'atom')} match`}>
            {usesSel ? 'sel' : formatCount(result.count)}
          </span>
        )}
      </div>
      {error ? (
        <div className="layers-query-error">
          <CircleAlert size={12} /> {error}
        </div>
      ) : dirty ? (
        <div className="layers-query-hint">Press Enter to apply · Esc to revert</div>
      ) : null}
    </div>
  );
}

function Legend({ mol, scheme, uniformColor }: { mol: Molecule; scheme: ColorScheme; uniformColor: string }) {
  const entries = useMemo(() => colorLegend(mol, scheme, uniformColor), [mol, scheme, uniformColor]);
  if (entries.length === 0 || scheme === 'uniform') return null;
  if (GRADIENT_SCHEMES.has(scheme) && entries.length >= 2) {
    const gradient = `linear-gradient(to right, ${entries.map((e) => e.color).join(', ')})`;
    return (
      <div className="layers-legend layers-legend-gradient" aria-label={`${COLOR_SCHEME_LABELS[scheme]} legend`}>
        <div className="layers-gradient" style={{ background: gradient }} />
        <div className="layers-gradient-labels">
          {entries.map((e, i) => (
            <span key={i}>{e.label}</span>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="layers-legend" aria-label={`${COLOR_SCHEME_LABELS[scheme]} legend`}>
      {entries.slice(0, 12).map((e, i) => (
        <span key={i} className="layers-legend-item" title={e.label}>
          <span className="layers-legend-dot" style={{ background: e.color }} />
          {e.label}
        </span>
      ))}
    </div>
  );
}
