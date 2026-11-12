// Share links: the whole scene packed into the URL fragment, so no server is needed.
//
// Synthesized sounds travel as their recipe (preset, settings, seed, edits) and are re-rendered
// on the other end, which keeps links short. Recorded and imported sounds have no recipe, so
// their audio is embedded: resampled to 24 kHz and stored as 8-bit µ-law.
//
// Fragment: #s=<base64url( deflate-raw( u32 jsonLength · json · audio bytes… ) )>
import { store } from './store';
import { addSound, renderRecipe, toast } from './actions';
import { fromData } from '../audio/buffers';
import { engine } from '../audio/engine';
import { hydrateScene } from '../scene/scene';
import type { Scene, Sound, SynthRecipe } from '../scene/types';

const VERSION = 1;
const HASH_KEY = 's';
const EMBED_RATE = 24000;
/** Browsers start refusing URLs around 2 MB. */
export const MAX_URL = 2_000_000;
/** Above this, chat apps tend to cut links off. */
export const LONG_URL = 8000;

interface SharedSound {
  name: string;
  recipe?: SynthRecipe;
  /** Embedded µ-law audio: sample rate and byte count, in payload order. */
  audio?: { sr: number; n: number };
}

interface Payload {
  v: number;
  /** Sources' soundId is an index into `sounds`. */
  scene: Omit<Scene, 'sources'> & { sources: (Omit<Scene['sources'][number], 'soundId'> & { soundId: number | null })[] };
  sounds: SharedSound[];
}

export interface ShareLink {
  url: string;
  recipes: number;
  embedded: number;
  /** Seconds of embedded audio. */
  embeddedSecs: number;
}

// ---------------------------------------------------------------- encode

export async function buildShareLink(): Promise<ShareLink> {
  const { scene, sounds } = store.get();
  const used = sounds.filter((s) => scene.sources.some((src) => src.soundId === s.id));
  const index = new Map(used.map((s, i) => [s.id, i]));

  const shared: SharedSound[] = [];
  const blobs: Uint8Array[] = [];
  let embeddedSecs = 0;
  for (const s of used) {
    if (s.recipe) {
      shared.push({ name: s.name, recipe: s.recipe });
    } else {
      const bytes = await packAudio(s.buffer);
      blobs.push(bytes);
      embeddedSecs += s.buffer.duration;
      shared.push({ name: s.name, audio: { sr: Math.min(EMBED_RATE, s.buffer.sampleRate), n: bytes.length } });
    }
  }

  const payload: Payload = {
    v: VERSION,
    scene: { ...scene, sources: scene.sources.map((src) => ({ ...src, soundId: index.get(src.soundId ?? '') ?? null })) },
    sounds: shared,
  };
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const raw = new Uint8Array(4 + json.length + blobs.reduce((n, b) => n + b.length, 0));
  new DataView(raw.buffer).setUint32(0, json.length, true);
  raw.set(json, 4);
  let at = 4 + json.length;
  for (const b of blobs) {
    raw.set(b, at);
    at += b.length;
  }

  const url = `${location.origin}${location.pathname}${location.search}#${HASH_KEY}=${toBase64Url(await deflate(raw))}`;
  return { url, recipes: shared.length - blobs.length, embedded: blobs.length, embeddedSecs };
}

/** Resample to at most 24 kHz and µ-law encode. */
async function packAudio(buf: AudioBuffer) {
  let d = buf.getChannelData(0);
  if (buf.sampleRate > EMBED_RATE) {
    const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * EMBED_RATE)), EMBED_RATE);
    const s = new AudioBufferSourceNode(ctx, { buffer: buf });
    s.connect(ctx.destination);
    s.start();
    d = (await ctx.startRendering()).getChannelData(0);
  }
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = muLawEncode(d[i]);
  return out;
}

// ---------------------------------------------------------------- decode

/** The share data in the current URL, if any. */
export function sharedFromHash(hash = location.hash): string | null {
  const m = hash.match(new RegExp(`^#${HASH_KEY}=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}

/** Remove the share data from the address bar, so a reload doesn't open it again. */
export function clearShareHash() {
  history.replaceState(history.state, '', location.pathname + location.search);
}

/** Replace the current scene with a shared one. Its sounds are added to the library. */
export async function openShared(data: string) {
  let raw: Uint8Array;
  let payload: Payload;
  try {
    raw = await inflate(fromBase64Url(data));
    const len = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
    payload = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + len)));
    raw = raw.subarray(4 + len);
  } catch {
    throw new Error('the link is broken or was cut off');
  }
  if (payload?.v !== VERSION || !Array.isArray(payload.sounds) || !Array.isArray(payload.scene?.sources)) {
    throw new Error('the link is from a different version of Whirly');
  }

  if (store.get().playing) engine.stop();
  const ids: string[] = [];
  let at = 0;
  for (const s of payload.sounds) {
    let sound: Sound | undefined;
    if (s.recipe) {
      // Opening the same link twice shouldn't fill the library with copies.
      const key = JSON.stringify(s.recipe);
      sound = store.get().sounds.find((x) => x.recipe && JSON.stringify(x.recipe) === key);
      sound ??= addSound(s.name, await renderRecipe(s.recipe), s.recipe);
    } else if (s.audio) {
      const bytes = raw.subarray(at, at + s.audio.n);
      at += s.audio.n;
      if (bytes.length !== s.audio.n) throw new Error('the link was cut off');
      const d = new Float32Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) d[i] = muLawDecode(bytes[i]);
      sound = addSound(s.name, fromData(d, s.audio.sr));
    }
    ids.push(sound?.id ?? '');
  }

  const scene = hydrateScene({
    ...payload.scene,
    sources: payload.scene.sources.map((src) => ({ ...src, soundId: src.soundId === null ? null : ids[src.soundId] || null })),
  });
  const first = scene.sources[0];
  store.set({
    scene,
    selectedSourceId: first?.id ?? null,
    selectedSoundId: first?.soundId ?? store.get().selectedSoundId,
    rightTab: 'source',
    setupName: null,
  });
  return scene;
}

/** Ask (if there is work to lose), then open the shared scene from the URL. */
export async function openSharedFromHash(confirmReplace: boolean) {
  const data = sharedFromHash();
  if (!data) return false;
  clearShareHash();
  if (confirmReplace && !confirm('Open the shared scene?\n\nIt replaces your current scene. Your sounds stay in the library.')) return false;
  try {
    const scene = await openShared(data);
    toast(`Opened a shared scene with ${scene.sources.length} source${scene.sources.length === 1 ? '' : 's'}. Press ▶ Play — and use headphones.`);
    return true;
  } catch (e) {
    toast(`Could not open the shared scene: ${(e as Error).message}`, 'error');
    return false;
  }
}

// ---------------------------------------------------------------- bytes

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(t);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const deflate = (b: Uint8Array) => pipe(b, new CompressionStream('deflate-raw'));
const inflate = (b: Uint8Array) => pipe(b, new DecompressionStream('deflate-raw'));

function toBase64Url(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// G.711 µ-law: 8 bits per sample with ~14-bit dynamic range.
const BIAS = 0x84;
const CLIP = 32635;

function muLawEncode(x: number) {
  let s = Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s = Math.min(s, CLIP) + BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

function muLawDecode(u: number) {
  u = ~u & 0xff;
  const exp = (u >> 4) & 0x07;
  const s = ((((u & 0x0f) << 3) + BIAS) << exp) - BIAS;
  return ((u & 0x80) ? -s : s) / 32768;
}
