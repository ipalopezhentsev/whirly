// A small Klatt-style formant speech synthesizer for the "Synthetic voice" preset.
//
// Text → phonemes (english.ts) → a timeline of target values (formants, voicing, noise, pitch)
// → sample-by-sample synthesis: a glottal pulse source through cascaded formant resonators, plus
// filtered noise for fricatives and stop bursts. Robotic, but fully offline and deterministic, so a
// share link only needs to carry the text and settings.
import { isVowelPhone, textToPhrases, type Phrase } from './english';

export interface SpeechParams {
  text: string;
  /** Base pitch, Hz. */
  pitch: number;
  /** Speaking rate, ×. */
  rate: number;
  /** Formant (vocal tract size) scale, ×: below 1 sounds larger, above 1 smaller. */
  formant: number;
}

export const SPEECH_DEFAULTS: SpeechParams = { text: '', pitch: 110, rate: 1, formant: 1 };

// ---------------------------------------------------------------- phoneme table

type Kind = 'vowel' | 'glide' | 'lateral' | 'trill' | 'nasal' | 'fric' | 'stop' | 'affricate' | 'h';
type Place = 'labial' | 'dental' | 'alveolar' | 'post' | 'velar';
type F3 = [number, number, number];

interface Phone {
  kind: Kind;
  /** Formant targets F1–F3 (Hz); for stops and fricatives, the locus the neighbours glide toward. */
  f: F3;
  /** Diphthong end target. */
  f2?: F3;
  /** Bandwidths B1–B3 (Hz). */
  b?: F3;
  /** Inherent duration, ms (stressed, for vowels). */
  dur: number;
  voiced?: boolean;
  place?: Place;
  /** Frication (or burst) amplitude. */
  af?: number;
  /** Antiresonance (Hz) of a lateral: air flowing around the tongue sides cancels a band. */
  zero?: number;
}

