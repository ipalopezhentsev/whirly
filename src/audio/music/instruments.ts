// Pitched instruments, synthesized note by note in plain JS (no Web Audio), so a render is exact,
// repeatable and can run in a worker. Four engines cover the sounds:
//   sub   — subtractive: band-limited oscillators (unison), resonant low-pass with envelope
//   fm    — two-operator FM plus an optional second modulator (electric piano tines, bells, basses)
//   add   — additive partials, each decaying at its own rate (piano, mallets, bells, organ)
//   pluck — Karplus–Strong plucked string
import type { Rng } from './rng';

export interface Timbre {
  bright: number;
  attack: number;
  release: number;
  detune: number;
  drive: number;
  vibrato: number;
  echo: number;
}

type Wave = 'saw' | 'square' | 'pulse' | 'tri' | 'sine';
type Overtone = [ratio: number, amp: number, decay: number];

export interface InstrumentDef {
  label: string;
  group: 'Keys' | 'Mallets & bells' | 'Strings' | 'Synths' | 'Bass';
  engine: 'sub' | 'fm' | 'add' | 'pluck';
  def: Timbre;
  /** Loudness trim. */
  level?: number;
  /** 0: struck — the note dies away over `release`. Otherwise the level held while the note is down. */
  sustain?: number;
  /** Attack → sustain fall time (s). */
  decay?: number;
  /** Struck notes are cut short when the note ends (piano damper, palm-muted string). */
  damp?: boolean;
  // sub
  wave?: Wave;
  width?: number;
  unison?: number;
  wave2?: Wave;
  ratio2?: number;
  mix2?: number;
  noise?: number;
  res?: number;
  /** Filter envelope depth in octaves. */
  env?: number;
  envDecay?: number;
  // fm
  ratio?: number;
  index?: number;
  indexDecay?: number;
  ratioB?: number;
  indexB?: number;
  decayB?: number;
  // add
  partials?: Overtone[];
  inharm?: number;
  hammer?: number;
}

const T = (bright: number, attack: number, release: number, extra: Partial<Timbre> = {}): Timbre => ({
  bright, attack, release, detune: 0, drive: 0, vibrato: 0, echo: 0, ...extra,
});

const harmonic = (n: number, tilt: number, decayTilt: number): Overtone[] =>
  Array.from({ length: n }, (_, i) => [i + 1, 1 / Math.pow(i + 1, tilt), 1 / Math.pow(i + 1, decayTilt)]);

