// Ambience generators: rain, stream, sea, wind, crowd, train, factory, fire, vinyl, tape hiss, thunder, mosquito.
// Pure sample-by-sample DSP into a Float32Array. Every random number comes from `rnd`, so a seeded
// render repeats exactly. Each sound but thunder is built as a loop of period `len`: slow modulations run whole
// cycles over the length, rhythms fit a whole number of beats, and events near the end wrap around
// to the start.
import { mod, TAU } from './util';

export type Rnd = () => number;

// ---------------------------------------------------------------- building blocks

/** Coefficient of a one-pole low-pass with cutoff `fc`. */
const pole = (fc: number, sr: number) => 1 - Math.exp((-TAU * fc) / sr);

/** Coefficient of a one-pole smoother with time constant `tau` seconds. */
const glide = (tau: number, sr: number) => 1 - Math.exp(-1 / (tau * sr));

function pinkNoise(rnd: Rnd) {
  // Paul Kellet's refined pink-noise filter
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const y = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    return y;
  };
}

function brownNoise(rnd: Rnd) {
  let last = 0;
  return () => (last = (last + 0.02 * (rnd() * 2 - 1)) / 1.02) * 3.5;
}

/** State-variable filter (topology-preserving form): low-, band- and high-pass from one update. */
class SVF {
  private s1 = 0;
  private s2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  private sr: number;
  lp = 0;
  /** Band-pass, unity gain at the centre. */
  bp = 0;
  hp = 0;
  constructor(sr: number, fc = 1000, q = 0.707) {
    this.sr = sr;
    this.set(fc, q);
  }
  set(fc: number, q: number) {
    const g = Math.tan((Math.PI * Math.min(Math.max(fc, 10), this.sr * 0.45)) / this.sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  run(x: number) {
    const v3 = x - this.s2;
    const v1 = this.a1 * this.s1 + this.a2 * v3;
    const v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
    this.s1 = 2 * v1 - this.s1;
    this.s2 = 2 * v2 - this.s2;
    this.lp = v2;
    this.bp = this.k * v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

/**
 * Smooth random curve in [−1, 1] that repeats exactly every `len` samples: a sum of sines with whole
 * numbers of cycles over the loop, from about `minHz` to `maxHz`, weighted 1/√n (slow swings dominate).
 */
function wander(rnd: Rnd, len: number, sr: number, maxHz: number, minHz = 0) {
  const dur = len / sr;
  const hi = Math.max(1, Math.round(maxHz * dur));
  const lo = Math.min(hi, Math.max(1, Math.round(minHz * dur)));
  const comps: [number, number, number][] = [];
  for (let c = lo; c <= hi; c++) comps.push([(TAU * c) / len, rnd() * TAU, (0.5 + 0.5 * rnd()) / Math.sqrt(c - lo + 1)]);
  const at = (i: number) => {
    let v = 0;
    for (const [w, p, a] of comps) v += a * Math.sin(w * i + p);
    return v;
  };
  // Evaluated every `step` samples and interpolated: these curves are far slower than audio.
  const out = new Float32Array(len);
  const step = 32;
  let a = at(0);
  let peak = 1e-9;
  for (let i = 0; i < len; i += step) {
    const b = at(i + step);
    for (let j = 0; j < step && i + j < len; j++) {
      const v = a + ((b - a) * j) / step;
      out[i + j] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    a = b;
  }
  for (let i = 0; i < len; i++) out[i] /= peak;
  return out;
}

/** Add decaying sine modes — [frequency Hz, amplitude, decay time s] — from sample `at`, wrapping around. */
function ring(d: Float32Array, sr: number, at: number, modes: number[][], gain = 1) {
  const len = d.length;
  at = mod(Math.floor(at), len);
  for (const [f, a, tau] of modes) {
    const n = Math.min(len, Math.ceil(tau * 7 * sr));
    const dec = Math.exp(-1 / (tau * sr));
    const w = (TAU * f) / sr;
    let e = a * gain;
    for (let j = 0; j < n; j++, e *= dec) d[(at + j) % len] += e * Math.sin(w * j);
  }
}

/** Add a burst of white noise decaying with time constant `tau` seconds, wrapping around. */
function burst(d: Float32Array, sr: number, rnd: Rnd, at: number, tau: number, amp: number) {
  const len = d.length;
  at = mod(Math.floor(at), len);
  const n = Math.min(len, Math.ceil(tau * 6 * sr));
  const dec = Math.exp(-1 / (tau * sr));
  let e = amp;
  for (let j = 0; j < n; j++, e *= dec) d[(at + j) % len] += e * (rnd() * 2 - 1);
}

/**
 * Add a ringing bubble (its Minnaert resonance): a decaying sine whose pitch rises as the bubble
 * shrinks — by the fraction `rise` every decay time `tau`.
 */
function bubble(d: Float32Array, sr: number, at: number, f0: number, rise: number, tau: number, amp: number) {
  const len = d.length;
  at = mod(Math.floor(at), len);
  const n = Math.min(len, Math.ceil(tau * 6 * sr));
  const dec = Math.exp(-1 / (tau * sr));
  const slope = rise / (tau * sr);
  let ph = 0;
  let e = amp;
  for (let j = 0; j < n; j++, e *= dec) {
    ph += (TAU * f0 * (1 + slope * j)) / sr;
    d[(at + j) % len] += e * Math.sin(ph);
  }
}

/** One-pole high-pass, in place. */
function highpass(d: Float32Array, sr: number, fc: number) {
  const k = pole(fc, sr);
  let lp = 0;
  for (let i = 0; i < d.length; i++) {
    lp += k * (d[i] - lp);
    d[i] -= lp;
  }
}

/** One-pole low-pass, in place. */
function lowpass(d: Float32Array, sr: number, fc: number) {
  const k = pole(fc, sr);
  let lp = 0;
  for (let i = 0; i < d.length; i++) d[i] = lp += k * (d[i] - lp);
}

/**
 * Small Schroeder reverb (four damped combs, two all-passes). It runs twice over the loop and keeps
 * the second pass, so the tail of the end rings on into the start. Returns dry + reverb, the reverb
 * scaled to `wet` × the dry RMS.
 */
function hall(d: Float32Array, sr: number, wet: number, size = 1, feedback = 0.84, damp = 0.3) {
  // Freeverb's mutually prime delays, so the echoes smear into a smooth tail instead of ringing.
  const sc = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
    .map((n) => ({ buf: new Float32Array(Math.max(1, Math.round(n * sc * size))), i: 0, lp: 0 }));
  const aps = [556, 441, 341, 225].map((n) => ({ buf: new Float32Array(Math.max(1, Math.round(n * sc))), i: 0 }));
  const rev = new Float32Array(d.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      let y = 0;
      for (const c of combs) {
        const o = c.buf[c.i];
        c.lp = o + damp * (c.lp - o);
        c.buf[c.i] = x + feedback * c.lp;
        if (++c.i === c.buf.length) c.i = 0;
        y += o;
      }
      for (const a of aps) {
        const o = a.buf[a.i];
        const v = y + 0.5 * o;
        a.buf[a.i] = v;
        if (++a.i === a.buf.length) a.i = 0;
        y = o - 0.5 * v;
      }
      if (pass) rev[i] = y;
    }
  }
  const g = (wet * rms(d)) / Math.max(1e-9, rms(rev));
  for (let i = 0; i < d.length; i++) rev[i] = d[i] + g * rev[i];
  return rev;
}

function rms(d: Float32Array) {
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, d.length));
}

/** A short metallic clank: many inharmonic, quickly damped modes and a click (metal struck, not a bell). */
function clank(d: Float32Array, sr: number, rnd: Rnd, at: number, gain: number, lo = 700, hi = 7000) {
  const modes: number[][] = [];
  for (let k = 0; k < 10; k++) {
    const f = lo * (hi / lo) ** rnd();
    modes.push([f, (0.3 + 0.7 * rnd()) * Math.sqrt(lo / f), 0.008 + 0.027 * rnd()]);
  }
  ring(d, sr, at, modes, gain * 0.25);
  burst(d, sr, rnd, at, 0.0015, gain * 0.6);
}

/** N-wave click: a short positive then negative pulse, `width` seconds long (a shock front, a speck of dust). */
function nwave(d: Float32Array, sr: number, at: number, width: number, amp: number) {
  const len = d.length;
  at = mod(Math.floor(at), len);
  const n = Math.max(2, Math.round(width * sr));
  for (let j = 0; j < n; j++) d[(at + j) % len] += amp * (1 - (2 * j) / (n - 1));
}

/** Scale to an RMS level, then soft-clip the rare peaks above it so normalizing doesn't bury the body. */
function finish(d: Float32Array, level: number) {
  const g = level / Math.max(1e-9, rms(d));
  for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * g);
  return d;
}

const uniform = (rnd: Rnd) => (a: number, b: number) => a + rnd() * (b - a);

// ---------------------------------------------------------------- the sounds

export function rain(sr: number, dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  const d = new Float32Array(len);
  const swell = wander(rnd, len, sr, 0.2); // the shower thickens and eases
  const density = (i: number) => 0.75 + 0.25 * swell[i];

  // Wash: the hiss of countless distant drops, pink noise between ~400 Hz and ~10 kHz.
  const pink = pinkNoise(rnd);
  const kLo = pole(400, sr);
  const kHi = pole(10000, sr);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < len; i++) {
    hi += kHi * (pink() - hi);
    lo += kLo * (hi - lo);
    d[i] = (hi - lo) * density(i);
  }

