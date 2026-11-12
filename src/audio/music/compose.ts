// The composer: turns MusicParams + seed into a form (sections with an energy level), a chord
// timeline, and note / drum events per track.
//
// Each section has a label (intro, A, B, C, outro); sections with the same label reuse the same
// generated material, so a piece has recognizable verses and choruses. Energy decides which tracks
// play (each track enters at a threshold), how many drum voices join in, how dense and loud parts are,
// and where fills, builds and crashes go.
import { between, gauss, int, pickOf, rngFor, weighted, type Rng } from './rng';
import { chordPcs, degSemi, markovProgression, parseProgression, PROGRESSIONS, SCALES, type Chord } from './theory';
import { barSeconds, type DrumStyle, type MusicParams, type PitchAlgo, type RhythmAlgo, type TrackParams } from './types';
import type { DrumVoice } from './drums';

export type Label = 'intro' | 'A' | 'B' | 'C' | 'outro';

export interface Section {
  index: number;
  /** First bar. */
  start: number;
  bars: number;
  energy: number;
  label: Label;
  /** The next section is clearly louder: build up at the end of this one. */
  rise: boolean;
}

export interface NoteEv {
  t: number;
  dur: number;
  midi: number;
  vel: number;
}

export interface DrumEv {
  t: number;
  voice: DrumVoice;
  vel: number;
}

