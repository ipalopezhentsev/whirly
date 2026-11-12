import { audioCtx, ensureRunning } from './context';

/** Microphone capture via MediaRecorder, decoded into an AudioBuffer. */
export class MicRecorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buf = new Float32Array(1024);
  private t0 = 0;

  get active() {
    return !!this.rec;
  }

  async start(raw: boolean) {
    const ctx = await ensureRunning();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw, channelCount: 1 },
    });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(100);
    this.source = ctx.createMediaStreamSource(this.stream);
    this.analyser = new AnalyserNode(ctx, { fftSize: 1024 });
    this.source.connect(this.analyser);
    this.t0 = performance.now();
  }

  /** Peak level of the input (0..1). */
  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let p = 0;
    for (let i = 0; i < this.buf.length; i++) p = Math.max(p, Math.abs(this.buf[i]));
    return p;
  }

  elapsed() {
    return this.rec ? (performance.now() - this.t0) / 1000 : 0;
  }

  async stop(): Promise<AudioBuffer> {
    const rec = this.rec;
    if (!rec) throw new Error('Not recording');
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.stop();
    await stopped;
    this.cleanup();
    const blob = new Blob(this.chunks, { type: rec.mimeType });
    return audioCtx().decodeAudioData(await blob.arrayBuffer());
  }

  cancel() {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.cleanup();
  }

  private cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.stream = null;
    this.rec = null;
    this.source = null;
    this.analyser = null;
  }
}
