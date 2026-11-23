/**
 * "Add layer" presets for the Layers panel. Pure: derives sensible layer definitions from the
 * molecule's content (protein / nucleic / ligands) and the current selection.
 */
import type { Molecule, Representation, RepStyle } from '../../core/types';
import { getTopology } from '../../core/molecule';
import { idsToQuery } from './query';
import { plural } from './format';

export interface LayerPreset {
  id: string;
  label: string;
  description: string;
  /** Style used for the menu icon. */
  style: RepStyle;
  rep: Partial<Representation>;
  /** When set, the preset is shown disabled with this explanation. */
  disabledReason?: string;
}

export interface MoleculeContent {
  protein: boolean;
  nucleic: boolean;
  ligand: boolean;
  /** Number of chains that contain polymer residues. */
  polymerChains: number;
}

export function moleculeContent(mol: Molecule | null): MoleculeContent {
  if (!mol) return { protein: false, nucleic: false, ligand: false, polymerChains: 0 };
  const topo = getTopology(mol);
  let protein = false;
  let nucleic = false;
  let ligand = false;
  for (const r of topo.residues) {
    if (r.kind === 'protein') protein = true;
    else if (r.kind === 'nucleic') nucleic = true;
    else if (r.kind === 'ligand') ligand = true;
  }
  let polymerChains = 0;
  for (const c of topo.chains) {
    if (c.residueIndices.some((ri) => topo.residues[ri].kind === 'protein' || topo.residues[ri].kind === 'nucleic')) polymerChains++;
  }
  return { protein, nucleic, ligand, polymerChains };
}

export function layerPresets(mol: Molecule | null, selection: ReadonlySet<number>): LayerPreset[] {
  const c = moleculeContent(mol);
  const polymer = c.protein || c.nucleic;
  const polymerQuery = c.protein && c.nucleic ? 'protein or nucleic' : c.nucleic ? 'nucleic' : 'protein';
  const presets: LayerPreset[] = [
    {
      id: 'cartoon',
      label: 'Cartoon',
      description: 'Ribbon trace of the protein / nucleic-acid backbone',
      style: 'cartoon',
      rep: {
        name: 'Cartoon',
        selection: polymerQuery,
        style: 'cartoon',
        color: c.polymerChains > 1 ? 'chain' : c.protein ? 'secondary' : 'residue',
      },
      disabledReason: polymer ? undefined : 'Needs protein or nucleic-acid residues',
    },
    {
      id: 'ball-and-stick',
      label: 'Ball & stick',
      description: 'Atoms as balls, bonds as sticks (shows bond orders)',
      style: 'ball-and-stick',
      rep: { name: 'Ball & stick', selection: 'all', style: 'ball-and-stick', color: 'element' },
    },
    {
      id: 'ligand-sticks',
      label: 'Sticks of ligands',
      description: 'Bound small molecules as sticks',
      style: 'licorice',
      rep: { name: 'Ligands', selection: 'ligand', style: 'licorice', color: 'element' },
      disabledReason: c.ligand ? undefined : 'No ligands in this structure',
    },
    {
      id: 'binding-site',
      label: 'Binding site',
      description: 'Residues within 5 Å of a ligand, as sticks',
      style: 'licorice',
      rep: {
        name: 'Binding site',
        selection: 'protein and (same residue as (within 5 of ligand))',
        style: 'licorice',
        color: 'element',
        scale: 0.8,
      },
      disabledReason: c.ligand && c.protein ? undefined : 'Needs a protein with a bound ligand',
    },
    {
      id: 'surface',
      label: 'Surface',
      description: c.protein ? 'Molecular surface colored by hydrophobicity' : 'Molecular surface',
      style: 'surface',
      rep: c.protein
        ? { name: 'Surface', selection: 'protein', style: 'surface', color: 'hydrophobicity', opacity: 0.85 }
        : { name: 'Surface', selection: 'all', style: 'surface', color: 'element', opacity: 0.7 },
      disabledReason: mol && mol.atoms.length > 0 ? undefined : 'The molecule is empty',
    },
    {
      id: 'spacefill',
      label: 'Spacefill',
      description: 'Atoms at their van der Waals radii',
      style: 'spacefill',
      rep: { name: 'Spacefill', selection: 'all', style: 'spacefill', color: 'element' },
    },
    {
      id: 'lines',
      label: 'Lines',
      description: 'Thin bond lines — fast for very large systems',
      style: 'lines',
      rep: { name: 'Lines', selection: 'all', style: 'lines', color: 'element' },
    },
    {
      id: 'selection',
      label: 'Selected atoms as ball & stick',
      description: selection.size ? `Highlight the ${plural(selection.size, 'selected atom')}` : 'Select atoms first',
      style: 'ball-and-stick',
      rep: {
        name: selection.size ? `Selection (${plural(selection.size, 'atom')})` : 'Selection',
        selection: idsToQuery(selection),
        style: 'ball-and-stick',
        color: 'element',
        scale: 1.1,
      },
      disabledReason: selection.size ? undefined : 'Select some atoms first',
    },
  ];
  return presets;
}

/** True if any atom of the mask belongs to a protein or nucleic-acid residue (cartoon can draw it). */
export function maskHasPolymer(mol: Molecule, mask: Uint8Array): boolean {
  const topo = getTopology(mol);
  const n = Math.min(mask.length, mol.atoms.length);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const ri = topo.atomResidue[i];
    if (ri < 0) continue;
    const kind = topo.residues[ri].kind;
    if (kind === 'protein' || kind === 'nucleic') return true;
  }
  return false;
}

/**
 * Number of a layer's atoms that are actually drawn: with `hideHydrogens` (View mode with
 * "Show hydrogens" off — the renderer's rule) hydrogens are not counted.
 */
export function drawnAtomCount(mol: Molecule, mask: Uint8Array, hideHydrogens: boolean): number {
  const n = Math.min(mask.length, mol.atoms.length);
  let count = 0;
  for (let i = 0; i < n; i++) if (mask[i] && !(hideHydrogens && mol.atoms[i].element === 'H')) count++;
  return count;
}
