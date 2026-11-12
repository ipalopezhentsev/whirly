// Realtime playback of the scene. Reconciles the audio graph with the store (like React
// reconciles the DOM) and updates moving parameters every animation frame.
import { audioCtx, ensureRunning } from './context';
import {
  anySolo, applyPannerProps, applyState, buildOutput, computeState, createChain, listenerYaw,
  playPositions, setEnvironment, setListener, startCue, startPlayer, type Chain, type Output,
} from './spatial';
import { dbToGain } from './util';
import { store } from '../state/store';
import { onFrame } from '../state/frame';
import { cueAt, cueKey, nextCue } from '../scene/playback';
import type { Selection, Sound, Source } from '../scene/types';

/**
 * Random plays are scheduled this far ahead. Generous, because background tabs get no animation
 * frames and their timers are throttled to about once a second.
 */
const LOOKAHEAD = 1.5;

interface Preview {
  node: AudioBufferSourceNode;
  soundId: string;
  startedAt: number;
  offset: number;
}

class Engine {
  out: Output | null = null;
  chains = new Map<string, Chain>();
  playing = false;
  startTime = 0;
  meterL: AnalyserNode | null = null;
  meterR: AnalyserNode | null = null;
  spectrum: AnalyserNode | null = null;
  private previewBus: GainNode | null = null;
  preview: Preview | null = null;

  get ctx() {
    return audioCtx();
  }

  private init(): Output {
    if (this.out) return this.out;
    const ctx = this.ctx;
    const { scene } = store.get();
    const out = buildOutput(ctx, scene, ctx.destination);
    const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    out.limiter.connect(split);
    this.meterL = new AnalyserNode(ctx, { fftSize: 2048 });
    this.meterR = new AnalyserNode(ctx, { fftSize: 2048 });
    split.connect(this.meterL, 0);
    split.connect(this.meterR, 1);
    this.spectrum = new AnalyserNode(ctx, { fftSize: 4096, smoothingTimeConstant: 0.8 });
    out.limiter.connect(this.spectrum);
    this.previewBus = new GainNode(ctx);
    this.previewBus.connect(out.master);
    this.out = out;
    return out;
  }

  /** Seconds since "play" (0 when stopped). */
  time() {
    return this.playing ? Math.max(0, this.ctx.currentTime - this.startTime) : 0;
  }

  async play() {
    const ctx = await ensureRunning();
    this.init();
    if (this.playing) this.stop();
    this.startTime = ctx.currentTime + 0.05;
    this.playing = true;
    store.set({ playing: true });
    this.reconcile();
  }

  stop() {
    for (const ch of this.chains.values()) this.kill(ch);
    this.chains.clear();
    this.playing = false;
    store.set({ playing: false });
  }

  private kill(ch: Chain) {
    const now = this.ctx.currentTime;
    ch.gain.gain.cancelScheduledValues(now);
    ch.gain.gain.setTargetAtTime(0, now, 0.015);
    ch.cue = undefined;
    const players = [...ch.players.keys()];
    for (const p of players) p.stop(now + 0.1);
    setTimeout(() => {
      for (const n of [
        ...players, ch.gain, ch.delay, ch.air, ch.notch, ch.peak, ch.shelf, ch.panner, ch.send,
        ch.reflDelay, ch.reflAir, ch.reflPanner, ch.reflGain, ch.analyser,
      ]) n?.disconnect();
    }, 300);
  }

  private chainKey(src: Source, sound: Sound | undefined) {
    return sound ? `${sound.id}:${sound.version}:${src.playback}:${src.startDelay}` : '';
  }

  /** Bring the audio graph in line with the current state. Cheap; runs on every store change. */
  reconcile() {
    const out = this.out;
    if (!out) return;
    const { scene, sounds } = store.get();

    if (setEnvironment(this.ctx, out, scene.environment.preset)) {
      for (const ch of this.chains.values()) {
        ch.send.disconnect();
        if (out.convolver) ch.send.connect(out.convolver);
      }
    }
    if (!this.playing) return;

    const ids = new Set(scene.sources.map((s) => s.id));
    for (const [id, ch] of this.chains) {
      if (!ids.has(id)) {
        this.kill(ch);
        this.chains.delete(id);
      }
    }

    const ctx = this.ctx;
    const t = this.time();
    const solo = anySolo(scene);
    for (const src of scene.sources) {
      const sound = sounds.find((s) => s.id === src.soundId);
      const key = this.chainKey(src, sound);
      const existing = this.chains.get(src.id);
      if (existing && existing.key === key) {
        applyPannerProps(existing.panner, scene.physics, src);
        applyPannerProps(existing.reflPanner, scene.physics, { ...src, directional: false });
        if (src.playback === 'random' && existing.cueKey !== cueKey(src)) this.reschedule(existing, src, t);
        continue;
      }
      if (existing) {
        this.kill(existing);
        this.chains.delete(src.id);
      }
      if (!sound) continue;

      const ch = createChain(ctx, src, sound.buffer, out, scene.physics, key, true);
      // Start silent at the right place; the next frame fades the gain in.
      applyState(ch, { ...computeState(src, scene, t, solo), gain: 0 }, ctx.currentTime, 'set');
      const startAt = this.startTime + src.startDelay;
      const dur = sound.buffer.duration;
      if (src.playback === 'random') {
        // Pick up the schedule where it is now, including a play that is already under way.
        ch.cueKey = cueKey(src);
        ch.cue = cueAt(src, dur, t);
        this.pump(ch, src);
      } else if (ctx.currentTime < startAt) {
        startPlayer(ctx, ch, startAt, { loop: src.playback === 'loop' });
      } else {
        const elapsed = ctx.currentTime - startAt;
        if (src.playback === 'loop') startPlayer(ctx, ch, ctx.currentTime, { offset: elapsed % dur, loop: true });
        else if (elapsed < dur) startPlayer(ctx, ch, ctx.currentTime, { offset: elapsed });
      }
      this.chains.set(src.id, ch);
    }
  }

