// A tiny external store. React reads it through useSyncExternalStore; the audio engine
// and canvases read it directly every frame without causing re-renders.
import { useSyncExternalStore } from 'react';
import { defaultScene } from '../scene/scene';
import type { Scene, Sound } from '../scene/types';

export interface AppState {
  ready: boolean;
  sounds: Sound[];
  scene: Scene;
  selectedSourceId: string | null;
  selectedSoundId: string | null;
  playing: boolean;
  rightTab: 'source' | 'world';
  toast: { id: number; msg: string; kind: 'info' | 'error' } | null;
}

let state: AppState = {
  ready: false,
  sounds: [],
  scene: defaultScene(),
  selectedSourceId: null,
  selectedSoundId: null,
  playing: false,
  rightTab: 'source',
  toast: null,
};

const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(update: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const patch = typeof update === 'function' ? update(state) : update;
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

/** Subscribe a component to a slice of state. The selector must return existing references. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
