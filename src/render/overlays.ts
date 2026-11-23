/**
 * Interactive overlays drawn on top of the representations. OWNER: render-core.
 *
 *  - selection halos   translucent shells (~1.25× display radius) around selected atoms (cap 20k)
 *  - hover halo        around the hovered atom / along the hovered bond
 *  - edit overlay      ghost atoms & bonds (preview = translucent cylinder, suggest = dashed line),
 *                      highlight halos for atoms / bonds (HIGHLIGHT_COLORS)
 *  - valence markers   (edit mode) pulsing red halos on over-valent atoms, amber stubs along open
 *                      valence directions of under-valent atoms (cap 2000 atoms)
 *  - measurements      dashed lines (+ angle arcs) with value labels; pending picks get target halos
 *
 * `sync()` diffs its inputs by identity and only rebuilds the parts whose inputs changed.
 */
import * as THREE from 'three';
import type { AppMode, EditOverlay, HoverInfo, Measurement, MeasureKind, Molecule, Vec3 } from '../core/types';
import { getTopology } from '../core/molecule';
import { getElement } from '../core/elements';
import { analyzeValence, shouldShowUnderValence } from '../core/chemistry';
import { angle as angleDeg, dihedral as dihedralDeg, distance as dist3, measureAtoms, openValenceDirections } from '../core/geometry';
import { HIGHLIGHT_COLORS, hexToRgb } from './colors';
import { srgbToLinear, writeCylinderMatrix, writeSphereMatrix } from './math3d';
import { createCylinderGeometry, displayRadius } from './reps/atoms';
import { formatMeasurement, type LabelDrawItem } from './labels';

export const MAX_SELECTION_HALOS = 20_000;
export const MAX_VALENCE_MARKERS = 2_000;

export interface OverlayInput {
  mol: Molecule | null;
  /** Changes whenever display radii may have changed (reps rebuilt / rescaled). */
  radiiVersion: number;
  /** Display radius (Å) of an atom by index (largest over the representations showing it). */
  radiusOf: (atomIndex: number) => number;
  /** True for atoms hidden by the global hydrogen filter. */
  isHidden: (atomIndex: number) => boolean;
  selection: ReadonlySet<number>;
  hovered: HoverInfo | null;
  editOverlay: EditOverlay;
  measurements: Measurement[];
  pendingMeasure: number[];
  measureKind: MeasureKind;
  mode: AppMode;
  showValence: boolean;
  /** True when the background is light (overlay lines/labels use dark ink). */
  lightBackground: boolean;
}

type Rgb = [number, number, number];

