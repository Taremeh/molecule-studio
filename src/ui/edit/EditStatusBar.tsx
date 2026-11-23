/**
 * Floating status/hint bar at the bottom of the stage (store.hint, valence summary).
 * OWNER: edit-ui agent. See ARCHITECTURE.md § UI.
 *
 * Shows the controller's context hint (or a default for the current mode / tool); in edit mode
 * also a valence summary (click selects the offending atoms) and the label of the last edit (click
 * undoes it).
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CircleAlert, CircleCheck, Undo2 } from 'lucide-react';
import { useStore } from '../../state/store';
import { analyzeValence, shouldShowUnderValence } from '../../core/chemistry';
import { getFragment } from '../../core/templates';
import type { Molecule } from '../../core/types';
import { defaultHint, formatShortcut } from './hints';
import './EditStatusBar.css';

interface ValenceSummary {
  over: number[];
  under: number[];
  showUnder: boolean;
}

function summarize(mol: Molecule): ValenceSummary {
  const over: number[] = [];
  const under: number[] = [];
  for (const v of analyzeValence(mol).values()) {
    if (v.status === 'over') over.push(v.atomId);
    else if (v.status === 'under') under.push(v.atomId);
  }
  return { over, under, showUnder: shouldShowUnderValence(mol) };
}

export default function EditStatusBar() {
  const { mode, tool, hint, editElement, editFragment, measureKind, pendingCount, undoLabel, showValence } = useStore(
    useShallow((s) => ({
      mode: s.mode,
      tool: s.tool,
      hint: s.hint,
      editElement: s.editElement,
      editFragment: s.editFragment,
      measureKind: s.measureKind,
      pendingCount: s.pendingMeasure.length,
      undoLabel: s.past.length ? s.past[s.past.length - 1].label : null,
      showValence: s.view.showValence,
    })),
  );
  const molecule = useStore((s) => s.molecule);
  const editing = mode === 'edit';

  const valence = useMemo(() => (editing && molecule && molecule.atoms.length ? summarize(molecule) : null), [editing, molecule]);

  const text =
    hint ??
    defaultHint({
      mode,
      tool,
      editElement,
      fragmentName: getFragment(editFragment)?.name,
      measureKind,
      pendingCount,
    });

  const select = (ids: number[]) => {
    if (ids.length) useStore.getState().setSelection(ids);
  };

  return (
    <div className={`esb glass ${editing ? 'is-edit' : ''}`}>
      <span className="esb-hint" title={text}>
        {text}
      </span>
      {valence && showValence && (
        <>
          <span className="esb-sep" />
          {valence.over.length > 0 ? (
            <button
              type="button"
              className="esb-pill is-error"
              onClick={() => select(valence.over)}
              title="Select the atoms that have more bonds than their valence allows"
            >
              <CircleAlert size={14} />
              {valence.over.length} atom{valence.over.length === 1 ? '' : 's'} exceed{valence.over.length === 1 ? 's' : ''} {valence.over.length === 1 ? 'its' : 'their'} valence
            </button>
          ) : valence.showUnder && valence.under.length > 0 ? (
            <button
              type="button"
              className="esb-pill is-warn"
              onClick={() => select(valence.under)}
              title="Select the atoms with open valences (use Add hydrogens to fill them)"
            >
              <CircleAlert size={14} />
              {valence.under.length} open valence{valence.under.length === 1 ? '' : 's'}
            </button>
          ) : (
            <span className="esb-pill is-ok" title="No valence problems found">
              <CircleCheck size={14} />
              Valences OK
            </span>
          )}
        </>
      )}
      {editing && undoLabel && (
        <>
          <span className="esb-sep" />
          <button
            type="button"
            className="esb-undo"
            onClick={() => useStore.getState().undo()}
            title={`Undo “${undoLabel}” (${formatShortcut('Mod+Z')})`}
          >
            <Undo2 size={13} />
            <span className="esb-undo-label">{undoLabel}</span>
          </button>
        </>
      )}
    </div>
  );
}
