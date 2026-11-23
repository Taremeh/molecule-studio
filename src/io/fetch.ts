/**
 * Fetch structures from public databases (all support CORS).
 * OWNER: io agent. CONTRACT: keep exported names & signatures.
 *
 * - RCSB PDB:  https://files.rcsb.org/download/{ID}.pdb, fall back to {ID}.cif (large entries have no .pdb).
 *              4-character ids only (validate: /^[0-9][A-Za-z0-9]{3}$/). Title from HEADER/TITLE.
 * - PubChem:   https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{name}/SDF?record_type=3d
 *              (or /cid/{cid}/... when the query is all digits); if no 3D conformer exists (404),
 *              fall back to record_type=2d and set `flat: true` so the caller can embed in 3D.
 * - PubChem autocomplete: https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/{q}/json?limit=8
 *              → response.dictionary_terms.compound (string[]).
 * - AlphaFold DB: https://alphafold.ebi.ac.uk/api/prediction/{UNIPROT} → JSON array, use [0].pdbUrl
 *              (or cifUrl), then fetch that file.
 * Errors: throw Error with a friendly message ("No PDB entry 1XYZ found", "Network error — are you
 * offline?"). Respect AbortSignal: an aborted request rejects with the signal's reason (a DOMException
 * named 'AbortError' by default) — except pubchemAutocomplete, which never rejects and resolves [].
 */
import type { FileFormat } from './formats';

export interface FetchedStructure {
  text: string;
  format: FileFormat;
  /** Display name, e.g. '1CRN' or 'caffeine'. */
  name: string;
  /** e.g. 'pdb', 'pubchem', 'alphafold' */
  source: string;
  externalId?: string;
  /** True if only 2D coordinates were available (caller should embed in 3D). */
  flat?: boolean;
}

const RCSB_DOWNLOAD = 'https://files.rcsb.org/download/';
const PUBCHEM_COMPOUND = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/';
const PUBCHEM_AUTOCOMPLETE = 'https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/';
const ALPHAFOLD_API = 'https://alphafold.ebi.ac.uk/api/prediction/';

export const PDB_ID_PATTERN = /^[0-9][A-Za-z0-9]{3}$/;
/** UniProt accession format (https://www.uniprot.org/help/accession_numbers). */
export const UNIPROT_PATTERN = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9]){1,2})$/;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/** fetch() with friendly network errors; aborts propagate unchanged. */
async function request(url: string, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  try {
    return await fetch(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    if (isAbortError(e)) throw e;
    throw new Error('Network error — are you offline? The server could not be reached.');
  }
}

async function readText(res: Response, signal?: AbortSignal): Promise<string> {
  try {
    return await res.text();
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    if (isAbortError(e)) throw e;
    throw new Error('Network error — the download was interrupted.');
  }
}

function httpError(service: string, status: number): Error {
  if (status === 429) return new Error(`Too many requests to ${service} — please wait a moment and try again.`);
  if (status >= 500) return new Error(`${service} is temporarily unavailable (HTTP ${status}). Please try again later.`);
  return new Error(`${service} returned an error (HTTP ${status}).`);
}

function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 15).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

// ---------------------------------------------------------------------------
// RCSB PDB
// ---------------------------------------------------------------------------

export async function fetchFromPdb(id: string, signal?: AbortSignal): Promise<FetchedStructure> {
  const code = id.trim().toUpperCase();
  if (!PDB_ID_PATTERN.test(code)) {
    throw new Error(`“${id.trim()}” is not a valid PDB id. PDB ids have 4 characters and start with a digit, like 1CRN.`);
  }
  for (const format of ['pdb', 'cif'] as const) {
    const res = await request(`${RCSB_DOWNLOAD}${code}.${format}`, signal);
    if (res.ok) {
      const text = await readText(res, signal);
      if (!text.trim() || looksLikeHtml(text)) continue;
      return { text, format, name: code, source: 'pdb', externalId: code };
    }
    if (res.status !== 404 && res.status !== 410) throw httpError('The RCSB PDB', res.status);
  }
  throw new Error(`No PDB entry ${code} found.`);
}

// ---------------------------------------------------------------------------
// PubChem
// ---------------------------------------------------------------------------

/** CID of the first record of a PubChem SDF (header line or PUBCHEM_COMPOUND_CID item). */
function extractCid(sdf: string): string | undefined {
  const m = /^> *<PUBCHEM_COMPOUND_CID>[^\n]*\n(\d+)/m.exec(sdf);
  if (m) return m[1];
  const first = sdf.slice(0, sdf.indexOf('\n')).trim();
  return /^\d+$/.test(first) ? first : undefined;
}

async function pubchemTitle(cid: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await request(`${PUBCHEM_COMPOUND}cid/${cid}/property/Title/TXT`, signal);
    if (!res.ok) return undefined;
    const title = (await readText(res, signal)).split('\n')[0].trim();
    return title && title.length <= 120 ? title : undefined;
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) throw e;
    return undefined; // the title is cosmetic
  }
}

