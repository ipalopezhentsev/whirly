import { useApp } from '../state/store';
import { patchPhysics, resetToDemo, setEnvironmentPreset, setListenerHeight, updateScene } from '../state/actions';
import { engine } from '../audio/engine';
import { ENVIRONMENTS } from '../audio/reverb';
import { Check, Hint, Section, Select, Slider } from './controls';

const POSTURES: [string, number][] = [['Lying', 0.2], ['Sitting', 1.2], ['Standing', 1.6], ['Gallery', 8], ['Tower', 30]];
const MEDIA: [string, number][] = [['Air', 343], ['Water', 1480], ['Steel', 5900], ['Slow-mo', 40]];

export function WorldPanel() {
  const scene = useApp((s) => s.scene);
  const { physics: ph, environment: env, listener } = scene;

  return (
    <div className="world">
      <Section title="Listener">
        <Slider label="Head turn" value={listener.yaw} min={-180} max={180} step={1} unit="°"
          onChange={(yaw) => updateScene((s) => ({ listener: { ...s.listener, yaw } }))} />
        <Slider label="Spin" value={listener.spin} min={-180} max={180} step={1} unit="°/s"
          title="Continuously turn the listener's head while playing"
          onChange={(spin) => updateScene((s) => ({ listener: { ...s.listener, spin } }))} />
        <Hint>You can also drag the head in the top view, or press <kbd>Q</kbd> / <kbd>E</kbd>.</Hint>
        <Slider label="Height" value={ph.earHeight} min={0.1} max={100} log step={0.01} unit="m" hardMax={1000}
          title="Listener's ears above the floor" onChange={setListenerHeight} />
        <div className="chips">
          {POSTURES.map(([label, h]) => (
            <button key={label} className={`chip ${ph.earHeight === h ? 'on' : ''}`} onClick={() => setListenerHeight(h)}>
              {label} {h} m
            </button>
          ))}
        </div>
        <Hint>
          Ears above the floor. Sources stay where they are in the room, so going up puts them below you. In the 3D view
          you can drag the listener up and down.
        </Hint>
      </Section>

      <Section title="Environment">
        <Select label="Space" value={env.preset} onChange={setEnvironmentPreset}
          options={Object.entries(ENVIRONMENTS).map(([k, e]) => [k, e.label] as const)} />
        <Slider label="Reverb" value={env.wet} min={0} max={1} step={0.01}
          onChange={(wet) => updateScene((s) => ({ environment: { ...s.environment, wet } }))} />
        <Hint>Room sound stays roughly constant while the direct sound fades with distance, so far sources sound more reverberant.</Hint>
      </Section>

      <Section title="Spatialization">
        <Select<PanningModelType> label="Panning" value={ph.panningModel} onChange={(panningModel) => patchPhysics({ panningModel })}
          options={[['HRTF', 'HRTF (3D, headphones)'], ['equalpower', 'Equal-power (stereo)']]} />
        <Select<DistanceModelType> label="Distance law" value={ph.distanceModel} onChange={(distanceModel) => patchPhysics({ distanceModel })}
          options={[['inverse', 'Inverse (natural, −6 dB/×2)'], ['exponential', 'Exponential'], ['linear', 'Linear (silent at max)']]} />
        <Slider label="Ref. distance" value={ph.refDistance} min={0.1} max={20} step={0.1} unit="m" onChange={(refDistance) => patchPhysics({ refDistance })}
          title="Distance at which the source plays at full level" />
        <Slider label="Rolloff" value={ph.rolloff} min={0} max={ph.distanceModel === 'linear' ? 1 : 5} step={0.05} onChange={(rolloff) => patchPhysics({ rolloff })}
          title="How quickly level drops with distance" />
        {ph.distanceModel === 'linear' && (
          <Slider label="Max distance" value={ph.maxDistance} min={1} max={2000} step={1} unit="m" onChange={(maxDistance) => patchPhysics({ maxDistance })} />
        )}
      </Section>

      <Section title="Height cues">
        <Check label="Extra elevation cues" checked={ph.elevationCues} onChange={(elevationCues) => patchPhysics({ elevationCues })}
          title="Pinna-style EQ that moves with elevation, on top of the HRTF" />
        {ph.elevationCues && (
          <Slider label="Strength" value={ph.elevAmount} min={0} max={2} step={0.05} unit="×" onChange={(elevAmount) => patchPhysics({ elevAmount })} />
        )}
        <Check label="Floor reflection" checked={ph.floor} onChange={(floor) => patchPhysics({ floor })}
          title="A second, mirrored copy of each source bouncing off the floor" />
        {ph.floor && (
          <Slider label="Reflectivity" value={ph.floorAmount} min={0} max={1} step={0.05}
            title="0 = thick carpet, 1 = polished stone" onChange={(floorAmount) => patchPhysics({ floorAmount })} />
        )}
        <Hint>
          The browser's HRTF comes from generic ears, so up/down is the weakest cue. These two help a lot, and broadband
          sounds (noise bursts, rain, footsteps) carry height far better than narrow ones like the bee. Try “Rise &amp; fall” with pink-noise bursts.
        </Hint>
      </Section>

      <Section title="Propagation">
        <Check label="Travel delay & Doppler" checked={ph.doppler} onChange={(doppler) => patchPhysics({ doppler })}
          title="Sound takes time to arrive; moving sources shift in pitch" />
        <Slider label="Speed of sound" value={ph.speedOfSound} min={5} max={6000} step={1} unit="m/s" onChange={(speedOfSound) => patchPhysics({ speedOfSound })} />
        <div className="chips">
          {MEDIA.map(([label, c]) => (
            <button key={label} className={`chip ${ph.speedOfSound === c ? 'on' : ''}`} onClick={() => patchPhysics({ speedOfSound: c })}>
              {label} {c}
            </button>
          ))}
        </div>
        <Check label="Air absorption" checked={ph.air} onChange={(air) => patchPhysics({ air })} title="Distant sounds lose their highs" />
        {ph.air && <Slider label="Amount" value={ph.airAmount} min={0.1} max={5} step={0.1} unit="×" onChange={(airAmount) => patchPhysics({ airAmount })} />}
        <Hint>Lower the speed of sound to exaggerate Doppler and see the gap between where a source is and where you hear it.</Hint>
      </Section>

      <Section title="Project">
        <button className="wide danger-outline" onClick={async () => {
          if (!confirm('Replace all sounds and the scene with the demo?')) return;
          engine.stop();
          await resetToDemo();
        }}>Reset to demo</button>
        <Hint>Sounds and the scene are saved in this browser automatically.</Hint>
      </Section>
    </div>
  );
}
