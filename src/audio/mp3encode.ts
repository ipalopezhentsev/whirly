// MP3 encoding with LAME (pure JS). Runs in mp3worker.ts, or on the main thread as a fallback.
import { Mp3Encoder } from '@breezystack/lamejs';

/** Samples per MP3 frame; encoding in multiples of it keeps the encoder's buffers small. */
const FRAME = 1152;

const toInt16 = (src: Float32Array, from: number, to: number) => {
  const out = new Int16Array(to - from);
  for (let i = from; i < to; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    out[i - from] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
};

/**
 * Encode one or two channels of audio (sample rate one MP3 allows: 32, 44.1 or 48 kHz and lower)
 * to MP3 frames at a constant `kbps`. `onProgress` gets the fraction done, 0 … 1.
 */
export function encodeMp3(chans: Float32Array[], sampleRate: number, kbps: number, onProgress?: (f: number) => void) {
  const stereo = chans.length > 1;
  const enc = new Mp3Encoder(stereo ? 2 : 1, sampleRate, kbps);
  const len = chans[0].length;
  const step = FRAME * 32;
  const parts: Uint8Array[] = [];
  let reported = 0;
  for (let i = 0; i < len; i += step) {
    const end = Math.min(len, i + step);
    const l = toInt16(chans[0], i, end);
    const out = stereo ? enc.encodeBuffer(l, toInt16(chans[1], i, end)) : enc.encodeBuffer(l);
    if (out.length) parts.push(out.slice());
    if (onProgress && end - reported >= sampleRate) {
      reported = end;
      onProgress(end / len);
    }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(tail.slice());
  return parts;
}