function linearRgb(hex: string): Rgb {
  const [r, g, b] = hexToRgb(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/** Instanced unit spheres or cylinders with a growable capacity and per-instance colours. */
class Batch {
  mesh: THREE.InstancedMesh | null = null;
  private capacity = 0;

  constructor(
    private parent: THREE.Object3D,
    private geometry: THREE.BufferGeometry,
    readonly material: THREE.Material,
    private renderOrder: number,
    private name: string,
  ) {}

  /** Resize to `count` instances; returns the matrix and colour arrays to fill (colours default to white). */
  begin(count: number): { m: Float32Array; c: Float32Array } | null {
    if (count === 0) {
      if (this.mesh) this.mesh.visible = false;
      return null;
    }
    if (!this.mesh || count > this.capacity) {
      this.disposeMesh();
      this.capacity = Math.max(16, 1 << Math.ceil(Math.log2(count)));
      const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3).fill(1), 3);
      mesh.frustumCulled = false;
      mesh.renderOrder = this.renderOrder;
      mesh.name = this.name;
      this.parent.add(mesh);
      this.mesh = mesh;
    }
    this.mesh.count = count;
    this.mesh.visible = true;
    return { m: this.mesh.instanceMatrix.array as Float32Array, c: this.mesh.instanceColor!.array as Float32Array };
  }

  commit() {
    if (!this.mesh) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  hide() {
    if (this.mesh) this.mesh.visible = false;
  }

  private disposeMesh() {
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
  }

  dispose() {
    this.disposeMesh();
    this.material.dispose();
  }
}

/** Dashed line segments with rebuildable geometry. */
class DashedLines {
  readonly object: THREE.LineSegments;
  readonly material: THREE.LineDashedMaterial;

  constructor(parent: THREE.Object3D, color: string, opts: { depthTest: boolean; renderOrder: number; dashSize: number; gapSize: number; opacity: number }) {
    this.material = new THREE.LineDashedMaterial({
      color,
      dashSize: opts.dashSize,
      gapSize: opts.gapSize,
      transparent: true,
      opacity: opts.opacity,
      depthTest: opts.depthTest,
      depthWrite: false,
      fog: false,
    });
    this.object = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = opts.renderOrder;
    this.object.visible = false;
    parent.add(this.object);
  }

  set(points: number[]) {
    this.object.geometry.dispose();
    const g = new THREE.BufferGeometry();
    if (points.length >= 6) g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.object.geometry = g;
    this.object.visible = points.length >= 6;
    if (this.object.visible) this.object.computeLineDistances();
  }

  dispose() {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

function basic(color: string, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, fog: false });
}

export class OverlayLayer {
  readonly group = new THREE.Group();
  private sphereGeom = new THREE.SphereGeometry(1, 20, 14);
  private cylGeom = createCylinderGeometry('medium');

  private selection = new Batch(this.group, this.sphereGeom, basic(HIGHLIGHT_COLORS.selection, 0.36), 2, 'selection-halos');
  private hoverAtom = new Batch(this.group, this.sphereGeom, basic(HIGHLIGHT_COLORS.hover, 0.45), 4, 'hover-atom');
  private hoverBond = new Batch(this.group, this.cylGeom, basic(HIGHLIGHT_COLORS.hover, 0.45), 4, 'hover-bond');
  private highlightAtoms = new Batch(this.group, this.sphereGeom, basic('#ffffff', 0.5), 3, 'highlight-atoms');
  private highlightBonds = new Batch(this.group, this.cylGeom, basic('#ffffff', 0.5), 3, 'highlight-bonds');
  private ghostAtoms = new Batch(
    this.group,
    this.sphereGeom,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false }),
    5,
    'ghost-atoms',
  );
  private ghostBonds = new Batch(this.group, this.cylGeom, basic('#ffffff', 0.6), 5, 'ghost-bonds');
  private suggestValid = new DashedLines(this.group, HIGHLIGHT_COLORS.valid, { depthTest: true, renderOrder: 6, dashSize: 0.18, gapSize: 0.12, opacity: 0.95 });
  private suggestInvalid = new DashedLines(this.group, HIGHLIGHT_COLORS.invalid, { depthTest: true, renderOrder: 6, dashSize: 0.18, gapSize: 0.12, opacity: 0.95 });
  private valenceOver = new Batch(this.group, this.sphereGeom, basic(HIGHLIGHT_COLORS.valenceOver, 0.4), 3, 'valence-over');
  private valenceStubs = new Batch(
    this.group,
    this.cylGeom,
    new THREE.MeshStandardMaterial({ color: HIGHLIGHT_COLORS.valenceUnder, roughness: 0.5, metalness: 0 }),
    1,
    'valence-stubs',
  );
  private valenceTips = new Batch(
    this.group,
    this.sphereGeom,
    new THREE.MeshStandardMaterial({ color: HIGHLIGHT_COLORS.valenceUnder, roughness: 0.5, metalness: 0 }),
    1,
    'valence-tips',
  );
  private pending = new Batch(this.group, this.sphereGeom, basic(HIGHLIGHT_COLORS.target, 0.45), 3, 'pending-measure');
  private measureDark = new DashedLines(this.group, '#334155', { depthTest: false, renderOrder: 10, dashSize: 0.22, gapSize: 0.14, opacity: 0.9 });
  private measureLight = new DashedLines(this.group, '#e2e8f0', { depthTest: false, renderOrder: 10, dashSize: 0.22, gapSize: 0.14, opacity: 0.9 });

  private last: Partial<OverlayInput> = {};
  private labels: LabelDrawItem[] = [];
  private pulse = false;

  constructor() {
    this.group.name = 'overlays';
  }

  /** Measurement value labels (world positions), refreshed by sync(). */
  get labelItems(): LabelDrawItem[] {
    return this.labels;
  }

  /** True when an animated (pulsing) marker is visible. */
  get animating(): boolean {
    return this.pulse;
  }

  /** Advance animations; returns true if something changed (needs a redraw). */
  animate(timeMs: number): boolean {
    if (!this.pulse) return false;
    const m = this.valenceOver.material as THREE.MeshBasicMaterial;
    m.opacity = 0.28 + 0.24 * (0.5 + 0.5 * Math.sin((timeMs / 1000) * Math.PI * 2 * 0.9));
    return true;
  }

  sync(input: OverlayInput) {
    const L = this.last;
    const molChanged = input.mol !== L.mol;
    const radiiChanged = input.radiiVersion !== L.radiiVersion;
    const base = molChanged || radiiChanged;
    if (base || input.selection !== L.selection) this.buildSelection(input);
    if (base || input.hovered !== L.hovered) this.buildHover(input);
    if (base || input.editOverlay !== L.editOverlay) this.buildEditOverlay(input);
    if (base || input.mode !== L.mode || input.showValence !== L.showValence) this.buildValence(input);
    if (
      base ||
      input.measurements !== L.measurements ||
      input.pendingMeasure !== L.pendingMeasure ||
      input.lightBackground !== L.lightBackground
    )
      this.buildMeasurements(input);
    this.last = { ...input };
  }

  dispose() {
    for (const b of [
      this.selection,
      this.hoverAtom,
      this.hoverBond,
      this.highlightAtoms,
      this.highlightBonds,
      this.ghostAtoms,
      this.ghostBonds,
      this.valenceOver,
      this.valenceStubs,
      this.valenceTips,
      this.pending,
    ])
      b.dispose();
    for (const l of [this.suggestValid, this.suggestInvalid, this.measureDark, this.measureLight]) l.dispose();
    this.sphereGeom.dispose();
    this.cylGeom.dispose();
    this.group.clear();
  }

  // ---------------------------------------------------------------------------

  private buildSelection(inp: OverlayInput) {
    const mol = inp.mol;
    if (!mol || inp.selection.size === 0) return this.selection.hide();
    const topo = getTopology(mol);
    const idx: number[] = [];
    for (const id of inp.selection) {
      const i = topo.idToIndex.get(id);
      if (i === undefined || inp.isHidden(i)) continue;
      idx.push(i);
      if (idx.length >= MAX_SELECTION_HALOS) break;
    }
    const buf = this.selection.begin(idx.length);
    if (!buf) return;
    for (let k = 0; k < idx.length; k++) {
      const a = mol.atoms[idx[k]];
      const r = inp.radiusOf(idx[k]);
      writeSphereMatrix(buf.m, k * 16, a.x, a.y, a.z, Math.max(r * 1.25, r + 0.12));
    }
    this.selection.commit();
  }

  private buildHover(inp: OverlayInput) {
    const mol = inp.mol;
    const h = inp.hovered;
    this.hoverAtom.hide();
    this.hoverBond.hide();
    if (!mol || !h) return;
    const topo = getTopology(mol);
    if (h.kind === 'atom' && h.atomId !== undefined) {
      const i = topo.idToIndex.get(h.atomId);
      if (i === undefined) return;
      const a = mol.atoms[i];
      const r = inp.radiusOf(i);
      const buf = this.hoverAtom.begin(1)!;
      writeSphereMatrix(buf.m, 0, a.x, a.y, a.z, Math.max(r * 1.35, r + 0.16));
      this.hoverAtom.commit();
    } else if (h.kind === 'bond' && h.bondId !== undefined) {
      const bi = topo.bondIdToIndex.get(h.bondId);
      if (bi === undefined) return;
      const bond = mol.bonds[bi];
      const ia = topo.idToIndex.get(bond.a);
      const ib = topo.idToIndex.get(bond.b);
      if (ia === undefined || ib === undefined) return;
      const A = mol.atoms[ia];
      const B = mol.atoms[ib];
      const buf = this.hoverBond.begin(1)!;
      writeCylinderMatrix(buf.m, 0, A.x, A.y, A.z, B.x, B.y, B.z, 0.28);
      this.hoverBond.commit();
    }
  }

  private buildEditOverlay(inp: OverlayInput) {
    const o = inp.editOverlay;
    const mol = inp.mol;
    const topo = mol ? getTopology(mol) : null;

    // Highlighted atoms.
    const hl = mol && topo ? o.highlightAtoms.filter((h) => topo.idToIndex.has(h.atomId)) : [];
    const ha = this.highlightAtoms.begin(hl.length);
    if (ha && mol && topo) {
      hl.forEach((h, k) => {
        const i = topo.idToIndex.get(h.atomId)!;
        const a = mol.atoms[i];
        const r = inp.radiusOf(i);
        writeSphereMatrix(ha.m, k * 16, a.x, a.y, a.z, r * 1.3 + 0.08);
        ha.c.set(linearRgb(HIGHLIGHT_COLORS[h.color]), k * 3);
      });
      this.highlightAtoms.commit();
    }

    // Highlighted bonds.
    const hb = mol && topo ? o.highlightBonds.filter((h) => topo.bondIdToIndex.has(h.bondId)) : [];
    const hbb = this.highlightBonds.begin(hb.length);
    if (hbb && mol && topo) {
      hb.forEach((h, k) => {
        const bond = mol.bonds[topo.bondIdToIndex.get(h.bondId)!];
        const ia = topo.idToIndex.get(bond.a);
        const ib = topo.idToIndex.get(bond.b);
        if (ia === undefined || ib === undefined) {
          writeSphereMatrix(hbb.m, k * 16, 0, 0, 0, 0);
          return;
        }
        const A = mol.atoms[ia];
        const B = mol.atoms[ib];
        writeCylinderMatrix(hbb.m, k * 16, A.x, A.y, A.z, B.x, B.y, B.z, 0.3);
        hbb.c.set(linearRgb(HIGHLIGHT_COLORS[h.color]), k * 3);
      });
      this.highlightBonds.commit();
    }

    // Ghost atoms: element colour, tinted red when invalid.
    const ga = this.ghostAtoms.begin(o.ghostAtoms.length);
    if (ga) {
      const red = linearRgb(HIGHLIGHT_COLORS.invalid);
      o.ghostAtoms.forEach((g, k) => {
        const r = displayRadius({ element: g.element }, 'ball-and-stick', 1);
        writeSphereMatrix(ga.m, k * 16, g.position[0], g.position[1], g.position[2], r);
        const c = linearRgb(getElement(g.element).color);
        const col: Rgb = g.valid ? c : [c[0] * 0.35 + red[0] * 0.65, c[1] * 0.35 + red[1] * 0.65, c[2] * 0.35 + red[2] * 0.65];
        ga.c.set(col, k * 3);
      });
      this.ghostAtoms.commit();
    }

    // Ghost bonds: 'preview' as translucent cylinders, 'suggest' as dashed lines.
    const preview = o.ghostBonds.filter((b) => b.style === 'preview');
    const gb = this.ghostBonds.begin(preview.length);
    if (gb) {
      const valid = linearRgb(HIGHLIGHT_COLORS.valid);
      const invalid = linearRgb(HIGHLIGHT_COLORS.invalid);
      preview.forEach((b, k) => {
        const r = b.order === 3 ? 0.16 : b.order === 2 ? 0.14 : 0.12;
        writeCylinderMatrix(gb.m, k * 16, b.from[0], b.from[1], b.from[2], b.to[0], b.to[1], b.to[2], r);
        gb.c.set(b.valid ? valid : invalid, k * 3);
      });
      this.ghostBonds.commit();
    }
    const sv: number[] = [];
    const si: number[] = [];
    for (const b of o.ghostBonds) {
      if (b.style !== 'suggest') continue;
      (b.valid ? sv : si).push(...b.from, ...b.to);
    }
    this.suggestValid.set(sv);
    this.suggestInvalid.set(si);
  }

  private buildValence(inp: OverlayInput) {
    const mol = inp.mol;
    this.pulse = false;
    if (!mol || inp.mode !== 'edit' || !inp.showValence || mol.atoms.length === 0) {
      this.valenceOver.hide();
      this.valenceStubs.hide();
      this.valenceTips.hide();
      return;
    }
    const topo = getTopology(mol);
    let info: ReturnType<typeof analyzeValence>;
    try {
      info = analyzeValence(mol);
    } catch (e) {
      console.warn('[viewer] valence analysis failed', e);
      info = new Map();
    }
    const over: number[] = [];
    const under: { index: number; id: number }[] = [];
    const showUnder = safeShouldShowUnder(mol);
    for (const [id, v] of info) {
      const i = topo.idToIndex.get(id);
      if (i === undefined) continue;
      if (v.status === 'over' && over.length < MAX_VALENCE_MARKERS) over.push(i);
      else if (showUnder && v.status === 'under' && v.openValence > 0 && under.length < MAX_VALENCE_MARKERS) under.push({ index: i, id });
    }
    const ob = this.valenceOver.begin(over.length);
    if (ob) {
      over.forEach((i, k) => {
        const a = mol.atoms[i];
        const r = inp.radiusOf(i);
        writeSphereMatrix(ob.m, k * 16, a.x, a.y, a.z, r * 1.4 + 0.1);
      });
      this.valenceOver.commit();
      this.pulse = true;
    }
    // Open valence stubs.
    const stubs: { a: Vec3; b: Vec3 }[] = [];
    for (const u of under) {
      let dirs: Vec3[] = [];
      try {
        dirs = openValenceDirections(mol, u.id);
      } catch {
        dirs = [];
      }
      const a = mol.atoms[u.index];
      const r = inp.radiusOf(u.index);
      for (const d of dirs) {
        const l = Math.hypot(d[0], d[1], d[2]);
        if (!(l > 1e-6)) continue;
        const ux = d[0] / l;
        const uy = d[1] / l;
        const uz = d[2] / l;
        const r0 = r * 0.7;
        const r1 = r + 0.42;
        stubs.push({ a: [a.x + ux * r0, a.y + uy * r0, a.z + uz * r0], b: [a.x + ux * r1, a.y + uy * r1, a.z + uz * r1] });
      }
    }
    const sb = this.valenceStubs.begin(stubs.length);
    const tb = this.valenceTips.begin(stubs.length);
    if (sb && tb) {
      stubs.forEach((s, k) => {
        writeCylinderMatrix(sb.m, k * 16, s.a[0], s.a[1], s.a[2], s.b[0], s.b[1], s.b[2], 0.045);
        writeSphereMatrix(tb.m, k * 16, s.b[0], s.b[1], s.b[2], 0.085);
      });
      this.valenceStubs.commit();
      this.valenceTips.commit();
    }
  }

  private buildMeasurements(inp: OverlayInput) {
    const mol = inp.mol;
    this.labels = [];
    const ink = inp.lightBackground ? this.measureDark : this.measureLight;
    const other = inp.lightBackground ? this.measureLight : this.measureDark;
    other.set([]);
    if (!mol) {
      ink.set([]);
      this.pending.hide();
      return;
    }
    const topo = getTopology(mol);
    const pos = (id: number): Vec3 | null => {
      const i = topo.idToIndex.get(id);
      if (i === undefined) return null;
      const a = mol.atoms[i];
      return [a.x, a.y, a.z];
    };
    const pts: number[] = [];
    const seg = (p: Vec3, q: Vec3) => pts.push(p[0], p[1], p[2], q[0], q[1], q[2]);

    for (const m of inp.measurements) {
      const P = m.atomIds.map(pos);
      if (P.some((p) => !p)) continue;
      const p = P as Vec3[];
      const value = measurementValue(mol, m.kind, m.atomIds, p);
      const text = formatMeasurement(m.kind, value);
      if (m.kind === 'distance' && p.length >= 2) {
        seg(p[0], p[1]);
        this.labels.push({ x: (p[0][0] + p[1][0]) / 2, y: (p[0][1] + p[1][1]) / 2, z: (p[0][2] + p[1][2]) / 2, text, kind: 'measure' });
      } else if (m.kind === 'angle' && p.length >= 3) {
        seg(p[0], p[1]);
        seg(p[1], p[2]);
        const arc = angleArc(p[0], p[1], p[2]);
        for (let k = 0; k + 1 < arc.points.length; k++) seg(arc.points[k], arc.points[k + 1]);
        this.labels.push({ x: arc.label[0], y: arc.label[1], z: arc.label[2], text, kind: 'measure' });
      } else if (m.kind === 'dihedral' && p.length >= 4) {
        seg(p[0], p[1]);
        seg(p[1], p[2]);
        seg(p[2], p[3]);
        this.labels.push({ x: (p[1][0] + p[2][0]) / 2, y: (p[1][1] + p[2][1]) / 2, z: (p[1][2] + p[2][2]) / 2, text, kind: 'measure' });
      }
    }

    // Pending picks of the measure tool: target halos + lines between consecutive picks.
    const pend = inp.pendingMeasure.filter((id) => topo.idToIndex.has(id));
    for (let k = 0; k + 1 < pend.length; k++) seg(pos(pend[k])!, pos(pend[k + 1])!);
    if (pend.length >= 2) {
      const need = inp.measureKind === 'distance' ? 2 : inp.measureKind === 'angle' ? 3 : 4;
      if (pend.length < need) {
        // Live partial value, e.g. the distance of the first two picks of an angle.
        const p = pend.slice(0, Math.min(pend.length, 4)).map((id) => pos(id)!);
        const kind: MeasureKind = pend.length === 2 ? 'distance' : 'angle';
        const ids = kind === 'distance' ? pend.slice(-2) : pend.slice(-3);
        const pp = kind === 'distance' ? p.slice(-2) : p.slice(-3);
        const v = measurementValue(mol, kind, ids, pp);
        const mid = kind === 'distance' ? lerp3(pp[0], pp[1], 0.5) : angleArc(pp[0], pp[1], pp[2]).label;
        this.labels.push({ x: mid[0], y: mid[1], z: mid[2], text: formatMeasurement(kind, v), kind: 'measure' });
      }
    }
    ink.set(pts);
    const pb = this.pending.begin(pend.length);
    if (pb) {
      pend.forEach((id, k) => {
        const i = topo.idToIndex.get(id)!;
        const a = mol.atoms[i];
        const r = inp.radiusOf(i);
        writeSphereMatrix(pb.m, k * 16, a.x, a.y, a.z, r * 1.35 + 0.1);
      });
      this.pending.commit();
    }
  }
}

