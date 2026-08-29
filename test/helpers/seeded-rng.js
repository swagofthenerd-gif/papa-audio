'use strict'
// Deterministic RNG for tests that need reproducible sampling.
//
// A bare LCG stepped once from a small seed does not spread: for seeds 0..199
// the first value only spans [0.2361, 0.3132], which is too narrow to exercise
// a weighted sampler at all. Mixing the seed first spreads that first value
// across the whole interval, which is what these tests actually depend on.
function seeded(seed) {
  let s = seed >>> 0
  s = ((s ^ 61) ^ (s >>> 16)) * 0x27d4eb2d
  s = (s ^ (s >>> 16)) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

module.exports = { seeded }
