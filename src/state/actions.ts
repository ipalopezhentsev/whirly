// All state mutations. Components call these; the engine and autosave react to the store.
import { store } from './store';
import { loadAll, startAutosave } from './persist';
import { audioCtx } from '../audio/context';
import { fromData, toMono } from '../audio/buffers';
import { renderPreset } from '../audio/synth';
import { ENVIRONMENTS } from '../audio/reverb';
import { DEG, uid } from '../audio/util';
import { defaultScene, hydrateScene, newSource } from '../scene/scene';
import type { MotionType, Physics, Scene, Sound, Source, Vec3 } from '../scene/types';

// ---------------------------------------------------------------- misc

let toastId = 0;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  store.set({ toast: { id: ++toastId, msg, kind } });
}

export const getSound = (id: string | null) => store.get().sounds.find((s) => s.id === id);
export const getSource = (id: string | null) => store.get().scene.sources.find((s) => s.id === id);

// ---------------------------------------------------------------- scene

export function updateScene(fn: (s: Scene) => Partial<Scene>) {
  store.set((st) => ({ scene: { ...st.scene, ...fn(st.scene) } }));
}

export function patchPhysics(p: Partial<Physics>) {
  updateScene((s) => ({ physics: { ...s.physics, ...p } }));
}

/**
 * Move the listener up or down. Source heights are stored relative to the ears, so every source
 * (and every Rise & fall range) is shifted the other way: the world stays put, only the listener moves.
 */
export function setListenerHeight(height: number) {
  updateScene((s) => {
    const h = Math.round(Math.max(0.1, height) * 100) / 100;
    const d = h - s.physics.earHeight;
    if (!d) return {};
    const r = (v: number) => Math.round((v - d) * 100) / 100;
    return {
      physics: { ...s.physics, earHeight: h },
      sources: s.sources.map((src) => {
        const rise = src.motion.params.rise;
        return {
          ...src,
          pos: { ...src.pos, y: r(src.pos.y) },
          motion: { ...src.motion, params: { ...src.motion.params, rise: { ...rise, low: r(rise.low), high: r(rise.high) } } },
        };
      }),
    };
  });
}

export function setEnvironmentPreset(preset: string) {
  updateScene(() => ({ environment: { preset, wet: ENVIRONMENTS[preset].wet } }));
}

export function patchSource(id: string, patch: Partial<Source> | ((s: Source) => Partial<Source>)) {
  updateScene((scene) => ({
    sources: scene.sources.map((s) => (s.id === id ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s)),
  }));
}

export function setSourcePos(id: string, pos: Partial<Vec3>) {
  patchSource(id, (s) => ({ pos: { ...s.pos, ...pos } }));
}

export function setMotionType(id: string, type: MotionType) {
  patchSource(id, (s) => ({ motion: { ...s.motion, type } }));
}

export function setMotionParam(id: string, type: MotionType, key: string, value: number) {
  patchSource(id, (s) => ({
    motion: { ...s.motion, params: { ...s.motion.params, [type]: { ...s.motion.params[type], [key]: value } } },
  }));
}

export function selectSource(id: string | null) {
  store.set({ selectedSourceId: id, ...(id ? { rightTab: 'source' as const } : {}) });
}

export function addSource(soundId: string | null, pos?: Partial<Vec3>, name?: string) {
  const { scene } = store.get();
  let p = pos;
  if (!p) {
    // Spread new sources around the listener at 3 m.
    const a = scene.sources.length * 50 * DEG;
    p = { x: +(3 * Math.sin(a)).toFixed(2), y: 0, z: +(-3 * Math.cos(a)).toFixed(2) };
  }
  const src = newSource(scene, soundId, p, name ?? getSound(soundId)?.name);
  updateScene((s) => ({ sources: [...s.sources, src] }));
  selectSource(src.id);
  return src;
}

export function duplicateSource(id: string) {
  const src = getSource(id);
  if (!src) return;
  const { scene } = store.get();
  const copy: Source = {
    ...structuredClone(src),
    id: uid(),
    name: `${src.name} copy`,
    color: newSource(scene, null).color,
    pos: { ...src.pos, x: src.pos.x + 1 },
  };
  updateScene((s) => ({ sources: [...s.sources, copy] }));
  selectSource(copy.id);
}

export function removeSource(id: string) {
  updateScene((s) => ({ sources: s.sources.filter((x) => x.id !== id) }));
  if (store.get().selectedSourceId === id) selectSource(store.get().scene.sources[0]?.id ?? null);
}

// ---------------------------------------------------------------- sounds

const undoStacks = new Map<string, AudioBuffer[]>();

function uniqueName(name: string) {
  const names = new Set(store.get().sounds.map((s) => s.name));
  if (!names.has(name)) return name;
  for (let i = 2; ; i++) if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
}

