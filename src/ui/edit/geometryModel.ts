/**
 * View model for the geometry inspector and the measurements list: live values of distances /
 * angles / dihedrals between atom ids, formatting, slider ranges, presets, and whether (and how)
 * the value can be edited with the core edit operations.
 * OWNER: edit-ui.
 */
import type { BondOrder, MeasureKind, Measurement, Molecule, Vec3 } from '../../core/types';
import { atomById, bondBetween, getTopology } from '../../core/molecule';
import { angle, dihedral, distance, idealBondLengthInMolecule } from '../../core/geometry';
import { isBondInRing } from '../../core/chemistry';
import { canSetDihedral, setAngle, setDihedral, setDistance } from '../../core/edit';
import { MEASURE_ATOM_COUNT } from './hints';

export const MEASURE_LABELS: Record<MeasureKind, string> = { distance: 'Distance', angle: 'Angle', dihedral: 'Dihedral' };

export function kindForCount(n: number): MeasureKind | null {
  return n === 2 ? 'distance' : n === 3 ? 'angle' : n === 4 ? 'dihedral' : null;
}

/**
 * Distance (Å), angle a–b–c (°, b = vertex) or dihedral a–b–c–d (°, (−180, 180]) for 2/3/4 atom
 * ids. Same definition as core/geometry `measureAtoms`, computed from the shared vector primitives.
 * NaN if an atom is missing or the count is not 2–4.
 */
export function measureIds(mol: Molecule, ids: readonly number[]): number {
  const p: Vec3[] = [];
  for (const id of ids) {
    const a = atomById(mol, id);
    if (!a) return NaN;
    p.push([a.x, a.y, a.z]);
  }
  if (p.length === 2) return distance(p[0], p[1]);
  if (p.length === 3) return angle(p[0], p[1], p[2]);
  if (p.length === 4) return dihedral(p[0], p[1], p[2], p[3]);
  return NaN;
}

/** Signed number with a typographic minus; never prints "−0.0". */
export function formatSigned(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(digits);
  if (parseFloat(s) === 0) return s;
  return (v < 0 ? '−' : '') + s;
}

/** "1.54 Å", "109.5°", "−60.0°" (precise: one more decimal). NaN → "—". */
export function formatMeasure(kind: MeasureKind, v: number, precise = false): string {
  if (!Number.isFinite(v)) return '—';
  if (kind === 'distance') return `${formatSigned(v, precise ? 3 : 2)} Å`;
  return `${formatSigned(v, precise ? 2 : 1)}°`;
}

/** Atom name (or element + 1-based index), optionally with the residue number: "CA 42", "C3". */
export function shortAtomLabel(mol: Molecule, id: number, withResidue = false): string {
  const a = atomById(mol, id);
  if (!a) return `#${id}`;
  const idx = getTopology(mol).idToIndex.get(id) ?? 0;
  const name = a.name || `${a.element}${idx + 1}`;
  if (withResidue && a.resName) return `${name} ${a.resSeq ?? ''}${a.iCode ?? ''}`.trim();
  return name;
}

function sameResidue(mol: Molecule, ids: readonly number[]): boolean {
  const topo = getTopology(mol);
  let res: number | undefined;
  for (const id of ids) {
    const i = topo.idToIndex.get(id);
    const r = i === undefined ? -1 : topo.atomResidue[i];
    if (res === undefined) res = r;
    else if (r !== res) return false;
  }
  return true;
}

/** Short labels for a list of atoms; residue numbers are added only when the atoms span residues. */
export function shortAtomLabels(mol: Molecule, ids: readonly number[]): string[] {
  const withRes = !sameResidue(mol, ids);
  return ids.map((id) => shortAtomLabel(mol, id, withRes));
}

/**
 * Compact one-line label for a measurement, e.g. "CA · ALA 42 · A – CB – CG" (atoms in the same
 * residue as the previous atom are given by name only).
 */
export function compactAtomLabels(mol: Molecule, ids: readonly number[], fullLabel: (id: number) => string): string {
  const topo = getTopology(mol);
  const parts: string[] = [];
  let prevRes = -2;
  for (const id of ids) {
    const i = topo.idToIndex.get(id);
    const r = i === undefined ? -1 : topo.atomResidue[i];
    parts.push(r >= 0 && r === prevRes ? shortAtomLabel(mol, id) : fullLabel(id));
    prevRes = r;
  }
  return parts.join(' – ');
}

export interface GeometryPreset {
  label: string;
  value: number;
  title: string;
}

export interface GeometryModel {
  kind: MeasureKind;
  atomIds: number[];
  /** Live value of the current molecule. */
  value: number;
  unit: 'Å' | '°';
  min: number;
  max: number;
  step: number;
  /** Decimal places for the number field. */
  digits: number;
  /** Whether setDistance / setAngle / setDihedral can change this value. */
  editable: boolean;
  /** Why it cannot be edited (when !editable). */
  reason?: string;
  /** What will move when the value is changed. */
  note?: string;
  /** For two bonded atoms: bond order, ideal length and deviation (value − ideal). */
  bond?: { order: BondOrder; ideal: number; deviation: number };
  presets: GeometryPreset[];
}

const EPS = 1e-6;
/** Exact tetrahedral angle acos(−1/3). */
export const TETRAHEDRAL_ANGLE = (Math.acos(-1 / 3) * 180) / Math.PI;

