// Base-sound generators. Each preset renders offline into a normalized mono AudioBuffer.
import { fromData, normalize, loopCrossfade, edgeFade } from './buffers';
import { TAU } from './util';
import { renderSpeech, type SpeechParams } from './speech';
import * as amb from './ambience';
import { renderMusicAsync } from './music/client';
import type { MusicParams } from './music/types';

/** Random source for the generators. `renderPreset` swaps in a seeded one so a render can be repeated exactly. */
let random = Math.random;

/** Small seeded PRNG (mulberry32). */
function seeded(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const newSeed = () => (Math.random() * 2 ** 32) >>> 0;

const rand = (a: number, b: number) => a + random() * (b - a);
const pick = <T,>(arr: T[]) => arr[Math.floor(random() * arr.length)];

export type NoiseColor = 'white' | 'pink' | 'brown';

export function noiseData(len: number, color: NoiseColor = 'white') {
  const d = new Float32Array(len);
  if (color === 'pink') {
    // Paul Kellet's refined pink-noise filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
  } else {
    for (let i = 0; i < len; i++) d[i] = random() * 2 - 1;
  }
  return d;
}

function noiseBuffer(ctx: BaseAudioContext, dur: number, color: NoiseColor) {
  const len = Math.max(1, Math.ceil(dur * ctx.sampleRate));
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  b.copyToChannel(noiseData(len, color), 0);
  return b;
}

function lfo(ctx: BaseAudioContext, frequency: number, depth: number, target: AudioParam, type: OscillatorType = 'sine') {
  const o = new OscillatorNode(ctx, { type, frequency });
  const g = new GainNode(ctx, { gain: depth });
  o.connect(g).connect(target);
  o.start();
  return o;
}

function gate(param: AudioParam, t: number, attack: number, hold: number, release: number, peak = 1) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + attack + hold);
  param.linearRampToValueAtTime(0, t + attack + hold + release);
}

function strike(param: AudioParam, t: number, peak: number, attack: number, tau: number) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, tau);
}

// ---------------------------------------------------------------- custom synth

export interface NumberSpec {
  label: string;
  min: number;
  max: number;
  step?: number;
  def: number;
  log?: boolean;
  unit?: string;
}
export interface SelectSpec {
  label: string;
  options: string[];
  def: string;
}

export interface CustomParams {
  wave: OscillatorType | NoiseColor;
  filter: 'none' | BiquadFilterType;
  freq: number;
  freqEnd: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  repeat: number;
  gate: number;
  cutoff: number;
  q: number;
  vibRate: number;
  vibDepth: number;
  tremRate: number;
  tremDepth: number;
}

export const CUSTOM_SELECTS: Record<'wave' | 'filter', SelectSpec> = {
  wave: { label: 'Waveform', options: ['sine', 'triangle', 'square', 'sawtooth', 'white', 'pink', 'brown'], def: 'sawtooth' },
  filter: { label: 'Filter', options: ['none', 'lowpass', 'highpass', 'bandpass'], def: 'lowpass' },
};

export const CUSTOM_NUMBERS: Record<Exclude<keyof CustomParams, 'wave' | 'filter'>, NumberSpec> = {
  freq: { label: 'Pitch start', min: 20, max: 8000, def: 220, log: true, unit: 'Hz' },
  freqEnd: { label: 'Pitch end', min: 20, max: 8000, def: 220, log: true, unit: 'Hz' },
  attack: { label: 'Attack', min: 0, max: 2, step: 0.005, def: 0.01, unit: 's' },
  decay: { label: 'Decay', min: 0, max: 2, step: 0.005, def: 0.2, unit: 's' },
  sustain: { label: 'Sustain', min: 0, max: 1, step: 0.01, def: 0.7 },
  release: { label: 'Release', min: 0, max: 3, step: 0.005, def: 0.3, unit: 's' },
  repeat: { label: 'Repeat every', min: 0, max: 4, step: 0.05, def: 0, unit: 's' },
  gate: { label: 'Note length', min: 0.05, max: 1, step: 0.01, def: 0.5, unit: '×' },
  cutoff: { label: 'Cutoff', min: 40, max: 18000, def: 2400, log: true, unit: 'Hz' },
  q: { label: 'Resonance', min: 0.1, max: 20, step: 0.1, def: 1 },
  vibRate: { label: 'Vibrato rate', min: 0, max: 20, step: 0.1, def: 5, unit: 'Hz' },
  vibDepth: { label: 'Vibrato depth', min: 0, max: 200, step: 1, def: 0, unit: 'ct' },
  tremRate: { label: 'Tremolo rate', min: 0, max: 30, step: 0.1, def: 6, unit: 'Hz' },
  tremDepth: { label: 'Tremolo depth', min: 0, max: 1, step: 0.01, def: 0 },
};

