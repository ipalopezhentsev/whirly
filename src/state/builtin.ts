// Built-in setups: scene files committed in src/presets/, one JSON file per setup.
//
// To add or update one, build the scene in the app, then 💾 Setups → "Export JSON" and save the
// file into src/presets/. demo.json is the demo: what a first-time visitor sees, and what
// "Reset to demo" restores. Without it (or if it doesn't open), a small built-in demo is made.
import { clearLibrary, createDemo } from './actions';
import { openSceneFile, type SceneFile } from './share';

const DEMO_FILE = 'demo';

const files = import.meta.glob<SceneFile>('../presets/*.json', { eager: true, import: 'default' });

export interface BuiltinSetup {
  /** File name without extension. */
  key: string;
  file: SceneFile;
}

/** The built-in setups, the demo first, then by name. */
export const BUILTIN_SETUPS: BuiltinSetup[] = Object.entries(files)
  .map(([path, file]) => ({ key: path.replace(/^.*\/|\.json$/g, ''), file }))
  .sort((a, b) => +(b.key === DEMO_FILE) - +(a.key === DEMO_FILE) || a.file.name.localeCompare(b.file.name));

/** Open a built-in setup, adding its sounds to the library. */
export const openBuiltin = (s: BuiltinSetup) => openSceneFile(s.file);

/** Open the demo scene, adding its sounds to the library. */
export async function openDemo() {
  const demo = BUILTIN_SETUPS.find((s) => s.key === DEMO_FILE);
  if (demo) {
    try {
      await openBuiltin(demo);
      return;
    } catch (e) {
      console.warn(`src/presets/${DEMO_FILE}.json did not open; using the built-in demo.`, e);
    }
  }
  await createDemo();
}

/** Replace all sounds and the scene with the demo. */
export async function resetToDemo() {
  clearLibrary();
  await openDemo();
}
