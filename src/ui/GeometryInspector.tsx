/**
 * Distance / angle / dihedral inspector for 2–4 selected atoms; editable in edit mode.
 * OWNER: edit-ui agent. See ARCHITECTURE.md § UI.
 *
 * The atom order is the selection's insertion order: 2 atoms → distance, 3 → angle (2nd = vertex),
 * 4 → dihedral (2nd–3rd = axis). In edit mode the value is changed live with a slider as ONE
 * transient edit (see edit/sliderEdit: begin on pointer down, updates computed from the transient
 * BASE molecule so repeated updates never accumulate error, end on release, Escape cancels) or typed
 * into the number field.
 */
import { useEffect, useMemo, useRef } from 'react';
import { ArrowLeftRight, Check, Pin } from 'lucide-react';
import { useStore } from '../state/store';
import { atomById, atomLabel } from '../core/molecule';
import { getElement } from '../core/elements';
import type { Molecule } from '../core/types';
import { Button, Chip, EmptyHint, NumberField, Section, Slider } from './common';
import {
  applyGeometryValue,
  BOND_ORDER_NAMES,
  deviationTone,
  formatMeasure,
  formatSigned,
  geometryEditLabel,
  geometryModel,
  isPinned,
  MEASURE_LABELS,
  measureIds,
  shortAtomLabels,
  type GeometryModel,
} from './edit/geometryModel';
import { MeasureKindIcon } from './edit/icons';
import { createSliderEdit, type SliderEdit } from './edit/sliderEdit';
import './GeometryInspector.css';

export default function GeometryInspector() {
  const molecule = useStore((s) => s.molecule);
  const selection = useStore((s) => s.selection);
  const transientBase = useStore((s) => s.transientBase);
  const mode = useStore((s) => s.mode);
  const measurements = useStore((s) => s.measurements);

  const ids = useMemo(() => [...selection], [selection]);
  const model = useMemo(
    () => (molecule && ids.length >= 2 && ids.length <= 4 ? geometryModel(molecule, ids, transientBase) : null),
    [molecule, ids, transientBase],
  );

  if (!molecule) return null;

  return (
    <Section title="Geometry" className="geo">
      {model ? (
        <GeometryEditor mol={molecule} model={model} editMode={mode === 'edit'} pinned={isPinned(measurements, model.kind, model.atomIds)} />
      ) : (
        <EmptyHint>
          {ids.length > 4
            ? `${ids.length.toLocaleString()} atoms selected — select 2 to 4 atoms to inspect a distance, angle or dihedral.`
            : 'Select 2 atoms for a distance, 3 for an angle (the 2nd is the vertex) or 4 for a dihedral. Shift-click adds atoms in order.'}
        </EmptyHint>
      )}
    </Section>
  );
}

