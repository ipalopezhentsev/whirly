// Motion paths: pure functions of scene time → position (metres, Web Audio axes).
// Axes: +x = right, +y = up, −z = front (the listener's default facing direction).
import { DEG, TAU, mod } from '../audio/util';
import type { Motion, MotionType, Source, Vec3 } from './types';

export interface ParamSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  unit?: string;
  /** A random seed rather than a quantity: shown with a 🎲 button, randomized for new and duplicated sources. */
  seed?: boolean;
}

export interface MotionDef {
  label: string;
  hint: string;
  params: Record<string, ParamSpec>;
}

export const MOTIONS: Record<MotionType, MotionDef> = {
  static: { label: 'Static', hint: '', params: {} },
  orbit: {
    label: 'Orbit around listener',
    hint: 'Radius and starting angle come from the anchor position. Positive speed = clockwise.',
    params: {
      speed: { label: 'Angular speed', min: -360, max: 360, step: 1, def: 45, unit: '°/s' },
      bob: { label: 'Height wobble', min: 0, max: 10, step: 0.1, def: 0, unit: 'm' },
    },
  },
  approach: {
    label: 'Approach & recede',
    hint: 'Moves along the line from you through the anchor, between the nearest and farthest distance.',
    params: {
      near: { label: 'Nearest', min: 0.2, max: 50, step: 0.1, def: 1, unit: 'm' },
      far: { label: 'Farthest', min: 1, max: 500, step: 1, def: 30, unit: 'm' },
      period: { label: 'Cycle time', min: 1, max: 60, step: 0.5, def: 8, unit: 's' },
    },
  },
  flyby: {
    label: 'Fly-by (back & forth)',
    hint: 'The anchor is the middle of the path, e.g. the point on a road nearest to you. Raise it for an overflight.',
    params: {
      speed: { label: 'Speed', min: 0.5, max: 340, step: 0.5, def: 20, unit: 'm/s' },
      length: { label: 'Path length', min: 2, max: 1000, step: 1, def: 120, unit: 'm' },
      heading: { label: 'Heading', min: -180, max: 180, step: 1, def: 90, unit: '°' },
    },
  },
  pass: {
    label: 'Drive past (one way)',
    hint: 'Fades in at the start of the path, drives through the anchor, fades out at the end, then repeats after the pause. Heading 90° = left to right.',
    params: {
      speed: { label: 'Speed', min: 0.5, max: 340, step: 0.5, def: 20, unit: 'm/s' },
      length: { label: 'Path length', min: 2, max: 1000, step: 1, def: 160, unit: 'm' },
      heading: { label: 'Heading', min: -180, max: 180, step: 1, def: 90, unit: '°' },
      gap: { label: 'Pause', min: 0, max: 60, step: 0.5, def: 2, unit: 's' },
    },
  },
  circle: {
    label: 'Circle around anchor',
    hint: 'Circles around its own anchor point, not around you.',
    params: {
      radius: { label: 'Radius', min: 0.1, max: 50, step: 0.1, def: 2, unit: 'm' },
      speed: { label: 'Angular speed', min: -720, max: 720, step: 1, def: 90, unit: '°/s' },
    },
  },
  rise: {
    label: 'Rise & fall',
    hint: 'Moves vertically. Useful for testing elevation cues.',
    params: {
      low: { label: 'Lowest', min: -100, max: 100, step: 0.1, def: -1.5, unit: 'm' },
      high: { label: 'Highest', min: -100, max: 100, step: 0.1, def: 5, unit: 'm' },
      period: { label: 'Cycle time', min: 1, max: 60, step: 0.5, def: 6, unit: 's' },
    },
  },
  wander: {
    label: 'Random wander',
    hint: 'Drifts smoothly around the anchor. Each seed is a different path; sources with the same seed and settings move identically.',
    params: {
      radius: { label: 'Range', min: 0.5, max: 100, step: 0.5, def: 4, unit: 'm' },
      pace: { label: 'Pace', min: 0.05, max: 3, step: 0.05, def: 0.5, unit: '×' },
      vertical: { label: 'Vertical', min: 0, max: 1, step: 0.05, def: 0.3, unit: '×' },
      seed: { label: 'Path seed', min: 0, max: 999999, step: 1, def: 0, seed: true },
    },
  },
};

const SEED_MAX = 999999;
export const randomSeed = () => 1 + Math.floor(Math.random() * SEED_MAX);

/** A stable seed from text (a source id), for saved scenes made before seeds existed. */
export function seedFrom(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return 1 + ((h >>> 0) % SEED_MAX);
}

/** Give every seed parameter a fresh random value (new and duplicated sources). */
export function reseedMotion(m: Motion): Motion {
  const params = { ...m.params };
  for (const k of MOTION_TYPES) {
    for (const [pk, spec] of Object.entries(MOTIONS[k].params)) {
      if (spec.seed) params[k] = { ...params[k], [pk]: randomSeed() };
    }
  }
  return { ...m, params };
}

