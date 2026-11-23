/**
 * Text input with an autocomplete dropdown (keyboard navigable). Used for PubChem name search.
 * Picking a suggestion (click, or ↓/↑ + Enter/Tab) calls `onSubmit` with it directly.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { HighlightMatch, SuggestList, useSuggestNav } from './Combobox';
import './shell.css';

export function SearchField(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  suggestions?: string[];
  /** Footer under the suggestions, e.g. "Searching PubChem…". */
  suggestFooter?: ReactNode;
  placeholder?: string;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  icon?: ReactNode;
  /** Extra content inside the field on the right (badges, buttons). */
  trailing?: ReactNode;
  className?: string;
  inputClassName?: string;
  maxLength?: number;
  spellCheck?: boolean;
  invalid?: boolean;
}) {
  const suggestions = props.suggestions ?? [];
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const pick = (i: number) => {
    const s = suggestions[i];
    if (s === undefined) return;
    props.onChange(s);
    nav.setOpen(false);
    props.onSubmit(s);
  };
  const nav = useSuggestNav(suggestions.length, pick, suggestions.join('\n'));
  const showList = focused && nav.open && suggestions.length > 0;

  return (
    <div className={`shell-combo shell-field ${props.className ?? ''}`}>
      {props.icon && <span className="shell-field-icon">{props.icon}</span>}
      <input
        ref={inputRef}
        className={`input shell-field-input ${props.icon ? 'has-icon' : ''} ${props.invalid ? 'is-error' : ''} ${props.inputClassName ?? ''}`}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        maxLength={props.maxLength}
        spellCheck={props.spellCheck ?? false}
        autoComplete="off"
        role="combobox"
        aria-label={props.ariaLabel}
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && nav.active >= 0 ? `${listId}-${nav.active}` : undefined}
        aria-invalid={props.invalid || undefined}
        title={props.title}
        onChange={(e) => {
          props.onChange(e.target.value);
          nav.setOpen(true);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          nav.setOpen(false);
        }}
        onKeyDown={(e) => {
          if (nav.onKeyDown(e)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            nav.setOpen(false);
            if (props.value.trim()) props.onSubmit(props.value);
          }
        }}
      />
      {props.trailing && <span className="shell-field-trailing">{props.trailing}</span>}
      {showList && (
        <SuggestList
          id={listId}
          active={nav.active}
          items={suggestions.map((s) => ({ key: s, label: <HighlightMatch text={s} query={props.value} /> }))}
          onPick={pick}
          onHover={nav.setActive}
          footer={props.suggestFooter}
        />
      )}
    </div>
  );
}
