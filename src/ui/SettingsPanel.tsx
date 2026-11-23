/**
 * View settings drawer/popover (store.panels.settings).
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 *
 * A non-modal drawer anchored under the TopBar's settings button (fixed, top-right). Changes apply
 * live. It closes with Escape, its × button, the settings button, or a click outside — except
 * clicks on the 3D stage, so the user can rotate the molecule to preview a change.
 */
import { useEffect, useRef } from 'react';
import { Gauge, Moon, Pipette, RotateCcw, Sun, X } from 'lucide-react';
import type { LabelMode, ViewSettings } from '../core/types';
import { DEFAULT_VIEW, THEME_BACKGROUNDS, useStore } from '../state/store';
import { Select, Toggle } from './common';
import { Segmented } from './shell/Segmented';
import './SettingsPanel.css';

const BACKGROUNDS: { color: string; name: string }[] = [
  { color: THEME_BACKGROUNDS.dark, name: 'Midnight (dark theme default)' },
  { color: '#000000', name: 'Black' },
  { color: '#1e293b', name: 'Slate' },
  { color: '#0f2438', name: 'Ocean' },
  { color: '#ffffff', name: 'White' },
  { color: THEME_BACKGROUNDS.light, name: 'Paper (light theme default)' },
  { color: '#d9dee7', name: 'Grey' },
];

const LABEL_OPTIONS: { value: LabelMode; label: string }[] = [
  { value: 'none', label: 'Off' },
  { value: 'element', label: 'Element symbol' },
  { value: 'name', label: 'Atom name' },
  { value: 'residue', label: 'Residue' },
  { value: 'serial', label: 'Serial number' },
];

