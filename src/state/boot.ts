// Startup: restore saved work (or create the demo), then open a share link if the URL has one.
import { store } from './store';
import { loadAll, startAutosave } from './persist';
import { toast } from './actions';
import { openDemo } from './builtin';
import { openSharedFromHash, sharedFromHash } from './share';
import { fromData } from '../audio/buffers';
import { defaultScene, hydrateScene } from '../scene/scene';
import type { Sound } from '../scene/types';

export async function boot() {
  const saved = await loadAll();
  const hasWork = !!saved?.sounds.length;
  if (saved && hasWork) {
    const sounds: Sound[] = saved.sounds.map((r) => ({
      id: r.id, name: r.name, buffer: fromData(r.data, r.sampleRate), version: 1, created: r.created, recipe: r.recipe,
    }));
    const scene = hydrateScene(saved.scene);
    store.set({ sounds, scene, selectedSoundId: sounds[0].id, selectedSourceId: scene.sources[0]?.id ?? null });
    startAutosave(true);
    await openSharedFromHash(true);
  } else {
    store.set({ scene: defaultScene() });
    // A first-time visitor with a share link gets the shared scene instead of the demo.
    if (!(await openSharedFromHash(false))) await openDemo();
    startAutosave(false);
  }
  store.set({ ready: true });

  // Pasting a share link into a tab that already has Whirly open only changes the fragment.
  window.addEventListener('hashchange', () => {
    if (!sharedFromHash()) return;
    toast('Opening the shared scene…');
    openSharedFromHash(store.get().scene.sources.length > 0);
  });
}
