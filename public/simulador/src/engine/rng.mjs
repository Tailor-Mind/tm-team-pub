/**
 * Deterministic PRNG. Two candidates with the same seed get the same world:
 * same scripted events, same defect rolls, same job noise. Without this the
 * telemetry is not comparable across people and the instrument is worthless.
 */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** uniform float in [lo, hi) */
    float: (lo, hi) => lo + next() * (hi - lo),
    /** integer in [lo, hi] inclusive */
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    /** true with probability p */
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** multiplicative jitter around 1, e.g. jitter(0.25) -> [0.75, 1.25) */
    jitter: (spread) => 1 - spread + next() * spread * 2,
  };
}

/** Stable string -> 32-bit seed, so a candidate token maps to a fixed world. */
function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { makeRng, seedFromString };