const P: Record<string, Phone> = {
  IY: { kind: 'vowel', f: [300, 2250, 2980], b: [55, 90, 200], dur: 150 },
  IH: { kind: 'vowel', f: [400, 1850, 2550], dur: 110 },
  EY: { kind: 'vowel', f: [480, 1760, 2520], f2: [330, 2200, 2950], dur: 180 },
  EH: { kind: 'vowel', f: [550, 1700, 2500], dur: 120 },
  AE: { kind: 'vowel', f: [680, 1680, 2420], b: [80, 110, 180], dur: 170 },
  AA: { kind: 'vowel', f: [720, 1180, 2580], b: [100, 80, 160], dur: 170 },
  AO: { kind: 'vowel', f: [600, 950, 2570], b: [90, 90, 120], dur: 170 },
  OW: { kind: 'vowel', f: [540, 1050, 2350], f2: [430, 880, 2300], dur: 180 },
  UH: { kind: 'vowel', f: [450, 1150, 2350], dur: 120 },
  UW: { kind: 'vowel', f: [340, 1200, 2250], f2: [310, 950, 2200], dur: 160 },
  AH: { kind: 'vowel', f: [620, 1220, 2550], dur: 120 },
  AX: { kind: 'vowel', f: [500, 1450, 2450], dur: 70 },
  ER: { kind: 'vowel', f: [470, 1300, 1600], b: [90, 70, 110], dur: 160 },
  AY: { kind: 'vowel', f: [700, 1200, 2550], f2: [400, 1950, 2550], dur: 200 },
  AW: { kind: 'vowel', f: [680, 1250, 2550], f2: [430, 930, 2350], dur: 200 },
  OY: { kind: 'vowel', f: [550, 960, 2400], f2: [380, 1850, 2500], dur: 210 },

  W: { kind: 'glide', f: [290, 650, 2150], dur: 70 },
  Y: { kind: 'glide', f: [260, 2100, 3020], dur: 60 },
  R: { kind: 'glide', f: [320, 1080, 1400], b: [70, 90, 100], dur: 70 },
  L: { kind: 'lateral', f: [320, 1050, 2880], b: [60, 110, 280], dur: 70, zero: 2100 },
  M: { kind: 'nasal', f: [250, 1100, 2200], b: [100, 300, 450], dur: 80, place: 'labial' },
  N: { kind: 'nasal', f: [250, 1500, 2500], b: [100, 300, 450], dur: 70, place: 'alveolar' },
  NG: { kind: 'nasal', f: [250, 2000, 2700], b: [100, 300, 450], dur: 90, place: 'velar' },

  F: { kind: 'fric', f: [340, 1100, 2100], dur: 110, place: 'labial', af: 0.35 },
  V: { kind: 'fric', f: [240, 1100, 2100], dur: 70, place: 'labial', af: 0.25, voiced: true },
  TH: { kind: 'fric', f: [320, 1300, 2550], dur: 110, place: 'dental', af: 0.3 },
  DH: { kind: 'fric', f: [270, 1300, 2550], dur: 55, place: 'dental', af: 0.2, voiced: true },
  S: { kind: 'fric', f: [320, 1400, 2550], dur: 120, place: 'alveolar', af: 1 },
  Z: { kind: 'fric', f: [240, 1400, 2550], dur: 90, place: 'alveolar', af: 0.7, voiced: true },
  SH: { kind: 'fric', f: [300, 1850, 2750], dur: 130, place: 'post', af: 1 },
  ZH: { kind: 'fric', f: [300, 1850, 2750], dur: 90, place: 'post', af: 0.7, voiced: true },
  HH: { kind: 'h', f: [500, 1500, 2500], dur: 65 },

  P: { kind: 'stop', f: [400, 1000, 2150], dur: 90, place: 'labial', af: 0.5 },
  B: { kind: 'stop', f: [220, 1000, 2150], dur: 75, place: 'labial', af: 0.35, voiced: true },
  T: { kind: 'stop', f: [400, 1700, 2600], dur: 80, place: 'alveolar', af: 0.8 },
  D: { kind: 'stop', f: [220, 1700, 2600], dur: 70, place: 'alveolar', af: 0.5, voiced: true },
  K: { kind: 'stop', f: [300, 1950, 2700], dur: 90, place: 'velar', af: 0.7 },
  G: { kind: 'stop', f: [220, 1950, 2700], dur: 75, place: 'velar', af: 0.5, voiced: true },
  CH: { kind: 'affricate', f: [350, 1850, 2800], dur: 120, place: 'post', af: 1 },
  JH: { kind: 'affricate', f: [260, 1850, 2800], dur: 100, place: 'post', af: 0.7, voiced: true },

  // Russian
  YI: { kind: 'vowel', f: [330, 1500, 2350], dur: 130 }, // ы
  OH: { kind: 'vowel', f: [520, 870, 2450], b: [80, 80, 140], dur: 160 }, // о
  UU: { kind: 'vowel', f: [320, 760, 2250], b: [60, 80, 140], dur: 150 }, // у
  // Weak unstressed а/о (мам[а], сл[о]во, [о]городе): lower and further back than the English schwa,
  // which drifts toward э.
  AR: { kind: 'vowel', f: [580, 1230, 2500], b: [80, 80, 160], dur: 80 },
  LX: { kind: 'lateral', f: [330, 850, 2500], b: [60, 90, 200], dur: 70, zero: 1700 }, // hard л
  RR: { kind: 'trill', f: [440, 1350, 2050], dur: 85, place: 'alveolar' }, // р: low F3 between taps
  KH: { kind: 'fric', f: [400, 1400, 2500], dur: 100, place: 'velar', af: 0.55 }, // х
  TS: { kind: 'affricate', f: [380, 1700, 2600], dur: 120, place: 'alveolar', af: 1 }, // ц
  SHH: { kind: 'fric', f: [300, 2100, 2850], dur: 170, place: 'post', af: 1 }, // щ
};

/** Soft л: clearly lower F1 and F2 than и, so it does not melt into the vowel. */
const SOFT_L: F3 = [260, 1750, 2950];

/** Soft (palatalized) consonant: its locus moves toward /i/. */
function soften(f: F3, place?: Place): F3 {
  return [f[0], Math.max(f[1], place === 'velar' ? 2300 : 2000), Math.max(f[2], 2800)];
}

