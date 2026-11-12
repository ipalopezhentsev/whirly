import { useEffect, useRef } from 'react';
import { useFrame } from '../state/frame';
import { engine } from '../audio/engine';
import { gainToDb } from '../audio/util';

function useCanvasSize(ref: React.RefObject<HTMLCanvasElement | null>) {
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  useEffect(() => {
    const c = ref.current!;
    const ro = new ResizeObserver(() => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      size.current = { w: r.width, h: r.height, dpr };
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const FMIN = 20;
const FMAX = 20000;
const DB_LO = -100;
const DB_HI = -10;

/** Output spectrum (log frequency) and stereo level meters. */
export function Monitor() {
  const specRef = useRef<HTMLCanvasElement>(null);
  const meterRef = useRef<HTMLCanvasElement>(null);
  const specSize = useCanvasSize(specRef);
  const meterSize = useCanvasSize(meterRef);
  const bins = useRef<Float32Array<ArrayBuffer> | null>(null);
  const td = useRef(new Float32Array(2048));
  const peaks = useRef([{ v: -90, t: 0 }, { v: -90, t: 0 }]);

  useFrame((ts) => {
    // Spectrum
    const sc = specRef.current;
    const { w, h, dpr } = specSize.current;
    if (sc && w) {
      const g = sc.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.font = '10px ui-monospace, monospace';
      g.fillStyle = 'rgba(148,163,184,0.5)';
      g.strokeStyle = 'rgba(148,163,184,0.1)';
      const fx = (f: number) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * w;
      for (const [f, l] of [[100, '100'], [1000, '1k'], [10000, '10k']] as const) {
        g.beginPath();
        g.moveTo(fx(f), 0);
        g.lineTo(fx(f), h);
        g.stroke();
        g.fillText(l, fx(f) + 3, h - 4);
      }
      const an = engine.spectrum;
      if (an) {
        if (!bins.current || bins.current.length !== an.frequencyBinCount) bins.current = new Float32Array(an.frequencyBinCount);
        an.getFloatFrequencyData(bins.current);
        const ny = engine.ctx.sampleRate / 2;
        const n = bins.current.length;
        g.beginPath();
        g.moveTo(0, h);
        for (let x = 0; x <= w; x += 2) {
          const f = FMIN * Math.pow(FMAX / FMIN, x / w);
          const db = bins.current[Math.min(n - 1, Math.round((f / ny) * n))];
          const y = h - ((Math.max(DB_LO, Math.min(DB_HI, db)) - DB_LO) / (DB_HI - DB_LO)) * h;
          g.lineTo(x, y);
        }
        g.lineTo(w, h);
        g.closePath();
        const grad = g.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(167,139,250,0.75)');
        grad.addColorStop(1, 'rgba(79,209,197,0.15)');
        g.fillStyle = grad;
        g.fill();
      }
    }

    // Meters
    const mc = meterRef.current;
    const m = meterSize.current;
    if (mc && m.w) {
      const g = mc.getContext('2d')!;
      g.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
      g.clearRect(0, 0, m.w, m.h);
      const toY = (db: number) => m.h - 14 - ((Math.max(-60, Math.min(0, db)) + 60) / 60) * (m.h - 20);
      g.font = '9px ui-monospace, monospace';
      g.fillStyle = 'rgba(148,163,184,0.55)';
      for (const db of [0, -12, -24, -48]) g.fillText(String(db), 0, toY(db) + 3);
      [engine.meterL, engine.meterR].forEach((an, i) => {
        const x = 26 + i * 20;
        g.fillStyle = 'rgba(148,163,184,0.12)';
        g.fillRect(x, toY(0), 14, toY(-60) - toY(0));
        if (!an) return;
        an.getFloatTimeDomainData(td.current);
        let sum = 0;
        let pk = 0;
        for (let k = 0; k < td.current.length; k++) {
          const v = td.current[k];
          sum += v * v;
          pk = Math.max(pk, Math.abs(v));
        }
        const rms = gainToDb(Math.sqrt(sum / td.current.length));
        const p = peaks.current[i];
        const pdb = gainToDb(pk);
        if (pdb > p.v || ts - p.t > 1200) { p.v = pdb; p.t = ts; }
        const grad = g.createLinearGradient(0, toY(0), 0, toY(-60));
        grad.addColorStop(0, '#fc8181');
        grad.addColorStop(0.15, '#f6e05e');
        grad.addColorStop(0.4, '#4fd1c5');
        grad.addColorStop(1, '#2c7a7b');
        g.fillStyle = grad;
        g.fillRect(x, toY(rms), 14, toY(-60) - toY(rms));
        g.fillStyle = p.v > -0.5 ? '#fc8181' : '#e2e8f0';
        g.fillRect(x, toY(p.v) - 1, 14, 2);
        g.fillStyle = 'rgba(148,163,184,0.7)';
        g.fillText(i ? 'R' : 'L', x + 4, m.h - 3);
      });
    }
  });

  return (
    <div className="monitor">
      <canvas ref={specRef} className="spectrum" aria-label="Output spectrum" />
      <canvas ref={meterRef} className="meters" aria-label="Output level meters" />
    </div>
  );
}
