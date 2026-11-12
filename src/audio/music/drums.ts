// Drum kits: every hit is synthesized (sine sweeps, filtered noise, metallic square-wave clusters).
import type { Rng } from './rng';

export type DrumVoice = 'kick' | 'snare' | 'clap' | 'hat' | 'ohat' | 'tomL' | 'tomH' | 'rim' | 'shaker' | 'crash';

interface Hit {
  type: 'kick' | 'tone' | 'noise' | 'metal' | 'snare' | 'clap' | 'chip';
  /** Start / end pitch (Hz) and pitch-fall time constant (s). */
  f0?: number;
  f1?: number;
  ptau?: number;
  /** Decay to −60 dB (s). */
  t60: number;
  /** Noise band (Hz). */
  hp?: number;
  lp?: number;
  /** Tone vs noise for snares. */
  mix?: number;
  click?: number;
  gain?: number;
  /** Seconds of fade-in (shakers). */
  attack?: number;
}

export interface Kit {
  label: string;
  voices: Partial<Record<DrumVoice, Hit>>;
  /** Post-filter low-pass (Hz) and bit depth for lo-fi kits. */
  lowpass?: number;
  bits?: number;
}

const kick = (f0: number, f1: number, t60: number, click = 0.3, ptau = 0.04): Hit => ({ type: 'kick', f0, f1, t60, click, ptau });
const metal = (t60: number, hp: number, gain = 0.5): Hit => ({ type: 'metal', t60, hp, gain });
const noise = (t60: number, hp: number, lp: number, gain = 0.6, attack = 0): Hit => ({ type: 'noise', t60, hp, lp, gain, attack });
const tone = (f0: number, f1: number, t60: number, gain = 0.8): Hit => ({ type: 'tone', f0, f1, t60, ptau: 0.08, gain });

