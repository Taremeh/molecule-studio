/**
 * Top bar: brand, Open (opens LoadDialog), View/Edit mode switch, undo/redo, export menu, screenshot, panel toggles, theme, settings, help.
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Box,
  Camera,
  ChevronDown,
  CircleQuestionMark,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Focus,
  ImageDown,
  Moon,
  Orbit,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PenLine,
  Pencil,
  Redo2,
  RotateCcw,
  Settings2,
  Sun,
  Undo2,
} from 'lucide-react';
import { useStore } from '../state/store';
import { getTopology, isMacromolecule } from '../core/molecule';
import { getViewer } from '../render/viewerApi';
import { exportMolecule, exportScreenshot, focusSelection, newMolecule } from '../app/actions';
import type { WritableFormat } from '../io/formats';
import { WRITE_EXTENSIONS } from '../io/formats';
import { IconButton, Popover, Toggle } from './common';
import { Segmented } from './shell/Segmented';
import { LogoMark } from './shell/icons';
import { openLoadDialog } from './shell/shellStore';
import { formatShortcut, isMacPlatform } from './shell/keys';
import { formatCount } from './shell/format';
import './TopBar.css';

const MAC = isMacPlatform();
const sc = (keys: string) => formatShortcut(keys, MAC);

const EXPORT_FORMATS: { format: WritableFormat; label: string; description: string }[] = [
  { format: 'pdb', label: 'PDB', description: 'Residues, chains, B-factors' },
  { format: 'sdf', label: 'SDF / MOL', description: 'Bond orders and charges' },
  { format: 'mol2', label: 'MOL2', description: 'Atom types and bond orders' },
  { format: 'xyz', label: 'XYZ', description: 'Plain element coordinates' },
];

const IMAGE_SCALES: { scale: number; label: string; description: string }[] = [
  { scale: 1, label: 'PNG image ×1', description: 'Screen size' },
  { scale: 2, label: 'PNG image ×2', description: 'High resolution' },
  { scale: 4, label: 'PNG image ×4', description: 'Print quality' },
];

export default function TopBar() {
  const hasMolecule = useStore((s) => s.molecule !== null);
  const mode = useStore((s) => s.mode);
  const undoLabel = useStore((s) => s.past.at(-1)?.label ?? null);
  const redoLabel = useStore((s) => s.future.at(-1)?.label ?? null);
  const panels = useStore((s) => s.panels);
  const theme = useStore((s) => s.view.theme);
  const hasPolymer = useStore((s) => (s.molecule ? getTopology(s.molecule).residues.some((r) => r.kind === 'protein' || r.kind === 'nucleic') : false));
  const st = useStore.getState;

  const onMode = (m: 'view' | 'edit') => {
    if (m === 'edit' && !st().molecule) newMolecule();
    else st().setMode(m);
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="topbar-brand" title="Molecule Studio">
          <LogoMark size={24} />
          <span className="topbar-brand-name">Molecule Studio</span>
        </div>
        {hasMolecule && (
          <>
            <span className="topbar-sep" aria-hidden="true" />
            <MoleculeName />
          </>
        )}
        <button
          type="button"
          className="btn btn-sm topbar-open"
          onClick={() => openLoadDialog()}
          title={`Open a structure — samples, PDB, PubChem, AlphaFold, SMILES or a file (${sc('Ctrl/Cmd+O')})`}
        >
          <FolderOpen size={15} />
          <span>Open</span>
        </button>
      </div>

      <div className="topbar-center">
        <Segmented
          ariaLabel="Mode"
          value={mode}
          onChange={onMode}
          options={[
            { value: 'view', label: 'View', icon: <Eye />, title: `View mode — rotate, inspect, select and measure (${sc('E')})` },
            {
              value: 'edit',
              label: 'Edit',
              icon: <PenLine />,
              title: hasMolecule ? `Edit mode — add, move and delete atoms and bonds (${sc('E')})` : 'Start building a new molecule',
            },
          ]}
        />
      </div>

      <div className="topbar-right">
        <IconButton
          icon={<Undo2 />}
          title={undoLabel ? `Undo: ${undoLabel}` : 'Nothing to undo'}
          shortcut={sc('Ctrl/Cmd+Z')}
          disabled={!undoLabel}
          onClick={() => st().undo()}
        />
        <IconButton
          icon={<Redo2 />}
          title={redoLabel ? `Redo: ${redoLabel}` : 'Nothing to redo'}
          shortcut={sc('Ctrl/Cmd+Shift+Z')}
          disabled={!redoLabel}
          onClick={() => st().redo()}
        />
        <span className="topbar-divider" aria-hidden="true" />
        <ExportMenu disabled={!hasMolecule} />
        <CameraMenu disabled={!hasMolecule} />
        <span className="topbar-divider" aria-hidden="true" />
        <IconButton icon={<PanelLeft />} title={panels.left ? 'Hide selection & layers panel' : 'Show selection & layers panel'} active={panels.left} onClick={() => st().togglePanel('left')} />
        <IconButton
          icon={<PanelBottom />}
          title={hasPolymer ? (panels.sequence ? 'Hide sequence' : 'Show sequence') : 'Sequence (available for proteins and nucleic acids)'}
          active={panels.sequence && hasPolymer}
          disabled={!hasPolymer}
          onClick={() => st().togglePanel('sequence')}
        />
        <IconButton icon={<PanelRight />} title={panels.right ? 'Hide inspector panel' : 'Show inspector panel'} active={panels.right} onClick={() => st().togglePanel('right')} />
        <span className="topbar-divider" aria-hidden="true" />
        <IconButton
          icon={theme === 'dark' ? <Sun /> : <Moon />}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={() => st().setView({ theme: theme === 'dark' ? 'light' : 'dark' })}
        />
        {/* data-settings-toggle lets the settings drawer ignore this button in its outside-click handling. */}
        <span data-settings-toggle="" className="topbar-wrap">
          <IconButton icon={<Settings2 />} title="View & editing settings" active={panels.settings} onClick={() => st().togglePanel('settings')} />
        </span>
        <IconButton icon={<CircleQuestionMark />} title="Help & keyboard shortcuts" shortcut="?" active={panels.help} onClick={() => st().setPanel('help', true)} />
      </div>
    </header>
  );
}

