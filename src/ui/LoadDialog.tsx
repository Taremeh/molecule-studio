/**
 * Load dialog (store.panels.load): samples gallery, PDB id, PubChem search with autocomplete, AlphaFold, file upload, paste text, SMILES, new empty molecule.
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 *
 * The dialog closes itself when a molecule loads (store.loadMolecule). While a load is in flight a
 * status banner shows the store's loading message; network fetches started here can be cancelled.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ClipboardPaste,
  Database,
  FileUp,
  FlaskConical,
  Hexagon,
  LayoutGrid,
  LoaderCircle,
  PenLine,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { useStore } from '../state/store';
import { SAMPLES, type SampleEntry } from '../io/samples';
import { ACCEPTED_EXTENSIONS, FORMAT_LABELS, type FileFormat } from '../io/formats';
import { newMolecule, openSample, openSmiles, openText } from '../app/actions';
import { Button, Kbd, Modal } from './common';
import { openDroppedFiles } from './DropOverlay';
import { useShell, type LoadTab } from './shell/shellStore';
import { useAbortableLoad, useIsLoading, usePubChemAutocomplete } from './shell/hooks';
import { SearchField } from './shell/SearchField';
import { SampleCard, CategoryIcon } from './shell/SampleCard';
import { CATEGORY_LABELS, CATEGORY_ORDER, filterSamples, groupSamples, type SampleCategory } from './shell/samples';
import { detectSearchKind, isPdbId, isUniprotId } from './shell/search';
import { runSearch } from './shell/searchActions';
import { formatShortcut, isMacPlatform } from './shell/keys';
import './LoadDialog.css';

const MAC = isMacPlatform();

const TABS: { id: LoadTab; label: string; icon: ReactNode; title: string }[] = [
  { id: 'gallery', label: 'Gallery', icon: <LayoutGrid size={15} />, title: 'Curated example structures' },
  { id: 'search', label: 'Search online', icon: <Search size={15} />, title: 'PubChem, RCSB PDB and AlphaFold DB' },
  { id: 'smiles', label: 'SMILES', icon: <Hexagon size={15} />, title: 'Build a 3D structure from a SMILES string' },
  { id: 'file', label: 'File', icon: <FileUp size={15} />, title: 'Open or paste a structure file' },
  { id: 'new', label: 'New', icon: <PenLine size={15} />, title: 'Start an empty molecule' },
];

const PDB_EXAMPLES: { id: string; name: string }[] = [
  { id: '1CRN', name: 'Crambin — tiny plant protein' },
  { id: '1UBQ', name: 'Ubiquitin' },
  { id: '4HHB', name: 'Hemoglobin with heme groups' },
  { id: '1HSG', name: 'HIV-1 protease with an inhibitor' },
  { id: '6LU7', name: 'SARS-CoV-2 main protease with an inhibitor' },
  { id: '1EMA', name: 'Green fluorescent protein' },
  { id: '1BNA', name: 'B-DNA dodecamer' },
];

const PUBCHEM_EXAMPLES = ['caffeine', 'aspirin', 'ibuprofen', 'dopamine', 'glucose', 'cholesterol', 'adenosine triphosphate'];

const ALPHAFOLD_EXAMPLES: { id: string; name: string }[] = [
  { id: 'P69905', name: 'Hemoglobin subunit alpha (human)' },
  { id: 'P01308', name: 'Insulin (human)' },
  { id: 'P04637', name: 'Tumor suppressor p53 (human)' },
];

const SMILES_EXAMPLES: { name: string; smiles: string }[] = [
  { name: 'Ethanol', smiles: 'CCO' },
  { name: 'Benzene', smiles: 'c1ccccc1' },
  { name: 'Cyclohexane', smiles: 'C1CCCCC1' },
  { name: 'Aspirin', smiles: 'CC(=O)Oc1ccccc1C(=O)O' },
  { name: 'Caffeine', smiles: 'Cn1cnc2c1c(=O)n(C)c(=O)n2C' },
  { name: 'Ibuprofen', smiles: 'CC(C)Cc1ccc(cc1)C(C)C(=O)O' },
  { name: 'Serotonin', smiles: 'NCCc1c[nH]c2ccc(O)cc12' },
  { name: 'Glycine (zwitterion)', smiles: '[NH3+]CC(=O)[O-]' },
];

export default function LoadDialog() {
  const open = useStore((s) => s.panels.load);
  const onClose = useCallback(() => useStore.getState().setPanel('load', false), []);
  return (
    <Modal open={open} onClose={onClose} title="Open a structure" width={900} className="load-modal">
      {open && <LoadContent />}
    </Modal>
  );
}

function LoadContent() {
  const tab = useShell((s) => s.loadTab);
  const setTab = useShell((s) => s.setLoadTab);
  const loading = useStore((s) => s.loading);
  const loader = useAbortableLoad();
  /** Text handed from the gallery's "search online" link to the Search tab. */
  const [prefill, setPrefill] = useState<string | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  };

  return (
    <div className="load">
      <div className="load-tabs" role="tablist" aria-label="Ways to open a structure" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`load-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`load-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`load-tab ${tab === t.id ? 'is-active' : ''}`}
            title={t.title}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {loading && (
        <div className="load-busy" role="status">
          <LoaderCircle size={15} className="shell-spin" />
          <span className="load-busy-text">{loading}</span>
          {loader.active && (
            <button type="button" className="load-busy-cancel" onClick={loader.cancel} title="Cancel the download">
              <X size={13} /> Cancel
            </button>
          )}
        </div>
      )}

      <div className="load-panel" role="tabpanel" id={`load-panel-${tab}`} aria-labelledby={`load-tab-${tab}`}>
        {tab === 'gallery' && (
          <GalleryTab
            onSearchOnline={(q) => {
              setPrefill(q);
              setTab('search');
            }}
          />
        )}
        {tab === 'search' && <SearchTab run={loader.run} prefill={prefill} onPrefillUsed={() => setPrefill(null)} />}
        {tab === 'smiles' && <SmilesTab />}
        {tab === 'file' && <FileTab />}
        {tab === 'new' && <NewTab onSmiles={() => setTab('smiles')} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

function GalleryTab({ onSearchOnline }: { onSearchOnline: (q: string) => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SampleCategory | 'all'>('all');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const loading = useIsLoading();
  useEffect(() => {
    if (!loading) setPendingId(null);
  }, [loading]);

  const filtered = useMemo(() => filterSamples(SAMPLES, query, category), [query, category]);
  const groups = useMemo(() => groupSamples(filtered), [filtered]);
  const counts = useMemo(() => {
    const c = new Map<SampleCategory, number>();
    for (const s of SAMPLES) c.set(s.category, (c.get(s.category) ?? 0) + 1);
    return c;
  }, []);
  const categories = CATEGORY_ORDER.filter((c) => counts.has(c));

  const open = (s: SampleEntry) => {
    setPendingId(s.id);
    void openSample(s);
  };

  return (
    <div className="load-gallery">
      <div className="load-gallery-bar">
        <SearchField
          className="load-gallery-search"
          value={query}
          onChange={setQuery}
          onSubmit={() => {
            if (filtered.length === 1) open(filtered[0]);
          }}
          placeholder="Filter samples — name, tag or PDB id"
          ariaLabel="Filter samples"
          icon={<Search size={14} />}
          autoFocus
        />
        <div className="load-cats" role="radiogroup" aria-label="Category">
          <button type="button" role="radio" aria-checked={category === 'all'} className={`chip ${category === 'all' ? 'is-active' : ''}`} onClick={() => setCategory('all')} title="All samples">
            All <span className="load-cat-count">{SAMPLES.length}</span>
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={category === c}
              className={`chip ${category === c ? 'is-active' : ''}`}
              onClick={() => setCategory(c)}
              title={`Only ${CATEGORY_LABELS[c].toLowerCase()}`}
            >
              <CategoryIcon category={c} size={12} /> {CATEGORY_LABELS[c]} <span className="load-cat-count">{counts.get(c)}</span>
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="load-noresults">
          <p>No samples match “{query}”.</p>
          {query.trim() && (
            <Button icon={<Search size={14} />} onClick={() => onSearchOnline(query.trim())} title="Look it up on PubChem / RCSB PDB">
              Search online for “{query.trim()}”
            </Button>
          )}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.category} className="load-group">
            <h3 className="load-group-title">
              <CategoryIcon category={g.category} size={14} /> {CATEGORY_LABELS[g.category]}
            </h3>
            <div className="load-cards">
              {g.items.map((s) => (
                <SampleCard key={s.id} sample={s} onOpen={open} disabled={loading} pending={pendingId === s.id && loading} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search online
// ---------------------------------------------------------------------------

function SearchTab(props: { run: (fn: (signal: AbortSignal) => Promise<unknown>) => void; prefill: string | null; onPrefillUsed: () => void }) {
  const loading = useIsLoading();
  const [pubchem, setPubchem] = useState('');
  const [pdb, setPdb] = useState('');
  const [uniprot, setUniprot] = useState('');

  // Route text from the gallery to the matching field.
  useEffect(() => {
    if (props.prefill === null) return;
    const kind = detectSearchKind(props.prefill);
    if (kind === 'pdb') setPdb(props.prefill.toUpperCase());
    else if (kind === 'alphafold') setUniprot(props.prefill.toUpperCase());
    else setPubchem(props.prefill);
    props.onPrefillUsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.prefill]);

  const { suggestions, loading: suggesting } = usePubChemAutocomplete(pubchem, !loading);
  const pdbValid = isPdbId(pdb);
  const uniprotValid = isUniprotId(uniprot);

  const fetchPubChem = (q: string) => {
    if (q.trim()) props.run((signal) => runSearch('pubchem', q, signal));
  };
  const fetchPdb = (id: string) => {
    if (isPdbId(id)) props.run((signal) => runSearch('pdb', id, signal));
  };
  const fetchAlphaFold = (id: string) => {
    if (isUniprotId(id)) props.run((signal) => runSearch('alphafold', id, signal));
  };

  return (
    <div className="load-search">
      <SourceBlock icon={<FlaskConical size={16} />} title="PubChem" subtitle="Small molecules by name or CID — 3D conformer when available">
        <div className="load-inline">
          <SearchField
            className="grow"
            value={pubchem}
            onChange={setPubchem}
            onSubmit={fetchPubChem}
            suggestions={suggestions}
            suggestFooter={suggesting ? 'Searching PubChem…' : 'Suggestions from PubChem'}
            placeholder="Compound name, e.g. caffeine, or CID 2519"
            ariaLabel="PubChem compound name or CID"
            icon={<Search size={14} />}
            disabled={loading}
            autoFocus
          />
          <Button variant="primary" disabled={loading || !pubchem.trim()} onClick={() => fetchPubChem(pubchem)} title="Fetch from PubChem (Enter)">
            Fetch
          </Button>
        </div>
        <Examples>
          {PUBCHEM_EXAMPLES.map((name) => (
            <button
              key={name}
              type="button"
              className="chip"
              disabled={loading}
              onClick={() => {
                setPubchem(name);
                fetchPubChem(name);
              }}
              title={`Fetch ${name} from PubChem`}
            >
              {name}
            </button>
          ))}
        </Examples>
      </SourceBlock>

      <SourceBlock icon={<Database size={16} />} title="Protein Data Bank" subtitle="Experimental structures from RCSB by 4-character PDB id">
        <div className="load-inline">
          <SearchField
            className="load-id-field"
            inputClassName="mono load-id-input"
            value={pdb}
            onChange={(v) => setPdb(v.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            onSubmit={fetchPdb}
            placeholder="e.g. 1CRN"
            ariaLabel="PDB id"
            maxLength={4}
            invalid={pdb.length === 4 && !pdbValid}
            disabled={loading}
          />
          <Button variant="primary" disabled={loading || !pdbValid} onClick={() => fetchPdb(pdb)} title="Fetch from RCSB PDB (Enter)">
            Fetch
          </Button>
          <span className="load-field-hint">{pdb && !pdbValid ? (pdb.length < 4 ? 'PDB ids have 4 characters' : 'Starts with a digit, e.g. 4HHB') : ''}</span>
        </div>
        <Examples>
          {PDB_EXAMPLES.map((e) => (
            <button
              key={e.id}
              type="button"
              className="chip"
              disabled={loading}
              onClick={() => {
                setPdb(e.id);
                fetchPdb(e.id);
              }}
              title={`${e.id}: ${e.name}`}
            >
              <span className="mono">{e.id}</span>
              <span className="load-chip-name">{e.name.split(' — ')[0].split(' with ')[0]}</span>
            </button>
          ))}
        </Examples>
      </SourceBlock>

      <SourceBlock icon={<Sparkles size={16} />} title="AlphaFold DB" subtitle="Predicted protein structures by UniProt accession (B-factor = pLDDT confidence)">
        <div className="load-inline">
          <SearchField
            className="load-id-field load-uniprot-field"
            inputClassName="mono load-id-input"
            value={uniprot}
            onChange={(v) => setUniprot(v.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            onSubmit={fetchAlphaFold}
            placeholder="e.g. P69905"
            ariaLabel="UniProt accession"
            maxLength={10}
            invalid={uniprot.length >= 6 && !uniprotValid}
            disabled={loading}
          />
          <Button variant="primary" disabled={loading || !uniprotValid} onClick={() => fetchAlphaFold(uniprot)} title="Fetch the AlphaFold model (Enter)">
            Fetch
          </Button>
          <span className="load-field-hint">{uniprot.length >= 6 && !uniprotValid ? 'Not a UniProt accession (e.g. P69905)' : ''}</span>
        </div>
        <Examples>
          {ALPHAFOLD_EXAMPLES.map((e) => (
            <button
              key={e.id}
              type="button"
              className="chip"
              disabled={loading}
              onClick={() => {
                setUniprot(e.id);
                fetchAlphaFold(e.id);
              }}
              title={`${e.id}: ${e.name}`}
            >
              <span className="mono">{e.id}</span>
              <span className="load-chip-name">{e.name.replace(/ \(human\)$/, '')}</span>
            </button>
          ))}
        </Examples>
      </SourceBlock>
    </div>
  );
}

function SourceBlock(props: { icon: ReactNode; title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="load-source">
      <header className="load-source-head">
        <span className="load-source-icon">{props.icon}</span>
        <div>
          <h3>{props.title}</h3>
          <p>{props.subtitle}</p>
        </div>
      </header>
      {props.children}
    </section>
  );
}

function Examples({ children }: { children: ReactNode }) {
  return (
    <div className="load-examples">
      <span className="load-examples-label">Try</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SMILES
// ---------------------------------------------------------------------------

function SmilesTab() {
  const loading = useIsLoading();
  const [smiles, setSmiles] = useState('');
  const [name, setName] = useState('');
  const build = (s = smiles, n = name) => {
    if (!s.trim()) return;
    void openSmiles(s.trim(), n.trim() || undefined);
  };
  return (
    <div className="load-smiles">
      <p className="load-lead">
        Paste a SMILES string — hydrogens and 3D coordinates are generated automatically, then you can refine the structure in Edit mode.
      </p>
      <label className="load-label" htmlFor="load-smiles-input">
        SMILES
      </label>
      <textarea
        id="load-smiles-input"
        className="input load-smiles-input"
        rows={3}
        value={smiles}
        spellCheck={false}
        autoFocus
        placeholder="e.g. CC(=O)Oc1ccccc1C(=O)O"
        onChange={(e) => setSmiles(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            build();
          }
        }}
        title="SMILES string (Enter builds, Shift+Enter inserts a new line)"
      />
      <div className="load-smiles-row">
        <label className="load-label" htmlFor="load-smiles-name">
          Name <span className="muted">(optional)</span>
        </label>
        <input id="load-smiles-name" className="input grow" value={name} placeholder="e.g. Aspirin" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && build()} />
        <Button variant="primary" icon={<Hexagon size={14} />} disabled={loading || !smiles.trim()} onClick={() => build()} title="Build the 3D structure (Enter)">
          Build 3D structure
        </Button>
      </div>
      <Examples>
        {SMILES_EXAMPLES.map((e) => (
          <button
            key={e.name}
            type="button"
            className="chip"
            disabled={loading}
            title={`${e.name}: ${e.smiles}`}
            onClick={() => {
              setSmiles(e.smiles);
              setName(e.name);
              build(e.smiles, e.name);
            }}
          >
            {e.name}
          </button>
        ))}
      </Examples>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

function FileTab() {
  const loading = useIsLoading();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [text, setText] = useState('');
  const [format, setFormat] = useState<FileFormat | 'auto'>('auto');
  const [name, setName] = useState('');

  const loadText = () => {
    if (!text.trim()) return;
    void openText(text, format === 'auto' ? null : format, name.trim() || 'Pasted structure', 'paste');
  };

  return (
    <div className="load-file">
      <div
        className={`load-drop ${over ? 'is-over' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Choose a structure file"
        title="Click to choose a file, or drop one here"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(e) => {
          // preventDefault tells the window-level DropOverlay that this drop is handled.
          e.preventDefault();
          setOver(false);
          openDroppedFiles(e.dataTransfer.files);
        }}
      >
        <span className="load-drop-icon">
          <Upload size={22} />
        </span>
        <span className="load-drop-title">Drop a structure file here or click to browse</span>
        <span className="load-drop-formats">{Object.values(FORMAT_LABELS).join(' · ')}</span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          className="shell-visually-hidden"
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files) openDroppedFiles(e.target.files);
            e.target.value = ''; // allow re-opening the same file
          }}
        />
      </div>

      <div className="load-paste">
        <div className="load-paste-head">
          <ClipboardPaste size={15} />
          <span>Or paste file contents</span>
        </div>
        <textarea
          className="input load-paste-input"
          rows={7}
          value={text}
          spellCheck={false}
          placeholder={'ATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00  0.00           N\n…or an SDF / XYZ / MOL2 / mmCIF block'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              loadText();
            }
          }}
          aria-label="Structure file contents"
        />
        <div className="load-paste-row">
          <select className="select" value={format} onChange={(e) => setFormat(e.target.value as FileFormat | 'auto')} title="File format (auto-detected from the content by default)" aria-label="Format">
            <option value="auto">Auto-detect format</option>
            {(Object.keys(FORMAT_LABELS) as FileFormat[]).map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
          <input className="input grow" value={name} placeholder="Name (optional)" onChange={(e) => setName(e.target.value)} aria-label="Structure name" />
          <Button variant="primary" disabled={loading || !text.trim()} onClick={loadText} title={`Load the pasted structure (${formatShortcut('Ctrl/Cmd+Enter', MAC)})`}>
            Load
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New
// ---------------------------------------------------------------------------

function NewTab({ onSmiles }: { onSmiles: () => void }) {
  return (
    <div className="load-new">
      <div className="load-new-hero">
        <span className="load-new-icon">
          <PenLine size={26} />
        </span>
        <h3>Build a molecule from scratch</h3>
        <p>Start with an empty canvas in Edit mode. Atoms snap to sensible bond lengths and hydrogens are filled in automatically.</p>
        <Button variant="primary" icon={<PenLine size={14} />} onClick={newMolecule} title="Start an empty molecule in Edit mode">
          Start empty molecule
        </Button>
      </div>
      <ul className="load-new-tips">
        <li>
          Click empty space to place a carbon; click an atom to grow a bond from it.
        </li>
        <li>
          Press <Kbd>N</Kbd> <Kbd>O</Kbd> <Kbd>S</Kbd> … to switch elements and <Kbd>1</Kbd> <Kbd>2</Kbd> <Kbd>3</Kbd> for bond orders.
        </li>
        <li>Use the fragment tool to drop in rings and functional groups.</li>
        <li>
          Prefer typing?{' '}
          <button type="button" className="load-link" onClick={onSmiles}>
            Start from a SMILES string
          </button>
          .
        </li>
      </ul>
    </div>
  );
}
