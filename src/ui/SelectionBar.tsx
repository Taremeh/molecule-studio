/**
 * Selection query input with autocomplete, quick chips, result count, and actions (select, focus, make layer, clear).
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 *
 * The query is validated live (atom count or parse error) as you type. Enter selects the matching
 * atoms (Shift+Enter adds them to the selection); ↓/↑ + Enter/Tab pick an autocomplete suggestion.
 */
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { CircleAlert, Focus, Layers, MousePointerClick, Search, X } from 'lucide-react';
import { useStore } from '../state/store';
import { evaluateSelection, maskToIds, quickSelections, selectionSuggestions } from '../core/selection';
import { getViewer } from '../render/viewerApi';
import { focusSelection } from '../app/actions';
import { Button, IconButton } from './common';
import { SuggestList, useSuggestNav } from './shell/Combobox';
import { useShell } from './shell/shellStore';
import { useMoleculeForQuery, useStructureMolecule } from './shell/hooks';
import { applySuggestion, idsToQuery, layerNameFromQuery, mentionsSelected } from './shell/query';
import { plural } from './shell/format';
import './SelectionBar.css';

const MAX_SUGGESTIONS = 8;
let handledFocusTick = 0;
const MAX_CHIPS = 10;

/** Evaluate a query against the live molecule (with the current selection for 'selected'). */
function evaluateNow(query: string) {
  const s = useStore.getState();
  if (!s.molecule) return null;
  const res = evaluateSelection(s.molecule, query, mentionsSelected(query) ? { selectedIds: s.selection } : {});
  return { res, ids: res.error ? [] : maskToIds(s.molecule, res.mask) };
}

