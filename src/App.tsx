/**
 * Application layout. OWNER: integration.
 *
 * ┌──────────────────────────── TopBar ────────────────────────────┐
 * │ left sidebar │            stage (3D viewport)       │ right sb  │
 * │ SelectionBar │  EditToolbar (edit mode, floating)   │ InfoPanel │
 * │ LayersPanel  │  EmptyState / HoverTooltip / status  │ Geometry  │
 * │              │                                      │ Measures  │
 * ├──────────────────────────── SequenceViewer ────────────────────┤
 */
import { useEffect } from 'react';
import { useStore } from './state/store';
import { installShortcuts } from './editor/shortcuts';
import Viewport from './ui/Viewport';
import TopBar from './ui/TopBar';
import LoadDialog from './ui/LoadDialog';
import DropOverlay from './ui/DropOverlay';
import LayersPanel from './ui/LayersPanel';
import SelectionBar from './ui/SelectionBar';
import InfoPanel from './ui/InfoPanel';
import SettingsPanel from './ui/SettingsPanel';
import Toasts from './ui/Toasts';
import LoadingOverlay from './ui/LoadingOverlay';
import HelpOverlay from './ui/HelpOverlay';
import EmptyState from './ui/EmptyState';
import EditToolbar from './ui/edit/EditToolbar';
import EditStatusBar from './ui/edit/EditStatusBar';
import GeometryInspector from './ui/GeometryInspector';
import MeasurementsPanel from './ui/MeasurementsPanel';
import SequenceViewer from './ui/SequenceViewer';
import HoverTooltip from './ui/HoverTooltip';
import { getTopology } from './core/molecule';

export default function App() {
  const theme = useStore((s) => s.view.theme);
  const mode = useStore((s) => s.mode);
  const panels = useStore((s) => s.panels);
  const molecule = useStore((s) => s.molecule);
  const hasPolymer = useStore((s) => {
    const m = s.molecule;
    if (!m) return false;
    return getTopology(m).residues.some((r) => r.kind === 'protein' || r.kind === 'nucleic');
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => installShortcuts(), []);

  return (
    <div className="app" data-mode={mode}>
      <TopBar />
      <div className="app-main">
        {panels.left && (
          <aside className="sidebar sidebar-left">
            <SelectionBar />
            <LayersPanel />
          </aside>
        )}
        <div className="stage">
          <Viewport />
          {!molecule && <EmptyState />}
          {mode === 'edit' && molecule && <EditToolbar />}
          {molecule && <EditStatusBar />}
          <HoverTooltip />
          <LoadingOverlay />
        </div>
        {panels.right && (
          <aside className="sidebar sidebar-right">
            <InfoPanel />
            <GeometryInspector />
            <MeasurementsPanel />
          </aside>
        )}
      </div>
      {panels.sequence && hasPolymer ? <SequenceViewer /> : <div />}
      <LoadDialog />
      <SettingsPanel />
      <HelpOverlay />
      <DropOverlay />
      <Toasts />
    </div>
  );
}
