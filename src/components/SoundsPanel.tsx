import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { useFrame } from '../state/frame';
import {
  addSound, addSource, canUndo, deleteSound, deleteSounds, editSound, makeRecipe, renameSound, renderRecipe,
  replaceSound, selectSound, toast, undoSound,
} from '../state/actions';
import { audioCtx, ensureRunning } from '../audio/context';
import { engine } from '../audio/engine';
import { MicRecorder } from '../audio/recorder';
import { CUSTOM_NUMBERS, CUSTOM_SELECTS, customDefaults, newSeed, PRESETS, type CustomParams } from '../audio/synth';
import { SPEECH_DEFAULTS, speechDuration, type SpeechParams } from '../audio/speech';
import * as ed from '../audio/buffers';
import { downloadBlob, encodeWav, safeFileName } from '../audio/wav';
import { fmtTime } from '../audio/util';
import { Check, Hint, Select, Seg, Slider } from './controls';
import { Waveform } from './Waveform';
import type { EditKind, Selection, Sound, SynthRecipe } from '../scene/types';

/** Default name for a synthesized sound: its text when it speaks, else the preset. */
function synthName(r: Pick<SynthRecipe, 'preset' | 'speech'> | undefined) {
  if (!r) return '';
  const text = r.speech?.text.trim();
  if (text) return `“${text.length > 24 ? `${text.slice(0, 22).trimEnd()}…` : text}”`;
  return PRESETS[r.preset]?.label.replace(/[(…].*$/, '').trim() ?? r.preset;
}

/** Whether a sound still has its automatic name (possibly numbered, "Synthetic voice 2"). */
function isAutoName(name: string, r: SynthRecipe) {
  const auto = synthName(r);
  return name === auto || (name.startsWith(`${auto} `) && /^[0-9]+$/.test(name.slice(auto.length + 1)));
}

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
    </aside>
  );
}

// ---------------------------------------------------------------- create

