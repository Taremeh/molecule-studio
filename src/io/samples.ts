/**
 * Sample gallery.
 * OWNER: io agent. CONTRACT: keep exported names & signatures.
 *
 * Embedded samples work offline: small molecules as SDF text with ideal 3D geometry and explicit
 * hydrogens (generated from internal coordinates, see sampleData.ts; checked in samples.test.ts).
 * Remote samples load via RCSB / PubChem (see fetch.ts). A 'smiles' sample is built with
 * core/smiles.ts moleculeFromSmiles.
 */
import { ACETIC_ACID_SDF, AMMONIA_SDF, BENZENE_SDF, C60_SDF, ETHANOL_SDF, METHANE_SDF, NACL_SDF, WATER_SDF } from './sampleData';

export type SampleSource =
  | { kind: 'embedded'; format: 'sdf' | 'xyz' | 'pdb' | 'mol2'; text: string }
  | { kind: 'pdb'; id: string }
  | { kind: 'pubchem'; query: string }
  | { kind: 'smiles'; smiles: string };

export interface SampleEntry {
  id: string;
  name: string;
  description: string;
  category: 'small' | 'protein' | 'nucleic' | 'material';
  source: SampleSource;
  /** Approximate atom count for display ('~1.2k atoms'). */
  approxAtoms?: number;
  /** Tags for search, e.g. ['drug', 'stimulant']. */
  tags?: string[];
}

/** Display labels for the gallery categories, in display order. */
export const SAMPLE_CATEGORIES: { id: SampleEntry['category']; label: string }[] = [
  { id: 'small', label: 'Small molecules' },
  { id: 'protein', label: 'Proteins' },
  { id: 'nucleic', label: 'Nucleic acids' },
  { id: 'material', label: 'Materials' },
];

const embedded = (text: string): SampleSource => ({ kind: 'embedded', format: 'sdf', text });

