// Procedurally generated room impulse responses for the ConvolverNode.

interface IrParams {
  rt60: number;
  predelay: number;
  damping: number;
  /** Number of early-reflection taps and the time span they fall in. */
  er: number;
  erSpan: number;
  sparse?: boolean;
  /** Discrete echo times in seconds. */
  echoes?: number[];
}

export interface Environment {
  label: string;
  wet: number;
  ir?: IrParams;
}

export const ENVIRONMENTS: Record<string, Environment> = {
  open: { label: 'Open field (dry)', wet: 0 },
  studio: { label: 'Small studio', wet: 0.18, ir: { rt60: 0.25, predelay: 0.002, damping: 0.6, er: 6, erSpan: 0.015 } },
  room: { label: 'Living room', wet: 0.28, ir: { rt60: 0.55, predelay: 0.004, damping: 0.55, er: 8, erSpan: 0.025 } },
  hall: { label: 'Concert hall', wet: 0.38, ir: { rt60: 2.0, predelay: 0.018, damping: 0.35, er: 12, erSpan: 0.06 } },
  cathedral: { label: 'Cathedral', wet: 0.5, ir: { rt60: 5.0, predelay: 0.035, damping: 0.25, er: 14, erSpan: 0.12 } },
  cave: { label: 'Cave', wet: 0.5, ir: { rt60: 3.2, predelay: 0.025, damping: 0.75, er: 24, erSpan: 0.3 } },
  forest: { label: 'Forest', wet: 0.18, ir: { rt60: 0.9, predelay: 0.012, damping: 0.85, er: 30, erSpan: 0.25, sparse: true } },
  canyon: {
    label: 'Canyon (echoes)', wet: 0.45,
    ir: { rt60: 1.6, predelay: 0.04, damping: 0.6, er: 6, erSpan: 0.05, echoes: [0.42, 0.95, 1.6] },
  },
};

/** mulberry32 — deterministic so an environment always sounds the same. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(sr: number, p: IrParams): AudioBuffer {
  const echoTail = p.echoes ? Math.max(...p.echoes) + 0.3 : 0;
  const length = Math.ceil(sr * (p.predelay + Math.max(p.rt60 * 1.2, echoTail) + 0.05));
  const buf = new AudioBuffer({ length, sampleRate: sr, numberOfChannels: 2 });
  const pre = Math.floor(p.predelay * sr);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const r = rng(1234 + ch * 777);
    let lp = 0;
    // Diffuse tail: noise × exponential decay, progressively low-passed (wall & air damping).
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp((-6.9078 * t) / p.rt60); // −60 dB at rt60
      let w = r() * 2 - 1;
      if (p.sparse) w = r() < 0.03 ? w * 3 : w * 0.25;
      const alpha = Math.max(0.03, Math.exp((-t * p.damping * 8) / p.rt60));
      lp += alpha * (w - lp);
      d[i] = lp * env * Math.min(1, t / 0.004) * 0.6;
    }
    // Early reflections: sparse discrete taps, different in each ear.
    for (let k = 0; k < p.er; k++) {
      const tk = p.predelay + r() * p.erSpan;
      const idx = Math.floor(tk * sr);
      const amp = (0.9 - (0.6 * (tk - p.predelay)) / Math.max(p.erSpan, 1e-3)) * (r() < 0.5 ? -1 : 1);
      for (let j = 0; j < 3 && idx + j < length; j++) d[idx + j] += amp * (1 - j / 3);
    }
    // Discrete echoes off distant walls.
    p.echoes?.forEach((te, k) => {
      const idx = Math.floor((te + (ch ? 0.013 * (k + 1) : 0)) * sr);
      const amp = 0.7 * Math.pow(0.55, k);
      const n = Math.floor(0.012 * sr);
      let e = 0;
      for (let j = 0; j < n && idx + j < length; j++) {
        e += 0.25 * (r() * 2 - 1 - e);
        d[idx + j] += amp * e * 3 * Math.exp(-j / (0.003 * sr));
      }
    });
  }
  return buf;
}

const cache = new Map<string, AudioBuffer>();

/** Stereo IR for an environment at the given sample rate (null for a dry environment). */
export function getImpulse(sampleRate: number, key: string): AudioBuffer | null {
  const env = ENVIRONMENTS[key];
  if (!env?.ir) return null;
  const k = `${key}@${sampleRate}`;
  let ir = cache.get(k);
  if (!ir) {
    ir = generate(sampleRate, env.ir);
    cache.set(k, ir);
  }
  return ir;
}
