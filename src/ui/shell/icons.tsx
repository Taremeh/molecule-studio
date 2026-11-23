/**
 * Custom icons for the shell UI: app logo and one glyph per representation style
 * (lucide has no molecular-graphics icons). All use currentColor so they follow the theme.
 */
import { useId } from 'react';
import type { RepStyle } from '../../core/types';

export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  // Unique gradient ids per instance (duplicate ids break when one copy is hidden).
  const uid = 'mslogo' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const a = `${uid}a`;
  const b = `${uid}b`;
  const c = `${uid}c`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <radialGradient id={a} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#bfdbfe" />
          <stop offset="55%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#2563eb" />
        </radialGradient>
        <radialGradient id={b} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#fecaca" />
          <stop offset="55%" stopColor="#f87171" />
          <stop offset="100%" stopColor="#dc2626" />
        </radialGradient>
        <radialGradient id={c} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="60%" stopColor="#e5e7eb" />
          <stop offset="100%" stopColor="#9ca3af" />
        </radialGradient>
      </defs>
      <path d="M20 38 L44 22 M20 38 L46 48" stroke="#94a3b8" strokeWidth="5" strokeLinecap="round" />
      <circle cx="20" cy="38" r="13" fill={`url(#${a})`} />
      <circle cx="44" cy="21" r="10" fill={`url(#${b})`} />
      <circle cx="47" cy="48" r="8" fill={`url(#${c})`} />
    </svg>
  );
}

export const REP_STYLE_INFO: Record<RepStyle, { label: string; description: string }> = {
  'ball-and-stick': { label: 'Ball & stick', description: 'Atoms as balls, bonds as sticks — shows bond orders' },
  spacefill: { label: 'Spacefill', description: 'Atoms at van der Waals size — shows shape and packing' },
  licorice: { label: 'Sticks', description: 'Bonds as rounded sticks — clean view of connectivity' },
  lines: { label: 'Lines', description: 'Thin lines — fastest, good for large systems' },
  cartoon: { label: 'Cartoon', description: 'Ribbon of the protein / nucleic-acid backbone (helices, sheets)' },
  surface: { label: 'Surface', description: 'Solvent-accessible molecular surface' },
};

export const REP_STYLE_ORDER: RepStyle[] = ['ball-and-stick', 'licorice', 'spacefill', 'lines', 'cartoon', 'surface'];

export function StyleIcon({ style, size = 16 }: { style: RepStyle; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true } as const;
  switch (style) {
    case 'ball-and-stick':
      return (
        <svg {...common}>
          <path d="M4.5 11.5 L11.5 4.5" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="4.2" cy="11.8" r="2.7" fill="currentColor" />
          <circle cx="11.8" cy="4.2" r="2.2" fill="currentColor" />
        </svg>
      );
    case 'spacefill':
      return (
        <svg {...common}>
          <circle cx="10.3" cy="6" r="4" fill="currentColor" fillOpacity="0.45" />
          <circle cx="6.2" cy="9.8" r="4.6" fill="currentColor" />
        </svg>
      );
    case 'licorice':
      return (
        <svg {...common}>
          <path d="M2.8 12 L7.6 6 L13.2 9.6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'lines':
      return (
        <svg {...common}>
          <path d="M1.8 11.5 L5.2 5 L9 11.5 L12.6 5 L14.4 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'cartoon':
      return (
        <svg {...common}>
          <path d="M1.8 8 C3.5 2.5 5.5 2.5 7 8 S10.5 13.5 12.2 8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M12 5.4 L15 8 L12 10.6 Z" fill="currentColor" />
        </svg>
      );
    case 'surface':
      return (
        <svg {...common}>
          <path
            d="M3 9.2c-.6-3 1.6-6 4.6-6.1 2-.1 3 1 4.1 1.6 1.6.9 2.3 2.6 1.8 4.4-.6 2.3-2.8 3.8-5.2 3.8C5.6 12.9 3.4 11.4 3 9.2z"
            fill="currentColor"
            fillOpacity="0.35"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
      );
  }
}