  // Ticks: drops striking leaves, roofs and pavement, each a tiny bright click.
  const ticks = new Float32Array(len);
  for (let k = 0, n = Math.round(dur * 500); k < n; k++) {
    const at = Math.floor(rnd() * len);
    if (rnd() < density(at)) burst(ticks, sr, rnd, at, R(0.0002, 0.0012), rnd() ** 3);
  }
  highpass(ticks, sr, 1500);
  for (let i = 0; i < len; i++) d[i] += 0.8 * ticks[i];

  // Plinks: a drop falling into a puddle traps a bubble, which rings with a quickly rising pitch.
  for (let k = 0, n = Math.round(dur * 18); k < n; k++) {
    const at = Math.floor(rnd() * len);
    if (rnd() < density(at)) bubble(d, sr, at, R(1400, 4500), R(0.15, 0.5), R(0.004, 0.012), 0.5 * rnd() ** 2);
  }

  // Big drops close by: dull taps on a nearby surface.
  const taps = new Float32Array(len);
  for (let k = 0, n = Math.round(dur * 1.5); k < n; k++) burst(taps, sr, rnd, rnd() * len, R(0.003, 0.008), R(0.5, 1.2));
  lowpass(taps, sr, 1800);
  lowpass(taps, sr, 1800);
  for (let i = 0; i < len; i++) d[i] += taps[i];
  return finish(d, 0.18);
}

export function stream(sr: number, dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  const d = new Float32Array(len);
  const flow = wander(rnd, len, sr, 0.25); // surges in the current
  const churn = wander(rnd, len, sr, 4, 1.5); // quick turbulence

  // Rush: the body of moving water, pink noise through a band-pass whose centre churns around
  // 600 Hz, over a soft brown-noise rumble.
  const pink = pinkNoise(rnd);
  const brown = brownNoise(rnd);
  const bp = new SVF(sr);
  const kr = pole(300, sr);
  let rum = 0;
  for (let i = 0; i < len; i++) {
    if ((i & 15) === 0) bp.set(600 * 2 ** (0.7 * churn[i]), 1.2);
    bp.run(pink());
    rum += kr * (brown() - rum);
    d[i] = (bp.bp * 0.9 + rum * 0.6) * (0.8 + 0.2 * flow[i]);
  }

  // Babble: bubbles ringing as the water tumbles over stones. They come in bursts, one pocket of
  // water at a time, with bubbles of similar size; bigger bubbles ring lower, longer and louder.
  for (let k = 0, n = Math.round(dur * 9); k < n; k++) {
    const at = Math.floor(rnd() * len);
    const level = 0.6 + 0.4 * flow[at];
    const base = 300 * 2 ** R(0, 2.6); // 300 Hz – 1.8 kHz
    const span = R(0.05, 0.35) * sr;
    for (let b = 0, count = 3 + Math.floor(rnd() * 14); b < count; b++) {
      const f = base * 2 ** R(-0.4, 0.4);
      const tau = R(0.7, 1.3) * (10 / f + 0.002);
      bubble(d, sr, at + rnd() * span, f, R(0.1, 0.5), tau, level * 0.6 * rnd() ** 2 * Math.sqrt(500 / f));
    }
  }

  // Fizz: a sprinkle of tiny, high bubbles and splashes.
  for (let k = 0, n = Math.round(dur * 60); k < n; k++) {
    bubble(d, sr, rnd() * len, R(2000, 5000), R(0.2, 0.8), R(0.002, 0.005), 0.15 * rnd() ** 2);
  }
  return finish(d, 0.2);
}

