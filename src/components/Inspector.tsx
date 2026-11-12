import { useRef } from 'react';
import { store, useApp } from '../state/store';
import { useFrame } from '../state/frame';
import {
  duplicateSource, patchSource, removeSource, selectSource, setMotionParam, setMotionType, setSourcePos,
} from '../state/actions';
import { engine } from '../audio/engine';
import { computeState, listenerYaw } from '../audio/spatial';
import { DEG, fmtDist, gainToDb, wrapDeg } from '../audio/util';
import { MOTIONS, MOTION_TYPES } from '../scene/motion';
import type { Aim, Source } from '../scene/types';
import { Check, Hint, Section, Select, Slider } from './controls';

export function Inspector() {
  const src = useApp((s) => s.scene.sources.find((x) => x.id === s.selectedSourceId));
  const sources = useApp((s) => s.scene.sources);
  if (!src) {
    return (
      <div className="empty">
        <p>No source selected.</p>
        <Hint>Click “＋ Scene” next to a sound in the library, or double-click anywhere in the scene.</Hint>
        {sources.length > 0 && (
          <ul className="src-list">
            {sources.map((s) => (
              <li key={s.id} onClick={() => selectSource(s.id)}>
                <span className="swatch" style={{ background: s.color }} /> {s.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return <SourceInspector src={src} sources={sources} />;
}

function SourceInspector({ src, sources }: { src: Source; sources: Source[] }) {
  const sounds = useApp((s) => s.sounds);
  const earHeight = useApp((s) => s.scene.physics.earHeight);
  const patch =(p: Partial<Source>) => patchSource(src.id, p);
  const dist = Math.hypot(src.pos.x, src.pos.z);
  const az = Math.round(Math.atan2(src.pos.x, -src.pos.z) / DEG);
  const setPolar = (d: number, a: number) =>
    setSourcePos(src.id, { x: +(d * Math.sin(a * DEG)).toFixed(3), z: +(-d * Math.cos(a * DEG)).toFixed(3) });
  const mdef = MOTIONS[src.motion.type];
  const isMoving = src.motion.type !== 'static';

  return (
    <div className="inspector">
      <div className="src-tabs">
        {sources.map((s) => (
          <button key={s.id} className={s.id === src.id ? 'on' : ''} onClick={() => selectSource(s.id)} title={s.name}>
            <span className="swatch" style={{ background: s.color }} />
            <span className="nm">{s.name}</span>
          </button>
        ))}
      </div>

      <div className="insp-head">
        <input type="color" value={src.color} onChange={(e) => patch({ color: e.target.value })} title="Colour" />
        <input className="name-in" value={src.name} onChange={(e) => patch({ name: e.target.value })} aria-label="Source name" />
        <button className={`tog ${src.muted ? 'on warn' : ''}`} onClick={() => patch({ muted: !src.muted })} title="Mute">M</button>
        <button className={`tog ${src.solo ? 'on' : ''}`} onClick={() => patch({ solo: !src.solo })} title="Solo">S</button>
        <button className="icon" onClick={() => duplicateSource(src.id)} title="Duplicate">⧉</button>
        <button className="icon danger" onClick={() => removeSource(src.id)} title="Remove from scene">✕</button>
      </div>

      <Readout src={src} />

      <Section title="Sound">
        <Select label="Sound" value={src.soundId ?? ''} onChange={(v) => patch({ soundId: v || null })}
          options={[['', '— none —'], ...sounds.map((s) => [s.id, s.name] as const)]} />
        <Check label="Loop" checked={src.loop} onChange={(loop) => patch({ loop })} />
        <Slider label="Gain" value={src.gainDb} min={-40} max={12} step={0.5} unit="dB" onChange={(gainDb) => patch({ gainDb })} />
        <Slider label="Starts at" value={src.startDelay} min={0} max={30} step={0.1} unit="s" onChange={(startDelay) => patch({ startDelay })} />
      </Section>

      <Section title={isMoving ? 'Anchor position' : 'Position'}>
        <Slider label="Distance" value={dist} min={0} max={100} step={0.1} unit="m" hardMax={3000} onChange={(d) => setPolar(d, az)} />
        <Slider label="Azimuth" value={az} min={-180} max={180} step={1} unit="°" onChange={(a) => setPolar(dist, a)}
          title="Bearing from the listener's origin: 0° = front, 90° = right" />
        <Slider label="Height" value={src.pos.y} min={-earHeight} max={30} step={0.1} unit="m" hardMin={-earHeight} hardMax={3000}
          title="Relative to the listener's ears" onChange={(y) => setSourcePos(src.id, { y })} />
        <Hint>Height is measured from your ears: 0 = ear level, −{earHeight} m = the floor.</Hint>
        <details>
          <summary>Cartesian</summary>
          <Slider label="Right" value={src.pos.x} min={-50} max={50} step={0.1} unit="m" hardMin={-3000} hardMax={3000} onChange={(x) => setSourcePos(src.id, { x })} />
          <Slider label="Front" value={-src.pos.z} min={-50} max={50} step={0.1} unit="m" hardMin={-3000} hardMax={3000} onChange={(f) => setSourcePos(src.id, { z: -f })} />
        </details>
      </Section>

      <Section title="Motion">
        <Select label="Path" value={src.motion.type} onChange={(t) => setMotionType(src.id, t)}
          options={MOTION_TYPES.map((t) => [t, MOTIONS[t].label] as const)} />
        {Object.entries(mdef.params).map(([k, p]) => (
          <Slider key={`${src.motion.type}.${k}`} label={p.label} value={src.motion.params[src.motion.type][k]}
            min={p.min} max={p.max} step={p.step} unit={p.unit}
            onChange={(v) => setMotionParam(src.id, src.motion.type, k, v)} />
        ))}
        {mdef.hint && <Hint>{mdef.hint}</Hint>}
      </Section>

      <Section title="Directivity" aside={<Check label="" checked={src.directional} onChange={(directional) => patch({ directional })} title="Directional source" />}>
        {src.directional ? (
          <>
            <Select<Aim> label="Points at" value={src.aim} onChange={(aim) => patch({ aim })}
              options={[['listener', 'The listener'], ['motion', 'Direction of travel'], ['fixed', 'Fixed direction']]} />
            {src.aim === 'fixed' && (
              <Slider label="Facing" value={src.yaw} min={-180} max={180} step={1} unit="°" onChange={(yaw) => patch({ yaw })} />
            )}
            <Slider label="Inner cone" value={src.coneInner} min={0} max={360} step={1} unit="°" onChange={(coneInner) => patch({ coneInner })} />
            <Slider label="Outer cone" value={src.coneOuter} min={0} max={360} step={1} unit="°" onChange={(coneOuter) => patch({ coneOuter })} />
            <Slider label="Outside gain" value={src.coneOuterGain} min={0} max={1} step={0.01} onChange={(coneOuterGain) => patch({ coneOuterGain })} />
            <Hint>Like a loudspeaker or a voice: full level inside the inner cone, fading to “outside gain” beyond the outer one.</Hint>
          </>
        ) : (
          <Hint>Omnidirectional. Tick the box to give the source a sound cone.</Hint>
        )}
      </Section>
    </div>
  );
}

/** Live numbers for the selected source, updated every frame without re-rendering. */
function Readout({ src }: { src: Source }) {
  const ref = useRef<HTMLDListElement>(null);
  useFrame(() => {
    const el = ref.current;
    if (!el) return;
    const { scene } = store.get();
    const live = scene.sources.find((s) => s.id === src.id);
    if (!live) return;
    const t = engine.time();
    const s = computeState(live, scene, t);
    const s2 = computeState(live, scene, t + 0.02);
    const ratio = 1 - (s2.delay - s.delay) / 0.02;
    const cents = 1200 * Math.log2(Math.max(ratio, 1e-3));
    const rel = wrapDeg(Math.atan2(s.heard.x, -s.heard.z) / DEG - listenerYaw(scene, t));
    const elev = Math.atan2(s.heard.y, Math.hypot(s.heard.x, s.heard.z)) / DEG;
    const side = Math.abs(rel) < 2 ? 'front' : Math.abs(rel) > 178 ? 'behind' : rel > 0 ? 'right' : 'left';
    const vals: Record<string, string> = {
      dist: fmtDist(s.distance),
      dir: `${Math.abs(rel).toFixed(0)}° ${side}`,
      elev: `${elev >= 0 ? '+' : ''}${elev.toFixed(0)}°`,
      delay: scene.physics.doppler ? `${(s.delay * 1000).toFixed(1)} ms` : 'off',
      doppler: scene.physics.doppler ? `×${ratio.toFixed(3)} (${cents >= 0 ? '+' : ''}${cents.toFixed(0)} ct)` : 'off',
      level: `${gainToDb(s.distanceGain).toFixed(1)} dB`,
      air: scene.physics.air ? `${(s.cutoff / 1000).toFixed(1)} kHz` : 'off',
    };
    for (const [k, v] of Object.entries(vals)) {
      const dd = el.querySelector<HTMLElement>(`[data-k="${k}"]`);
      if (dd && dd.textContent !== v) dd.textContent = v;
    }
  });
  const rows: [string, string, string][] = [
    ['dist', 'Distance', 'Distance from the listener to where the sound is heard from'],
    ['dir', 'Direction', 'Relative to where the listener faces'],
    ['elev', 'Elevation', 'Angle above or below ear level'],
    ['delay', 'Arrival delay', 'Time the sound takes to reach you'],
    ['doppler', 'Doppler', 'Pitch change from motion toward or away from you'],
    ['level', 'Distance loss', 'Attenuation from the distance model'],
    ['air', 'Air low-pass', 'High frequencies absorbed by air'],
  ];
  return (
    <dl className="readout" ref={ref}>
      {rows.map(([k, label, title]) => (
        <div key={k} title={title}>
          <dt>{label}</dt>
          <dd data-k={k}>–</dd>
        </div>
      ))}
    </dl>
  );
}