export function customDefaults(): CustomParams {
  const n = Object.fromEntries(Object.entries(CUSTOM_NUMBERS).map(([k, s]) => [k, s.def]));
  return { ...n, wave: CUSTOM_SELECTS.wave.def, filter: CUSTOM_SELECTS.filter.def } as CustomParams;
}

function renderCustom(ctx: BaseAudioContext, out: AudioNode, dur: number, p: CustomParams) {
  const isNoise = p.wave === 'white' || p.wave === 'pink' || p.wave === 'brown';
  let src: AudioScheduledSourceNode;
  let osc: OscillatorNode | null = null;
  if (isNoise) {
    src = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx, dur, p.wave as NoiseColor) });
  } else {
    osc = new OscillatorNode(ctx, { type: p.wave as OscillatorType, frequency: p.freq });
    if (p.vibDepth > 0 && p.vibRate > 0) lfo(ctx, p.vibRate, p.vibDepth, osc.detune);
    src = osc;
  }
  let node: AudioNode = src;
  if (p.filter !== 'none') {
    const f = new BiquadFilterNode(ctx, { type: p.filter, frequency: p.cutoff, Q: p.q });
    node.connect(f);
    node = f;
  }
  const trem = new GainNode(ctx, { gain: 1 - p.tremDepth / 2 });
  if (p.tremDepth > 0 && p.tremRate > 0) lfo(ctx, p.tremRate, p.tremDepth / 2, trem.gain);
  const amp = new GainNode(ctx, { gain: 0 });
  node.connect(trem).connect(amp).connect(out);

  const notes: number[] = [];
  if (p.repeat > 0) for (let t = 0; t < dur - 0.01; t += p.repeat) notes.push(t);
  else notes.push(0);

  for (const t0 of notes) {
    let noteLen: number;
    let rel: number;
    if (p.repeat > 0) {
      noteLen = Math.max(0.01, p.repeat * p.gate);
      rel = Math.max(0.002, Math.min(p.release, p.repeat - noteLen - 0.002));
    } else {
      rel = Math.min(p.release, dur * 0.5);
      noteLen = Math.max(0.01, dur - rel);
    }
    const tOff = t0 + noteLen;
    let a = Math.max(0.002, p.attack);
    let d = p.decay;
    const room = noteLen - 0.002;
    if (a + d > room) {
      const k = room / (a + d);
      a *= k;
      d *= k;
    }
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(1, t0 + a);
    amp.gain.linearRampToValueAtTime(p.sustain, t0 + a + d);
    amp.gain.setValueAtTime(p.sustain, tOff);
    amp.gain.linearRampToValueAtTime(0, tOff + rel);
    if (osc) {
      osc.frequency.setValueAtTime(p.freq, t0);
      osc.frequency.exponentialRampToValueAtTime(p.freqEnd, tOff);
    }
  }
  src.start();
}

// ---------------------------------------------------------------- presets

export interface Preset {
  label: string;
  /** Default duration in seconds. */
  dur: number;
  /** Continuous sound: the render is made seamlessly loopable. */
  loop?: boolean;
  /** The generator's output already loops exactly, so it is used as is. For rhythmic sounds: the usual
   *  loop cross-fade drops 0.1 s, which would cut a beat short and fade out a hit at the start. */
  seamless?: boolean;
  /** Peak level the render is normalized to, in dB (default −3). Lower for sounds that are all body
   *  and no peaks, such as steady hiss, which would otherwise come out far louder than the rest. */
  level?: number;
  render?: (ctx: BaseAudioContext, out: AudioNode, dur: number, params: CustomParams) => void;
  js?: (sr: number, dur: number, len: number) => Float32Array;
  /** Speaks text instead, when the recipe has some. */
  speech?: boolean;
  /** Algorithmic composition, rendered from the recipe's `music` settings (see ./music). */
  music?: boolean;
}

