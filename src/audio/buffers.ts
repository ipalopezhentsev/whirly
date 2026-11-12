// Edit operations on mono AudioBuffers. Every function returns a new buffer.
import type { Selection } from '../scene/types';
import { clamp, dbToGain } from './util';

export function makeBuffer(length: number, sampleRate: number, channels = 1) {
  return new AudioBuffer({ length: Math.max(1, length), sampleRate, numberOfChannels: channels });
}

export function fromData(data: Float32Array, sampleRate: number) {
  const b = makeBuffer(data.length, sampleRate);
  b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
  return b;
}

const data = (b: AudioBuffer) => b.getChannelData(0);
const copy = (b: AudioBuffer) => new Float32Array(data(b));

/** Sample range [a, b) for a selection in seconds (whole buffer if none). */
export function sampleRange(buf: AudioBuffer, sel?: Selection | null): [number, number] {
  if (!sel) return [0, buf.length];
  const a = clamp(Math.round(sel.start * buf.sampleRate), 0, buf.length);
  const b = clamp(Math.round(sel.end * buf.sampleRate), 0, buf.length);
  return b - a < 2 ? [0, buf.length] : [a, b];
}

export function toMono(buf: AudioBuffer) {
  if (buf.numberOfChannels === 1) return buf;
  const out = new Float32Array(buf.length);
  const n = buf.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / n;
  }
  return fromData(out, buf.sampleRate);
}

export function peak(buf: AudioBuffer) {
  const d = data(buf);
  let p = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > p) p = a;
  }
  return p;
}

export function normalize(buf: AudioBuffer, targetDb = -1) {
  const p = peak(buf);
  if (p < 1e-9) return buf;
  const g = dbToGain(targetDb) / p;
  const d = copy(buf);
  for (let i = 0; i < d.length; i++) d[i] *= g;
  return fromData(d, buf.sampleRate);
}

export function applyGain(buf: AudioBuffer, db: number, sel?: Selection | null) {
  const [a, b] = sampleRange(buf, sel);
  const g = dbToGain(db);
  const d = copy(buf);
  for (let i = a; i < b; i++) d[i] = clamp(d[i] * g, -1, 1);
  return fromData(d, buf.sampleRate);
}

export function reverse(buf: AudioBuffer, sel?: Selection | null) {
  const [a, b] = sampleRange(buf, sel);
  const d = copy(buf);
  d.subarray(a, b).reverse();
  return fromData(d, buf.sampleRate);
}

export function crop(buf: AudioBuffer, sel?: Selection | null) {
  const [a, b] = sampleRange(buf, sel);
  return fromData(data(buf).slice(a, b), buf.sampleRate);
}

export function removeRange(buf: AudioBuffer, sel?: Selection | null) {
  const [a, b] = sampleRange(buf, sel);
  if (a === 0 && b === buf.length) return buf;
  const d = data(buf);
  const out = new Float32Array(d.length - (b - a));
  out.set(d.subarray(0, a));
  out.set(d.subarray(b), a);
  return fromData(out, buf.sampleRate);
}

export function silence(buf: AudioBuffer, sel?: Selection | null) {
  const [a, b] = sampleRange(buf, sel);
  const d = copy(buf);
  d.fill(0, a, b);
  return fromData(d, buf.sampleRate);
}

const defaultFadeLen = (buf: AudioBuffer) => Math.min(Math.floor(buf.length * 0.2), buf.sampleRate);

export function fadeIn(buf: AudioBuffer, sel?: Selection | null) {
  const [a, b] = sel ? sampleRange(buf, sel) : [0, defaultFadeLen(buf)];
  const d = copy(buf);
  const n = Math.max(1, b - a);
  for (let i = a; i < b; i++) d[i] *= Math.sin((((i - a) / n) * Math.PI) / 2) ** 2;
  return fromData(d, buf.sampleRate);
}

export function fadeOut(buf: AudioBuffer, sel?: Selection | null) {
  const [a, b] = sel ? sampleRange(buf, sel) : [buf.length - defaultFadeLen(buf), buf.length];
  const d = copy(buf);
  const n = Math.max(1, b - a);
  for (let i = a; i < b; i++) d[i] *= Math.cos((((i - a) / n) * Math.PI) / 2) ** 2;
  return fromData(d, buf.sampleRate);
}

/** Short fades at both edges to avoid clicks. */
export function edgeFade(buf: AudioBuffer, sec = 0.005) {
  const n = Math.min(Math.floor(sec * buf.sampleRate), Math.floor(buf.length / 2));
  const d = copy(buf);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    d[i] *= g;
    d[d.length - 1 - i] *= g;
  }
  return fromData(d, buf.sampleRate);
}

/** Cut leading/trailing audio quieter than `thresholdDb` relative to the peak. */
export function trimSilence(buf: AudioBuffer, thresholdDb = -45) {
  const d = data(buf);
  const thr = dbToGain(thresholdDb) * Math.max(peak(buf), 1e-6);
  let a = 0;
  let b = d.length - 1;
  while (a < d.length && Math.abs(d[a]) < thr) a++;
  while (b > a && Math.abs(d[b]) < thr) b--;
  if (a >= b) return buf;
  const pad = Math.floor(0.01 * buf.sampleRate);
  return fromData(d.slice(Math.max(0, a - pad), Math.min(d.length, b + pad)), buf.sampleRate);
}

/**
 * Make a buffer loop seamlessly: the tail is cross-faded into the head so the last
 * sample flows straight into the first. Shortens the buffer by `sec`.
 */
export function loopCrossfade(buf: AudioBuffer, sec = 0.05) {
  const d = data(buf);
  const n = Math.min(Math.floor(sec * buf.sampleRate), Math.floor(d.length / 2));
  if (n < 2) return buf;
  const out = new Float32Array(d.length - n);
  out.set(d.subarray(0, d.length - n));
  for (let i = 0; i < n; i++) {
    const x = ((i / n) * Math.PI) / 2;
    out[i] = d[i] * Math.sin(x) + d[d.length - n + i] * Math.cos(x);
  }
  return fromData(out, buf.sampleRate);
}

/** Resample by playback rate (speed and pitch change together, like tape). */
export async function changeSpeed(buf: AudioBuffer, rate: number) {
  const len = Math.max(1, Math.ceil(buf.length / rate));
  const ctx = new OfflineAudioContext(1, len, buf.sampleRate);
  const s = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
  s.connect(ctx.destination);
  s.start();
  return ctx.startRendering();
}