export const SAMPLES: SampleEntry[] = [
  // ---- small molecules: embedded (offline) ----
  {
    id: 'water',
    name: 'Water',
    description: 'H₂O — a bent molecule with a 104.5° H–O–H angle',
    category: 'small',
    approxAtoms: 3,
    tags: ['offline', 'solvent', 'basic'],
    source: embedded(WATER_SDF),
  },
  {
    id: 'methane',
    name: 'Methane',
    description: 'CH₄ — the textbook tetrahedral carbon (109.5°)',
    category: 'small',
    approxAtoms: 5,
    tags: ['offline', 'alkane', 'basic', 'tetrahedral'],
    source: embedded(METHANE_SDF),
  },
  {
    id: 'ammonia',
    name: 'Ammonia',
    description: 'NH₃ — trigonal pyramid shaped by a lone pair',
    category: 'small',
    approxAtoms: 4,
    tags: ['offline', 'basic', 'lone pair'],
    source: embedded(AMMONIA_SDF),
  },
  {
    id: 'ethanol',
    name: 'Ethanol',
    description: 'C₂H₅OH — the simplest alcohol most people know',
    category: 'small',
    approxAtoms: 9,
    tags: ['offline', 'alcohol', 'solvent'],
    source: embedded(ETHANOL_SDF),
  },
  {
    id: 'benzene',
    name: 'Benzene',
    description: 'C₆H₆ — planar aromatic ring, the archetype of aromaticity',
    category: 'small',
    approxAtoms: 12,
    tags: ['offline', 'aromatic', 'ring'],
    source: embedded(BENZENE_SDF),
  },
  {
    id: 'acetic-acid',
    name: 'Acetic acid',
    description: 'CH₃COOH — the acid in vinegar; a planar carboxyl group',
    category: 'small',
    approxAtoms: 8,
    tags: ['offline', 'carboxylic acid', 'vinegar'],
    source: embedded(ACETIC_ACID_SDF),
  },

  // ---- small molecules: PubChem 3D conformers ----
  {
    id: 'caffeine',
    name: 'Caffeine',
    description: 'The stimulant in coffee and tea — a methylated purine',
    category: 'small',
    approxAtoms: 24,
    tags: ['drug', 'stimulant', 'alkaloid', 'purine'],
    source: { kind: 'pubchem', query: 'caffeine' },
  },
  {
    id: 'aspirin',
    name: 'Aspirin',
    description: 'Acetylsalicylic acid — pain reliever that acetylates COX enzymes',
    category: 'small',
    approxAtoms: 21,
    tags: ['drug', 'analgesic', 'NSAID'],
    source: { kind: 'pubchem', query: 'aspirin' },
  },
  {
    id: 'paracetamol',
    name: 'Paracetamol',
    description: 'Acetaminophen — one of the most widely used medicines',
    category: 'small',
    approxAtoms: 20,
    tags: ['drug', 'analgesic', 'acetaminophen'],
    source: { kind: 'pubchem', query: 'paracetamol' },
  },
  {
    id: 'ibuprofen',
    name: 'Ibuprofen',
    description: 'Anti-inflammatory drug with a chiral propionic acid group',
    category: 'small',
    approxAtoms: 33,
    tags: ['drug', 'NSAID', 'chiral'],
    source: { kind: 'pubchem', query: 'ibuprofen' },
  },
  {
    id: 'glucose',
    name: 'Glucose',
    description: 'D-glucose — the sugar ring that fuels cells',
    category: 'small',
    approxAtoms: 24,
    tags: ['sugar', 'carbohydrate', 'metabolism'],
    source: { kind: 'pubchem', query: 'glucose' },
  },
  {
    id: 'dopamine',
    name: 'Dopamine',
    description: 'Catecholamine neurotransmitter of reward and movement',
    category: 'small',
    approxAtoms: 22,
    tags: ['neurotransmitter', 'catecholamine'],
    source: { kind: 'pubchem', query: 'dopamine' },
  },
  {
    id: 'serotonin',
    name: 'Serotonin',
    description: '5-hydroxytryptamine — an indole neurotransmitter regulating mood',
    category: 'small',
    approxAtoms: 25,
    tags: ['neurotransmitter', 'indole'],
    source: { kind: 'pubchem', query: 'serotonin' },
  },
  {
    id: 'penicillin-g',
    name: 'Penicillin G',
    description: 'Benzylpenicillin — the β-lactam antibiotic discovered by Fleming',
    category: 'small',
    approxAtoms: 41,
    tags: ['drug', 'antibiotic', 'beta-lactam'],
    source: { kind: 'pubchem', query: 'penicillin G' },
  },
  {
    id: 'cholesterol',
    name: 'Cholesterol',
    description: 'Steroid with four fused rings that stiffens cell membranes',
    category: 'small',
    approxAtoms: 74,
    tags: ['steroid', 'lipid', 'membrane'],
    source: { kind: 'pubchem', query: 'cholesterol' },
  },
  {
    id: 'atp',
    name: 'ATP',
    description: 'Adenosine triphosphate — the energy currency of the cell',
    category: 'small',
    approxAtoms: 47,
    tags: ['nucleotide', 'energy', 'phosphate', 'metabolism'],
    source: { kind: 'pubchem', query: 'ATP' },
  },

  // ---- proteins (RCSB PDB) ----
  {
    id: '1crn',
    name: 'Crambin',
    description: '1CRN · tiny 46-residue seed protein at ultra-high resolution',
    category: 'protein',
    approxAtoms: 327,
    tags: ['1CRN', 'small protein', 'disulfide', 'plant'],
    source: { kind: 'pdb', id: '1CRN' },
  },
  {
    id: '1ubq',
    name: 'Ubiquitin',
    description: '1UBQ · the 76-residue tag that marks proteins for degradation',
    category: 'protein',
    approxAtoms: 660,
    tags: ['1UBQ', 'signalling', 'beta-grasp'],
    source: { kind: 'pdb', id: '1UBQ' },
  },
  {
    id: '1hsg',
    name: 'HIV-1 protease + indinavir',
    description: '1HSG · dimeric aspartyl protease with the drug indinavir in its active site',
    category: 'protein',
    approxAtoms: 1686,
    tags: ['1HSG', 'drug', 'enzyme', 'inhibitor', 'ligand', 'HIV'],
    source: { kind: 'pdb', id: '1HSG' },
  },
  {
    id: '1ema',
    name: 'Green fluorescent protein',
    description: '1EMA · an 11-stranded β-barrel around a glowing chromophore',
    category: 'protein',
    approxAtoms: 1866,
    tags: ['1EMA', 'GFP', 'beta-barrel', 'fluorescence'],
    source: { kind: 'pdb', id: '1EMA' },
  },
  {
    id: '6lu7',
    name: 'SARS-CoV-2 main protease',
    description: '6LU7 · COVID-19 Mpro bound to the covalent inhibitor N3',
    category: 'protein',
    approxAtoms: 2500,
    tags: ['6LU7', 'COVID-19', 'coronavirus', 'enzyme', 'inhibitor', 'ligand'],
    source: { kind: 'pdb', id: '6LU7' },
  },
  {
    id: '4hhb',
    name: 'Hemoglobin',
    description: '4HHB · the α₂β₂ oxygen carrier of blood, with four heme groups',
    category: 'protein',
    approxAtoms: 4779,
    tags: ['4HHB', 'heme', 'oxygen transport', 'tetramer', 'iron'],
    source: { kind: 'pdb', id: '4HHB' },
  },

  // ---- nucleic acids ----
  {
    id: '1bna',
    name: 'B-DNA dodecamer',
    description: '1BNA · the Dickerson–Drew double helix CGCGAATTCGCG',
    category: 'nucleic',
    approxAtoms: 566,
    tags: ['1BNA', 'DNA', 'double helix'],
    source: { kind: 'pdb', id: '1BNA' },
  },
  {
    id: '1ehz',
    name: 'Transfer RNA',
    description: '1EHZ · yeast tRNA-Phe folded into its L-shape',
    category: 'nucleic',
    approxAtoms: 1821,
    tags: ['1EHZ', 'RNA', 'tRNA', 'translation'],
    source: { kind: 'pdb', id: '1EHZ' },
  },

  // ---- materials (embedded) ----
  {
    id: 'c60',
    name: 'Buckminsterfullerene',
    description: 'C₆₀ — a carbon soccer ball of 12 pentagons and 20 hexagons',
    category: 'material',
    approxAtoms: 60,
    tags: ['offline', 'fullerene', 'carbon', 'nanomaterial'],
    source: embedded(C60_SDF),
  },
  {
    id: 'nacl',
    name: 'Rock salt',
    description: 'NaCl — a 4×4×4 fragment of the cubic ionic lattice',
    category: 'material',
    approxAtoms: 64,
    tags: ['offline', 'crystal', 'ionic', 'lattice', 'sodium chloride'],
    source: embedded(NACL_SDF),
  },
];

/** Case-insensitive search over name, description, tags and PDB ids. */
export function searchSamples(query: string, samples: SampleEntry[] = SAMPLES): SampleEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return samples;
  return samples.filter((s) => {
    const hay = [s.name, s.description, s.category, ...(s.tags ?? []), s.source.kind === 'pdb' ? s.source.id : ''].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** Short atom-count label for gallery cards: '24 atoms', '~1.7k atoms'. */
export function formatAtomCount(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1000) return `${n} atom${n === 1 ? '' : 's'}`;
  return `~${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k atoms`;
}
