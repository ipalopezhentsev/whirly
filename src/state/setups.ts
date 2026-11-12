// Named snapshots of the scene ("setups") saved in this browser's IndexedDB.
//
// A setup holds the scene plus the sounds its sources use, at full quality. Audio is stored
// once per distinct sound (keyed by a content fingerprint), so many setups sharing the same
// sounds cost little. Loading reuses identical sounds already in the library.
import { store } from './store';
import { db, req, tx } from './persist';
import { addSound } from './actions';
import { fromData } from '../audio/buffers';
import { engine } from '../audio/engine';
import { uid } from '../audio/util';
import { hydrateScene } from '../scene/scene';
import type { Scene, SynthRecipe } from '../scene/types';

interface SetupSound {
  /** The sound's id when saved; the scene's sources refer to it. */
  id: string;
  name: string;
  /** Content fingerprint, the key of its audio in the 'audio' store. */
  fp: string;
  recipe?: SynthRecipe;
}

export interface Setup {
  id: string;
  name: string;
  created: number;
  updated: number;
  scene: Scene;
  sounds: SetupSound[];
}

interface StoredAudio {
  fp: string;
  sampleRate: number;
  data: Float32Array;
}

// ---------------------------------------------------------------- fingerprints

const fpCache = new WeakMap<AudioBuffer, string>();

/** FNV-1a over the raw sample bits, plus rate and length. */
function fingerprint(sampleRate: number, data: Float32Array) {
  const u = new Uint32Array(data.buffer, data.byteOffset, data.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
  return `${sampleRate}-${data.length}-${(h >>> 0).toString(36)}`;
}

function bufferFp(b: AudioBuffer) {
  let fp = fpCache.get(b);
  if (!fp) fpCache.set(b, (fp = fingerprint(b.sampleRate, b.getChannelData(0))));
  return fp;
}

// ---------------------------------------------------------------- API

/** Saved setups, newest first, without loading any audio. */
export async function listSetups(): Promise<Setup[]> {
  const all = await req((await tx('setups', 'readonly')).getAll() as IDBRequest<Setup[]>);
  return all.sort((a, b) => b.updated - a.updated);
}

/** Save the current scene under a name, replacing a setup that already has that name. */
export async function saveSetup(name: string) {
  const { scene, sounds } = store.get();
  const used = sounds.filter((s) => scene.sources.some((src) => src.soundId === s.id));

  const audio = await tx('audio', 'readonly');
  const setupSounds: SetupSound[] = [];
  const newAudio: StoredAudio[] = [];
  for (const s of used) {
    const fp = bufferFp(s.buffer);
    if (!(await req(audio.getKey(fp))) && !newAudio.some((a) => a.fp === fp)) {
      newAudio.push({ fp, sampleRate: s.buffer.sampleRate, data: s.buffer.getChannelData(0).slice() });
    }
    setupSounds.push({ id: s.id, name: s.name, fp, ...(s.recipe && { recipe: s.recipe }) });
  }

  const existing = (await listSetups()).find((x) => x.name === name);
  const now = Date.now();
  const setup: Setup = {
    id: existing?.id ?? uid(),
    name,
    created: existing?.created ?? now,
    updated: now,
    scene: structuredClone(scene),
    sounds: setupSounds,
  };

  // Write audio and setup in one transaction so a setup never points at missing audio.
  const both = (await db()).transaction(['setups', 'audio'], 'readwrite');
  for (const a of newAudio) both.objectStore('audio').put(a);
  both.objectStore('setups').put(setup);
  await new Promise<void>((resolve, reject) => {
    both.oncomplete = () => resolve();
    both.onerror = () => reject(both.error);
    both.onabort = () => reject(both.error ?? new Error('save aborted'));
  });
  if (existing) await collectAudio();
  store.set({ setupName: name });
  return setup;
}

/** Replace the current scene with a saved setup. Missing sounds are added to the library. */
export async function loadSetup(id: string) {
  const setup = await req((await tx('setups', 'readonly')).get(id) as IDBRequest<Setup | undefined>);
  if (!setup) throw new Error('that setup no longer exists');
  if (store.get().playing) engine.stop();

  const audio = await tx('audio', 'readonly');
  const stored = await Promise.all(setup.sounds.map((s) => req(audio.get(s.fp) as IDBRequest<StoredAudio | undefined>)));

  const ids = new Map<string, string>();
  setup.sounds.forEach((s, i) => {
    // Reuse an identical sound if the library has one, preferring the very same sound.
    const lib = store.get().sounds;
    const same = lib.find((x) => x.id === s.id && bufferFp(x.buffer) === s.fp) ?? lib.find((x) => bufferFp(x.buffer) === s.fp);
    if (same) return ids.set(s.id, same.id);
    const a = stored[i];
    if (!a) return; // audio missing: the source keeps no sound
    ids.set(s.id, addSound(s.name, fromData(a.data, a.sampleRate), s.recipe).id);
  });

  const scene = hydrateScene({
    ...setup.scene,
    sources: setup.scene.sources.map((src) => ({ ...src, soundId: (src.soundId && ids.get(src.soundId)) ?? null })),
  });
  const first = scene.sources[0];
  store.set({
    scene,
    selectedSourceId: first?.id ?? null,
    selectedSoundId: first?.soundId ?? store.get().selectedSoundId,
    rightTab: 'source',
    setupName: setup.name,
  });
  return setup;
}

export async function deleteSetup(id: string) {
  await req((await tx('setups', 'readwrite')).delete(id));
  await collectAudio();
}

/** Drop stored audio that no setup refers to any more. */
async function collectAudio() {
  const used = new Set((await listSetups()).flatMap((s) => s.sounds.map((x) => x.fp)));
  const store_ = await tx('audio', 'readwrite');
  const keys = (await req(store_.getAllKeys())) as string[];
  await Promise.all(keys.filter((k) => !used.has(k)).map((k) => req(store_.delete(k))));
}