  /** Schedule a random source's plays that start within the lookahead. */
  private pump(ch: Chain, src: Source) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    while (ch.cue && this.startTime + ch.cue.t < now + LOOKAHEAD) {
      startCue(ctx, ch, ch.cue, this.startTime + ch.cue.t, now);
      ch.cue = nextCue(src, ch.cue, ch.buffer.duration);
    }
  }

  /**
   * The pauses or seed changed: drop plays that haven't started yet and continue with the new
   * schedule, letting one that is already sounding finish.
   */
  private reschedule(ch: Chain, src: Source, t: number) {
    const now = this.ctx.currentTime;
    for (const [p, at] of ch.players) {
      if (at > now) {
        p.stop();
        ch.players.delete(p);
      }
    }
    ch.cueKey = cueKey(src);
    ch.cue = cueAt(src, ch.buffer.duration, t, true);
    this.pump(ch, src);
  }

  /** Keep random sources' plays scheduled ahead. Runs on a timer rather than on frames, which stop in background tabs. */
  pumpAll() {
    if (!this.playing) return;
    for (const src of store.get().scene.sources) {
      const ch = this.chains.get(src.id);
      if (ch?.cue) this.pump(ch, src);
    }
  }

  /** Scene time (seconds) of a random source's next play, and whether it is sounding now. */
  randomStatus(srcId: string) {
    const ch = this.chains.get(srcId);
    if (!this.playing || !ch?.cue) return null;
    const now = this.ctx.currentTime;
    let sounding = false;
    let next = this.startTime + ch.cue.t;
    for (const at of ch.players.values()) {
      if (at <= now) sounding = true;
      else next = Math.min(next, at);
    }
    return { sounding, next: next - this.startTime };
  }

  /** Per-frame update of everything that moves. */
  tick() {
    const out = this.out;
    if (!out) return;
    const ctx = this.ctx;
    const { scene } = store.get();
    const now = ctx.currentTime;
    out.master.gain.setTargetAtTime(dbToGain(scene.masterDb), now, 0.03);
    out.reverbReturn.gain.setTargetAtTime(scene.environment.wet, now, 0.03);
    const t = this.time();
    setListener(ctx, listenerYaw(scene, t), now, 'smooth');
    if (!this.playing) return;
    const solo = anySolo(scene);
    for (const src of scene.sources) {
      const ch = this.chains.get(src.id);
      if (ch) applyState(ch, computeState(src, scene, t, solo), now, 'smooth');
    }
  }

  /** RMS level (0..1) of a source's dry signal, for the scene view. */
  level(srcId: string) {
    const ch = this.chains.get(srcId);
    if (!ch?.analyser || !ch.abuf) return 0;
    ch.analyser.getFloatTimeDomainData(ch.abuf);
    let s = 0;
    for (let i = 0; i < ch.abuf.length; i++) s += ch.abuf[i] * ch.abuf[i];
    return Math.sqrt(s / ch.abuf.length);
  }

  /** Play a library sound dry (no spatialization). */
  async previewSound(sound: Sound, sel: Selection | null, onEnd?: () => void) {
    const ctx = await ensureRunning();
    this.init();
    this.stopPreview();
    const node = new AudioBufferSourceNode(ctx, { buffer: sound.buffer });
    node.connect(this.previewBus!);
    const offset = sel ? sel.start : 0;
    node.start(0, offset, sel ? sel.end - sel.start : undefined);
    const p: Preview = { node, soundId: sound.id, startedAt: ctx.currentTime, offset };
    this.preview = p;
    node.onended = () => {
      if (this.preview === p) this.preview = null;
      onEnd?.();
    };
  }

  stopPreview() {
    if (!this.preview) return;
    try {
      this.preview.node.stop();
    } catch {
      /* already stopped */
    }
    this.preview = null;
  }

  /**
   * Where the given sounds are playing right now (seconds into the sound): each scene source
   * playing one of them (as heard at the listener), plus the preview. Muted sources don't count.
   */
  playheads(soundIds: ReadonlySet<string>) {
    const out: number[] = [];
    if (this.preview && soundIds.has(this.preview.soundId)) out.push(this.preview.offset + this.ctx.currentTime - this.preview.startedAt);
    if (!this.playing) return out;
    const { scene } = store.get();
    const solo = anySolo(scene);
    const now = this.ctx.currentTime;
    for (const src of scene.sources) {
      if (!src.soundId || !soundIds.has(src.soundId) || src.muted || (solo && !src.solo)) continue;
      const ch = this.chains.get(src.id);
      if (ch) out.push(...playPositions(ch, now));
    }
    return out;
  }

  /** Playhead (seconds into the sound) of the running preview, or null. */
  previewTime(soundId: string) {
    const p = this.preview;
    return p && p.soundId === soundId ? p.offset + this.ctx.currentTime - p.startedAt : null;
  }
}

export const engine = new Engine();
store.subscribe(() => engine.reconcile());
onFrame(() => engine.tick());
setInterval(() => engine.pumpAll(), 250);