/** Noise spectra for fricatives and bursts: two resonances [freq, bandwidth, gain]. */
const NOISE: Record<Place, [number, number, number][]> = {
  labial: [[1500, 2500, 0.5], [7000, 4000, 1]],
  dental: [[5000, 3000, 0.6], [8000, 4000, 1]],
  alveolar: [[5200, 1500, 1], [7800, 2500, 0.6]],
  post: [[2700, 700, 1], [4200, 1500, 0.6]],
  velar: [[2100, 700, 1], [3500, 1500, 0.4]],
};
/** Soft (palatalized) consonants hiss higher and thinner; soft х becomes a palatal [ç]. */
const NOISE_SOFT: Record<Place, [number, number, number][]> = {
  labial: [[3000, 2500, 0.5], [7000, 4000, 1]],
  dental: [[6000, 3000, 0.6], [8500, 4000, 1]],
  alveolar: [[6500, 1500, 1], [8800, 2500, 0.6]],
  post: [[3000, 700, 1], [4800, 1500, 0.6]],
  velar: [[3800, 1000, 1], [5500, 2000, 0.5]],
};
/** During a nasal the closed mouth swallows a band of frequencies (an antiresonance) set by where it is closed. */
const ORAL_ZERO: Partial<Record<Place, number>> = { labial: 1100, alveolar: 1700, velar: 2800 };
/** Where a soft consonant's release glides: toward /i/. */
const I_GLIDE: F3 = [280, 2250, 2950];
const DEFAULT_B: F3 = [70, 100, 160];

// ---------------------------------------------------------------- parameter tracks

/** Piecewise-linear value over time, read with a forward-moving cursor. */
class Track {
  t: number[] = [];
  v: number[] = [];
  private i = 0;
  private def: number;
  constructor(def = 0) {
    this.def = def;
  }
  add(t: number, v: number) {
    const n = this.t.length;
    if (n && t <= this.t[n - 1]) t = this.t[n - 1] + 1e-5;
    this.t.push(t);
    this.v.push(v);
  }
  at(t: number) {
    const { t: ts, v } = this;
    if (!ts.length) return this.def;
    if (t <= ts[0]) return v[0];
    while (this.i < ts.length - 2 && ts[this.i + 1] < t) this.i++;
    const a = this.i;
    if (t >= ts[ts.length - 1]) return v[v.length - 1];
    const k = (t - ts[a]) / (ts[a + 1] - ts[a]);
    return v[a] + (v[a + 1] - v[a]) * k;
  }
}

interface Plan {
  F: Track[];
  B: Track[];
  av: Track;
  ah: Track;
  af: Track;
  nasal: Track;
  /** Frequency of the mouth's antiresonance during nasals. */
  oralZero: Track;
  /** How much of that antiresonance applies (nasals and laterals). */
  zeroMix: Track;
  /** Vocal effort 0–1 (exclamations): louder, brighter, more pressed voice. */
  effort: Track;
  /** Noise spectrum: freq/bw/gain for two resonances. */
  nz: Track[];
  f0: Track;
  dur: number;
}

interface Unit {
  ph: string;
  p: Phone;
  stress: boolean;
  /** Last syllable(s) of a phrase: lengthened. */
  final: boolean;
  /** Palatalized consonant (Russian). */
  soft: boolean;
  /** From a Russian word: voiceless stops are not aspirated. */
  ru: boolean;
  /** Last sound of its word. */
  wordEnd: boolean;
}

