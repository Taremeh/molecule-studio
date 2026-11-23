/**
 * Shared React hooks for the shell UI.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Molecule } from '../../core/types';
import { useStore } from '../../state/store';
import { pubchemAutocomplete } from '../../io/fetch';

/**
 * The current molecule, but only re-evaluated when its STRUCTURE changes (atoms/bonds/elements) or a
 * new document is loaded — not on every coordinate update while dragging. Use it for derived data
 * that does not depend on coordinates (atom counts of queries, formula, legends) so drags stay smooth.
 */
export function useStructureMolecule(): Molecule | null {
  const structureVersion = useStore((s) => s.structureVersion);
  const documentId = useStore((s) => s.documentId);
  const hasMolecule = useStore((s) => s.molecule !== null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => useStore.getState().molecule, [structureVersion, documentId, hasMolecule]);
}

/**
 * Molecule to evaluate a selection query against: the structure-keyed molecule for most queries,
 * the live one for coordinate-dependent queries ('within …') so their counts follow atom moves.
 */
export function useMoleculeForQuery(query: string): Molecule | null {
  const structural = useStructureMolecule();
  const coordinateDependent = /\bwithin\b/i.test(query);
  const live = useStore((s) => (coordinateDependent ? s.molecule : null));
  return coordinateDependent ? live : structural;
}

/** Returns a stable function that calls `fn` at most once per animation frame with the latest args. */
export function useRafThrottle<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const frame = useRef<number | null>(null);
  const lastArgs = useRef<A | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      // Flush the pending call so the last value is never lost on unmount.
      if (lastArgs.current) fnRef.current(...lastArgs.current);
    },
    [],
  );
  return useCallback((...args: A) => {
    lastArgs.current = args;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const a = lastArgs.current;
      lastArgs.current = null;
      if (a) fnRef.current(...a);
    });
  }, []);
}

/** `value`, updated only after it has been stable for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

// Small module-level cache so retyping a prefix does not refetch.
const autocompleteCache = new Map<string, string[]>();

/**
 * PubChem compound-name autocomplete: debounced (250 ms), aborts stale requests, ignores errors
 * (autocomplete is a convenience — failures must never interrupt typing).
 */
export function usePubChemAutocomplete(query: string, enabled: boolean): { suggestions: string[]; loading: boolean } {
  const q = query.trim();
  const active = enabled && q.length >= 2;
  const debounced = useDebouncedValue(active ? q : '', 250);
  const [state, setState] = useState<{ key: string; suggestions: string[] }>({ key: '', suggestions: [] });

  useEffect(() => {
    if (!debounced) return;
    const key = debounced.toLowerCase();
    const cached = autocompleteCache.get(key);
    if (cached) {
      setState({ key, suggestions: cached });
      return;
    }
    const ctrl = new AbortController();
    pubchemAutocomplete(debounced, ctrl.signal)
      .then((list) => {
        if (ctrl.signal.aborted) return;
        const unique = [...new Set(list)].slice(0, 8);
        if (autocompleteCache.size > 200) autocompleteCache.clear();
        autocompleteCache.set(key, unique);
        setState({ key, suggestions: unique });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ key, suggestions: [] });
      });
    return () => ctrl.abort();
  }, [debounced]);

  const key = active ? q.toLowerCase() : '';
  const suggestions = useMemo(() => {
    if (!key) return EMPTY;
    // While the next request is in flight, keep showing the previous results that still match.
    let list = state.key === key ? state.suggestions : state.key && key.startsWith(state.key) ? state.suggestions.filter((s) => s.toLowerCase().includes(key)) : EMPTY;
    // Nothing to suggest if the only candidate is exactly what was typed.
    if (list.length === 1 && list[0].toLowerCase() === key) list = EMPTY;
    return list;
  }, [key, state]);
  return { suggestions, loading: active && state.key !== key };
}

const EMPTY: string[] = [];

/** True while an app-level load (store.loading) is in progress. */
export function useIsLoading(): boolean {
  return useStore((s) => s.loading !== null);
}

/**
 * Runs abortable loads one at a time: starting a new one aborts the previous. `active` is true
 * while a load started here is in flight (for a Cancel button).
 */
export function useAbortableLoad() {
  const ref = useRef<AbortController | null>(null);
  const [active, setActive] = useState(false);
  const run = useCallback((fn: (signal: AbortSignal) => Promise<unknown>) => {
    ref.current?.abort();
    const ctrl = new AbortController();
    ref.current = ctrl;
    setActive(true);
    void fn(ctrl.signal).finally(() => {
      if (ref.current === ctrl) {
        ref.current = null;
        setActive(false);
      }
    });
  }, []);
  const cancel = useCallback(() => ref.current?.abort(), []);
  return { run, cancel, active };
}
