// Autosave the scene and the sound library to IndexedDB so work survives a reload.
import { store } from './store';
import type { Sound } from '../scene/types';

const DB_NAME = 'whirly';

interface StoredSound {
  id: string;
  name: string;
  sampleRate: number;
  created: number;
  data: Float32Array;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('sounds', { keyPath: 'id' });
      r.result.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

function req<T>(r: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(storeName: string, mode: IDBTransactionMode) {
  return (await db()).transaction(storeName, mode).objectStore(storeName);
}

export async function loadAll(): Promise<{ sounds: StoredSound[]; scene: unknown } | null> {
  try {
    const sounds = await req((await tx('sounds', 'readonly')).getAll() as IDBRequest<StoredSound[]>);
    const scene = await req((await tx('kv', 'readonly')).get('scene'));
    sounds.sort((a, b) => a.created - b.created);
    return { sounds, scene };
  } catch (e) {
    console.warn('IndexedDB unavailable, not restoring', e);
    return null;
  }
}

async function saveSound(s: Sound) {
  const rec: StoredSound = {
    id: s.id,
    name: s.name,
    sampleRate: s.buffer.sampleRate,
    created: s.created,
    data: s.buffer.getChannelData(0).slice(),
  };
  await req((await tx('sounds', 'readwrite')).put(rec));
}

async function deleteSound(id: string) {
  await req((await tx('sounds', 'readwrite')).delete(id));
}

export async function clearAll() {
  await req((await tx('sounds', 'readwrite')).clear());
  await req((await tx('kv', 'readwrite')).clear());
}

/**
 * Start watching the store and write changes back (scene debounced).
 * `persisted`: whether the current state was just loaded from the database (else it is saved now).
 */
export function startAutosave(persisted: boolean) {
  let last = store.get();
  let sceneTimer = 0;
  const saved = new Map<string, Sound>(persisted ? last.sounds.map((s) => [s.id, s]) : []);
  const fail = (e: unknown) => console.warn('Autosave failed', e);

  const sync = (force = false) => {
    const s = store.get();
    if (force || s.scene !== last.scene) {
      clearTimeout(sceneTimer);
      const scene = s.scene;
      sceneTimer = window.setTimeout(async () => {
        try {
          await req((await tx('kv', 'readwrite')).put(scene, 'scene'));
        } catch (e) {
          fail(e);
        }
      }, 400);
    }
    if (force || s.sounds !== last.sounds) {
      const ids = new Set(s.sounds.map((x) => x.id));
      for (const snd of s.sounds) {
        if (saved.get(snd.id) !== snd) {
          saved.set(snd.id, snd);
          saveSound(snd).catch(fail);
        }
      }
      for (const id of [...saved.keys()]) {
        if (!ids.has(id)) {
          saved.delete(id);
          deleteSound(id).catch(fail);
        }
      }
    }
    last = s;
  };
  store.subscribe(() => sync());
  if (!persisted) sync(true);
}
