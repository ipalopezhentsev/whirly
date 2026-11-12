import { useEffect, useRef, useState } from 'react';
import { store, useApp } from './state/store';
import { useFrame } from './state/frame';
import { getSound, removeSource, toast, updateScene } from './state/actions';
import { audioCtx, ensureRunning } from './audio/context';
import { engine } from './audio/engine';
import { renderScene } from './audio/spatial';
import { downloadBlob, encodeWav } from './audio/wav';
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

function Transport() {
  const playing = useApp((s) => s.playing);
  const masterDb = useApp((s) => s.scene.masterDb);
  const clock = useRef<HTMLSpanElement>(null);
  const [dur, setDur] = useState(20);
  const [rendering, setRendering] = useState(false);
  const [result, setResult] = useState<{ url: string; blob: Blob; secs: number } | null>(null);

  useFrame(() => {
    if (clock.current) clock.current.textContent = fmtTime(engine.time());
  });

  const exportWav = async () => {
    setRendering(true);
    try {
      const t0 = performance.now();
      const { scene } = store.get();
      const buf = await renderScene(scene, (id) => getSound(id)?.buffer, dur, audioCtx().sampleRate);
      const blob = encodeWav(buf);
      if (result) URL.revokeObjectURL(result.url);
      setResult({ url: URL.createObjectURL(blob), blob, secs: (performance.now() - t0) / 1000 });
    } catch (e) {
      toast(`Render failed: ${(e as Error).message}`, 'error');
    } finally {
      setRendering(false);
    }
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
        <label className="inline" title="Length of the exported mix">
          <span>Export</span>
          <input className="num" type="number" min={1} max={600} value={dur} onChange={(e) => setDur(Math.max(1, Math.min(600, +e.target.value || 1)))} />
          <span>s</span>
        </label>
        <button onClick={exportWav} disabled={rendering}>{rendering ? 'Rendering…' : '⬇ Render WAV'}</button>
        <span className="sep" />
        <SetupsButton />
        <ShareButton />
      </div>
      <div className="phones" title="HRTF spatialization only works properly on headphones">🎧 Use headphones</div>
      {result && (
        <div className="render-pop" role="dialog" aria-label="Rendered mix">
          <div className="rp-head">
            <strong>Rendered {dur}s stereo mix</strong>
            <span className="muted">in {result.secs.toFixed(1)} s</span>
            <button className="icon" onClick={() => { URL.revokeObjectURL(result.url); setResult(null); }} aria-label="Close">✕</button>
          </div>
          <audio controls src={result.url} />
          <button className="primary wide" onClick={() => downloadBlob(result.blob, 'whirly-scene.wav')}>⬇ Download WAV</button>
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