export function sea(sr: number, dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  const d = new Float32Array(len);
  // A breaker every ~7 s, a whole number of them per loop.
  const count = Math.max(1, Math.round(dur / 7));
  const period = len / count;
  const waves = Array.from({ length: count }, (_, k) => ({
    crash: (k + R(-0.2, 0.2)) * period, // sample where it breaks
    rise: R(1.4, 2.6) * sr, // the swell building up before
    wash: R(1.8, 3), // seconds the foam keeps hissing as the water draws back
    size: R(0.55, 1),
  }));
  const swell = wander(rnd, len, sr, 0.1);
  const pink = pinkNoise(rnd);
  const brown = brownNoise(rnd);
  const body = new SVF(sr);
  const kHiss = pole(2500, sr);
  const kRum = pole(250, sr);
  const kEnv = glide(0.03, sr);
  const foam = new Float32Array(len);
  let roar = 0, bright = 0, fizz = 0; // targets, updated every 32 samples
  let roarS = 0, fizzS = 0, hissLp = 0, rum = 0;
  d.set(looped(len, sr, (o) => { for (let i = 0; i < o.length; i++) {
    if ((i & 31) === 0) {
      roar = 0;
      bright = 0;
      fizz = 0;
      for (const w of waves) {
        // Samples since the break, wrapped into [−rise, len − rise) so each wave shows once per loop.
        const x = mod(i - w.crash + w.rise, len) - w.rise;
        if (x < 0) {
          const u = 1 + x / w.rise; // 0 → 1 as the wave builds
          roar += w.size * 0.5 * u ** 3;
          bright = Math.max(bright, w.size * u ** 4);
        } else {
          const t = x / sr;
          roar += w.size * (0.6 * Math.exp(-t / 0.5) + 0.4 * Math.exp(-t / 2)); // the crash, then the wash
          bright = Math.max(bright, w.size * Math.exp(-t / 0.8));
          fizz += w.size * (1 - Math.exp(-t / 0.25)) * Math.exp(-t / w.wash);
        }
      }
      body.set(250 + 4500 * bright ** 1.5, 0.6);
    }
    roarS += kEnv * (roar - roarS);
    fizzS += kEnv * (fizz - fizzS);
    foam[i % len] = fizzS;
    body.run(pink() * 0.8 + brown() * 0.4);
    const w = rnd() * 2 - 1;
    hissLp += kHiss * (w - hissLp);
    const crackle = rnd() < 0.15 ? 1 : 0.3;
    rum += kRum * (brown() - rum);
    o[i] = body.lp * roarS * 1.6 + (w - hissLp) * crackle * fizzS * 0.35 + rum * (0.5 + 0.15 * swell[i % len]);
  } }));
  // Foam: countless tiny bubbles popping while the water drains.
  for (let k = 0, n = Math.round(dur * 250); k < n; k++) {
    const at = Math.floor(rnd() * len);
    if (rnd() < foam[at]) bubble(d, sr, at, R(2500, 7000), R(0.2, 0.6), R(0.001, 0.003), 0.15 * rnd());
  }
  return finish(d, 0.2);
}

export function wind(sr: number, _dur: number, len: number, rnd: Rnd) {
  const d = new Float32Array(len);
  const gust = wander(rnd, len, sr, 0.3);
  const flutter = wander(rnd, len, sr, 6, 2);
  const pink = pinkNoise(rnd);
  const brown = brownNoise(rnd);
  const howl = new SVF(sr);
  const whistle = new SVF(sr);
  const kr = pole(150, sr);
  const kh = pole(3000, sr);
  let rum = 0;
  let hissLp = 0;
  for (let i = 0; i < len; i++) {
    const s = 0.5 + 0.5 * gust[i]; // strength, 0 … 1
    const s2 = s * s;
    if ((i & 15) === 0) {
      // Stronger gusts blow higher; the whistle is air singing through a gap.
      const f = (200 + 700 * s2) * 2 ** (0.12 * flutter[i]);
      howl.set(f, 2.5);
      whistle.set(f * 2.7, 30);
    }
    const x = pink();
    howl.run(x);
    whistle.run(x);
    rum += kr * (brown() - rum);
    const w = rnd() * 2 - 1;
    hissLp += kh * (w - hissLp);
    d[i] = (1 + 0.15 * flutter[i])
      * (howl.bp * (0.3 + 1.2 * s2) + whistle.bp * 4 * s2 * s2 + rum * (0.4 + 0.6 * s) + (w - hissLp) * 0.05 * s2);
  }
  return finish(d, 0.2);
}

/** Vowel formants F1–F3 in Hz (adult male; scaled up for other voices). */
const VOWELS = [
  [730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410],
  [300, 870, 2240], [660, 1720, 2410], [490, 1350, 1690], [440, 1020, 2240],
];

