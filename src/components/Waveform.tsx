import { useEffect, useRef } from 'react';
import { useFrame } from '../state/frame';
import { engine } from '../audio/engine';
import type { Selection } from '../scene/types';

interface Props {
  soundId: string;
  buffer: AudioBuffer;
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
}

/** Waveform with drag-to-select and a preview playhead. */
export function Waveform({ soundId, buffer, selection, onSelect }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const peaks = useRef<{ buf: AudioBuffer; w: number; min: Float32Array; max: Float32Array } | null>(null);
  const dragFrom = useRef<number | null>(null);
  const live = useRef<Selection | null>(selection);
  const dirty = useRef(true);
  const hadPlayhead = useRef(false);

  useEffect(() => {
    live.current = selection;
    dirty.current = true;
  }, [selection, buffer]);

  useEffect(() => {
    const c = ref.current!;
    const ro = new ResizeObserver(() => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      size.current = { w: r.width, h: r.height, dpr };
      dirty.current = true;
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  const xToTime = (x: number) => Math.max(0, Math.min(buffer.duration, (x / size.current.w) * buffer.duration));
  const localX = (e: React.PointerEvent) => e.clientX - ref.current!.getBoundingClientRect().left;

  useFrame(() => {
    const c = ref.current;
    const { w, h, dpr } = size.current;
    if (!c || !w) return;
    const ph = engine.previewTime(soundId);
    if (!dirty.current && ph === null && !hadPlayhead.current) return;
    hadPlayhead.current = ph !== null;
    dirty.current = false;

    const cols = Math.max(1, Math.floor(w));
    if (!peaks.current || peaks.current.buf !== buffer || peaks.current.w !== cols) {
      const d = buffer.getChannelData(0);
      const min = new Float32Array(cols);
      const max = new Float32Array(cols);
      const per = d.length / cols;
      for (let i = 0; i < cols; i++) {
        const s = Math.floor(i * per);
        const e = Math.max(s + 1, Math.floor((i + 1) * per));
        let lo = 1;
        let hi = -1;
        for (let j = s; j < e && j < d.length; j++) {
          if (d[j] < lo) lo = d[j];
          if (d[j] > hi) hi = d[j];
        }
        min[i] = lo;
        max[i] = hi;
      }
      peaks.current = { buf: buffer, w: cols, min, max };
    }

    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0b0e14';
    g.fillRect(0, 0, w, h);
    const sel = live.current;
    if (sel) {
      const a = (sel.start / buffer.duration) * w;
      const b = (sel.end / buffer.duration) * w;
      g.fillStyle = 'rgba(167,139,250,0.22)';
      g.fillRect(a, 0, b - a, h);
    }
    g.strokeStyle = 'rgba(148,163,184,0.15)';
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();
    g.fillStyle = '#4fd1c5';
    const { min, max } = peaks.current;
    for (let i = 0; i < cols; i++) {
      const y1 = h / 2 - max[i] * (h / 2 - 2);
      const y2 = h / 2 - min[i] * (h / 2 - 2);
      g.fillRect(i, y1, 1, Math.max(1, y2 - y1));
    }
    if (ph !== null) {
      const x = (ph / buffer.duration) * w;
      g.fillStyle = '#f8fafc';
      g.fillRect(x, 0, 1.5, h);
    }
  });

  return (
    <canvas
      ref={ref}
      className="wave"
      onPointerDown={(e) => {
        dragFrom.current = xToTime(localX(e));
        live.current = null;
        dirty.current = true;
        ref.current!.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragFrom.current === null) return;
        const t = xToTime(localX(e));
        live.current = { start: Math.min(t, dragFrom.current), end: Math.max(t, dragFrom.current) };
        dirty.current = true;
      }}
      onPointerUp={() => {
        if (dragFrom.current === null) return;
        dragFrom.current = null;
        const sel = live.current;
        onSelect(sel && sel.end - sel.start > 0.005 ? sel : null);
      }}
    />
  );
}