/** Molecule name, click to rename inline (Enter saves, Escape cancels). */
function MoleculeName() {
  const name = useStore((s) => s.molecule?.name ?? '');
  const atoms = useStore((s) => s.molecule?.atoms.length ?? 0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== name) useStore.getState().setMoleculeName(v);
    setEditing(false);
  };

  return (
    <div className="topbar-name-wrap">
      {editing ? (
        <input
          ref={inputRef}
          className="topbar-name-input"
          value={draft}
          aria-label="Molecule name"
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="topbar-name"
          title="Rename molecule"
          onClick={() => {
            setDraft(name);
            setEditing(true);
          }}
        >
          <span className="topbar-name-text">{name || 'Untitled'}</span>
          <Pencil className="topbar-name-pencil" size={12} aria-hidden="true" />
        </button>
      )}
      <span className="topbar-name-meta" title={`${formatCount(atoms)} atoms`}>
        {formatCount(atoms)} {atoms === 1 ? 'atom' : 'atoms'}
      </span>
    </div>
  );
}

function ExportMenu({ disabled }: { disabled: boolean }) {
  const [transparent, setTransparent] = useState(false);
  const isMacro = useStore((s) => (s.molecule ? isMacromolecule(s.molecule) : false));
  const recommended: WritableFormat = isMacro ? 'pdb' : 'sdf';
  return (
    <Popover
      align="right"
      className="topbar-menu"
      trigger={(open, toggle) => (
        <button
          type="button"
          className={`icon-btn topbar-menu-btn ${open ? 'is-active' : ''}`}
          onClick={toggle}
          disabled={disabled}
          title={`Export structure or image (${sc('Ctrl/Cmd+S')})`}
          aria-label="Export"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Download />
          <ChevronDown className="topbar-caret" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Export">
          <div className="topbar-menu-label">Structure file</div>
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.format}
              type="button"
              role="menuitem"
              className="menu-item"
              title={`Download as .${WRITE_EXTENSIONS[f.format]} — ${f.description}`}
              onClick={() => {
                exportMolecule(f.format);
                close();
              }}
            >
              <FileText size={15} className="topbar-menu-icon" />
              <span className="topbar-menu-text">
                <span>
                  {f.label}
                  {f.format === recommended && <span className="topbar-menu-tag">Recommended</span>}
                </span>
                <span className="topbar-menu-desc">{f.description}</span>
              </span>
              <span className="menu-hint">.{WRITE_EXTENSIONS[f.format]}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <div className="topbar-menu-label">Image</div>
          {IMAGE_SCALES.map((s) => (
            <button
              key={s.scale}
              type="button"
              role="menuitem"
              className="menu-item"
              title={`Save a PNG at ${s.scale}× the viewport resolution${transparent ? ' with a transparent background' : ''}`}
              onClick={() => {
                close();
                void exportScreenshot(s.scale, transparent);
              }}
            >
              <ImageDown size={15} className="topbar-menu-icon" />
              <span className="topbar-menu-text">
                <span>{s.label}</span>
                <span className="topbar-menu-desc">{s.description}</span>
              </span>
            </button>
          ))}
          <div className="topbar-menu-toggle">
            <Toggle checked={transparent} onChange={setTransparent} label="Transparent background" title="Save images without the background color" />
          </div>
        </div>
      )}
    </Popover>
  );
}