/** Wander path shape per seed: a phase for each sine and a small spread of its rate. */
const wanderShapes = new Map<number, { ph: number[]; f: number[] }>();
function wanderShape(seed: number) {
  let s = wanderShapes.get(seed);
  if (!s) {
    // mulberry32
    let a = seed | 0;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    s = { ph: Array.from({ length: 6 }, () => rnd() * TAU), f: Array.from({ length: 6 }, () => 0.85 + rnd() * 0.3) };
    if (wanderShapes.size > 500) wanderShapes.clear();
    wanderShapes.set(seed, s);
  }
  return s;
}

export const MOTION_TYPES = Object.keys(MOTIONS) as MotionType[];

/** Default motion settings; seeds are random, so each new source wanders its own way. */
export function defaultMotion(): Motion {
  const params = {} as Motion['params'];
  for (const k of MOTION_TYPES) {
    params[k] = Object.fromEntries(Object.entries(MOTIONS[k].params).map(([pk, p]) => [pk, p.seed ? randomSeed() : p.def]));
  }
  return { type: 'static', params };
}

/** Position of a source at scene time t (seconds). */
export function positionAt(src: Source, t: number): Vec3 {
  const { x, y, z } = src.pos;
  const p = src.motion.params[src.motion.type];
  switch (src.motion.type) {
    case 'orbit': {
      const r = Math.max(0.05, Math.hypot(x, z));
      const a = Math.atan2(z, x) + p.speed * DEG * t;
      return { x: r * Math.cos(a), y: y + p.bob * Math.sin(TAU * 0.25 * t), z: r * Math.sin(a) };
    }
    case 'approach': {
      const r = Math.hypot(x, z);
      const ux = r > 1e-3 ? x / r : 0;
      const uz = r > 1e-3 ? z / r : -1;
      const near = Math.min(p.near, p.far);
      const far = Math.max(p.near, p.far);
      const d = near + (far - near) * (0.5 - 0.5 * Math.cos((TAU * t) / p.period));
      return { x: ux * d, y, z: uz * d };
    }
    case 'flyby': {
      const L = p.length;
      const u = mod(t * p.speed, 2 * L);
      const s = u < L ? u - L / 2 : 1.5 * L - u;
      const h = p.heading * DEG;
      return { x: x + Math.sin(h) * s, y, z: z - Math.cos(h) * s };
    }
    case 'pass': {
      const travel = p.length / p.speed;
      const u = mod(t, travel + p.gap);
      // During the pause it waits (silently) at the start of the path.
      const s = Math.min(u, travel) * p.speed - p.length / 2;
      const h = p.heading * DEG;
      return { x: x + Math.sin(h) * s, y, z: z - Math.cos(h) * s };
    }
    case 'circle': {
      const a = p.speed * DEG * t;
      return { x: x + p.radius * Math.cos(a), y, z: z + p.radius * Math.sin(a) };
    }
    case 'rise': {
      const k = 0.5 - 0.5 * Math.cos((TAU * t) / p.period);
      return { x, y: p.low + (p.high - p.low) * k, z };
    }
    case 'wander': {
      const w = p.pace * t;
      const R = p.radius * 0.5;
      const { ph, f } = wanderShape(p.seed ?? 0);
      return {
        x: x + R * (Math.sin(w * f[0] + ph[0]) + Math.sin(w * 1.618 * f[1] + ph[1])),
        y: y + p.vertical * R * (Math.sin(w * 0.7 * f[2] + ph[2]) + 0.5 * Math.sin(w * 1.9 * f[3] + ph[3])),
        z: z + R * (Math.sin(w * 1.27 * f[4] + ph[4]) + Math.sin(w * 0.73 * f[5] + ph[5])),
      };
    }
    default:
      return { x, y, z };
  }
}

/** Duration of one full motion cycle (used to draw the path). 0 = no motion. */
export function motionPeriod(src: Source): number {
  const p = src.motion.params[src.motion.type];
  switch (src.motion.type) {
    case 'orbit':
    case 'circle':
      return p.speed ? 360 / Math.abs(p.speed) : 0;
    case 'approach':
    case 'rise':
      return p.period;
    case 'flyby':
      return (2 * p.length) / p.speed;
    case 'pass':
      return p.length / p.speed;
    case 'wander':
      return 8 / p.pace; // just the next stretch; the full path never repeats
    default:
      return 0;
  }
}

/**
 * Loudness envelope imposed by the motion itself (0..1). Only one-way passes use it,
 * to fade in/out at the ends of the path so the jump back to the start is inaudible.
 */
export function motionGain(src: Source, t: number): number {
  if (src.motion.type !== 'pass') return 1;
  const p = src.motion.params.pass;
  const travel = p.length / p.speed;
  const u = mod(t, travel + p.gap);
  if (u >= travel) return 0;
  const edge = Math.min(u, travel - u) / (travel * 0.12);
  const k = Math.min(1, edge);
  return k * k * (3 - 2 * k); // smoothstep
}

export function velocityAt(src: Source, t: number, dt = 0.01): Vec3 {
  const a = positionAt(src, t - dt);
  const b = positionAt(src, t + dt);
  return { x: (b.x - a.x) / (2 * dt), y: (b.y - a.y) / (2 * dt), z: (b.z - a.z) / (2 * dt) };
}

/** Where a path preview starts: periodic paths are drawn whole, a wander path from "now". */
export const pathStart = (src: Source, t: number) => (src.motion.type === 'wander' ? t : 0);
