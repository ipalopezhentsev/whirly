let ctx: AudioContext | null = null;

/** The single shared realtime AudioContext (created lazily; may start suspended). */
export function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

/** Resume the context. Browsers only allow this after a user gesture. */
export async function ensureRunning(): Promise<AudioContext> {
  const c = audioCtx();
  if (c.state !== 'running') {
    try {
      await c.resume();
    } catch {
      /* resumed on the next gesture */
    }
  }
  return c;
}
