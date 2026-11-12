// The spatial signal chain, shared by the realtime engine and the offline WAV renderer.
//
// Per source:
//   player(s) → gain → delay (propagation / Doppler) → air (low-pass) → elevation EQ → panner (HRTF + distance + cone) → master
//                │                                       └→ send → convolver (room) → reverbReturn → master
//                └→ reflDelay → reflAir → reflPanner → reflGain → master      (floor reflection: mirrored image source)
//
// Everything that changes over time is computed by `computeState` as a pure function of scene time,
// then pushed into AudioParams: smoothed per animation frame in realtime, or as dense linear ramps offline.
import { motionGain, positionAt, velocityAt } from '../scene/motion';
import { firstCue, nextCue, playLength, type Cue } from '../scene/playback';
import type { Physics, Scene, Sound, Source, Vec3 } from '../scene/types';
import { getImpulse } from './reverb';
import { clamp, dbToGain, DEG } from './util';

/** Longest propagation delay we can model (seconds). 10 s ≈ 3.4 km in air. */
export const MAX_DELAY = 10;

export interface SourceState {
  /** Where the sound is heard from: the "retarded" position, where the source was when it emitted it. */
  heard: Vec3;
  /** Where the source actually is right now. */
  now: Vec3;
  distance: number;
  delay: number;
  gain: number;
  distanceGain: number;
  cutoff: number;
  send: number;
  orient: Vec3 | null;
  /** Elevation angle of the heard position, degrees (+ = above ear level). */
  elevation: number;
  eq: ElevationEq;
  refl: { pos: Vec3; delay: number; gain: number; cutoff: number };
}

export interface ElevationEq {
  notchF: number;
  notchGain: number;
  peakGain: number;
  shelfGain: number;
}

export interface Output {
  master: GainNode;
  limiter: DynamicsCompressorNode;
  reverbReturn: GainNode;
  convolver: ConvolverNode | null;
  envKey: string | null;
}

export interface Chain {
  srcId: string;
  key: string;
  buffer: AudioBuffer;
  /** Player nodes scheduled or sounding, with their start (context time): one, except for random playback, where each play gets its own. */
  players: Map<AudioBufferSourceNode, number>;
  /** Random playback (realtime): the next play not scheduled yet, and the settings it was worked out from. */
  cue?: Cue;
  cueKey?: string;
  gain: GainNode;
  delay: DelayNode;
  air: BiquadFilterNode;
  notch: BiquadFilterNode;
  peak: BiquadFilterNode;
  shelf: BiquadFilterNode;
  panner: PannerNode;
  send: GainNode;
  reflDelay: DelayNode;
  reflAir: BiquadFilterNode;
  reflPanner: PannerNode;
  reflGain: GainNode;
  analyser?: AnalyserNode;
  abuf?: Float32Array<ArrayBuffer>;
}

const len3 = (p: Vec3) => Math.hypot(p.x, p.y, p.z);

/** Same formulas the PannerNode uses, so readouts match what you hear. */
export function distanceGain(d: number, ph: Physics) {
  const ref = Math.max(0.001, ph.refDistance);
  const r = ph.rolloff;
  switch (ph.distanceModel) {
    case 'linear': {
      const max = Math.max(ref + 0.001, ph.maxDistance);
      const dd = clamp(d, ref, max);
      return clamp(1 - (Math.min(r, 1) * (dd - ref)) / (max - ref), 0, 1);
    }
    case 'exponential':
      return Math.pow(Math.max(d, ref) / ref, -r);
    default:
      return ref / (ref + r * (Math.max(d, ref) - ref));
  }
}

/** Air absorbs high frequencies over distance; modelled as a falling low-pass cutoff. */
export function airCutoff(d: number, ph: Physics) {
  if (!ph.air) return 20000;
  return clamp(20000 / (1 + (d * ph.airAmount) / 20), 300, 20000);
}

/**
 * Spectral elevation cues layered over the generic HRTF:
 *  - the pinna notch moves up in frequency as the source rises (~5.7 kHz at −45°, ~11 kHz at +45°),
 *  - a boost around 8 kHz reads as "above" (Blauert's directional bands),
 *  - torso shadowing dulls sources below.
 * Depth grows with |elevation| so sources at ear level are not coloured.
 */
