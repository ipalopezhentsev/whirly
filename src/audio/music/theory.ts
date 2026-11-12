// Scales, chords and chord progressions.
import { pickOf, weighted, type Rng } from './rng';

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export interface ScaleDef {
  label: string;
  steps: number[];
  /** Seven-note scale the chords are built from, for scales too sparse to stack thirds in. */
  parent?: string;
}

export const SCALES: Record<string, ScaleDef> = {
  major: { label: 'Major (Ionian)', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Minor (Aeolian)', steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { label: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { label: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  harmonicMinor: { label: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  melodicMinor: { label: 'Melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  phrygianDominant: { label: 'Phrygian dominant (Hijaz)', steps: [0, 1, 4, 5, 7, 8, 10] },
  doubleHarmonic: { label: 'Double harmonic', steps: [0, 1, 4, 5, 7, 8, 11] },
  pentaMajor: { label: 'Pentatonic major', steps: [0, 2, 4, 7, 9], parent: 'major' },
  pentaMinor: { label: 'Pentatonic minor', steps: [0, 3, 5, 7, 10], parent: 'minor' },
  blues: { label: 'Blues', steps: [0, 3, 5, 6, 7, 10], parent: 'mixolydian' },
  hirajoshi: { label: 'Hirajoshi', steps: [0, 2, 3, 7, 8], parent: 'minor' },
  insen: { label: 'In-sen', steps: [0, 1, 5, 7, 10], parent: 'phrygian' },
  pelog: { label: 'Pelog (approx.)', steps: [0, 1, 3, 7, 8], parent: 'phrygian' },
  wholeTone: { label: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
};

/** Scale degree (any integer, 0 = tonic) to semitones above the tonic. */
export function degSemi(deg: number, steps: number[]) {
  const n = steps.length;
  const o = Math.floor(deg / n);
  return o * 12 + steps[deg - o * n];
}

/** The scale degree whose pitch is nearest to `semi` (semitones above the tonic). */
export function nearestDeg(semi: number, steps: number[]) {
  const n = steps.length;
  let best = 0;
  let bd = Infinity;
  const o = Math.floor(semi / 12);
  for (let k = (o - 1) * n; k <= (o + 2) * n; k++) {
    const d = Math.abs(degSemi(k, steps) - semi);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

export interface Chord {
  /** Root, semitones above the key's tonic (0–11). */
  root: number;
  /** Chord tones as semitones above the root, ascending, starting with 0. */
  ivs: number[];
}

/** Pitch classes (0–11, relative to the tonic) of a chord. */
export const chordPcs = (c: Chord) => c.ivs.map((i) => (c.root + i) % 12);

export const PROGRESSIONS: Record<string, { label: string; spec: string }> = {
  pop: { label: '1 5 6 4 (pop)', spec: '1 5 6 4' },
  doowop: { label: '1 6 4 5 (doo-wop)', spec: '1 6 4 5' },
  axis: { label: '1 6 3 7', spec: '1 6 3 7' },
  sad: { label: '6 4 1 5', spec: '6 4 1 5' },
  canon: { label: '1 5 6 3 4 1 4 5 (canon)', spec: '1 5 6 3 4 1 4 5' },
  circle: { label: '1 4 7 3 6 2 5 1 (circle)', spec: '1 4 7 3 6 2 5 1' },
  jazz: { label: '2 5 1 6 (jazz turnaround)', spec: '2 5 1 6' },
  twoChord: { label: '1 4 (vamp)', spec: '1 4' },
  modal: { label: '1 7 (modal vamp)', spec: '1 7' },
  lift: { label: '1 2 (lift / tension)', spec: '1 2' },
  hijaz: { label: '1 2 1 7', spec: '1 2 1 7' },
  minorDrive: { label: 'i iv v i', spec: 'i iv v i' },
  epic: { label: 'i ♭VI ♭III ♭VII (epic)', spec: 'i bVI bIII bVII' },
  andalusian: { label: 'i ♭VII ♭VI V (Andalusian)', spec: 'i bVII bVI V' },
  rock: { label: 'I ♭VII IV I (rock)', spec: 'I bVII IV I' },
  blues: { label: '12-bar blues', spec: 'I7 I7 I7 I7 IV7 IV7 I7 I7 V7 IV7 I7 V7' },
  drone: { label: 'Drone (tonic only)', spec: '1' },
  markov: { label: 'Generated (functional harmony)', spec: '' },
};

const ROMAN: Record<string, number> = { i: 0, ii: 2, iii: 4, iv: 5, v: 7, vi: 9, vii: 11 };

/** Seven-note scale used for building chords. */
export const chordScale = (scale: string) => {
  const s = SCALES[scale] ?? SCALES.major;
  return s.parent ? SCALES[s.parent].steps : s.steps;
};

/** Diatonic chord on a scale degree (0-based): stack every other scale note. */
export function diatonic(deg: number, steps: number[], size: number): Chord {
  const root = degSemi(deg, steps);
  const ivs: number[] = [];
  for (let k = 0; k < size; k++) ivs.push(degSemi(deg + 2 * k, steps) - root);
  return { root: ((root % 12) + 12) % 12, ivs };
}

/**
 * Parse a progression: numbers are diatonic chords of the scale (1 = tonic), so they follow the
 * scale; Roman numerals are explicit (I major, i minor, b/# prefix, 7/maj7/m7/dim/aug/sus2/sus4/6/9 suffix).
 */
export function parseProgression(spec: string, scale: string, size: number): Chord[] {
  const steps = chordScale(scale);
  const out: Chord[] = [];
  for (const tok of spec.trim().split(/\s+/)) {
    if (!tok) continue;
    if (/^\d+$/.test(tok)) {
      out.push(diatonic(+tok - 1, steps, size));
      continue;
    }
    const m = tok.match(/^([b#]?)(vii|iii|vi|iv|ii|v|i)(maj7|m7|7|dim|aug|sus2|sus4|6|9)?$/i);
    if (!m) continue;
    const numeral = m[2];
    const minor = numeral === numeral.toLowerCase();
    const root = (ROMAN[numeral.toLowerCase()] + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0) + 12) % 12;
    const q = m[3] ?? '';
    let ivs = minor ? [0, 3, 7] : [0, 4, 7];
    if (q === 'dim') ivs = [0, 3, 6];
    if (q === 'aug') ivs = [0, 4, 8];
    if (q === 'sus2') ivs = [0, 2, 7];
    if (q === 'sus4') ivs = [0, 5, 7];
    if (q === '7' || q === 'm7' || q === '9') ivs.push(10);
    if (q === 'maj7') ivs.push(11);
    if (q === '6') ivs.push(9);
    if (q === '9') ivs.push(14);
    if (size >= 4 && ivs.length < 4) ivs.push(q === 'dim' ? 9 : minor ? 10 : 11);
    if (size >= 5 && ivs.length < 5) ivs.push(14);
    out.push({ root, ivs });
  }
  return out.length ? out : [diatonic(0, steps, size)];
}

/**
 * A progression from a Markov chain over harmonic functions: tonic (1, 6, 3) → subdominant (4, 2)
 * → dominant (5, 7) → tonic, with some wandering. Starts on the tonic.
 */
export function markovProgression(r: Rng, scale: string, size: number, length: number): Chord[] {
  const steps = chordScale(scale);
  // From degree (0-based) → weights over next degree.
  const next: Record<number, number[]> = {
    0: [0.2, 0.8, 0.4, 2.2, 2.0, 1.6, 0.2],
    1: [0.3, 0, 0.2, 0.6, 3.0, 0.3, 0.8],
    2: [0.4, 0.3, 0, 1.2, 0.4, 2.2, 0],
    3: [1.4, 0.7, 0.3, 0, 2.6, 0.4, 0.5],
    4: [3.2, 0.3, 0.4, 0.6, 0, 1.6, 0.1],
    5: [0.6, 1.8, 0.6, 1.8, 1.0, 0, 0.1],
    6: [2.6, 0, 1.0, 0.2, 0.4, 0.4, 0],
  };
  const degs = [0];
  while (degs.length < length) degs.push(weighted(r, next[degs[degs.length - 1]]));
  // Close the loop: the last chord should lead home.
  if (length >= 3 && degs[length - 1] === 0) degs[length - 1] = pickOf(r, [4, 3, 6]);
  return degs.map((d) => diatonic(d, steps, size));
}

/** A readable chord symbol, e.g. "Am7". */
export function chordName(c: Chord, key: number) {
  const name = NOTE_NAMES[(c.root + key) % 12];
  const s = new Set(c.ivs.map((i) => i % 12));
  const has = (...xs: number[]) => xs.every((x) => s.has(x));
  let q = '';
  if (has(4, 8)) q = '+';
  else if (has(3, 6)) q = s.has(10) ? 'm7♭5' : s.has(9) ? '°7' : '°';
  else if (has(3)) q = s.has(10) ? 'm7' : s.has(11) ? 'm(maj7)' : 'm';
  else if (has(4)) q = s.has(10) ? '7' : s.has(11) ? 'maj7' : s.has(9) ? '6' : '';
  else if (has(5)) q = 'sus4';
  else if (has(2)) q = 'sus2';
  else if (s.size <= 2) q = s.has(7) ? '5' : '';
  if (c.ivs.includes(14) && q !== '') q = q.replace(/7$/, '9');
  else if (c.ivs.includes(14)) q += 'add9';
  return name + q;
}