export default function SelectionBar() {
  const mol = useStructureMolecule();
  const selection = useStore((s) => s.selection);
  const query = useShell((s) => s.selectionQuery);
  const setQuery = useShell((s) => s.setSelectionQuery);
  const focusTick = useShell((s) => s.selectionFocusTick);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [showAllChips, setShowAllChips] = useState(false);

  // Another component (e.g. Help) asked to focus the input. Handle each request once, so
  // re-mounting the sidebar later doesn't steal focus.
  useEffect(() => {
    if (focusTick === handledFocusTick) return;
    handledFocusTick = focusTick;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusTick]);

  // Live validation: deferred so typing stays responsive on large structures.
  const deferredQuery = useDeferredValue(query);
  const trimmed = deferredQuery.trim();
  const usesSel = mentionsSelected(trimmed);
  const evalMol = useMoleculeForQuery(trimmed);
  const result = useMemo(() => {
    if (!evalMol || !trimmed) return null;
    return evaluateSelection(evalMol, trimmed, usesSel ? { selectedIds: selection } : {});
  }, [evalMol, trimmed, usesSel, usesSel ? selection : null]);

  const suggestions = useMemo(() => {
    if (!mol || !focused) return [] as string[];
    return selectionSuggestions(mol, query).slice(0, MAX_SUGGESTIONS);
  }, [mol, query, focused]);

  const accept = (i: number) => {
    const s = suggestions[i];
    if (s !== undefined) setQuery(applySuggestion(query, s));
  };
  const nav = useSuggestNav(suggestions.length, accept, suggestions.join('\n'));

  const chips = useMemo(() => (mol ? quickSelections(mol) : []), [mol]);
  const visibleChips = showAllChips ? chips : chips.slice(0, MAX_CHIPS);

  const disabled = !mol || mol.atoms.length === 0;
  const hasQuery = query.trim().length > 0;
  const error = result?.error;

  const doSelect = (q: string, add = false) => {
    const out = evaluateNow(q.trim());
    if (!out) return;
    if (out.res.error) {
      useStore.getState().toast(out.res.error, 'warning');
      return;
    }
    if (out.ids.length === 0) useStore.getState().toast('No atoms match this query', 'info', 2000);
    if (add) useStore.getState().addToSelection(out.ids);
    else useStore.getState().setSelection(out.ids);
    nav.setOpen(false);
  };

  const doFocus = () => {
    const q = query.trim();
    if (!q) return focusSelection();
    const out = evaluateNow(q);
    if (!out || out.res.error) return;
    if (out.ids.length === 0) {
      useStore.getState().toast('No atoms match this query', 'info', 2000);
      return;
    }
    getViewer()?.focusAtoms(out.ids, true);
  };

  const doNewLayer = () => {
    const q = query.trim();
    const out = evaluateNow(q);
    if (!out || out.res.error) return;
    if (out.ids.length === 0) {
      useStore.getState().toast('No atoms match this query', 'info', 2000);
      return;
    }
    // Layers are evaluated without the live selection, so freeze 'selected' into atom ids.
    const layerQuery = mentionsSelected(q) ? idsToQuery(out.ids) : q;
    const name = layerNameFromQuery(q);
    const id = useStore.getState().addRep({
      name,
      selection: layerQuery,
      style: out.ids.length > 5000 ? 'lines' : 'ball-and-stick',
      color: 'element',
    });
    useShell.getState().setLayerOpen(id, true);
    useStore.getState().toast(`Added layer “${name}” · ${plural(out.ids.length, 'atom')}`, 'success', 2200);
  };

  const onChip = (e: MouseEvent, q: string) => {
    setQuery(q);
    doSelect(q, e.shiftKey || e.metaKey || e.ctrlKey);
  };

  return (
    <div className={`selbar ${disabled ? 'is-disabled-bar' : ''}`}>
      <div className="selbar-head">
        <span className="selbar-title">Select</span>
        {selection.size > 0 && (
          <span className="selbar-status" aria-live="polite">
            <span className="selbar-dot" aria-hidden="true" />
            {plural(selection.size, 'atom')} selected
            <button type="button" className="selbar-status-clear" title="Clear selection (Esc)" aria-label="Clear selection" onClick={() => useStore.getState().clearSelection()}>
              <X size={12} />
            </button>
          </span>
        )}
      </div>

      <div className="shell-combo selbar-combo">
        <Search className="selbar-search-icon" size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          className={`input selbar-input ${error ? 'is-error' : ''}`}
          value={query}
          disabled={disabled}
          placeholder={disabled ? 'Load a molecule to select atoms' : 'e.g. protein and chain A, within 5 of ligand'}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-label="Selection query"
          aria-autocomplete="list"
          aria-expanded={nav.open}
          aria-controls={listId}
          aria-activedescendant={nav.active >= 0 ? `${listId}-${nav.active}` : undefined}
          aria-invalid={!!error}
          title="Selection query — press Enter to select, Shift+Enter to add to the selection. Press ? for the syntax."
          onChange={(e) => {
            setQuery(e.target.value);
            nav.setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            // Don't pop a list on a plain click into an empty box; typing or ↓ opens it.
            nav.setOpen(query.length > 0);
          }}
          onBlur={() => {
            setFocused(false);
            nav.setOpen(false);
          }}
          onKeyDown={(e) => {
            if (nav.onKeyDown(e)) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              if (query.trim()) doSelect(query, e.shiftKey);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (query) setQuery('');
              else inputRef.current?.blur();
            }
          }}
        />
        {result && !error && hasQuery && (
          <span className={`selbar-count ${result.count === 0 ? 'is-zero' : ''}`} title={`${plural(result.count, 'atom')} match`}>
            {result.count.toLocaleString('en-US')}
          </span>
        )}
        {nav.open && suggestions.length > 0 && (
          <SuggestList
            id={listId}
            active={nav.active}
            items={suggestions.map((s) => ({ key: s, label: s }))}
            onPick={(i) => accept(i)}
            onHover={nav.setActive}
            footer="↑↓ to choose · Enter or Tab to insert · Esc to close"
          />
        )}
      </div>

      <div className={`selbar-feedback ${error ? 'is-error' : ''}`} aria-live="polite">
        {disabled ? null : error ? (
          <>
            <CircleAlert size={13} aria-hidden="true" />
            <span>{error}</span>
          </>
        ) : result && hasQuery ? (
          <span>
            {result.count === 0 ? 'No atoms match' : `${plural(result.count, 'atom')} match`}
            {usesSel && selection.size === 0 ? ' · nothing is selected yet' : ''}
          </span>
        ) : (
          <span className="selbar-hint">
            {chips.length > 0 ? 'Type a query or pick a chip below' : 'Type a query, e.g. element C or within 3 of id 1'} · <button type="button" className="selbar-link" onClick={() => useStore.getState().setPanel('help', true)} title="Selection language reference">syntax</button>
          </span>
        )}
      </div>

      <div className="selbar-actions">
        <Button
          small
          variant="primary"
          icon={<MousePointerClick size={14} />}
          disabled={disabled || !hasQuery || !!error}
          onClick={() => doSelect(query)}
          title="Select the matching atoms (Enter). Shift+Enter adds them to the current selection."
        >
          Select
        </Button>
        <IconButton icon={<Focus />} title={hasQuery ? 'Zoom to the matching atoms' : 'Zoom to the selection'} disabled={disabled || !!error} onClick={doFocus} className="selbar-icon-btn" />
        <IconButton icon={<Layers />} title="New layer from this query" disabled={disabled || !hasQuery || !!error} onClick={doNewLayer} className="selbar-icon-btn" />
        <span className="grow" />
        <Button small variant="ghost" disabled={selection.size === 0} onClick={() => useStore.getState().clearSelection()} title="Clear the selection (Esc)">
          Clear
        </Button>
      </div>

      {!disabled && chips.length > 0 && (
        <div className="selbar-chips" aria-label="Quick selections">
          {visibleChips.map((c) => (
            <button
              key={c.label + c.query}
              type="button"
              className={`chip ${query.trim() === c.query ? 'is-active' : ''}`}
              title={`Select: ${c.query}  (Shift-click to add)`}
              onClick={(e) => onChip(e, c.query)}
            >
              {c.label}
            </button>
          ))}
          {chips.length > MAX_CHIPS && (
            <button type="button" className="chip selbar-more" onClick={() => setShowAllChips((v) => !v)} title={showAllChips ? 'Show fewer' : 'Show all quick selections'}>
              {showAllChips ? 'Less' : `+${chips.length - MAX_CHIPS} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
