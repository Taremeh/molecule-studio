/**
 * Shared UI primitives. OWNER: integration. Styles live in styles/global.css.
 * Use these for a consistent look; add component-specific CSS in your own component's .css file.
 */
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';

type BtnVariant = 'default' | 'primary' | 'ghost' | 'danger';

export function Button(props: {
  children?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  variant?: BtnVariant;
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
  active?: boolean;
  small?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  style?: CSSProperties;
}) {
  const cls = ['btn', `btn-${props.variant ?? 'default'}`, props.active ? 'is-active' : '', props.small ? 'btn-sm' : '', props.className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type={props.type ?? 'button'} className={cls} onClick={props.onClick} disabled={props.disabled} title={props.title} style={props.style}>
      {props.icon}
      {props.children !== undefined && <span>{props.children}</span>}
    </button>
  );
}

export function IconButton(props: {
  icon: ReactNode;
  title: string;
  onClick?: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  variant?: BtnVariant;
  className?: string;
  /** Shortcut shown in the tooltip, e.g. 'Ctrl+Z'. */
  shortcut?: string;
}) {
  const cls = ['icon-btn', props.active ? 'is-active' : '', props.variant ? `btn-${props.variant}` : '', props.className ?? ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={cls}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.shortcut ? `${props.title} (${props.shortcut})` : props.title}
      aria-label={props.title}
      aria-pressed={props.active}
    >
      {props.icon}
    </button>
  );
}

export function Section(props: {
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section className={`section ${open ? 'is-open' : ''} ${props.className ?? ''}`}>
      <header className="section-header">
        <button type="button" className="section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="section-caret">{open ? '▾' : '▸'}</span>
          <span className="section-title">{props.title}</span>
        </button>
        {props.actions && <div className="section-actions">{props.actions}</div>}
      </header>
      {open && <div className="section-body">{props.children}</div>}
    </section>
  );
}

export function Select<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  title?: string;
  className?: string;
}) {
  return (
    <select className={`select ${props.className ?? ''}`} value={props.value} title={props.title} onChange={(e) => props.onChange(e.target.value as T)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** Called on pointer up / change end. */
  onCommit?: (v: number) => void;
  label?: ReactNode;
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  return (
    <label className={`slider ${props.disabled ? 'is-disabled' : ''}`}>
      {props.label && <span className="slider-label">{props.label}</span>}
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 0.01}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        onPointerUp={(e) => props.onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => props.onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
      />
      {props.format && <span className="slider-value">{props.format(props.value)}</span>}
    </label>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <label className={`toggle ${props.disabled ? 'is-disabled' : ''}`} title={props.title}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{props.label}</span>
    </label>
  );
}

export function Chip(props: { children: ReactNode; onClick?: () => void; active?: boolean; title?: string; color?: string }) {
  return (
    <button type="button" className={`chip ${props.active ? 'is-active' : ''}`} onClick={props.onClick} title={props.title}>
      {props.color && <span className="chip-dot" style={{ background: props.color }} />}
      {props.children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Popover anchored below its trigger. Closes on outside click / Escape. */
export function Popover(props: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /** Open upwards / to the side. */
  placement?: 'bottom' | 'right' | 'top';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="popover-anchor" ref={ref}>
      {props.trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className={`popover popover-${props.placement ?? 'bottom'} popover-align-${props.align ?? 'left'} ${props.className ?? ''}`}>
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Centered modal dialog with backdrop. */
export function Modal(props: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number; className?: string }) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);
  if (!props.open) return null;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.className ?? ''}`} style={{ width: props.width ?? 720 }} role="dialog" aria-modal="true">
        <header className="modal-header">
          <h2>{props.title}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

/** Number input that commits on Enter/blur, with unit suffix. */
export function NumberField(props: {
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  digits?: number;
  disabled?: boolean;
  title?: string;
}) {
  const digits = props.digits ?? 2;
  const [text, setText] = useState(props.value.toFixed(digits));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(Number.isFinite(props.value) ? props.value.toFixed(digits) : '—');
  }, [props.value, focused, digits]);
  const commit = () => {
    const v = parseFloat(text);
    if (Number.isFinite(v)) {
      let c = v;
      if (props.min !== undefined) c = Math.max(props.min, c);
      if (props.max !== undefined) c = Math.min(props.max, c);
      props.onCommit(c);
    } else setText(props.value.toFixed(digits));
  };
  return (
    <span className={`number-field ${props.disabled ? 'is-disabled' : ''}`} title={props.title}>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        disabled={props.disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(props.value.toFixed(digits));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {props.unit && <span className="number-unit">{props.unit}</span>}
    </span>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="empty-hint">{children}</div>;
}
