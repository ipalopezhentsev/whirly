import type { CustomParams } from '../audio/synth';
import type { SpeechParams } from '../audio/speech';
import type { MusicParams } from '../audio/music/types';
import type { Playback } from './playback';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type MotionType = 'static' | 'orbit' | 'approach' | 'flyby' | 'pass' | 'circle' | 'rise' | 'wander';

export interface Motion {
  type: MotionType;
  /** Parameters for every motion type, so switching types keeps earlier settings. */
  params: Record<MotionType, Record<string, number>>;
}

/** Which way a directional source points. */
export type Aim = 'listener' | 'fixed' | 'motion';

export interface Source {
  id: string;
  name: string;
  color: string;
  soundId: string | null;
  gainDb: number;
  playback: Playback;
  /** Seconds after "play" before the sound starts. */
  startDelay: number;
  /** Random playback: shortest and longest pause between plays, in seconds. */
  gapMin: number;
  gapMax: number;
  /** Random playback: each play's level varies by up to ± this many dB, and its pitch by ± this many semitones. */
  varyDb: number;
  varyPitch: number;
  /** Random playback: seed for the pauses and variations. */
  playSeed: number;
  muted: boolean;
  solo: boolean;
  /** Anchor position in metres: +x right, +y up, −z front. */
  pos: Vec3;
  motion: Motion;
  directional: boolean;
  aim: Aim;
  /** Facing direction in degrees when aim = 'fixed' (0 = front, clockwise). */
  yaw: number;
  coneInner: number;
  coneOuter: number;
  coneOuterGain: number;
}

export interface Physics {
  panningModel: PanningModelType;
  distanceModel: DistanceModelType;
  refDistance: number;
  maxDistance: number;
  rolloff: number;
  /** Propagation delay (and therefore Doppler shift). */
  doppler: boolean;
  speedOfSound: number;
  /** High-frequency air absorption over distance. */
  air: boolean;
  airAmount: number;
  /** Extra pinna-style spectral cues on top of the generic HRTF, which is weak on elevation. */
  elevationCues: boolean;
  elevAmount: number;
  /** Reflection off the floor (an image source mirrored below the floor). */
  floor: boolean;
  floorAmount: number;
  /** Listener's ear height above the floor, in metres. The floor is at y = −earHeight. */
  earHeight: number;
}

export interface Scene {
  version: number;
  masterDb: number;
  listener: { yaw: number; spin: number };
  environment: { preset: string; wet: number };
  physics: Physics;
  sources: Source[];
}

export type EditKind =
  | 'crop' | 'delete' | 'silence' | 'reverse' | 'normalize' | 'fadeIn' | 'fadeOut' | 'gain' | 'trim' | 'loopFade' | 'speed';

/** One sound edit, as data, so it can be replayed (see `applyEdit`). */
export interface EditOp {
  op: EditKind;
  sel?: Selection | null;
  /** Amount, for gain (dB) and speed (×). */
  v?: number;
}

/** How to regenerate a synthesized sound exactly: share links carry this instead of the audio. */
export interface SynthRecipe {
  preset: string;
  dur: number;
  /** Seed for the synth's random generator (noise, random rhythms). */
  seed: number;
  /** Custom-synth settings (only for the 'custom' preset). */
  params?: CustomParams;
  /** Text and voice settings (only for the 'voice' preset when it speaks text). */
  speech?: SpeechParams;
  /** Composition settings (only for the 'music' preset); `music.stem` makes the sound one track's stem. */
  music?: MusicParams;
  edits: EditOp[];
}

export interface Sound {
  id: string;
  name: string;
  /** Mono buffer. Replaced, never mutated, on edit. */
  buffer: AudioBuffer;
  version: number;
  created: number;
  /** Set for synthesized sounds; recorded and imported sounds have none. */
  recipe?: SynthRecipe;
}

export interface Selection {
  start: number;
  end: number;
}
