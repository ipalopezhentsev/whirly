import { useEffect, useRef } from 'react';
import { store, useApp } from '../state/store';
import { useFrame } from '../state/frame';
import { addSource, selectSource, setSourcePos, toast, updateScene } from '../state/actions';
import { engine } from '../audio/engine';
import { anySolo, computeState, listenerYaw } from '../audio/spatial';
import { motionGain, motionPeriod, pathStart, positionAt } from '../scene/motion';
import { clamp, DEG, fmtDist, TAU, wrapDeg } from '../audio/util';
import type { Vec3 } from '../scene/types';

type Drag =
  | { mode: 'rotate' }
  | { mode: 'move'; id: string; ox: number; oz: number }
  | { mode: 'height'; id: string; y0: number; h0: number };

const NICE = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
const niceStep = (x: number) => NICE.find((n) => n >= x) ?? 5000;
const HEAD_R = 26;

export function SceneCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const drag = useRef<Drag | null>(null);
  const hits = useRef<{ id: string; x: number; y: number; r: number }[]>([]);
  const hoverHead = useRef(false);
  const scale = useApp((s) => s.scene.view.scale);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      size.current = { w: r.width, h: r.height, dpr };
    });
    ro.observe(wrap);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.0015));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  const zoom = (k: number) => updateScene((s) => ({ view: { ...s.view, scale: clamp(s.view.scale * k, 0.2, 400) } }));

  const fit = () => {
    const { scene } = store.get();
    let r = 2;
    for (const src of scene.sources) {
      const P = Math.min(motionPeriod(src), 120);
      for (let k = 0; k <= 60; k++) {
        const p = positionAt(src, (k / 60) * P);
        r = Math.max(r, Math.hypot(p.x, p.z));
      }
    }
    const { w, h } = size.current;
    updateScene((s) => ({ view: { ...s.view, scale: clamp((Math.min(w, h) / 2 - 30) / (r * 1.05), 0.2, 400) } }));
  };

  // ---------------------------------------------------------------- input

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const toWorld = (px: number, py: number) => {
    const { w, h } = size.current;
    const S = store.get().scene.view.scale;
    return { x: (px - w / 2) / S, z: (py - h / 2) / S };
  };
  const hitSource = (px: number, py: number) => {
    for (let i = hits.current.length - 1; i >= 0; i--) {
      const h = hits.current[i];
      if (Math.hypot(px - h.x, py - h.y) <= h.r) return h.id;
    }
    return null;
  };
  const nearHead = (px: number, py: number) => Math.hypot(px - size.current.w / 2, py - size.current.h / 2) < HEAD_R;

  const onPointerDown = (e: React.PointerEvent) => {
    const [px, py] = local(e);
    const id = hitSource(px, py);
    if (id) {
      selectSource(id);
      const src = store.get().scene.sources.find((s) => s.id === id)!;
      const w = toWorld(px, py);
      drag.current = e.shiftKey
        ? { mode: 'height', id, y0: py, h0: src.pos.y }
        : { mode: 'move', id, ox: src.pos.x - w.x, oz: src.pos.z - w.z };
    } else if (nearHead(px, py)) {
      drag.current = { mode: 'rotate' };
    } else {
      return;
    }
    canvasRef.current!.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const [px, py] = local(e);
    const d = drag.current;
    const canvas = canvasRef.current!;
    if (!d) {
      hoverHead.current = nearHead(px, py);
      canvas.style.cursor = hitSource(px, py) ? 'grab' : hoverHead.current ? 'alias' : 'crosshair';
      return;
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    if (d.mode === 'rotate') {
      const { w, h } = size.current;
      const yaw = Math.round(wrapDeg(Math.atan2(px - w / 2, -(py - h / 2)) / DEG));
      updateScene((s) => ({ listener: { ...s.listener, yaw } }));
    } else if (d.mode === 'move') {
      const wpt = toWorld(px, py);
      setSourcePos(d.id, { x: round(wpt.x + d.ox), z: round(wpt.z + d.oz) });
      canvas.style.cursor = 'grabbing';
    } else {
      const S = store.get().scene.view.scale;
      setSourcePos(d.id, { y: round(d.h0 + (d.y0 - py) / Math.max(S, 10)) });
      canvas.style.cursor = 'ns-resize';
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    canvasRef.current!.releasePointerCapture(e.pointerId);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const [px, py] = local(e);
    if (hitSource(px, py) || nearHead(px, py)) return;
    const st = store.get();
    const soundId = st.selectedSoundId ?? st.sounds[0]?.id ?? null;
    if (!soundId) return toast('Create or record a sound first.');
    const w = toWorld(px, py);
    addSource(soundId, { x: Math.round(w.x * 10) / 10, y: 0, z: Math.round(w.z * 10) / 10 });
  };

  // ---------------------------------------------------------------- drawing

  useFrame(() => {
    const canvas = canvasRef.current;
    const { w, h, dpr } = size.current;
    if (!canvas || !w) return;
    const g = canvas.getContext('2d')!;
    const st = store.get();
    const { scene } = st;
    const S = scene.view.scale;
    const cx = w / 2;
    const cy = h / 2;
    const t = engine.time();
    const toS = (p: Vec3) => [cx + p.x * S, cy + p.z * S] as const;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0b0e14';
    g.fillRect(0, 0, w, h);

    // Distance rings and bearing spokes
    const maxR = Math.hypot(w, h) / 2 / S;
    const step = niceStep(64 / S);
    g.font = '10px ui-monospace, monospace';
    g.textBaseline = 'middle';
    for (let i = 1; i * step <= maxR; i++) {
      const r = i * step * S;
      g.beginPath();
      g.arc(cx, cy, r, 0, TAU);
      g.strokeStyle = i % 5 === 0 ? 'rgba(148,163,184,0.22)' : 'rgba(148,163,184,0.10)';
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = 'rgba(148,163,184,0.55)';
      g.fillText(fmtDist(i * step).replace(/\.0+ /, ' '), cx + r * 0.707 + 4, cy - r * 0.707);
    }
    g.strokeStyle = 'rgba(148,163,184,0.07)';
    for (let a = 0; a < 360; a += 30) {
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.sin(a * DEG) * maxR * S, cy - Math.cos(a * DEG) * maxR * S);
      g.stroke();
    }

    // Sources
    const solo = anySolo(scene);
    const nextHits: typeof hits.current = [];
    let selLine: { x: number; y: number; d: number } | null = null;
    for (const src of scene.sources) {
      const s = computeState(src, scene, t, solo);
      const [nx, ny] = toS(s.now);
      const audible = !src.muted && (!solo || src.solo) && !!src.soundId;
      const selected = src.id === st.selectedSourceId;
      g.globalAlpha = audible ? Math.max(0.4, motionGain(src, t)) : 0.4;

      // Motion path preview
      const P = Math.min(motionPeriod(src), 120);
      const t0 = pathStart(src, t);
      if (P > 0) {
        g.beginPath();
        const N = 180;
        for (let k = 0; k <= N; k++) {
          const [x, y] = toS(positionAt(src, t0 + (k / N) * P));
          if (k) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.setLineDash([3, 5]);
        g.strokeStyle = src.color + (selected ? '90' : '50');
        g.lineWidth = 1.2;
        g.stroke();
        g.setLineDash([]);
        // Anchor marker
        const [ax, ay] = toS(src.pos);
        g.strokeStyle = src.color + 'aa';
        g.beginPath();
        g.moveTo(ax - 5, ay);
        g.lineTo(ax + 5, ay);
        g.moveTo(ax, ay - 5);
        g.lineTo(ax, ay + 5);
        g.stroke();
      }

      // Where it is heard from (delayed by the speed of sound)
      const [hx, hy] = toS(s.heard);
      if (Math.hypot(hx - nx, hy - ny) > 4) {
        g.setLineDash([2, 3]);
        g.strokeStyle = src.color + '80';
        g.beginPath();
        g.moveTo(nx, ny);
        g.lineTo(hx, hy);
        g.stroke();
        g.setLineDash([]);
        g.beginPath();
        g.arc(hx, hy, 6, 0, TAU);
        g.stroke();
      }

      // Directivity cone
      if (s.orient) {
        const a = Math.atan2(s.orient.x, -s.orient.z) - Math.PI / 2;
        const half = (src.coneInner / 2) * DEG;
        const halfOuter = (src.coneOuter / 2) * DEG;
        g.fillStyle = src.color + '18';
        g.beginPath();
        g.moveTo(nx, ny);
        g.arc(nx, ny, 44, a - halfOuter, a + halfOuter);
        g.fill();
        g.fillStyle = src.color + '30';
        g.beginPath();
        g.moveTo(nx, ny);
        g.arc(nx, ny, 44, a - half, a + half);
        g.fill();
      }

      // Activity glow
      const lvl = Math.min(1, engine.level(src.id) * 4);
      if (lvl > 0.01) {
        g.fillStyle = src.color + '30';
        g.beginPath();
        g.arc(nx, ny, 9 + lvl * 20, 0, TAU);
        g.fill();
      }

      // The source itself
      g.fillStyle = src.color;
      g.beginPath();
      g.arc(nx, ny, 8, 0, TAU);
      g.fill();
      if (selected) {
        g.strokeStyle = '#f8fafc';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(nx, ny, 12, 0, TAU);
        g.stroke();
        g.lineWidth = 1;
        selLine = { x: hx, y: hy, d: s.distance };
      }
      g.fillStyle = '#e2e8f0';
      g.font = '12px system-ui, sans-serif';
      g.fillText(src.name + (src.muted ? ' (muted)' : ''), nx + 14, ny - 2);
      if (Math.abs(s.now.y) >= 0.05) {
        g.fillStyle = 'rgba(203,213,225,0.7)';
        g.font = '10px ui-monospace, monospace';
        g.fillText(`${s.now.y > 0 ? '▲' : '▼'} ${Math.abs(s.now.y).toFixed(1)} m`, nx + 14, ny + 11);
      }
      g.globalAlpha = 1;
      nextHits.push({ id: src.id, x: nx, y: ny, r: 13 });
    }
    hits.current = nextHits;

    // Line from listener to the selected source
    if (selLine) {
      g.strokeStyle = 'rgba(248,250,252,0.35)';
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(selLine.x, selLine.y);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(248,250,252,0.8)';
      g.font = '11px ui-monospace, monospace';
      g.fillText(fmtDist(selLine.d), (cx + selLine.x) / 2 + 6, (cy + selLine.y) / 2);
    }

    // Listener head
    const yaw = listenerYaw(scene, t);
    g.save();
    g.translate(cx, cy);
    g.rotate(yaw * DEG);
    const fov = g.createRadialGradient(0, 0, 0, 0, 0, 90);
    fov.addColorStop(0, 'rgba(79,209,197,0.22)');
    fov.addColorStop(1, 'rgba(79,209,197,0)');
    g.fillStyle = fov;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 90, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    g.fill();
    if (hoverHead.current || drag.current?.mode === 'rotate') {
      g.strokeStyle = 'rgba(79,209,197,0.6)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.arc(0, 0, HEAD_R, 0, TAU);
      g.stroke();
      g.setLineDash([]);
    }
    g.fillStyle = '#94a3b8';
    for (const sx of [-12.5, 12.5]) {
      g.beginPath();
      g.ellipse(sx, 0, 3, 5.5, 0, 0, TAU);
      g.fill();
    }
    g.fillStyle = '#e2e8f0';
    g.beginPath();
    g.arc(0, 0, 11, 0, TAU);
    g.fill();
    g.fillStyle = '#4fd1c5';
    g.beginPath();
    g.moveTo(0, -17);
    g.lineTo(-5, -9);
    g.lineTo(5, -9);
    g.closePath();
    g.fill();
    g.fillStyle = '#0b0e14';
    g.font = 'bold 8px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('L', -12.5, 0.5);
    g.fillText('R', 12.5, 0.5);
    g.textAlign = 'start';
    g.restore();
  });

  return (
    <div className="scene-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="scene-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      />
      <div className="scene-tag">Top view (from above) · front is up · {(100 / scale).toFixed(scale > 20 ? 1 : 0)} m per 100 px</div>
      <div className="scene-zoom">
        <button onClick={() => zoom(1.25)} title="Zoom in">+</button>
        <button onClick={() => zoom(0.8)} title="Zoom out">−</button>
        <button onClick={fit} title="Fit all sources">Fit</button>
      </div>
      <div className="scene-help">
        Drag a source to move it · drag the head to turn · double-click to add · scroll to zoom · height: use the 3D view or <kbd>Shift</kbd>+drag up/down
      </div>
    </div>
  );
}
