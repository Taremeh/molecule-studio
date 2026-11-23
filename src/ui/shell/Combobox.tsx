/**
 * Autocomplete dropdown primitives shared by the selection bar and the search boxes:
 * `useSuggestNav` handles keyboard navigation, `SuggestList` renders an ARIA listbox.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import './shell.css';

export interface SuggestNav {
  /** Index of the highlighted item, -1 if none. */
  active: number;
  setActive: (i: number) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Call from the input's onKeyDown. Returns true if the event was handled (caller should stop). */
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => boolean;
}

/**
 * Keyboard navigation for a suggestion list: ↓/↑ move (wrapping), Enter/Tab accept the highlighted
 * item, Escape closes the list (without letting the Escape reach dialogs / global shortcuts).
 * `resetKey` resets the highlight when the item list changes.
 */
export function useSuggestNav(count: number, onAccept: (index: number) => void, resetKey: unknown): SuggestNav {
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  useEffect(() => setActive(-1), [resetKey]);
  const visible = open && count > 0;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): boolean => {
    if (e.key === 'ArrowDown') {
      if (count === 0) return false;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
      } else setActive((active + 1) % count);
      return true;
    }
    if (!visible) return false;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active <= 0 ? count - 1 : active - 1);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && active >= 0 && active < count) {
      e.preventDefault();
      onAccept(active);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
      return true;
    }
    return false;
  };
  return { active: visible ? active : -1, setActive, open: visible, setOpen, onKeyDown };
}

export interface SuggestItem {
  key: string;
  label: ReactNode;
  /** Secondary text on the right. */
  hint?: ReactNode;
}

export function SuggestList(props: {
  id: string;
  items: SuggestItem[];
  active: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  /** Optional footer (e.g. "Searching…"). */
  footer?: ReactNode;
  className?: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (props.active < 0) return;
    const el = listRef.current?.children[props.active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [props.active]);
  return (
    <div className={`shell-suggest ${props.className ?? ''}`}>
      <ul ref={listRef} id={props.id} role="listbox" className="shell-suggest-list">
        {props.items.map((item, i) => (
          <li
            key={item.key}
            id={`${props.id}-${i}`}
            role="option"
            aria-selected={i === props.active}
            className={`shell-suggest-item ${i === props.active ? 'is-active' : ''}`}
            // Keep focus in the input so typing continues after a click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(i)}
            onMouseEnter={() => props.onHover(i)}
          >
            <span className="shell-suggest-label">{item.label}</span>
            {item.hint && <span className="shell-suggest-hint">{item.hint}</span>}
          </li>
        ))}
      </ul>
      {props.footer && <div className="shell-suggest-footer">{props.footer}</div>}
    </div>
  );
}

/** Highlights the part of `text` matching `query` (case-insensitive, first occurrence). */
export function HighlightMatch({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="shell-mark">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
