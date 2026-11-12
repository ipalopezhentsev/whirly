// Presets: moods (key, scale, harmony, tempo) and styles (a whole piece: mood, form, instruments
// and how each part is generated).
import { instrumentTimbre } from './instruments';
import { KITS } from './drums';
import { int, pickOf, type Rng } from './rng';
import { MAX_SECONDS, barSeconds, type MusicParams, type Role, type TrackParams } from './types';

export const ROLES: Record<Role, string> = {
  melody: 'Melody', chords: 'Chords', pad: 'Pad', arp: 'Arpeggio', bass: 'Bass', drums: 'Drums',
};

const ROLE_DEFAULTS: Record<Role, Partial<TrackParams>> = {
  melody: { instrument: 'piano', algo: 'markov', rhythm: 'phrase', step: 2, density: 0.55, octave: 5, range: 14, voices: 1, legato: 0.9, enter: 0.5 },
  chords: { instrument: 'epiano', algo: 'chord', rhythm: 'sustain', step: 1, density: 0.5, octave: 4, range: 12, voices: 4, legato: 0.95, enter: 0.1 },
  pad: { instrument: 'pad', algo: 'chord', rhythm: 'sustain', step: 1, density: 0.5, octave: 4, range: 12, voices: 4, legato: 1.05, enter: 0 },
  arp: { instrument: 'harp', algo: 'arpUp', rhythm: 'steady', step: 4, density: 1, octave: 5, range: 24, voices: 3, legato: 0.8, enter: 0.6 },
  bass: { instrument: 'synthbass', algo: 'bass', rhythm: 'steady', step: 2, density: 0.6, octave: 2, range: 12, voices: 1, legato: 0.8, enter: 0.3 },
  drums: { instrument: 'k808', style: 'backbeat', density: 0.5, fills: 0.4, enter: 0.3, step: 4, bright: 0.85 },
};

/** A track for a role, with an instrument's timbre and any overrides. */
export function makeTrack(role: Role, patch: Partial<TrackParams> = {}): TrackParams {
  const d = { ...ROLE_DEFAULTS[role], ...patch };
  const inst = d.instrument!;
  const timbre = role === 'drums' ? { bright: 0.85, attack: 0, release: 0.5, detune: 0, drive: 0, vibrato: 0, echo: 0 } : instrumentTimbre(inst);
  return {
    id: role,
    name: ROLES[role],
    role,
    on: true,
    salt: 0,
    gainDb: 0,
    algo: 'markov',
    rhythm: 'phrase',
    step: 2,
    density: 0.5,
    octave: 4,
    range: 12,
    voices: 1,
    legato: 0.9,
    style: 'backbeat',
    fills: 0.3,
    enter: 0,
    instrument: inst,
    ...timbre,
    ...d,
  } as TrackParams;
}

// ---------------------------------------------------------------- moods

export interface Mood {
  label: string;
  scale: string;
  progression: string;
  tempo: number;
  swing?: number;
  chordSize?: number;
  consonance?: number;
}