function safeShouldShowUnder(mol: Molecule): boolean {
  try {
    return shouldShowUnderValence(mol);
  } catch {
    return false;
  }
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Live value of a measurement: core measureAtoms, with a local fallback if it is unavailable. */
export function measurementValue(mol: Molecule, kind: MeasureKind, ids: number[], p: Vec3[]): number {
  let v = NaN;
  try {
    v = measureAtoms(mol, ids);
  } catch {
    v = NaN;
  }
  if (Number.isFinite(v)) return v;
  if (kind === 'distance' && p.length >= 2) return dist3(p[0], p[1]);
  if (kind === 'angle' && p.length >= 3) return angleDeg(p[0], p[1], p[2]);
  if (kind === 'dihedral' && p.length >= 4) return dihedralDeg(p[0], p[1], p[2], p[3]);
  return NaN;
}

/**
 * Arc for the angle A–B–C drawn around the vertex B (slerp between the unit vectors towards A and C),
 * plus a label anchor on the bisector just outside the arc.
 */
export function angleArc(a: Vec3, b: Vec3, c: Vec3, segments = 16): { points: Vec3[]; label: Vec3 } {
  const ux = a[0] - b[0], uy = a[1] - b[1], uz = a[2] - b[2];
  const vx = c[0] - b[0], vy = c[1] - b[1], vz = c[2] - b[2];
  const lu = Math.hypot(ux, uy, uz);
  const lv = Math.hypot(vx, vy, vz);
  if (lu < 1e-6 || lv < 1e-6) return { points: [], label: b };
  const radius = Math.min(0.7, 0.35 * Math.min(lu, lv));
  const u: Vec3 = [ux / lu, uy / lu, uz / lu];
  const v: Vec3 = [vx / lv, vy / lv, vz / lv];
  const cos = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  // Bisector for the label (undefined for a straight angle: use a perpendicular-free fallback, the vertex).
  let bis: Vec3 = [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
  const lb = Math.hypot(bis[0], bis[1], bis[2]);
  bis = lb > 1e-6 ? [bis[0] / lb, bis[1] / lb, bis[2] / lb] : [0, 0, 0];
  const lr = radius + 0.45;
  const label: Vec3 = [b[0] + bis[0] * lr, b[1] + bis[1] * lr, b[2] + bis[2] * lr];
  if (sin < 1e-3) return { points: [], label };
  const points: Vec3[] = [];
  for (let k = 0; k <= segments; k++) {
    const s = k / segments;
    const w0 = Math.sin((1 - s) * theta) / sin;
    const w1 = Math.sin(s * theta) / sin;
    points.push([
      b[0] + radius * (w0 * u[0] + w1 * v[0]),
      b[1] + radius * (w0 * u[1] + w1 * v[1]),
      b[2] + radius * (w0 * u[2] + w1 * v[2]),
    ]);
  }
  return { points, label };
}
