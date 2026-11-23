/**
 * End-to-end editor walkthroughs against the REAL core modules (edit, chemistry, geometry,
 * templates, minimize) — the other editor tests use fakes for those. Drives the controller with
 * pointer sequences through the fake viewer and checks molecule, undo history, overlay and hint.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Molecule, ToolId } from '../core/types';
import { atomById, bondBetween, buildMolecule, createMolecule } from '../core/molecule';
import { analyzeValence, molecularFormula } from '../core/chemistry';
import { distance, idealBondLength } from '../core/geometry';
import { useStore } from '../state/store';
import { createHarness, type Harness } from './testing/fakeViewer';
import { twoGroups } from './testing/molecules';

const S = () => useStore.getState();
let h: Harness;

function load(m: Molecule, tool: ToolId, view: Partial<ReturnType<typeof S>['view']> = {}) {
  S().loadMolecule(m);
  useStore.setState({
    mode: 'edit',
    tool,
    editElement: 'C',
    editBondOrder: 1,
    editFragment: 'benzene',
    panels: { ...S().panels, help: false, load: false, settings: false },
    view: { ...S().view, autoHydrogens: true, snapBonds: true, relaxOnDrag: false, ...view },
  });
}

const notOk = (m: Molecule) => [...analyzeValence(m).values()].filter((v) => v.status !== 'ok');
const len = (m: Molecule, a: number, b: number) => {
  const A = atomById(m, a)!;
  const B = atomById(m, b)!;
  return distance([A.x, A.y, A.z], [B.x, B.y, B.z]);
};
const firstOf = (m: Molecule, el: string) => m.atoms.find((a) => a.element === el)!.id;
const bondMid = (m: Molecule, a: number, b: number): [number, number] => {
  const A = atomById(m, a)!;
  const B = atomById(m, b)!;
  const s = h.toScreen([(A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2]);
  return [s.x, s.y];
};

beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.ctl.dispose());

describe('building with every tool (real chemistry)', () => {
  it('each action is one labelled undo step; undo / redo restore the exact molecules', () => {
    load(createMolecule('New', { source: 'editor' }), 'add-atom');
    const snapshots: Molecule[] = [S().molecule!];
    const step = (expectLabel: string | RegExp) => {
      const label = S().past.at(-1)?.label;
      expect(label).toMatch(expectLabel);
      expect(S().past).toHaveLength(snapshots.length);
      snapshots.push(S().molecule!);
    };

    h.click(250, 250); // first atom → methane at the origin
    step('Add C');
    expect(molecularFormula(S().molecule!)).toBe('CH4');

    let m = S().molecule!;
    useStore.setState({ editElement: 'O' });
    const hId = firstOf(m, 'H');
    h.move(...h.screenOf(m, hId));
    h.flush();
    expect(S().hint).toBe('Click to replace this H with O');
    h.click(...h.screenOf(m, hId));
    step('Replace H with O');
    m = S().molecule!;
    expect(molecularFormula(m)).toBe('CH4O');
    expect(len(m, firstOf(m, 'C'), firstOf(m, 'O'))).toBeCloseTo(idealBondLength('C', 'O', 1), 6);

    useStore.setState({ tool: 'element', editElement: 'N' });
    h.click(...h.screenOf(m, firstOf(m, 'C')));
    step('Change C to N');
    m = S().molecule!;
    expect(molecularFormula(m)).toBe('H3NO'); // hydroxylamine
    expect(notOk(m)).toEqual([]);

    useStore.setState({ tool: 'charge' });
    h.click(...h.screenOf(m, firstOf(m, 'N')));
    step('Charge N⁺ (+1)');
    m = S().molecule!;
    expect(molecularFormula(m)).toBe('H4NO'); // NH3+–OH
    expect(notOk(m)).toEqual([]);

    useStore.setState({ tool: 'fragment', editFragment: 'benzene' });
    const nH = m.bonds.map((b) => (b.a === firstOf(m, 'N') ? b.b : b.b === firstOf(m, 'N') ? b.a : -1)).find((id) => id > 0 && atomById(m, id)!.element === 'H')!;
    h.click(...h.screenOf(m, nH));
    step('Attach Benzene');
    m = S().molecule!;
    expect(molecularFormula(m)).toBe('C6H8NO'); // Ph–NH2+–OH
    expect(notOk(m)).toEqual([]);

    useStore.setState({ tool: 'delete' });
    h.click(...h.screenOf(m, firstOf(m, 'O')));
    step('Delete O');
    m = S().molecule!;
    expect(molecularFormula(m)).toBe('C6H8N'); // anilinium: N+ refilled with H
    expect(notOk(m)).toEqual([]);

    // add-bond: cycle the N–C(ring) bond? (N+ is saturated → refused, no step)
    useStore.setState({ tool: 'add-bond' });
    const n = firstOf(m, 'N');
    const cRing = m.bonds.find((b) => (b.a === n || b.b === n) && atomById(m, b.a === n ? b.b : b.a)!.element === 'C')!;
    h.click(...bondMid(m, cRing.a, cRing.b));
    expect(S().molecule).toBe(m);
    expect(S().toasts.at(-1)?.kind).toBe('warning');

    // move: drag the nitrogen (its H ride along), one undo step
    useStore.setState({ tool: 'move' });
    const p = h.screenOf(m, n);
    h.drag(p, [p[0] + 30, p[1] - 20]);
    step(/^Move N/);

    // undo everything, step by step, back to the empty document
    for (let i = snapshots.length - 2; i >= 0; i--) {
      S().undo();
      expect(S().molecule).toBe(snapshots[i]);
    }
    expect(S().molecule!.atoms).toHaveLength(0);
    for (let i = 1; i < snapshots.length; i++) {
      S().redo();
      expect(S().molecule).toBe(snapshots[i]);
    }
  });

  it('bond orders: drag a bond between two methanes, then cycle single → double → triple → single', () => {
    const m0 = twoGroups({ el: 'C', nH: 4, at: [0, 0, 0] }, { el: 'C', nH: 4, at: [1.6, 0, 0] });
    load(m0, 'add-bond');
    h.drag([0, 0], [160, 0]);
    let m = S().molecule!;
    expect(S().past.at(-1)?.label).toBe('Bond C–C');
    expect(molecularFormula(m)).toBe('C2H6');
    const expected: [number, string, string][] = [
      [2, 'C2H4', 'Bond C–C (double)'],
      [3, 'C2H2', 'Bond C–C (triple)'],
      [1, 'C2H6', 'Bond C–C (single)'],
    ];
    for (const [order, formula, label] of expected) {
      h.click(...bondMid(m, 1, 6));
      m = S().molecule!;
      expect(bondBetween(m, 1, 6)!.order).toBe(order);
      expect(molecularFormula(m)).toBe(formula);
      expect(S().past.at(-1)?.label).toBe(label);
      expect(len(m, 1, 6)).toBeCloseTo(idealBondLength('C', 'C', order as 1 | 2 | 3), 6);
      expect(notOk(m)).toEqual([]);
    }
  });
});

describe('cancelled interactions leave no history', () => {
  const pair = () => twoGroups({ el: 'C', nH: 3, at: [0, 0, 0] }, { el: 'C', nH: 3, at: [3, 0, 0] });

  for (const relaxOnDrag of [false, true]) {
    it(`move drag cancelled by Escape or pointercancel (relaxOnDrag ${relaxOnDrag})`, () => {
      const m = pair();
      load(m, 'move', { relaxOnDrag });
      h.down(0, 0);
      h.move(60, 30);
      h.flush();
      expect(S().molecule).not.toBe(m);
      expect(h.key('Escape').stopped).toBe(true);
      expect(S().molecule).toBe(m);
      h.up(60, 30);
      h.flush();

      h.down(0, 0);
      h.move(150, 0);
      h.flush();
      expect(S().hint).toMatch(/Release to bond/);
      h.containerEvent('pointercancel', { pointerId: 1 });
      h.up(150, 0); // a late release must not finish the cancelled drag
      h.flush();
      expect(S().molecule).toBe(m);
      expect(S().past).toHaveLength(0);
      expect(S().transientBase).toBeNull();
      expect(S().editOverlay.ghostBonds).toEqual([]);
    });
  }

  it('bond drag and box-delete cancelled by Escape', () => {
    const m = pair();
    load(m, 'add-bond');
    h.down(0, 0);
    h.move(300, 0);
    h.flush();
    expect(S().editOverlay.ghostBonds).toHaveLength(1);
    h.key('Escape');
    h.up(300, 0);
    h.flush();
    useStore.setState({ tool: 'delete' });
    h.down(-200, -200, { shift: true });
    h.move(400, 200, { shift: true });
    h.flush();
    expect(S().editOverlay.selectionRect).not.toBeNull();
    h.key('Escape');
    h.up(400, 200, { shift: true });
    h.flush();
    expect(S().molecule).toBe(m);
    expect(S().past).toHaveLength(0);
    expect(S().editOverlay.selectionRect).toBeNull();
  });
});

describe('auto hydrogens on a PDB protein without hydrogens', () => {
  /** Two alanines (N CA C O CB), no hydrogens, as read from a PDB file. */
  function dipeptide(): Molecule {
    const res = (seq: number, x: number) => [
      { element: 'N', x, y: 0, z: 0, name: 'N', resName: 'ALA', resSeq: seq, chain: 'A' },
      { element: 'C', x: x + 1.2, y: 0.8, z: 0, name: 'CA', resName: 'ALA', resSeq: seq, chain: 'A' },
      { element: 'C', x: x + 2.5, y: 0, z: 0, name: 'C', resName: 'ALA', resSeq: seq, chain: 'A' },
      { element: 'O', x: x + 2.6, y: -1.2, z: 0, name: 'O', resName: 'ALA', resSeq: seq, chain: 'A' },
      { element: 'C', x: x + 1.2, y: 1.8, z: 1.1, name: 'CB', resName: 'ALA', resSeq: seq, chain: 'A' },
    ];
    const bonds = [
      { a: 1, b: 2 },
      { a: 2, b: 3 },
      { a: 3, b: 4, order: 2 as const },
      { a: 2, b: 5 },
      { a: 6, b: 7 },
      { a: 7, b: 8 },
      { a: 8, b: 9, order: 2 as const },
      { a: 7, b: 10 },
      { a: 3, b: 6 },
    ];
    return buildMolecule('protein', [...res(1, 0), ...res(2, 3.8)], bonds, { source: 'pdb', format: 'pdb' });
  }
  const hCount = (m: Molecule) => m.atoms.filter((a) => a.element === 'H').length;

  it('edits never hydrogenate single atoms of an H-free structure', () => {
    load(dipeptide(), 'add-atom');
    let m = S().molecule!;
    h.click(...h.screenOf(m, 5)); // add a carbon to CB
    m = S().molecule!;
    expect(S().past.at(-1)?.label).toBe('Add C');
    expect(hCount(m)).toBe(0);
    useStore.setState({ tool: 'element', editElement: 'O' });
    h.click(...h.screenOf(m, 10)); // CB of residue 2 → O
    m = S().molecule!;
    expect(S().past.at(-1)?.label).toBe('Change C to O');
    useStore.setState({ tool: 'charge' });
    h.click(...h.screenOf(m, 1));
    useStore.setState({ tool: 'delete' });
    h.click(...h.screenOf(S().molecule!, 5));
    m = S().molecule!;
    expect(S().past.map((e) => e.label)).toEqual(['Add C', 'Change C to O', 'Charge N⁺ (+1)', 'Delete C']);
    expect(hCount(m)).toBe(0);
    // the residue info is kept for new atoms
    expect(m.atoms.at(-1)).toMatchObject({ resName: 'ALA', chain: 'A' });
  });
});
