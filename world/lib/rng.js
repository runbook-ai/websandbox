'use strict';
// Seeded randomness. Every stream is derived from (world seed, label), so adding a persona or a network
// never shifts the draws of another: rng(seed, 'persona', id) is the same in every build.
const crypto = require('crypto');

function hash32(...parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest().readUInt32LE(0);
}

// sfc32 (Small Fast Counter), seeded from a sha256 of the labels.
function rng(...labels) {
  const h = crypto.createHash('sha256').update(labels.join('\u0000')).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    // weights: array of numbers, or an object {key: weight} (returns the key).
    weighted(weights) {
      const entries = Array.isArray(weights) ? weights.map((w, i) => [i, w]) : Object.entries(weights);
      const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
      if (!(total > 0)) return entries.length ? entries[0][0] : undefined;
      let x = next() * total;
      for (const [k, w] of entries) if ((x -= Math.max(0, w)) < 0) return k;
      return entries[entries.length - 1][0];
    },
    normal(mu = 0, sigma = 1) {
      const u = 1 - next(), v = next();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    lognormal: (mu, sigma) => Math.exp(r.normal(mu, sigma)),
    poisson(lambda) {
      if (lambda <= 0) return 0;
      if (lambda > 30) return Math.max(0, Math.round(r.normal(lambda, Math.sqrt(lambda))));
      const l = Math.exp(-lambda);
      let k = 0, p = 1;
      do { k++; p *= next(); } while (p > l);
      return k - 1;
    },
    sample(arr, n) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a.slice(0, n);
    },
  };
  return r;
}

module.exports = { rng, hash32 };