export async function fetchFromPubChem(query: string, signal?: AbortSignal): Promise<FetchedStructure> {
  const q = query.trim();
  if (!q) throw new Error('Enter a compound name or a PubChem CID.');
  const cidMatch = /^(?:cid[\s:#-]*)?(\d+)$/i.exec(q);
  const queryCid = cidMatch?.[1];
  const path = queryCid ? `cid/${queryCid}` : `name/${encodeURIComponent(q)}`;
  const notFound = () =>
    new Error(queryCid ? `No PubChem compound with CID ${queryCid} found.` : `No compound named “${q}” found in PubChem.`);
  const busy = () => new Error('PubChem is busy right now — please try again in a moment.');

  let flat = false;
  let res = await request(`${PUBCHEM_COMPOUND}${path}/SDF?record_type=3d`, signal);
  if (res.status === 404) {
    // Either the compound does not exist ("No CID found") or it has no 3D conformer (e.g. salts,
    // metal complexes, large molecules): try the 2D record.
    const body = await readText(res, signal);
    if (/No CID found/i.test(body)) throw notFound();
    res = await request(`${PUBCHEM_COMPOUND}${path}/SDF?record_type=2d`, signal);
    flat = true;
    if (res.status === 404) throw notFound();
  }
  if (res.status === 400) throw queryCid ? new Error(`“${queryCid}” is not a valid PubChem CID.`) : notFound();
  if (res.status === 503) throw busy();
  if (!res.ok) throw httpError('PubChem', res.status);
  const text = await readText(res, signal);
  if (!text.includes('M  END') && !/V[23]000/.test(text)) throw new Error('PubChem returned an unexpected response. Please try again.');

  const cid = extractCid(text) ?? queryCid;
  let name = q;
  if (queryCid) name = (cid && (await pubchemTitle(cid, signal))) || `CID ${queryCid}`;
  const out: FetchedStructure = { text, format: 'sdf', name, source: 'pubchem' };
  if (cid) out.externalId = cid;
  if (flat) out.flat = true;
  return out;
}

/** Compound-name suggestions for a partial query. Never rejects: resolves [] on errors and aborts. */
export async function pubchemAutocomplete(query: string, signal?: AbortSignal): Promise<string[]> {
  const q = query.trim();
  if (q.length < 2 || signal?.aborted) return [];
  try {
    const res = await fetch(`${PUBCHEM_AUTOCOMPLETE}${encodeURIComponent(q)}/json?limit=8`, { signal });
    if (!res.ok) return [];
    const json: unknown = await res.json();
    const list = (json as { dictionary_terms?: { compound?: unknown } } | null)?.dictionary_terms?.compound;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// AlphaFold DB
// ---------------------------------------------------------------------------

interface AlphaFoldEntry {
  pdbUrl?: unknown;
  cifUrl?: unknown;
  modelEntityId?: unknown;
  uniprotAccession?: unknown;
}

/** Only follow model URLs served by EMBL-EBI over https. */
function trustedModelUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && (url.hostname === 'ebi.ac.uk' || url.hostname.endsWith('.ebi.ac.uk')) ? url.href : null;
  } catch {
    return null;
  }
}

export async function fetchFromAlphaFold(uniprotId: string, signal?: AbortSignal): Promise<FetchedStructure> {
  const raw = uniprotId.trim().toUpperCase();
  // Accept model ids like AF-P69905-F1 too.
  const af = /^AF-([A-Z0-9]+)-F\d+(?:-MODEL_V\d+)?$/.exec(raw);
  const acc = af ? af[1] : raw;
  if (!UNIPROT_PATTERN.test(acc)) {
    throw new Error(`“${uniprotId.trim()}” is not a valid UniProt accession. Try something like P69905 (human hemoglobin α).`);
  }
  const noModel = () => new Error(`No AlphaFold model found for UniProt ${acc}.`);
  const res = await request(`${ALPHAFOLD_API}${acc}`, signal);
  if (res.status === 404) throw noModel();
  if (res.status === 400) throw new Error(`AlphaFold DB did not accept “${acc}” as a UniProt accession.`);
  if (!res.ok) throw httpError('AlphaFold DB', res.status);
  let entries: unknown;
  try {
    entries = JSON.parse(await readText(res, signal));
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) throw e;
    throw new Error('AlphaFold DB returned an unexpected response.');
  }
  const entry = (Array.isArray(entries) ? entries[0] : undefined) as AlphaFoldEntry | undefined;
  if (!entry) throw noModel();

  const candidates: { url: string; format: FileFormat }[] = [];
  const pdbUrl = trustedModelUrl(entry.pdbUrl);
  const cifUrl = trustedModelUrl(entry.cifUrl);
  if (pdbUrl) candidates.push({ url: pdbUrl, format: 'pdb' });
  if (cifUrl) candidates.push({ url: cifUrl, format: 'cif' });
  if (!candidates.length) throw noModel();

  let lastStatus = 0;
  for (const c of candidates) {
    const fileRes = await request(c.url, signal);
    if (!fileRes.ok) {
      lastStatus = fileRes.status;
      continue;
    }
    const text = await readText(fileRes, signal);
    if (!text.trim() || looksLikeHtml(text)) continue;
    const name = typeof entry.modelEntityId === 'string' && entry.modelEntityId ? entry.modelEntityId : `AF-${acc}-F1`;
    return { text, format: c.format, name, source: 'alphafold', externalId: acc };
  }
  throw lastStatus ? httpError('AlphaFold DB', lastStatus) : new Error(`Could not download the AlphaFold model for ${acc}.`);
}
