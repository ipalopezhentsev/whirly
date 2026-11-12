// Seeded randomness for the composer. Every decision draws from a generator keyed by what it is
// about (track, section, bar…), so changing one part never reshuffles the others, and a single
// track can be re-rendered on its own (stems) with exactly the same notes.

export type Rng = () => number;

/** mulberry32 */
export function mulberry(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the parts' text. */
export function hash(...parts: (string | number)[]) {
  let h = 0x811c9dc5;
  const s = parts.join('\u0001');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export const rngFor = (...parts: (string | number)[]) => mulberry(hash(...parts));

export const between = (r: Rng, a: number, b: number) => a + r() * (b - a);
export const int = (r: Rng, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
export const pickOf = <T,>(r: Rng, arr: readonly T[]) => arr[Math.floor(r() * arr.length)];

/** Index chosen with probability proportional to its weight. */
export function weighted(r: Rng, w: readonly number[]) {
  let total = 0;
  for (const x of w) total += Math.max(0, x);
  let v = r() * total;
  for (let i = 0; i < w.length; i++) {
    v -= Math.max(0, w[i]);
    if (v < 0) return i;
  }
  return w.length - 1;
}

/** Roughly normal (sum of three uniforms), mean 0, sd ≈ 1. */
export const gauss = (r: Rng) => (r() + r() + r() - 1.5) * 2;