function CameraMenu({ disabled }: { disabled: boolean }) {
  const selCount = useStore((s) => s.selection.size);
  const projection = useStore((s) => s.view.projection);
  const autoRotate = useStore((s) => s.view.autoRotate);
  const item = (icon: ReactNode, label: string, hint: string, title: string, run: () => void, close: () => void) => (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      title={title}
      onClick={() => {
        run();
        close();
      }}
    >
      {icon}
      <span>{label}</span>
      <span className="menu-hint">{hint}</span>
    </button>
  );
  return (
    <Popover
      align="right"
      className="topbar-menu"
      trigger={(open, toggle) => (
        <button
          type="button"
          className={`icon-btn topbar-menu-btn ${open ? 'is-active' : ''}`}
          onClick={toggle}
          disabled={disabled}
          title="Camera: reset, focus, look along an axis"
          aria-label="Camera"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Camera />
          <ChevronDown className="topbar-caret" />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label="Camera">
          {item(<RotateCcw size={15} />, 'Reset view', sc('R'), 'Fit the whole molecule', () => getViewer()?.resetView(), close)}
          {item(
            <Focus size={15} />,
            selCount ? 'Focus selection' : 'Fit all atoms',
            sc('F'),
            selCount ? 'Zoom to the selected atoms' : 'Zoom to the whole molecule',
            focusSelection,
            close,
          )}
          <div className="menu-sep" />
          <div className="topbar-menu-label">Look along</div>
          <div className="topbar-axes">
            {(['x', 'y', 'z'] as const).map((axis) => (
              <button
                key={axis}
                type="button"
                className={`btn btn-sm topbar-axis topbar-axis-${axis}`}
                title={`Look along the ${axis.toUpperCase()} axis`}
                onClick={() => {
                  getViewer()?.viewAlong(axis);
                  close();
                }}
              >
                {axis.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="menu-sep" />
          <div className="topbar-menu-toggle">
            <Toggle
              checked={projection === 'orthographic'}
              onChange={(v) => useStore.getState().setView({ projection: v ? 'orthographic' : 'perspective' })}
              label={
                <span className="row">
                  <Box size={14} /> Orthographic
                </span>
              }
              title="Orthographic projection (no perspective distortion) — good for comparing sizes"
            />
            <Toggle
              checked={autoRotate}
              onChange={(v) => useStore.getState().setView({ autoRotate: v })}
              label={
                <span className="row">
                  <Orbit size={14} /> Auto-rotate
                </span>
              }
              title="Slowly spin the molecule"
            />
          </div>
        </div>
      )}
    </Popover>
  );
}
