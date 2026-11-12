// Actions for algorithmic compositions: compose, split into stems placed around the listener, and
// re-render every sound of a piece (its mix and its stems) together when its settings change.
import { store } from './store';
import { addSound, addSource, makeRecipe, patchSource, renderRecipe, replaceSound, selectSound } from './actions';
import { fromData } from '../audio/buffers';
import { engine } from '../audio/engine';
import { renderMusicAsync } from '../audio/music/client';
import { STYLES } from '../audio/music/presets';
import { musicDuration, type MusicParams, type TrackParams } from '../audio/music/types';
import { DEG } from '../audio/util';
import type { Sound, SynthRecipe, Vec3 } from '../scene/types';

/** Settings shared by a piece's mix and stems (everything but which stem). */
export const pieceSettings = (m: MusicParams): MusicParams => {
  const { stem: _stem, ...rest } = m;
  return rest;
};

const pieceKey = (r: SynthRecipe) => JSON.stringify({ m: pieceSettings(r.music!), s: r.seed });

/** The library sounds made from the same piece as `sound`: its mix and its stems. */
export function pieceSounds(sound: Sound, sounds = store.get().sounds) {
  if (!sound.recipe?.music) return [sound];
  const key = pieceKey(sound.recipe);
  return sounds.filter((s) => s.recipe?.music && pieceKey(s.recipe) === key);
}

/** Default name for a piece, or one of its stems. */
export function musicName(m: MusicParams, track?: TrackParams) {
  const base = `♫ ${STYLES[m.style]?.label ?? 'Music'}`;
  return track ? `${base} · ${track.name}` : base;
}

const musicRecipe = (m: MusicParams, seed: number, stem?: string) =>
  makeRecipe({ preset: 'music', dur: musicDuration(m), seed, music: { ...pieceSettings(m), ...(stem && { stem }) } });

/** Compose a piece and add its mix to the library. */
export async function composeMix(m: MusicParams, seed: number) {
  const recipe = musicRecipe(m, seed);
  const sound = addSound(musicName(m), await renderRecipe(recipe), recipe);
  engine.previewSound(sound, null);
  return sound;
}

/**
 * Where a band's stems go: drums behind the centre, bass in the middle, everything else spread
 * on an arc in front, pads wide and a little raised.
 */
function stemPositions(tracks: TrackParams[]): Vec3[] {
  const others = tracks.filter((t) => t.role !== 'drums' && t.role !== 'bass');
  return tracks.map((t) => {
    if (t.role === 'drums') return { x: 0, y: -0.3, z: -4.5 };
    if (t.role === 'bass') return { x: 0, y: -0.5, z: -2.6 };
    // Evenly across the front, −75° … +75°; a lone part sits a little off-centre, clear of bass and drums.
    const i = others.indexOf(t);
    const n = others.length;
    const az = (n === 1 ? 30 : -75 + (150 * (i + 0.5)) / n) * DEG;
    const r = 3.5;
    return { x: +(r * Math.sin(az)).toFixed(2), y: t.role === 'pad' ? 1 : 0, z: +(-r * Math.cos(az)).toFixed(2) };
  });
}

/** Add stems for the given tracks as sounds, each placed in the scene as its own source. */
function placeStems(base: string, m: MusicParams, seed: number, tracks: TrackParams[], stems: Record<string, Float32Array>, sampleRate: number) {
  const pos = stemPositions(tracks);
  const sources = tracks.map((t, i) => {
    const sound = addSound(`${base} · ${t.name}`, fromData(stems[t.id] ?? new Float32Array(1), sampleRate), musicRecipe(m, seed, t.id));
    return addSource(sound.id, pos[i], t.name);
  });
  return sources;
}

/** Compose a piece straight into stems: one sound and one scene source per playing track. */
export async function composeBand(m: MusicParams, seed: number) {
  const res = await renderMusicAsync(pieceSettings(m), seed, 'all');
  const tracks = m.tracks.filter((t) => t.on);
  const sources = placeStems(musicName(m), m, seed, tracks, res.stems, res.sampleRate);
  return sources;
}

/**
 * Split a piece's mix into stems placed around the listener. Scene sources that played the mix
 * are muted, so nothing doubles up.
 */
export async function splitIntoStems(mix: Sound) {
  const r = mix.recipe!;
  const m = r.music!;
  const res = await renderMusicAsync(pieceSettings(m), r.seed, 'all');
  const tracks = m.tracks.filter((t) => t.on);
  for (const src of store.get().scene.sources) if (src.soundId === mix.id && !src.muted) patchSource(src.id, { muted: true });
  placeStems(mix.name, m, r.seed, tracks, res.stems, res.sampleRate);
  selectSound(mix.id);
  return tracks.length;
}

/**
 * Re-render a piece with new settings (undoable per sound). Every sound of the piece follows: the
 * mix and all its stems. Tracks added since the split get new stems and sources.
 */
export async function rerenderPiece(sound: Sound, m: MusicParams, seed: number) {
  const siblings = pieceSounds(sound);
  const oldSettings = sound.recipe!.music!;
  const autoName = (s: Sound) => {
    const stem = s.recipe!.music!.stem;
    const tr = oldSettings.tracks.find((t) => t.id === stem);
    return s.name === musicName(oldSettings, stem ? tr : undefined);
  };
  const newName = (stem: string | undefined) => musicName(m, stem ? m.tracks.find((t) => t.id === stem) : undefined);

  if (siblings.length === 1 && !oldSettings.stem) {
    const recipe = musicRecipe(m, seed);
    const buffer = await renderRecipe(recipe);
    replaceSound(sound.id, buffer, recipe, autoName(sound) ? newName(undefined) : undefined);
    return { ...sound, buffer };
  }

  const res = await renderMusicAsync(pieceSettings(m), seed, 'all');
  const len = Math.max(1, Math.ceil(musicDuration(m) * res.sampleRate));
  let self = sound;
  for (const s of siblings) {
    const stem = s.recipe!.music!.stem;
    const data = stem ? (res.stems[stem] ?? new Float32Array(len)) : res.mix!;
    const buffer = fromData(data, res.sampleRate);
    replaceSound(s.id, buffer, musicRecipe(m, seed, stem), autoName(s) ? newName(stem) : undefined);
    if (s.id === sound.id) self = { ...s, buffer };
  }
  // New tracks join the band where the piece has been split.
  const stemmed = new Set(siblings.map((s) => s.recipe!.music!.stem).filter(Boolean));
  if (stemmed.size) {
    const added = m.tracks.filter((t) => t.on && !stemmed.has(t.id));
    if (added.length) placeStems(musicName(m), m, seed, added, res.stems, res.sampleRate);
    selectSound(sound.id);
  }
  return self;
}
