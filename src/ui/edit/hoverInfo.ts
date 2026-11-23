/**
 * Content model for the hover tooltip: what to say about the hovered atom or bond.
 * OWNER: edit-ui.
 */
import type { AppMode, HoverInfo, Molecule } from '../../core/types';
import { atomById, bondById } from '../../core/molecule';
import { getElement } from '../../core/elements';
import { distance, idealBondLengthInMolecule } from '../../core/geometry';
import { shouldShowUnderValence, valenceOf } from '../../core/chemistry';
import { BOND_ORDER_NAMES, formatSigned, shortAtomLabel } from './geometryModel';

export type LineTone = 'default' | 'muted' | 'ok' | 'warn' | 'error';

export interface TooltipLine {
  text: string;
  tone: LineTone;
}

export interface TooltipBadge {
  symbol: string;
  color: string;
}

export interface TooltipContent {
  kind: 'atom' | 'bond';
  badges: TooltipBadge[];
  title: string;
  /** Right-aligned faint detail in the title row (atom name / serial). */
  aside?: string;
  lines: TooltipLine[];
}

/** "+1", "−2" */
export function formatCharge(q: number): string {
  return q > 0 ? `+${q}` : `−${Math.abs(q)}`;
}

function residueText(resName: string, resSeq: number | undefined, iCode: string | undefined, chain: string | undefined): string {
  const num = `${resSeq ?? ''}${iCode ?? ''}`;
  return [`${resName}${num ? ' ' + num : ''}`, chain ? `chain ${chain}` : ''].filter(Boolean).join(' · ');
}

function describeAtom(mol: Molecule, atomId: number, mode: AppMode): TooltipContent | null {
  const a = atomById(mol, atomId);
  if (!a) return null;
  const el = getElement(a.element);
  const lines: TooltipLine[] = [];
  if (a.resName) lines.push({ text: residueText(a.resName, a.resSeq, a.iCode, a.chain) + (a.hetero ? ' · het' : ''), tone: 'default' });
  const props: string[] = [];
  if (a.bfactor !== undefined && Number.isFinite(a.bfactor)) props.push(`B ${a.bfactor.toFixed(1)}`);
  if (a.occupancy !== undefined && Number.isFinite(a.occupancy) && a.occupancy < 1) props.push(`occ ${a.occupancy.toFixed(2)}`);
  if (a.altLoc) props.push(`alt ${a.altLoc}`);
  if (props.length) lines.push({ text: props.join(' · '), tone: 'muted' });
  if (a.charge) lines.push({ text: `Charge ${formatCharge(a.charge)}`, tone: 'default' });

  if (mode === 'edit') {
    const v = valenceOf(mol, atomId);
    if (v) {
      if (v.status === 'ok') lines.push({ text: `Valence OK (${formatBondSum(v.bondOrderSum)})`, tone: 'ok' });
      else if (v.status === 'over') lines.push({ text: v.message ?? `${a.element} exceeds its valence`, tone: 'error' });
      else if (v.status === 'under' && shouldShowUnderValence(mol)) {
        const n = v.openValence;
        lines.push({ text: v.message ?? `${n} open valence${n === 1 ? '' : 's'}`, tone: 'warn' });
      }
    }
  }

  const name = a.name && a.name !== a.element ? a.name : undefined;
  const serial = a.serial !== undefined ? `#${a.serial}` : undefined;
  return {
    kind: 'atom',
    badges: [{ symbol: el.number > 0 ? el.symbol : a.element, color: el.color }],
    title: el.number > 0 ? el.name : `Unknown element (${a.element})`,
    aside: [name, serial].filter(Boolean).join(' ') || undefined,
    lines,
  };
}

function formatBondSum(sum: number): string {
  return Number.isInteger(sum) ? String(sum) : sum.toFixed(1);
}

function describeBond(mol: Molecule, bondId: number, mode: AppMode): TooltipContent | null {
  const bond = bondById(mol, bondId);
  if (!bond) return null;
  const a = atomById(mol, bond.a);
  const b = atomById(mol, bond.b);
  if (!a || !b) return null;
  const len = distance([a.x, a.y, a.z], [b.x, b.y, b.z]);
  const order = BOND_ORDER_NAMES[bond.order] ?? String(bond.order);
  const lines: TooltipLine[] = [];
  const la = shortAtomLabel(mol, a.id, !!a.resName && (a.resSeq !== b.resSeq || a.chain !== b.chain));
  const lb = shortAtomLabel(mol, b.id, !!b.resName && (a.resSeq !== b.resSeq || a.chain !== b.chain));
  lines.push({ text: `${la} – ${lb}`, tone: 'muted' });
  if (mode === 'edit') {
    const ideal = idealBondLengthInMolecule(mol, a.id, b.id, bond.order);
    const dev = len - ideal;
    lines.push({
      text: `Ideal ${ideal.toFixed(2)} Å (${dev >= 0 ? '+' : ''}${formatSigned(dev, 2)})`,
      tone: Math.abs(dev) <= 0.1 ? 'muted' : 'warn',
    });
  }
  return {
    kind: 'bond',
    badges: [
      { symbol: a.element, color: getElement(a.element).color },
      { symbol: b.element, color: getElement(b.element).color },
    ],
    title: `${a.element}–${b.element} · ${order} · ${len.toFixed(2)} Å`,
    lines,
  };
}

/** Tooltip content for the hovered item, or null if there is nothing (left) to describe. */
export function describeHover(mol: Molecule | null, hovered: HoverInfo | null, mode: AppMode): TooltipContent | null {
  if (!mol || !hovered) return null;
  if (hovered.kind === 'atom' && hovered.atomId !== undefined) return describeAtom(mol, hovered.atomId, mode);
  if (hovered.kind === 'bond' && hovered.bondId !== undefined) return describeBond(mol, hovered.bondId, mode);
  return null;
}