export function elevationEq(elevDeg: number, ph: Physics): ElevationEq {
  if (!ph.elevationCues) return { notchF: 8000, notchGain: 0, peakGain: 0, shelfGain: 0 };
  const e = clamp(elevDeg, -90, 90);
  const k = ph.elevAmount;
  const s = Math.sin(e * DEG);
  const depth = Math.min(1, Math.abs(e) / 20) * (e > 60 ? (90 - e) / 30 : 1);
  return {
    notchF: clamp(8000 * Math.pow(2, e / 90), 5000, 13000),
    notchGain: -14 * k * depth,
    peakGain: 7 * k * Math.max(0, s),
    shelfGain: -9 * k * Math.max(0, -s),
  };
}

export const listenerYaw =(scene: Scene, t: number) => scene.listener.yaw + scene.listener.spin * t;

export const anySolo = (scene: Scene) => scene.sources.some((s) => s.solo && !s.muted);

export function computeState(src: Source, scene: Scene, t: number, solo = anySolo(scene)): SourceState {
  const ph = scene.physics;
  const c = Math.max(1, ph.speedOfSound);
  const now = positionAt(src, t);
  let heard = now;
  let d = len3(now);
  let delay = 0;
  let te = t;
  if (ph.doppler) {
    // Solve te = t − |p(te)| / c by fixed-point iteration: the sound reaching us now
    // left the source at te. Driving the delay line with t − te gives physical Doppler.
    for (let i = 0; i < 4; i++) {
      te = t - d / c;
      heard = positionAt(src, te);
      d = len3(heard);
    }
    delay = Math.min(d / c, MAX_DELAY - 0.05);
  }
  const dg = distanceGain(d, ph);
  const audible = !src.muted && (!solo || src.solo);

  let orient: Vec3 | null = null;
  if (src.directional) {
    let v: Vec3;
    if (src.aim === 'listener') v = { x: -heard.x, y: -heard.y, z: -heard.z };
    else if (src.aim === 'motion') v = velocityAt(src, te);
    else v = { x: Math.sin(src.yaw * DEG), y: 0, z: -Math.cos(src.yaw * DEG) };
    const n = len3(v);
    orient = n > 1e-6 ? { x: v.x / n, y: v.y / n, z: v.z / n } : { x: Math.sin(src.yaw * DEG), y: 0, z: -Math.cos(src.yaw * DEG) };
  }

  // Floor reflection: mirror the heard position in the floor plane y = −earHeight.
  const floorY = -ph.earHeight;
  const mirror = { x: heard.x, y: 2 * floorY - heard.y, z: heard.z };
  const dRefl = len3(mirror);
  const reflOn = ph.floor && heard.y > floorY;
  const refl = {
    pos: mirror,
    delay: clamp(ph.doppler ? dRefl / c : (dRefl - d) / c, 0, MAX_DELAY - 0.05),
    gain: reflOn ? ph.floorAmount : 0,
    // A floor absorbs some of the highs.
    cutoff: Math.min(airCutoff(dRefl, ph), 9000),
  };
  const elevation = Math.atan2(heard.y, Math.hypot(heard.x, heard.z)) / DEG;

  return {
    heard,
    now,
    distance: d,
    elevation,
    eq: elevationEq(elevation, ph),
    refl,
    delay,
    // Use the emission time, so a fade-out at the end of a pass is heard when that sound arrives.
    gain: audible ? dbToGain(src.gainDb) * motionGain(src, te) : 0,
    distanceGain: dg,
    cutoff: airCutoff(d, ph),
    // The reverberant field falls off much more slowly than the direct sound, so
    // far-away sources sound "wetter" — the main perceptual distance cue in a room.
    send: Math.sqrt(dg),
    orient,
  };
}

// ---------------------------------------------------------------- graph building

export function pannerOptions(ph: Physics, src: Source): PannerOptions {
  return {
    panningModel: ph.panningModel,
    distanceModel: ph.distanceModel,
    refDistance: Math.max(0.01, ph.refDistance),
    maxDistance: Math.max(ph.refDistance + 0.01, ph.maxDistance),
    rolloffFactor: Math.max(0, ph.rolloff),
    coneInnerAngle: src.directional ? src.coneInner : 360,
    coneOuterAngle: src.directional ? src.coneOuter : 360,
    coneOuterGain: clamp(src.coneOuterGain, 0, 1),
  };
}

