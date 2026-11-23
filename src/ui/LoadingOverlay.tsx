/**
 * Loading spinner overlay over the stage (store.loading).
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 *
 * Rendered inside `.stage` (absolute). The card fades in after a short delay so quick loads
 * (embedded samples) don't flash.
 */
import { LoaderCircle } from 'lucide-react';
import { useStore } from '../state/store';
import './LoadingOverlay.css';
import './shell/shell.css';

export default function LoadingOverlay() {
  const loading = useStore((s) => s.loading);
  if (!loading) return null;
  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-card glass">
        <LoaderCircle className="loading-spinner shell-spin" size={22} aria-hidden="true" />
        <span className="loading-message">{loading}</span>
      </div>
    </div>
  );
}