function SynthCreator() {
  const [preset, setPreset] = useState('voice');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      const recipe = makeRecipe({ preset, dur: PRESETS[preset].dur, params: customDefaults() });
      const s = addSound(synthName(recipe), await renderRecipe(recipe), recipe);
      engine.previewSound(s, null);
    } catch (e) {
      toast(`Could not generate: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <Select label="Preset" value={preset} onChange={setPreset}
        options={Object.entries(PRESETS).map(([k, p]) => [k, p.label] as const)} />
      <button className="primary wide" onClick={add} disabled={busy}>{busy ? 'Rendering…' : '✦ Add sound'}</button>
      <Hint>Its settings (text, pitch, length…) are edited on the sound itself, in its editor below.</Hint>
    </div>
  );
}

interface SynthDraft {
  preset: string;
  dur: number;
  params: CustomParams;
  speech: SpeechParams;
}

const draftOf = (r: SynthRecipe): SynthDraft => ({
  preset: r.preset, dur: r.dur, params: r.params ?? customDefaults(), speech: r.speech ?? SPEECH_DEFAULTS,
});

/** A synthesized sound's own settings: edit them and Apply to re-render this sound in place. */
function SynthSettings({ sound }: { sound: Sound }) {
  const r = sound.recipe!;
  // Reset the form when the recipe changes underneath it (Apply, undo), but not for later edits.
  const recipeKey = JSON.stringify({ ...r, edits: [] });
  const [d, setD] = useState(() => draftOf(r));
  useEffect(() => setD(draftOf(r)), [recipeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);

  const speaks = !!PRESETS[d.preset]?.speech;
  const text = d.speech.text.trim();
  const spokenDur = useMemo(() => (speaks && text ? speechDuration(d.speech) : 0), [speaks, text, d.speech]);
  const next = (seed = r.seed) => makeRecipe({ preset: d.preset, dur: spokenDur || d.dur, params: d.params, speech: d.speech, seed });
  const changed = JSON.stringify(next()) !== JSON.stringify(makeRecipe({ ...r, edits: [] }));

  const apply = async (seed?: number) => {
    setBusy(true);
    try {
      engine.stopPreview();
      const recipe = next(seed);
      const buffer = await renderRecipe(recipe);
      // A name the user gave stays; an automatic one follows the new text.
      replaceSound(sound.id, buffer, recipe, isAutoName(sound.name, r) ? synthName(recipe) : undefined);
      engine.previewSound({ ...sound, buffer }, null);
    } catch (e) {
      toast(`Could not generate: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const setP = <K extends keyof CustomParams>(k: K, v: CustomParams[K]) => setD((x) => ({ ...x, params: { ...x.params, [k]: v } }));
  const setSp = <K extends keyof SpeechParams>(k: K, v: SpeechParams[K]) => setD((x) => ({ ...x, speech: { ...x.speech, [k]: v } }));

  return (
    <div className="synth-settings">
      <Select label="Preset" value={d.preset} options={Object.entries(PRESETS).map(([k, p]) => [k, p.label] as const)}
        onChange={(k) => setD((x) => ({ ...x, preset: k, dur: PRESETS[k].dur }))} />
      {speaks && (
        <>
          <textarea
            className="speech-text"
            rows={3}
            placeholder="Text to speak, English or Russian. Leave empty for wordless babble."
            value={d.speech.text}
            onChange={(e) => setSp('text', e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) apply(); }}
          />
          {text && (
            <>
              <Slider label="Pitch" value={d.speech.pitch} min={50} max={400} log unit="Hz" onChange={(v) => setSp('pitch', v)} />
              <Slider label="Speed" value={d.speech.rate} min={0.4} max={2.5} step={0.05} unit="×" onChange={(v) => setSp('rate', v)} />
              <Slider label="Formants" value={d.speech.formant} min={0.7} max={1.4} step={0.01} unit="×"
                title="Vocal tract size: lower sounds bigger, higher sounds smaller" onChange={(v) => setSp('formant', v)} />
            </>
          )}
        </>
      )}
      {spokenDur
        ? <div className="ctl field"><span className="lbl">Length</span><span className="hint">auto, {spokenDur.toFixed(1)} s</span></div>
        : <Slider label="Length" value={d.dur} min={0.2} max={30} step={0.1} unit="s" onChange={(v) => setD((x) => ({ ...x, dur: v }))} />}
      {d.preset === 'custom' && (
        <>
          {(['wave', 'filter'] as const).map((k) => (
            <Select key={k} label={CUSTOM_SELECTS[k].label} value={d.params[k] as string}
              options={CUSTOM_SELECTS[k].options.map((o) => [o, o] as const)}
              onChange={(v) => setP(k, v as never)} />
          ))}
          {(Object.keys(CUSTOM_NUMBERS) as (keyof typeof CUSTOM_NUMBERS)[]).map((k) => {
            const s = CUSTOM_NUMBERS[k];
            return <Slider key={k} label={s.label} value={d.params[k]} min={s.min} max={s.max} step={s.step} log={s.log} unit={s.unit} onChange={(v) => setP(k, v)} />;
          })}
          <Hint>Repeat = 0 plays one long note; otherwise notes repeat at that interval.</Hint>
        </>
      )}
      <div className="gen-btns">
        <button className="primary" onClick={() => apply()} disabled={busy || !changed}
          title="Re-render this sound with these settings (undoable); scene sources using it follow">
          {busy ? 'Rendering…' : changed ? '↻ Apply' : 'Up to date'}
        </button>
        <button onClick={() => apply(newSeed())} disabled={busy || (speaks && !!text)}
          title="Same settings, a new random variation">🎲 Variation</button>
      </div>
      {r.edits.length > 0 && changed && (
        <Hint>Applying drops the {r.edits.length} edit{r.edits.length > 1 ? 's' : ''} made to this sound (Undo brings them back).</Hint>
      )}
      {speaks && text && (
        <Hint>A small formant synthesizer, robotic by design. Commas and full stops add pauses, repeated ones (…, blank lines) longer ones, and [1.5] inserts 1.5 s of silence; a question mark raises the pitch at the end; ! (or !!, !!!) is louder, higher and a bit faster. Russian stress is guessed: mark it with a capital vowel (молокО) or + before the vowel (молок+о) where it is wrong; = before a vowel (мол=око) says it as written, unreduced. Ctrl+Enter applies.</Hint>
      )}
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
  // Which sounds are expanded to show their settings and editor; each one toggles on its own.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = sounds.map((s) => s.id);
    // A sound added from now on opens right away, ready to edit (not everything at startup).
    if (known.current) {
      const added = ids.filter((id) => !known.current!.has(id));
      if (added.length) setOpen((o) => new Set([...o, ...added]));
    }
    known.current = new Set(ids);
  }, [sounds]);
  if (!sounds.length) return <p className="hint">No sounds yet.</p>;
  const toggle = (id: string) => setOpen((o) => {
    const n = new Set(o);
    if (!n.delete(id)) n.add(id);
    return n;
  });
  const used = new Set(sources.map((x) => x.soundId));
  const unused = sounds.filter((s) => !used.has(s.id));

  const remove = (s: Sound, uses: number) => {
    if (uses && !confirm(`“${s.name}” is placed in the scene ${uses}×. Remove it anyway?`)) return;
    engine.stopPreview();
    deleteSound(s.id);
  };
  const clearAll = () => {
    const placed = sounds.length - unused.length;
    if (!confirm(`Remove all ${sounds.length} sounds${placed ? `, including ${placed} placed in the scene` : ''}?`)) return;
    engine.stopPreview();
    deleteSounds(sounds.map((s) => s.id));
  };

  return (
    <>
    <div className="list-head">
      <span>Library · {sounds.length}</span>
      <button className="small" disabled={!unused.length}
        onClick={() => {
          const names = unused.map((s) => `• ${s.name}`).join('\n');
          if (!confirm(`Remove ${unused.length} sound${unused.length > 1 ? 's' : ''} not placed in the scene?\n\n${names}`)) return;
          engine.stopPreview();
          deleteSounds(unused.map((s) => s.id));
        }}
        title="Remove every sound that is not placed in the scene">Remove unused{unused.length ? ` (${unused.length})` : ''}</button>
      <button className="small danger" onClick={clearAll} title="Remove all sounds">Clear all</button>
    </div>
    <ul className="sound-list">
      {sounds.map((s) => {
        const uses = sources.filter((x) => x.soundId === s.id).length;
        return (
          <li key={s.id} className={`${s.id === selected ? 'on' : ''} ${open.has(s.id) ? 'open' : ''}`}>
            <div className="row" onClick={() => { selectSound(s.id); toggle(s.id); }}
              title={open.has(s.id) ? 'Collapse' : 'Show settings and editor'}>
            <span className="caret">{open.has(s.id) ? '▾' : '▸'}</span>
            <button className="icon" title="Preview" onClick={(e) => { e.stopPropagation(); engine.previewSound(s, null); }}>▶</button>
            <span className="nm">{s.name}</span>
            <span className="meta">{s.buffer.duration.toFixed(1)}s{uses ? ` · ${uses}×` : ''}</span>
            <button className="small" title="Place this sound in the scene"
              onClick={(e) => { e.stopPropagation(); addSource(s.id); }}>＋ Scene</button>
            <button className="icon danger" title="Remove from the library"
              onClick={(e) => { e.stopPropagation(); remove(s, uses); }}>✕</button>
            </div>
            {open.has(s.id) && <EditorFor sound={s} />}
          </li>
        );
      })}
    </ul>
    </>
  );
}

