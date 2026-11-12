// One shared requestAnimationFrame loop for the engine, canvases and live readouts.
import { useEffect, useRef } from 'react';

type FrameCb = (ts: number) => void;
const callbacks = new Set<FrameCb>();

export function onFrame(cb: FrameCb) {
  callbacks.add(cb);
  return () => {
    callbacks.delete(cb);
  };
}

function loop(ts: number) {
  for (const cb of callbacks) {
    try {
      cb(ts);
    } catch (e) {
      console.error(e);
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/** Run `cb` every animation frame while the component is mounted. */
export function useFrame(cb: FrameCb) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => onFrame((ts) => ref.current(ts)), []);
}
