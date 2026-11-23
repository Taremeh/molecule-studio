/**
 * Move tool: drag atoms on the camera-facing plane through the grabbed atom.
 * - dragging a selected atom moves the whole selection rigidly; Alt-drag moves the connected fragment;
 *   otherwise the atom moves together with its terminal hydrogens;
 * - transient edit (one undo entry per drag, Escape restores the start state);
 * - optional live relaxation (view.relaxOnDrag) of the atoms within 3 bonds;
 * - live feedback: suggested bonds (dashed, green/red) and clashes; on release, valid suggestions
 *   become bonds when view.snapBonds is on.
 */
import type { EditOverlay, Molecule, Vec3 } from '../../core/types';
import type { PickResult } from '../../render/viewerApi';
import { atomById, bondById } from '../../core/molecule';
import { add, length, scale, sub } from '../../core/geometry';
import { setPositions, translateAtoms } from '../../core/edit';
import { createMinimizer, type Minimizer } from '../../core/minimize';
import {
  atomsWithinBonds,
  computeDragFeedback,
  createProximityIndex,
  type DragFeedback,
  pairLabel,
  shortAtomLabel,
} from '../feedback';
import { applySnapBonds } from '../ops';
import { resolveMovedAtoms } from '../moveSet';
import { boxOpFromModifiers, createBoxDrag } from './boxDrag';
import { atomPos, autoHydrogens, groupName, hitKey, selectByClick, selectGroupAndFocus } from './common';
import type { DragSession, Feedback, PointerState, Tool, ToolEnv } from './types';

/** Relaxation is skipped when more atoms than this would have to move. */
const MAX_RELAX_ATOMS = 1500;
/** Time budget per frame for relaxation steps (ms). */
const RELAX_BUDGET_MS = 6;
const RELAX_MAX_STEPS_PER_FRAME = 12;
const MAX_OVERLAY_ITEMS = 200;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export const moveTool: Tool = {
  hoverKey: (_env, hit) => hitKey(hit),

  preview(env, hit) {
    const s = env.state();
    const mol = s.molecule;
    if (!mol || !hit) return { hint: 'Drag an atom to move it · Alt-drag moves its whole fragment · drag empty space to rotate' };
    if (hit.kind === 'atom' && hit.atomId !== undefined && atomById(mol, hit.atomId)) {
      const id = hit.atomId;
      if (s.selection.has(id) && s.selection.size > 1) {
        return { hint: `Drag to move the ${s.selection.size} selected atoms · Alt-drag moves the whole ${groupName(mol, id)}` };
      }
      return { hint: `Drag to move ${shortAtomLabel(mol, id)} · Alt-drag moves the whole ${groupName(mol, id)}` };
    }
    const bond = hit.bondId !== undefined ? bondById(mol, hit.bondId) : undefined;
    return { hint: bond ? `Drag to move the ${pairLabel(mol, bond.a, bond.b)} bond` : null };
  },

  press(_env, hit, p) {
    if (hit) {
      return {
        consume: true,
        click: (env, at) => selectByClick(env, hit, at),
        startDrag: (env, start) => createMoveDrag(env, hit, start),
      };
    }
    if (p.shift) return { consume: true, startDrag: (env, start) => createBoxDrag(env, start, boxOpFromModifiers(start)) };
    return { consume: false, click: (env, at) => selectByClick(env, null, at) };
  },

  doubleClick(env, hit, p) {
    selectGroupAndFocus(env, hit, p, true);
  },
};

/** Undo label describing what the user grabbed (carried hydrogens are implicit). */
function moveLabel(mol: Molecule, grabbed: number[], moved: ReadonlySet<number>, kind: 'atom' | 'selection' | 'fragment'): string {
  const el = (id: number) => atomById(mol, id)?.element ?? 'atom';
  if (kind === 'fragment') return `Move fragment (${moved.size} atoms)`;
  if (kind === 'selection') return moved.size === 1 ? `Move ${el([...moved][0])}` : `Move ${moved.size} atoms`;
  return grabbed.length === 2 ? `Move ${pairLabel(mol, grabbed[0], grabbed[1])} bond` : `Move ${el(grabbed[0])}`;
}

/** Run relaxation steps within the per-frame time budget. */
function relax(minimizer: Minimizer) {
  const t0 = now();
  let steps = 0;
  do {
    minimizer.step(2);
    steps += 2;
  } while (steps < RELAX_MAX_STEPS_PER_FRAME && now() - t0 < RELAX_BUDGET_MS);
}

function dragFeedbackView(mol: Molecule, fb: DragFeedback, grabbed: number, label: string, moved: number, snap: boolean): Feedback {
  const overlay: Partial<EditOverlay> = {
    ghostBonds: fb.suggestions.slice(0, MAX_OVERLAY_ITEMS).map((s) => ({ from: s.from, to: s.to, valid: s.valid, order: 1, style: 'suggest' as const })),
    highlightAtoms: [],
  };
  const highlighted = new Set<number>();
  for (const c of fb.clashes) {
    if (highlighted.size >= MAX_OVERLAY_ITEMS) break;
    for (const id of [c.a, c.b]) {
      if (highlighted.has(id)) continue;
      highlighted.add(id);
      overlay.highlightAtoms!.push({ atomId: id, color: 'invalid' });
    }
  }
  for (const s of fb.suggestions) {
    if (s.valid && !highlighted.has(s.b) && highlighted.size < MAX_OVERLAY_ITEMS) {
      highlighted.add(s.b);
      overlay.highlightAtoms!.push({ atomId: s.b, color: 'valid' });
    }
  }

  const mine = fb.suggestions.filter((s) => s.a === grabbed);
  const bestValid = fb.suggestions.find((s) => s.valid);
  let hint: string;
  if (bestValid && snap) {
    const n = fb.suggestions.filter((s) => s.valid).length;
    hint = `Release to bond ${pairLabel(mol, bestValid.a, bestValid.b)}${n > 1 ? ` (+${n - 1} more)` : ''} · Esc to cancel`;
  } else if (bestValid) {
    hint = `${pairLabel(mol, bestValid.a, bestValid.b)} is within bonding distance (bond snapping is off)`;
  } else if (mine.length && mine[0].reason) {
    hint = mine[0].reason;
  } else if (fb.clashes.length) {
    const other = fb.clashes[0].b;
    hint = `Too close to ${shortAtomLabel(mol, other)}${fb.clashes.length > 1 ? ` and ${fb.clashes.length - 1} more` : ''}`;
  } else {
    hint = `${label} · moved ${moved.toFixed(2)} Å · Esc to cancel`;
  }
  return { overlay, hint };
}

