// Main-thread side of the music renderer: runs renders in a worker so the UI stays responsive,
// falling back to rendering here if workers are unavailable.
import type { MusicResult, RenderMode } from './render';
import type { MusicParams } from './types';

type Pending = { resolve: (r: MusicResult) => void; reject: (e: Error) => void; req: [MusicParams, number, RenderMode] };

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

async function renderHere(params: MusicParams, seed: number, mode: RenderMode) {
  const { renderMusic } = await import('./render');
  return renderMusic(params, seed, mode);
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; res?: MusicResult; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.res) p.resolve(e.data.res);
      else p.reject(new Error(e.data.error ?? 'render failed'));
    };
    // The worker script failed to load: render everything (including what was queued) here instead.
    w.onerror = (e) => {
      e.preventDefault();
      console.warn('Music worker unavailable; rendering on the main thread.', e.message);
      worker = null;
      w.terminate();
      const queued = [...pending.values()];
      pending.clear();
      for (const p of queued) renderHere(...p.req).then(p.resolve, p.reject);
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Render a composition: the mix, one stem (`params.stem`), or the mix and every stem. */
export function renderMusicAsync(params: MusicParams, seed: number, mode: RenderMode): Promise<MusicResult> {
  const w = getWorker();
  if (!w) return renderHere(params, seed, mode);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, req: [params, seed, mode] });
    w.postMessage({ id, params, seed, mode });
  });
}
