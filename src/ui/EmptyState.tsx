/**
 * Welcome screen shown on the stage when no molecule is loaded.
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 *
 * One search box understands PubChem names / CIDs, PDB ids, UniProt accessions (AlphaFold) and
 * SMILES (auto-detected, see shell/search.ts). Below: quick-start samples, file upload and
 * "build from scratch".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FolderOpen, Hexagon, LayoutGrid, PenLine, Search, Upload } from 'lucide-react';
import { SAMPLES, type SampleEntry } from '../io/samples';
import { ACCEPTED_EXTENSIONS, FORMAT_LABELS } from '../io/formats';
import { newMolecule, openSample, openSmiles } from '../app/actions';
import { Kbd } from './common';
import { openDroppedFiles } from './DropOverlay';
import { LogoMark } from './shell/icons';
import { SearchField } from './shell/SearchField';
import { SampleCard } from './shell/SampleCard';
import { pickQuickStart } from './shell/samples';
import { SEARCH_KIND_LABELS, describeSearch, detectSearchKind } from './shell/search';
import { runSearch } from './shell/searchActions';
import { useAbortableLoad, useIsLoading, usePubChemAutocomplete } from './shell/hooks';
import { openLoadDialog } from './shell/shellStore';
import { formatShortcut, isMacPlatform } from './shell/keys';
import './EmptyState.css';

const MAC = isMacPlatform();
const QUICK_START_COUNT = 6;

export default function EmptyState() {
  const loading = useIsLoading();
  const loader = useAbortableLoad();
  const [query, setQuery] = useState('');
  const [smiles, setSmiles] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loading) setPendingId(null);
  }, [loading]);

  const kind = detectSearchKind(query);
  const { suggestions, loading: suggesting } = usePubChemAutocomplete(query, kind === 'pubchem' && !loading);
  const quick = useMemo(() => pickQuickStart(SAMPLES, QUICK_START_COUNT), []);

  const submit = (text: string) => {
    const k = detectSearchKind(text);
    if (!k || loading) return;
    loader.run((signal) => runSearch(k, text, signal));
  };

  const openQuick = (s: SampleEntry) => {
    setPendingId(s.id);
    void openSample(s);
  };

  const buildSmiles = () => {
    if (smiles.trim() && !loading) void openSmiles(smiles.trim());
  };

  return (
    <div className="empty">
      <div className="empty-inner">
        <header className="empty-hero">
          <LogoMark size={60} className="empty-logo" />
          <h1 className="empty-title">Molecule Studio</h1>
          <p className="empty-tagline">Explore, inspect and build molecules in 3D — right in your browser.</p>
        </header>

        <div className="empty-search">
          <SearchField
            className="empty-search-field"
            inputClassName="empty-search-input"
            value={query}
            onChange={setQuery}
            onSubmit={submit}
            suggestions={kind === 'pubchem' ? suggestions : []}
            suggestFooter={suggesting ? 'Searching PubChem…' : 'Suggestions from PubChem'}
            placeholder="Search a compound, PDB id, UniProt id or SMILES…"
            ariaLabel="Search PubChem, the PDB or AlphaFold, or enter a SMILES"
            title="Compound name (PubChem), 4-character PDB id, UniProt accession (AlphaFold) or a SMILES string"
            icon={<Search size={17} />}
            disabled={loading}
            trailing={
              <>
                {kind && <span className="shell-badge shell-badge-accent empty-kind">{SEARCH_KIND_LABELS[kind]}</span>}
                <button type="button" className="empty-go" disabled={!kind || loading} onClick={() => submit(query)} title={kind ? `${describeSearch(kind, query)} (Enter)` : 'Type something to search'} aria-label="Search">
                  <ArrowRight size={16} />
                </button>
              </>
            }
          />
          <div className="empty-search-hint" aria-live="polite">
            {loading && loader.active ? (
              <>
                Loading…{' '}
                <button type="button" className="empty-link" onClick={loader.cancel}>
                  Cancel
                </button>
              </>
            ) : kind ? (
              <>
                {describeSearch(kind, query)} · <Kbd>Enter</Kbd>
              </>
            ) : (
              <>
                Try{' '}
                {[
                  ['caffeine', 'PubChem'],
                  ['1CRN', 'PDB'],
                  ['P69905', 'AlphaFold'],
                  ['c1ccccc1', 'SMILES'],
                ].map(([example, source], i) => (
                  <span key={example}>
                    {i > 0 && ', '}
                    <button type="button" className="empty-example" onClick={() => setQuery(example)} title={`${source} example`}>
                      {example}
                    </button>
                  </span>
                ))}
              </>
            )}
          </div>
        </div>

        {quick.length > 0 && (
          <section className="empty-section" aria-label="Quick start samples">
            <div className="empty-section-head">
              <span className="empty-section-title">Quick start</span>
              <button type="button" className="empty-link" onClick={() => openLoadDialog('gallery')} title="Open the sample gallery">
                <LayoutGrid size={13} /> Browse all samples
              </button>
            </div>
            <div className="empty-samples">
              {quick.map((s) => (
                <SampleCard key={s.id} sample={s} compact onOpen={openQuick} disabled={loading} pending={loading && pendingId === s.id} />
              ))}
            </div>
          </section>
        )}

        <div className="empty-actions">
          <button
            type="button"
            className="empty-card empty-card-button"
            onClick={() => fileRef.current?.click()}
            disabled={loading}
            title={`Open a structure file (${ACCEPTED_EXTENSIONS.join(', ')})`}
          >
            <span className="empty-card-icon">
              <Upload size={18} />
            </span>
            <span className="empty-card-text">
              <span className="empty-card-title">Upload a file</span>
              <span className="empty-card-desc">{Object.values(FORMAT_LABELS).join(' · ')}</span>
              <span className="empty-card-note">…or drop it anywhere on this window</span>
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(',')}
            className="shell-visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              if (e.target.files) openDroppedFiles(e.target.files);
              e.target.value = '';
            }}
          />

          <div className="empty-card">
            <div className="empty-card-row">
              <span className="empty-card-icon">
                <PenLine size={18} />
              </span>
              <span className="empty-card-text">
                <span className="empty-card-title">Build a molecule from scratch</span>
                <span className="empty-card-desc">Draw atoms and bonds — hydrogens are added for you</span>
              </span>
              <button type="button" className="btn btn-sm btn-primary empty-build" onClick={newMolecule} disabled={loading} title="Start an empty molecule in Edit mode">
                Start
              </button>
            </div>
            <div className="empty-smiles">
              <Hexagon size={14} className="empty-smiles-icon" aria-hidden="true" />
              <input
                className="input empty-smiles-input"
                value={smiles}
                placeholder="…or paste a SMILES, e.g. CC(=O)Oc1ccccc1C(=O)O"
                spellCheck={false}
                aria-label="SMILES string"
                disabled={loading}
                onChange={(e) => setSmiles(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') buildSmiles();
                }}
                title="Build a 3D structure from a SMILES string (Enter)"
              />
              <button type="button" className="btn btn-sm" disabled={!smiles.trim() || loading} onClick={buildSmiles} title="Build the 3D structure (Enter)">
                Build
              </button>
            </div>
          </div>
        </div>

        <footer className="empty-footer">
          <button type="button" className="empty-link" onClick={() => openLoadDialog()} title="All the ways to open a structure">
            <FolderOpen size={13} /> More ways to open
          </button>
          <span className="empty-footer-sep">·</span>
          <span>
            <Kbd>?</Kbd> help
          </span>
          <span className="empty-footer-sep">·</span>
          <span>
            <Kbd>{formatShortcut('Ctrl/Cmd+O', MAC)}</Kbd> open
          </span>
        </footer>
      </div>
    </div>
  );
}
