/**
 * Module Web Worker computing molecular surfaces off the main thread. OWNER: render-advanced.
 * Protocol: receives a SurfaceWorkerRequest, replies once with a SurfaceWorkerResponse whose typed arrays
 * are transferred (zero-copy). The main thread terminates the worker after the reply or on abort.
 */
import { computeSurface, type SurfaceWorkerRequest, type SurfaceWorkerResponse } from './surface-core';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<SurfaceWorkerRequest>) => void) | null;
  postMessage(message: SurfaceWorkerResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  const { id, input } = ev.data;
  try {
    const mesh = computeSurface(input);
    const transfer: Transferable[] = mesh
      ? [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.atom.buffer]
      : [];
    scope.postMessage({ id, ok: true, mesh }, transfer);
  } catch (e) {
    scope.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) }, []);
  }
};