export const MOODS: Record<string, Mood> = {
  happy: { label: 'Happy', scale: 'major', progression: 'pop', tempo: 116 },
  uplifting: { label: 'Uplifting', scale: 'major', progression: 'canon', tempo: 124 },
  peaceful: { label: 'Peaceful', scale: 'pentaMajor', progression: 'twoChord', tempo: 66 },
  dreamy: { label: 'Dreamy', scale: 'lydian', progression: 'lift', tempo: 72, chordSize: 4 },
  chill: { label: 'Chill', scale: 'major', progression: 'jazz', tempo: 82, swing: 0.2, chordSize: 4 },
  nostalgic: { label: 'Nostalgic', scale: 'major', progression: 'sad', tempo: 96 },
  melancholic: { label: 'Melancholic', scale: 'minor', progression: 'axis', tempo: 76 },
  cool: { label: 'Cool / modal', scale: 'dorian', progression: 'modal', tempo: 92, chordSize: 4 },
  mysterious: { label: 'Mysterious', scale: 'wholeTone', progression: 'lift', tempo: 70, consonance: 0.5 },
  dark: { label: 'Dark', scale: 'phrygian', progression: 'lift', tempo: 88 },
  tense: { label: 'Tense', scale: 'harmonicMinor', progression: 'andalusian', tempo: 140 },
  epic: { label: 'Epic', scale: 'minor', progression: 'epic', tempo: 92 },
  driving: { label: 'Driving', scale: 'minor', progression: 'minorDrive', tempo: 128 },
  exotic: { label: 'Exotic (Hijaz)', scale: 'phrygianDominant', progression: 'hijaz', tempo: 100 },
  japanese: { label: 'Japanese', scale: 'hirajoshi', progression: 'axis', tempo: 76 },
  gamelan: { label: 'Gamelan', scale: 'pelog', progression: 'drone', tempo: 96 },
  bluesy: { label: 'Bluesy', scale: 'blues', progression: 'blues', tempo: 96, swing: 0.33, chordSize: 4 },
  jazzy: { label: 'Jazzy', scale: 'major', progression: 'jazz', tempo: 132, swing: 0.33, chordSize: 4 },
  rock: { label: 'Rocking', scale: 'mixolydian', progression: 'rock', tempo: 128 },
  wandering: { label: 'Wandering (generated harmony)', scale: 'dorian', progression: 'markov', tempo: 100 },
};

export function applyMood(p: MusicParams, mood: string): MusicParams {
  const m = MOODS[mood];
  if (!m) return p;
  return {
    ...p, mood, scale: m.scale, progression: m.progression, tempo: m.tempo, swing: m.swing ?? 0,
    chordSize: m.chordSize ?? 3, consonance: m.consonance ?? 0.75,
  };
}

// ---------------------------------------------------------------- styles

const base = (): Omit<MusicParams, 'tracks'> => ({
  style: '', mood: '', key: 0, scale: 'major', tempo: 110, meter: 4, swing: 0, humanize: 0.3,
  progression: 'pop', chordBars: 1, chordSize: 3, consonance: 0.75,
  form: 'song', sectionBars: 8, bars: 32, energy: 0.7, variation: 0.3,
});

interface Style {
  label: string;
  mood: string;
  params: Partial<MusicParams>;
  tracks: [Role, Partial<TrackParams>][];
}

const t = (role: Role, instrument: string, patch: Partial<TrackParams> = {}): [Role, Partial<TrackParams>] =>
  [role, { instrument, ...patch }];