// ---------------------------------------------------------------- editor

function EditorFor({ sound }: { sound: Sound }) {
  const [sel, setSel] = useState<Selection | null>(null);
  const [rate, setRate] = useState(1);
  const [busy, setBusy] = useState(false);

  // Edits are data (EditOp), so synthesized sounds can record them in their recipe for share links.
  const run = async (op: EditKind, { useSel = false, keepSel = false, v }: { useSel?: boolean; keepSel?: boolean; v?: number } = {}) => {
    setBusy(true);
    try {
      engine.stopPreview();
      const s = useSel && sel ? { start: +sel.start.toFixed(4), end: +sel.end.toFixed(4) } : undefined;
      await editSound(sound.id, { op, ...(s && { sel: s }), ...(v !== undefined && { v }) });
      if (!keepSel) setSel(null);
    } finally {
      setBusy(false);
    }
  };

  const ops: [string, string, () => void][] = [
    ['Crop', 'Keep only the selection', () => run('crop', { useSel: true })],
    ['Delete', 'Remove the selection', () => run('delete', { useSel: true })],
    ['Silence', 'Silence the selection', () => run('silence', { useSel: true, keepSel: true })],
    ['Reverse', 'Reverse (selection or all)', () => run('reverse', { useSel: true, keepSel: true })],
    ['Normalize', 'Peak to −1 dBFS', () => run('normalize', { keepSel: true })],
    ['Fade in', 'Fade in over selection (or start)', () => run('fadeIn', { useSel: true, keepSel: true })],
    ['Fade out', 'Fade out over selection (or end)', () => run('fadeOut', { useSel: true, keepSel: true })],
    ['−3 dB', 'Quieter (selection or all)', () => run('gain', { useSel: true, keepSel: true, v: -3 })],
    ['+3 dB', 'Louder (selection or all)', () => run('gain', { useSel: true, keepSel: true, v: 3 })],
    ['Trim', 'Cut silence at both ends', () => run('trim')],
    ['Loop x-fade', 'Cross-fade the end into the start so the sound loops seamlessly', () => run('loopFade')],
  ];

  return (
    <div className="card editor">
      <div className="ed-head">
        <input className="name-in" value={sound.name} onChange={(e) => renameSound(sound.id, e.target.value)} aria-label="Sound name" />
        <button className="icon" title="Download as WAV" onClick={() => downloadBlob(encodeWav(sound.buffer), `${safeFileName(sound.name)}.wav`)}>⬇</button>
        <button className="icon danger" title="Delete sound"
          onClick={() => { if (confirm(`Delete “${sound.name}”?`)) { engine.stopPreview(); deleteSound(sound.id); } }}>✕</button>
      </div>
      {sound.recipe && <SynthSettings sound={sound} />}
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
        <button disabled={busy || rate === 1} onClick={() => run('speed', { v: rate }).then(() => setRate(1))}>
          Apply speed ×{rate.toFixed(2)}
        </button>
      </div>
      <Hint>Drag on the waveform to select. Edits apply to the selection, or the whole sound if nothing is selected.</Hint>
    </div>
  );
}
