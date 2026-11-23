/**
 * Measurement list with live values.
 * OWNER: edit-ui agent. See ARCHITECTURE.md § UI.
 *
 * Segmented control to start measuring (activates the measure tool with that kind), progress of the
 * pending pick, and the list: live value, hover → highlight the atoms in 3D, click → focus them,
 * delete, copy all as tab-separated text, clear all.
 */
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Copy, Trash2, X } from 'lucide-react';
import { useStore } from '../state/store';
import { atomLabel } from '../core/molecule';
import type { MeasureKind, Measurement } from '../core/types';
import { getViewer } from '../render/viewerApi';
import { EmptyHint, IconButton, Section } from './common';
import { compactAtomLabels, formatMeasure, MEASURE_LABELS, measureIds } from './edit/geometryModel';
import { MEASURE_ATOM_COUNT, measureProgressHint, TOOL_SHORTCUTS } from './edit/hints';
import { MeasureKindIcon } from './edit/icons';
import { showTemporaryHighlight } from './edit/overlayHighlight';
import './MeasurementsPanel.css';

const KINDS: MeasureKind[] = ['distance', 'angle', 'dihedral'];

export default function MeasurementsPanel() {
  const molecule = useStore((s) => s.molecule);
  const measurements = useStore((s) => s.measurements);
  const { tool, measureKind, pendingCount } = useStore(
    useShallow((s) => ({ tool: s.tool, measureKind: s.measureKind, pendingCount: s.pendingMeasure.length })),
  );
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Live values: recomputed whenever the molecule (coordinates) or the list changes.
  const rows = useMemo(() => {
    if (!molecule) return [];
    return measurements.map((m) => ({
      m,
      value: measureIds(molecule, m.atomIds),
      text: compactAtomLabels(molecule, m.atomIds, (id) => atomLabel(molecule, id)),
      full: m.atomIds.map((id) => atomLabel(molecule, id)).join('  –  '),
    }));
  }, [molecule, measurements]);

  // Highlight the hovered measurement's atoms in the 3D view (on top of the editor's own overlay);
  // remove the highlight again when the hover ends or the row goes away.
  const hovered = measurements.find((m) => m.id === hoverId);
  const hoveredKey = hovered ? hovered.atomIds.join(',') : '';
  useEffect(() => {
    if (!hoveredKey) return;
    return showTemporaryHighlight(hoveredKey.split(',').map(Number), 'target');
  }, [hoveredKey]);

  if (!molecule) return null;

  const measuring = tool === 'measure';
  const startMeasuring = (k: MeasureKind) => {
    const s = useStore.getState();
    if (s.tool === 'measure' && s.measureKind === k) {
      s.setTool('select');
      return;
    }
    s.setMeasureKind(k);
    s.setTool('measure');
  };

  const copyAll = async () => {
    const lines = ['Kind\tAtoms\tValue\tUnit', ...rows.map((r) => `${r.m.kind}\t${r.full}\t${r.value.toFixed(r.m.kind === 'distance' ? 3 : 2)}\t${r.m.kind === 'distance' ? 'Å' : 'deg'}`)];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      useStore.getState().toast(`Copied ${rows.length} measurement${rows.length === 1 ? '' : 's'}`, 'success', 1800);
    } catch {
      useStore.getState().toast('Could not access the clipboard', 'error');
    }
  };

  return (
    <Section
      title={`Measurements${measurements.length ? ` · ${measurements.length}` : ''}`}
      className="meas"
      actions={
        measurements.length > 0 && (
          <>
            <IconButton icon={<Copy size={15} />} title="Copy all measurements as a table" onClick={() => void copyAll()} />
            <IconButton icon={<Trash2 size={15} />} title="Remove all measurements" onClick={() => useStore.getState().clearMeasurements()} />
          </>
        )
      }
    >
      <div className="meas-kinds" role="radiogroup" aria-label="New measurement">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={measuring && measureKind === k}
            className={`meas-kind ${measuring && measureKind === k ? 'is-active' : ''}`}
            title={`Measure ${MEASURE_LABELS[k].toLowerCase()}: click ${MEASURE_ATOM_COUNT[k]} atoms in the 3D view (${TOOL_SHORTCUTS.measure})`}
            onClick={() => startMeasuring(k)}
          >
            <MeasureKindIcon kind={k} size={14} />
            {MEASURE_LABELS[k]}
          </button>
        ))}
      </div>

      {measuring && (
        <div className="meas-pending">
          <span className="meas-dots" aria-hidden="true">
            {Array.from({ length: MEASURE_ATOM_COUNT[measureKind] }, (_, i) => (
              <span key={i} className={`meas-dot ${i < pendingCount ? 'is-done' : i === pendingCount ? 'is-next' : ''}`} />
            ))}
          </span>
          <span className="meas-pending-text">{measureProgressHint(measureKind, pendingCount)}</span>
          {pendingCount > 0 && (
            <button type="button" className="meas-link" onClick={() => useStore.getState().setPendingMeasure([])} title="Discard the atoms picked so far">
              Reset
            </button>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        !measuring && <EmptyHint>No measurements yet. Pick a kind above, or select atoms and use “Pin as measurement”.</EmptyHint>
      ) : (
        <ul className="meas-list">
          {rows.map(({ m, value, text, full }) => (
            <MeasurementRow
              key={m.id}
              m={m}
              value={value}
              text={text}
              full={full}
              hovered={m.id === hoverId}
              onHover={(on) => setHoverId(on ? m.id : null)}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function MeasurementRow(props: {
  m: Measurement;
  value: number;
  text: string;
  full: string;
  hovered: boolean;
  onHover: (on: boolean) => void;
}) {
  const { m, value, text, full } = props;
  return (
    <li
      className={`meas-row ${props.hovered ? 'is-hovered' : ''}`}
      onMouseEnter={() => props.onHover(true)}
      onMouseLeave={() => props.onHover(false)}
    >
      <button
        type="button"
        className="meas-main"
        title={`${MEASURE_LABELS[m.kind]}: ${full}\nClick to focus`}
        onClick={() => getViewer()?.focusAtoms(m.atomIds, true)}
      >
        <span className={`meas-icon kind-${m.kind}`}>
          <MeasureKindIcon kind={m.kind} size={14} />
        </span>
        <span className="meas-atoms">{text}</span>
        <span className="meas-value">{formatMeasure(m.kind, value)}</span>
      </button>
      <button
        type="button"
        className="meas-delete"
        title="Remove measurement"
        aria-label="Remove measurement"
        onClick={() => {
          props.onHover(false);
          useStore.getState().removeMeasurement(m.id);
        }}
      >
        <X size={14} />
      </button>
    </li>
  );
}