export const KITS: Record<string, Kit> = {
  k808: {
    label: '808',
    voices: {
      kick: kick(140, 46, 0.9, 0.15, 0.05), snare: { type: 'snare', f0: 185, t60: 0.25, hp: 1200, lp: 9000, mix: 0.45 },
      clap: { type: 'clap', t60: 0.3, hp: 900, lp: 3500 }, hat: metal(0.07, 7500, 0.35), ohat: metal(0.5, 7000, 0.3),
      tomL: tone(110, 80, 0.45), tomH: tone(170, 125, 0.4), rim: tone(1700, 1700, 0.03, 0.5),
      shaker: noise(0.07, 5000, 12000, 0.3, 0.012), crash: metal(1.6, 4500, 0.35),
    },
  },
  k909: {
    label: '909',
    voices: {
      kick: kick(190, 52, 0.45, 0.5, 0.03), snare: { type: 'snare', f0: 210, t60: 0.22, hp: 1800, lp: 12000, mix: 0.35 },
      clap: { type: 'clap', t60: 0.25, hp: 1000, lp: 4500 }, hat: noise(0.06, 8000, 16000, 0.4), ohat: noise(0.4, 7000, 16000, 0.35),
      tomL: tone(130, 90, 0.35), tomH: tone(200, 150, 0.3), rim: tone(1800, 1800, 0.03, 0.5),
      shaker: noise(0.06, 6000, 14000, 0.3, 0.01), crash: noise(1.5, 5000, 16000, 0.35),
    },
  },
  acoustic: {
    label: 'Acoustic',
    voices: {
      kick: kick(110, 58, 0.35, 0.35, 0.02), snare: { type: 'snare', f0: 220, t60: 0.3, hp: 600, lp: 8000, mix: 0.3 },
      clap: { type: 'clap', t60: 0.2, hp: 800, lp: 3000 }, hat: noise(0.05, 6500, 13000, 0.35), ohat: noise(0.6, 5500, 13000, 0.3),
      tomL: tone(95, 75, 0.6), tomH: tone(150, 120, 0.5), rim: tone(1200, 1100, 0.04, 0.5),
      shaker: noise(0.08, 4000, 10000, 0.3, 0.015), crash: { ...noise(2.2, 3500, 13000, 0.35), type: 'metal' },
    },
  },
  lofi: {
    label: 'Lo-fi', lowpass: 5500, bits: 10,
    voices: {
      kick: kick(100, 50, 0.35, 0.2, 0.03), snare: { type: 'snare', f0: 200, t60: 0.22, hp: 800, lp: 6000, mix: 0.35 },
      clap: { type: 'clap', t60: 0.2, hp: 800, lp: 3000 }, hat: noise(0.04, 6000, 11000, 0.3), ohat: noise(0.3, 5500, 11000, 0.25),
      tomL: tone(100, 80, 0.4), tomH: tone(160, 130, 0.35), rim: tone(1500, 1400, 0.03, 0.5),
      shaker: noise(0.07, 4000, 9000, 0.3, 0.015), crash: noise(1.2, 3500, 10000, 0.3),
    },
  },
  electro: {
    label: 'Electro / minimal',
    voices: {
      kick: kick(160, 48, 0.3, 0.6, 0.015), snare: { type: 'snare', f0: 280, t60: 0.12, hp: 2500, lp: 14000, mix: 0.5 },
      clap: { type: 'clap', t60: 0.18, hp: 1200, lp: 6000 }, hat: noise(0.025, 9000, 18000, 0.35), ohat: noise(0.18, 8000, 18000, 0.3),
      tomL: tone(220, 120, 0.15), tomH: tone(330, 200, 0.12), rim: tone(2400, 2400, 0.015, 0.6),
      shaker: noise(0.035, 7000, 16000, 0.3, 0.004), crash: metal(0.9, 6000, 0.3),
    },
  },
  trap: {
    label: 'Trap',
    voices: {
      kick: kick(120, 38, 1.6, 0.25, 0.07), snare: { type: 'snare', f0: 200, t60: 0.2, hp: 1500, lp: 10000, mix: 0.3 },
      clap: { type: 'clap', t60: 0.28, hp: 1000, lp: 5000 }, hat: metal(0.045, 8000, 0.35), ohat: metal(0.35, 7500, 0.3),
      tomL: tone(90, 70, 0.6), tomH: tone(140, 110, 0.5), rim: tone(1900, 1900, 0.025, 0.5),
      shaker: noise(0.05, 6000, 14000, 0.3, 0.008), crash: metal(1.5, 5000, 0.35),
    },
  },
  chip: {
    label: 'Chiptune',
    voices: {
      kick: { type: 'chip', f0: 200, f1: 40, ptau: 0.03, t60: 0.2 }, snare: { type: 'chip', t60: 0.18, hp: 1000, lp: 9000 },
      clap: { type: 'chip', t60: 0.15, hp: 1500, lp: 9000 }, hat: { type: 'chip', t60: 0.04, hp: 7000, lp: 16000, gain: 0.4 },
      ohat: { type: 'chip', t60: 0.25, hp: 6000, lp: 16000, gain: 0.35 }, tomL: { type: 'chip', f0: 160, f1: 80, ptau: 0.06, t60: 0.25 },
      tomH: { type: 'chip', f0: 260, f1: 140, ptau: 0.05, t60: 0.2 }, rim: { type: 'chip', f0: 1200, f1: 1200, t60: 0.03 },
      shaker: { type: 'chip', t60: 0.05, hp: 6000, lp: 16000, gain: 0.3 }, crash: { type: 'chip', t60: 0.9, hp: 4000, lp: 16000, gain: 0.35 },
    },
  },
  perc: {
    label: 'Hand percussion',
    voices: {
      kick: tone(95, 80, 0.35, 1), snare: tone(2600, 2500, 0.05, 0.6), clap: { type: 'clap', t60: 0.15, hp: 1000, lp: 3500 },
      hat: noise(0.06, 5000, 12000, 0.35, 0.015), ohat: noise(0.16, 4500, 12000, 0.3, 0.03),
      tomL: tone(200, 185, 0.3, 0.8), tomH: tone(320, 300, 0.22, 0.75), rim: tone(1700, 1650, 0.04, 0.55),
      shaker: noise(0.09, 4000, 11000, 0.35, 0.02), crash: tone(520, 500, 1.2, 0.3),
    },
  },
};

// ---------------------------------------------------------------- synthesis

/** RBJ biquad, used on noise. */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(type: 'lp' | 'hp' | 'bp', f: number, q: number, sr: number) {
    const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    if (type === 'lp') { this.b0 = (1 - cs) / 2; this.b1 = 1 - cs; this.b2 = (1 - cs) / 2; }
    else if (type === 'hp') { this.b0 = (1 + cs) / 2; this.b1 = -(1 + cs); this.b2 = (1 + cs) / 2; }
    else { this.b0 = al; this.b1 = 0; this.b2 = -al; }
    this.b0 /= a0; this.b1 /= a0; this.b2 /= a0;
    this.a1 = (-2 * cs) / a0;
    this.a2 = (1 - al) / a0;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const TAU = Math.PI * 2;
// The six square-wave pitches of the classic 808 cymbal circuit.
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];

