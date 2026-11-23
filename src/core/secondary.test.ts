import { describe, expect, it } from 'vitest';
import type { AtomInput } from './molecule';
import { buildMolecule } from './molecule';
import { assignSecondaryStructure, hbondEnergy } from './secondary';
import type { Molecule } from './types';
import { add, backboneAtoms, buildBackbone, scale, strandFrame, transformAtoms } from './structure-testkit';

/** One character per residue (by CA): H helix, E sheet, - coil, ? unset. */
function ssString(mol: Molecule, chain?: string): string {
  return mol.atoms
    .filter((a) => a.name === 'CA' && (chain === undefined || a.chain === chain))
    .map((a) => (a.ss === 'helix' ? 'H' : a.ss === 'sheet' ? 'E' : a.ss === 'coil' ? '-' : '?'))
    .join('');
}

const helixBackbone = (n: number) => buildBackbone(Array(n).fill(-57), Array(n).fill(-47));

/** Two ideal 8-residue strands placed with realistic inter-strand H-bond geometry. */
function strandPair(parallel: boolean): AtomInput[] {
  const phi = parallel ? -119 : -139;
  const psi = parallel ? 113 : 135;
  const bb = buildBackbone(Array(8).fill(phi), Array(8).fill(psi));
  const f = strandFrame(bb);
  const a = backboneAtoms(bb, { chain: 'A' });
  // Partner strand ~4.9–5 Å away in the sheet plane; antiparallel = rotated 180° about the sheet
  // normal. Offsets were found by maximising the inter-strand DSSP H-bond count.
  const shift = parallel
    ? add(add(scale(f.side, 5.0), scale(f.axis, -0.1)), scale(f.normal, -0.5))
    : add(scale(f.side, 4.9), scale(f.axis, -3.4));
  const b = transformAtoms(backboneAtoms(bb, { chain: 'B' }), f.normal, parallel ? 0 : 180, f.center, shift);
  return [...a, ...b];
}

describe('hbondEnergy', () => {
  it('gives ≈ −2.9 kcal/mol for a linear N–H···O=C with N···O = 2.9 Å', () => {
    const e = hbondEnergy([0, 0, 0], [1, 0, 0], [4.13, 0, 0], [2.9, 0, 0]);
    expect(e).toBeCloseTo(-2.9, 1);
  });

  it('is repulsive / weak when the H points away and clamps at −9.9', () => {
    expect(hbondEnergy([0, 0, 0], [-1, 0, 0], [4.13, 0, 0], [2.9, 0, 0])).toBeGreaterThan(-0.5);
    expect(hbondEnergy([0, 0, 0], [1, 0, 0], [1.6, 0, 0], [1.2, 0, 0])).toBe(-9.9);
  });
});