export interface Plan {
  sections: Section[];
  beat: number;
  bar: number;
  total: number;
  chords: Record<'A' | 'B' | 'C', Chord[]>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const material = (l: Label): 'A' | 'B' | 'C' => (l === 'intro' || l === 'outro' ? 'A' : l);

// ---------------------------------------------------------------- form

export const FORMS: Record<string, string> = {
  loop: 'Loop (steady)',
  song: 'Song (intro, verse, chorus, bridge, outro)',
  build: 'Build-up (layers keep entering)',
  arc: 'Arc (rise, peak, fade)',
  waves: 'Waves (swells and lulls)',
  random: 'Random walk',
};

const SONG_ENERGY: Record<Label, number> = { intro: 0.25, A: 0.55, B: 0.95, C: 0.35, outro: 0.2 };

function labelFor(e: number): Label {
  return e >= 0.72 ? 'B' : e < 0.32 ? 'C' : 'A';
}

export function planSections(p: MusicParams, seed: number): Section[] {
  const n = Math.max(1, Math.ceil(p.bars / p.sectionBars));
  const r = rngFor(seed, 'form');
  let labels: Label[] = [];
  let energies: number[] = [];
  switch (p.form) {
    case 'song': {
      const intro = n >= 4;
      const outro = n >= 5;
      const m = n - +intro - +outro;
      const mid: Label[] = [];
      while (mid.length < m) mid.push('A', 'B');
      mid.length = m;
      if (mid[m - 1] !== 'B') mid[m - 1] = 'B';
      if (n >= 7) mid[m - 2] = 'C';
      labels = [...(intro ? ['intro' as Label] : []), ...mid, ...(outro ? ['outro' as Label] : [])];
      let seen = 0;
      energies = labels.map((l) => SONG_ENERGY[l] + (l === 'A' || l === 'B' ? Math.min(0.1, 0.05 * (l === 'A' ? seen++ : 0)) : 0));
      break;
    }
    case 'build':
      energies = Array.from({ length: n }, (_, i) => (n === 1 ? 1 : 0.15 + (0.85 * i) / (n - 1)));
      labels = energies.map((e, i) => (i === 0 && n >= 3 ? 'intro' : e >= 0.72 ? 'B' : 'A'));
      break;
    case 'arc':
      energies = Array.from({ length: n }, (_, i) => 0.12 + 0.88 * Math.sin((Math.PI * (i + 0.5)) / n));
      labels = energies.map((e, i) => (n >= 4 && i === 0 ? 'intro' : n >= 4 && i === n - 1 ? 'outro' : e >= 0.72 ? 'B' : 'A'));
      break;
    case 'waves':
      energies = Array.from({ length: n }, (_, i) => 0.55 - 0.4 * Math.cos((Math.PI * 2 * i) / 4));
      labels = energies.map(labelFor);
      break;
    case 'random': {
      let e = between(r, 0.3, 0.6);
      for (let i = 0; i < n; i++) {
        energies.push(e);
        e = clamp(e + (r() - 0.5) * 0.7, 0.1, 1);
      }
      labels = energies.map(labelFor);
      break;
    }
    default:
      energies = Array(n).fill(p.energy);
      labels = Array(n).fill('A');
  }
  if (p.form !== 'loop') energies = energies.map((e) => clamp(e + (p.energy - 0.7) * 0.6, 0.05, 1));
  const out: Section[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * p.sectionBars;
    out.push({ index: i, start, bars: Math.min(p.sectionBars, p.bars - start), energy: energies[i], label: labels[i], rise: false });
  }
  for (let i = 0; i + 1 < n; i++) out[i].rise = out[i + 1].energy - out[i].energy >= 0.2;
  return out;
}

export function makePlan(p: MusicParams, seed: number): Plan {
  const beat = 60 / p.tempo;
  const bar = barSeconds(p);
  const size = clamp(Math.round(p.chordSize), 3, 5);
  const chords = {} as Plan['chords'];
  for (const l of ['A', 'B', 'C'] as const) {
    chords[l] = p.progression === 'markov'
      ? markovProgression(rngFor(seed, 'prog', l), p.scale, size, 4)
      : parseProgression(PROGRESSIONS[p.progression]?.spec ?? p.progression, p.scale, size);
  }
  return { sections: planSections(p, seed), beat, bar, total: p.bars * bar, chords };
}

/**
 * How much a track plays in a section: 0 = silent, otherwise 0.15–1, rising with how far the
 * section's energy is above the track's entry threshold.
 */
export function trackLevel(p: MusicParams, sec: Section, tr: TrackParams, seed: number) {
  if (!tr.on || sec.energy < tr.enter - 1e-9) return 0;
  // With variation, parts that aren't the foundation sometimes sit a section out.
  if (tr.enter > 0.02 && p.variation > 0 && sec.label !== 'intro' && rngFor(seed, tr.id, tr.salt, 'sitout', sec.index)() < p.variation * 0.22) return 0;
  return 0.15 + 0.85 * clamp((sec.energy - tr.enter) / Math.max(0.15, 1 - tr.enter), 0, 1);
}

/** Chord sounding at a beat offset within a section. */
function chordAt(p: MusicParams, plan: Plan, sec: Section, beatInSec: number) {
  const prog = plan.chords[material(sec.label)];
  const per = Math.max(0.5, p.chordBars) * p.meter;
  const i = Math.floor(beatInSec / per + 1e-6);
  return { chord: prog[i % prog.length], next: prog[(i + 1) % prog.length], spanStart: i * per, spanEnd: (i + 1) * per };
}

/** The chords of a section in order, with their spans in beats from its start. */
export function sectionChords(p: MusicParams, plan: Plan, sec: Section) {
  const per = Math.max(0.5, p.chordBars) * p.meter;
  const end = sec.bars * p.meter;
  const out: { chord: Chord; start: number; end: number }[] = [];
  for (let b = 0; b < end - 1e-6; b += per) out.push({ chord: chordAt(p, plan, sec, b).chord, start: b, end: Math.min(end, b + per) });
  return out;
}

// ---------------------------------------------------------------- labels

export const ALGOS: Record<PitchAlgo, string> = {
  markov: 'Markov melody (steps, leaps resolve)',
  walk: 'Random walk',
  motif: 'Motif & variations',
  pink: '1/f fractal noise',
  automaton: 'Cellular automaton',
  lsystem: 'L-system',
  arpUp: 'Arpeggio ↑',
  arpDown: 'Arpeggio ↓',
  arpUpDown: 'Arpeggio ↑↓',
  arpRandom: 'Arpeggio, random order',
  chord: 'Chords (voice-led)',
  bass: 'Bass line (root, fifth, approach)',
  walking: 'Walking bass',
  drone: 'Drone (tonic)',
};

export const RHYTHMS: Record<RhythmAlgo, string> = {
  phrase: 'Phrased (varied lengths, rests)',
  steady: 'Steady (every step)',
  euclid: 'Euclidean (evenly spread)',
  random: 'Random',
  syncopated: 'Syncopated (off-beats)',
  sustain: 'Held (one per chord)',
};

export const STEPS: readonly (readonly [string, string])[] = [
  ['0.5', 'Half notes'], ['1', 'Quarter notes'], ['2', 'Eighths'], ['3', 'Eighth triplets'], ['4', 'Sixteenths'],
];

// ---------------------------------------------------------------- rhythm

interface Onset {
  /** Grid step within the phrase. */
  pos: number;
  len: number;
  acc: number;
  /** Pitch value; meaning depends on the algorithm. */
  v: number;
}

function accent(pos: number, n: number, meter: number) {
  const perBeat = n / meter;
  const inBar = pos % n;
  if (inBar === 0) return 1;
  if (Number.isInteger(perBeat) && inBar % perBeat === 0) return 0.9;
  if (Number.isInteger(perBeat / 2) && inBar % (perBeat / 2) === 0) return 0.75;
  return 0.62;
}

/** Evenly spread k pulses over n steps (Bjorklund / Bresenham), starting on step 0. */
export function euclid(k: number, n: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(((i + 1) * k) / n) - Math.floor((i * k) / n) === 1);
  // Rotate so the first pulse is on step 0.
  const first = out.indexOf(true);
  return first > 0 ? [...out.slice(first), ...out.slice(0, first)] : out;
}

