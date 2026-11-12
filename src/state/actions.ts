// All state mutations. Components call these; the engine and autosave react to the store.
import { store } from './store';
import { audioCtx } from '../audio/context';
import { applyEdit, toMono } from '../audio/buffers';
import { newSeed, PRESETS, renderPreset } from '../audio/synth';
import { ENVIRONMENTS } from '../audio/reverb';
import { DEG, uid } from '../audio/util';
import { defaultScene, newSource } from '../scene/scene';
import { randomSeed, reseedMotion } from '../scene/motion';
import type { EditOp, MotionType, Physics, Scene, Sound, Source, SynthRecipe, Vec3 } from '../scene/types';

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
  const sound = getSound(soundId);
  const src = newSource(scene, soundId, p, name ?? sound?.name);
  if (sound?.recipe && PRESETS[sound.recipe.preset]?.oneShot) src.playback = 'random';
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
    // Same settings, but its own random path.
    motion: reseedMotion(src.motion),
    playSeed: randomSeed(),
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

/** Earlier versions of a sound, for undo. */
const undoStacks = new Map<string, (Pick<Sound, 'buffer' | 'recipe'> & { name?: string })[]>();

function uniqueName(name: string) {
  const names = new Set(store.get().sounds.map((s) => s.name));
  if (!names.has(name)) return name;
  for (let i = 2; ; i++) if (!names.has(`${name} ${i}`)) return `${name} ${i}`;
}

export function addSound(name: string, buffer: AudioBuffer, recipe?: SynthRecipe): Sound {
  const sound: Sound = { id: uid(), name: uniqueName(name), buffer: toMono(buffer), version: 1, created: Date.now(), recipe };
  store.set((s) => ({ sounds: [...s.sounds, sound], selectedSoundId: sound.id }));
  return sound;
}

/** Render a synth recipe, edits included. */
export async function renderRecipe(r: SynthRecipe, sampleRate = audioCtx().sampleRate) {
  let buf = await renderPreset(r.preset, r.dur, sampleRate, r.params, r.seed, r.speech, r.music);
  for (const e of r.edits) buf = await applyEdit(buf, e);
  return buf;
}

/** A complete synth recipe: a fresh random seed unless one is given, and only the settings its preset uses. */
export function makeRecipe(recipe: Omit<SynthRecipe, 'seed' | 'edits'> & Partial<SynthRecipe>): SynthRecipe {
  const r: SynthRecipe = { seed: newSeed(), edits: [], ...recipe };
  if (r.preset !== 'custom') delete r.params;
  if (!PRESETS[r.preset]?.speech || !r.speech?.text.trim()) delete r.speech;
  if (!PRESETS[r.preset]?.music) delete r.music;
  return r;
}

/** Synthesize a new sound and add it to the library. */
export async function synthSound(name: string, recipe: Omit<SynthRecipe, 'seed' | 'edits'> & Partial<SynthRecipe>) {
  const r = makeRecipe(recipe);
  return addSound(name, await renderRecipe(r), r);
}

/**
 * Swap a sound's audio for a new render (undoable). It keeps its id, so scene sources using it
 * play the new audio.
 */
export function replaceSound(id: string, buffer: AudioBuffer, recipe: SynthRecipe | undefined, name?: string) {
  const sound = getSound(id);
  if (!sound) return;
  const stack = undoStacks.get(id) ?? [];
  stack.push({ buffer: sound.buffer, recipe: sound.recipe, name: sound.name });
  if (stack.length > 20) stack.shift();
  undoStacks.set(id, stack);
  store.set((s) => ({
    sounds: s.sounds.map((x) => (x.id === id ? { ...x, buffer: toMono(buffer), recipe, name: name ?? x.name, version: x.version + 1 } : x)),
  }));
}

export function selectSound(id: string | null) {
  store.set({ selectedSoundId: id });
}

export function renameSound(id: string, name: string) {
  store.set((s) => ({ sounds: s.sounds.map((x) => (x.id === id ? { ...x, name } : x)) }));
}

/** Edit a sound (undoable). Synthesized sounds remember the edit in their recipe. */
export async function editSound(id: string, op: EditOp) {
  const sound = getSound(id);
  if (!sound) return;
  const next = await applyEdit(sound.buffer, op);
  if (next === sound.buffer) return;
  const stack = undoStacks.get(id) ?? [];
  stack.push({ buffer: sound.buffer, recipe: sound.recipe });
  if (stack.length > 20) stack.shift();
  undoStacks.set(id, stack);
  const recipe = sound.recipe && { ...sound.recipe, edits: [...sound.recipe.edits, op] };
  store.set((s) => ({ sounds: s.sounds.map((x) => (x.id === id ? { ...x, buffer: next, recipe, version: x.version + 1 } : x)) }));
}

export const canUndo = (id: string) => (undoStacks.get(id)?.length ?? 0) > 0;

export function undoSound(id: string) {
  const prev = undoStacks.get(id)?.pop();
  if (!prev) return;
  store.set((s) => ({ sounds: s.sounds.map((x) => (x.id === id ? { ...x, ...prev, version: x.version + 1 } : x)) }));
}

export function deleteSound(id: string) {
  deleteSounds([id]);
}

/** Remove sounds from the library; scene sources that used them are left without a sound. */
export function deleteSounds(ids: string[]) {
  const gone = new Set(ids);
  for (const id of ids) undoStacks.delete(id);
  store.set((s) => {
    const sounds = s.sounds.filter((x) => !gone.has(x.id));
    return {
      sounds,
      selectedSoundId: s.selectedSoundId && gone.has(s.selectedSoundId) ? (sounds[0]?.id ?? null) : s.selectedSoundId,
      scene: { ...s.scene, sources: s.scene.sources.map((src) => (src.soundId && gone.has(src.soundId) ? { ...src, soundId: null } : src)) },
    };
  });
}

// ---------------------------------------------------------------- demo

/** Set a source's motion type and override some of that type's parameters. */
function setMotion(id: string, type: MotionType, params: Record<string, number>) {
  patchSource(id, (s) => ({
    motion: { ...s.motion, type, params: { ...s.motion.params, [type]: { ...s.motion.params[type], ...params } } },
  }));
}

/**
 * Built-in demo: a cathedral with someone walking around, a bee darting about, and an ambulance
 * passing behind. Only a fallback: the demo visitors see is the scene saved in demo.txt (see demo.ts).
 */
export async function createDemo() {
  const bee = await synthSound('Bee', { preset: 'bee', dur: 6 });
  const siren = await synthSound('Siren', { preset: 'siren', dur: 6 });
  const steps = await synthSound('Footsteps', { preset: 'footsteps', dur: 6 });

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
}

/** Start an empty scene with default settings. The library keeps its sounds. */
export function newScene() {
  store.set({ scene: defaultScene(), selectedSourceId: null, setupName: null });
}

/** Remove every sound and start an empty scene. */
export function clearLibrary() {
  store.set({ sounds: [], scene: defaultScene(), selectedSourceId: null, selectedSoundId: null });
  undoStacks.clear();
}