export function crowd(sr: number, _dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  // Voices are made at half the sample rate: the murmur is low-passed far below that Nyquist anyway.
  const vsr = sr / 2;
  const vlen = Math.ceil(len / 2) + 2;
  const v = new Float32Array(vlen);
  const Q = [5, 10, 12];
  const G = [1, 0.45, 0.2];
  const kA = glide(0.025, vsr);
  const kF = glide(0.04, vsr);
  const kP = glide(0.08, vsr);
  const kTilt = pole(900, vsr);
  // Thirty people talking at once, all at conversational distance so no single voice stands out,
  // each in phrases of syllables with pauses between.
  for (let n = 0; n < 30; n++) {
    const female = rnd() < 0.5;
    const pitch0 = female ? R(180, 230) : R(100, 130);
    const fs = female ? R(1.12, 1.18) : R(0.97, 1.03);
    const gain = R(0.5, 1);
    const pace = R(0.9, 1.1);
    const sylls: { at: number; end: number; f: number[]; p: number; amp: number }[] = [];
    for (let t = R(-1.5, 1) * vsr; t < vlen;) {
      let p = pitch0 * R(1.05, 1.15); // a phrase starts a little high and drifts down
      for (let w = 0, words = 4 + Math.floor(rnd() * 10); w < words; w++) {
        const sl = (R(0.14, 0.26) / pace) * vsr;
        const vowel = VOWELS[Math.floor(rnd() * VOWELS.length)];
        sylls.push({ at: t, end: t + sl, f: vowel.map((x) => x * fs), p: p * R(0.97, 1.03), amp: R(0.7, 1) });
        p *= R(0.97, 1);
        t += sl + (R(0.02, 0.06) / pace) * vsr;
      }
      t += R(0.3, 1.2) * vsr; // a breath, or listening to someone else
    }
    const F = [0, 1, 2].map(() => new SVF(vsr));
    const cur = [500 * fs, 1500 * fs, 2500 * fs];
    let amp = 0, pitch = pitch0, ph = 0, s = 0, src = 0;
    for (let i = 0; i < vlen; i++) {
      while (s < sylls.length && sylls[s].end <= i) s++;
      const y = sylls[s];
      const on = !!y && i >= y.at;
      if (!on && amp < 1e-4) continue; // silent: skip the work
      amp += kA * ((on ? y.amp : 0) - amp);
      if (on) {
        for (let k = 0; k < 3; k++) cur[k] += kF * (y.f[k] - cur[k]);
        pitch += kP * (y.p - pitch);
      }
      if ((i & 15) === 0) for (let k = 0; k < 3; k++) F[k].set(cur[k], Q[k]);
      ph += pitch / vsr;
      if (ph >= 1) ph -= 1;
      src += kTilt * (1 - 2 * ph - src); // glottal pulses, softened as voices are from across a room
      const x = src * amp;
      let out = 0;
      for (let k = 0; k < 3; k++) {
        F[k].run(x);
        out += G[k] * F[k].bp;
      }
      v[i] += gain * out;
    }
  }
  // Back up to the full rate, keeping only the band where speech carries in a room.
  const d = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const j = i >> 1;
    d[i] = i & 1 ? (v[j] + v[j + 1]) / 2 : v[j];
  }
  lowpass(d, sr, 3500);
  lowpass(d, sr, 3500);
  // Underneath, speech-shaped noise: all the voices too many and too far off to tell apart.
  const pink = pinkNoise(rnd);
  const bp = new SVF(sr, 550, 0.6);
  const babble = wander(rnd, len, sr, 6, 2);
  const bed = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    bp.run(pink());
    bed[i] = bp.bp * (0.75 + 0.25 * babble[i]);
  }
  const g = (0.35 * rms(d)) / Math.max(1e-9, rms(bed));
  for (let i = 0; i < len; i++) d[i] += g * bed[i];
  return finish(hall(d, sr, 0.5, 1, 0.8, 0.4), 0.2);
}