function plan(sp: SpeechParams): Plan {
  const pl: Plan = {
    F: [new Track(500), new Track(1500), new Track(2500)],
    B: [new Track(70), new Track(100), new Track(160)],
    av: new Track(), ah: new Track(), af: new Track(), nasal: new Track(), effort: new Track(), oralZero: new Track(1100), zeroMix: new Track(),
    nz: Array.from({ length: 6 }, () => new Track(1000)),
    f0: new Track(sp.pitch),
    dur: 0,
  };
  const rate = Math.max(0.2, sp.rate);
  const formants = (t: number, f: F3, b: F3 = DEFAULT_B) => {
    for (let k = 0; k < 3; k++) {
      pl.F[k].add(t, f[k]);
      pl.B[k].add(t, b[k]);
    }
  };
  const amps = (s: number, e: number, a: { av?: number; ah?: number; af?: number; nasal?: number; zero?: number }, ramp = 0.006) => {
    const r = Math.min(ramp, (e - s) / 3);
    for (const [k, tr] of [['av', pl.av], ['ah', pl.ah], ['af', pl.af], ['nasal', pl.nasal], ['zero', pl.zeroMix]] as const) {
      tr.add(s + r, a[k] ?? 0);
      tr.add(e - r, a[k] ?? 0);
    }
  };
  const noise = (t: number, place: Place, soft = false) => {
    (soft ? NOISE_SOFT : NOISE)[place].forEach(([f, bw, g], k) => {
      pl.nz[k * 3].add(t, f);
      pl.nz[k * 3 + 1].add(t, bw);
      pl.nz[k * 3 + 2].add(t, g);
    });
  };

  let t = 0.08;
  let spoken = t;
  amps(0, t, {});
  for (const phrase of textToPhrases(sp.text)) {
    const units = phraseUnits(phrase);
    const t0 = t;
    const ex = phrase.excl;
    // Exclamations are said a little faster.
    const pace = rate * (1 + 0.07 * ex);
    const vowelMarks: { s: number; e: number; stress: boolean }[] = [];
    units.forEach((u, i) => {
      const { p } = u;
      const f = u.soft ? (u.ph === 'L' ? SOFT_L : soften(p.f, p.place)) : p.f;
      const prev = units[i - 1];
      const next = units[i + 1];
      const nextVowel = units.slice(i + 1).find((x) => x.p.kind === 'vowel')?.p;
      let d = p.dur;
      if (p.kind === 'vowel') d *= u.stress ? 1 : u.ph === 'AX' || u.ph === 'AR' ? 0.9 : 0.62;
      else if ((prev && prev.p.kind !== 'vowel') || (next && next.p.kind !== 'vowel')) d *= 0.82;
      if (u.final) d *= 1.35;
      d = d / 1000 / pace;
      const s = t;
      const e = s + d;
      /** Where this sound ends (stops can run past `e` with burst and aspiration). */
      let end = e;
      switch (p.kind) {
        case 'vowel': {
          const lead = p.f2 ? 0.15 : 0.3;
          formants(s + d * lead, p.f, p.b);
          formants(e - d * (p.f2 ? 0.1 : 0.3), p.f2 ?? p.f, p.b);
          amps(s, e, { av: u.stress ? 1 : 0.8 });
          vowelMarks.push({ s, e, stress: u.stress });
          break;
        }
        case 'glide':
          formants(s + d * 0.4, f, p.b);
          formants(e - d * 0.4, f, p.b);
          amps(s, e, { av: 0.7 }, 0.012);
          break;
        case 'lateral': {
          // Like a nasal, a lateral switches fairly sharply and is a little weaker than the vowel,
          // with a spectral dip; gliding into the vowel at full level makes it vanish.
          const edge = Math.min(0.015, d / 4);
          formants(s + edge, f, p.b);
          formants(e - edge, f, p.b);
          const z = u.soft ? 2500 : p.zero!;
          pl.oralZero.add(s, z);
          pl.oralZero.add(e, z);
          amps(s, e, { av: 0.5, zero: 0.8 }, 0.006);
          break;
        }
        case 'trill': {
          // Two tongue-tip contacts. Between them the tract has a low F3 (the main р cue, л has a
          // high one), and the formants keep swinging toward the contact and back, so the movement
          // is heard in the voiced parts. During a contact voicing goes on as a weak murmur, and
          // the release gives a faint click.
          const k = d / 5;
          const open: F3 = u.soft ? [380, 1900, 2500] : p.f;
          const tap: F3 = [280, u.soft ? 2100 : 1700, 2600];
          for (let j = 0; j < 5; j++) {
            const a = s + j * k;
            const closed = j % 2 === 1;
            formants(a + k / 2, closed ? tap : open, closed ? [150, 250, 350] : [70, 100, 140]);
            amps(a, a + k, { av: closed ? 0.1 : 0.65 }, 0.002);
            if (closed) {
              noise(a + k, 'alveolar');
              amps(a + k, a + k + 0.004, { av: 0.4, af: 0.12 }, 0.001);
            }
          }
          break;
        }
        case 'nasal': {
          // The murmur switches on and off abruptly as the lips or tongue close and open: that jump,
          // not a glide, is what tells м from в or w.
          const edge = Math.min(0.012, d / 4);
          formants(s + edge, f, p.b);
          formants(e - edge, f, p.b);
          pl.oralZero.add(s, ORAL_ZERO[p.place!]!);
          pl.oralZero.add(e, ORAL_ZERO[p.place!]!);
          amps(s, e, { av: 0.4, nasal: 1, zero: 1 }, 0.004);
          break;
        }
        case 'fric':
          formants(s + d * 0.3, f);
          formants(e - d * 0.3, f);
          noise(s, p.place!, u.soft);
          noise(e, p.place!, u.soft);
          amps(s, e, { av: p.voiced ? 0.35 : 0, af: p.af! * (u.soft && p.place === 'velar' ? 1.3 : 1) }, 0.012);
          break;
        case 'h': {
          const f = nextVowel?.f ?? p.f;
          formants(s, f, [300, 200, 250]);
          formants(e, f, [300, 200, 250]);
          amps(s, e, { ah: 0.6 }, 0.012);
          break;
        }
        case 'stop':
        case 'affricate': {
          const affr = p.kind === 'affricate';
          let locus = f;
          // Hard к/г: F2 and F3 pinch together just above the next vowel's F2 (low before о/у).
          const velar = p.place === 'velar' && !u.soft && !affr;
          const labial = p.place === 'labial' && !affr;
          if (velar && nextVowel) {
            const f2 = Math.min(2600, Math.max(1150, nextVowel.f[1] + 300));
            locus = [p.f[0], f2, Math.max(f2 + 700, 2200)];
          }
          const close = d * (affr ? 0.45 : 0.72);
          const rel = s + close;
          // A soft п/б still closes with the lips (formants falling into it); the softness shows
          // only at the release. Approaching with an и-like locus is how т sounds.
          formants(s + close * 0.3, labial && u.soft ? p.f : locus);
          formants(rel, locus);
          amps(s, rel, { av: p.voiced ? 0.12 : 0 }, 0.004);
          noise(rel, p.place!, u.soft);
          if (affr) {
            amps(rel, e, { av: p.voiced ? 0.3 : 0, af: p.af }, 0.006);
            noise(e, p.place!, u.soft);
            break;
          }
          // Soft stops release with a short hiss, ть and дь most of all (almost ць, дзь).
          const burst = (u.soft ? (p.place === 'alveolar' ? 0.03 : 0.02) : velar ? 0.02 : 0.012) / Math.sqrt(rate);
          if (velar) {
            // The burst goes through the vocal tract (narrow resonances at the pinch), so it stays a
            // compact puff around F2 instead of a broadband hiss, which sounds like ш/ж.
            formants(rel + burst, locus, [250, 90, 150]);
            amps(rel, rel + burst, { ah: 1.1 }, 0.002);
          } else if (labial) {
            // Lips release a weak, low, diffuse puff. A bright hiss here is heard as т.
            formants(rel + burst, locus, [300, 250, 350]);
            amps(rel, rel + burst, { ah: 0.6 }, 0.002);
          } else {
            amps(rel, rel + burst, { af: p.af! * (u.soft ? 1.2 : 1) }, 0.002);
          }
          noise(rel + burst, p.place!, u.soft);
          end = rel + burst;
          // Voiceless stops are aspirated before a vowel or glide, except after S ("spin", "stop").
          // Russian ones are not, but voicing still starts a little late (longest after к); without
          // that gap they sound voiced.
          const aspirate = !p.voiced && next && (next.p.kind === 'vowel' || next.p.kind === 'glide' || next.p.kind === 'lateral') && prev?.ph !== 'S';
          if (aspirate) {
            const asp = (u.ru ? (p.place === 'velar' ? 0.025 : 0.012) : 0.05) / rate;
            amps(end, end + asp, { ah: 0.5 }, 0.004);
            end += asp;
          }
          end = Math.max(e, end);
          break;
        }
      }
      // A soft consonant not followed by a vowel (мать, день, письмо) lets go with a brief /i/-coloured
      // glide, voiced after sonorants and voiced consonants, a breath otherwise.
      if (u.soft && p.kind !== 'vowel' && (u.wordEnd || (next && next.p.kind !== 'vowel'))) {
        const g = (u.wordEnd ? 0.045 : 0.018) / rate;
        const voiced = p.voiced || p.kind === 'glide' || p.kind === 'lateral' || p.kind === 'nasal' || p.kind === 'trill';
        formants(end + g * 0.7, I_GLIDE, [60, 150, 250]);
        amps(end, end + g, voiced ? { av: 0.3 } : { ah: 0.4 }, 0.006);
        end += g;
      }
      t = end;
    });
    // Pitch: a falling declination line with accents on stressed vowels, a final fall or rise.
    const t1 = t;
    const base = sp.pitch * (1 + 0.12 * ex);
    const decl = (x: number) => base * (1.1 - 0.25 * ((x - t0) / Math.max(0.3, t1 - t0)));
    const q = phrase.end === '?';
    const excl = 1 + 0.5 * ex;
    pl.f0.add(t0, decl(t0));
    let firstAccent = true;
    vowelMarks.forEach((v, i) => {
      const last = i === vowelMarks.length - 1;
      const acc = v.stress ? (firstAccent ? 0.22 : 0.12) * excl : 0;
      if (v.stress) firstAccent = false;
      const d = v.e - v.s;
      pl.f0.add(v.s + d * 0.2, decl(v.s) * (1 + acc));
      if (last && q) pl.f0.add(v.e, base * 1.45);
      else if (last && phrase.end !== ',') pl.f0.add(v.e, base * 0.72);
      else if (last) pl.f0.add(v.e, base * 1.0);
      else pl.f0.add(v.s + d * 0.8, decl(v.e) * (1 + acc * 0.4));
    });
    const effort = [0, 0.6, 0.85, 1][ex];
    pl.effort.add(t0, effort);
    pl.effort.add(t1, effort);
    if (units.length) spoken = t;
    const pause = phrase.pause / rate + phrase.silence;
    amps(t, t + pause, {}, 0.01);
    t += pause;
    // Explicit silence counts as content, so a trailing [n] (a gap before a loop repeats) is kept.
    if (phrase.silence) spoken = t;
  }
  pl.dur = spoken + 0.12;
  return pl;
}