export const STYLES: Record<string, Style> = {
  ambient: {
    label: 'Ambient drift', mood: 'dreamy',
    params: { key: 2, tempo: 64, form: 'waves', bars: 32, sectionBars: 8, chordBars: 2, humanize: 0.5 },
    tracks: [
      t('pad', 'pad', { enter: 0 }),
      t('bass', 'subbass', { id: 'drone', name: 'Drone', algo: 'drone', rhythm: 'sustain', octave: 2, voices: 2, enter: 0, attack: 0.8, release: 2, gainDb: -5 }),
      t('melody', 'bell', { id: 'bells', name: 'Bells', algo: 'pink', rhythm: 'random', step: 1, density: 0.3, echo: 0.5, enter: 0.35, gainDb: -6 }),
      t('melody', 'piano', { algo: 'walk', density: 0.3, octave: 4, echo: 0.35, enter: 0.55, gainDb: -3 }),
    ],
  },
  lofi: {
    label: 'Lo-fi beat', mood: 'chill',
    params: { key: 5, tempo: 80, swing: 0.22, form: 'song', bars: 32, sectionBars: 4, humanize: 0.45 },
    tracks: [
      t('chords', 'epiano', { name: 'Keys', rhythm: 'syncopated', step: 2, density: 0.35, enter: 0 }),
      t('bass', 'fingerbass', { rhythm: 'phrase', density: 0.45, enter: 0.25 }),
      t('drums', 'lofi', { style: 'backbeat', density: 0.45, fills: 0.25, enter: 0.3 }),
      t('melody', 'vibes', { density: 0.4, echo: 0.3, enter: 0.55, gainDb: -2 }),
    ],
  },
  synthwave: {
    label: 'Synthwave', mood: 'melancholic',
    params: { key: 9, tempo: 100, form: 'song', bars: 48, sectionBars: 8 },
    tracks: [
      t('pad', 'pad', { bright: 0.4, enter: 0, gainDb: -3 }),
      t('bass', 'synthbass', { density: 0.9, enter: 0.2 }),
      t('arp', 'stab', { algo: 'arpUp', octave: 4, echo: 0.3, enter: 0.45, gainDb: -6 }),
      t('melody', 'sawlead', { name: 'Lead', algo: 'motif', echo: 0.25, enter: 0.7, gainDb: -2 }),
      t('drums', 'k909', { density: 0.4, fills: 0.5, enter: 0.3 }),
    ],
  },
  techno: {
    label: 'Techno build', mood: 'cool',
    params: { key: 7, tempo: 126, form: 'build', bars: 48, sectionBars: 8, chordSize: 3, variation: 0.2 },
    tracks: [
      t('drums', 'k909', { style: 'four', density: 0.55, fills: 0.2, enter: 0 }),
      t('bass', 'acid', { algo: 'walk', rhythm: 'random', step: 4, density: 0.55, range: 12, enter: 0.2 }),
      t('chords', 'stab', { name: 'Stabs', rhythm: 'euclid', step: 4, density: 0.19, voices: 3, echo: 0.35, enter: 0.45, gainDb: -4 }),
      t('pad', 'pad', { enter: 0.7, gainDb: -6 }),
    ],
  },
  chiptune: {
    label: 'Chiptune', mood: 'happy',
    params: { key: 0, tempo: 140, form: 'song', bars: 48, sectionBars: 8, humanize: 0 },
    tracks: [
      t('melody', 'chip', { name: 'Lead', algo: 'motif', step: 4, density: 0.55, range: 14, vibrato: 0.2, enter: 0.5 }),
      t('arp', 'chip', { algo: 'arpUpDown', step: 3, octave: 4, range: 12, enter: 0.3, gainDb: -7 }),
      t('bass', 'chiptri', { step: 2, octave: 3, enter: 0.15 }),
      t('drums', 'chip', { density: 0.4, fills: 0.5, enter: 0.3, gainDb: -2 }),
    ],
  },
  minimal: {
    label: 'Minimal pulse', mood: 'peaceful',
    params: { key: 4, tempo: 112, form: 'waves', bars: 48, sectionBars: 8, humanize: 0.15 },
    tracks: [
      t('melody', 'marimba', { id: 'pulse', name: 'Pulse', algo: 'automaton', rhythm: 'steady', step: 2, octave: 4, enter: 0 }),
      t('melody', 'marimba', { id: 'cells', name: 'Cells', algo: 'lsystem', rhythm: 'euclid', step: 4, density: 0.45, octave: 5, range: 12, enter: 0.3, gainDb: -3 }),
      t('bass', 'fingerbass', { rhythm: 'euclid', density: 0.4, enter: 0.45 }),
      t('drums', 'perc', { name: 'Shakers', style: 'euclid', density: 0.5, enter: 0.55, gainDb: -6 }),
      t('pad', 'glass', { enter: 0.7, gainDb: -6 }),
    ],
  },
  musicbox: {
    label: 'Music box lullaby', mood: 'happy',
    params: { key: 7, tempo: 84, meter: 3, form: 'arc', bars: 32, sectionBars: 8, humanize: 0.35 },
    tracks: [
      t('melody', 'musicbox', { octave: 6, range: 12, density: 0.5, echo: 0.2, enter: 0.2 }),
      t('arp', 'musicbox', { step: 2, octave: 5, range: 12, enter: 0, gainDb: -5 }),
      t('pad', 'glass', { enter: 0.5, gainDb: -9 }),
    ],
  },
  trap: {
    label: 'Trap', mood: 'tense',
    params: { key: 1, tempo: 140, form: 'song', bars: 32, sectionBars: 8, chordBars: 2 },
    tracks: [
      t('melody', 'fmbell', { name: 'Bells', density: 0.45, range: 12, echo: 0.3, enter: 0 }),
      t('drums', 'trap', { style: 'trap', density: 0.7, fills: 0.3, enter: 0.25 }),
      t('bass', 'boom', { name: '808', rhythm: 'phrase', density: 0.35, legato: 1, enter: 0.25 }),
      t('pad', 'pad', { bright: 0.25, enter: 0.5, gainDb: -7 }),
    ],
  },
  dnb: {
    label: 'Drum & bass', mood: 'melancholic',
    params: { key: 4, tempo: 172, form: 'song', bars: 64, sectionBars: 8, chordBars: 2 },
    tracks: [
      t('pad', 'pad', { enter: 0, gainDb: -4 }),
      t('drums', 'acoustic', { style: 'dnb', density: 0.6, fills: 0.5, enter: 0.3 }),
      t('bass', 'reese', { rhythm: 'phrase', density: 0.35, enter: 0.3 }),
      t('arp', 'nylon', { step: 2, echo: 0.4, enter: 0.5, gainDb: -4 }),
    ],
  },
  cinematic: {
    label: 'Cinematic', mood: 'epic',
    params: { key: 2, tempo: 90, form: 'arc', bars: 32, sectionBars: 8, chordBars: 2, humanize: 0.35 },
    tracks: [
      t('pad', 'strings', { name: 'Strings', enter: 0 }),
      t('bass', 'strings', { name: 'Low strings', algo: 'bass', rhythm: 'sustain', octave: 2, enter: 0, gainDb: -2 }),
      t('arp', 'piano', { algo: 'arpUpDown', step: 2, octave: 4, range: 24, enter: 0.35, gainDb: -5 }),
      t('melody', 'brass', { name: 'Brass', algo: 'motif', step: 1, density: 0.6, octave: 4, enter: 0.6 }),
      t('drums', 'acoustic', { style: 'halftime', density: 0.5, fills: 0.7, bright: 0.6, enter: 0.55 }),
    ],
  },
  jazz: {
    label: 'Jazz trio', mood: 'jazzy',
    params: { key: 10, form: 'song', bars: 32, sectionBars: 8, humanize: 0.5 },
    tracks: [
      t('chords', 'piano', { name: 'Comping', rhythm: 'syncopated', step: 2, density: 0.3, enter: 0.1, gainDb: -2 }),
      t('bass', 'fingerbass', { name: 'Walking bass', algo: 'walking', rhythm: 'steady', step: 1, enter: 0 }),
      t('drums', 'acoustic', { style: 'shuffle', density: 0.4, fills: 0.3, enter: 0.2, bright: 0.7 }),
      t('melody', 'vibes', { density: 0.55, enter: 0.4 }),
    ],
  },
  blues: {
    label: 'Blues shuffle', mood: 'bluesy',
    params: { key: 4, form: 'song', bars: 48, sectionBars: 12 },
    tracks: [
      t('chords', 'organ', { enter: 0, voices: 3, gainDb: -5 }),
      t('bass', 'fingerbass', { algo: 'walking', rhythm: 'steady', step: 1, enter: 0 }),
      t('melody', 'overdrive', { name: 'Guitar', step: 3, density: 0.45, octave: 4, enter: 0.4, gainDb: -2 }),
      t('drums', 'acoustic', { style: 'shuffle', density: 0.45, enter: 0.2 }),
    ],
  },
  bossa: {
    label: 'Bossa nova', mood: 'jazzy',
    params: { key: 2, tempo: 128, swing: 0, form: 'song', bars: 32, sectionBars: 8, humanize: 0.35 },
    tracks: [
      t('chords', 'nylon', { name: 'Guitar', rhythm: 'euclid', step: 4, density: 0.44, enter: 0 }),
      t('bass', 'fingerbass', { rhythm: 'euclid', step: 4, density: 0.19, enter: 0 }),
      t('melody', 'flute', { density: 0.5, enter: 0.45 }),
      t('drums', 'perc', { name: 'Percussion', style: 'bossa', density: 0.5, enter: 0.2, gainDb: -3 }),
    ],
  },
  gamelan: {
    label: 'Gamelan bells', mood: 'gamelan',
    params: { key: 3, form: 'waves', bars: 32, sectionBars: 8, humanize: 0.2 },
    tracks: [
      t('melody', 'glock', { id: 'bonang', name: 'Bonang', algo: 'automaton', rhythm: 'steady', step: 2, octave: 5, range: 10, enter: 0 }),
      t('melody', 'marimba', { id: 'saron', name: 'Saron', algo: 'lsystem', rhythm: 'steady', step: 1, octave: 4, range: 10, enter: 0.2 }),
      t('bass', 'bell', { id: 'gong', name: 'Gong', algo: 'drone', rhythm: 'sustain', octave: 3, voices: 1, enter: 0, gainDb: -2 }),
      t('drums', 'perc', { name: 'Kendang', style: 'euclid', density: 0.5, enter: 0.5, gainDb: -4 }),
    ],
  },
  rock: {
    label: 'Driving rock', mood: 'rock',
    params: { key: 4, form: 'song', bars: 48, sectionBars: 8 },
    tracks: [
      t('chords', 'overdrive', { name: 'Rhythm guitar', rhythm: 'steady', step: 2, voices: 3, octave: 3, legato: 0.7, enter: 0.2, gainDb: -3 }),
      t('bass', 'fingerbass', { density: 0.9, enter: 0.2 }),
      t('melody', 'sawlead', { name: 'Lead', algo: 'motif', enter: 0.7, gainDb: -3 }),
      t('drums', 'acoustic', { density: 0.5, fills: 0.5, enter: 0 }),
    ],
  },
  piano: {
    label: 'Generative piano', mood: 'melancholic',
    params: { key: 9, tempo: 72, form: 'arc', bars: 32, sectionBars: 8, chordBars: 2, humanize: 0.6 },
    tracks: [
      t('arp', 'piano', { id: 'left', name: 'Left hand', algo: 'arpUpDown', step: 2, octave: 3, range: 24, enter: 0 }),
      t('melody', 'piano', { id: 'right', name: 'Right hand', density: 0.45, enter: 0.3 }),
    ],
  },
};