export const INSTRUMENTS: Record<string, InstrumentDef> = {
  piano: {
    label: 'Soft piano', group: 'Keys', engine: 'add', damp: true, hammer: 0.15, inharm: 0.0004, level: 1.1,
    partials: harmonic(9, 1.1, 0.7), def: T(0.5, 0.002, 4, { echo: 0.1 }),
  },
  epiano: {
    label: 'Electric piano', group: 'Keys', engine: 'fm', damp: true, ratio: 1, index: 1.5, indexDecay: 0.6,
    ratioB: 14, indexB: 0.5, decayB: 0.04, def: T(0.5, 0.003, 3, { vibrato: 0.15 }),
  },
  organ: {
    label: 'Organ', group: 'Keys', engine: 'add', sustain: 1, decay: 0.05, level: 0.55,
    partials: [[0.5, 0.6, 1], [1, 1, 1], [2, 0.7, 1], [3, 0.4, 1], [4, 0.45, 1], [6, 0.2, 1], [8, 0.25, 1]],
    hammer: 0.04, def: T(0.5, 0.01, 0.1, { vibrato: 0.3 }),
  },
  musicbox: {
    label: 'Music box', group: 'Mallets & bells', engine: 'add', hammer: 0.04, level: 0.9,
    partials: [[1, 1, 1], [2, 0.12, 0.6], [6.27, 0.3, 0.22], [17.55, 0.08, 0.08]], def: T(0.6, 0.001, 1.6, { echo: 0.2 }),
  },
  glock: {
    label: 'Glockenspiel', group: 'Mallets & bells', engine: 'add', hammer: 0.05, level: 0.8,
    partials: [[1, 1, 1], [2.76, 0.45, 0.4], [5.4, 0.25, 0.2], [8.93, 0.1, 0.1]], def: T(0.55, 0.001, 1.4),
  },
  marimba: {
    label: 'Marimba', group: 'Mallets & bells', engine: 'add', hammer: 0.2, level: 1.1,
    partials: [[1, 1, 1], [3.93, 0.3, 0.3], [9.2, 0.08, 0.12]], def: T(0.5, 0.001, 0.9),
  },
  vibes: {
    label: 'Vibraphone', group: 'Mallets & bells', engine: 'add', hammer: 0.06, damp: true,
    partials: [[1, 1, 1], [4, 0.3, 0.4], [10, 0.05, 0.15]], def: T(0.5, 0.002, 3.2, { vibrato: 0.45 }),
  },
  bell: {
    label: 'Tubular bell', group: 'Mallets & bells', engine: 'add', hammer: 0.03, level: 0.8,
    partials: [
      [0.56, 0.6, 1.6], [0.92, 0.4, 1.2], [1, 1, 1], [1.19, 0.5, 0.8], [1.7, 0.6, 0.6], [2, 0.4, 0.5],
      [2.74, 0.35, 0.4], [3, 0.3, 0.35], [3.76, 0.2, 0.3], [4.07, 0.25, 0.25],
    ],
    def: T(0.5, 0.001, 4.5, { echo: 0.15 }),
  },
  fmbell: {
    label: 'FM bell', group: 'Mallets & bells', engine: 'fm', ratio: 3.5, index: 2.8, indexDecay: 1.2, level: 0.8,
    def: T(0.5, 0.001, 3),
  },
  nylon: {
    label: 'Nylon guitar', group: 'Strings', engine: 'pluck', damp: true, def: T(0.35, 0, 2.2),
  },
  harp: {
    label: 'Harp', group: 'Strings', engine: 'pluck', def: T(0.45, 0, 3.5, { echo: 0.1 }),
  },
  overdrive: {
    label: 'Overdriven guitar', group: 'Strings', engine: 'pluck', damp: true, level: 0.6,
    def: T(0.7, 0, 2.5, { drive: 0.75 }),
  },
  strings: {
    label: 'String section', group: 'Strings', engine: 'sub', wave: 'saw', unison: 3, sustain: 0.9, decay: 0.4,
    res: 0.1, env: 0.4, envDecay: 1, level: 0.8, def: T(0.42, 0.35, 0.6, { detune: 12, vibrato: 0.25 }),
  },
  pad: {
    label: 'Warm pad', group: 'Synths', engine: 'sub', wave: 'saw', unison: 5, sustain: 1, decay: 0.5,
    res: 0.15, env: 0.3, envDecay: 2, level: 0.7, def: T(0.33, 1.2, 2, { detune: 18 }),
  },
  glass: {
    label: 'Glass pad', group: 'Synths', engine: 'fm', ratio: 2, index: 0.7, sustain: 1, decay: 0.5, level: 0.7,
    ratioB: 3.01, indexB: 0.3, def: T(0.5, 0.8, 2.5, { vibrato: 0.12 }),
  },
  sawlead: {
    label: 'Saw lead', group: 'Synths', engine: 'sub', wave: 'saw', unison: 2, sustain: 0.8, decay: 0.2,
    res: 0.25, env: 1.5, envDecay: 0.25, level: 0.75, def: T(0.5, 0.01, 0.25, { detune: 8, vibrato: 0.3 }),
  },
  squarelead: {
    label: 'Square lead', group: 'Synths', engine: 'sub', wave: 'square', sustain: 0.8, decay: 0.2,
    res: 0.2, env: 1, envDecay: 0.2, level: 0.75, def: T(0.5, 0.01, 0.2, { vibrato: 0.25 }),
  },
  chip: {
    label: 'Chiptune pulse', group: 'Synths', engine: 'sub', wave: 'pulse', width: 0.25, sustain: 0.85, decay: 0.08,
    level: 0.45, def: T(1, 0.002, 0.04),
  },
  chiptri: {
    label: 'Chiptune triangle', group: 'Synths', engine: 'sub', wave: 'tri', sustain: 1, decay: 0.05,
    level: 0.9, def: T(1, 0.002, 0.03),
  },
  brass: {
    label: 'Synth brass', group: 'Synths', engine: 'sub', wave: 'saw', unison: 2, sustain: 0.85, decay: 0.3,
    res: 0.1, env: 2, envDecay: 0.5, level: 0.7, def: T(0.3, 0.06, 0.2, { detune: 6, vibrato: 0.15 }),
  },
  flute: {
    label: 'Flute', group: 'Synths', engine: 'sub', wave: 'sine', wave2: 'tri', ratio2: 1, mix2: 0.2, noise: 0.07,
    sustain: 0.9, decay: 0.15, level: 1, def: T(0.6, 0.06, 0.15, { vibrato: 0.35, echo: 0.1 }),
  },
  stab: {
    label: 'Synth stab', group: 'Synths', engine: 'sub', wave: 'saw', unison: 3, res: 0.3, env: 2, envDecay: 0.12,
    level: 0.7, def: T(0.42, 0.003, 0.35, { detune: 14, echo: 0.2 }),
  },
  subbass: {
    label: 'Sub bass', group: 'Bass', engine: 'sub', wave: 'sine', wave2: 'tri', ratio2: 1, mix2: 0.15, sustain: 1,
    decay: 0.1, level: 1.2, def: T(0.5, 0.005, 0.12, { drive: 0.15 }),
  },
  synthbass: {
    label: 'Synth bass', group: 'Bass', engine: 'sub', wave: 'saw', wave2: 'square', ratio2: 0.5, mix2: 0.4,
    sustain: 0.75, decay: 0.2, res: 0.2, env: 1.6, envDecay: 0.15, level: 1, def: T(0.3, 0.004, 0.1),
  },
  acid: {
    label: 'Acid bass', group: 'Bass', engine: 'sub', wave: 'saw', sustain: 0.7, decay: 0.2, res: 0.82, env: 3,
    envDecay: 0.15, level: 0.8, def: T(0.22, 0.003, 0.08, { drive: 0.3, echo: 0.15 }),
  },
  fmbass: {
    label: 'FM bass', group: 'Bass', engine: 'fm', ratio: 1, index: 2.2, indexDecay: 0.15, sustain: 0.7, decay: 0.3,
    level: 1, def: T(0.5, 0.003, 0.1),
  },
  fingerbass: {
    label: 'Finger bass', group: 'Bass', engine: 'pluck', damp: true, level: 1.3, def: T(0.25, 0, 1.6),
  },
  boom: {
    label: '808 bass', group: 'Bass', engine: 'sub', wave: 'sine', level: 1.3, def: T(0.5, 0.004, 1.6, { drive: 0.35 }),
  },
  reese: {
    label: 'Reese bass', group: 'Bass', engine: 'sub', wave: 'saw', unison: 2, sustain: 1, decay: 0.1, res: 0.15,
    level: 0.85, def: T(0.3, 0.01, 0.15, { detune: 24, drive: 0.2 }),
  },
};

