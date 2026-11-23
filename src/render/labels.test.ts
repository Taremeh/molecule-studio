import { describe, expect, it } from 'vitest';
import { MAX_ATOM_LABELS, atomLabelText, collectAtomLabels, formatMeasurement, residueLabelText } from './labels';
import { benzene, dipeptide, ethylene } from './testMolecules';
import { buildMolecule } from '../core/molecule';

describe('formatMeasurement', () => {
  it('formats distances, angles and dihedrals', () => {
    expect(formatMeasurement('distance', 1.5432)).toBe('1.54 Å');
    expect(formatMeasurement('angle', 109.4712)).toBe('109.5°');
    expect(formatMeasurement('dihedral', -60)).toBe('−60.0°');
    expect(formatMeasurement('dihedral', 180)).toBe('180.0°');
    expect(formatMeasurement('distance', NaN)).toBe('—');
  });
});

describe('atom label text', () => {
  it('uses element, name, serial and residue', () => {
    const mol = dipeptide();
    const ca = mol.atoms[1];
    expect(atomLabelText(ca, 1, 'element')).toBe('C');
    expect(atomLabelText(ca, 1, 'name')).toBe('CA');
    expect(atomLabelText(ca, 1, 'serial')).toBe(String(ca.id));
    expect(residueLabelText(ca)).toBe('ALA 1:A');
    const eth = ethylene();
    expect(atomLabelText(eth.atoms[2], 2, 'name')).toBe('H3');
  });
});

describe('collectAtomLabels', () => {
  it('labels every atom of a small molecule when nothing is selected', () => {
    const mol = benzene();
    expect(collectAtomLabels(mol, new Set(), 'element', false).length).toBe(12);
    expect(collectAtomLabels(mol, new Set(), 'element', true).length).toBe(6); // hydrogens hidden
    expect(collectAtomLabels(mol, new Set(), 'none', false).length).toBe(0);
  });

  it('labels only selected atoms when there is a selection', () => {
    const mol = benzene();
    const labels = collectAtomLabels(mol, new Set([mol.atoms[2].id, mol.atoms[0].id]), 'element', false);
    expect(labels.map((l) => l.atomIndex)).toEqual([0, 2]);
  });

  it('does not label large molecules without a selection, and caps labels', () => {
    const atoms = Array.from({ length: 800 }, (_, i) => ({ element: 'C', x: i, y: 0, z: 0 }));
    const mol = buildMolecule('big', atoms);
    expect(collectAtomLabels(mol, new Set(), 'element', false).length).toBe(0);
    const all = new Set(mol.atoms.map((a) => a.id));
    expect(collectAtomLabels(mol, all, 'element', false).length).toBe(MAX_ATOM_LABELS);
  });

  it('residue mode: one label per residue, anchored at CA', () => {
    const mol = dipeptide();
    const labels = collectAtomLabels(mol, new Set(), 'residue', false);
    expect(labels.length).toBe(2);
    expect(labels[0]).toEqual({ atomIndex: 1, text: 'ALA 1:A' });
    expect(labels[1]).toEqual({ atomIndex: 6, text: 'GLY 2:A' });
  });
});
