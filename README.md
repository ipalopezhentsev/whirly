# Whirly — spatial sound lab

Make or record a sound, place it in a 3D scene, and move it around you: closer, farther, orbiting, flying past, overhead. All audio processing runs in the browser via the Web Audio API — nothing is uploaded.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

Use headphones — the HRTF panner only works properly over headphones.

## What it does

**Sounds** (left panel)
- *Synthesize* — presets (bee, siren, engine, helicopter, footsteps, automatic gunfire, voice babble, birds, bell, rain, …) or a custom synth (waveform/noise, pitch sweep, ADSR, filter, vibrato, tremolo, repeat).
- *Record* from the microphone, optionally raw (no echo cancellation / noise suppression).
- *Import* any audio file the browser can decode. Everything is mixed to mono — sources are point sources.
- *Edit*: select on the waveform, then crop / delete / silence / reverse / normalize / fade / gain / trim silence / seamless-loop cross-fade / speed change, with undo. Download any sound as WAV.

**Scene** (centre) — a 3D view (three.js): orbit/pan/zoom the camera. Every source has a stem down to the floor and a floor shadow, so height is visible at a glance. Drag a ball to move it, drag the white ⇕ handle on the selected source to change its height, double-click the floor to add a source.

**Setups** — *💾 Setups* saves the current scene under a name in this browser (IndexedDB) and lists saved setups to open again. Each setup keeps its sounds at full quality, so it still opens after those sounds are deleted from the library; audio shared by several setups is stored once.

**Built-in setups** — every JSON file in [`src/presets/`](src/presets/) is a built-in setup, listed in *💾 Setups* for everyone. `demo.json` is the demo: what a first-time visitor sees (no saved work, no share link) and what *Reset to demo* restores; without it a small hard-coded demo is used. To add or update one, build the scene, then *💾 Setups → ⬇ JSON* and save the file into `src/presets/` (the file is named after the setup name in the box). The format is the share-link payload as readable JSON: synthesized sounds as recipes, recorded/imported ones as embedded 24 kHz µ-law audio.

**Share** — *🔗 Share* copies a link that holds the whole scene. Synthesized sounds travel as their recipe (preset, settings, random seed and edits), so the link stays short; recorded or imported sounds are embedded as compressed audio, which makes the link much longer.

**Source** (right panel) — position (polar or cartesian; height is measured from the listener's ears), motion path (orbit around listener, approach & recede, fly-by back & forth, one-way drive-past, circle, rise & fall, wander), directivity cone, gain/mute/solo, and live readouts: distance, direction, elevation, arrival delay, Doppler shift, distance loss, air low-pass.

**World** — listener head turn/spin and height (lying / sitting / standing / gallery / tower, or drag the listener in the 3D view; sources stay put in the room), environment (studio, room, hall, cathedral, cave, forest, canyon echoes), distance law, rolloff, speed of sound, air absorption.

**Render WAV** — renders the scene offline (faster than realtime) to a stereo WAV.

## How the physics is modelled

Per source: `player → gain → delay → air low-pass → PannerNode (HRTF) → master`, plus a send into a convolution reverb.

- **Propagation delay & Doppler**: a `DelayNode` driven with the retarded time — the delay is `|p(tₑ)| / c` where `tₑ = t − |p(tₑ)| / c`, solved by fixed-point iteration. Modulating the delay line produces physically correct Doppler shift (pitch rises on approach, falls when receding), and the scene shows where you *hear* a source from vs. where it *is*. Lower the speed of sound to exaggerate it.
- **Distance**: the PannerNode's inverse/exponential/linear laws; air absorption as a distance-dependent low-pass.
- **Height**: the browser's generic HRTF has weak elevation cues, so two extras are layered on: a pinna-style EQ (a notch that rises in frequency with elevation, an ~8 kHz boost for "above", a high-shelf cut for "below"), and a floor reflection — a mirrored image source below the floor whose extra path length changes with height. Broadband sounds carry these cues best.
- **Room**: procedurally generated stereo impulse responses. The reverb send falls off more slowly than the direct path, so far sources sound wetter — a key perceptual distance cue.
- Motion is a pure function of time, so realtime playback (smoothed per animation frame) and offline export (200 Hz automation ramps) use the same code — see `src/audio/spatial.ts`.

## Code map

| Path | What |
| --- | --- |
| `src/audio/spatial.ts` | Signal chain, per-time state, offline render |
| `src/audio/engine.ts` | Realtime playback; reconciles the audio graph with the store |
| `src/audio/synth.ts` | Sound presets and the custom synth |
| `src/audio/buffers.ts` | Sound editing operations |
| `src/audio/reverb.ts` | Environments and impulse-response generation |
| `src/scene/motion.ts` | Motion paths |
| `src/state/` | Store, actions, autosave to IndexedDB, frame loop |
| `src/components/` | React UI |
