/**
 * Molecule summary and details of the current selection / single selected atom.
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { CircleAlert, ExternalLink, Focus, Layers, X } from 'lucide-react';
import type { Atom, HoverInfo, Molecule } from '../core/types';
import { useStore } from '../state/store';
import { atomById, atomLabel, boundingBox, centroid, getTopology } from '../core/molecule';
import { findRings, molecularFormula, molecularMass, moleculeSummary, netCharge, shouldShowUnderValence, valenceOf } from '../core/chemistry';
import { getElement } from '../core/elements';
import { focusSelection } from '../app/actions';
import { EmptyHint, IconButton, Section } from './common';
import { ElementBadge, Formula } from './shell/Chem';
import { useStructureMolecule } from './shell/hooks';
import { useShell } from './shell/shellStore';
import { externalLink } from './shell/links';
import { idsToQuery } from './shell/query';
import { bondOrderLabel, formatCharge, formatCoord, formatCount, formatKDa, formatMass, plural, truncate } from './shell/format';
import { FORMAT_LABELS, type FileFormat } from '../io/formats';
import './InfoPanel.css';

const SOURCE_LABELS: Record<string, string> = {
  file: 'Local file',
  paste: 'Pasted text',
  pdb: 'RCSB PDB',
  pubchem: 'PubChem',
  alphafold: 'AlphaFold DB',
  sample: 'Sample gallery',
  smiles: 'SMILES',
  editor: 'Built in editor',
};

export default function InfoPanel() {
  const hasMolecule = useStore((s) => s.molecule !== null);
  return (
    <>
      <Section title="Molecule" className="info">
        {hasMolecule ? <MoleculeInfo /> : <EmptyHint>No molecule loaded. Open one from the top bar or drop a file anywhere.</EmptyHint>}
      </Section>
      {hasMolecule && <SelectionInfo />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Molecule summary
// ---------------------------------------------------------------------------

function MoleculeInfo() {
  const mol = useStructureMolecule();
  const name = useStore((s) => s.molecule?.name ?? '');
  const mode = useStore((s) => s.mode);
  const summary = useMemo(() => (mol ? moleculeSummary(mol) : null), [mol]);
  // Ring perception is only meaningful (and cheap) for small molecules.
  const rings = useMemo(() => (mol && summary && summary.residues === 0 && mol.atoms.length <= 2000 ? findRings(mol).length : null), [mol, summary]);
  if (!mol || !summary) return null;
  const meta = mol.meta;
  const link = externalLink(meta);
  const kda = formatKDa(summary.mass);
  const format = meta.format && meta.format in FORMAT_LABELS ? FORMAT_LABELS[meta.format as FileFormat] : meta.format?.toUpperCase();
  const title = meta.title && meta.title.trim() && meta.title.trim().toLowerCase() !== name.trim().toLowerCase() ? meta.title.trim() : null;

  if (mol.atoms.length === 0) {
    return <EmptyHint>Empty molecule. {mode === 'edit' ? 'Click in the viewport to place the first atom.' : 'Switch to Edit mode to start building.'}</EmptyHint>;
  }

  return (
    <div className="info-mol">
      {title && (
        <p className="info-title" title={title}>
          {title}
        </p>
      )}
      <div className="info-formula-row">
        <span className="info-formula" title="Molecular formula (Hill order)">
          <Formula formula={summary.formula} />
        </span>
        <span className="info-mass" title="Molecular mass (standard atomic weights)">
          {formatMass(summary.mass)}
          {kda && <span className="info-kda"> · {kda}</span>}
        </span>
      </div>
      <div className="info-stats">
        <Stat label="Atoms" value={formatCount(summary.atoms)} title={`${formatCount(summary.heavyAtoms)} heavy atoms, ${formatCount(summary.hydrogens)} hydrogens`} />
        {summary.residues > 0 ? (
          <>
            <Stat label="Residues" value={formatCount(summary.residues)} />
            <Stat label="Chains" value={formatCount(summary.chains)} />
          </>
        ) : (
          <>
            <Stat label="Heavy atoms" value={formatCount(summary.heavyAtoms)} title="Non-hydrogen atoms" />
            <Stat label="Rings" value={rings === null ? '—' : formatCount(rings)} title="Smallest set of smallest rings" />
          </>
        )}
        <Stat label="Bonds" value={formatCount(summary.bonds)} />
        <Stat label="Hydrogens" value={formatCount(summary.hydrogens)} title={summary.hydrogens === 0 ? 'No explicit hydrogens in this structure' : 'Explicit hydrogens'} />
        <Stat label="Charge" value={formatCharge(summary.charge)} title="Net formal charge" />
      </div>
      {summary.valenceErrors > 0 && (
        <button type="button" className="info-warning" onClick={() => selectOverValent(mol)} title="Select the atoms with too many bonds">
          <CircleAlert size={14} />
          <span>
            {plural(summary.valenceErrors, 'atom')} {summary.valenceErrors === 1 ? 'exceeds its' : 'exceed their'} valence — click to select
          </span>
        </button>
      )}
      <dl className="kv info-meta">
        {meta.source && (
          <>
            <dt>Source</dt>
            <dd title={meta.source}>{SOURCE_LABELS[meta.source] ?? meta.source}</dd>
          </>
        )}
        {format && (
          <>
            <dt>Format</dt>
            <dd>{format}</dd>
          </>
        )}
        {meta.externalId && (
          <>
            <dt>{link?.idLabel ?? 'Identifier'}</dt>
            <dd>
              {link ? (
                <a className="info-link" href={link.href} target="_blank" rel="noopener noreferrer" title={`Open ${link.href}`}>
                  {meta.externalId}
                  <ExternalLink size={11} />
                </a>
              ) : (
                meta.externalId
              )}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function selectOverValent(mol: Molecule) {
  const ids: number[] = [];
  for (const a of mol.atoms) if (valenceOf(mol, a.id)?.status === 'over') ids.push(a.id);
  if (ids.length) useStore.getState().setSelection(ids);
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="info-stat" title={title}>
      <span className="info-stat-value">{value}</span>
      <span className="info-stat-label">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selection details
// ---------------------------------------------------------------------------

function SelectionInfo() {
  const selection = useStore((s) => s.selection);
  const count = selection.size;
  const title = count === 0 ? 'Selection' : count === 1 ? 'Selected atom' : `Selection · ${formatCount(count)} atoms`;
  return (
    <Section
      title={title}
      className="info-sel-section"
      actions={
        count > 0 ? (
          <>
            <IconButton icon={<Focus />} title="Zoom to the selection" shortcut="F" onClick={focusSelection} className="info-head-btn" />
            <IconButton icon={<X />} title="Clear selection" shortcut="Esc" onClick={() => useStore.getState().clearSelection()} className="info-head-btn" />
          </>
        ) : undefined
      }
    >
      {count === 0 ? (
        <EmptyHint>Click an atom to inspect it. Shift-click or Shift-drag to select several.</EmptyHint>
      ) : count === 1 ? (
        <SingleAtom id={selection.values().next().value as number} />
      ) : (
        <MultiAtoms />
      )}
    </Section>
  );
}

function SingleAtom({ id }: { id: number }) {
  // Live molecule: coordinates update while dragging in edit mode.
  const mol = useStore((s) => s.molecule);
  const mode = useStore((s) => s.mode);
  const atom = mol ? atomById(mol, id) : undefined;
  if (!mol || !atom) return null;
  const el = getElement(atom.element);
  const topo = getTopology(mol);
  const idx = topo.idToIndex.get(id) ?? -1;
  const resIndex = idx >= 0 ? topo.atomResidue[idx] : -1;
  const residue = resIndex >= 0 ? topo.residues[resIndex] : null;

  return (
    <div className="info-atom">
      <div className="info-atom-head">
        <ElementBadge element={atom.element} charge={atom.charge} size={34} />
        <div className="info-atom-title">
          <div className="info-atom-name">
            {el.name}
            {atom.name && atom.name !== atom.element && <span className="info-atom-aname">{atom.name}</span>}
          </div>
          <div className="info-atom-sub">
            {residue ? `${residue.resName} ${residue.resSeq}${residue.iCode}${residue.chain ? ` · chain ${residue.chain}` : ''}` : `Atom #${idx + 1}`}
            {residue && <span className="info-kind"> · {residue.kind}</span>}
          </div>
        </div>
      </div>

      <dl className="kv info-kv">
        <dt>Element</dt>
        <dd>
          {atom.element} · Z = {el.number}
        </dd>

        {atom.serial !== undefined && (
          <>
            <dt>Serial</dt>
            <dd>{atom.serial}</dd>
          </>
        )}
        <dt>Atom id</dt>
        <dd title="Stable id used by the selection language (id …)">{atom.id}</dd>
        {atom.altLoc && (
          <>
            <dt>Alt. location</dt>
            <dd>{atom.altLoc}</dd>
          </>
        )}
        {atom.ss && residue?.kind === 'protein' && (
          <>
            <dt>Structure</dt>
            <dd>{atom.ss === 'helix' ? 'α-helix' : atom.ss === 'sheet' ? 'β-sheet' : 'Coil'}</dd>
          </>
        )}
        {atom.bfactor !== undefined && (
          <>
            <dt>B-factor</dt>
            <dd>{atom.bfactor.toFixed(2)}</dd>
          </>
        )}
        {atom.occupancy !== undefined && (
          <>
            <dt>Occupancy</dt>
            <dd>{atom.occupancy.toFixed(2)}</dd>
          </>
        )}
        <dt>Formal charge</dt>
        <dd>{formatCharge(atom.charge ?? 0)}</dd>
        {atom.hetero && (
          <>
            <dt>Record</dt>
            <dd>HETATM</dd>
          </>
        )}
      </dl>

      <div className="info-coords" title="Cartesian coordinates (Å)">
        <span className="info-coord">
          <i>x</i>
          {formatCoord(atom.x)}
        </span>
        <span className="info-coord">
          <i>y</i>
          {formatCoord(atom.y)}
        </span>
        <span className="info-coord">
          <i>z</i>
          {formatCoord(atom.z)}
        </span>
        <span className="info-coord-unit">Å</span>
      </div>

      <ValenceRow atomId={atom.id} mode={mode} />
      <Neighbours mol={mol} atom={atom} />
    </div>
  );
}

function ValenceRow({ atomId, mode }: { atomId: number; mode: 'view' | 'edit' }) {
  // Valence depends only on the structure: don't re-analyse the molecule on every drag frame.
  const mol = useStructureMolecule();
  const info = useMemo(() => (mol ? valenceOf(mol, atomId) : undefined), [mol, atomId]);
  if (!mol || !info) return null;
  const allowed = info.allowed.length ? info.allowed.join(' / ') : '—';
  const sum = Number.isInteger(info.bondOrderSum) ? String(info.bondOrderSum) : info.bondOrderSum.toFixed(1);
  let badge: ReactNode;
  let text: string;
  switch (info.status) {
    case 'ok':
      badge = <span className="shell-badge shell-badge-success">OK</span>;
      text = `Bond order sum ${sum} (allowed ${allowed})`;
      break;
    case 'over':
      badge = <span className="shell-badge shell-badge-danger">Too many bonds</span>;
      text = info.message ?? `Bond order sum ${sum} exceeds ${allowed}`;
      break;
    case 'under': {
      // Structures without explicit hydrogens (most PDB files) are "under-valent" everywhere — say why.
      const implicitH = !shouldShowUnderValence(mol);
      badge = implicitH ? <span className="shell-badge">Implicit H</span> : <span className="shell-badge shell-badge-warning">Open valence</span>;
      text = implicitH
        ? `${plural(info.openValence, 'bond')} short — hydrogens are not in the file`
        : info.message ?? `${plural(info.openValence, 'open valence')} (sum ${sum}, allowed ${allowed})`;
      break;
    }
    default:
      badge = <span className="shell-badge">Not checked</span>;
      text = 'Valence is not checked for metals and unknown elements';
  }
  return (
    <div className={`info-valence info-valence-${info.status}`} title={mode === 'edit' ? 'Valence status (also shown in the viewport in Edit mode)' : 'Valence status'}>
      <span className="info-valence-label">Valence</span>
      {badge}
      <span className="info-valence-text">{text}</span>
    </div>
  );
}

function Neighbours({ mol, atom }: { mol: Molecule; atom: Atom }) {
  // The 3D hover set from this list must not outlive it: when the list changes (another atom is
  // inspected) or goes away under a resting pointer, no mouseleave follows.
  const ownHover = useRef<HoverInfo | null>(null);
  useEffect(
    () => () => {
      const s = useStore.getState();
      if (ownHover.current && s.hovered === ownHover.current) s.setHovered(null);
      ownHover.current = null;
    },
    [atom.id],
  );
  const topo = getTopology(mol);
  const idx = topo.idToIndex.get(atom.id);
  if (idx === undefined) return null;
  const bonds = topo.atomBonds[idx].map((bi) => mol.bonds[bi]);
  return (
    <div className="info-neigh">
      <div className="info-subtitle">Bonded to {bonds.length === 0 ? 'nothing' : plural(bonds.length, 'atom')}</div>
      {bonds.length > 0 && (
        <ul className="info-neigh-list">
          {bonds.slice(0, 12).map((b) => {
            const otherId = b.a === atom.id ? b.b : b.a;
            const other = atomById(mol, otherId);
            if (!other) return null;
            const d = Math.hypot(other.x - atom.x, other.y - atom.y, other.z - atom.z);
            const order = bondOrderLabel(b.order);
            return (
              <li key={b.id}>
                <button
                  type="button"
                  className="info-neigh-item"
                  title={`Select ${atomLabel(mol, otherId)}`}
                  onClick={() => useStore.getState().setSelection([otherId])}
                  onMouseEnter={(e) => {
                    ownHover.current = { kind: 'atom', atomId: otherId, clientX: e.clientX, clientY: e.clientY };
                    useStore.getState().setHovered(ownHover.current);
                  }}
                  onMouseLeave={() => {
                    ownHover.current = null;
                    useStore.getState().setHovered(null);
                  }}
                >
                  <ElementBadge element={other.element} charge={other.charge} size={18} />
                  <span className="info-neigh-label">{truncate(atomLabel(mol, otherId), 26)}</span>
                  <span className="info-neigh-order" title={`${order.name} bond`}>
                    {order.symbol}
                  </span>
                  <span className="info-neigh-dist">{d.toFixed(3)} Å</span>
                </button>
              </li>
            );
          })}
          {bonds.length > 12 && <li className="info-more">+{bonds.length - 12} more</li>}
        </ul>
      )}
    </div>
  );
}

function MultiAtoms() {
  const selection = useStore((s) => s.selection);
  const structMol = useStructureMolecule();
  const liveMol = useStore((s) => s.molecule);

  // Composition depends only on the structure; geometry (centroid, extent) on live coordinates.
  const composition = useMemo(() => {
    if (!structMol) return null;
    const ids = [...selection];
    const topo = getTopology(structMol);
    const residues = new Set<number>();
    const chains = new Set<string>();
    let hydrogens = 0;
    for (const id of ids) {
      const i = topo.idToIndex.get(id);
      if (i === undefined) continue;
      const a = structMol.atoms[i];
      if (a.element === 'H') hydrogens++;
      const r = topo.atomResidue[i];
      if (r >= 0) {
        residues.add(r);
        chains.add(topo.residues[r].chain);
      }
    }
    const resList = [...residues].sort((a, b) => a - b).map((r) => topo.residues[r]);
    return {
      formula: molecularFormula(structMol, ids),
      mass: molecularMass(structMol, ids),
      charge: netCharge(structMol, ids),
      hydrogens,
      residues: resList,
      chains: [...chains].filter((c) => c !== '').sort(),
    };
  }, [structMol, selection]);

  const geometry = useMemo(() => {
    if (!liveMol) return null;
    const c = centroid(liveMol, selection);
    const box = boundingBox(liveMol, selection);
    return { c, size: box ? box.max.map((v, i) => v - box.min[i]) : [0, 0, 0] };
  }, [liveMol, selection]);

  if (!composition || !geometry) return null;
  const n = selection.size;
  const resPreview = composition.residues.slice(0, 8).map((r) => `${r.resName}${r.resSeq}${r.iCode}${composition.chains.length > 1 ? `:${r.chain}` : ''}`);

  const makeLayer = () => {
    const name = `Selection (${plural(n, 'atom')})`;
    const id = useStore.getState().addRep({ name, selection: idsToQuery(selection), style: 'ball-and-stick', color: 'element', scale: 1.1 });
    useShell.getState().setLayerOpen(id, true);
    useStore.getState().toast(`Added layer “${name}”`, 'success', 2000);
  };

  return (
    <div className="info-multi">
      <div className="info-formula-row">
        <span className="info-formula" title="Formula of the selected atoms">
          <Formula formula={composition.formula} />
        </span>
        <span className="info-mass">{formatMass(composition.mass)}</span>
      </div>
      <dl className="kv info-kv">
        <dt>Atoms</dt>
        <dd>
          {formatCount(n)}
          {composition.hydrogens > 0 && <span className="muted"> ({formatCount(composition.hydrogens)} H)</span>}
        </dd>
        <dt>Net charge</dt>
        <dd>{formatCharge(composition.charge)}</dd>
        <dt>Centroid</dt>
        <dd title="Mean position of the selected atoms (Å)">
          {geometry.c.map(formatCoord).join(', ')}
        </dd>
        <dt>Extent</dt>
        <dd title="Size of the bounding box (Å)">
          {geometry.size.map((v) => v.toFixed(1)).join(' × ')} Å
        </dd>
        {composition.residues.length > 0 && (
          <>
            <dt>Residues</dt>
            <dd title={composition.residues.map((r) => `${r.resName}${r.resSeq}${r.iCode}`).join(', ')}>{formatCount(composition.residues.length)}</dd>
          </>
        )}
        {composition.chains.length > 0 && (
          <>
            <dt>{composition.chains.length === 1 ? 'Chain' : 'Chains'}</dt>
            <dd>{truncate(composition.chains.join(', '), 30)}</dd>
          </>
        )}
      </dl>
      {resPreview.length > 0 && (
        <div className="info-res-chips">
          {resPreview.map((r) => (
            <span key={r} className="info-res-chip">
              {r}
            </span>
          ))}
          {composition.residues.length > resPreview.length && <span className="info-more">+{composition.residues.length - resPreview.length} more</span>}
        </div>
      )}
      <div className="info-actions">
        <button type="button" className="btn btn-sm" onClick={focusSelection} title="Zoom to the selection (F)">
          <Focus size={14} /> <span>Focus</span>
        </button>
        <button type="button" className="btn btn-sm" onClick={makeLayer} title="Draw the selected atoms in their own layer">
          <Layers size={14} /> <span>Make layer</span>
        </button>
      </div>
      {n >= 2 && n <= 4 && <p className="info-tip">Tip: the geometry inspector below shows the {n === 2 ? 'distance' : n === 3 ? 'angle' : 'dihedral'} between these atoms.</p>}
    </div>
  );
}
