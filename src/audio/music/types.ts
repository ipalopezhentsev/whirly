// The settings of a generated piece. They travel inside a sound's recipe, so a piece (or one of its
// stems) can be rebuilt exactly from them and the seed.

export type Role = 'melody' | 'chords' | 'pad' | 'arp' | 'bass' | 'drums';

export type PitchAlgo =
  | 'markov' | 'walk' | 'motif' | 'pink' | 'automaton' | 'lsystem'
  | 'arpUp' | 'arpDown' | 'arpUpDown' | 'arpRandom' | 'chord' | 'bass' | 'walking' | 'drone';

export type RhythmAlgo = 'phrase' | 'steady' | 'euclid' | 'random' | 'syncopated' | 'sustain';

export type DrumStyle =
  | 'four' | 'backbeat' | 'breakbeat' | 'halftime' | 'trap' | 'dnb' | 'shuffle' | 'bossa' | 'euclid' | 'random';

export interface TrackParams {
  /** Stable id: names the stem and keys this track's random choices. */
  id: string;
  name: string;
  role: Role;
  on: boolean;
  /** Instrument key (INSTRUMENTS) or, for drums, kit key (KITS). */
  instrument: string;
  /** Bumped to re-roll only this track's notes. */
  salt: number;

  // ---- sound
  /** 0–1: filter cutoff, FM index, string brightness. */
  bright: number;
  /** Seconds. */
  attack: number;
  /** Seconds: release for sustained instruments, ring/decay time for struck ones. */
  release: number;
  /** Unison spread in cents. */
  detune: number;
  drive: number;
  vibrato: number;
  /** Tempo-synced echo amount. */
  echo: number;
  gainDb: number;

  // ---- notes
  algo: PitchAlgo;
  rhythm: RhythmAlgo;
  /** Notes per beat: 0.5 = half notes, 1 = quarters, 2 = eighths, 3 = eighth triplets, 4 = sixteenths. */
  step: number;
  /** 0–1: how many grid steps get a note. */
  density: number;
  /** Octave of the register's centre (4 = middle C). */
  octave: number;
  /** Pitch range in semitones. */
  range: number;
  /** Notes sounding together: chord size for chords, tones cycled by arpeggios, parallel harmony for melodies. */
  voices: number;
  /** Note length as a fraction of the time until the next note. */
  legato: number;

  // ---- drums
  style: DrumStyle;
  fills: number;

  // ---- arrangement
  /** The track plays in sections whose energy is at least this (0 = always). */
  enter: number;
}

export interface MusicParams {
  /** Style and mood last applied, for display. */
  style: string;
  mood: string;
  /** Tonic, 0 = C … 11 = B. */
  key: number;
  scale: string;
  tempo: number;
  /** Beats per bar. */
  meter: number;
  /** 0–0.5: delay of off-beat notes, as a fraction of a grid step. */
  swing: number;
  humanize: number;

  progression: string;
  /** Bars per chord. */
  chordBars: number;
  /** Notes per chord: 3 triads, 4 sevenths, 5 ninths. */
  chordSize: number;
  /** 0–1: how strongly melodies are pulled to chord tones. */
  consonance: number;

  form: string;
  sectionBars: number;
  bars: number;
  /** Overall energy: shifts every section's level. */
  energy: number;
  /** 0–1: how much repeats change and parts sit out sections. */
  variation: number;

  tracks: TrackParams[];
  /** Set on a stem: the one track this sound holds. */
  stem?: string;
}

/** Duration of a bar in seconds. */
export const barSeconds = (p: Pick<MusicParams, 'tempo' | 'meter'>) => (60 / p.tempo) * p.meter;

/** Longest piece we render (memory: mono float audio, possibly one buffer per stem). */
export const MAX_SECONDS = 240;

export const musicDuration = (p: Pick<MusicParams, 'tempo' | 'meter' | 'bars'>) => p.bars * barSeconds(p);

/** Music renders at CD rate: full bandwidth, a little less memory and time than 48 kHz. */
export const MUSIC_RATE = 44100;
