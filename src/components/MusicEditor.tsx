// Algorithmic music: the "Compose" creator tab, and a piece's settings in its sound editor.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { useFrame } from '../state/frame';
import { toast } from '../state/actions';
import { composeBand, composeMix, pieceSettings, pieceSounds, rerenderPiece, splitIntoStems } from '../state/music';
import { engine } from '../audio/engine';
import { newSeed } from '../audio/synth';
import { ALGOS, DRUM_STYLES, FORMS, makePlan, RHYTHMS, STEPS, trackLevel } from '../audio/music/compose';
import { INSTRUMENTS, instrumentTimbre } from '../audio/music/instruments';
import { KITS } from '../audio/music/drums';
import { applyMood, fitLength, MOODS, newTrack, ROLES, STYLES, styleParams, surprise } from '../audio/music/presets';
import { mulberry } from '../audio/music/rng';
import { chordName, NOTE_NAMES, PROGRESSIONS, SCALES } from '../audio/music/theory';
import { barSeconds, MAX_SECONDS, musicDuration, type MusicParams, type Role, type TrackParams } from '../audio/music/types';
import { fmtTime } from '../audio/util';
import { Check, Hint, Select, Seg, Slider } from './controls';
import type { Sound } from '../scene/types';

const STYLE_OPTIONS = Object.entries(STYLES).map(([k, s]) => [k, s.label] as const);
const MOOD_OPTIONS = Object.entries(MOODS).map(([k, m]) => [k, m.label] as const);

// ---------------------------------------------------------------- create

