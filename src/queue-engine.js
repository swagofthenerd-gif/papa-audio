'use strict'
// The four queue modes. One selection core; the modes differ only in candidate
// pool, scoring and how widely the sampler is allowed to roam.

const { distance, buildNormaliser, normalise } = require('./audio-features')
const { softmaxSample } = require('./queue-sampler')
const { sequence } = require('./queue-sequencer')

const MODE_TEMPERATURE = { radio: 0.4, mix: 1.0, surprise: 2.5, rediscover: 1.2 }
// These two are coupled and neither is meaningful alone. SURROUND_BONUS is a
// flat bonus; affinity is 0..1 scaled by AFFINITY_WEIGHT. If AFFINITY_WEIGHT
// does not exceed SURROUND_BONUS, a maximally-loved stereo track is outranked
// by every unloved surround track and can never surface -- which contradicts
// the rule that stereo is admitted when it is genuinely the better match.
// Changing either one means re-checking the other.
const SURROUND_BONUS = 2.8
const AFFINITY_WEIGHT = 6.0
const ZERO = { energy: 0, brightness: 0, dynamics: 0, density: 0, punch: 0 }

function poolFor(mode, tracks, seed, coldSet, clusterOf, seedCluster) {
  if (mode === 'rediscover') {
    const cold = coldSet || new Set()
    return tracks.filter(t => cold.has(t.filePath))
  }
  if (mode === 'mix' && clusterOf) {
    return tracks.filter(t => clusterOf.get(t.filePath) === seedCluster)
  }
  if (mode === 'radio' && seed) {
    return tracks.filter(t => t.filePath !== seed.filePath)
  }
  return tracks
}

function buildQueue({
  mode = 'surprise', seed = null, tracks = [], vectors = new Map(),
  affinity = new Map(), coldSet = null, clusterOf = null, seedCluster = null,
  length = 30, surroundBias = SURROUND_BONUS, rng = Math.random,
} = {}) {
  const pool = poolFor(mode, tracks || [], seed, coldSet, clusterOf, seedCluster)
  if (!pool.length) return []

  // Z-score against this library so "bright" means bright relative to what the
  // user owns, not against an absolute scale that means nothing here.
  const present = pool.map(t => vectors.get(t.filePath)).filter(Boolean)
  const norm = buildNormaliser(present)
  const zOf = t => {
    const v = vectors.get(t.filePath)
    return v ? normalise(v, norm) : ZERO
  }
  const seedZ = seed ? zOf(seed) : null

  const scores = pool.map(t => {
    let s = 0
    if (seedZ && mode === 'radio') s -= distance(seedZ, zOf(t))
    s += AFFINITY_WEIGHT * (affinity.get(t.filePath) || 0)
    if ((t.channels || 0) >= 6) s += surroundBias
    return s
  })

  // Oversample, then let sequencing choose the order from a slightly wider set.
  const want = Math.min(length, pool.length)
  const picked = softmaxSample(pool, scores, {
    count: Math.min(pool.length, Math.ceil(want * 1.5)),
    temperature: MODE_TEMPERATURE[mode] ?? 1,
    rng,
  })

  const zVectors = new Map(picked.map(t => [t.filePath, zOf(t)]))
  return sequence(picked, { vectors: zVectors }).slice(0, want)
}

module.exports = { buildQueue, MODE_TEMPERATURE, SURROUND_BONUS, AFFINITY_WEIGHT }
