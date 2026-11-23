/**
 * Toast notifications (store.toasts).
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 *
 * Bottom-right stack, newest at the bottom. Info/success toasts are announced politely, warnings
 * and errors assertively. Toasts dismiss themselves (store.toast schedules it) or via the × button.
 */
import { CircleCheck, CircleX, Info, TriangleExclamationPoint, X } from 'lucide-react';
import type { ToastKind } from '../core/types';
import { useStore } from '../state/store';
import './Toasts.css';

const ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleExclamationPoint,
  error: CircleX,
};

export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={`toasts-item toasts-${t.kind}`} role={t.kind === 'error' || t.kind === 'warning' ? 'alert' : 'status'}>
            <Icon className="toasts-icon" size={16} aria-hidden="true" />
            <div className="toasts-message">{t.message}</div>
            <button type="button" className="toasts-close" onClick={() => useStore.getState().dismissToast(t.id)} title="Dismiss" aria-label="Dismiss notification">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