/**
 * Inspector model for an ORDERED list of 2–4 atom ids (selection insertion order). `base` is the
 * molecule a transient edit started from (keeps the slider range stable while dragging).
 * Returns null for other counts or if an atom is missing.
 */
export function geometryModel(mol: Molecule, ids: readonly number[], base: Molecule | null = null): GeometryModel | null {
  const kind = kindForCount(ids.length);
  if (!kind || new Set(ids).size !== ids.length) return null;
  const value = measureIds(mol, ids);
  if (!Number.isFinite(value)) return null;
  const atomIds = [...ids];
  const labels = shortAtomLabels(mol, atomIds);

  if (kind === 'distance') {
    const [a, b] = atomIds;
    const baseValue = base ? measureIds(base, atomIds) : value;
    const model: GeometryModel = {
      kind,
      atomIds,
      value,
      unit: 'Å',
      min: 0.5,
      max: Math.max(10, Math.ceil(Number.isFinite(baseValue) ? baseValue : value)),
      step: 0.01,
      digits: 3,
      editable: true,
      presets: [],
    };
    const bond = bondBetween(mol, a, b);
    if (value < EPS) {
      model.editable = false;
      model.reason = 'The atoms overlap, so the direction is undefined.';
    } else if (bond) {
      const ea = atomById(mol, a)!.element;
      const eb = atomById(mol, b)!.element;
      const ideal = idealBondLengthInMolecule(mol, a, b, bond.order);
      model.bond = { order: bond.order, ideal, deviation: value - ideal };
      model.presets.push({ label: 'Ideal', value: ideal, title: `Ideal ${ea}–${eb} bond length (${ideal.toFixed(3)} Å)` });
      model.note = isBondInRing(mol, a, b) ? `Ring bond: only ${labels[1]} moves.` : `Moves ${labels[1]} and everything attached on its side.`;
    } else {
      model.note = `Moves ${labels[1]} only.`;
    }
    return model;
  }

  if (kind === 'angle') {
    const [a, b, c] = atomIds;
    const model: GeometryModel = {
      kind,
      atomIds,
      value,
      unit: '°',
      min: 0,
      max: 180,
      step: 0.1,
      digits: 2,
      editable: true,
      presets: [
        { label: '109.5°', value: TETRAHEDRAL_ANGLE, title: 'Tetrahedral (sp³), 109.47°' },
        { label: '120°', value: 120, title: 'Trigonal planar (sp²)' },
        { label: '180°', value: 180, title: 'Linear (sp)' },
      ],
    };
    if (measureIds(mol, [a, b]) < EPS || measureIds(mol, [c, b]) < EPS) {
      model.editable = false;
      model.reason = 'An atom overlaps the vertex, so the angle is undefined.';
    } else if (bondBetween(mol, b, c)) {
      model.note = isBondInRing(mol, b, c) ? `Ring bond: only ${labels[2]} moves.` : `Rotates the ${labels[2]} side about vertex ${labels[1]}.`;
    } else {
      model.note = `Moves ${labels[2]} about vertex ${labels[1]}.`;
    }
    return model;
  }

  const [a, b, c, d] = atomIds;
  const check = canSetDihedral(mol, a, b, c, d);
  return {
    kind,
    atomIds,
    value,
    unit: '°',
    min: -180,
    max: 180,
    step: 0.5,
    digits: 1,
    editable: check.ok,
    reason: check.ok ? undefined : check.reason ?? 'This dihedral cannot be changed.',
    note: check.ok ? `Rotates the ${labels[2]} side about the ${labels[1]}–${labels[2]} bond.` : undefined,
    presets: [
      { label: '180°', value: 180, title: 'Anti (trans)' },
      { label: '60°', value: 60, title: 'Gauche (+)' },
      { label: '−60°', value: -60, title: 'Gauche (−)' },
      { label: '0°', value: 0, title: 'Syn (cis / eclipsed)' },
    ],
  };
}

/** Apply a new value with the matching core edit operation (returns a new molecule). */
export function applyGeometryValue(mol: Molecule, kind: MeasureKind, ids: readonly number[], value: number): Molecule {
  if (ids.length !== MEASURE_ATOM_COUNT[kind]) return mol;
  if (kind === 'distance') return setDistance(mol, ids[0], ids[1], value);
  if (kind === 'angle') return setAngle(mol, ids[0], ids[1], ids[2], value);
  return setDihedral(mol, ids[0], ids[1], ids[2], ids[3], value);
}

/** Undo label for a geometry edit, e.g. "Set angle to 109.5°". */
export function geometryEditLabel(kind: MeasureKind, value: number): string {
  return `Set ${kind} to ${formatMeasure(kind, value)}`;
}

/** True if the same measurement (in either direction) is already in the list. */
export function isPinned(measurements: readonly Measurement[], kind: MeasureKind, ids: readonly number[]): boolean {
  const key = ids.join(',');
  const rev = [...ids].reverse().join(',');
  return measurements.some((m) => m.kind === kind && (m.atomIds.join(',') === key || m.atomIds.join(',') === rev));
}

/** Tone for a bond-length deviation: within 0.05 Å ok, within 0.15 Å warn, else error. */
export function deviationTone(dev: number): 'ok' | 'warn' | 'error' {
  const d = Math.abs(dev);
  return d <= 0.05 ? 'ok' : d <= 0.15 ? 'warn' : 'error';
}

export const BOND_ORDER_NAMES: Record<BondOrder, string> = { 1: 'single', 1.5: 'aromatic', 2: 'double', 3: 'triple' };