export const instrumentTimbre = (key: string): Timbre => ({ ...(INSTRUMENTS[key] ?? INSTRUMENTS.piano).def });

// ---------------------------------------------------------------- building blocks

const TAU = Math.PI * 2;
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
/** Per-sample multiplier for an exponential decay reaching −60 dB after `t60` seconds. */
const decayK = (t60: number, sr: number) => Math.exp(-6.9 / (Math.max(1e-3, t60) * sr));

function polyBlep(t: number, dt: number) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function osc(w: Wave, ph: number, dt: number, width: number) {
  switch (w) {
    case 'sine': return Math.sin(TAU * ph);
    case 'tri': return 1 - 4 * Math.abs(ph - 0.5);
    case 'saw': return 2 * ph - 1 - polyBlep(ph, dt);
    default: {
      const pw = w === 'square' ? 0.5 : width;
      let v = ph < pw ? 1 : -1;
      v += polyBlep(ph, dt);
      let p2 = ph + 1 - pw;
      if (p2 >= 1) p2 -= 1;
      v -= polyBlep(p2, dt);
      return v;
    }
  }
}

/**
 * ADSR as a per-sample generator. Struck instruments (sustain 0) decay over `release` and are
 * only cut at note-off when they have a damper; sustained ones release over `release` after note-off.
 */
