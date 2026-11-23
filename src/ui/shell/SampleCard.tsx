/**
 * Sample card used by the load dialog gallery and the empty-state quick start.
 */
import { Dna, FlaskConical, Gem, LoaderCircle, Shapes } from 'lucide-react';
import type { SampleEntry } from '../../io/samples';
import { CATEGORY_BADGES, sampleSourceLabel, type SampleCategory } from './samples';
import { formatApprox } from './format';
import './shell.css';
import './SampleCard.css';

const CATEGORY_ICONS: Record<SampleCategory, typeof FlaskConical> = {
  small: FlaskConical,
  protein: Shapes,
  nucleic: Dna,
  material: Gem,
};

export function CategoryIcon({ category, size = 16 }: { category: SampleCategory; size?: number }) {
  const Icon = CATEGORY_ICONS[category] ?? FlaskConical;
  return <Icon size={size} aria-hidden="true" />;
}

export function SampleCard(props: {
  sample: SampleEntry;
  onOpen: (s: SampleEntry) => void;
  disabled?: boolean;
  pending?: boolean;
  compact?: boolean;
}) {
  const s = props.sample;
  const atoms = s.approxAtoms !== undefined ? `${formatApprox(s.approxAtoms)} ${s.approxAtoms === 1 ? 'atom' : 'atoms'}` : null;
  const source = sampleSourceLabel(s);
  return (
    <button
      type="button"
      className={`shell-sample-card shell-sample-${s.category} ${props.compact ? 'is-compact' : ''} ${props.pending ? 'is-pending' : ''}`}
      onClick={() => props.onOpen(s)}
      disabled={props.disabled}
      title={`Open ${s.name} — ${s.description}${s.source.kind === 'embedded' ? ' (works offline)' : ` (downloads from ${source})`}`}
    >
      <span className="shell-sample-icon">{props.pending ? <LoaderCircle size={props.compact ? 16 : 18} className="shell-spin" /> : <CategoryIcon category={s.category} size={props.compact ? 16 : 18} />}</span>
      <span className="shell-sample-text">
        <span className="shell-sample-name">{s.name}</span>
        <span className="shell-sample-desc">{s.description}</span>
        {!props.compact && (
          <span className="shell-sample-meta">
            <span className="shell-sample-badge">{CATEGORY_BADGES[s.category]}</span>
            {atoms && <span>{atoms}</span>}
            <span className="shell-sample-source">{source}</span>
          </span>
        )}
        {props.compact && atoms && <span className="shell-sample-meta">{atoms}</span>}
      </span>
    </button>
  );
}
