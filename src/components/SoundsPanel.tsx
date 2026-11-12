import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { useFrame } from '../state/frame';
import {
  addSound, addSource, canUndo, deleteSound, editSound, renameSound, selectSound, toast, undoSound,
} from '../state/actions';
import { audioCtx, ensureRunning } from '../audio/context';
import { engine } from '../audio/engine';
import { MicRecorder } from '../audio/recorder';
import { CUSTOM_NUMBERS, CUSTOM_SELECTS, customDefaults, PRESETS, renderPreset, type CustomParams } from '../audio/synth';
import * as ed from '../audio/buffers';
import { downloadBlob, encodeWav, safeFileName } from '../audio/wav';
import { fmtTime } from '../audio/util';
import { Check, Hint, Select, Seg, Slider } from './controls';
import { Waveform } from './Waveform';
import type { Selection, Sound } from '../scene/types';

export function SoundsPanel() {
  const [tab, setTab] = useState<'synth' | 'record' | 'file'>('synth');
  return (
    <aside className="panel left">
      <h2>Sounds</h2>
      <div className="card">
        <Seg value={tab} onChange={setTab} options={[['synth', 'Synthesize'], ['record', 'Record'], ['file', 'Import']]} />
        {tab === 'synth' && <SynthCreator />}
        {tab === 'record' && <RecordCreator />}
        {tab === 'file' && <FileCreator />}
      </div>
      <SoundList />
      <SoundEditor />
    </aside>
  );
}

// ---------------------------------------------------------------- create