/** Update non-automatable panner settings, touching only what changed. */
export function applyPannerProps(panner: PannerNode, ph: Physics, src: Source) {
  const o = pannerOptions(ph, src);
  if (panner.panningModel !== o.panningModel) panner.panningModel = o.panningModel!;
  if (panner.distanceModel !== o.distanceModel) panner.distanceModel = o.distanceModel!;
  if (panner.refDistance !== o.refDistance) panner.refDistance = o.refDistance!;
  if (panner.maxDistance !== o.maxDistance) panner.maxDistance = o.maxDistance!;
  if (panner.rolloffFactor !== o.rolloffFactor) panner.rolloffFactor = o.rolloffFactor!;
  if (panner.coneInnerAngle !== o.coneInnerAngle) panner.coneInnerAngle = o.coneInnerAngle!;
  if (panner.coneOuterAngle !== o.coneOuterAngle) panner.coneOuterAngle = o.coneOuterAngle!;
  if (Math.abs(panner.coneOuterGain - o.coneOuterGain!) > 1e-6) panner.coneOuterGain = o.coneOuterGain!;
}

export function buildOutput(ctx: BaseAudioContext, scene: Scene, destination: AudioNode): Output {
  const master = new GainNode(ctx, { gain: dbToGain(scene.masterDb) });
  // A brick-wall-ish limiter keeps close, loud sources from clipping the mix.
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.15 });
  master.connect(limiter).connect(destination);
  const reverbReturn = new GainNode(ctx, { gain: scene.environment.wet });
  reverbReturn.connect(master);
  const out: Output = { master, limiter, reverbReturn, convolver: null, envKey: null };
  setEnvironment(ctx, out, scene.environment.preset);
  return out;
}

/** Swap the room impulse response. Returns true when the convolver changed. */
export function setEnvironment(ctx: BaseAudioContext, out: Output, preset: string) {
  if (out.envKey === preset) return false;
  out.envKey = preset;
  out.convolver?.disconnect();
  const ir = getImpulse(ctx.sampleRate, preset);
  out.convolver = ir ? new ConvolverNode(ctx, { buffer: ir }) : null;
  out.convolver?.connect(out.reverbReturn);
  return true;
}

export function createChain(ctx: BaseAudioContext, src: Source, buffer: AudioBuffer, out: Output, ph: Physics, key = '', withAnalyser = false): Chain {
  const gain = new GainNode(ctx, { gain: 0 });
  const delay = new DelayNode(ctx, { maxDelayTime: MAX_DELAY, delayTime: 0 });
  const air = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 20000, Q: 0.707 });
  const notch = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 8000, Q: 3, gain: 0 });
  const peak = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 8000, Q: 1.4, gain: 0 });
  const shelf = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 3500, gain: 0 });
  const panner = new PannerNode(ctx, pannerOptions(ph, src));
  const send = new GainNode(ctx, { gain: 0 });
  gain.connect(delay).connect(air).connect(notch).connect(peak).connect(shelf).connect(panner).connect(out.master);
  air.connect(send);
  if (out.convolver) send.connect(out.convolver);

  const reflDelay = new DelayNode(ctx, { maxDelayTime: MAX_DELAY, delayTime: 0 });
  const reflAir = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 9000, Q: 0.707 });
  const reflPanner = new PannerNode(ctx, pannerOptions(ph, { ...src, directional: false }));
  const reflGain = new GainNode(ctx, { gain: 0 });
  gain.connect(reflDelay).connect(reflAir).connect(reflPanner).connect(reflGain).connect(out.master);

  const chain: Chain = {
    srcId: src.id, key, buffer, players: new Map(), gain, delay, air, notch, peak, shelf, panner, send, reflDelay, reflAir, reflPanner, reflGain,
  };
  if (withAnalyser) {
    chain.analyser = new AnalyserNode(ctx, { fftSize: 512 });
    chain.abuf = new Float32Array(512);
    gain.connect(chain.analyser);
  }
  return chain;
}

export interface PlayOptions {
  /** Seconds into the sound (buffer time) to start from. */
  offset?: number;
  loop?: boolean;
  /** Level of this play alone (linear), for random variation. */
  gain?: number;
  playbackRate?: number;
}

/** Where in its sound each player starts and how fast it runs, to tell where it is now. */
const plays = new WeakMap<AudioBufferSourceNode, { offset: number; rate: number; loop: boolean }>();

/**
 * Where the chain's sound is playing (seconds into the sound), as heard now: a distant source is
 * heard a moment after it plays, by its propagation delay. One entry per sounding play.
 */
export function playPositions(ch: Chain, now: number) {
  const heard = now - ch.delay.delayTime.value;
  const dur = ch.buffer.duration;
  const out: number[] = [];
  for (const [p, when] of ch.players) {
    const info = plays.get(p);
    if (!info || when > heard) continue;
    let t = info.offset + (heard - when) * info.rate;
    if (info.loop) t %= dur;
    if (t < dur) out.push(t);
  }
  return out;
}

