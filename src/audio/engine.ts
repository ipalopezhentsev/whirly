// Realtime playback of the scene. Reconciles the audio graph with the store (like React
// reconciles the DOM) and updates moving parameters every animation frame.
import { audioCtx, ensureRunning } from './context';
import {
  anySolo, applyPannerProps, applyState, buildOutput, computeState, createChain, listenerYaw,
  setEnvironment, setListener, type Chain, type Output,
} from './spatial';
import { dbToGain } from './util';
import { store } from '../state/store';
import { onFrame } from '../state/frame';
import type { Selection, Sound, Source } from '../scene/types';

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
    try {
      ch.player.stop(now + 0.1);
    } catch {
      /* never started */
    }
    setTimeout(() => {
      for (const n of [
        ch.player, ch.gain, ch.delay, ch.air, ch.notch, ch.peak, ch.shelf, ch.panner, ch.send,
        ch.reflDelay, ch.reflAir, ch.reflPanner, ch.reflGain, ch.analyser,
      ]) n?.disconnect();
    }, 300);
  }

  private chainKey(src: Source, sound: Sound | undefined) {
    return sound ? `${sound.id}:${sound.version}:${src.loop}:${src.startDelay}` : '';
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
      if (ctx.currentTime < startAt) {
        ch.player.start(startAt);
      } else {
        const elapsed = ctx.currentTime - startAt;
        if (src.loop) ch.player.start(ctx.currentTime, elapsed % dur);
        else if (elapsed < dur) ch.player.start(ctx.currentTime, elapsed);
      }
      this.chains.set(src.id, ch);
    }
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

  /** Playhead (seconds into the sound) of the running preview, or null. */
  previewTime(soundId: string) {
    const p = this.preview;
    return p && p.soundId === soundId ? p.offset + this.ctx.currentTime - p.startedAt : null;
  }
}

export const engine = new Engine();
store.subscribe(() => engine.reconcile());
onFrame(() => engine.tick());
