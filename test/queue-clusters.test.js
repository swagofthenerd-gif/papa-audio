'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { clusterLibrary } = require('../src/queue-clusters')
const { seeded } = require('./helpers/seeded-rng')

function twoBlobs() {
  const tracks = [], vectors = new Map()
  for (let i = 0; i < 40; i++) {
    const quiet = i < 20
    const t = { filePath: `/t${i}.flac`, artist: quiet ? 'Quiet Band' : 'Loud Band', albumId: `a${i}` }
    tracks.push(t)
    const base = quiet ? 0.1 : 0.9
    vectors.set(t.filePath, {
      energy: base, brightness: base, dynamics: base, density: base, punch: base,
    })
  }
  return { tracks, vectors }
}

test('the first assignment counts as movement, so clustering does not stop immediately', () => {
  // Pre-filling `assign` with 0 -- a real cluster index -- makes the first pass
  // look like "nothing moved" whenever every point lands in cluster 0, and the
  // loop breaks before separating anything. This asserts both clusters are used.
  const { tracks, vectors } = twoBlobs()
  const { clusterOf } = clusterLibrary({ tracks, vectors, k: 2, rng: seeded(1) })
  const used = new Set(tracks.map(t => clusterOf.get(t.filePath)))
  assert.strictEqual(used.size, 2, `clustering collapsed into ${used.size} cluster(s)`)
})

test('separates two obvious groups', () => {
  const { tracks, vectors } = twoBlobs()
  const { clusterOf } = clusterLibrary({ tracks, vectors, k: 2, rng: seeded(1) })
  const first = clusterOf.get('/t0.flac')
  for (let i = 0; i < 20; i++) assert.strictEqual(clusterOf.get(`/t${i}.flac`), first)
  for (let i = 20; i < 40; i++) assert.notStrictEqual(clusterOf.get(`/t${i}.flac`), first)
})

test('every track is assigned', () => {
  const { tracks, vectors } = twoBlobs()
  const { clusterOf } = clusterLibrary({ tracks, vectors, k: 5, rng: seeded(2) })
  for (const t of tracks) assert.ok(Number.isInteger(clusterOf.get(t.filePath)))
})

test('names a mix after its dominant artists, never a genre tag', () => {
  const { tracks, vectors } = twoBlobs()
  const { names } = clusterLibrary({ tracks, vectors, k: 2, rng: seeded(3) })
  assert.strictEqual(names.length, 2)
  assert.ok(names.some(n => n.includes('Quiet Band')))
  assert.ok(names.some(n => n.includes('Loud Band')))
})

test('k larger than the library does not throw or produce empty clusters', () => {
  const tracks = [{ filePath: '/a.flac', artist: 'A', albumId: 'x' }]
  const vectors = new Map([['/a.flac', { energy: 1, brightness: 1, dynamics: 1, density: 1, punch: 1 }]])
  const r = clusterLibrary({ tracks, vectors, k: 5, rng: seeded(4) })
  assert.strictEqual(r.clusterOf.get('/a.flac'), 0)
  assert.strictEqual(r.centroids.length, 1)
})

test('seeding from previous centroids keeps assignments stable across refits', () => {
  const { tracks, vectors } = twoBlobs()
  const first = clusterLibrary({ tracks, vectors, k: 2, rng: seeded(5) })
  const again = clusterLibrary({ tracks, vectors, k: 2, rng: seeded(999), previousCentroids: first.centroids })
  for (const t of tracks) {
    assert.strictEqual(again.clusterOf.get(t.filePath), first.clusterOf.get(t.filePath))
  }
})

test('an empty library returns empty structures', () => {
  const r = clusterLibrary({ tracks: [], vectors: new Map(), k: 5, rng: seeded(6) })
  assert.strictEqual(r.centroids.length, 0)
  assert.strictEqual(r.names.length, 0)
})