function GeometryEditor({ mol, model, editMode, pinned }: { mol: Molecule; model: GeometryModel; editMode: boolean; pinned: boolean }) {
  const { kind, atomIds } = model;
  const labels = shortAtomLabels(mol, atomIds);
  const gestureRef = useRef<SliderEdit | null>(null);
  if (!gestureRef.current) gestureRef.current = createSliderEdit();
  const gesture = gestureRef.current;

  // Finish an unfinished slider drag if the inspector goes away (e.g. selection changed).
  useEffect(() => () => gesture.finish(), [gesture]);

  /** Undo label from the value reached at the end of the gesture. */
  const sliderLabel = (m: Molecule) => geometryEditLabel(kind, measureIds(m, atomIds));

  function sliderPointerDown(e: React.PointerEvent) {
    // Only the primary button drags the slider; a right click opens the context menu, which may
    // swallow the release and would leave the transient edit open.
    if (e.button !== 0) return;
    // A value typed into the number field commits on blur, which the browser fires only after this
    // pointer down: let it land first, so the drag continues from it instead of being cut short.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== e.target) active.blur();
    gesture.pointerDown(sliderLabel);
  }

  /** Live slider update, always computed from the transient base to avoid drift. */
  function slide(v: number) {
    gesture.change(sliderLabel, (base) => applyGeometryValue(base, kind, atomIds, v));
  }

  /**
   * Apply a typed / preset value as one undoable edit. `tolerance` skips no-op commits (the number
   * field also commits on blur with the unchanged, rounded value).
   */
  function commitValue(v: number, tolerance = 0) {
    const s = useStore.getState();
    if (!s.molecule) return;
    let diff = Math.abs(v - measureIds(s.molecule, atomIds));
    if (kind === 'dihedral') diff = Math.min(diff, 360 - diff); // −180° and 180° are the same dihedral
    if (diff <= tolerance) return;
    const next = applyGeometryValue(s.molecule, kind, atomIds, v);
    if (next === s.molecule) return;
    s.commit(next, geometryEditLabel(kind, v));
  }

  const bond = model.bond;
  const tone = bond ? deviationTone(bond.deviation) : undefined;
  const canEdit = editMode && model.editable;
  const roles = kind === 'angle' ? ['', 'vertex', ''] : kind === 'dihedral' ? ['', 'axis', 'axis', ''] : [];

  return (
    <div className="geo-body">
      <div className="geo-kind">
        <MeasureKindIcon kind={kind} size={15} />
        <span>{MEASURE_LABELS[kind]}</span>
        {bond && <span className="geo-bond-tag">{BOND_ORDER_NAMES[bond.order]} bond</span>}
      </div>

      <div className="geo-atoms">
        {atomIds.map((id, i) => {
          const a = atomById(mol, id);
          return (
            <span key={id} className="geo-atom">
              {i > 0 && <span className="geo-dash">–</span>}
              <Chip color={a ? getElement(a.element).color : undefined} title={`${i + 1}. ${atomLabel(mol, id)}${roles[i] ? ` (${roles[i]})` : ''}`}>
                {labels[i]}
                {roles[i] && <span className="geo-role">{roles[i]}</span>}
              </Chip>
            </span>
          );
        })}
      </div>

      <div className="geo-value-row">
        <span className="geo-value">{formatMeasure(kind, model.value, true)}</span>
        {bond && (
          <span className={`geo-dev is-${tone}`} title={`Typical bond length for this pair and bond order: ${bond.ideal.toFixed(3)} Å (what Clean geometry relaxes to)`}>
            {bond.deviation >= 0 ? '+' : ''}
            {formatSigned(bond.deviation, 3)} Å vs ideal {bond.ideal.toFixed(2)} Å
          </span>
        )}
      </div>

      {editMode && (
        <div className={`geo-edit ${canEdit ? '' : 'is-disabled'}`}>
          <div className="geo-slider" onPointerDownCapture={canEdit ? sliderPointerDown : undefined}>
            <Slider
              value={clamp(model.value, model.min, model.max)}
              min={model.min}
              max={model.max}
              step={model.step}
              disabled={!canEdit}
              onChange={slide}
              onCommit={() => gesture.keyUp()}
            />
          </div>
          <NumberField
            value={model.value}
            min={model.min}
            max={kind === 'distance' ? 100 : model.max}
            digits={model.digits}
            unit={model.unit}
            disabled={!canEdit}
            title={`Type a ${kind} and press Enter`}
            onCommit={(v) => commitValue(v, 0.5 * 10 ** -model.digits)}
          />
        </div>
      )}

      {editMode && canEdit && model.presets.length > 0 && (
        <div className="geo-presets">
          {model.presets.map((p) => (
            <Chip key={p.label} title={`${p.title} — set to ${formatMeasure(kind, p.value)}`} onClick={() => commitValue(p.value, 1e-9)}>
              {p.label}
            </Chip>
          ))}
        </div>
      )}

      {editMode && !model.editable && model.reason && <div className="geo-reason">{model.reason}</div>}
      {editMode && model.editable && model.note && <div className="geo-note">{model.note}</div>}
      {!editMode && <div className="geo-note">Switch to Edit mode (E) to change this {kind}.</div>}

      <div className="geo-actions">
        <Button
          small
          icon={pinned ? <Check size={14} /> : <Pin size={14} />}
          disabled={pinned}
          title={pinned ? 'Already in the measurements list' : 'Keep this measurement in the 3D view and the measurements list'}
          onClick={() => useStore.getState().addMeasurement(kind, atomIds)}
        >
          {pinned ? 'Pinned' : 'Pin as measurement'}
        </Button>
        {editMode && (
          <Button
            small
            variant="ghost"
            icon={<ArrowLeftRight size={14} />}
            title="Reverse the atom order, so the other end moves when the value is changed"
            onClick={() => useStore.getState().setSelection([...atomIds].reverse())}
          >
            Reverse
          </Button>
        )}
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
