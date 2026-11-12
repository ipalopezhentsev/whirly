import { useEffect, useMemo, useRef, useState } from 'react';
import { store, useApp } from './state/store';
import { useFrame } from './state/frame';
import { getSound, newScene, removeSource, toast, updateScene } from './state/actions';
import { audioCtx, ensureRunning } from './audio/context';
import { engine } from './audio/engine';
import { renderScene, songsEnd } from './audio/spatial';
import { downloadBlob, encodeWav, safeFileName } from './audio/wav';
import { encodeMp3Blob, MP3_BITRATES, MP3_DEFAULT_KBPS, mp3SampleRate } from './audio/mp3';
import { fmtTime, wrapDeg } from './audio/util';
import { SoundsPanel } from './components/SoundsPanel';
import { ThreeView } from './components/ThreeView';
import { ShareButton } from './components/ShareButton';
import { SetupsButton } from './components/SetupsButton';
import { Monitor } from './components/Monitor';
import { Inspector } from './components/Inspector';
import { WorldPanel } from './components/WorldPanel';
import { Seg } from './components/controls';

export function App() {
  const ready = useApp((s) => s.ready);
  const tab = useApp((s) => s.rightTab);
  useShortcuts();

  if (!ready) return <div className="loading">Synthesizing sounds…</div>;
  return (
    <>
      <Transport />
      <main className="layout">
        <SoundsPanel />
        <section className="stage">
          <div className="views">
            <ThreeView />
          </div>
          <Monitor />
        </section>
        <aside className="panel right">
          <Seg value={tab} onChange={(rightTab) => store.set({ rightTab })} options={[['source', 'Source'], ['world', 'World']]} />
          {tab === 'source' ? <Inspector /> : <WorldPanel />}
        </aside>
      </main>
      <Toast />
    </>
  );
}

type ExportFormat = 'wav' | 'mp3';
type ExportPrefs = { format: ExportFormat; kbps: number };

/** Export format and MP3 bitrate, remembered in this browser. */
function useExportPrefs() {
  const [prefs, setPrefs] = useState<ExportPrefs>(() => {
    try {
      const p = JSON.parse(localStorage.getItem('whirly.export') ?? '{}');
      return { format: p.format === 'mp3' ? 'mp3' : 'wav', kbps: MP3_BITRATES.includes(p.kbps) ? p.kbps : MP3_DEFAULT_KBPS };
    } catch {
      return { format: 'wav', kbps: MP3_DEFAULT_KBPS };
    }
  });
  const update = (p: Partial<ExportPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    try {
      localStorage.setItem('whirly.export', JSON.stringify(next));
    } catch {
      // Storage blocked: the choice just isn't remembered.
    }
  };
  return [prefs, update] as const;
}