/** Drag session for the move tool, or null if nothing can be moved. */
export function createMoveDrag(env: ToolEnv, hit: PickResult, start: PointerState): DragSession | null {
  const s0 = env.state();
  const mol0 = s0.molecule;
  if (!mol0 || s0.transientBase) return null; // another transient edit (e.g. a slider) is active

  let grabbedIds: number[];
  if (hit.kind === 'atom' && hit.atomId !== undefined) grabbedIds = [hit.atomId];
  else {
    const b = hit.bondId !== undefined ? bondById(mol0, hit.bondId) : undefined;
    grabbedIds = b ? [b.a, b.b] : [];
  }
  grabbedIds = grabbedIds.filter((id) => atomById(mol0, id));
  if (!grabbedIds.length) return null;
  const grabbed = grabbedIds[0];

  const moved = resolveMovedAtoms(mol0, grabbedIds, { selection: s0.selection, wholeFragment: start.alt });
  if (!moved.size) return null;
  const kind = start.alt ? 'fragment' : s0.selection.size > 0 && grabbedIds.every((id) => s0.selection.has(id)) ? 'selection' : 'atom';

  // Plane through the grabbed point facing the camera; keep the grab offset so nothing jumps.
  const planePoint: Vec3 =
    grabbedIds.length === 1 ? atomPos(mol0, grabbed)! : scale(add(atomPos(mol0, grabbedIds[0])!, atomPos(mol0, grabbedIds[1])!), 0.5);
  const offset = sub(planePoint, env.viewer.screenToWorldOnPlane(start.x, start.y, planePoint));

  s0.beginTransient();
  const base = env.state().transientBase;
  if (!base) return null;

  const basePos = new Map<number, Vec3>();
  for (const id of moved) basePos.set(id, atomPos(base, id)!);

  let minimizer: Minimizer | null = null;
  if (s0.view.relaxOnDrag) {
    const movable = atomsWithinBonds(base, moved, 3);
    if (movable.size > 0 && movable.size <= MAX_RELAX_ATOMS) {
      try {
        minimizer = createMinimizer(base, { movable });
      } catch (e) {
        console.warn('Relaxation unavailable:', e);
      }
    }
  }

  const autoH = autoHydrogens(s0, base);
  const index = createProximityIndex(base, moved, minimizer ? 1 : 0);
  const label = moveLabel(base, grabbedIds, moved, kind);
  let current: Molecule = base;
  let feedback: DragFeedback | null = null;
  let delta: Vec3 = [0, 0, 0];
  let aborted = false;

  /** Move to the pointer; false if the transient edit was taken away from us (undo, load…). */
  const apply = (p: PointerState): boolean => {
    const s = env.state();
    if (aborted || s.transientBase !== base) {
      aborted = true;
      return false;
    }
    const world = env.viewer.screenToWorldOnPlane(p.x, p.y, planePoint);
    delta = sub(add(world, offset), planePoint);
    let next: Molecule;
    if (minimizer) {
      const positions = new Map<number, Vec3>();
      for (const [id, p0] of basePos) {
        const target = add(p0, delta);
        positions.set(id, target);
        minimizer.setFixedPosition(id, target);
      }
      relax(minimizer);
      for (const [id, pos] of minimizer.positions()) if (!moved.has(id)) positions.set(id, pos);
      next = setPositions(base, positions);
    } else {
      next = translateAtoms(base, moved, delta);
    }
    s.updateTransient(next);
    current = next;
    feedback = computeDragFeedback(next, { moved, grabbed, autoH, topologyMol: base, index });
    env.show(dragFeedbackView(base, feedback, grabbed, label, length(delta), s.view.snapBonds));
    return true;
  };

  return {
    update(_env, p) {
      apply(p);
    },

    finish(env, p) {
      if (!apply(p)) return;
      const s = env.state();
      try {
        let final = current;
        let formed: string[] = [];
        if (s.view.snapBonds && feedback) {
          const valid = feedback.suggestions.filter((x) => x.valid);
          if (valid.length) ({ mol: final, formed } = applySnapBonds(current, valid, autoH));
        }
        if (!formed.length && !minimizer && length(delta) < 1e-4) {
          s.cancelTransient(); // a drag that ended where it started: no undo entry
          return;
        }
        if (final !== current) s.updateTransient(final);
        s.endTransient(formed.length ? `${label} & bond ${formed.join(', ')}` : label);
        if (formed.length) s.toast(`Formed ${formed.join(', ')} bond${formed.length > 1 ? 's' : ''}`, 'success', 2200);
      } catch (e) {
        if (env.state().transientBase === base) env.state().cancelTransient();
        throw e;
      }
    },

    cancel(env) {
      aborted = true;
      if (env.state().transientBase === base) env.state().cancelTransient();
    },
  };
}
