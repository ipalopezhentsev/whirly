export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(g, 1e-9));
export const uid = () => Math.random().toString(36).slice(2, 10);
export const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Wrap an angle in degrees to [-180, 180). */
export const wrapDeg = (a: number) => mod(a + 180, 360) - 180;

export function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function fmtDist(m: number) {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 100) return `${m.toFixed(0)} m`;
  if (m >= 10) return `${m.toFixed(1)} m`;
  return `${m.toFixed(2)} m`;
}