export function train(sr: number, dur: number, len: number, rnd: Rnd) {
  // Heard riding in a carriage: heavy, dark and felt as much as heard. The walls take the edge off
  // the rolling noise, the floor and frame boom, and every rail joint lands as a thud underfoot.
  const R = uniform(rnd);
  // A 25 m car passes a rail joint every ~1.7 s (about 55 km/h), a whole number of cars per loop.
  const cars = Math.max(1, Math.round(dur / R(1.55, 1.85)));
  const T = len / cars;
  const speed = (25 * sr) / T; // m/s
  const turns = Math.max(1, Math.round((speed / 2.9) * dur)); // turns of a 0.92 m wheel per loop

  // Joints. The two axles of one car's rear bogie strike, then the two of the next car's front bogie
  // (ta-DAM, ta-DAM), then quiet until the next car. Axles are 2.5 m apart, bogies ~7.5 m; spacing is
  // distance over speed, so it scales with the car period.
  const pattern = [0, 0.1, 0.3, 0.4];
  const knock = new Float32Array(len); // steel hitting steel: drives everything below
  const thuds = new Float32Array(len); // the wheelset dropping into the joint
  const rail = new Float32Array(len); // a short, damped ring of wheel and rail
  const railModes = [[R(900, 1100), 0.5, 0.012], [R(1900, 2300), 0.35, 0.008], [R(3100, 3600), 0.2, 0.005]];
  const thudHi = R(150, 180);
  const thudLo = R(50, 60);
  for (let c = 0; c < cars; c++) {
    for (let a = 0; a < 4; a++) {
      const at = (c + pattern[a] + R(-0.003, 0.003)) * T;
      const g = R(0.85, 1) * (a % 2 ? 1 : 0.8); // the second wheel of a pair lands harder
      burst(knock, sr, rnd, at, 0.003, g);
      thud(thuds, sr, at, thudHi, thudLo, 0.11, g);
      ring(rail, sr, at, railModes, g);
    }
  }
  // The knock through bogie and floor: a dull clunk.
  const clunk = knock.slice();
  lowpass(clunk, sr, 700);
  lowpass(clunk, sr, 700);
  // The carriage's floor and frame resonances, struck by the joints and shaken by the rough track.
  const modes = [[R(38, 46), 6, 1], [R(60, 72), 6, 0.8], [R(95, 112), 5, 0.6], [R(150, 175), 4, 0.45], [R(250, 300), 3, 0.3]];
  const boom = resonate(knock, sr, modes, true);
  const brown = brownNoise(rnd);
  const body = looped(len, sr, (o) => {
    const shake = new Float32Array(o.length);
    for (let i = 0; i < o.length; i++) shake[i] = brown();
    o.set(resonate(shake, sr, modes));
  });

  // Rolling: wheels on rail through the floor and walls, a dark roar that pulses with each wheel
  // turn (no wheel is perfectly round), over a deep rumble.
  const sway = wander(rnd, len, sr, 0.5);
  const flats = Array.from({ length: turns }, () => R(0.5, 1));
  const roll = new SVF(sr, R(450, 600), 0.9);
  const low = new SVF(sr, 100, 1);
  const kWall = pole(1400, sr);
  const brown2 = brownNoise(rnd);
  let wall = 0;
  const rollL = looped(len, sr, (o) => {
    for (let i = 0; i < o.length; i++) {
      const c = ((i % len) * turns) / len;
      const k = Math.floor(c);
      const pulse = 1 + 0.3 * flats[k] * (0.5 + 0.5 * Math.cos(TAU * (c - k))) ** 4;
      roll.run(rnd() * 2 - 1);
      wall += kWall * (roll.bp - wall);
      o[i] = wall * pulse;
    }
  });
  const rumble = looped(len, sr, (o) => {
    for (let i = 0; i < o.length; i++) o[i] = low.run(brown2());
  });

  // Mix by loudness: the bed is mostly low rumble and booming body; the joints punch well above it.
  const bed = new Float32Array(len);
  const strikes = new Float32Array(len);
  scaleTo(rumble, 1);
  scaleTo(body, 0.8);
  scaleTo(rollL, 0.4);
  scaleTo(thuds, 1);
  scaleTo(clunk, 0.7);
  scaleTo(boom, 0.9);
  scaleTo(rail, 0.2);
  scaleTo(knock, 0.08);
  for (let i = 0; i < len; i++) {
    const rock = 1 + 0.08 * Math.sin((TAU * i) / T) + 0.1 * sway[i]; // the car swaying on its springs
    bed[i] = (rumble[i] + body[i] + rollL[i]) * rock;
    strikes[i] = thuds[i] + clunk[i] + boom[i] + rail[i] + knock[i];
  }
  scaleTo(strikes, rms(bed) * 0.9);
  for (let i = 0; i < len; i++) bed[i] += strikes[i];
  return finish(bed, 0.2);
}

/** Pitch-dropping sine thud from sample `at`: `f1` falling to `f0` Hz, decaying over `tau` seconds. */
function thud(d: Float32Array, sr: number, at: number, f1: number, f0: number, tau: number, amp: number) {
  const len = d.length;
  at = mod(Math.floor(at), len);
  const n = Math.min(len, Math.ceil(tau * 6 * sr));
  let ph = 0;
  for (let j = 0; j < n; j++) {
    const t = j / sr;
    ph += (TAU * (f0 + (f1 - f0) * Math.exp(-t / 0.02))) / sr;
    d[(at + j) % len] += amp * Math.min(1, t / 0.001) * Math.exp(-t / tau) * Math.sin(ph);
  }
}

/**
 * Run a signal through parallel resonances — [frequency Hz, Q, gain] — and sum them. With `loop`,
 * it runs twice over the input and keeps the second pass, so ringing at the end carries on into the start.
 */
function resonate(x: Float32Array, sr: number, modes: number[][], loop = false) {
  const filters = modes.map(([f, q, g]) => ({ svf: new SVF(sr, f, q), g }));
  const out = new Float32Array(x.length);
  for (let pass = loop ? 0 : 1; pass < 2; pass++) {
    for (let i = 0; i < x.length; i++) {
      let y = 0;
      for (const m of filters) {
        m.svf.run(x[i]);
        y += m.svf.bp * m.g;
      }
      out[i] = y;
    }
  }
  return out;
}

/** Scale in place to an RMS level. */
function scaleTo(d: Float32Array, level: number) {
  const g = level / Math.max(1e-9, rms(d));
  for (let i = 0; i < d.length; i++) d[i] *= g;
  return d;
}

/**
 * A noise layer that loops seamlessly at exactly `len` samples, for sounds whose rhythm must survive
 * the loop. `fill` renders 0.1 s more than needed (index anything periodic with `i % len`); that
 * overrun, which continues straight on from the end, is cross-faded into the start.
 */
function looped(len: number, sr: number, fill: (out: Float32Array) => void) {
  const n = Math.min(Math.floor(0.1 * sr), Math.floor(len / 2));
  const ext = new Float32Array(len + n);
  fill(ext);
  for (let i = 0; i < n; i++) {
    const x = ((i / n) * Math.PI) / 2;
    ext[i] = ext[i] * Math.sin(x) + ext[len + i] * Math.cos(x);
  }
  return ext.slice(0, len);
}