class Env {
  level = 0;
  private stage = 0; // 0 attack, 1 decay/hold, 2 release
  private n = 0;
  private aInc: number;
  private kDecay: number;
  private kRel: number;
  constructor(
    sr: number, attack: number, private sustain: number, decay: number, release: number,
    private offAt: number, damp: boolean,
  ) {
    this.aInc = 1 / Math.max(1, attack * sr);
    if (sustain > 0) {
      this.kDecay = Math.exp(-1 / (Math.max(0.005, decay / 3) * sr));
      this.kRel = decayK(release, sr);
    } else {
      this.kDecay = decayK(release, sr);
      this.kRel = damp ? decayK(0.12, sr) : this.kDecay;
    }
  }
  next() {
    if (this.n++ >= this.offAt && this.stage < 2) this.stage = 2;
    if (this.stage === 0) {
      this.level += this.aInc;
      if (this.level >= 1) {
        this.level = 1;
        this.stage = 1;
      }
    } else if (this.stage === 1) {
      this.level = this.sustain > 0 ? this.sustain + (this.level - this.sustain) * this.kDecay : this.level * this.kDecay;
    } else {
      this.level *= this.kRel;
    }
    return this.level;
  }
}

/** Zavalishin's TPT state-variable low-pass, coefficients refreshed every 16 samples. */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;
  private k: number;
  constructor(private sr: number, res: number) {
    this.k = 2 - 1.95 * Math.min(0.97, Math.max(0, res));
  }
  set(fc: number) {
    const g = Math.tan(Math.PI * Math.min(fc, this.sr * 0.45) / this.sr);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  lp(x: number) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }
}

const driver = (drive: number) => {
  if (drive <= 0.01) return (x: number) => x;
  const k = 1 + drive * 9;
  const norm = 1 / Math.tanh(k);
  return (x: number) => Math.tanh(x * k) * norm;
};

/**
 * Pitch vibrato: delayed onset, ~5.3 Hz, depth up to ±35 cents. Returns a function of the sample
 * index giving the frequency factor, refreshed every 8 samples (2^x ≈ 1 + x·ln2 at these depths).
 */
function vibrato(amount: number, sr: number) {
  if (amount <= 0) return () => 1;
  const depth = (amount * 35 * Math.LN2) / 1200;
  let v = 1;
  return (i: number) => {
    if ((i & 7) === 0) {
      const t = i / sr;
      v = 1 + depth * Math.min(1, t / 0.4) * Math.sin(TAU * 5.3 * t);
    }
    return v;
  };
}

// ---------------------------------------------------------------- voices

/**
 * Add one note to `out`, starting at sample `start`. `dur` is how long the note is held (s),
 * `vel` 0–1. Notes ring past their end as their envelope or string allows.
 */
export function renderNote(
  out: Float32Array, start: number, dur: number, midi: number, vel: number, inst: InstrumentDef, tb: Timbre,
  sr: number, r: Rng,
) {
  if (start >= out.length) return;
  const f = mtof(midi);
  if (f >= sr * 0.45) return;
  const offAt = Math.max(1, Math.round(dur * sr));
  const gain = 0.3 * (inst.level ?? 1) * (0.25 + 0.75 * vel);
  const drv = driver(tb.drive);
  const write = (i: number, v: number) => {
    out[start + i] += drv(v) * gain;
  };
  // Upper bound only; each voice stops once its envelope has died away.
  const maxLen = Math.min(out.length - start, Math.ceil((dur + 1.5 * Math.max(0.05, tb.release) + 0.5) * sr));
  switch (inst.engine) {
    case 'sub': return subVoice(write, maxLen, offAt, f, vel, inst, tb, sr, r);
    case 'fm': return fmVoice(write, maxLen, offAt, f, vel, inst, tb, sr);
    case 'add': return addVoice(write, maxLen, offAt, f, vel, inst, tb, sr, r);
    case 'pluck': return pluckVoice(write, maxLen, offAt, f, vel, inst, tb, sr, r);
  }
}

type Write = (i: number, v: number) => void;

function envFor(inst: InstrumentDef, tb: Timbre, sr: number, offAt: number) {
  return new Env(sr, tb.attack, inst.sustain ?? 0, inst.decay ?? 0.2, tb.release, offAt, !!inst.damp);
}