export function addSound(name: string, buffer: AudioBuffer): Sound {
  const sound: Sound = { id: uid(), name: uniqueName(name), buffer: toMono(buffer), version: 1, created: Date.now() };
  store.set((s) => ({ sounds: [...s.sounds, sound], selectedSoundId: sound.id }));
  return sound;
}

export function selectSound(id: string | null) {
  store.set({ selectedSoundId: id });
}

export function renameSound(id: string, name: string) {
  store.set((s) => ({ sounds: s.sounds.map((x) => (x.id === id ? { ...x, name } : x)) }));
}

/** Replace a sound's buffer with an edited version (undoable). */
export async function editSound(id: string, fn: (buf: AudioBuffer) => AudioBuffer | Promise<AudioBuffer>) {
  const sound = getSound(id);
  if (!sound) return;
  const next = await fn(sound.buffer);
  if (next === sound.buffer) return;
  const stack = undoStacks.get(id) ?? [];
  stack.push(sound.buffer);
  if (stack.length > 20) stack.shift();
  undoStacks.set(id, stack);
  store.set((s) => ({ sounds: s.sounds.map((x) => (x.id === id ? { ...x, buffer: next, version: x.version + 1 } : x)) }));
}

export const canUndo = (id: string) => (undoStacks.get(id)?.length ?? 0) > 0;

export function undoSound(id: string) {
  const prev = undoStacks.get(id)?.pop();
  if (!prev) return;
  store.set((s) => ({ sounds: s.sounds.map((x) => (x.id === id ? { ...x, buffer: prev, version: x.version + 1 } : x)) }));
}

export function deleteSound(id: string) {
  undoStacks.delete(id);
  store.set((s) => ({
    sounds: s.sounds.filter((x) => x.id !== id),
    selectedSoundId: s.selectedSoundId === id ? (s.sounds.find((x) => x.id !== id)?.id ?? null) : s.selectedSoundId,
    scene: { ...s.scene, sources: s.scene.sources.map((src) => (src.soundId === id ? { ...src, soundId: null } : src)) },
  }));
}

// ---------------------------------------------------------------- boot

/** Set a source's motion type and override some of that type's parameters. */
function setMotion(id: string, type: MotionType, params: Record<string, number>) {
  patchSource(id, (s) => ({
    motion: { ...s.motion, type, params: { ...s.motion.params, [type]: { ...s.motion.params[type], ...params } } },
  }));
}

/** Demo: a cathedral with someone walking around, a bee darting about, and an ambulance passing behind. */
async function createDemo() {
  const sr = audioCtx().sampleRate;
  const bee = addSound('Bee', await renderPreset('bee', 6, sr));
  const siren = addSound('Siren', await renderPreset('siren', 6, sr));
  const steps = addSound('Footsteps', await renderPreset('footsteps', 6, sr));

  updateScene(() => ({ environment: { preset: 'cathedral', wet: ENVIRONMENTS.cathedral.wet } }));

  // Ears are ~1.6 m above the floor, so footsteps come from below.
  const f = addSource(steps.id, { x: -2, y: -1.6, z: -3 }, 'Footsteps');
  setMotion(f.id, 'wander', { radius: 7, pace: 0.25, vertical: 0 });

  const b = addSource(bee.id, { x: 1, y: 0.3, z: -1 }, 'Bee');
  setMotion(b.id, 'wander', { radius: 3.5, pace: 0.9, vertical: 0.5 });
  patchSource(b.id, { gainDb: -4 });

  // Behind the listener (+z), driving left → right, once every ~8.4 s.
  const a = addSource(siren.id, { x: 0, y: 0, z: 14 }, 'Ambulance');
  setMotion(a.id, 'pass', { speed: 25, length: 160, heading: 90, gap: 2 });

  selectSource(f.id);
  selectSound(steps.id);
  updateScene((s) => ({ view: { ...s.view, scale: 18 } }));
}

export async function boot() {
  const saved = await loadAll();
  if (saved && saved.sounds.length) {
    const sounds: Sound[] = saved.sounds.map((r) => ({
      id: r.id, name: r.name, buffer: fromData(r.data, r.sampleRate), version: 1, created: r.created,
    }));
    const scene = hydrateScene(saved.scene);
    store.set({ sounds, scene, selectedSoundId: sounds[0].id, selectedSourceId: scene.sources[0]?.id ?? null });
    startAutosave(true);
  } else {
    store.set({ scene: defaultScene() });
    await createDemo();
    startAutosave(false);
  }
  store.set({ ready: true });
}

export async function resetToDemo() {
  store.set({ sounds: [], scene: defaultScene(), selectedSourceId: null, selectedSoundId: null });
  undoStacks.clear();
  await createDemo();
}
