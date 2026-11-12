// A piano roll of one part in one section of a composition: the notes (or drum hits) it plays there,
// over the bar grid and the section's chords, with a line where the piece is playing.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '../state/frame';
import { engine } from '../audio/engine';
import { drumEvents, noteEvents, sectionChords, trackLevel, type DrumEv, type NoteEv, type Plan } from '../audio/music/compose';
import { chordName, NOTE_NAMES } from '../audio/music/theory';
import type { DrumVoice } from '../audio/music/drums';
import type { MusicParams, TrackParams } from '../audio/music/types';

/** Drum rows, top to bottom: cymbals over drums, kick at the bottom like the lowest note. */
const DRUM_ROWS: [DrumVoice, string][] = [
  ['crash', 'Crash'], ['ohat', 'Open hat'], ['hat', 'Hat'], ['shaker', 'Shaker'], ['rim', 'Rim'],
  ['tomH', 'Tom hi'], ['tomL', 'Tom lo'], ['clap', 'Clap'], ['snare', 'Snare'], ['kick', 'Kick'],
];
const BLACK = new Set([1, 3, 6, 8, 10]);
const CHORD_H = 14;
const MAX_HEADS = 4;
/** Events this early before a section's start still belong to it (humanized timing). */
const SLACK = 0.04;

const noteName = (m: number) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const SECTION_NAMES: Record<string, string> = { intro: 'Intro', outro: 'Outro' };

interface Props {
  p: MusicParams;
  plan: Plan;
  seed: number;
  tr: TrackParams;
  sec: number;
  onSection: (i: number) => void;
  onClose: () => void;
  /** Set when the settings shown are the ones rendered: the sounds whose playheads to follow. */
  live: { soundIds: ReadonlySet<string>; barSec: number } | null;
}

