// Renders compositions off the main thread.
import { renderMusic, type RenderMode } from './render';
import type { MusicParams } from './types';

interface Req {
  id: number;
  params: MusicParams;
  seed: number;
  mode: RenderMode;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, params, seed, mode } = e.data;
  try {
    const res = renderMusic(params, seed, mode);
    const transfer = [res.mix, ...Object.values(res.stems)].filter((d): d is Float32Array => !!d).map((d) => d.buffer);
    (self as unknown as Worker).postMessage({ id, res }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message ?? String(err) });
  }
};
