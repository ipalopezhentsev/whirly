import { defaultMotion, MOTIONS, MOTION_TYPES } from './motion';
import { ENVIRONMENTS } from '../audio/reverb';
import { uid } from '../audio/util';
import type { Scene, Source, Vec3 } from './types';

export const COLORS = ['#4fd1c5', '#f6ad55', '#a78bfa', '#f687b3', '#63b3ed', '#68d391', '#fc8181', '#faf089'];

export function defaultScene(): Scene {
  return {
    version: 1,
    masterDb: 0,
    listener: { yaw: 0, spin: 0 },
    environment: { preset: 'room', wet: ENVIRONMENTS.room.wet },
    physics: {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: 1,
      maxDistance: 1000,
      rolloff: 1,
      doppler: true,
      speedOfSound: 343,
      air: true,
      airAmount: 1,
      elevationCues: true,
      elevAmount: 1,
      floor: true,
      floorAmount: 0.5,
      earHeight: 1.6,
    },
    view: { scale: 28, mode: 'split' },
    sources: [],
  };
}

export function newSource(scene: Scene, soundId: string | null, pos: Partial<Vec3> = {}, name?: string): Source {
  const i = scene.sources.length;
  return {
    id: uid(),
    name: name || `Source ${i + 1}`,
    color: COLORS[i % COLORS.length],
    soundId,
    gainDb: 0,
    loop: true,
    startDelay: 0,
    muted: false,
    solo: false,
    pos: { x: 0, y: 0, z: -2, ...pos },
    motion: defaultMotion(),
    directional: false,
    aim: 'listener',
    yaw: 0,
    coneInner: 90,
    coneOuter: 240,
    coneOuterGain: 0.15,
  };
}

/** Merge a saved scene with current defaults so older saves keep working. */
export function hydrateScene(raw: any): Scene {
  const d = defaultScene();
  if (!raw || typeof raw !== 'object') return d;
  const s: Scene = {
    ...d,
    ...raw,
    listener: { ...d.listener, ...raw.listener },
    environment: { ...d.environment, ...raw.environment },
    physics: { ...d.physics, ...raw.physics },
    view: { ...d.view, ...raw.view },
    sources: [],
  };
  if (!ENVIRONMENTS[s.environment.preset]) s.environment.preset = 'room';
  for (const src of raw.sources || []) {
    const base = newSource(s, src.soundId ?? null, src.pos);
    const motion = defaultMotion();
    for (const k of MOTION_TYPES) motion.params[k] = { ...motion.params[k], ...(src.motion?.params?.[k] || {}) };
    motion.type = src.motion?.type in MOTIONS ? src.motion.type : 'static';
    s.sources.push({ ...base, ...src, pos: { ...base.pos, ...src.pos }, motion });
  }
  return s;
}