export function PianoRoll({ p, plan, seed, tr, sec: index, onSection, onClose, live }: Props) {
  const sec = plan.sections[index];
  const drums = tr.role === 'drums';
  const t0 = sec.start * plan.bar;
  const t1 = t0 + sec.bars * plan.bar;
  const level = trackLevel(p, sec, tr, seed);

  const all = useMemo((): (NoteEv | DrumEv)[] => (drums ? drumEvents(p, plan, tr, seed) : noteEvents(p, plan, tr, seed)), [p, plan, tr, seed, drums]);
  const events = useMemo(() => all.filter((e) => e.t >= t0 - SLACK && e.t < t1 - SLACK), [all, t0, t1]);
  const chords = useMemo(() => sectionChords(p, plan, sec), [p, plan, sec]);

  // Rows: the drum voices that play here, or the pitch range played (at least an octave and a bit).
  const rows = useMemo(() => {
    if (drums) {
      const used = new Set(events.map((e) => (e as { voice: DrumVoice }).voice));
      return DRUM_ROWS.filter(([v]) => used.has(v)).map(([v, l]) => ({ key: v as string | number, label: l }));
    }
    const ms = events.map((e) => (e as { midi: number }).midi);
    let lo = ms.length ? Math.min(...ms) - 1 : 12 * (tr.octave + 1) + p.key - 6;
    let hi = ms.length ? Math.max(...ms) + 1 : lo + 12;
    while (hi - lo < 14) { lo--; hi++; }
    return Array.from({ length: hi - lo + 1 }, (_, i) => {
      const m = hi - i;
      return { key: m as string | number, label: noteName(m) };
    });
  }, [events, drums, tr.octave, p.key]);

  const gutter = drums ? 50 : 28;
  const rowH = drums ? 13 : Math.max(4, Math.min(10, Math.floor(200 / Math.max(1, rows.length))));
  const height = CHORD_H + Math.max(1, rows.length) * rowH;

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const heads = useRef<(HTMLDivElement | null)[]>([]);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const xOf = (t: number) => gutter + ((t - t0) / (t1 - t0)) * (width - gutter);

  useEffect(() => {
    const c = canvas.current;
    if (!c || width <= gutter) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const [bg, card, line, line2, text, muted, accent, accent2] =
      ['--bg', '--card', '--line', '--line-2', '--text', '--muted', '--accent', '--accent-2'].map(v);
    g.clearRect(0, 0, width, height);
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);
    g.font = `9px ${v('--mono') || 'monospace'}`;
    g.textBaseline = 'middle';

    // Row backgrounds and labels.
    rows.forEach((r, i) => {
      const y = CHORD_H + i * rowH;
      const black = !drums && BLACK.has(((r.key as number) % 12 + 12) % 12);
      g.fillStyle = black ? bg : card;
      g.fillRect(gutter, y, width - gutter, rowH);
      if (!drums && ((r.key as number) % 12 + 12) % 12 === 0) {
        g.fillStyle = line2;
        g.fillRect(gutter, y + rowH - 1, width - gutter, 1);
      }
      const label = drums || ((r.key as number) % 12 + 12) % 12 === 0 || rowH >= 9 || i === 0 || i === rows.length - 1;
      if (label && rowH >= 4) {
        g.fillStyle = drums || ((r.key as number) % 12 === 0) ? text : muted;
        g.fillText(r.label, 3, y + rowH / 2, gutter - 5);
      }
    });

    // Beat and bar lines.
    const beats = sec.bars * p.meter;
    for (let b = 0; b <= beats; b++) {
      const x = Math.round(xOf(t0 + b * plan.beat));
      g.fillStyle = b % p.meter === 0 ? line2 : line;
      g.fillRect(x, CHORD_H, b % p.meter === 0 ? 1 : 0.5, height - CHORD_H);
    }

    // Chords along the top.
    for (const ch of chords) {
      const x0 = xOf(t0 + ch.start * plan.beat);
      const x1 = xOf(t0 + ch.end * plan.beat);
      g.fillStyle = line2;
      g.fillRect(Math.round(x0), 0, 1, CHORD_H - 2);
      g.fillStyle = muted;
      g.fillText(chordName(ch.chord, p.key), x0 + 3, CHORD_H / 2, Math.max(4, x1 - x0 - 5));
    }

    // Notes / hits.
    const rowOf = new Map(rows.map((r, i) => [r.key, i]));
    const pxPerSec = (width - gutter) / (t1 - t0);
    for (const e of events) {
      const i = rowOf.get(drums ? (e as { voice: DrumVoice }).voice : (e as { midi: number }).midi);
      if (i === undefined) continue;
      const x = Math.max(gutter, xOf(e.t));
      const w = drums ? Math.max(2, Math.min(6, (plan.beat / 4) * pxPerSec * 0.7)) : Math.max(2, Math.min(xOf(t1) - x, (e as { dur: number }).dur * pxPerSec - 1));
      const y = CHORD_H + i * rowH;
      g.globalAlpha = 0.35 + 0.65 * e.vel;
      g.fillStyle = drums ? accent2 : accent;
      g.fillRect(x, y + 1, w, Math.max(2, rowH - 2));
    }
    g.globalAlpha = 1;
  });

  useFrame(() => {
    const times = (live ? engine.playheads(live.soundIds) : [])
      .filter((t) => t >= t0 && t < t1)
      .sort((a, b) => a - b)
      .filter((t, i, xs) => !i || t - xs[i - 1] > 0.05);
    heads.current.forEach((h, i) => {
      if (!h) return;
      const t = times[i];
      if (t === undefined || width <= gutter) {
        h.style.display = 'none';
        return;
      }
      h.style.display = '';
      h.style.transform = `translateX(${xOf(t)}px)`;
    });
  });

  const n = plan.sections.length;
  const name = SECTION_NAMES[sec.label] ?? sec.label;
  const empty = !tr.on ? 'This part is switched off.' : !level ? 'This part sits this section out.' : !events.length ? 'No notes here.' : '';

  return (
    <div className="roll">
      <div className="roll-head">
        <button className="icon" disabled={index <= 0} onClick={() => onSection(index - 1)} title="Previous section">‹</button>
        <span className="roll-title">
          <b>{tr.name}</b> · {name} <span className="muted">· bars {sec.start + 1}–{sec.start + sec.bars}</span>
        </span>
        <button className="icon" disabled={index >= n - 1} onClick={() => onSection(index + 1)} title="Next section">›</button>
        <button className="icon" onClick={onClose} title="Close the piano roll">✕</button>
      </div>
      <div className="roll-body" ref={wrap}>
        {Array.from({ length: MAX_HEADS }, (_, i) => (
          <div key={i} className="roll-playhead" ref={(el) => { heads.current[i] = el; }} style={{ display: 'none' }} />
        ))}
        <canvas ref={canvas} style={{ width: '100%', height }} />
        {empty && <div className="roll-empty">{empty}</div>}
      </div>
    </div>
  );
}