function subVoice(write: Write, maxLen: number, offAt: number, f: number, vel: number, inst: InstrumentDef, tb: Timbre, sr: number, r: Rng) {
  const env = envFor(inst, tb, sr, offAt);
  const wave = inst.wave ?? 'saw';
  const width = inst.width ?? 0.5;
  const U = Math.max(1, inst.unison ?? 1);
  const ph = new Float64Array(U);
  const ratio = new Float64Array(U);
  for (let u = 0; u < U; u++) {
    ph[u] = U > 1 ? r() : 0;
    const spread = U > 1 ? (u / (U - 1)) * 2 - 1 : 0;
    ratio[u] = Math.pow(2, (spread * tb.detune) / 1200);
  }
  const uNorm = 1 / Math.sqrt(U);
  const w2 = inst.wave2;
  const r2 = inst.ratio2 ?? 1;
  const mix2 = w2 ? (inst.mix2 ?? 0.3) : 0;
  let ph2 = 0;
  const noise = inst.noise ?? 0;
  // Unfiltered waves (sine, chip) skip the filter.
  const filtered = inst.env !== undefined || inst.res !== undefined || tb.bright < 0.98;
  const svf = new Svf(sr, inst.res ?? 0);
  const fc0 = 80 * Math.pow(2, tb.bright * 8) * Math.pow(f / 261.6, 0.5) * (0.55 + 0.45 * vel);
  const envAmt = (inst.env ?? 0) * (0.4 + 0.6 * vel);
  const kEnv = Math.exp(-1 / (Math.max(0.01, inst.envDecay ?? 0.3) * sr));
  const attackN = Math.max(1, tb.attack * sr);
  const vib = vibrato(tb.vibrato, sr);
  let fenv = 0;
  for (let i = 0; i < maxLen; i++) {
    const e = env.next();
    if (i > offAt && e < 1e-4) break;
    const fv = f * vib(i);
    let s = 0;
    for (let u = 0; u < U; u++) {
      const dt = (fv * ratio[u]) / sr;
      s += osc(wave, ph[u], dt, width);
      ph[u] += dt;
      if (ph[u] >= 1) ph[u] -= 1;
    }
    s *= uNorm;
    if (w2) {
      const dt2 = (fv * r2) / sr;
      s = s * (1 - mix2) + osc(w2, ph2, dt2, 0.5) * mix2;
      ph2 += dt2;
      if (ph2 >= 1) ph2 -= 1;
    }
    if (noise) s += (r() * 2 - 1) * noise;
    if (filtered) {
      fenv = i < attackN ? i / attackN : fenv * kEnv;
      if ((i & 15) === 0) svf.set(fc0 * Math.pow(2, envAmt * fenv));
      s = svf.lp(s);
    }
    write(i, s * e);
  }
}

function fmVoice(write: Write, maxLen: number, offAt: number, f: number, vel: number, inst: InstrumentDef, tb: Timbre, sr: number) {
  const env = envFor(inst, tb, sr, offAt);
  const scale = (0.2 + 1.6 * tb.bright) * (0.5 + 0.5 * vel);
  const I0 = (inst.index ?? 1) * scale;
  const kI = inst.indexDecay ? Math.exp(-1 / (inst.indexDecay * sr)) : 1;
  const IB0 = (inst.indexB ?? 0) * scale;
  const kB = inst.decayB ? Math.exp(-1 / (inst.decayB * sr)) : 1;
  const ratio = inst.ratio ?? 1;
  const ratioB = inst.ratioB ?? 1;
  const vib = vibrato(tb.vibrato, sr);
  let pc = 0, pm = 0, pb = 0, I = I0, IB = IB0;
  for (let i = 0; i < maxLen; i++) {
    const e = env.next();
    if (i > offAt && e < 1e-4) break;
    const fv = f * vib(i);
    const m = Math.sin(TAU * pm) * I + (IB > 1e-4 ? Math.sin(TAU * pb) * IB : 0);
    write(i, Math.sin(TAU * pc + m) * e);
    pc += fv / sr;
    pm += (fv * ratio) / sr;
    pb += (fv * ratioB) / sr;
    if (pc >= 1) pc -= 1;
    if (pm >= 1) pm -= 1;
    if (pb >= 1) pb -= 1;
    I *= kI;
    IB *= kB;
  }
}

