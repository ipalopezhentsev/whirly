// Main-thread side of the MP3 encoder: encodes in a worker, or here if workers are unavailable.

export const MP3_BITRATES = [96, 128, 160, 192, 256, 320] as const;
export const MP3_DEFAULT_KBPS = 192;

/** MP3 tops out at 48 kHz: the rate to render at for an MP3 when the audio device runs at `rate`. */
export const mp3SampleRate = (rate: number) => ([32000, 44100, 48000].includes(rate) ? rate : 48000);

async function encodeHere(chans: Float32Array[], sampleRate: number, kbps: number, onProgress?: (f: number) => void) {
  const { encodeMp3 } = await import('./mp3encode');
  return encodeMp3(chans, sampleRate, kbps, onProgress);
}

function encodeInWorker(chans: Float32Array[], sampleRate: number, kbps: number, onProgress?: (f: number) => void) {
  return new Promise<Uint8Array[]>((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./mp3worker.ts', import.meta.url), { type: 'module' });
    } catch {
      encodeHere(chans, sampleRate, kbps, onProgress).then(resolve, reject);
      return;
    }
    w.onmessage = (e: MessageEvent<{ progress?: number; parts?: Uint8Array[]; error?: string }>) => {
      if (e.data.progress !== undefined) return onProgress?.(e.data.progress);
      w.terminate();
      if (e.data.parts) resolve(e.data.parts);
      else reject(new Error(e.data.error ?? 'MP3 encoding failed'));
    };
    // The worker script failed to load: encode here instead (the samples were not transferred).
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      console.warn('MP3 worker unavailable; encoding on the main thread.', e.message);
      encodeHere(chans, sampleRate, kbps, onProgress).then(resolve, reject);
    };
    w.postMessage({ chans, sampleRate, kbps });
  });
}

/** Encode an AudioBuffer (mono or stereo, at an MP3 sample rate) as a constant-bitrate MP3 Blob. */
export async function encodeMp3Blob(buf: AudioBuffer, kbps: number, onProgress?: (f: number) => void): Promise<Blob> {
  const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c).slice());
  const parts = await encodeInWorker(chans, buf.sampleRate, kbps, onProgress);
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}
