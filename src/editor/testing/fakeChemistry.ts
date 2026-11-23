/**
 * TEST ONLY — minimal implementation of the core/chemistry contract (valence rules for H C N O F S Cl
 * with the documented charge rules), so the editor's tests are deterministic and independent of the
 * concurrently developed core/chemistry.ts.
 * Used via vi.mock('../core/chemistry', () => import('./testing/fakeChemistry')).
 */
import type { BondOrder, Molecule } from '../../core/types';
import type { ValenceInfo } from '../../core/chemistry';
import { atomById, bondBetween, getTopology } from '../../core/molecule';

const NEUTRAL: Record<string, number[]> = { H: [1], C: [4], N: [3], O: [2], F: [1], S: [2, 4, 6], Cl: [1], Ne: [0] };

export function allowedValences(element: string, charge = 0): number[] {
  if (charge) {
    if ((element === 'N' || element === 'O' || element === 'S') && charge === 1) return [element === 'N' ? 4 : 3];
    if (element === 'N' && charge === -1) return [2];
    if (element === 'O' && charge === -1) return [1];
    if (element === 'C' && Math.abs(charge) === 1) return [3];
  }
  return NEUTRAL[element] ?? [];
}

function orderSum(mol: Molecule, id: number): { sum: number; count: number } {
  const topo = getTopology(mol);
  const idx = topo.idToIndex.get(id);
  if (idx === undefined) return { sum: 0, count: 0 };
  let sum = 0;
  for (const bi of topo.atomBonds[idx]) sum += mol.bonds[bi].order;
  return { sum, count: topo.atomBonds[idx].length };
}

export function valenceOf(mol: Molecule, atomId: number): ValenceInfo | undefined {
  const a = atomById(mol, atomId);
  if (!a) return undefined;
  const allowed = allowedValences(a.element, a.charge ?? 0);
  const { sum } = orderSum(mol, atomId);
  const rounded = Math.floor(sum + 1e-6);
  const max = allowed.length ? Math.max(...allowed) : Infinity;
  const status = !allowed.length ? 'unchecked' : rounded > max ? 'over' : allowed.includes(rounded) ? 'ok' : 'under';
  const next = allowed.find((v) => v >= rounded);
  return {
    atomId,
    element: a.element,
    bondOrderSum: sum,
    allowed,
    status,
    openValence: status === 'under' && next !== undefined ? next - rounded : 0,
    message: status === 'over' ? `${a.element} has ${rounded} bonds (max ${max})` : undefined,
  };
}

export function analyzeValence(mol: Molecule): Map<number, ValenceInfo> {
  const m = new Map<number, ValenceInfo>();
  for (const a of mol.atoms) m.set(a.id, valenceOf(mol, a.id)!);
  return m;
}

function exceeds(mol: Molecule, id: number, delta: number): boolean {
  const info = valenceOf(mol, id);
  if (!info || !info.allowed.length) return false;
  return Math.floor(info.bondOrderSum + delta + 1e-6) > Math.max(...info.allowed);
}

export function canAddBond(mol: Molecule, a: number, b: number, order: BondOrder): { ok: boolean; reason?: string } {
  if (a === b) return { ok: false, reason: 'same atom' };
  const A = atomById(mol, a);
  const B = atomById(mol, b);
  if (!A || !B) return { ok: false, reason: 'atom missing' };
  const existing = bondBetween(mol, a, b);
  const delta = order - (existing?.order ?? 0);
  if (!existing && Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z) > 4) return { ok: false, reason: 'too far apart' };
  if (exceeds(mol, a, delta)) return { ok: false, reason: `${A.element} would exceed its valence` };
  if (exceeds(mol, b, delta)) return { ok: false, reason: `${B.element} would exceed its valence` };
  return { ok: true };
}

export function canAcceptBond(mol: Molecule, atomId: number, order: BondOrder): { ok: boolean; reason?: string } {
  const a = atomById(mol, atomId);
  if (!a) return { ok: false, reason: 'atom missing' };
  return exceeds(mol, atomId, order) ? { ok: false, reason: `${a.element} is saturated` } : { ok: true };
}

export function shouldShowUnderValence(_mol: Molecule): boolean {
  return true;
}

export function isBondInRing(_mol: Molecule, _a: number, _b: number): boolean {
  return false;
}

export function findRings(_mol: Molecule): number[][] {
  return [];
}

export function molecularFormula(): string {
  return '';
}

export function molecularMass(): number {
  return 0;
}

export function netCharge(): number {
  return 0;
}
