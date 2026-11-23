import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../state/store';
import { newMolecule, openFile, openPdbId, openText } from './actions';

const S = () => useStore.getState();

/** Enough of a File for openFile. */
function fakeFile(name: string, text: () => Promise<string>): File {
  return { name, text } as unknown as File;
}

beforeEach(() => {
  useStore.setState({ toasts: [], loading: null, molecule: null });
});

describe('openFile', () => {
  it('loads a readable file', async () => {
    const xyz = '3\nwater\nO 0 0 0\nH 0.96 0 0\nH -0.24 0.93 0\n';
    const mol = await openFile(fakeFile('water.xyz', async () => xyz));
    expect(mol?.atoms).toHaveLength(3);
    expect(S().molecule).toBe(mol);
    expect(S().loading).toBeNull();
  });

  it('reports a file that cannot be read (e.g. a dropped folder) instead of rejecting', async () => {
    const unreadable = fakeFile('structures', () =>
      Promise.reject(Object.assign(new Error('A requested file or directory could not be found at the time an operation was processed.'), { name: 'NotFoundError' })),
    );
    await expect(openFile(unreadable)).resolves.toBeUndefined();
    expect(S().molecule).toBeNull();
    expect(S().loading).toBeNull();
    const t = S().toasts.at(-1);
    expect(t?.kind).toBe('error');
    expect(t?.message).toMatch(/structures/);
  });
});

describe('overlapping loads', () => {
  const PDB = 'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00  0.00           N\nATOM      2  CA  ALA A   1       1.458   0.000   0.000  1.00  0.00           C\nEND\n';
  const XYZ = '1\nneon\nNe 0 0 0\n';
  let release: () => void = () => {};

  beforeEach(() => {
    // A slow download: the response arrives only when the test says so.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((resolve, reject) => {
            release = () => resolve(new Response(PDB, { status: 200 }));
            init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
          }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a slow download that finishes after a newer file was opened does not replace it', async () => {
    const slow = openPdbId('1ABC');
    await new Promise((r) => setTimeout(r, 30)); // the download is in flight
    const dropped = await openText(XYZ, null, 'neon.xyz'); // meanwhile the user drops a file
    expect(S().molecule).toBe(dropped);
    expect(S().loading).toBeNull();
    release();
    await expect(slow).resolves.toBeUndefined();
    expect(S().molecule).toBe(dropped);
    expect(S().loading).toBeNull();
    expect(S().toasts.filter((t) => t.kind === 'error')).toEqual([]);
  });

  it("an older operation finishing first does not hide a newer one's loading indicator", async () => {
    const slow = openPdbId('1ABC');
    await new Promise((r) => setTimeout(r, 30));
    const ctrl = new AbortController();
    const second = openPdbId('2XYZ', ctrl.signal); // e.g. a second search started from the dialog
    release(); // only the first request is answered now…
    await slow;
    expect(S().loading).toMatch(/2XYZ/); // …the second is still running
    ctrl.abort();
    await second;
    expect(S().loading).toBeNull();
  });

  it('a download superseded by a newer search is dropped without a "Cancelled" toast', async () => {
    const first = new AbortController();
    const slow = openPdbId('1ABC', first.signal);
    await new Promise((r) => setTimeout(r, 30));
    const next = openText(XYZ, null, 'neon.xyz');
    first.abort(); // useAbortableLoad aborts the previous request when a new one starts
    await slow;
    const loaded = await next;
    expect(S().molecule).toBe(loaded);
    expect(S().toasts.map((t) => t.message)).not.toContain('Cancelled');
  });

  it('a slow download does not replace a molecule started from scratch meanwhile', async () => {
    const slow = openPdbId('1ABC');
    await new Promise((r) => setTimeout(r, 30));
    newMolecule();
    const fresh = S().molecule;
    // The superseded download's indicator (it covers the stage) must not stay up until it finishes.
    expect(S().loading).toBeNull();
    release();
    await slow;
    expect(S().molecule).toBe(fresh);
    expect(S().loading).toBeNull();
    expect(S().toasts.filter((t) => t.kind === 'error')).toEqual([]);
  });
});
