// Render a composition to mono audio: each track on its own (a stem), then the mix.
//
// Tails that ring past the end (releases, echoes, cymbals) are wrapped around to the start, so
// every piece loops seamlessly. The mix is normalized; stems are scaled by the same gain, so stems
// placed together in a scene keep the balance of the mix.
import { drumEvents, makePlan, noteEvents, type Plan } from './compose';
import { Biquad, KITS, synthHit, type DrumVoice } from './drums';
import { INSTRUMENTS, renderNote, type Timbre } from './instruments';
import { int, rngFor } from './rng';
import { MUSIC_RATE, musicDuration, type MusicParams, type TrackParams } from './types';

/** Seconds rendered past the end, then wrapped around to the start. */
const TAIL = 10;
const TARGET_PEAK = 0.708; // −3 dBFS, like the other synthesized sounds

export interface MusicResult {
  sampleRate: number;
  mix: Float32Array | null;
  stems: Record<string, Float32Array>;
}

/** What to render: the mix, one stem (`params.stem`), or everything. */
export type RenderMode = 'mix' | 'stem' | 'all';

/** Mix gain per piece, so a stem can be rendered alone at the level it has in the mix. */
const mixGain = new Map<string, number>();
const pieceKey = (p: MusicParams, seed: number) => JSON.stringify({ ...p, stem: undefined, seed });

const dbToGain = (db: number) => Math.pow(10, db / 20);

function renderTrack(p: MusicParams, plan: Plan, tr: TrackParams, seed: number, sr: number, len: number) {
  const ext = new Float32Array(len + Math.ceil(TAIL * sr));
  if (tr.role === 'drums') {
    const kit = KITS[tr.instrument] ?? KITS.k808;
    const cache = new Map<DrumVoice, Float32Array[]>();
    const r = rngFor(seed, tr.id, tr.salt, 'hits');
    for (const ev of drumEvents(p, plan, tr, seed)) {
      const h = kit.voices[ev.voice];
      if (!h) continue;
      let variants = cache.get(ev.voice);
      if (!variants) {
        variants = [0, 1, 2].map((k) => synthHit(h, sr, rngFor(seed, tr.instrument, ev.voice, k)));
        cache.set(ev.voice, variants);
      }
      const d = variants[int(r, 0, 2)];
      const s0 = Math.round(ev.t * sr);
      const g = Math.pow(ev.vel, 1.3) * 0.5;
      for (let i = 0; i < d.length && s0 + i < ext.length; i++) ext[s0 + i] += d[i] * g;
    }
    // Brightness as a low-pass (and the kit's own lo-fi treatment), then drive.
    const fc = Math.min(kit.lowpass ?? Infinity, 900 * Math.pow(2, tr.bright * 5));
    if (fc < sr * 0.42) {
      const lp1 = new Biquad('lp', fc, 0.7, sr);
      for (let i = 0; i < ext.length; i++) ext[i] = lp1.run(ext[i]);
    }
    if (kit.bits) {
      const q = Math.pow(2, kit.bits - 1);
      for (let i = 0; i < ext.length; i++) ext[i] = Math.round(ext[i] * q) / q;
    }
    if (tr.drive > 0.01) {
      const k = 1 + tr.drive * 6;
      const norm = 1 / Math.tanh(k);
      for (let i = 0; i < ext.length; i++) ext[i] = Math.tanh(ext[i] * k) * norm;
    }
  } else {
    const inst = INSTRUMENTS[tr.instrument] ?? INSTRUMENTS.piano;
    const tb: Timbre = { bright: tr.bright, attack: tr.attack, release: tr.release, detune: tr.detune, drive: tr.drive, vibrato: tr.vibrato, echo: tr.echo };
    const r = rngFor(seed, tr.id, tr.salt, 'voices');
    for (const ev of noteEvents(p, plan, tr, seed)) {
      renderNote(ext, Math.round(ev.t * sr), ev.dur, ev.midi, ev.vel, inst, tb, sr, r);
    }
  }
  if (tr.echo > 0.01) echo(ext, sr, plan.beat * 0.75, tr.echo);

  const g = dbToGain(tr.gainDb);
  const out = new Float32Array(len);
  for (let i = 0; i < ext.length; i++) out[i % len] += ext[i] * g;
  return out;
}

/** Tempo-synced feedback echo (dotted eighth), each repeat a little darker. */
function echo(x: Float32Array, sr: number, delay: number, amount: number) {
  const D = Math.max(1, Math.round(delay * sr));
  const fb = 0.3 + 0.35 * amount;
  const wet = amount * 0.6;
  const y = new Float32Array(x.length);
  let lp = 0;
  for (let i = D; i < x.length; i++) {
    lp += 0.4 * (x[i - D] + fb * y[i - D] - lp);
    y[i] = lp;
  }
  for (let i = 0; i < x.length; i++) x[i] += wet * y[i];
}

function peakOf(d: Float32Array) {
  let p = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > p) p = a;
  }
  return p;
}

export function renderMusic(p: MusicParams, seed: number, mode: RenderMode): MusicResult {
  const sr = MUSIC_RATE;
  const len = Math.max(1, Math.ceil(musicDuration(p) * sr));
  const plan = makePlan(p, seed);
  const key = pieceKey(p, seed);
  const playing = p.tracks.filter((t) => t.on);

  // A single stem whose mix level is known: render just that track.
  if (mode === 'stem' && p.stem && mixGain.has(key)) {
    const tr = playing.find((t) => t.id === p.stem);
    const d = tr ? renderTrack(p, plan, tr, seed, sr, len) : new Float32Array(len);
    const g = mixGain.get(key)!;
    for (let i = 0; i < len; i++) d[i] *= g;
    return { sampleRate: sr, mix: null, stems: { [p.stem]: d } };
  }

  const stems: Record<string, Float32Array> = {};
  const mix = new Float32Array(len);
  for (const tr of playing) {
    const d = renderTrack(p, plan, tr, seed, sr, len);
    for (let i = 0; i < len; i++) mix[i] += d[i];
    stems[tr.id] = d;
  }
  const pk = peakOf(mix);
  const g = pk > 1e-6 ? TARGET_PEAK / pk : 1;
  if (mixGain.size > 50) mixGain.clear();
  mixGain.set(key, g);
  for (let i = 0; i < len; i++) mix[i] *= g;
  if (mode === 'mix') return { sampleRate: sr, mix, stems: {} };
  // Disabled tracks have silent stems.
  for (const tr of p.tracks) {
    const d = stems[tr.id];
    if (d) for (let i = 0; i < len; i++) d[i] *= g;
    else stems[tr.id] = new Float32Array(len);
  }
  if (mode === 'stem') return { sampleRate: sr, mix: null, stems: { [p.stem!]: stems[p.stem!] ?? new Float32Array(len) } };
  return { sampleRate: sr, mix, stems };
}