export function factory(sr: number, dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  const d = new Float32Array(len);
  const whole = (hz: number) => Math.max(1, Math.round(hz * dur)) / dur; // nearest frequency with whole cycles per loop

  // Bed: transformer hum, ventilation roar and the rumble of heavy plant through the floor.
  const mains = whole(rnd() < 0.5 ? 50 : 60);
  const pink = pinkNoise(rnd);
  const brown = brownNoise(rnd);
  const brown2 = brownNoise(rnd);
  const vent = new SVF(sr, 700, 0.5);
  const kr = pole(180, sr);
  // Machines running in cycles, each a band of noise pulsed by its own mechanism: a loom-like
  // chatter, a pump's chug, a conveyor's rattle. Every cycle is a little different in strength.
  const machines = [
    { hz: R(7, 11), fc: R(1500, 3000), q: 1.5, att: 0.001, tau: 0.012, level: 0.5, white: true },
    { hz: R(1.4, 2.2), fc: R(180, 320), q: 0.9, att: 0.04, tau: 0.12, level: 1.5, white: false },
    { hz: R(4, 6), fc: R(3000, 5000), q: 1.2, att: 0.0005, tau: 0.006, level: 0.35, white: true },
  ].map((m) => {
    const cycles = Math.max(1, Math.round(m.hz * dur));
    return { ...m, cycles, period: dur / cycles, svf: new SVF(sr, m.fc, m.q), acc: Array.from({ length: cycles }, () => R(0.6, 1)) };
  });
  let rum = 0;
  d.set(looped(len, sr, (o) => {
    for (let i = 0; i < o.length; i++) {
      const t = (i % len) / sr;
      const hum = 0.004 * Math.sin(TAU * mains * t) + 0.015 * Math.sin(TAU * 2 * mains * t)
        + 0.008 * Math.sin(TAU * 4 * mains * t) + 0.005 * Math.sin(TAU * 6 * mains * t);
      rum += kr * (brown() - rum);
      vent.run(pink());
      let x = hum + rum * 0.8 + vent.bp * 0.35;
      for (const m of machines) {
        const c = ((i % len) * m.cycles) / len;
        const k = Math.floor(c);
        const s = (c - k) * m.period; // seconds into this cycle
        const env = s < m.att ? s / m.att : Math.exp(-(s - m.att) / m.tau);
        m.svf.run(m.white ? rnd() * 2 - 1 : brown2());
        x += m.svf.bp * env * m.acc[k] * m.level;
      }
      o[i] = x;
    }
  }));

  // A press stamping every few seconds: a heavy, dull thud and a short clatter of metal. It's fed
  // by hand, so it skips a stroke now and then and isn't quite on time.
  const strokes = Math.max(1, Math.round(dur / R(2.5, 3.5)));
  const P = len / strokes;
  const thuds = new Float32Array(len);
  const thudHz = R(45, 60);
  for (let k = 0; k < strokes; k++) {
    if (strokes > 1 && rnd() < 0.15) continue;
    const at = (k + R(-0.04, 0.04)) * P;
    ring(d, sr, at, [[thudHz, 0.9, 0.07]]);
    burst(thuds, sr, rnd, at, 0.025, 1.4);
    clank(d, sr, rnd, at + 0.004 * sr, R(0.3, 0.45), 400, 5000);
  }
  lowpass(thuds, sr, 350);
  lowpass(thuds, sr, 350);
  for (let i = 0; i < len; i++) d[i] += thuds[i];

  // Clatter: parts dropped into bins and tools set down, at random.
  for (let t = R(0, 1) * sr; t < len; t += R(0.6, 2.5) * sr) {
    let u = t;
    for (let c = 0, n = 1 + Math.floor(rnd() * 4); c < n; c++, u += R(0.04, 0.15) * sr) clank(d, sr, rnd, u, R(0.08, 0.25));
  }

  // Air: pneumatic tools and blow-off valves hissing in short bursts.
  const air = new Float32Array(len);
  for (let t = R(0, 2) * sr; t < len; t += R(1.5, 5) * sr) {
    const n = Math.floor(R(0.12, 0.6) * sr);
    const a = R(0.15, 0.35);
    for (let j = 0; j < n; j++) {
      const e = Math.min(1, j / (0.01 * sr), (n - j) / (0.04 * sr));
      air[(Math.floor(t) + j) % len] += (rnd() * 2 - 1) * e * a;
    }
  }
  highpass(air, sr, 2000);
  for (let i = 0; i < len; i++) d[i] += air[i];

  // All of it in a big, hard hall.
  return finish(hall(d, sr, 0.7, 1.4, 0.86, 0.35), 0.15);
}

export function fire(sr: number, dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  const d = new Float32Array(len);
  const flare = wander(rnd, len, sr, 0.4); // the fire flaring up and settling
  const flicker = wander(rnd, len, sr, 6, 1.5);
  const heat = (i: number) => 0.5 + 0.5 * flare[i];

  // Roar: hot gas rising, a low, breathy rumble that flickers with the flames; a soft hiss above it.
  const brown = brownNoise(rnd);
  const roar = new SVF(sr, 280, 0.7);
  const kh = pole(2500, sr);
  let hissLp = 0;
  for (let i = 0; i < len; i++) {
    roar.run(brown());
    const w = rnd() * 2 - 1;
    hissLp += kh * (w - hissLp);
    d[i] = roar.lp * (0.5 + 0.3 * heat(i) + 0.2 * flicker[i]) * 1.2 + (w - hissLp) * 0.03 * (0.6 + 0.4 * heat(i));
  }

  // Crackle: wood fibres snapping in tight clusters of sharp clicks, busier as the fire flares.
  const crackle = new Float32Array(len);
  for (let k = 0, n = Math.round(dur * 14); k < n; k++) {
    const at = Math.floor(rnd() * len);
    if (rnd() > 0.3 + 0.7 * heat(at)) continue;
    const level = R(0.2, 1);
    let u = at;
    for (let c = 0, m = 1 + Math.floor(rnd() ** 2 * 10); c < m; c++, u += R(0.002, 0.03) * sr) {
      burst(crackle, sr, rnd, u, R(0.0001, 0.0006), level * R(0.3, 1));
    }
  }
  // Pops: pockets of sap bursting, louder, with a short knock of the wood around them.
  for (let k = 0, n = Math.max(1, Math.round(dur * 0.6)); k < n; k++) {
    const at = rnd() * len;
    nwave(crackle, sr, at, R(0.0003, 0.001), R(0.8, 1.5));
    ring(crackle, sr, at, [[R(500, 1200), 0.3, 0.008], [R(1500, 3000), 0.2, 0.005]]);
  }
  highpass(crackle, sr, 800);
  for (let i = 0; i < len; i++) d[i] += crackle[i];
  return finish(d, 0.15);
}

