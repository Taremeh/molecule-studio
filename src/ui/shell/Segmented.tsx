/**
 * Segmented control (radio group rendered as joined buttons) with arrow-key navigation.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import './shell.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: ReactNode;
  title: string;
  disabled?: boolean;
}

export function Segmented<T extends string>(props: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
  /** Stretch the segments to fill the width. */
  block?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = props.options.filter((o) => !o.disabled);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || enabled.length === 0) return;
    e.preventDefault();
    const cur = enabled.findIndex((o) => o.value === props.value);
    let next = cur;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = cur <= 0 ? enabled.length - 1 : cur - 1;
    else next = (cur + 1) % enabled.length;
    const v = enabled[next].value;
    props.onChange(v);
    // Move focus with the selection (roving tabindex).
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(v)}"]`)?.focus());
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={props.ariaLabel}
      className={`shell-seg shell-seg-${props.size ?? 'md'} ${props.block ? 'shell-seg-block' : ''} ${props.className ?? ''}`}
      onKeyDown={onKeyDown}
    >
      {props.options.map((o) => {
        const checked = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={o.value}
            tabIndex={checked ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            className={`shell-seg-btn ${checked ? 'is-checked' : ''}`}
            onClick={() => !checked && props.onChange(o.value)}
          >
            {o.icon}
            {o.label !== undefined && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
