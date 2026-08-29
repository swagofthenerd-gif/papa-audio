'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { buildQueue, MODE_TEMPERATURE, MODE_AFFINITY, AFFINITY_WEIGHT } = require('../src/queue-engine')
const { seeded } = require('./helpers/seeded-rng')

const V = e => ({ energy: e, brightness: e, dynamics: e, density: e, punch: e })

function lib(n, surroundEvery = 2) {
  const tracks = [], vectors = new Map()
  for (let i = 0; i < n; i++) {
    const t = {
      filePath: `/t${i}.flac`, title: `T${i}`,
      artist: `Artist${i % 12}`, albumId: `alb${i % 20}`,
      channels: i % surroundEvery === 0 ? 6 : 2,
    }
    tracks.push(t)
    vectors.set(t.filePath, V(i / n))
  }
  return { tracks, vectors }
}

test('radio returns the requested length and excludes the seed', () => {
  const { tracks, vectors } = lib(60)
  const seed = tracks[10]
  const q = buildQueue({ mode: 'radio', seed, tracks, vectors, length: 20, rng: seeded(1) })
  assert.strictEqual(q.length, 20)
  assert.ok(!q.some(t => t.filePath === seed.filePath), 'seed should not repeat in its own radio')
})

test('radio stays near the seed rather than wandering the library', () => {
  const { tracks, vectors } = lib(120)
  const seed = tracks[60]
  const q = buildQueue({ mode: 'radio', seed, tracks, vectors, length: 15, rng: seeded(3) })
  const seedE = vectors.get(seed.filePath).energy
  const avg = q.reduce((s, t) => s + Math.abs(vectors.get(t.filePath).energy - seedE), 0) / q.length
  assert.ok(avg < 0.3, `radio drifted too far: mean energy gap ${avg}`)
})

test('surround-first lands between 60 and 95 percent surround', () => {
  const { tracks, vectors } = lib(200)
  const q = buildQueue({ mode: 'surprise', tracks, vectors, length: 40, rng: seeded(5) })
  const ratio = q.filter(t => t.channels >= 6).length / q.length
  assert.ok(ratio >= 0.6 && ratio <= 0.95, `surround ratio was ${ratio}`)
})

test('rediscover only draws from the cold set', () => {
  const { tracks, vectors } = lib(60)
  const coldSet = new Set(tracks.slice(0, 12).map(t => t.filePath))
  const q = buildQueue({ mode: 'rediscover', tracks, vectors, coldSet, length: 8, rng: seeded(7) })
  assert.ok(q.length > 0)
  for (const t of q) assert.ok(coldSet.has(t.filePath), `${t.filePath} was not cold`)
})

test('the same seed reproduces, a different seed does not', () => {
  const { tracks, vectors } = lib(80)
  const a = buildQueue({ mode: 'surprise', tracks, vectors, length: 12, rng: seeded(11) })
  const b = buildQueue({ mode: 'surprise', tracks, vectors, length: 12, rng: seeded(11) })
  const c = buildQueue({ mode: 'surprise', tracks, vectors, length: 12, rng: seeded(12) })
  assert.deepStrictEqual(a.map(t => t.filePath), b.map(t => t.filePath))
  assert.notDeepStrictEqual(a.map(t => t.filePath), c.map(t => t.filePath))
})

test('artist spacing survives the whole pipeline', () => {
  const { tracks, vectors } = lib(120)
  const q = buildQueue({ mode: 'surprise', tracks, vectors, length: 30, rng: seeded(13) })
  const seen = new Map()
  q.forEach((t, i) => {
    const prev = seen.get(t.artist)
    if (prev !== undefined) assert.ok(i - prev >= 3, `${t.artist} at ${prev} and ${i}`)
    seen.set(t.artist, i)
  })
})

test('affinity raises a favourite track into the queue', () => {
  const { tracks, vectors } = lib(100)
  const fav = tracks[77].filePath
  const affinity = new Map([[fav, 1]])
  let hits = 0
  for (let i = 0; i < 40; i++) {
    const q = buildQueue({ mode: 'surprise', tracks, vectors, affinity, length: 15, rng: seeded(i) })
    if (q.some(t => t.filePath === fav)) hits++
  }
  assert.ok(hits > 10, `a strong favourite appeared only ${hits}/40 times`)
})

test('no features at all still returns a playable queue', () => {
  const { tracks } = lib(40)
  const q = buildQueue({ mode: 'surprise', tracks, vectors: new Map(), length: 10, rng: seeded(2) })
  assert.strictEqual(q.length, 10)
})

test('a library smaller than the requested length returns what exists', () => {
  const { tracks, vectors } = lib(5)
  const q = buildQueue({ mode: 'surprise', tracks, vectors, length: 50, rng: seeded(2) })
  assert.strictEqual(q.length, 5)
})

test('an empty library returns an empty queue', () => {
  assert.deepStrictEqual(buildQueue({ mode: 'surprise', tracks: [], vectors: new Map(), length: 10 }), [])
})

test('radio is the tightest mode and surprise the loosest', () => {
  assert.ok(MODE_TEMPERATURE.radio < MODE_TEMPERATURE.mix)
  assert.ok(MODE_TEMPERATURE.mix < MODE_TEMPERATURE.surprise)
})

test('mix falls back to the whole library before analysis has run', () => {
  const { tracks } = lib(40)
  // No vectors, so clusterLibrary produces no clusters and every lookup misses.
  const q = buildQueue({ mode: 'mix', tracks, vectors: new Map(), clusterOf: new Map(), seedCluster: 0, length: 10 })
  assert.strictEqual(q.length, 10, 'a Daily Mix played nothing before analysis ran')
})

test('radio affinity is scaled far below the other modes, so distance to the seed still dominates', () => {
  assert.ok(MODE_AFFINITY.radio < 2, `radio affinity ${MODE_AFFINITY.radio} is too high to let seed distance dominate`)
  for (const m of ['mix', 'surprise', 'rediscover']) {
    assert.ok(MODE_AFFINITY[m] > MODE_AFFINITY.radio * 3, `${m} affinity should carry the mode, same order as AFFINITY_WEIGHT`)
    assert.strictEqual(MODE_AFFINITY[m], AFFINITY_WEIGHT, `${m} should keep the historical weight`)
  }
})