export const PRESETS: Record<string, Preset> = {
  beeps: {
    label: 'Beeps (1 kHz)', dur: 4,
    render(ctx, out, dur) {
      const o = new OscillatorNode(ctx, { frequency: 1000 });
      const g = new GainNode(ctx, { gain: 0 });
      o.connect(g).connect(out);
      for (let t = 0.01; t + 0.15 < dur; t += 0.5) gate(g.gain, t, 0.005, 0.11, 0.015);
      o.start();
    },
  },
  noise: {
    label: 'Pink-noise bursts', dur: 4,
    render(ctx, out, dur) {
      const s = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx, dur, 'pink') });
      const g = new GainNode(ctx, { gain: 0 });
      s.connect(g).connect(out);
      for (let t = 0.01; t + 0.25 < dur; t += 0.6) gate(g.gain, t, 0.005, 0.2, 0.02);
      s.start();
    },
  },
  bee: {
    label: 'Buzzing bee', dur: 6, loop: true,
    render(ctx, out) {
      const o = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 215 });
      for (const [f, a] of [[6.3, 9], [0.9, 18], [13.7, 4]]) lfo(ctx, f, a, o.frequency);
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1100, Q: 0.9 });
      const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 150 });
      const amp = new GainNode(ctx, { gain: 0.7 });
      lfo(ctx, 21, 0.15, amp.gain);
      lfo(ctx, 0.37, 0.2, amp.gain);
      o.connect(bp).connect(hp).connect(amp).connect(out);
      o.start();
    },
  },
  birds: {
    label: 'Bird chirps', dur: 8,
    render(ctx, out, dur) {
      const o = new OscillatorNode(ctx, { frequency: 3000 });
      const g = new GainNode(ctx, { gain: 0 });
      lfo(ctx, 31, 120, o.frequency);
      o.connect(g).connect(out);
      let t = 0.1;
      while (t < dur - 0.5) {
        const n = 2 + Math.floor(rand(0, 5));
        const base = rand(2500, 4500);
        for (let k = 0; k < n && t < dur - 0.3; k++) {
          const len = rand(0.05, 0.12);
          const lo = base * rand(0.8, 1.1);
          const hi = base * rand(1.2, 1.7);
          const up = random() < 0.5;
          o.frequency.setValueAtTime(up ? lo : hi, t);
          o.frequency.exponentialRampToValueAtTime(up ? hi : lo, t + len);
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.8, t + 0.008);
          g.gain.linearRampToValueAtTime(0, t + len);
          t += len + rand(0.03, 0.09);
        }
        t += rand(0.4, 1.4);
      }
      o.start();
    },
  },
  siren: {
    label: 'Siren (wail)', dur: 6, loop: true,
    render(ctx, out) {
      const o = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 950 });
      lfo(ctx, 1 / 3, 350, o.frequency);
      const f = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2500, Q: 1 });
      o.connect(f).connect(out);
      o.start();
    },
  },
  engine: {
    label: 'Car engine', dur: 6, loop: true,
    render(ctx, out, dur) {
      const base = 48;
      const o1 = new OscillatorNode(ctx, { type: 'sawtooth', frequency: base });
      const o2 = new OscillatorNode(ctx, { type: 'square', frequency: base / 2 });
      lfo(ctx, 0.4, 2.5, o1.frequency);
      lfo(ctx, 0.4, 1.25, o2.frequency);
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 520, Q: 3 });
      const n = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx, dur, 'brown') });
      o1.connect(new GainNode(ctx, { gain: 0.5 })).connect(lp);
      o2.connect(new GainNode(ctx, { gain: 0.3 })).connect(lp);
      n.connect(new GainNode(ctx, { gain: 0.5 })).connect(lp);
      lp.connect(out);
      o1.start();
      o2.start();
      n.start();
    },
  },
  helicopter: {
    label: 'Helicopter', dur: 6, loop: true,
    js(sr, _dur, len) {
      const d = new Float32Array(len);
      let lp = 0;
      let br = 0;
      const slapRate = 12;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const ph = (t * slapRate) % 1;
        const slap = Math.exp(-ph * 14);
        const w = random() * 2 - 1;
        lp += 0.12 * (w - lp);
        br = (br + 0.02 * w) / 1.02;
        d[i] = 1.6 * lp * slap + 0.5 * Math.sin(TAU * 55 * t) * slap + br + 0.03 * Math.sin(TAU * 1150 * t);
      }
      return d;
    },
  },
  footsteps: {
    label: 'Footsteps', dur: 6,
    render(ctx, out, dur) {
      // Hard soles on stone: heel strike, then a brighter toe/scuff. High-passed so they stay light.
      const nb = noiseBuffer(ctx, 1, 'white');
      const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 250, Q: 0.7 });
      hp.connect(out);
      let i = 0;
      for (let t = 0.05; t < dur - 0.3; t += 0.52 + rand(-0.04, 0.04), i++) {
        const foot = i % 2 ? 1.08 : 0.94; // left and right shoes sound slightly different
        for (const [off, f, a, tau] of [[0, 2400, 1, 0.022], [0.06 + rand(-0.01, 0.01), 4800, 0.5, 0.015]]) {
          const s = new AudioBufferSourceNode(ctx, { buffer: nb });
          const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: f * foot * rand(0.9, 1.1), Q: 0.9 });
          const g = new GainNode(ctx, { gain: 0 });
          strike(g.gain, t + off, a * rand(0.8, 1), 0.002, tau);
          s.connect(lp).connect(g).connect(hp);
          s.start(t + off, rand(0, 0.7), 0.2);
        }
      }
    },
  },
  gunfire: {
    label: 'Automatic gunfire (random bursts)', dur: 8,
    js(sr, dur, len) {
      const d = new Float32Array(len);
      // One-pole low-pass coefficient for a cutoff, so the timbre doesn't depend on the sample rate.
      const k = (fc: number) => 1 - Math.exp(-TAU * fc / sr);
      const kBody = k(3000);
      const kTail = k(500);
      const kClick = k(6000);
      const shot = (t0: number, amp: number, bright: number) => {
        const s0 = Math.floor(t0 * sr);
        const n = Math.min(len - s0, Math.floor(0.4 * sr));
        const f0 = rand(65, 90);
        const clickAt = rand(0.018, 0.026); // the bolt cycling, just after the report
        let body = 0, tail = 0, click = 0, ph = 0;
        for (let j = 0; j < n; j++) {
          const t = j / sr;
          const w = random() * 2 - 1;
          body += kBody * (w - body);
          tail += kTail * (w - tail);
          // Muzzle report: a raw-noise crack, a mid-band blast and a falling low thump.
          const crack = w * Math.exp(-t / 0.0025) * bright;
          const blast = body * Math.exp(-t / 0.035) * 2.2;
          ph += TAU * f0 * (1 + 1.8 * Math.exp(-t / 0.008)) / sr;
          const thump = Math.sin(ph) * Math.exp(-t / 0.05) * 0.8;
          // A darker rumble that rings on, overlapping the next shots in a burst.
          const rumble = tail * Math.exp(-t / 0.14) * 3;
          let mech = 0;
          if (t > clickAt) {
            click += kClick * (w - click);
            mech = (w - click) * Math.exp(-(t - clickAt) / 0.0015) * 0.12;
          }
          d[s0 + j] += amp * (crack + blast + thump + rumble + mech);
        }
      };
      // One weapon per render: its cyclic rate stays put, the bursts (length, gaps) are random.
      const period = 60 / rand(600, 900);
      let t = rand(0.05, 0.4);
      while (t < dur - 0.3) {
        const r = random();
        const shots = r < 0.15 ? 1 + Math.floor(rand(0, 2)) // single or double tap
          : r < 0.75 ? 3 + Math.floor(rand(0, 5)) // short burst
          : 8 + Math.floor(rand(0, 18)); // long burst
        const p = period * rand(0.97, 1.03);
        for (let i = 0; i < shots && t < dur - 0.3; i++) {
          shot(t, rand(0.8, 1), rand(0.8, 1.2));
          t += p * rand(0.96, 1.04);
        }
        t += rand(0.3, 2.2);
      }
      // Gentle saturation squashes the overlapping tails into a denser, punchier burst.
      for (let i = 0; i < len; i++) d[i] = Math.tanh(d[i] * 0.8);
      return d;
    },
  },
  voice: {
    label: 'Synthetic voice (text or babble)', dur: 8, speech: true,
    render(ctx, out, dur) {
      const V: Record<string, number[]> = {
        a: [730, 1090, 2440], e: [530, 1840, 2480], i: [270, 2290, 3010], o: [570, 840, 2410], u: [300, 870, 2240],
      };
      const src = new OscillatorNode(ctx, { type: 'sawtooth', frequency: 125 });
      lfo(ctx, 5.5, 3, src.frequency);
      const amp = new GainNode(ctx, { gain: 0 });
      const formants = [0, 1, 2].map((k) => {
        const f = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: V.a[k], Q: [8, 10, 12][k] });
        src.connect(f).connect(new GainNode(ctx, { gain: [1, 0.6, 0.3][k] })).connect(amp);
        return f;
      });
      const nz = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer(ctx, dur, 'white') });
      const ng = new GainNode(ctx, { gain: 0 });
      nz.connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 4000 })).connect(ng).connect(out);
      amp.connect(out);

      let t = 0.1;
      let inPhrase = 0;
      while (t < dur - 0.4) {
        const len = rand(0.12, 0.3);
        const v = pick(Object.keys(V));
        if (random() < 0.4) gate(ng.gain, t - 0.07, 0.01, 0.04, 0.02, 0.25);
        formants.forEach((f, k) => f.frequency.setTargetAtTime(V[v][k], t, 0.02));
        src.frequency.setTargetAtTime(rand(105, 150), t, 0.06);
        amp.gain.setTargetAtTime(1, t, 0.02);
        amp.gain.setTargetAtTime(0, t + len, 0.03);
        t += len + rand(0.06, 0.14);
        if (++inPhrase > 3 + random() * 5) {
          inPhrase = 0;
          t += rand(0.35, 0.8);
        }
      }
      src.start();
      nz.start();
    },
  },
  bell: {
    label: 'Bell (FM)', dur: 5,
    render(ctx, out, dur) {
      const fc = 523;
      for (let t = 0.02; t < dur - 0.2; t += 2.5) {
        const car = new OscillatorNode(ctx, { frequency: fc });
        const mod = new OscillatorNode(ctx, { frequency: fc * 1.4 });
        const mg = new GainNode(ctx, { gain: 0 });
        mod.connect(mg).connect(car.frequency);
        strike(mg.gain, t, fc * 3, 0.001, 0.6);
        const ag = new GainNode(ctx, { gain: 0 });
        strike(ag.gain, t, 0.8, 0.002, 0.9);
        car.connect(ag).connect(out);
        car.start(t);
        mod.start(t);
        car.stop(t + 6);
        mod.stop(t + 6);
      }
    },
  },
  // Ambiences (see ./ambience). `random` is read at call time, so a seeded render stays seeded.
  rain: { label: 'Rain', dur: 10, loop: true, js: (sr, dur, len) => amb.rain(sr, dur, len, random) },
  stream: { label: 'Stream (babbling brook)', dur: 10, loop: true, js: (sr, dur, len) => amb.stream(sr, dur, len, random) },
  sea: { label: 'Sea waves', dur: 16, loop: true, seamless: true, js: (sr, dur, len) => amb.sea(sr, dur, len, random) },
  wind: { label: 'Wind (gusty)', dur: 12, loop: true, js: (sr, dur, len) => amb.wind(sr, dur, len, random) },
  crowd: { label: 'Crowd murmur', dur: 12, loop: true, js: (sr, dur, len) => amb.crowd(sr, dur, len, random) },
  train: { label: 'Train (clickety-clack)', dur: 12, loop: true, seamless: true, js: (sr, dur, len) => amb.train(sr, dur, len, random) },
  factory: { label: 'Factory floor', dur: 12, loop: true, seamless: true, js: (sr, dur, len) => amb.factory(sr, dur, len, random) },
  fire: { label: 'Fire (crackling)', dur: 10, loop: true, js: (sr, dur, len) => amb.fire(sr, dur, len, random) },
  vinyl: { label: 'Vinyl crackle', dur: 9, loop: true, seamless: true, js: (sr, dur, len) => amb.vinyl(sr, dur, len, random) },
  tape: { label: 'Tape hiss', dur: 6, loop: true, level: -20, js: (sr, dur, len) => amb.tape(sr, dur, len, random) },
  thunder: { label: 'Thunder (storm)', dur: 10, js: (sr, dur, len) => amb.thunder(sr, dur, len, random) },
  mosquito: { label: 'Mosquito', dur: 6, loop: true, js: (sr, dur, len) => amb.mosquito(sr, dur, len, random) },
  drone: {
    label: 'Chord pad', dur: 8, loop: true,
    render(ctx, out) {
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 900, Q: 2 });
      lfo(ctx, 0.15, 500, lp.frequency);
      lp.connect(out);
      for (const f of [110, 164.81, 220, 277.18]) {
        for (const detune of [-7, 7]) {
          const o = new OscillatorNode(ctx, { type: 'sawtooth', frequency: f, detune });
          o.connect(new GainNode(ctx, { gain: 0.12 })).connect(lp);
          o.start();
        }
      }
    },
  },
  tick: { label: 'Clock tick-tock', dur: 4, loop: true, seamless: true, js: (sr, dur, len) => amb.clock(sr, dur, len, random) },
  custom: { label: 'Custom synth…', dur: 2, render: renderCustom },
  music: { label: 'Algorithmic music', dur: 60, music: true },
};