export function ComposeCreator() {
  const [style, setStyle] = useState('lofi');
  const [mood, setMood] = useState('');
  const [busy, setBusy] = useState<'' | 'mix' | 'band'>('');

  const run = async (kind: 'mix' | 'band', p: MusicParams = styleParams(style, mood || undefined)) => {
    setBusy(kind);
    try {
      if (kind === 'mix') await composeMix(p, newSeed());
      else {
        const sources = await composeBand(p, newSeed());
        toast(`Placed ${sources.length} instruments around you. Press ▶ Play scene.`);
      }
    } catch (e) {
      toast(`Could not compose: ${(e as Error).message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="pane">
      <Select label="Style" value={style} onChange={setStyle} options={STYLE_OPTIONS} />
      <Select label="Mood" value={mood} onChange={setMood} options={[['', '— the style’s own —'], ...MOOD_OPTIONS]} />
      <div className="gen-btns">
        <button className="primary" onClick={() => run('mix')} disabled={!!busy} title="One sound with the whole piece">
          {busy === 'mix' ? 'Composing…' : '♫ Compose'}
        </button>
        <button onClick={() => run('band')} disabled={!!busy}
          title="One sound per instrument, each placed in the scene as its own source around you">
          {busy === 'band' ? 'Composing…' : '♫ As a band in the scene'}
        </button>
      </div>
      <button className="small" disabled={!!busy} onClick={() => run('mix', surprise(mulberry(newSeed())))}>🎲 Surprise me (random style, mood, key)</button>
      <Hint>Instruments, timbres, note algorithms, harmony, form and dynamics are all edited on the sound itself, below.</Hint>
    </div>
  );
}

// ---------------------------------------------------------------- piece settings

const strip = (m: MusicParams) => pieceSettings(m);

/** A composition's settings: edit, then Apply to re-render it (and all its stems) in place. */
export function MusicSettings({ sound }: { sound: Sound }) {
  const r = sound.recipe!;
  const m = r.music!;
  const recipeKey = JSON.stringify({ ...r, edits: [] });
  const [d, setD] = useState<MusicParams>(() => strip(m));
  useEffect(() => setD(strip(m)), [recipeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const sounds = useApp((s) => s.sounds);
  const siblings = useMemo(() => pieceSounds(sound, sounds), [sound, sounds]);
  // The mix and its stems run in sync, so any of them playing moves the playhead.
  const soundIds = useMemo(() => new Set(siblings.map((s) => s.id)), [siblings]);
  const stemTrack = m.stem ? m.tracks.find((t) => t.id === m.stem) : undefined;
  const stemCount = siblings.filter((s) => s.recipe?.music?.stem).length;
  const changed = JSON.stringify(d) !== JSON.stringify(strip(m));

  const apply = async (seed = r.seed) => {
    setBusy(true);
    try {
      engine.stopPreview();
      const self = await rerenderPiece(sound, fitLength(d), seed);
      engine.previewSound(self, null);
    } catch (e) {
      toast(`Could not compose: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const split = async () => {
    setBusy(true);
    try {
      engine.stopPreview();
      const n = await splitIntoStems(sound);
      toast(`Placed ${n} stems around you${sound.name ? `; scene sources playing “${sound.name}” were muted` : ''}.`);
    } catch (e) {
      toast(`Could not split: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<MusicParams>) => setD((x) => fitLength({ ...x, ...patch }));
  const setTrack = (id: string, patch: Partial<TrackParams>) =>
    setD((x) => ({ ...x, tracks: x.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  const maxBars = Math.max(2, Math.floor(MAX_SECONDS / barSeconds(d)));
  const plan = useMemo(() => makePlan(d, r.seed), [d, r.seed]);
  const chordLine = (['A', 'B', 'C'] as const)
    .filter((l, i, all) => i === 0 || JSON.stringify(plan.chords[l]) !== JSON.stringify(plan.chords[all[0]]))
    .map((l) => plan.chords[l].map((c) => chordName(c, d.key)).join(' '))
    .join('  |  ');

  return (
    <div className="synth-settings music">
      {stemTrack && (
        <Hint>
          Stem “{stemTrack.name}” of a {m.tracks.filter((t) => t.on).length}-part piece. Applying re-renders all
          {' '}{siblings.length} sounds of the piece together, so they stay in time.
        </Hint>
      )}
      <Select label="Style" value={STYLES[d.style] ? d.style : ''} options={[...(STYLES[d.style] ? [] : [['', '— custom —'] as const]), ...STYLE_OPTIONS]}
        onChange={(k) => k && setD(styleParams(k))} />
      <Select label="Mood" value={MOODS[d.mood] ? d.mood : ''} options={[...(MOODS[d.mood] ? [] : [['', '— custom —'] as const]), ...MOOD_OPTIONS]}
        onChange={(k) => k && setD((x) => fitLength(applyMood(x, k)))} />
      <div className="music-sum mono">
        {NOTE_NAMES[d.key]} {SCALES[d.scale]?.label.replace(/ \(.*\)$/, '').toLowerCase()} · {Math.round(d.tempo)} bpm · {d.meter}/4 ·
        {' '}{d.bars} bars ({fmtTime(musicDuration(d)).replace(/\.\d$/, '')})
        <div className="chords">{chordLine}</div>
      </div>
      <ArrangementMap p={d} seed={r.seed} plan={plan} live={changed ? null : { soundIds, barSec: barSeconds(m) }} />

      <div className="gen-btns">
        <button className="primary" onClick={() => apply()} disabled={busy || !changed}
          title="Re-render with these settings (undoable); scene sources using it follow">
          {busy ? 'Rendering…' : changed ? '↻ Apply' : 'Up to date'}
        </button>
        <button onClick={() => apply(newSeed())} disabled={busy} title="Same settings, new random choices: a different piece in the same style">🎲 Variation</button>
      </div>
      {!m.stem && (
        <button onClick={split} disabled={busy || changed}
          title={changed ? 'Apply your changes first' : 'One sound per instrument, each placed in the scene around you, all in sync'}>
          ⑂ Split into stems → scene{stemCount ? ` (has ${stemCount})` : ''}
        </button>
      )}

      <details>
        <summary>Key, scale & tempo</summary>
        <Select label="Key" value={String(d.key)} options={NOTE_NAMES.map((n, i) => [String(i), n] as const)} onChange={(v) => set({ key: +v, mood: '' })} />
        <Select label="Scale" value={d.scale} options={Object.entries(SCALES).map(([k, s]) => [k, s.label] as const)} onChange={(scale) => set({ scale, mood: '' })} />
        <Slider label="Tempo" value={d.tempo} min={40} max={200} step={1} unit="bpm" onChange={(tempo) => set({ tempo, mood: '' })} />
        <Select label="Meter" value={String(d.meter)} options={[2, 3, 4, 5, 6, 7].map((n) => [String(n), `${n}/4`] as const)} onChange={(v) => set({ meter: +v })} />
        <Slider label="Swing" value={d.swing} min={0} max={0.5} step={0.01} onChange={(swing) => set({ swing, mood: '' })}
          title="Delays every other grid step: 0.33 ≈ triplet shuffle" />
        <Slider label="Humanize" value={d.humanize} min={0} max={1} step={0.01} onChange={(humanize) => set({ humanize })}
          title="Random timing and loudness deviations, like a human player" />
      </details>

      <details>
        <summary>Harmony</summary>
        <Select label="Chords" value={PROGRESSIONS[d.progression] ? d.progression : 'pop'}
          options={Object.entries(PROGRESSIONS).map(([k, p]) => [k, p.label] as const)} onChange={(progression) => set({ progression, mood: '' })} />
        <Select label="Chord every" value={String(d.chordBars)} options={[['0.5', '½ bar'], ['1', 'bar'], ['2', '2 bars'], ['4', '4 bars']]}
          onChange={(v) => set({ chordBars: +v })} />
        <div className="ctl field"><span className="lbl">Chord size</span>
          <Seg value={String(d.chordSize)} options={[['3', 'Triads'], ['4', '7ths'], ['5', '9ths']]} onChange={(v) => set({ chordSize: +v, mood: '' })} />
        </div>
        <Slider label="Consonance" value={d.consonance} min={0} max={1} step={0.01} onChange={(consonance) => set({ consonance })}
          title="How strongly melodies land on chord tones (on the beat and at phrase ends)" />
        <Hint>Numbered progressions are built from the scale, so they follow it; Roman ones (♭VI, V7…) are fixed chords.</Hint>
      </details>

      <details>
        <summary>Form & dynamics</summary>
        <Select label="Form" value={d.form} options={Object.entries(FORMS)} onChange={(form) => set({ form })} />
        <Select label="Sections of" value={String(d.sectionBars)} options={[2, 4, 8, 12, 16].map((n) => [String(n), `${n} bars`] as const)}
          onChange={(v) => set({ sectionBars: +v })} />
        <Slider label="Length" value={d.bars} min={2} max={maxBars} step={1} unit="bars" onChange={(bars) => set({ bars: Math.round(bars) })} />
        <Slider label="Energy" value={d.energy} min={0} max={1} step={0.01} onChange={(energy) => set({ energy })}
          title="Raises or lowers every section's level: more parts and drums, louder, denser" />
        <Slider label="Variation" value={d.variation} min={0} max={1} step={0.01} onChange={(variation) => set({ variation })}
          title="How much repeats change, and how often parts sit a section out" />
        <Hint>Each section has an energy level. A part plays where the energy reaches its “Enters at”; drums add kick, hats, snare, open hats and percussion as it rises, fill at phrase ends, roll into louder sections and crash on arrival.</Hint>
      </details>

      <div className="tracks-head">
        <span>Parts · {d.tracks.length}</span>
        <AddTrack onAdd={(role) => setD((x) => ({ ...x, tracks: [...x.tracks, newTrack(x, role)] }))} />
      </div>
      {d.tracks.map((tr) => (
        <TrackCard key={tr.id} tr={tr} onChange={(patch) => setTrack(tr.id, patch)}
          onRemove={() => setD((x) => ({ ...x, tracks: x.tracks.filter((t) => t.id !== tr.id) }))} />
      ))}
      {changed && <Hint>Press ↻ Apply to hear your changes.</Hint>}
      {changed && r.edits.length > 0 && (
        <Hint>Applying drops the {r.edits.length} edit{r.edits.length > 1 ? 's' : ''} made to this sound (Undo brings them back).</Hint>
      )}
    </div>
  );
}

function AddTrack({ onAdd }: { onAdd: (role: Role) => void }) {
  return (
    <select className="add-track" value="" onChange={(e) => e.target.value && onAdd(e.target.value as Role)} aria-label="Add a part">
      <option value="">＋ Add part…</option>
      {Object.entries(ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- arrangement

/** At most this many playheads are drawn (one per scene source playing the piece, plus the preview). */
const MAX_HEADS = 4;

/**
 * Sections across, parts down: where each part plays and how strongly; energy on top.
 * With `live` (the settings shown are the ones rendered), a line marks where the piece is playing.
 */
function ArrangementMap({ p, seed, plan, live }: {
  p: MusicParams; seed: number; plan: ReturnType<typeof makePlan>; live: { soundIds: ReadonlySet<string>; barSec: number } | null;
}) {
  const cols = plan.sections.map((s) => `${s.bars}fr`).join(' ');
  const names: Record<string, string> = { intro: 'In', outro: 'Out' };
  const root = useRef<HTMLDivElement>(null);
  const energy = useRef<HTMLDivElement>(null);
  const heads = useRef<(HTMLDivElement | null)[]>([]);

  useFrame(() => {
    // Stems of one piece play in step: show a single line for plays within 50 ms of each other.
    const times = (live ? engine.playheads(live.soundIds) : []).sort((a, b) => a - b).filter((t, i, all) => !i || t - all[i - 1] > 0.05);
    const box = root.current?.getBoundingClientRect();
    heads.current.forEach((h, i) => {
      if (!h) return;
      const t = times[i];
      const bar = live && t !== undefined ? t / live.barSec : -1;
      // Position within the section's column (columns are separated by gaps, so not quite linear overall).
      const k = plan.sections.findIndex((s) => bar < s.start + s.bars);
      const cell = energy.current?.children[k] as HTMLElement | undefined;
      if (bar < 0 || !box || !cell) {
        h.style.display = 'none';
        return;
      }
      const s = plan.sections[k];
      const r = cell.getBoundingClientRect();
      h.style.display = '';
      h.style.transform = `translateX(${r.left - box.left + ((bar - s.start) / s.bars) * r.width}px)`;
    });
  });

  return (
    <div className="arr" ref={root} title="Arrangement: sections across, parts down. Brighter = plays more (denser, louder, more drum voices).">
      {Array.from({ length: MAX_HEADS }, (_, i) => (
        <div key={i} className="arr-head" ref={(el) => { heads.current[i] = el; }} style={{ display: 'none' }} />
      ))}
      <div className="arr-row">
        <span className="arr-name">Energy</span>
        <div className="arr-cells" ref={energy} style={{ gridTemplateColumns: cols }}>
          {plan.sections.map((s) => (
            <div key={s.index} className="arr-energy" title={`${s.label}: energy ${s.energy.toFixed(2)}${s.rise ? ', builds up' : ''}`}>
              <i style={{ height: `${Math.round(s.energy * 100)}%` }} />
              <b>{names[s.label] ?? s.label}{s.rise ? '↗' : ''}</b>
            </div>
          ))}
        </div>
      </div>
      {p.tracks.map((tr) => (
        <div className="arr-row" key={tr.id}>
          <span className={`arr-name ${tr.on ? '' : 'off'}`}>{tr.name}</span>
          <div className="arr-cells" style={{ gridTemplateColumns: cols }}>
            {plan.sections.map((s) => {
              const lv = trackLevel(p, s, tr, seed);
              return <div key={s.index} className="arr-cell" style={{ opacity: lv ? 0.25 + 0.75 * lv : 1, background: lv ? undefined : 'transparent' }} />;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- one part

const INSTRUMENT_OPTIONS = Object.entries(INSTRUMENTS).map(([k, i]) => [k, `${i.group}: ${i.label}`] as const);
const KIT_OPTIONS = Object.entries(KITS).map(([k, kit]) => [k, kit.label] as const);

function TrackCard({ tr, onChange, onRemove }: { tr: TrackParams; onChange: (p: Partial<TrackParams>) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const drums = tr.role === 'drums';
  const instLabel = drums ? `${KITS[tr.instrument]?.label ?? tr.instrument} kit` : INSTRUMENTS[tr.instrument]?.label ?? tr.instrument;
  return (
    <div className={`track ${open ? 'open' : ''} ${tr.on ? '' : 'off'}`}>
      <div className="track-head">
        <Check label="" checked={tr.on} onChange={(on) => onChange({ on })} title="Play this part" />
        <button className="caret-btn" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Edit this part'}>{open ? '▾' : '▸'}</button>
        <div className="track-title" onClick={() => setOpen(!open)}>
          <span className="nm">{tr.name}</span>
          <span className="meta">{instLabel}</span>
        </div>
        <button className="icon" title="New notes for this part only" onClick={() => onChange({ salt: tr.salt + 1 })}>🎲</button>
        <button className="icon danger" title="Remove this part" onClick={onRemove}>✕</button>
      </div>
      {open && (
        <div className="track-body">
          <div className="ctl field"><span className="lbl">Name</span>
            <input type="text" value={tr.name} onChange={(e) => onChange({ name: e.target.value })} />
          </div>
          {drums ? (
            <>
              <Select label="Kit" value={tr.instrument} options={KIT_OPTIONS} onChange={(instrument) => onChange({ instrument })} />
              <Select label="Pattern" value={tr.style} options={Object.entries(DRUM_STYLES) as [TrackParams['style'], string][]} onChange={(style) => onChange({ style })} />
              <Slider label="Density" value={tr.density} min={0} max={1} step={0.01} onChange={(density) => onChange({ density })}
                title="Ghost notes, extra hats, hat rolls" />
              <Slider label="Fills" value={tr.fills} min={0} max={1} step={0.01} onChange={(fills) => onChange({ fills })}
                title="How often phrase and section ends get a snare / tom fill" />
              <Slider label="Brightness" value={tr.bright} min={0} max={1} step={0.01} onChange={(bright) => onChange({ bright })} />
              <Slider label="Drive" value={tr.drive} min={0} max={1} step={0.01} onChange={(drive) => onChange({ drive })} />
              <Slider label="Echo" value={tr.echo} min={0} max={1} step={0.01} onChange={(echo) => onChange({ echo })} />
            </>
          ) : (
            <>
              <Select label="Instrument" value={tr.instrument} options={INSTRUMENT_OPTIONS}
                onChange={(instrument) => onChange({ instrument, ...instrumentTimbre(instrument) })} />
              <h5>Notes</h5>
              <Select label="Algorithm" value={tr.algo} options={Object.entries(ALGOS) as [TrackParams['algo'], string][]} onChange={(algo) => onChange({ algo })} />
              <Select label="Rhythm" value={tr.rhythm} options={Object.entries(RHYTHMS) as [TrackParams['rhythm'], string][]} onChange={(rhythm) => onChange({ rhythm })} />
              <Select label="Grid" value={String(tr.step)} options={STEPS} onChange={(v) => onChange({ step: +v })} />
              <Slider label="Density" value={tr.density} min={0} max={1} step={0.01} onChange={(density) => onChange({ density })}
                title="How many grid steps get a note (random, syncopated, Euclidean and phrased rhythms)" />
              <Slider label="Octave" value={tr.octave} min={1} max={7} step={1} onChange={(octave) => onChange({ octave })} title="4 = middle C" />
              <Slider label="Range" value={tr.range} min={3} max={36} step={1} unit="st" onChange={(range) => onChange({ range })} />
              <Slider label="Voices" value={tr.voices} min={1} max={6} step={1} onChange={(voices) => onChange({ voices })}
                title="Chords: notes per chord. Arpeggios: chord tones cycled. Melodies: parallel harmony below" />
              <Slider label="Legato" value={tr.legato} min={0.1} max={1.5} step={0.01} unit="×" onChange={(legato) => onChange({ legato })}
                title="Note length relative to the gap until the next note" />
              <h5>Sound</h5>
              <Slider label="Brightness" value={tr.bright} min={0} max={1} step={0.01} onChange={(bright) => onChange({ bright })} />
              <Slider label="Attack" value={tr.attack} min={0} max={3} step={0.001} unit="s" onChange={(attack) => onChange({ attack })} />
              <Slider label="Release" value={tr.release} min={0.02} max={8} step={0.01} unit="s" onChange={(release) => onChange({ release })}
                title="Fade after the note for held sounds; how long it rings for struck and plucked ones" />
              <Slider label="Detune" value={tr.detune} min={0} max={50} step={0.5} unit="ct" onChange={(detune) => onChange({ detune })}
                title="Spread of the unison voices (synth instruments)" />
              <Slider label="Drive" value={tr.drive} min={0} max={1} step={0.01} onChange={(drive) => onChange({ drive })} />
              <Slider label="Vibrato" value={tr.vibrato} min={0} max={1} step={0.01} onChange={(vibrato) => onChange({ vibrato })} />
              <Slider label="Echo" value={tr.echo} min={0} max={1} step={0.01} onChange={(echo) => onChange({ echo })} title="Tempo-synced (dotted eighth)" />
            </>
          )}
          <h5>Mix & arrangement</h5>
          <Slider label="Volume" value={tr.gainDb} min={-30} max={12} step={0.5} unit="dB" onChange={(gainDb) => onChange({ gainDb })} />
          <Slider label="Enters at" value={tr.enter} min={0} max={1} step={0.01} onChange={(enter) => onChange({ enter })}
            title="Plays in sections with at least this energy: 0 = always, higher = only at the peaks" />
        </div>
      )}
    </div>
  );
}