const fmtSize = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`);

function Transport() {
  const playing = useApp((s) => s.playing);
  const masterDb = useApp((s) => s.scene.masterDb);
  const hasSources = useApp((s) => s.scene.sources.length > 0);
  const clock = useRef<HTMLSpanElement>(null);
  const [dur, setDur] = useState(20);
  const [{ format, kbps }, setPrefs] = useExportPrefs();
  // A composed song in the scene sets the shortest export: it must play to its end.
  const scene = useApp((s) => s.scene);
  const sounds = useApp((s) => s.sounds);
  const song = useMemo(() => songsEnd(scene, (id) => sounds.find((s) => s.id === id)), [scene, sounds]);
  const minDur = song ? Math.ceil(song.end * 10) / 10 : 1;
  const maxDur = Math.max(600, minDur);
  useEffect(() => {
    setDur((d) => Math.max(d, minDur));
  }, [minDur]);
  const commitDur = () => {
    if (dur >= minDur) return;
    setDur(minDur);
    toast(`The export can't be shorter than ${minDur} s: “${song!.source.name}” plays until then.`);
  };
  const setupName = useApp((s) => s.setupName);
  /** What the export is doing and how far it got (0 … 1); null when idle. */
  const [busy, setBusy] = useState<{ phase: 'Rendering' | 'Encoding'; f: number } | null>(null);
  const [result, setResult] = useState<{ url: string; blob: Blob; file: string; secs: number; dur: number; tail: number } & ExportPrefs | null>(null);

  useFrame(() => {
    if (clock.current) clock.current.textContent = fmtTime(engine.time());
  });

  const exportMix = async () => {
    if (busy) return;
    setBusy({ phase: 'Rendering', f: 0 });
    store.set({ popover: null });
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    try {
      const t0 = performance.now();
      const { scene } = store.get();
      const rate = format === 'mp3' ? mp3SampleRate(audioCtx().sampleRate) : audioCtx().sampleRate;
      const len = Math.max(dur, minDur);
      setDur(len);
      const buf = await renderScene(scene, getSound, len, rate, { onProgress: (f) => setBusy({ phase: 'Rendering', f }) });
      let blob: Blob;
      if (format === 'mp3') {
        setBusy({ phase: 'Encoding', f: 0 });
        blob = await encodeMp3Blob(buf, kbps, (f) => setBusy({ phase: 'Encoding', f }));
      } else {
        setBusy({ phase: 'Encoding', f: 1 });
        await new Promise((r) => setTimeout(r)); // let the button show it before the (blocking) WAV encode
        blob = encodeWav(buf);
      }
      const file = `${safeFileName(setupName ?? 'whirly-scene')}.${format}`;
      // Save it straight away; the popup keeps a preview and the button to save it again.
      downloadBlob(blob, file);
      toast(`Saved “${file}” to your browser's downloads folder.`);
      setResult({ url: URL.createObjectURL(blob), blob, file, secs: (performance.now() - t0) / 1000, dur: len, tail: buf.duration - len, format, kbps });
    } catch (e) {
      toast(`Render failed: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const startNew = () => {
    if (hasSources && !confirm('Start a new, empty scene?\n\nAll sources are removed, and the room, listener and settings go back to defaults. '
      + 'Sounds stay in the library. Save the scene first (💾 Setups) if you want to keep it.')) return;
    engine.stop();
    newScene();
    toast('New scene. Place sounds from the library to fill it.');
  };

  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle cx="12" cy="12" r="3" fill="currentColor" />
          <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".6" />
          <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".3" />
          <circle cx="19" cy="7" r="1.8" fill="#f6ad55" />
        </svg>
        <span>Whirly</span>
        <small>spatial sound lab</small>
      </div>
      <div className="transport">
        <button className={`primary play ${playing ? 'on' : ''}`} onClick={() => (playing ? engine.stop() : engine.play())} title="Play / stop the scene (Space)">
          {playing ? '■ Stop' : '▶ Play scene'}
        </button>
        <span ref={clock} className="clock mono">0:00.0</span>
        <label className="inline" title="Master volume">
          <span>Master</span>
          <input type="range" min={-40} max={6} step={0.5} value={masterDb}
            onChange={(e) => updateScene(() => ({ masterDb: +e.target.value }))} />
          <span className="mono">{masterDb > 0 ? '+' : ''}{masterDb.toFixed(1)} dB</span>
        </label>
        <span className="sep" />
        <label className="inline"
          title={`How long the sources play in the export; then they stop and the reverb rings out.${
            song ? ` At least ${minDur} s, so “${song.source.name}” plays to its end (songs play once in an export).` : ''}`}>
          <span>Export</span>
          <input className="num" type="number" min={minDur} max={maxDur} step="any" value={dur}
            onChange={(e) => setDur(Math.max(1, Math.min(maxDur, +e.target.value || 1)))}
            onBlur={commitDur} onKeyDown={(e) => e.key === 'Enter' && commitDur()} />
          <span>s</span>
        </label>
        <select value={format} onChange={(e) => setPrefs({ format: e.target.value as ExportFormat })} aria-label="Export format"
          title="WAV: lossless 16-bit. MP3: far smaller, lossy.">
          <option value="wav">WAV</option>
          <option value="mp3">MP3</option>
        </select>
        {format === 'mp3' && (
          <select value={kbps} onChange={(e) => setPrefs({ kbps: +e.target.value })} aria-label="MP3 bitrate" title="MP3 bitrate (constant)">
            {MP3_BITRATES.map((b) => <option key={b} value={b}>{b} kbps</option>)}
          </select>
        )}
        <button className={`export-btn ${busy ? 'busy' : ''}`} onClick={exportMix} aria-disabled={!!busy}
          style={busy ? ({ '--p': `${busy.f * 100}%` } as React.CSSProperties) : undefined}
          title="Render the scene and save it as a file (to your browser's downloads)">
          {busy ? `${busy.phase} ${Math.floor(busy.f * 100)}%` : `⬇ Export ${format.toUpperCase()}`}
        </button>
        <span className="sep" />
        <button onClick={startNew} title="Clear the scene and start afresh (the library keeps its sounds)">✚ New scene</button>
        <SetupsButton />
        <ShareButton />
      </div>
      <div className="phones" title="HRTF spatialization only works properly on headphones">🎧 Use headphones</div>
      {result && (
        <div className="render-pop" role="dialog" aria-label="Rendered mix">
          <div className="rp-head">
            <strong>Rendered {result.dur}s stereo mix{result.tail >= 0.05 ? ` + ${result.tail.toFixed(1)}s ring-out` : ''}</strong>
            <span className="muted">
              {result.format === 'mp3' ? `MP3 ${result.kbps} kbps` : 'WAV'} · {fmtSize(result.blob.size)} · in {result.secs.toFixed(1)} s
            </span>
            <button className="icon" onClick={() => { URL.revokeObjectURL(result.url); setResult(null); }} aria-label="Close">✕</button>
          </div>
          <audio controls src={result.url} />
          <p className="hint">Saved as <strong>{result.file}</strong> in your browser's downloads folder.</p>
          <button className="wide" onClick={() => downloadBlob(result.blob, result.file)}>⬇ Save again</button>
        </div>
      )}
    </header>
  );
}

function Toast() {
  const t = useApp((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!t) return;
    setVisible(true);
    const h = setTimeout(() => setVisible(false), 3500);
    return () => clearTimeout(h);
  }, [t]);
  return <div className={`toast ${visible ? 'show' : ''} ${t?.kind ?? ''}`} role="status">{t?.msg}</div>;
}

function useShortcuts() {
  useEffect(() => {
    // The first gesture anywhere unlocks audio, so meters and previews just work.
    const unlock = () => ensureRunning();
    window.addEventListener('pointerdown', unlock, { once: true });

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, select, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const st = store.get();
      if (e.code === 'Space') {
        e.preventDefault();
        if (st.playing) engine.stop();
        else engine.play();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && st.selectedSourceId) {
        removeSource(st.selectedSourceId);
      } else if (e.key === 'q' || e.key === 'e') {
        const d = e.key === 'q' ? -15 : 15;
        updateScene((s) => ({ listener: { ...s.listener, yaw: wrapDeg(s.listener.yaw + d) } }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', unlock);
    };
  }, []);
}
