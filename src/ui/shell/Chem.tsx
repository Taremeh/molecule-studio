/**
 * Small chemistry display components: element badge and formula with subscripts.
 */
import { getElement } from '../../core/elements';
import { chargeSuffix, formulaParts, readableTextColor } from './format';
import './shell.css';

/** Round badge in the element's CPK color with its symbol (and charge), e.g. a blue "N⁺". */
export function ElementBadge({ element, charge, size = 22, title }: { element: string; charge?: number; size?: number; title?: string }) {
  const info = getElement(element);
  const bg = info.color;
  return (
    <span
      className="shell-element"
      title={title ?? `${info.name}${info.number ? ` (Z = ${info.number})` : ''}`}
      style={{
        width: size,
        height: size,
        background: bg,
        color: readableTextColor(bg),
        fontSize: Math.max(9, Math.round(size * (element.length > 1 ? 0.42 : 0.5))),
      }}
    >
      {element}
      {charge ? <sup style={{ fontSize: '0.7em', marginLeft: 1 }}>{chargeSuffix(charge)}</sup> : null}
    </span>
  );
}

/** Hill formula with digit subscripts. */
export function Formula({ formula }: { formula: string }) {
  if (!formula) return <span className="muted">—</span>;
  return (
    <span className="shell-formula" aria-label={formula}>
      {formulaParts(formula).map((p, i) => (p.sub ? <sub key={i}>{p.text}</sub> : <span key={i}>{p.text}</span>))}
    </span>
  );
}
