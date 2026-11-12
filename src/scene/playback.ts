// When a source's sound plays. 'loop' and 'once' are a single player node; 'random' fires the
// sound again and again with a random pause between plays (thunder, a dog barking, a door slam),
// each play a little louder or quieter and higher or lower, so the repeats don't sound identical.
//
// The random schedule is a pure function of the source's settings and seed, so the realtime
// engine and the offline renderer play it at exactly the same times.
import { rngFor } from '../audio/music/rng';
import { dbToGain } from '../audio/util';
import type { Source } from './types';

export type Playback = 'loop' | 'once' | 'random';

export const PLAYBACKS: [Playback, string][] = [
  ['loop', 'Loop'],
  ['once', 'Once'],
  ['random', 'At random times'],
];

/** One random play: its index, start time (scene seconds), level (linear gain) and playback rate. */
export interface Cue {
  k: number;
  t: number;
  gain: number;
  rate: number;
}

/** Plays never start closer together than this, so a zero pause can't schedule unbounded nodes. */
const MIN_STEP = 0.05;

/** Silence before random play k. */
function pause(src: Source, k: number) {
  const lo = Math.max(0, Math.min(src.gapMin, src.gapMax));
  const hi = Math.max(0, src.gapMin, src.gapMax);
  return lo + rngFor('pause', src.playSeed, k)() * (hi - lo);
}

function cue(src: Source, k: number, t: number): Cue {
  const r = rngFor('vary', src.playSeed, k);
  return { k, t, gain: dbToGain((r() * 2 - 1) * src.varyDb), rate: 2 ** (((r() * 2 - 1) * src.varyPitch) / 12) };
}

/** How long a play lasts: higher plays are faster, so shorter. */
export const playLength = (c: Cue, dur: number) => dur / c.rate;

/**
 * The first random play. As if the sequence had already been running, it lands at a random point
 * within its pause after "Starts at", rather than always right away or always a full pause later.
 */
export function firstCue(src: Source): Cue {
  return cue(src, 0, src.startDelay + rngFor('first', src.playSeed)() * pause(src, 0));
}

export function nextCue(src: Source, c: Cue, dur: number): Cue {
  return cue(src, c.k + 1, c.t + Math.max(MIN_STEP, playLength(c, dur) + pause(src, c.k + 1)));
}

/**
 * The first random play still sounding at scene time t, or, with `unstarted`, the first one that
 * starts at or after t.
 */
export function cueAt(src: Source, dur: number, t: number, unstarted = false): Cue {
  let c = firstCue(src);
  while (unstarted ? c.t < t : c.t + playLength(c, dur) <= t) c = nextCue(src, c, dur);
  return c;
}

/** What the random schedule depends on (besides the sound and the start delay). */
export const cueKey = (src: Source) => `${src.playSeed}:${src.gapMin}:${src.gapMax}:${src.varyDb}:${src.varyPitch}`;
