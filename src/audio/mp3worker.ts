// Encodes MP3 off the main thread, so a long mix doesn't freeze the UI.
import { encodeMp3 } from './mp3encode';

interface Req {
  chans: Float32Array[];
  sampleRate: number;
  kbps: number;
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<Req>) => {
  const { chans, sampleRate, kbps } = e.data;
  try {
    const parts = encodeMp3(chans, sampleRate, kbps, (progress) => post({ progress }));
    post({ parts }, parts.map((p) => p.buffer as ArrayBuffer));
  } catch (err) {
    post({ error: (err as Error).message ?? String(err) });
  }
};