/**
 * Render a preset to a normalized mono AudioBuffer. With a `seed`, the same arguments give the
 * same sound every time (that is how share links rebuild synthesized sounds).
 */
export async function renderPreset(
  key: string, dur: number, sampleRate: number, params: CustomParams = customDefaults(), seed?: number,
  speech?: SpeechParams, music?: MusicParams,
) {
  const p = PRESETS[key];
  if (!p) throw new Error(`Unknown preset “${key}”`);
  if (p.music) {
    // Already loopable (tails wrap around) and normalized at the level of the whole mix, so a stem
    // keeps its balance with the other stems. Rendered at its own sample rate.
    if (!music) throw new Error('Missing music settings');
    const res = await renderMusicAsync(music, seed ?? 0, music.stem ? 'stem' : 'mix');
    return fromData((music.stem ? res.stems[music.stem] : res.mix)!, res.sampleRate);
  }
  const len = Math.max(1, Math.ceil(dur * sampleRate));
  let data: Float32Array | undefined;
  let ctx: OfflineAudioContext | undefined;
  // All random numbers are drawn synchronously here, before the first await, so concurrent
  // renders can't interleave their draws.
  const prev = random;
  if (seed !== undefined) random = seeded(seed);
  try {
    if (p.speech && speech?.text.trim()) {
      data = renderSpeech(speech, sampleRate, len, random);
    } else if (p.js) {
      data = p.js(sampleRate, dur, len);
    } else {
      ctx = new OfflineAudioContext(1, len, sampleRate);
      const out = new GainNode(ctx);
      out.connect(ctx.destination);
      p.render!(ctx, out, dur, params);
    }
  } finally {
    random = prev;
  }
  data ??= (await ctx!.startRendering()).getChannelData(0);
  let buf = fromData(data, sampleRate);
  if (!p.seamless) buf = p.loop && dur > 0.5 ? loopCrossfade(buf, Math.min(0.1, dur * 0.1)) : edgeFade(buf);
  return normalize(buf, p.level ?? -3);
}