export function vinyl(sr: number, dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  const d = new Float32Array(len);
  // 33⅓ rpm: one turn every 1.8 s, a whole number of turns per loop.
  const turns = Math.max(1, Math.round(dur / 1.8));
  const turn = len / turns;

  // Surface noise: a soft groove hiss that swells a little once per turn (a slightly warped disc),
  // and the turntable's low rumble.
  const brown = brownNoise(rnd);
  const kLo = pole(250, sr);
  const kHi = pole(7000, sr);
  const kr = pole(40, sr);
  let lo = 0, hi = 0, rum = 0;
  d.set(looped(len, sr, (o) => {
    for (let i = 0; i < o.length; i++) {
      hi += kHi * (rnd() * 2 - 1 - hi);
      lo += kLo * (hi - lo);
      rum += kr * (brown() - rum);
      o[i] = (hi - lo) * 0.05 * (1 + 0.2 * Math.sin((TAU * i) / turn)) + rum * 0.3;
    }
  }));

  // Crackle: dust in the groove, a steady patter of tiny ticks and a few bigger pops.
  const clicks = new Float32Array(len);
  const sign = () => (rnd() < 0.5 ? 1 : -1);
  for (let k = 0, n = Math.round(dur * 60); k < n; k++) nwave(clicks, sr, rnd() * len, R(0.00004, 0.00015), sign() * 0.25 * rnd() ** 3);
  for (let k = 0, n = Math.round(dur * 1.2); k < n; k++) nwave(clicks, sr, rnd() * len, R(0.0002, 0.0008), sign() * R(0.3, 0.8));
  // Scratches: a pop at the same spot on every turn.
  for (let s = 0, n = rnd() < 0.75 ? 1 + Math.floor(rnd() * 2) : 0; s < n; s++) {
    const pos = rnd();
    const a = sign() * R(0.4, 0.9);
    const w = R(0.0003, 0.0008);
    for (let t = 0; t < turns; t++) nwave(clicks, sr, (t + pos) * turn, w, a * R(0.85, 1));
  }
  lowpass(clicks, sr, 9000);
  highpass(clicks, sr, 300);
  for (let i = 0; i < len; i++) d[i] += clicks[i];
  return finish(d, 0.025);
}

export function clock(sr: number, dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  // An escapement, not a tone: at each beat a pallet strikes the escape wheel (two or three tiny
  // clicks a few milliseconds apart) and the wooden case answers with a brief, heavily damped knock.
  // Tick and tock differ in the timing and dullness of their clicks, never in pitch.
  const beats = 2 * Math.max(1, Math.round(dur)); // two beats a second, an even number so tick-tock alternates across the loop
  const B = len / beats;
  const lean = R(0, 0.03); // slightly out of beat: tick-to-tock isn't quite as long as tock-to-tick
  const shapes = [0, 1].map(() => [[0, 1], [R(0.002, 0.004), R(0.3, 0.6)], [R(0.006, 0.012), R(0.15, 0.35)]]);
  const ticks = new Float32Array(len);
  const tocks = new Float32Array(len);
  for (let b = 0; b < beats; b++) {
    const tock = b % 2;
    const at = (b + (tock ? lean : 0)) * B;
    const g = R(0.92, 1);
    for (const [off, a] of shapes[tock]) burst(tock ? tocks : ticks, sr, rnd, at + off * sr, R(0.00015, 0.0003), g * a);
  }
  lowpass(tocks, sr, 2500); // the tock is the duller of the two
  const clicks = new Float32Array(len);
  for (let i = 0; i < len; i++) clicks[i] = ticks[i] + 1.6 * tocks[i];
  const box = [[R(500, 700), 6, 1], [R(1100, 1400), 7, 0.8], [R(2200, 2700), 8, 0.6], [R(3800, 4600), 8, 0.4]]; // damped within a few cycles: no pitch
  const knock = scaleTo(resonate(clicks, sr, box, true), 1);
  scaleTo(clicks, 0.35);
  for (let i = 0; i < len; i++) clicks[i] += knock[i];
  return clicks;
}

export function tape(sr: number, dur: number, len: number, rnd: Rnd) {
  const d = new Float32Array(len);
  // Hiss: white noise leaning towards the treble, as tape hiss does, rolled off above ~14 kHz by the head.
  const breath = wander(rnd, len, sr, 12, 3); // modulation noise: the coating isn't perfectly even
  const kLo = pole(1200, sr);
  const kTop = pole(14000, sr);
  // A faint hum from the deck, at whole cycles per loop.
  const mains = Math.max(1, Math.round((rnd() < 0.5 ? 50 : 60) * dur)) / dur;
  let lo = 0, top = 0;
  for (let i = 0; i < len; i++) {
    top += kTop * (rnd() * 2 - 1 - top);
    lo += kLo * (top - lo);
    const t = i / sr;
    d[i] = (top - 0.7 * lo) * (1 + 0.05 * breath[i]) + 0.004 * Math.sin(TAU * mains * t) + 0.002 * Math.sin(TAU * 3 * mains * t);
  }
  return finish(d, 0.2);
}

export function thunder(sr: number, dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  const d = new Float32Array(len);
  // One strike, or (more often, when there's room) two: the second lands while the first is still
  // rumbling, so they run into each other. Each is at its own distance around where the storm is.
  const storm = rnd(); // 0: far off … 1: overhead
  const count = dur >= 3 && rnd() < 0.6 ? 2 : 1;
  let at = Math.min(R(0.05, 0.3) * sr, len * 0.3);
  for (let k = 0; k < count && (k === 0 || at < len * 0.7); k++, at += R(0.8, 2.2) * sr) {
    strike(d, sr, dur, rnd, at, Math.min(1, Math.max(0, storm + R(-0.3, 0.3))));
  }
  // Below ~30 Hz is felt, not heard; it would only use up headroom and leave the rest quiet.
  highpass(d, sr, 30);
  highpass(d, sr, 30);
  // Squeeze the blasts down towards the rolling tails, so the whole storm comes out loud.
  compress(d, sr, 0.08, 3);
  // Fade the last fifth so the tail ends cleanly whatever the length.
  const fadeFrom = Math.floor(len * 0.8);
  for (let i = fadeFrom; i < len; i++) d[i] *= Math.cos((((i - fadeFrom) / (len - fadeFrom)) * Math.PI) / 2) ** 2;
  return finish(d, 0.3);
}

