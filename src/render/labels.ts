/**
 * Text labels drawn on a 2D canvas stacked over the WebGL canvas (pointer-events: none), redrawn after
 * every WebGL frame: atom labels (view.labelMode) and measurement values. OWNER: render-core.
 */
import type { Atom, LabelMode, MeasureKind, Molecule } from '../core/types';
import { getTopology } from '../core/molecule';

/** Labels are drawn for at most this many atoms. */
export const MAX_ATOM_LABELS = 500;
/** With nothing selected, small molecules (< this many atoms) get labels on every atom. */
export const LABEL_ALL_BELOW = 60;

export const LABEL_FONT_FAMILY = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Label text for one atom in modes element / name / serial (residue mode is grouped, see collectAtomLabels). */
export function atomLabelText(atom: Atom, index: number, mode: LabelMode): string {
  switch (mode) {
    case 'element':
      return atom.element;
    case 'name':
      return atom.name || `${atom.element}${index + 1}`;
    case 'serial':
      return String(atom.serial ?? atom.id);
    case 'residue':
      return residueLabelText(atom) ?? (atom.name || atom.element);
    default:
      return '';
  }
}

/** "ALA 42" (+ ":A" with a chain), or null for atoms without residue information. */
export function residueLabelText(atom: Atom): string | null {
  if (!atom.resName && atom.resSeq === undefined) return null;
  const name = atom.resName ?? 'UNK';
  const num = atom.resSeq !== undefined ? ` ${atom.resSeq}${atom.iCode ?? ''}` : '';
  const chain = atom.chain ? `:${atom.chain}` : '';
  return `${name}${num}${chain}`;
}

/** "1.54 Å", "109.5°", "−60.0°"; '—' when undefined. */
export function formatMeasurement(kind: MeasureKind, value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (kind === 'distance') return `${value.toFixed(2)} Å`;
  const s = value.toFixed(1);
  return `${s.startsWith('-') ? '−' + s.slice(1) : s}°`;
}

export interface AtomLabel {
  /** Atom index the label is anchored to. */
  atomIndex: number;
  text: string;
}

/**
 * Which atoms get labels: the selected atoms, or all atoms of a small molecule when nothing is selected
 * (capped at MAX_ATOM_LABELS). Hidden hydrogens are skipped. In 'residue' mode there is one label per
 * residue, anchored at its CA / C4' / P (or the first labelled atom of that residue).
 */
export function collectAtomLabels(
  mol: Molecule,
  selection: ReadonlySet<number>,
  mode: LabelMode,
  hideHydrogens: boolean,
): AtomLabel[] {
  if (mode === 'none' || mol.atoms.length === 0) return [];
  const topo = getTopology(mol);
  let indices: number[] = [];
  if (selection.size > 0) {
    for (const id of selection) {
      const i = topo.idToIndex.get(id);
      if (i !== undefined) indices.push(i);
    }
    indices.sort((a, b) => a - b);
  } else if (mol.atoms.length < LABEL_ALL_BELOW) {
    indices = mol.atoms.map((_, i) => i);
  }
  if (hideHydrogens) indices = indices.filter((i) => mol.atoms[i].element !== 'H');

  const out: AtomLabel[] = [];
  if (mode === 'residue') {
    const seen = new Map<number, number>(); // residue index → position in `out`
    for (const i of indices) {
      const r = topo.atomResidue[i];
      const atom = mol.atoms[i];
      if (r < 0) {
        out.push({ atomIndex: i, text: atom.name || atom.element });
      } else {
        const pos = seen.get(r);
        const isAnchor = atom.name === 'CA' || atom.name === "C4'" || atom.name === 'P';
        if (pos === undefined) {
          seen.set(r, out.length);
          out.push({ atomIndex: i, text: residueLabelText(atom) ?? atom.element });
        } else if (isAnchor && mol.atoms[out[pos].atomIndex].name !== 'CA') {
          out[pos] = { atomIndex: i, text: out[pos].text };
        }
      }
      if (out.length >= MAX_ATOM_LABELS) break;
    }
    return out;
  }
  for (const i of indices) {
    out.push({ atomIndex: i, text: atomLabelText(mol.atoms[i], i, mode) });
    if (out.length >= MAX_ATOM_LABELS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canvas layer
// ---------------------------------------------------------------------------

export interface ScreenPoint {
  /** CSS pixels relative to the canvas' top-left corner. */
  x: number;
  y: number;
  /** 0 (nearest) .. 1 (farthest) within the scene depth range, used for depth fading. */
  depth: number;
  visible: boolean;
}

export interface LabelDrawItem {
  x: number;
  y: number;
  z: number;
  text: string;
  kind: 'atom' | 'measure';
}

export interface LabelTheme {
  /** True when the background is dark (light text). */
  dark: boolean;
}

export class LabelLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private hasContent = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewport-labels';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    });
    this.ctx = this.canvas.getContext('2d');
  }

  resize(cssWidth: number, cssHeight: number, dpr: number) {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.hasContent = true; // resizing clears the canvas; force a redraw
  }

  draw(items: LabelDrawItem[], project: (x: number, y: number, z: number) => ScreenPoint, theme: LabelTheme) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (items.length === 0 && !this.hasContent) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.hasContent = items.length > 0;
    if (items.length === 0) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawLabels(ctx, items, project, theme, this.cssWidth, this.cssHeight);
  }

  dispose() {
    this.canvas.remove();
  }
}

/** Draw labels into any 2D context whose transform maps CSS pixels to device pixels. */
export function drawLabels(
  ctx: CanvasRenderingContext2D,
  items: LabelDrawItem[],
  project: (x: number, y: number, z: number) => ScreenPoint,
  theme: LabelTheme,
  width: number,
  height: number,
) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const atomFill = theme.dark ? '#f1f5f9' : '#0f172a';
  const atomStroke = theme.dark ? 'rgba(2, 6, 23, 0.85)' : 'rgba(255, 255, 255, 0.9)';
  // Atom labels first, so measurement pills stay on top.
  ctx.font = `600 11px ${LABEL_FONT_FAMILY}`;
  ctx.lineWidth = 3;
  for (const it of items) {
    if (it.kind !== 'atom') continue;
    const p = project(it.x, it.y, it.z);
    if (!p.visible || p.x < -40 || p.y < -20 || p.x > width + 40 || p.y > height + 20) continue;
    ctx.globalAlpha = 1 - 0.55 * Math.min(1, Math.max(0, p.depth));
    ctx.strokeStyle = atomStroke;
    ctx.strokeText(it.text, p.x, p.y);
    ctx.fillStyle = atomFill;
    ctx.fillText(it.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
  ctx.font = `600 12px ${LABEL_FONT_FAMILY}`;
  for (const it of items) {
    if (it.kind !== 'measure') continue;
    const p = project(it.x, it.y, it.z);
    if (!p.visible) continue;
    const w = ctx.measureText(it.text).width + 12;
    const h = 20;
    const x = p.x - w / 2;
    const y = p.y - h / 2;
    ctx.fillStyle = theme.dark ? 'rgba(15, 23, 42, 0.86)' : 'rgba(255, 255, 255, 0.92)';
    ctx.strokeStyle = theme.dark ? 'rgba(148, 163, 184, 0.45)' : 'rgba(100, 116, 139, 0.45)';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.dark ? '#fde68a' : '#92400e';
    ctx.fillText(it.text, p.x, p.y + 0.5);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