/** Ids are unique within a piece. */
function uniqueIds(tracks: TrackParams[]) {
  const seen = new Set<string>();
  for (const tr of tracks) {
    let id = tr.id;
    for (let i = 2; seen.has(id); i++) id = `${tr.id}${i}`;
    tr.id = id;
    seen.add(id);
  }
  return tracks;
}

/** Keep a piece within the length limit by dropping bars. */
export function fitLength(p: MusicParams): MusicParams {
  const max = Math.max(1, Math.floor(MAX_SECONDS / barSeconds(p)));
  return p.bars > max ? { ...p, bars: max } : p;
}

export function styleParams(style: string, mood?: string): MusicParams {
  const s = STYLES[style] ?? STYLES.lofi;
  let p: MusicParams = { ...base(), style, tracks: [] };
  p = applyMood(p, s.mood);
  p = { ...p, ...s.params, style };
  if (mood && mood !== s.mood) p = { ...applyMood(p, mood) };
  p.tracks = uniqueIds(s.tracks.map(([role, patch]) => makeTrack(role, patch)));
  return fitLength(p);
}

/** A random style, mood and key. */
export function surprise(r: Rng): MusicParams {
  const style = pickOf(r, Object.keys(STYLES));
  const mood = r() < 0.5 ? undefined : pickOf(r, Object.keys(MOODS));
  return { ...styleParams(style, mood), key: int(r, 0, 11) };
}

/** A new track for a role, with an id not yet used in the piece. */
export function newTrack(p: MusicParams, role: Role): TrackParams {
  const tr = makeTrack(role, role === 'drums' ? { instrument: Object.keys(KITS)[0] } : {});
  return uniqueIds([...p.tracks.map((x) => ({ ...x })), tr]).pop()!;
}

export const defaultMusic = () => styleParams('lofi');