/** Play the chain's sound at context time `when`. */
export function startPlayer(ctx: BaseAudioContext, ch: Chain, when: number, { offset = 0, loop = false, gain = 1, playbackRate = 1 }: PlayOptions = {}) {
  const p = new AudioBufferSourceNode(ctx, { buffer: ch.buffer, loop, playbackRate });
  plays.set(p, { offset, rate: playbackRate, loop });
  // The chain's gain is driven by distance and mute every frame, so a play's own level needs its own node.
  const level = gain !== 1 ? new GainNode(ctx, { gain }) : null;
  if (level) p.connect(level).connect(ch.gain);
  else p.connect(ch.gain);
  p.start(when, offset);
  ch.players.set(p, when);
  p.onended = () => {
    ch.players.delete(p);
    p.disconnect();
    level?.disconnect();
  };
  return p;
}

/** Schedule a random play. If it began before `now`, join it part-way through. */
export function startCue(ctx: BaseAudioContext, ch: Chain, c: Cue, at: number, now = at) {
  const opts = { gain: c.gain, playbackRate: c.rate };
  if (at >= now) startPlayer(ctx, ch, at, opts);
  else if (now - at < playLength(c, ch.buffer.duration)) startPlayer(ctx, ch, now, { ...opts, offset: (now - at) * c.rate });
}

export type ApplyMode = 'set' | 'ramp' | 'smooth';

const SETTERS: Record<ApplyMode, (p: AudioParam, v: number, t: number) => void> = {
  set: (p, v, t) => p.setValueAtTime(v, t),
  ramp: (p, v, t) => p.linearRampToValueAtTime(v, t),
  smooth: (p, v, t) => p.setTargetAtTime(v, t, 0.025),
};

export function applyState(ch: Chain, st: SourceState, time: number, mode: ApplyMode) {
  const set = SETTERS[mode];
  set(ch.panner.positionX, st.heard.x, time);
  set(ch.panner.positionY, st.heard.y, time);
  set(ch.panner.positionZ, st.heard.z, time);
  set(ch.delay.delayTime, st.delay, time);
  set(ch.air.frequency, st.cutoff, time);
  set(ch.send.gain, st.send, time);
  set(ch.gain.gain, st.gain, time);
  set(ch.notch.frequency, st.eq.notchF, time);
  set(ch.notch.gain, st.eq.notchGain, time);
  set(ch.peak.gain, st.eq.peakGain, time);
  set(ch.shelf.gain, st.eq.shelfGain, time);
  set(ch.reflPanner.positionX, st.refl.pos.x, time);
  set(ch.reflPanner.positionY, st.refl.pos.y, time);
  set(ch.reflPanner.positionZ, st.refl.pos.z, time);
  set(ch.reflDelay.delayTime, st.refl.delay, time);
  set(ch.reflAir.frequency, st.refl.cutoff, time);
  set(ch.reflGain.gain, st.refl.gain, time);
  if (st.orient) {
    set(ch.panner.orientationX, st.orient.x, time);
    set(ch.panner.orientationY, st.orient.y, time);
    set(ch.panner.orientationZ, st.orient.z, time);
  }
}

export function setListener(ctx: BaseAudioContext, yawDeg: number, time: number, mode: ApplyMode) {
  const L = ctx.listener;
  const fx = Math.sin(yawDeg * DEG);
  const fz = -Math.cos(yawDeg * DEG);
  if (L.forwardX) {
    const set = SETTERS[mode];
    set(L.forwardX, fx, time);
    set(L.forwardY, 0, time);
    set(L.forwardZ, fz, time);
  } else {
    // Firefox: no AudioParams on the listener
    L.setOrientation(fx, 0, fz, 0, 1, 0);
  }
}

// ---------------------------------------------------------------- offline render

/** Sources fade out over this long when an export stops them, so a cut-off loop doesn't click. */
const STOP_FADE = 0.05;
/** The ring-out ends once the mix stays below this level (−80 dBFS). */
const SILENCE = 1e-4;

/**
 * Render the scene to a stereo buffer, faster than realtime. Motion is written as
 * 200 Hz linear automation, so Doppler and panning are sample-accurate between points.
 *
 * Sources sound for `duration` seconds, then stop. Composed songs play once, never looped, so a
 * song set to loop doesn't start over. With `ringOut`, the recording then carries on until the
 * room's reverb and any sound still on its way to the listener have died away (the silence after
 * is trimmed); without it, it ends at `duration`. `onProgress` gets the fraction rendered, 0 … 1.
 */