describe('assignSecondaryStructure', () => {
  it('assigns an ideal α-helix (φ −57°, ψ −47°): all but the terminal residues', () => {
    const mol = assignSecondaryStructure(buildMolecule('helix', backboneAtoms(helixBackbone(20))));
    expect(ssString(mol)).toBe('-' + 'H'.repeat(18) + '-');
    // Every atom of each residue carries the residue's ss.
    for (const a of mol.atoms) expect(a.ss).toBeDefined();
  });

  it('assigns an antiparallel β-sheet from two ideal strands', () => {
    const mol = assignSecondaryStructure(buildMolecule('anti', strandPair(false)));
    for (const ch of ['A', 'B']) {
      const s = ssString(mol, ch);
      expect(s).not.toContain('H');
      expect(s.slice(1, 6)).toBe('EEEEE');
    }
  });

  it('assigns a parallel β-sheet from two ideal strands', () => {
    const mol = assignSecondaryStructure(buildMolecule('par', strandPair(true)));
    for (const ch of ['A', 'B']) {
      const s = ssString(mol, ch);
      expect(s).not.toContain('H');
      expect(s.slice(1, 7)).toBe('EEEEEE');
    }
  });

  it('does not call a lone extended strand a sheet', () => {
    const bb = buildBackbone(Array(10).fill(-139), Array(10).fill(135));
    const mol = assignSecondaryStructure(buildMolecule('strand', backboneAtoms(bb)));
    expect(ssString(mol)).toBe('-'.repeat(10));
  });

  it('respects chain breaks (no H-bond pattern across a gap)', () => {
    const atoms = backboneAtoms(helixBackbone(24));
    // Cut after residue 12: move the C-terminal half 30 Å away.
    const moved = atoms.map((a) => (a.resSeq! > 12 ? { ...a, x: a.x + 30 } : a));
    const mol = assignSecondaryStructure(buildMolecule('broken', moved));
    const s = ssString(mol);
    expect(s.slice(0, 12)).toBe('-' + 'H'.repeat(10) + '-');
    expect(s.slice(12)).toBe('-' + 'H'.repeat(10) + '-');
  });

  it('treats different chains independently', () => {
    const a = backboneAtoms(helixBackbone(12), { chain: 'A' });
    const b = backboneAtoms(helixBackbone(12), { chain: 'B' }).map((x) => ({ ...x, x: x.x + 25 }));
    const mol = assignSecondaryStructure(buildMolecule('two', [...a, ...b]));
    expect(ssString(mol, 'A')).toBe('-' + 'H'.repeat(10) + '-');
    expect(ssString(mol, 'B')).toBe('-' + 'H'.repeat(10) + '-');
  });

  it('tolerates missing backbone atoms', () => {
    const atoms = backboneAtoms(helixBackbone(20)).filter((a) => !(a.resSeq === 10 && a.name === 'O'));
    const mol = assignSecondaryStructure(buildMolecule('missingO', atoms));
    const s = ssString(mol);
    expect(s).toHaveLength(20);
    // Residue 10's C=O is the acceptor of the 10→14 turn; the surrounding turns keep the helix.
    expect(s.slice(1, 19)).toBe('H'.repeat(18));
  });

  it('proline cannot donate but an ideal helix containing one stays helical', () => {
    const atoms = backboneAtoms(helixBackbone(20), { resName: (i) => (i === 10 ? 'PRO' : 'ALA') });
    const mol = assignSecondaryStructure(buildMolecule('pro', atoms));
    expect(ssString(mol).slice(1, 19)).toBe('H'.repeat(18));
  });

  it('falls back to CA-trace geometry for CA-only models', () => {
    const helix = assignSecondaryStructure(buildMolecule('ca', backboneAtoms(helixBackbone(20), { caOnly: true })));
    expect(ssString(helix)).toBe('-' + 'H'.repeat(18) + '-');

    const pair = strandPair(false).filter((a) => a.name === 'CA');
    const sheet = assignSecondaryStructure(buildMolecule('ca-sheet', pair));
    for (const ch of ['A', 'B']) {
      const s = ssString(sheet, ch);
      expect(s).not.toContain('H');
      expect(s.slice(2, 6)).toBe('EEEE');
    }
    const lone = buildBackbone(Array(10).fill(-139), Array(10).fill(135));
    const loneMol = assignSecondaryStructure(buildMolecule('ca-lone', backboneAtoms(lone, { caOnly: true })));
    expect(ssString(loneMol)).toBe('-'.repeat(10));
  });

  it('leaves non-protein atoms untouched', () => {
    const atoms = [
      ...backboneAtoms(helixBackbone(8)),
      { element: 'O', name: 'O', resName: 'HOH', resSeq: 100, chain: 'A', hetero: true, x: 30, y: 0, z: 0 },
      { element: 'C', name: 'C1', resName: 'LIG', resSeq: 200, chain: 'A', hetero: true, x: 35, y: 0, z: 0 },
    ];
    const mol = assignSecondaryStructure(buildMolecule('mixed', atoms));
    expect(mol.atoms.at(-1)!.ss).toBeUndefined();
    expect(mol.atoms.at(-2)!.ss).toBeUndefined();
  });

  it('honours meta.hasSecondaryStructure unless forced, and never mutates the input', () => {
    const base = buildMolecule('h', backboneAtoms(helixBackbone(12)), [], { hasSecondaryStructure: true });
    expect(assignSecondaryStructure(base)).toBe(base);
    const snapshot = JSON.stringify(base);
    const forced = assignSecondaryStructure(base, true);
    expect(forced).not.toBe(base);
    expect(ssString(forced)).toBe('-' + 'H'.repeat(10) + '-');
    expect(JSON.stringify(base)).toBe(snapshot);
    // Re-running on an already-assigned molecule changes nothing → same object.
    expect(assignSecondaryStructure(forced, true)).toBe(forced);
  });

  it('returns the input for molecules without protein', () => {
    const mol = buildMolecule('lig', [{ element: 'C', x: 0, y: 0, z: 0 }]);
    expect(assignSecondaryStructure(mol)).toBe(mol);
  });

  it('is fast on a large protein (≈ 6000 residues)', () => {
    const one = backboneAtoms(helixBackbone(30));
    const atoms: AtomInput[] = [];
    let chainNo = 0;
    for (let gx = 0; gx < 10; gx++) {
      for (let gy = 0; gy < 20; gy++) {
        const chain = String.fromCharCode(65 + (chainNo % 26)) + Math.floor(chainNo / 26);
        chainNo++;
        for (const a of one) atoms.push({ ...a, chain, x: a.x + gx * 12, y: a.y + gy * 12 });
      }
    }
    const mol = buildMolecule('bundle', atoms);
    const t0 = performance.now();
    const out = assignSecondaryStructure(mol);
    const ms = performance.now() - t0;
    expect(ssString(out).split('H').length - 1).toBe(200 * 28);
    expect(ms).toBeLessThan(2000);
  });
});
