/**
 * Post-load pipeline: bonds → bond orders → secondary structure.
 * OWNER: integration (core). Uses functions from bonding.ts / secondary.ts.
 */
import type { Molecule } from './types';
import { perceiveBondOrders, perceiveBonds } from './bonding';
import { assignSecondaryStructure } from './secondary';
import { hasProtein } from './molecule';

/**
 * True when an empty bond table of a format with explicit connectivity (SDF/MOL2) is meaningful
 * as it is: ionic records — salts and lattices whose atoms carry formal charges (e.g. the rock-salt
 * sample, PubChem 2D salt records, where distances in 2D drawing units would invent bonds).
 */
function emptyBondTableIsIntended(mol: Molecule): boolean {
  return mol.atoms.some((a) => a.charge);
}

export function prepareMolecule(input: Molecule): Molecule {
  let mol = input;
  if (mol.atoms.length === 0) return mol;

  // 1. Bonds: files without connectivity (XYZ, PDB without CONECT for protein atoms, mmCIF)
  //    get distance-based bonds. perceiveBonds keeps existing bonds. Formats with a bond table are
  //    trusted; an empty table is only filled from distances when it looks like "not written".
  const explicit = mol.meta.hasBondOrders === true;
  const needsBonds = !explicit || (mol.bonds.length === 0 && !emptyBondTableIsIntended(mol));
  if (needsBonds) mol = perceiveBonds(mol);

  // 2. Bond orders for formats without them (and for bonds just perceived from distances):
  //    geometry-based perception for small molecules / ligands, residue templates for standard
  //    protein and nucleic residues.
  if (!explicit || needsBonds) mol = perceiveBondOrders(mol);

  // 3. Secondary structure for proteins.
  if (hasProtein(mol) && !mol.meta.hasSecondaryStructure) {
    mol = assignSecondaryStructure(mol);
  }
  return mol;
}