export async function renderScene(
  scene: Scene, getSound: (id: string | null) => Sound | undefined, duration: number, sampleRate: number,
  { ringOut = true, onProgress }: { ringOut?: boolean; onProgress?: (f: number) => void } = {},
) {
  const solo = anySolo(scene);
  const audible = scene.sources.filter((src) => getSound(src.soundId) && !src.muted && (!solo || src.solo));

  // Longest the mix can keep sounding after the sources stop: sound in flight, then the reverb.
  let tail = 0;
  if (ringOut) {
    for (const src of audible) {
      const st = computeState(src, scene, duration, solo);
      tail = Math.max(tail, st.delay, st.refl.delay);
    }
    const ir = scene.environment.wet > 0 ? getImpulse(sampleRate, scene.environment.preset) : null;
    tail += (ir?.duration ?? 0) + STOP_FADE + 0.3;
  }

  const length = Math.max(1, Math.ceil((duration + tail) * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const out = buildOutput(ctx, scene, ctx.destination);
  const steps = Math.ceil(duration * 200);
  const dt = duration / steps;

  if (scene.listener.spin) {
    for (let k = 0; k <= steps; k++) setListener(ctx, listenerYaw(scene, k * dt), k * dt, k ? 'ramp' : 'set');
  } else {
    setListener(ctx, scene.listener.yaw, 0, 'set');
  }

  for (const src of audible) {
    const sound = getSound(src.soundId)!;
    const buffer = sound.buffer;
    const song = !!sound.recipe?.music;
    const ch = createChain(ctx, src, buffer, out, scene.physics);
    for (let k = 0; k <= steps; k++) {
      const t = k * dt;
      const st = computeState(src, scene, t, solo);
      // Stop: fade what the source emits. Sound already in flight (delay lines, reverb) rings on.
      const fade = Math.min(1, (duration - t) / STOP_FADE);
      applyState(ch, fade < 1 ? { ...st, gain: st.gain * fade } : st, t, k ? 'ramp' : 'set');
    }
    if (src.playback === 'random') {
      for (let c = firstCue(src); c.t < duration; c = nextCue(src, c, buffer.duration)) {
        startCue(ctx, ch, c, c.t);
        if (song) break;
      }
    } else {
      startPlayer(ctx, ch, src.startDelay, { loop: src.playback === 'loop' && !song });
    }
  }
  if (onProgress) {
    // Pause the render now and then to report how far it got (at most ~100 times, at least 0.5 s apart).
    const total = length / sampleRate;
    const step = Math.max(0.5, total / 100);
    for (let t = step; t < total - 0.1; t += step) {
      const at = t;
      ctx.suspend(at).then(() => {
        onProgress(at / total);
        ctx.resume();
      }, () => {});
    }
  }
  const rendered = await ctx.startRendering();
  return ringOut ? trimSilence(rendered, Math.ceil(duration * sampleRate)) : rendered;
}

/** Cut the silence after the ring-out (never before `from`), with a short fade to end cleanly. */
function trimSilence(buf: AudioBuffer, from: number) {
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  let last = from;
  for (const d of chans) {
    for (let i = d.length - 1; i > last; i--) {
      if (Math.abs(d[i]) > SILENCE) {
        last = i;
        break;
      }
    }
  }
  const sr = buf.sampleRate;
  const length = Math.min(buf.length, last + Math.round(0.05 * sr));
  const out = new AudioBuffer({ numberOfChannels: chans.length, length, sampleRate: sr });
  const fadeLen = Math.min(length - from, Math.round(0.02 * sr));
  chans.forEach((d, c) => {
    const o = d.slice(0, length);
    for (let i = 0; i < fadeLen; i++) o[length - 1 - i] *= i / fadeLen;
    out.copyToChannel(o, c);
  });
  return out;
}

/**
 * When the last composed song in the scene finishes its first full play (scene seconds), and which
 * source plays it; null if no audible source plays a composition. An export shorter than this would
 * cut a song off.
 */
export function songsEnd(scene: Scene, getSound: (id: string | null) => Sound | undefined) {
  const solo = anySolo(scene);
  let best: { end: number; source: Source } | null = null;
  for (const src of scene.sources) {
    const sound = getSound(src.soundId);
    if (!sound?.recipe?.music || src.muted || (solo && !src.solo)) continue;
    const dur = sound.buffer.duration;
    const c = src.playback === 'random' ? firstCue(src) : null;
    const end = c ? c.t + playLength(c, dur) : src.startDelay + dur;
    if (!best || end > best.end) best = { end, source: src };
  }
  return best;
}
