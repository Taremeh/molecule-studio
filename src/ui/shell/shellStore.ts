/**
 * Small UI-only state shared between shell components (not part of the document state).
 * Kept outside the main store so it never triggers renderer work.
 */
import { create } from 'zustand';
import { useStore } from '../../state/store';

export type LoadTab = 'gallery' | 'search' | 'smiles' | 'file' | 'new';

interface ShellState {
  /** Active tab of the load dialog (remembered between openings). */
  loadTab: LoadTab;
  setLoadTab: (tab: LoadTab) => void;
  /** Draft query of the SelectionBar. Lives here so it survives sidebar toggles and can be set from Help. */
  selectionQuery: string;
  setSelectionQuery: (q: string) => void;
  /** Bumped when another component wants the SelectionBar input focused. */
  selectionFocusTick: number;
  /** Explicit expanded / collapsed state per layer id (absent → default). */
  layerOpen: Record<string, boolean>;
  setLayerOpen: (id: string, open: boolean) => void;
  resetLayerOpen: () => void;
}

export const useShell = create<ShellState>()((set, get) => ({
  loadTab: 'gallery',
  setLoadTab: (loadTab) => set({ loadTab }),
  selectionQuery: '',
  setSelectionQuery: (selectionQuery) => set({ selectionQuery }),
  selectionFocusTick: 0,
  layerOpen: {},
  setLayerOpen: (id, open) => set({ layerOpen: { ...get().layerOpen, [id]: open } }),
  resetLayerOpen: () => set({ layerOpen: {} }),
}));

/** Open the load dialog, optionally on a specific tab. */
export function openLoadDialog(tab?: LoadTab) {
  if (tab) useShell.getState().setLoadTab(tab);
  useStore.getState().setPanel('load', true);
}

/** Put a query into the SelectionBar (opening the left sidebar if needed) and focus it. */
export function sendQueryToSelectionBar(query: string) {
  const s = useShell.getState();
  s.setSelectionQuery(query);
  useShell.setState({ selectionFocusTick: s.selectionFocusTick + 1 });
  const app = useStore.getState();
  if (!app.panels.left) app.setPanel('left', true);
}