function addVoice(write: Write, maxLen: number, offAt: number, f: number, vel: number, inst: InstrumentDef, tb: Timbre, sr: number, r: Rng) {
  const sustained = (inst.sustain ?? 0) > 0;
  const B = inst.inharm ?? 0;
  const tilt = (tb.bright - 0.5) * 2.4 + (vel - 0.7) * 0.8;
  // Recursive sine oscillators: y[n] = c·y[n−1] − y[n−2].
  const ps: { c: number; y1: number; y2: number; g: number; k: number }[] = [];
  let norm = 0;
  for (const [ratio, amp, dk] of inst.partials ?? [[1, 1, 1]]) {
    const rr = ratio * Math.sqrt(1 + B * ratio * ratio);
    const fk = f * rr;
    if (fk >= sr * 0.45) continue;
    const w = (TAU * fk) / sr;
    const a = amp * Math.pow(rr, tilt);
    const phase = r() * TAU;
    ps.push({ c: 2 * Math.cos(w), y1: Math.sin(phase - w) * a, y2: Math.sin(phase - 2 * w) * a, g: 1, k: sustained ? 1 : decayK(tb.release * dk, sr) });
    norm += a;
  }
  if (!ps.length) return;
  const gain = 1 / Math.max(1, norm * 0.7);
  // Struck: the partials decay on their own; the envelope only shapes the attack and the damper.
  const env = sustained ? envFor(inst, tb, sr, offAt) : new Env(sr, tb.attack, 1, 0.01, 0.12, inst.damp ? offAt : 1e9, false);
  const longest = sustained ? maxLen : Math.min(maxLen, Math.ceil(Math.max(...(inst.partials ?? [[1, 1, 1]]).map((p) => p[2])) * tb.release * sr) + 10);
  const hammerN = inst.hammer ? Math.floor(0.006 * sr) : 0;
  let lp = 0;
  const trem = tb.vibrato;
  for (let i = 0; i < longest; i++) {
    const e = env.next();
    if (i > offAt && e < 1e-4) break;
    let s = 0;
    for (const p of ps) {
      const y = p.c * p.y1 - p.y2;
      p.y2 = p.y1;
      p.y1 = y;
      s += y * p.g;
      p.g *= p.k;
    }
    s *= gain;
    if (trem > 0) s *= 1 - trem * 0.45 * (0.5 - 0.5 * Math.cos(TAU * 5 * (i / sr)));
    if (i < hammerN) {
      lp += 0.3 * ((r() * 2 - 1) - lp);
      s += lp * inst.hammer! * (1 - i / hammerN) * vel * 3;
    }
    write(i, s * e);
  }
}

function pluckVoice(write: Write, maxLen: number, offAt: number, f: number, vel: number, inst: InstrumentDef, tb: Timbre, sr: number, r: Rng) {
  // Delay line of one period; the two-point average in the loop adds half a sample of delay.
  const P = sr / f;
  const L = Math.max(2, P - 0.5);
  const size = Math.ceil(L) + 3;
  const buf = new Float32Array(size);
  // Excitation: a noise burst one period long, darker for low brightness / soft notes, with a
  // pick-position comb for a less synthetic tone.
  const exLen = Math.ceil(P);
  const ex = new Float32Array(exLen);
  const a = Math.min(0.95, 0.08 + 0.85 * tb.bright * (0.5 + 0.5 * vel));
  let lp = 0;
  for (let i = 0; i < exLen; i++) {
    lp += a * ((r() * 2 - 1) - lp);
    ex[i] = lp;
  }
  const pick = Math.max(1, Math.floor(P * 0.13));
  for (let i = exLen - 1; i >= pick; i--) ex[i] -= 0.6 * ex[i - pick];
  const gRing = Math.pow(0.001, 1 / (f * Math.max(0.05, tb.release)));
  const gDamp = Math.pow(0.001, 1 / (f * 0.1));
  const len = Math.min(maxLen, Math.ceil(tb.release * sr) + 10);
  let w = 0;
  let prev = 0;
  let level = 0;
  for (let i = 0; i < len; i++) {
    let rp = w - L;
    if (rp < 0) rp += size;
    const i0 = Math.floor(rp);
    const fr = rp - i0;
    const y = buf[i0 % size] * (1 - fr) + buf[(i0 + 1) % size] * fr;
    const g = inst.damp && i > offAt ? gDamp : gRing;
    const v = g * 0.5 * (y + prev) + (i < exLen ? ex[i] : 0);
    prev = y;
    buf[w] = v;
    w = (w + 1) % size;
    write(i, v * 1.6);
    level = level * 0.999 + Math.abs(v) * 0.001;
    if (i > exLen * 4 && level < 1e-5) break;
  }
}