function SynthCreator() {
  const [preset, setPreset] = useState('bee');
  const [dur, setDur] = useState(PRESETS.bee.dur);
  const [params, setParams] = useState<CustomParams>(customDefaults);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      const buf = await renderPreset(preset, dur, audioCtx().sampleRate, params);
      const s = addSound(PRESETS[preset].label.replace(/[(…].*$/, '').trim(), buf);
      engine.previewSound(s, null);
    } catch (e) {
      toast(`Could not generate: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof CustomParams>(k: K, v: CustomParams[K]) => setParams((p) => ({ ...p, [k]: v }));

  return (
    <div className="pane">
      <Select
        label="Preset"
        value={preset}
        options={Object.entries(PRESETS).map(([k, p]) => [k, p.label] as const)}
        onChange={(k) => {
          setPreset(k);
          setDur(PRESETS[k].dur);
        }}
      />
      <Slider label="Length" value={dur} min={0.2} max={30} step={0.1} unit="s" onChange={setDur} />
      {preset === 'custom' && (
        <div className="custom">
          {(['wave', 'filter'] as const).map((k) => (
            <Select key={k} label={CUSTOM_SELECTS[k].label} value={params[k] as string}
              options={CUSTOM_SELECTS[k].options.map((o) => [o, o] as const)}
              onChange={(v) => set(k, v as never)} />
          ))}
          {(Object.keys(CUSTOM_NUMBERS) as (keyof typeof CUSTOM_NUMBERS)[]).map((k) => {
            const s = CUSTOM_NUMBERS[k];
            return <Slider key={k} label={s.label} value={params[k]} min={s.min} max={s.max} step={s.step} log={s.log} unit={s.unit} onChange={(v) => set(k, v)} />;
          })}
          <Hint>Repeat = 0 plays one long note; otherwise notes repeat at that interval.</Hint>
        </div>
      )}
      <button className="primary wide" onClick={generate} disabled={busy}>
        {busy ? 'Rendering…' : '✦ Generate sound'}
      </button>
    </div>
  );
}

function RecordCreator() {
  const rec = useRef<MicRecorder | null>(null);
  const meter = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const [recording, setRecording] = useState(false);
  const [raw, setRaw] = useState(true);
  const [trim, setTrim] = useState(true);

  useEffect(() => () => rec.current?.cancel(), []);

  useFrame(() => {
    const r = rec.current;
    if (!r?.active) return;
    if (meter.current) meter.current.style.width = `${Math.min(100, r.level() * 100)}%`;
    if (time.current) time.current.textContent = fmtTime(r.elapsed());
  });

  const toggle = async () => {
    if (!recording) {
      try {
        rec.current = new MicRecorder();
        await rec.current.start(raw);
        setRecording(true);
      } catch (e) {
        toast(`Microphone unavailable: ${(e as Error).message}`, 'error');
      }
      return;
    }
    setRecording(false);
    try {
      let buf = await rec.current!.stop();
      buf = ed.toMono(buf);
      if (trim) buf = ed.trimSilence(buf);
      const s = addSound('Recording', ed.normalize(buf, -1));
      toast(`Recorded ${s.buffer.duration.toFixed(1)} s`);
    } catch (e) {
      toast(`Recording failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="pane">
      <Check label="Raw input (no echo cancel / noise suppression)" checked={raw} onChange={setRaw} />
      <Check label="Trim silence & normalize when done" checked={trim} onChange={setTrim} />
      <button className={`wide ${recording ? 'rec on' : 'rec'}`} onClick={toggle}>
        {recording ? '■ Stop recording' : '● Record from microphone'}
      </button>
      {recording && (
        <div className="recbar">
          <div className="lvl"><div ref={meter} /></div>
          <span ref={time} className="mono">0:00.0</span>
        </div>
      )}
      <Hint>Everything stays in your browser; nothing is uploaded.</Hint>
    </div>
  );
}

function FileCreator() {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const buf = await audioCtx().decodeAudioData(await f.arrayBuffer());
        addSound(f.name.replace(/\.[^.]+$/, ''), buf);
      } catch {
        toast(`Could not decode ${f.name}`, 'error');
      }
    }
  };

  return (
    <div className="pane">
      <div
        className={`drop ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); load(e.dataTransfer.files); }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
      >
        Drop audio files here or <u>browse</u>
        <small>WAV, MP3, OGG, FLAC… (mixed to mono)</small>
      </div>
      <input ref={input} type="file" accept="audio/*" multiple hidden onChange={(e) => { load(e.target.files); e.target.value = ''; }} />
    </div>
  );
}

// ---------------------------------------------------------------- list

function SoundList() {
  const sounds = useApp((s) => s.sounds);
  const selected = useApp((s) => s.selectedSoundId);
  const sources = useApp((s) => s.scene.sources);
  if (!sounds.length) return <p className="hint">No sounds yet.</p>;
  return (
    <ul className="sound-list">
      {sounds.map((s) => {
        const uses = sources.filter((x) => x.soundId === s.id).length;
        return (
          <li key={s.id} className={s.id === selected ? 'on' : ''} onClick={() => selectSound(s.id)}>
            <button className="icon" title="Preview" onClick={(e) => { e.stopPropagation(); engine.previewSound(s, null); }}>▶</button>
            <span className="nm">{s.name}</span>
            <span className="meta">{s.buffer.duration.toFixed(1)}s{uses ? ` · ${uses}×` : ''}</span>
            <button className="small" title="Place this sound in the scene"
              onClick={(e) => { e.stopPropagation(); addSource(s.id); }}>＋ Scene</button>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- editor

function SoundEditor() {
  const sound = useApp((s) => s.sounds.find((x) => x.id === s.selectedSoundId));
  if (!sound) return null;
  return <EditorFor key={sound.id} sound={sound} />;
}

function EditorFor({ sound }: { sound: Sound }) {
  const [sel, setSel] = useState<Selection | null>(null);
  const [rate, setRate] = useState(1);
  const [busy, setBusy] = useState(false);

  const run = async (fn: (b: AudioBuffer) => AudioBuffer | Promise<AudioBuffer>, keepSel = false) => {
    setBusy(true);
    try {
      engine.stopPreview();
      await editSound(sound.id, fn);
      if (!keepSel) setSel(null);
    } finally {
      setBusy(false);
    }
  };

  const ops: [string, string, () => void][] = [
    ['Crop', 'Keep only the selection', () => run((b) => ed.crop(b, sel))],
    ['Delete', 'Remove the selection', () => run((b) => ed.removeRange(b, sel))],
    ['Silence', 'Silence the selection', () => run((b) => ed.silence(b, sel), true)],
    ['Reverse', 'Reverse (selection or all)', () => run((b) => ed.reverse(b, sel), true)],
    ['Normalize', 'Peak to −1 dBFS', () => run((b) => ed.normalize(b, -1), true)],
    ['Fade in', 'Fade in over selection (or start)', () => run((b) => ed.fadeIn(b, sel), true)],
    ['Fade out', 'Fade out over selection (or end)', () => run((b) => ed.fadeOut(b, sel), true)],
    ['−3 dB', 'Quieter (selection or all)', () => run((b) => ed.applyGain(b, -3, sel), true)],
    ['+3 dB', 'Louder (selection or all)', () => run((b) => ed.applyGain(b, 3, sel), true)],
    ['Trim', 'Cut silence at both ends', () => run((b) => ed.trimSilence(b))],
    ['Loop x-fade', 'Cross-fade the end into the start so the sound loops seamlessly', () => run((b) => ed.loopCrossfade(b, 0.08))],
  ];

  return (
    <div className="card editor">
      <div className="ed-head">
        <input className="name-in" value={sound.name} onChange={(e) => renameSound(sound.id, e.target.value)} aria-label="Sound name" />
        <button className="icon" title="Download as WAV" onClick={() => downloadBlob(encodeWav(sound.buffer), `${safeFileName(sound.name)}.wav`)}>⬇</button>
        <button className="icon danger" title="Delete sound"
          onClick={() => { if (confirm(`Delete “${sound.name}”?`)) { engine.stopPreview(); deleteSound(sound.id); } }}>✕</button>
      </div>
      <Waveform soundId={sound.id} buffer={sound.buffer} selection={sel} onSelect={setSel} />
      <div className="ed-info mono">
        {sound.buffer.duration.toFixed(2)} s · {(sound.buffer.sampleRate / 1000).toFixed(1)} kHz mono
        {sel && ` · sel ${sel.start.toFixed(2)}–${sel.end.toFixed(2)} s`}
      </div>
      <div className="btns">
        <button className="primary" onClick={async () => { await ensureRunning(); engine.previewSound(sound, sel); }}>▶ Play{sel ? ' sel' : ''}</button>
        <button onClick={() => engine.stopPreview()}>■</button>
        <button onClick={() => undoSound(sound.id)} disabled={!canUndo(sound.id)}>↶ Undo</button>
        {sel && <button onClick={() => setSel(null)}>Clear sel</button>}
      </div>
      <div className="btns ops">
        {ops.map(([label, title, fn]) => (
          <button key={label} title={title} onClick={fn} disabled={busy}>{label}</button>
        ))}
      </div>
      <div className="speed">
        <Slider label="Speed" value={rate} min={0.25} max={4} step={0.01} unit="×" onChange={setRate}
          title="Changes speed and pitch together, like tape" />
        <button disabled={busy || rate === 1} onClick={() => run((b) => ed.changeSpeed(b, rate)).then(() => setRate(1))}>
          Apply speed ×{rate.toFixed(2)}
        </button>
      </div>
      <Hint>Drag on the waveform to select. Edits apply to the selection, or the whole sound if nothing is selected.</Hint>
    </div>
  );
}
