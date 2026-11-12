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
  loop: boolean;
  /** Seconds after "play" before the sound starts. */
  startDelay: number;
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

export type ViewMode = 'top' | '3d' | 'split';

export interface Scene {
  version: number;
  masterDb: number;
  listener: { yaw: number; spin: number };
  environment: { preset: string; wet: number };
  physics: Physics;
  view: { scale: number; mode: ViewMode };
  sources: Source[];
}

export interface Sound {
  id: string;
  name: string;
  /** Mono buffer. Replaced, never mutated, on edit. */
  buffer: AudioBuffer;
  version: number;
  created: number;
}

export interface Selection {
  start: number;
  end: number;
}