/** Add one lightning strike's thunder from sample `t0`; `near` runs from 0 (far off) to 1 (overhead). */
function strike(d: Float32Array, sr: number, dur: number, rnd: Rnd, t0: number, near: number) {
  const R = uniform(rnd);
  const len = d.length;
  const loud = 0.55 + 0.45 * near;
  const span = Math.min(dur * 0.5, R(2.5, 5)); // seconds over which the channel's sound arrives

  // Rumble: the channel is kilometres long, so its sound arrives bit by bit — overlapping rolls of
  // low noise, fading and darkening as they come from farther away. The nearest part of the channel
  // arrives first, as one sudden blast.
  const rolls = Array.from({ length: 10 + Math.floor(rnd() * 10) }, () => {
    const s = rnd() ** 1.7 * span;
    return { at: t0 + s * sr, amp: R(0.3, 1) * Math.exp(-s / R(2, 3.5)), att: R(0.05, 0.4) * sr, dec: R(0.4, 1.8) * sr };
  });
  rolls.push({ at: t0, amp: R(1.2, 1.6), att: R(0.01, 0.03) * sr, dec: R(0.3, 0.6) * sr });
  const brown = brownNoise(rnd);
  const brown2 = brownNoise(rnd);
  const pink = pinkNoise(rnd);
  const body = new SVF(sr);
  const kSub = pole(60, sr);
  const kEnv = glide(0.02, sr);
  let env = 0, envS = 0, sub = 0, rumblePeak = 0;
  for (let i = Math.floor(t0); i < len; i++) {
    if ((i & 31) === 0) {
      env = 0;
      for (const r of rolls) {
        const x = i - r.at;
        if (x > 0) env += r.amp * (x < r.att ? x / r.att : Math.exp(-(x - r.att) / r.dec));
      }
      const age = Math.max(0, (i - t0) / sr);
      body.set(150 + (500 + 2000 * near) * Math.exp(-age / 1.5), 0.8);
    }
    envS += kEnv * (env - envS);
    body.run(brown() * 0.7 + pink() * 0.5);
    sub += kSub * (brown2() - sub);
    // The sub is kept modest: it is felt more than heard, and too much of it leaves the rest quiet.
    const v = (body.lp + sub * 0.8) * envS * loud;
    d[i] += v;
    rumblePeak = Math.max(rumblePeak, Math.abs(v));
  }

  // Crackle: shock waves from the channel's countless kinks. First a tearing rip, then (a flash often
  // has several return strokes) fainter rips a few tens of milliseconds apart; then crackles all
  // through the rolling rumble, thinning out as it fades. Duller from farther away.
  const crack = new Float32Array(len);
  let from = t0;
  let amp = 1;
  for (let s = 0, strokes = 1 + Math.floor(rnd() * 3); s < strokes; s++) {
    for (let j = 0, n = Math.min(len - from, (s ? R(0.15, 0.4) : R(0.5, 1.2)) * sr); j < n; j++) {
      const t = j / sr;
      if (rnd() < 0.04 * Math.exp(-t / 0.35)) nwave(crack, sr, from + j, R(0.0003, 0.002), amp * R(0.3, 1) * Math.exp(-t / 0.5));
    }
    from += R(0.04, 0.15) * sr;
    amp *= R(0.4, 0.75);
  }
  const envPeak = rolls.reduce((m, r) => m + r.amp, 0);
  for (let k = 0, n = Math.round(R(40, 80) * span); k < n; k++) {
    const at = t0 + rnd() ** 1.3 * span * sr;
    if (at >= len) continue;
    let e = 0;
    for (const r of rolls) {
      const x = at - r.at;
      if (x > 0) e += r.amp * (x < r.att ? x / r.att : Math.exp(-(x - r.att) / r.dec));
    }
    nwave(crack, sr, at, R(0.0005, 0.003), (rnd() < 0.5 ? 1 : -1) * rnd() ** 2 * 0.6 * Math.min(1, e / envPeak * 2));
  }
  highpass(crack, sr, 200);
  lowpass(crack, sr, 2000 + 6000 * near);
  // Matched to this strike's rumble by peak (the crackle is brief, so its average says little).
  const top = crack.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const g = (rumblePeak * (0.5 + 0.7 * near)) / Math.max(1e-9, top);
  for (let i = 0; i < len; i++) d[i] += crack[i] * g;
}

/**
 * Feed-forward compressor, in place: above `thr` (a fraction of the peak), level grows only 1/`ratio`
 * as fast. Brings quiet tails and distant parts up towards the loud blasts.
 */
function compress(d: Float32Array, sr: number, thr: number, ratio: number, attack = 0.005, release = 0.25) {
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const t = thr * peak;
  const ka = glide(attack, sr);
  const kr = glide(release, sr);
  let env = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    env += (a > env ? ka : kr) * (a - env);
    if (env > t) d[i] *= (env / t) ** (1 / ratio - 1);
  }
}

export function mosquito(sr: number, _dur: number, len: number, rnd: Rnd) {
  const R = uniform(rnd);
  const d = new Float32Array(len);
  const f0 = R(480, 620); // wingbeats per second
  const drift = wander(rnd, len, sr, 0.5); // banking and climbing: the whine slides
  const dart = wander(rnd, len, sr, 3, 1); // quick darts and hovers
  const level = wander(rnd, len, sr, 0.7);
  // Wing strokes aren't sine-pure: a buzz rich in harmonics, each with its own phase.
  const H = [1, 0.7, 0.5, 0.35, 0.25, 0.15, 0.1, 0.06].map((a) => [a, rnd() * TAU]);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    ph += (TAU * f0 * (1 + 0.04 * drift[i] + 0.015 * dart[i])) / sr;
    if (ph > TAU) ph -= TAU;
    let x = 0;
    for (let k = 0; k < H.length; k++) x += H[k][0] * Math.sin((k + 1) * ph + H[k][1]);
    d[i] = x * (0.7 + 0.3 * level[i]) + (rnd() * 2 - 1) * 0.02;
  }
  return finish(d, 0.25);
}
