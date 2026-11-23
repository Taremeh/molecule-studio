import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFromAlphaFold, fetchFromPdb, fetchFromPubChem, pubchemAutocomplete } from './fetch';
import { BETAINE_SDF, PDB_FIXTURE } from './__fixtures__/fixtures';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let calls: string[] = [];

function mockFetch(handler: Handler) {
  calls = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    init?.signal?.throwIfAborted();
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const text = (body: string, status = 200) => new Response(body, { status });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PUBCHEM_404_NAME = 'Status: 404\nCode: PUGREST.NotFound\nMessage: No CID found\nDetail: No CID found that matches the given name';
const PUBCHEM_404_RECORDS = 'Status: 404\nCode: PUGREST.NotFound\nMessage: No records found for the given CID(s)';

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchFromPdb', () => {
  it('downloads the .pdb file', async () => {
    mockFetch(() => text(PDB_FIXTURE));
    const r = await fetchFromPdb(' 1crn ');
    expect(calls).toEqual(['https://files.rcsb.org/download/1CRN.pdb']);
    expect(r).toMatchObject({ format: 'pdb', name: '1CRN', source: 'pdb', externalId: '1CRN' });
    expect(r.text).toBe(PDB_FIXTURE);
  });

  it('falls back to mmCIF for entries without a .pdb file', async () => {
    mockFetch((url) => (url.endsWith('.pdb') ? text('<!DOCTYPE html><title>404</title>', 404) : text('data_4V6X\n')));
    const r = await fetchFromPdb('4v6x');
    expect(calls).toEqual(['https://files.rcsb.org/download/4V6X.pdb', 'https://files.rcsb.org/download/4V6X.cif']);
    expect(r.format).toBe('cif');
  });

  it('reports missing entries, invalid ids, server and network errors', async () => {
    mockFetch(() => text('not found', 404));
    await expect(fetchFromPdb('9XYZ')).rejects.toThrow('No PDB entry 9XYZ found.');
    await expect(fetchFromPdb('crambin')).rejects.toThrow(/not a valid PDB id/);
    await expect(fetchFromPdb('ABCD')).rejects.toThrow(/not a valid PDB id/);
    mockFetch(() => text('oops', 503));
    await expect(fetchFromPdb('1CRN')).rejects.toThrow(/temporarily unavailable \(HTTP 503\)/);
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchFromPdb('1CRN')).rejects.toThrow(/Network error — are you offline\?/);
  });

  it('honours AbortSignal', async () => {
    mockFetch(() => text(PDB_FIXTURE));
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(fetchFromPdb('1CRN', ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);

    const late = new AbortController();
    mockFetch(async (_url, init) => {
      late.abort();
      init?.signal?.throwIfAborted();
      return text(PDB_FIXTURE);
    });
    await expect(fetchFromPdb('1CRN', late.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('fetchFromPubChem', () => {
  it('fetches the 3D record by name', async () => {
    mockFetch(() => text(BETAINE_SDF));
    const r = await fetchFromPubChem('betaine');
    expect(calls).toEqual(['https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/betaine/SDF?record_type=3d']);
    expect(r).toMatchObject({ format: 'sdf', name: 'betaine', source: 'pubchem', externalId: '247' });
    expect(r.flat).toBeUndefined();
  });

  it('URL-encodes names', async () => {
    mockFetch(() => text(BETAINE_SDF));
    await fetchFromPubChem('penicillin G');
    expect(calls[0]).toBe('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/penicillin%20G/SDF?record_type=3d');
  });

  it('falls back to the 2D record (flat) when no 3D conformer exists', async () => {
    mockFetch((url) => (url.includes('record_type=3d') ? text(PUBCHEM_404_RECORDS, 404) : text(BETAINE_SDF)));
    const r = await fetchFromPubChem('heme');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('record_type=2d');
    expect(r.flat).toBe(true);
  });

  it('does not retry in 2D when the name is unknown', async () => {
    mockFetch(() => text(PUBCHEM_404_NAME, 404));
    await expect(fetchFromPubChem('notacompound')).rejects.toThrow('No compound named “notacompound” found in PubChem.');
    expect(calls).toHaveLength(1);
  });

  it('queries by CID and looks up the compound title', async () => {
    mockFetch((url) => (url.includes('/property/Title/') ? text('Betaine\n') : text(BETAINE_SDF)));
    const r = await fetchFromPubChem('CID 247');
    expect(calls[0]).toBe('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/247/SDF?record_type=3d');
    expect(r).toMatchObject({ name: 'Betaine', externalId: '247' });
  });

  it('uses a CID label when the title lookup fails', async () => {
    mockFetch((url) => (url.includes('/property/Title/') ? text('', 500) : text(BETAINE_SDF)));
    expect((await fetchFromPubChem('247')).name).toBe('CID 247');
  });

  it('reports busy servers, empty queries and network failures', async () => {
    mockFetch(() => text('Status: 503\nCode: PUGREST.ServerBusy', 503));
    await expect(fetchFromPubChem('caffeine')).rejects.toThrow(/PubChem is busy/);
    await expect(fetchFromPubChem('   ')).rejects.toThrow(/Enter a compound name/);
    mockFetch(() => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    });
    await expect(fetchFromPubChem('caffeine')).rejects.toThrow(/Network error/);
  });
});

describe('pubchemAutocomplete', () => {
  it('returns dictionary terms', async () => {
    mockFetch(() => json({ status: { code: 0 }, total: 2, dictionary_terms: { compound: ['caffeine', 'caffeic acid'] } }));
    expect(await pubchemAutocomplete('caff')).toEqual(['caffeine', 'caffeic acid']);
    expect(calls[0]).toBe('https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/caff/json?limit=8');
  });

  it('resolves [] on short queries, errors, odd payloads and aborts', async () => {
    mockFetch(() => json({ status: { code: 0 }, total: 0 }));
    expect(await pubchemAutocomplete('c')).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await pubchemAutocomplete('zzzz')).toEqual([]);
    mockFetch(() => text('busy', 503));
    expect(await pubchemAutocomplete('caff')).toEqual([]);
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await pubchemAutocomplete('caff')).toEqual([]);
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await pubchemAutocomplete('caff', ctrl.signal)).toEqual([]);
  });
});

describe('fetchFromAlphaFold', () => {
  const entry = {
    modelEntityId: 'AF-P69905-F1',
    uniprotAccession: 'P69905',
    pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.pdb',
    cifUrl: 'https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif',
  };

  it('looks up the prediction and downloads the PDB model', async () => {
    mockFetch((url) => (url.includes('/api/') ? json([entry]) : text(PDB_FIXTURE)));
    const r = await fetchFromAlphaFold('p69905');
    expect(calls).toEqual(['https://alphafold.ebi.ac.uk/api/prediction/P69905', entry.pdbUrl]);
    expect(r).toMatchObject({ format: 'pdb', name: 'AF-P69905-F1', source: 'alphafold', externalId: 'P69905' });
  });

  it('accepts AlphaFold model ids and falls back to mmCIF', async () => {
    mockFetch((url) => (url.includes('/api/') ? json([entry]) : url.endsWith('.pdb') ? text('gone', 404) : text('data_AF\n')));
    const r = await fetchFromAlphaFold('AF-P69905-F1');
    expect(r.format).toBe('cif');
    expect(calls[0]).toBe('https://alphafold.ebi.ac.uk/api/prediction/P69905');
  });

  it('reports missing models and invalid accessions', async () => {
    mockFetch(() => json({ error: 'not found' }, 404));
    await expect(fetchFromAlphaFold('Q99999')).rejects.toThrow('No AlphaFold model found for UniProt Q99999.');
    mockFetch(() => json([]));
    await expect(fetchFromAlphaFold('Q99999')).rejects.toThrow(/No AlphaFold model/);
    await expect(fetchFromAlphaFold('hemoglobin')).rejects.toThrow(/not a valid UniProt accession/);
  });

  it('refuses to follow model URLs outside EMBL-EBI', async () => {
    mockFetch(() => json([{ ...entry, pdbUrl: 'https://evil.example.com/x.pdb', cifUrl: 'http://alphafold.ebi.ac.uk/x.cif' }]));
    await expect(fetchFromAlphaFold('P69905')).rejects.toThrow(/No AlphaFold model/);
    expect(calls).toHaveLength(1);
  });
});
