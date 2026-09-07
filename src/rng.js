/**
 * Seeded PRNG so a given seed always reproduces the same diagram.
 * xmur3 hashes an arbitrary string seed into a 32-bit int; mulberry32
 * is a fast, small, good-enough PRNG driven by that int.
 */
(function (global) {
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class SeededRNG {
    constructor(seed) {
      this.seed = String(seed);
      this._next = mulberry32(xmur3(this.seed)());
    }

    /** Float in [0, 1). */
    random() {
      return this._next();
    }

    /** Float in [min, max). */
    range(min, max) {
      return min + this.random() * (max - min);
    }

    /** Integer in [min, max] (inclusive on both ends). */
    int(min, max) {
      return Math.floor(this.range(min, max + 1));
    }

    /** True with probability p (default 0.5). */
    bool(p = 0.5) {
      return this.random() < p;
    }

    /** Random element of a non-empty array. */
    pick(arr) {
      return arr[this.int(0, arr.length - 1)];
    }

    /** In-place Fisher-Yates shuffle, returns the same array. */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = this.int(0, i);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
  }

  /** Generates a short human-typeable random seed string. */
  function randomSeedString() {
    return Math.random().toString(36).slice(2, 10);
  }

  global.DG = global.DG || {};
  global.DG.SeededRNG = SeededRNG;
  global.DG.randomSeedString = randomSeedString;
})(window);
