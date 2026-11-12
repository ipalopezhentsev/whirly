let ctx: AudioContext | null = null;

type SessionType = 'playback' | 'play-and-record';

/**
 * iOS/iPadOS Safari plays Web Audio in the "ambient" session by default, which the
 * silent switch / Control Center silent mode mutes. Declaring a media session makes it
 * behave like a media player instead. No-op where the Audio Session API is missing.
 */
export function setAudioSession(type: SessionType) {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (!session) return;
  try {
    session.type = type;
  } catch {
    /* unsupported value */
  }
}

/** The single shared realtime AudioContext (created lazily; may start suspended). */
export function audioCtx(): AudioContext {
  if (!ctx) {
    setAudioSession('playback');
    ctx = new AudioContext({ latencyHint: 'interactive' });
  }
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
