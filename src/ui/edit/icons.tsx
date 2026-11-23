/**
 * Small custom SVG icons in the lucide style (24×24 viewBox, 2px round strokes, currentColor)
 * for concepts lucide has no glyph for: bond orders, angles, dihedrals, hydrogens, charges.
 * OWNER: edit-ui.
 */
import type { SVGProps } from 'react';
import type { BondOrder, MeasureKind } from '../../core/types';
import { Ruler } from 'lucide-react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** One to three parallel diagonal lines (aromatic: one solid + one dashed). */
export function BondOrderIcon({ order, ...rest }: IconProps & { order: BondOrder }) {
  const offsets = order === 3 ? [-4, 0, 4] : order === 2 || order === 1.5 ? [-2.5, 2.5] : [0];
  // Lines run from lower-left to upper-right; offset perpendicular to that direction.
  const k = Math.SQRT1_2;
  return (
    <Svg {...rest}>
      {offsets.map((o, i) => (
        <line
          key={o}
          x1={5 + o * k}
          y1={19 + o * k}
          x2={19 + o * k}
          y2={5 + o * k}
          strokeDasharray={order === 1.5 && i === 1 ? '2.5 2.5' : undefined}
        />
      ))}
    </Svg>
  );
}

export function AngleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 19H4l11-13" />
      <path d="M10.5 19a6.5 6.5 0 0 0-2-4.7" />
    </Svg>
  );
}

export function DihedralIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 17l6-9 6 8 6-10" />
      <circle cx="9" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="16" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function MeasureKindIcon({ kind, ...rest }: IconProps & { kind: MeasureKind }) {
  if (kind === 'angle') return <AngleIcon {...rest} />;
  if (kind === 'dihedral') return <DihedralIcon {...rest} />;
  return <Ruler size={rest.size ?? 18} aria-hidden="true" />;
}

/** "H" with a small plus / minus badge. */
export function HydrogenIcon({ sign, ...rest }: IconProps & { sign: '+' | '-' }) {
  return (
    <Svg {...rest}>
      <path d="M4 5v14M13 5v14M4 12h9" />
      <path d="M17 8h5" />
      {sign === '+' && <path d="M19.5 5.5v5" />}
    </Svg>
  );
}

/** Circle with ± for the formal-charge tool. */
export function ChargeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6.5v6M9 9.5h6M9 16.5h6" />
    </Svg>
  );
}