/** Note start positions within one bar of n steps. `len` is filled for the 'phrase' rhythm only. */
function barRhythm(kind: string, n: number, meter: number, density: number, r: Rng, rot: number): { pos: number; len?: number }[] {
  const out: { pos: number; len?: number }[] = [];
  const onBeat = (i: number) => accent(i, n, meter) >= 0.9;
  switch (kind) {
    case 'steady':
      for (let i = 0; i < n; i++) out.push({ pos: i });
      break;
    case 'euclid': {
      const pat = euclid(clamp(Math.round(density * n), 1, n), n);
      for (let i = 0; i < n; i++) if (pat[(i - rot + n) % n]) out.push({ pos: i });
      break;
    }
    case 'syncopated':
      for (let i = 0; i < n; i++) if (r() < density * (i === 0 ? 1.1 : onBeat(i) ? 0.55 : 1.35)) out.push({ pos: i });
      break;
    case 'random':
      for (let i = 0; i < n; i++) if (r() < density * (i === 0 ? 1.6 : onBeat(i) ? 1.2 : 0.8)) out.push({ pos: i });
      break;
    default: {
      // 'phrase': note lengths drawn like a melody, shorter when denser, with rests.
      const lens = [1, 2, 3, 4, 6, 8];
      const w = lens.map((l) => Math.exp(-Math.abs(Math.log2(l) - (1 - density) * 3) * 1.4));
      let pos = 0;
      while (pos < n) {
        const l = Math.min(lens[weighted(r, w)], n - pos);
        if (r() > (1 - density) * 0.45 || pos === 0) out.push({ pos, len: l });
        pos += l;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- pitch algorithms

/** Melodic interval weights for the Markov melody: steps over leaps, repeated notes rare. */
const MARKOV_IV = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const MARKOV_W = [0.5, 0.8, 2.2, 4, 0.7, 4, 2.2, 0.8, 0.5];

function markovSeq(count: number, r: Rng, half: number, start = 0) {
  const out: number[] = [];
  let v = start;
  let prev = 0;
  for (let i = 0; i < count; i++) {
    out.push(v);
    const w = MARKOV_W.map((x, j) => {
      const iv = MARKOV_IV[j];
      let y = x;
      // After a leap, step back the other way; after a step, keep going a little more often.
      if (Math.abs(prev) >= 3) y *= Math.sign(iv) === -Math.sign(prev) && Math.abs(iv) <= 2 ? 3 : 0.2;
      else if (prev && Math.sign(iv) === Math.sign(prev)) y *= 1.3;
      // Stay within range, drifting back toward the centre.
      if (Math.abs(v + iv) > half) y *= 0.05;
      if (Math.abs(v) > half * 0.6 && Math.sign(iv) === Math.sign(v)) y *= 0.5;
      return y;
    });
    prev = MARKOV_IV[weighted(r, w)];
    v += prev;
  }
  return out;
}

function walkSeq(count: number, r: Rng, half: number) {
  const out: number[] = [];
  let v = 0;
  for (let i = 0; i < count; i++) {
    out.push(v);
    let step = [-2, -1, 0, 1, 2][weighted(r, [1, 4, 1.5, 4, 1])];
    if (r() < 0.12) step = (r() < 0.5 ? -1 : 1) * int(r, 3, 5);
    v += step;
    if (v > half) v = 2 * half - v;
    if (v < -half) v = -2 * half - v;
    v = clamp(v, -half, half);
  }
  return out;
}

/** 1/f ("pink") noise by the Voss–McCartney method: several dice, each re-rolled half as often. */
function pinkSeq(count: number, r: Rng, half: number) {
  const rows = [r(), r(), r(), r(), r()];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < rows.length; j++) if (i % (1 << j) === 0) rows[j] = r();
    const s = rows.reduce((a, b) => a + b, 0) / rows.length; // 0..1, centred at 0.5
    out.push(Math.round((s - 0.5) * 2.6 * half));
  }
  return out.map((v) => clamp(v, -half, half));
}

const CA_RULES = [30, 45, 73, 86, 89, 90, 105, 110, 150];

/** Elementary cellular automaton: cells are scale degrees; each step plays a live cell near the last note. */
function automatonSeq(count: number, r: Rng, half: number) {
  const W = clamp(2 * half + 1, 5, 25);
  const rule = pickOf(r, CA_RULES);
  let row = Array.from({ length: W }, () => r() < 0.3);
  const out: number[] = [];
  let prev = Math.floor(W / 2);
  for (let i = 0; i < count; i++) {
    row = row.map((_, j) => {
      const idx = (+row[(j - 1 + W) % W] << 2) | (+row[j] << 1) | +row[(j + 1) % W];
      return ((rule >> idx) & 1) === 1;
    });
    let live = row.flatMap((c, j) => (c ? [j] : []));
    if (!live.length) {
      row[int(r, 0, W - 1)] = true;
      live = row.flatMap((c, j) => (c ? [j] : []));
    }
    const pick = r() < 0.7 ? live.reduce((a, b) => (Math.abs(b - prev) < Math.abs(a - prev) ? b : a)) : pickOf(r, live);
    prev = pick;
    out.push(pick - Math.floor(W / 2));
  }
  return out;
}

const LSYS: Record<string, string>[] = [
  { F: 'F+F--F+F' },
  { F: 'F[+F]F[-F]F' },
  { F: 'FF-[-F+F+F]+[+F-F-F]' },
  { F: 'F+G', G: 'F-G' },
  { F: 'F-F++F-F' },
  { F: 'G[+F]-F', G: 'GG' },
];

/** L-system: rewrite a string a few times, then read it as a melody (F/G play, +/− step, [ ] remember / return). */
function lsystemSeq(count: number, r: Rng, half: number) {
  const rules = pickOf(r, LSYS);
  let s = 'F';
  for (let it = 0; it < 6 && s.length < count * 3; it++) s = s.replace(/[FG]/g, (c) => rules[c] ?? c);
  const step = r() < 0.6 ? 1 : 2;
  const out: number[] = [];
  const stack: number[] = [];
  let v = 0;
  for (let k = 0; out.length < count && k < s.length * 4; k++) {
    const c = s[k % s.length];
    if (c === 'F' || c === 'G') out.push(v);
    else if (c === '+') v += step;
    else if (c === '-') v -= step;
    else if (c === '[') stack.push(v);
    else if (c === ']') v = stack.pop() ?? 0;
    if (v > half) v = 2 * half - v;
    if (v < -half) v = -2 * half - v;
    v = clamp(v, -half, half);
  }
  while (out.length < count) out.push(0);
  return out;
}

const SCALE_ALGOS = new Set(['markov', 'walk', 'motif', 'pink', 'automaton', 'lsystem']);
const ARP_ALGOS = new Set(['arpUp', 'arpDown', 'arpUpDown', 'arpRandom']);

/** Grid steps per bar for a track. */
export const stepsPerBar = (p: MusicParams, tr: TrackParams) => Math.max(1, Math.round(p.meter * tr.step));

/** One phrase (P bars) of abstract material: rhythm plus pitch values. */
function makePhrase(p: MusicParams, tr: TrackParams, P: number, n: number, chordSteps: number, r: Rng): Onset[] {
  const half = Math.max(1, Math.round(((tr.range / 12) * (SCALES[p.scale] ?? SCALES.major).steps.length) / 2));
  const total = P * n;
  let ons: Onset[] = [];

  if (tr.rhythm === 'sustain' || tr.algo === 'drone') {
    const span = tr.algo === 'drone' ? total : Math.max(1, Math.round(chordSteps));
    for (let pos = 0; pos < total; pos += span) ons.push({ pos, len: Math.min(span, total - pos), acc: 1, v: 0 });
  } else if (tr.algo === 'motif') {
    // A one-bar motif, then repeats, sequences (transposed), inversions and a varied cadence.
    const rot = r() < 0.5 ? 0 : int(r, 1, n - 1);
    const rhythm = barRhythm(tr.rhythm, n, p.meter, tr.density, r, rot);
    const motif = markovSeq(rhythm.length, r, Math.max(2, Math.round(half * 0.6)));
    const shift = int(r, 1, 3) * (r() < 0.5 ? -1 : 1);
    for (let b = 0; b < P; b++) {
      const kind = b === 0 ? 'id' : b % 4 === 1 ? 'seq' : b % 4 === 2 ? (r() < 0.5 ? 'id' : 'inv') : b % 4 === 3 ? 'vary' : 'id';
      rhythm.forEach((o, i) => {
        let v = motif[i];
        if (kind === 'seq') v += shift;
        if (kind === 'inv') v = motif[0] - (v - motif[0]);
        if (kind === 'vary' && i >= rhythm.length / 2) v += int(r, -2, 2);
        ons.push({ pos: b * n + o.pos, len: o.len ?? 0, acc: accent(o.pos, n, p.meter), v: clamp(v, -half, half) });
      });
    }
  } else {
    const rot = r() < 0.5 ? 0 : int(r, 1, n - 1);
    for (let b = 0; b < P; b++) {
      for (const o of barRhythm(tr.rhythm, n, p.meter, tr.density, r, rot)) {
        ons.push({ pos: b * n + o.pos, len: o.len ?? 0, acc: accent(o.pos, n, p.meter), v: 0 });
      }
    }
    const c = ons.length;
    const seq = tr.algo === 'walk' ? walkSeq(c, r, half)
      : tr.algo === 'pink' ? pinkSeq(c, r, half)
      : tr.algo === 'automaton' ? automatonSeq(c, r, half)
      : tr.algo === 'lsystem' ? lsystemSeq(c, r, half)
      : tr.algo === 'markov' ? markovSeq(c, r, half)
      : null;
    if (seq) ons.forEach((o, i) => (o.v = seq[i]));
    // Bass lines: root on chord changes, then fifths, octaves, thirds and approach notes.
    if (tr.algo === 'bass') ons.forEach((o) => (o.v = o.pos % Math.max(1, Math.round(chordSteps)) === 0 ? 0 : weighted(r, [4.5, 2, 1.5, 1, 1])));
    if (tr.algo === 'arpRandom') ons.forEach((o) => (o.v = int(r, 0, 31)));
  }
  // Lengths: up to the next note (rhythms that don't choose their own).
  ons.sort((a, b) => a.pos - b.pos);
  ons.forEach((o, i) => {
    if (!o.len) o.len = Math.min((ons[i + 1]?.pos ?? total) - o.pos, n * 2);
  });
  ons = ons.filter((o) => o.len > 0);
  return ons;
}

// ---------------------------------------------------------------- realization

/** Voice a chord near `center` with `count` notes, moving as little as possible from `prev`. */
function voiceChord(key: number, c: Chord, count: number, center: number, prev: number[] | null) {
  const tones: number[] = [];
  for (let k = 0; k < count; k++) tones.push(c.ivs[k % c.ivs.length] + 12 * Math.floor(k / c.ivs.length));
  let best: number[] = [];
  let bestCost = Infinity;
  const base = center - 6 + ((((c.root + key - (center - 6)) % 12) + 12) % 12);
  for (let inv = 0; inv < tones.length; inv++) {
    for (const oct of [-12, 0]) {
      const v = tones.map((t, k) => base + oct + t + (k < inv ? 12 : 0)).sort((a, b) => a - b);
      const mid = (v[0] + v[v.length - 1]) / 2;
      let cost = Math.abs(mid - center) * 0.6;
      if (prev?.length) cost += v.reduce((s, x, k) => s + Math.abs(x - prev[Math.min(k, prev.length - 1)]), 0) / v.length;
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
    }
  }
  return best;
}

/** Nearest pitch to `midi` whose pitch class (relative to the key) is in `pcs`. */
function snap(midi: number, key: number, pcs: number[]) {
  for (let d = 0; d <= 6; d++) {
    for (const s of [-1, 1]) {
      const m = midi + s * d;
      if (pcs.includes((((m - key) % 12) + 12) % 12)) return m;
    }
  }
  return midi;
}

/** Note events for a pitched track. */
export function noteEvents(p: MusicParams, plan: Plan, tr: TrackParams, seed: number): NoteEv[] {
  const out: NoteEv[] = [];
  const steps = (SCALES[p.scale] ?? SCALES.major).steps;
  const n = stepsPerBar(p, tr);
  const stepSec = plan.bar / n;
  const center = 12 * (tr.octave + 1) + p.key;
  const tonic = center;
  const chordSteps = Math.max(0.5, p.chordBars) * n;
  const phrases = new Map<string, Onset[]>();
  let voicing: number[] | null = null;
  const swingOn = tr.step === 2 || tr.step === 4;

  for (const sec of plan.sections) {
    const level = trackLevel(p, sec, tr, seed);
    if (!level) continue;
    const mat = material(sec.label);
    const prog = plan.chords[mat];
    const P = clamp(Math.ceil(prog.length * Math.max(0.5, p.chordBars)), 1, Math.min(8, Math.max(1, sec.bars)));
    const pkey = `${mat}:${P}`;
    if (!phrases.has(pkey)) phrases.set(pkey, makePhrase(p, tr, P, n, chordSteps, rngFor(seed, tr.id, tr.salt, 'phrase', mat, P)));
    const phrase = phrases.get(pkey)!;
    const r = rngFor(seed, tr.id, tr.salt, 'play', sec.index);
    const energyVel = 0.5 + 0.5 * sec.energy;
    let walkPrev: number | null = null;

    const reps = Math.ceil(sec.bars / P);
    for (let rep = 0; rep < reps; rep++) {
      phrase.forEach((o, idx) => {
        const posInSec = rep * P * n + o.pos;
        if (posInSec >= sec.bars * n) return;
        const isSustain = tr.rhythm === 'sustain' || tr.algo === 'drone' || tr.algo === 'chord';
        // Quieter sections thin out the weak-beat notes; later repeats change a little.
        if (!isSustain && o.acc < 0.9 && r() < (0.65 - level) * 0.8) return;
        if (rep > 0 && o.acc < 0.9 && r() < p.variation * 0.12) return;
        let v = o.v;
        if (rep > 0 && SCALE_ALGOS.has(tr.algo) && r() < p.variation * 0.3) v += pickOf(r, [-2, -1, 1, 2]);

        const beatInSec = (posInSec * stepSec) / plan.beat;
        const { chord, next, spanStart, spanEnd } = chordAt(p, plan, sec, beatInSec);
        const pcs = chordPcs(chord);
        const lenSteps = Math.min(o.len, ((spanEnd - beatInSec) * plan.beat) / stepSec + (isSustain ? 0 : n));
        let dur = Math.max(0.03, lenSteps * stepSec * tr.legato);
        const notes: number[] = [];
        const rootNear = (c: Chord, ctr: number) => ctr - 6 + ((((c.root + p.key - (ctr - 6)) % 12) + 12) % 12);

        if (SCALE_ALGOS.has(tr.algo)) {
          let m = tonic + degSemi(v, steps);
          const last = idx === phrase.length - 1;
          const pSnap = last ? Math.max(p.consonance, 0.5) : o.acc >= 0.9 ? p.consonance : p.consonance * 0.25;
          if (r() < pSnap) m = last && r() < 0.6 ? snap(m, p.key, [chord.root]) : snap(m, p.key, pcs);
          notes.push(m);
          // Parallel harmony a third (and fifth…) below, in the scale.
          const d0 = Math.round(v);
          for (let k = 1; k < tr.voices; k++) notes.push(tonic + degSemi(d0 - 2 * k, steps) + (m - (tonic + degSemi(v, steps))));
        } else if (ARP_ALGOS.has(tr.algo)) {
          const per = Math.max(2, Math.min(tr.voices, 6));
          const tones: number[] = [];
          for (let k = 0; k < per; k++) tones.push(chord.ivs[k % chord.ivs.length] + 12 * Math.floor(k / chord.ivs.length));
          const octs = Math.max(1, Math.round(tr.range / 12));
          const base = rootNear(chord, center);
          const list: number[] = [];
          for (let oc = 0; oc < octs; oc++) for (const t of tones) list.push(base + 12 * oc + t);
          const N = list.length;
          const k = Math.round((beatInSec - spanStart) * plan.beat / stepSec);
          const i = tr.algo === 'arpUp' ? k % N
            : tr.algo === 'arpDown' ? N - 1 - (k % N)
            : tr.algo === 'arpUpDown' ? (N < 2 ? 0 : (() => { const q = k % (2 * N - 2); return q < N ? q : 2 * N - 2 - q; })())
            : o.v % N;
          notes.push(list[i]);
        } else if (tr.algo === 'chord') {
          voicing = voiceChord(p.key, chord, Math.max(1, tr.voices), center, voicing);
          notes.push(...voicing);
        } else if (tr.algo === 'drone') {
          notes.push(tonic);
          if (tr.voices >= 2) notes.push(tonic + 7);
          if (tr.voices >= 3) notes.push(tonic + 12);
          if (tr.voices >= 4) notes.push(tonic + degSemi(2, steps));
          dur = Math.max(dur, o.len * stepSec);
        } else if (tr.algo === 'bass' || tr.algo === 'walking') {
          const root = rootNear(chord, center);
          const nextRoot = rootNear(next, center);
          const toEnd = (spanEnd - beatInSec) * plan.beat;
          const lastInSpan = toEnd <= o.len * stepSec + 1e-6;
          if (tr.algo === 'walking') {
            let m: number;
            if (Math.abs(beatInSec - spanStart) < 1e-6 || walkPrev === null) m = root;
            else if (lastInSpan) m = nextRoot + (nextRoot >= walkPrev ? -1 : 1);
            else {
              // Step through chord and scale tones toward the next root.
              const dir = Math.sign(nextRoot - walkPrev) || (r() < 0.5 ? 1 : -1);
              const cands = [1, 2, 3, 4].map((d) => walkPrev! + dir * d).filter((x) => pcs.includes((((x - p.key) % 12) + 12) % 12) || steps.includes((((x - p.key) % 12) + 12) % 12));
              m = cands.length ? cands[r() < 0.6 ? 0 : Math.min(1, cands.length - 1)] : walkPrev + dir * 2;
            }
            walkPrev = m;
            notes.push(m);
          } else {
            // Approach notes only lead into a chord change.
            const code = o.v === 3 && !lastInSpan ? 0 : o.v;
            notes.push(code === 1 ? root + 7 : code === 2 ? root + 12 : code === 3 ? nextRoot + (r() < 0.5 ? -1 : 2) : code === 4 ? root + (chord.ivs[1] ?? 4) : root);
          }
        }

        const swing = swingOn && o.pos % 2 === 1 ? p.swing * stepSec : 0;
        const t = (sec.start * n + posInSec) * stepSec + swing + gauss(r) * p.humanize * 0.012;
        // Crescendo into a louder section.
        const fromEnd = (sec.bars * n - posInSec) / n;
        const build = sec.rise && fromEnd <= 2 ? 0.85 + 0.25 * (1 - fromEnd / 2) : 1;
        const vel = clamp(energyVel * (0.72 + 0.28 * o.acc) * build * (1 + (r() - 0.5) * 0.3 * p.humanize), 0.05, 1);
        for (const m of notes) out.push({ t: Math.max(0, t), dur, midi: m, vel: notes.length > 1 ? vel * 0.85 : vel });
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- drums

/** 16 steps per 4/4 bar. x = hit, o = medium, . = ghost (density), ? = sometimes (density), - = rest. */
const STYLES: Record<Exclude<DrumStyle, 'euclid' | 'random'>, Partial<Record<DrumVoice, string>>> = {
  four: { kick: 'x---x---x---x---', clap: '----x-------x---', hat: '..x...x...x...x.', ohat: '--o---o---o---o-', shaker: '.?.?.?.?.?.?.?.?' },
  backbeat: { kick: 'x-----x-x-?-----', snare: '----x-------x--.', hat: 'x-o-x-o-x-o-x-o-', ohat: '--------------o-', tomL: '----------------' },
  breakbeat: { kick: 'x-x-------x-?---', snare: '----x--.-.-.x--.', hat: 'x-x-x-x-x-x-x-x-', ohat: '-------o--------', rim: '---.------.-----' },
  halftime: { kick: 'x------?x-------', snare: '--------x-------', hat: 'x-o-x-o-x-o-x-o-', rim: '---.-------.----', shaker: '.?.?.?.?.?.?.?.?' },
  trap: { kick: 'x------x--x-----', clap: '--------x-------', hat: 'x-x-x-x-x-x-x-x-', ohat: '-------------o--', rim: '-----.------.---' },
  dnb: { kick: 'x---------x-----', snare: '----x--.----x---', hat: 'x-x-x-x-x-x-x-x-', ohat: '--o-------o-----', shaker: '.?.?.?.?.?.?.?.?' },
  shuffle: { kick: 'x-----x-x-------', snare: '----x-------x---', hat: 'x-.ox-.ox-.ox-.o', rim: '--------------.-' },
  bossa: { kick: 'x--xx--xx--xx--x', rim: 'x--x--x---x--x--', hat: 'x-x-x-x-x-x-x-x-', shaker: '.o.o.o.o.o.o.o.o', tomH: '--------------?-' },
};

export const DRUM_STYLES: Record<DrumStyle, string> = {
  four: 'Four on the floor', backbeat: 'Backbeat (pop / rock)', breakbeat: 'Breakbeat', halftime: 'Half-time',
  trap: 'Trap (hat rolls)', dnb: 'Drum & bass', shuffle: 'Shuffle', bossa: 'Bossa nova', euclid: 'Euclidean (generated)',
  random: 'Random (generated)',
};

/** Energy level at which each drum voice joins: kick first, then hats, snare, open hats, percussion. */
const LAYER: Record<DrumVoice, number> = {
  kick: 0, hat: 0.2, snare: 0.35, clap: 0.35, ohat: 0.55, rim: 0.7, shaker: 0.6, tomL: 0.7, tomH: 0.7, crash: 0.35,
};

function generatedPattern(style: 'euclid' | 'random', r: Rng, density: number): Partial<Record<DrumVoice, string>> {
  const pat = (hits: boolean[], ch = 'x') => hits.map((h) => (h ? ch : '-')).join('');
  const rot = (s: string, k: number) => s.slice(16 - k) + s.slice(0, 16 - k);
  if (style === 'euclid') {
    return {
      kick: pat(euclid(int(r, 3, 5), 16)),
      snare: rot(pat(euclid(int(r, 1, 3), 16)), 4),
      hat: rot(pat(euclid(int(r, 5, 11), 16), 'o'), int(r, 0, 3)),
      rim: rot(pat(euclid(int(r, 3, 7), 16), 'o'), int(r, 1, 15)),
      shaker: rot(pat(euclid(int(r, 7, 13), 16), '.'), int(r, 0, 3)),
    };
  }
  const row = (prob: (i: number) => number, ch: string) => Array.from({ length: 16 }, (_, i) => (r() < prob(i) ? ch : '-')).join('');
  return {
    kick: row((i) => (i === 0 ? 1 : i % 4 === 0 ? 0.3 : 0.15), 'x'),
    snare: row((i) => (i === 4 || i === 12 ? 0.9 : 0.06 * (1 + density)), 'x'),
    hat: row((i) => (i % 2 === 0 ? 0.5 + density * 0.5 : density * 0.5), 'o'),
    rim: row(() => 0.1 * (1 + density), 'o'),
  };
}

const CHAR_VEL: Record<string, number> = { x: 1, X: 1, o: 0.7, '.': 0.35, '?': 0.6 };

/** Drum hits for a drum track. */
export function drumEvents(p: MusicParams, plan: Plan, tr: TrackParams, seed: number): DrumEv[] {
  const out: DrumEv[] = [];
  const n = p.meter * 4;
  const sixteenth = plan.beat / 4;
  const shuffle = tr.style === 'shuffle';
  const swingAmt = shuffle ? Math.max(p.swing, 0.33) : p.swing;
  let prevEnergy = -1;

  for (const sec of plan.sections) {
    const level = trackLevel(p, sec, tr, seed);
    const startEnergy = prevEnergy;
    prevEnergy = sec.energy;
    if (!level) continue;
    const mat = material(sec.label);
    const pr = rngFor(seed, tr.id, tr.salt, 'drumpat', mat);
    const pattern = tr.style === 'euclid' || tr.style === 'random'
      ? generatedPattern(tr.style, pr, tr.density)
      : STYLES[tr.style] ?? STYLES.backbeat;
    const r = rngFor(seed, tr.id, tr.salt, 'drums', sec.index);
    const energyVel = 0.55 + 0.45 * sec.energy;
    const hit = (bar: number, step: number, voice: DrumVoice, vel: number, sub = 0) => {
      const s = (sec.start + bar) * n + step;
      const swing = !shuffle && step % 2 === 1 ? swingAmt * sixteenth : shuffle && step % 4 === 2 ? swingAmt * 2 * sixteenth : 0;
      const t = s * sixteenth + swing + sub + gauss(r) * p.humanize * 0.007;
      out.push({ t: Math.max(0, t), voice, vel: clamp(vel * energyVel * (1 + (r() - 0.5) * 0.25 * p.humanize), 0.05, 1) });
    };

    // A crash marks the arrival of a section at least as loud as the last.
    if (sec.index > 0 && level >= LAYER.crash && sec.energy >= startEnergy - 0.05) hit(0, 0, 'crash', 0.8);

    for (let b = 0; b < sec.bars; b++) {
      const lastBar = b === sec.bars - 1;
      const phraseEnd = (b + 1) % 4 === 0;
      // Builds into louder sections: a snare roll over the last bar, kick dropping out half-way.
      const building = sec.rise && lastBar && level >= LAYER.snare;
      // Fills at phrase ends (more likely at section ends): the last beat or two.
      const fillBeats = !building && (phraseEnd || lastBar) && r() < tr.fills * (lastBar ? 1.2 : 0.6) ? (r() < tr.fills ? 2 : 1) : 0;
      const fillFrom = n - fillBeats * 4;

      for (const [voice, row] of Object.entries(pattern) as [DrumVoice, string][]) {
        if (level < LAYER[voice]) continue;
        for (let i = 0; i < n; i++) {
          if (fillBeats && i >= fillFrom && voice !== 'hat') continue;
          if (building && (voice === 'snare' || voice === 'clap' || (voice === 'kick' && i >= n / 2))) continue;
          const ch = row[i % 16];
          if (!ch || ch === '-') continue;
          if ((ch === '.' || ch === '?') && r() > tr.density * (ch === '.' ? 1.2 : 1) * (0.4 + 0.6 * level)) continue;
          if (voice === 'hat' && tr.style === 'trap' && r() < tr.density * 0.3 * level) {
            // Hat roll: two or three quick hits in the space of one sixteenth.
            const k = r() < 0.5 ? 2 : 3;
            for (let j = 0; j < k; j++) hit(b, i, voice, CHAR_VEL[ch] * (0.55 + 0.1 * j), (j * sixteenth) / k);
            continue;
          }
          hit(b, i, voice, CHAR_VEL[ch] * (i % 4 === 0 ? 1 : 0.9));
        }
        // Dense playing adds ghost hats between the written ones.
        if (voice === 'hat' && tr.density > 0.6) {
          for (let i = 0; i < n; i++) if (row[i % 16] === '-' && r() < (tr.density - 0.6) * 1.5 * level) hit(b, i, 'hat', 0.3);
        }
      }
      if (building) {
        for (let i = 0; i < n; i += i < n / 2 ? 2 : 1) hit(b, i, 'snare', 0.3 + 0.7 * (i / n));
      }
      if (fillBeats) {
        const toms: DrumVoice[] = level >= LAYER.tomL ? ['snare', 'tomH', 'tomH', 'tomL'] : ['snare'];
        for (let i = fillFrom; i < n; i++) {
          if (i % 2 === 1 && r() < 0.35) continue;
          const v = toms[Math.min(toms.length - 1, Math.floor(((i - fillFrom) / (n - fillFrom)) * toms.length))];
          hit(b, i, v, 0.55 + 0.45 * ((i - fillFrom) / (n - fillFrom)));
        }
      }
    }
  }
  return out;
}