function phraseUnits(phrase: Phrase): Unit[] {
  const units: Unit[] = [];
  phrase.words.forEach((w, wi) => {
    const lastWord = wi === phrase.words.length - 1;
    w.phones.forEach((raw, i) => {
      const soft = raw.endsWith("'");
      const ph = soft ? raw.slice(0, -1) : raw;
      const p = P[ph];
      if (!p) return;
      const final = lastWord && (w.stress < 0 || i >= w.stress) && isVowelPhone(ph);
      units.push({ ph, p, stress: i === w.stress, final, soft, ru: !!w.ru, wordEnd: i === w.phones.length - 1 });
    });
  });
  return units;
}

/** Length of the rendered speech, seconds. */
export function speechDuration(sp: SpeechParams) {
  return Math.max(0.3, +plan(sp).dur.toFixed(2));
}

// ---------------------------------------------------------------- synthesis

/** Klatt two-pole resonator, unity gain at DC. */
class Resonator {
  a = 1; b = 0; c = 0; y1 = 0; y2 = 0;
  set(f: number, bw: number, sr: number) {
    const r = Math.exp((-Math.PI * bw) / sr);
    this.c = -r * r;
    this.b = 2 * r * Math.cos((2 * Math.PI * f) / sr);
    this.a = 1 - this.b - this.c;
  }
  run(x: number) {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Klatt anti-resonator (a pair of zeros), unity gain at DC. */
class AntiResonator {
  a = 1; b = 0; c = 0; x1 = 0; x2 = 0;
  set(f: number, bw: number, sr: number) {
    const r = Math.exp((-Math.PI * bw) / sr);
    const C = -r * r;
    const B = 2 * r * Math.cos((2 * Math.PI * f) / sr);
    const A = 1 - B - C;
    this.a = 1 / A;
    this.b = -B / A;
    this.c = -C / A;
  }
  run(x: number) {
    const y = this.a * x + this.b * this.x1 + this.c * this.x2;
    this.x2 = this.x1;
    this.x1 = x;
    return y;
  }
}

/** Notch (RBJ): unity gain away from `f`. */
class Notch {
  b0 = 1; b1 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  set(f: number, q: number, sr: number) {
    const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = 1 / a0;
    this.b1 = (-2 * Math.cos(w)) / a0;
    this.a1 = this.b1;
    this.a2 = (1 - alpha) / a0;
  }
  run(x: number) {
    const y = this.b0 * (x + this.x2) + this.b1 * this.x1 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Band-pass with 0 dB peak (RBJ), for the noise branch. */
class BandPass {
  b0 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  set(f: number, bw: number, sr: number) {
    f = Math.min(f, sr * 0.45);
    const w = (2 * Math.PI * f) / sr;
    const alpha = Math.sin(w) / (2 * (f / Math.max(bw, 1)));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x: number) {
    const y = this.b0 * (x - this.x2) - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// Relative levels of the three sources (calibrated against a voiced vowel).
const ASP_GAIN = 0.9;
const FRIC_GAIN = 1.3;
const OPEN_QUOTIENT = 0.6;
/** Extra loudness at full vocal effort, ×. */
const EFFORT_GAIN = 1.6;

/** Render speech into `len` samples. `rnd` supplies the noise (seeded for repeatable renders). */
export function renderSpeech(sp: SpeechParams, sr: number, len: number, rnd: () => number = Math.random) {
  const pl = plan(sp);
  const out = new Float32Array(len);
  const fs = Math.max(0.5, sp.formant);
  const nyq = sr * 0.45;
  const R = [0, 1, 2, 3, 4].map(() => new Resonator());
  const nasalPole = new Resonator();
  const nasalZero = new AntiResonator();
  nasalPole.set(270, 100, sr);
  const oralZero = new Notch();
  const bp = [new BandPass(), new BandPass()];
  const ng = [0, 0];
  R[3].set(Math.min(3350 * fs, nyq), 250, sr);
  R[4].set(Math.min(3900 * fs, nyq), 300, sr);

  const smooth = 1 - Math.exp(-1 / (0.002 * sr));
  let av = 0, ah = 0, af = 0;
  let avT = 0, ahT = 0, afT = 0, f0 = sp.pitch;
  let effort = 0, effortT = 0, vPrev = 0, nasMix = 0;
  let phase = 0, tilt = 0, periodJitter = 1;
  const ph1 = rnd() * 6.28, ph2 = rnd() * 6.28;
  const block = 32;

  for (let i = 0; i < len; i++) {
    if (i % block === 0) {
      const t = i / sr;
      // Shouting opens the jaw wider, which raises F1.
      const jaw = 1 + 0.15 * pl.effort.at(t);
      for (let k = 0; k < 3; k++) R[k].set(Math.min(pl.F[k].at(t) * fs * (k ? 1 : jaw), nyq), pl.B[k].at(t), sr);
      const nas = pl.nasal.at(t);
      nasalZero.set(270 + 180 * nas, 100, sr);
      oralZero.set(pl.oralZero.at(t) * fs, 1.2, sr);
      nasMix = pl.zeroMix.at(t);
      for (let k = 0; k < 2; k++) {
        bp[k].set(pl.nz[k * 3].at(t) * Math.sqrt(fs), pl.nz[k * 3 + 1].at(t), sr);
        ng[k] = pl.nz[k * 3 + 2].at(t);
      }
      avT = pl.av.at(t);
      ahT = pl.ah.at(t);
      afT = pl.af.at(t);
      effortT = pl.effort.at(t);
      // Slow drift keeps the pitch from sounding mechanical.
      f0 = pl.f0.at(t) * (1 + 0.012 * Math.sin(2 * Math.PI * 0.7 * t + ph1) + 0.007 * Math.sin(2 * Math.PI * 2.3 * t + ph2));
    }
    av += (avT - av) * smooth;
    ah += (ahT - ah) * smooth;
    af += (afT - af) * smooth;
    effort += (effortT - effort) * smooth;

    // Glottal source: derivative of a polynomial flow pulse (KLGLOTT88), then a gentle tilt.
    phase += (f0 * periodJitter) / sr;
    if (phase >= 1) {
      phase -= 1;
      periodJitter = 1 + (rnd() - 0.5) * 0.01;
    }
    // More effort: a shorter open phase and less tilt, i.e. a pressed, brighter voice.
    const x = phase / (OPEN_QUOTIENT - 0.15 * effort);
    const g = x < 1 ? 2 * x - 3 * x * x : 0;
    tilt += (0.45 + 0.4 * effort) * (g - tilt);
    const n1 = rnd() * 2 - 1;
    const n2 = rnd() * 2 - 1;
    const breath = x < 1 ? 0.04 : 0.01;

    let v = tilt * av + n1 * (ah * ASP_GAIN + av * breath);
    v = nasalZero.run(nasalPole.run(v));
    for (let k = 0; k < 5; k++) v = R[k].run(v);
    const vz = oralZero.run(v);
    v += (vz - v) * nasMix;
    // Effort shifts energy up the spectrum (+6 dB/octave emphasis, blended in).
    const vd = v - vPrev;
    vPrev = v;
    v += effort * 2.5 * vd;
    const fr = af > 1e-4 ? n2 * af * FRIC_GAIN : 0;
    out[i] = (v + bp[0].run(fr) * ng[0] + bp[1].run(fr) * ng[1]) * (1 + (EFFORT_GAIN - 1) * effort);
  }
  return out;
}