/** Render one hit at full velocity. */
export function synthHit(h: Hit, sr: number, r: Rng): Float32Array {
  const len = Math.ceil(Math.min(3, h.t60 * 1.05 + (h.attack ?? 0)) * sr);
  const d = new Float32Array(len);
  const k = Math.exp(-6.9 / (h.t60 * sr));
  const g = h.gain ?? 1;
  let env = 1;
  switch (h.type) {
    case 'kick': {
      let ph = 0;
      const kp = Math.exp(-1 / ((h.ptau ?? 0.04) * sr));
      let df = h.f0! - h.f1!;
      const hp = new Biquad('hp', 1500, 0.7, sr);
      for (let i = 0; i < len; i++) {
        ph += (h.f1! + df) / sr;
        df *= kp;
        const click = i < sr * 0.004 ? hp.run(r() * 2 - 1) * (h.click ?? 0) * (1 - i / (sr * 0.004)) : 0;
        d[i] = Math.tanh(1.4 * Math.sin(TAU * ph)) * env + click;
        env *= k;
      }
      break;
    }
    case 'tone': {
      let ph = 0;
      const kp = Math.exp(-1 / ((h.ptau ?? 0.08) * sr));
      let df = h.f0! - h.f1!;
      for (let i = 0; i < len; i++) {
        ph += (h.f1! + df) / sr;
        df *= kp;
        d[i] = Math.sin(TAU * ph) * env * g;
        env *= k;
      }
      break;
    }
    case 'noise': {
      const hp = new Biquad('hp', h.hp ?? 100, 0.7, sr);
      const lp = new Biquad('lp', h.lp ?? 16000, 0.7, sr);
      const an = Math.max(1, (h.attack ?? 0) * sr);
      for (let i = 0; i < len; i++) {
        const a = i < an ? i / an : 1;
        d[i] = lp.run(hp.run(r() * 2 - 1)) * env * a * g * 1.6;
        if (i >= an) env *= k;
      }
      break;
    }
    case 'metal': {
      const ph = METAL.map(() => r());
      const bp = new Biquad('bp', (h.hp ?? 7000) * 1.2, 0.8, sr);
      const hp = new Biquad('hp', h.hp ?? 7000, 0.7, sr);
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let j = 0; j < 6; j++) {
          ph[j] += (METAL[j] * 1.7) / sr;
          if (ph[j] >= 1) ph[j] -= 1;
          s += ph[j] < 0.5 ? 1 : -1;
        }
        d[i] = hp.run(bp.run(s / 6 + (r() * 2 - 1) * 0.15)) * env * g * 2.2;
        env *= k;
      }
      break;
    }
    case 'snare': {
      const hp = new Biquad('hp', h.hp ?? 1000, 0.7, sr);
      const lp = new Biquad('lp', h.lp ?? 9000, 0.7, sr);
      const kt = Math.exp(-6.9 / (Math.min(0.12, h.t60 * 0.5) * sr));
      let et = 1;
      let ph = 0;
      const mix = h.mix ?? 0.4;
      for (let i = 0; i < len; i++) {
        ph += (h.f0! * (1 + 0.4 * et)) / sr;
        const body = (Math.sin(TAU * ph) + 0.5 * Math.sin(TAU * ph * 1.62)) * et;
        d[i] = body * mix + lp.run(hp.run(r() * 2 - 1)) * env * (1 - mix) * 1.8;
        env *= k;
        et *= kt;
      }
      break;
    }
    case 'clap': {
      const bp = new Biquad('bp', ((h.hp ?? 1000) + (h.lp ?? 3000)) / 2, 1.2, sr);
      const taps = [0, 0.011, 0.023, 0.034];
      const kTap = Math.exp(-6.9 / (0.012 * sr));
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        let a = 0;
        for (let j = 0; j < 3; j++) if (t >= taps[j] && t < taps[j + 1]) a = Math.pow(kTap, (t - taps[j]) * sr);
        if (t >= taps[3]) a = env;
        d[i] = bp.run(r() * 2 - 1) * a * 2.4;
        if (t >= taps[3]) env *= k;
      }
      break;
    }
    case 'chip': {
      // NES-style: stepped noise from a linear-feedback shift register, or a falling square tone.
      if (h.f0) {
        let ph = 0;
        const kp = Math.exp(-1 / ((h.ptau ?? 0.05) * sr));
        let df = h.f0 - (h.f1 ?? h.f0);
        for (let i = 0; i < len; i++) {
          ph += ((h.f1 ?? h.f0) + df) / sr;
          df *= kp;
          d[i] = (ph % 1 < 0.5 ? 0.6 : -0.6) * env;
          env *= k;
        }
      } else {
        let lfsr = 1 + Math.floor(r() * 32766);
        const hold = Math.max(1, Math.round(sr / ((h.hp ?? 4000) * 2)));
        let v = 0;
        for (let i = 0; i < len; i++) {
          if (i % hold === 0) {
            const bit = (lfsr ^ (lfsr >> 1)) & 1;
            lfsr = (lfsr >> 1) | (bit << 14);
            v = lfsr & 1 ? 0.6 : -0.6;
          }
          d[i] = v * env * g;
          env *= k;
        }
      }
      break;
    }
  }
  return d;
}