export default function SettingsPanel() {
  const open = useStore((s) => s.panels.settings);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => useStore.getState().setPanel('settings', false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || !(t instanceof Element)) return;
      if (ref.current?.contains(t)) return;
      if (t.closest('[data-settings-toggle]') || t.closest('.stage')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const p = useStore.getState().panels;
      if (p.help || p.load) return; // a modal is on top; let it handle Escape
      // Escape inside another text field (e.g. the selection box) belongs to that field.
      const t = e.target as Element | null;
      if (t instanceof Element && !ref.current?.contains(t) && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.stopPropagation(); // don't also clear the selection
      close();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div ref={ref} className="settings" role="dialog" aria-label="Settings">
      <SettingsContent />
    </div>
  );
}

function SettingsContent() {
  const view = useStore((s) => s.view);
  const set = (patch: Partial<ViewSettings>) => useStore.getState().setView(patch);
  const isCustomBg = !BACKGROUNDS.some((b) => b.color.toLowerCase() === view.background.toLowerCase());

  return (
    <>
      <header className="settings-header">
        <h2>Settings</h2>
        <div className="row">
          <button
            type="button"
            className="icon-btn settings-small-btn"
            title="Reset view settings to defaults (keeps the theme)"
            aria-label="Reset settings"
            onClick={() => set({ ...DEFAULT_VIEW, theme: view.theme, background: THEME_BACKGROUNDS[view.theme] })}
          >
            <RotateCcw />
          </button>
          <button type="button" className="icon-btn settings-small-btn" title="Close (Esc)" aria-label="Close settings" onClick={() => useStore.getState().setPanel('settings', false)}>
            <X />
          </button>
        </div>
      </header>

      <div className="settings-body">
        <div className="settings-group-title">Appearance</div>

        <div className="settings-field">
          <span className="settings-label">Theme</span>
          <Segmented
            ariaLabel="Theme"
            size="sm"
            value={view.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { value: 'dark', label: 'Dark', icon: <Moon />, title: 'Dark interface' },
              { value: 'light', label: 'Light', icon: <Sun />, title: 'Light interface' },
            ]}
          />
        </div>

        <div className="settings-field settings-field-stack">
          <span className="settings-label">Background</span>
          <div className="settings-swatches" role="radiogroup" aria-label="Background color">
            {BACKGROUNDS.map((b) => {
              const checked = b.color.toLowerCase() === view.background.toLowerCase();
              return (
                <button
                  key={b.color}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={b.name}
                  title={b.name}
                  className={`settings-swatch ${checked ? 'is-checked' : ''}`}
                  style={{ background: b.color }}
                  onClick={() => set({ background: b.color })}
                />
              );
            })}
            <label
              className={`settings-swatch settings-swatch-custom ${isCustomBg ? 'is-checked' : ''}`}
              title="Custom background color"
              style={isCustomBg ? { background: view.background } : undefined}
            >
              <Pipette size={13} aria-hidden="true" />
              <input type="color" aria-label="Custom background color" value={toHex6(view.background)} onChange={(e) => set({ background: e.target.value })} />
            </label>
          </div>
        </div>

        <div className="settings-field">
          <span className="settings-label">Projection</span>
          <Segmented
            ariaLabel="Projection"
            size="sm"
            value={view.projection}
            onChange={(projection) => set({ projection })}
            options={[
              { value: 'perspective', label: 'Perspective', title: 'Natural depth perspective' },
              { value: 'orthographic', label: 'Ortho', title: 'Orthographic: no perspective distortion, sizes comparable across depth' },
            ]}
          />
        </div>

        <div className="settings-field">
          <span className="settings-label" title="Tessellation of spheres and cylinders, cartoon smoothness and surface resolution">
            <Gauge size={13} aria-hidden="true" /> Quality
          </span>
          <Segmented
            ariaLabel="Rendering quality"
            size="sm"
            value={view.quality}
            onChange={(quality) => set({ quality })}
            options={[
              { value: 'low', label: 'Low', title: 'Fastest — best for very large structures' },
              { value: 'medium', label: 'Medium', title: 'Balanced' },
              { value: 'high', label: 'High', title: 'Smoothest — for figures' },
            ]}
          />
        </div>

        <div className="settings-field">
          <span className="settings-label" title="Text labels for the selected atoms (or all atoms of small molecules when nothing is selected)">
            Labels
          </span>
          <Select
            className="settings-select"
            value={view.labelMode}
            options={LABEL_OPTIONS}
            onChange={(labelMode) => set({ labelMode })}
            title="Text labels for the selected atoms (or all atoms of small molecules when nothing is selected)"
          />
        </div>

        <div className="settings-toggles">
          <Toggle checked={view.showHydrogens} onChange={(showHydrogens) => set({ showHydrogens })} label="Show hydrogens" title="Hide hydrogens to declutter large structures (always shown in Edit mode)" />
          <Toggle checked={view.fog} onChange={(fog) => set({ fog })} label="Depth fog" title="Fade distant atoms to improve depth perception" />
          <Toggle checked={view.autoRotate} onChange={(autoRotate) => set({ autoRotate })} label="Auto-rotate" title="Slowly spin the molecule" />
        </div>

        <div className="settings-group-title">Editing</div>
        <div className="settings-toggles">
          <SettingToggle
            checked={view.showValence}
            onChange={(showValence) => set({ showValence })}
            label="Valence feedback"
            hint="Red halos for over-bonded atoms, amber stubs for open valences"
          />
          <SettingToggle
            checked={view.autoHydrogens}
            onChange={(autoHydrogens) => set({ autoHydrogens })}
            label="Automatic hydrogens"
            hint="Add or remove H on edited atoms to keep valences satisfied"
          />
          <SettingToggle
            checked={view.relaxOnDrag}
            onChange={(relaxOnDrag) => set({ relaxOnDrag })}
            label="Relax while dragging"
            hint="Neighbouring atoms follow a dragged atom (force field)"
          />
          <SettingToggle
            checked={view.snapBonds}
            onChange={(snapBonds) => set({ snapBonds })}
            label="Snap bonds"
            hint="Form a bond when a dragged atom is released next to another"
          />
        </div>
      </div>
    </>
  );
}

function SettingToggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div className="settings-toggle-with-hint">
      <Toggle checked={props.checked} onChange={props.onChange} label={props.label} title={props.hint} />
      <div className="settings-hint">{props.hint}</div>
    </div>
  );
}

/** <input type="color"> requires '#rrggbb'. */
function toHex6(c: string): string {
  const s = c.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : '#000000';
}
