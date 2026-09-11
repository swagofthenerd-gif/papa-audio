'use strict'
const test = require('node:test')
const assert = require('node:assert')
const M = require('../src/mood-map')

// ── Genre splitting ──────────────────────────────────────────────────────────

test('splitGenres breaks compounds apart and drops tag junk', () => {
  assert.deepEqual(M.splitGenres('Rock, Progressive Rock / Art Rock'), ['rock', 'progressive rock', 'art rock'])
  assert.deepEqual(M.splitGenres('Library'), [])
  assert.deepEqual(M.splitGenres('Music; Unknown'), [])
  assert.deepEqual(M.splitGenres(null), [])
  assert.deepEqual(M.splitGenres('Jazz | jazz'), ['jazz'], 'deduped case-insensitively')
  assert.deepEqual(M.genreKeysOf({ genre: '' }), ['unknown'])
  assert.deepEqual(M.genreKeysOf({ genre: 'Blues' }), ['blues'])
})

test('genreMatches finds a mood keyword inside any part of a compound tag', () => {
  const dark = M.moodById('dark')
  assert.ok(M.genreMatches({ genre: 'Doom Metal, Sludge' }, dark))
  assert.ok(M.genreMatches({ genre: 'Progressive Rock' }, M.moodById('epic')))
  assert.ok(!M.genreMatches({ genre: 'Library' }, dark))
  assert.ok(!M.genreMatches({ genre: null }, dark))
})

// ── Analysis-based moods ─────────────────────────────────────────────────────
// A tiny library with no genre tags at all (the reported install), where the
// audio analysis is the only thing that knows anything.
function vec(energy, brightness, dynamics, density, punch) {
  return { vector: { energy, brightness, dynamics, density, punch } }
}
const FEATURES = {
  '/a1.flac': vec(0.9, 0.7, 0.3, 0.8, 0.9), '/a2.flac': vec(0.8, 0.6, 0.3, 0.7, 0.8),   // loud + punchy
  '/b1.flac': vec(0.2, 0.3, 0.6, 0.2, 0.1), '/b2.flac': vec(0.2, 0.3, 0.5, 0.2, 0.1),   // quiet, airy
  '/c1.flac': vec(0.5, 0.1, 0.8, 0.6, 0.3),                                             // dark, dynamic
  '/d1.flac': vec(0.5, 0.9, 0.4, 0.4, 0.5),                                             // bright
}
function lib() {
  return [
    { id: 'A', name: 'Loud', artist: 'X', genre: null, tracks: [{ filePath: '/a1.flac' }, { filePath: '/a2.flac' }] },
    { id: 'B', name: 'Quiet', artist: 'Y', genre: null, tracks: [{ filePath: '/b1.flac' }, { filePath: '/b2.flac' }] },
    { id: 'C', name: 'Dark', artist: 'Z', genre: null, tracks: [{ filePath: '/c1.flac' }] },
    { id: 'D', name: 'Bright', artist: 'W', genre: null, tracks: [{ filePath: '/d1.flac' }] },
    { id: 'E', name: 'Unmeasured', artist: 'V', genre: null, tracks: [{ filePath: '/none.flac' }] },
  ]
}

test('albumVector averages the analysed tracks and is null for an unmeasured album', () => {
  const v = M.albumVector(lib()[0], FEATURES)
  assert.ok(Math.abs(v.energy - 0.85) < 1e-9)
  assert.equal(M.albumVector(lib()[4], FEATURES), null)
  assert.equal(M.albumVector(lib()[0], null), null)
  // The bare-vector shape works too.
  assert.ok(M.albumVector({ tracks: [{ filePath: '/x' }] }, { '/x': { energy: 1, brightness: 1, dynamics: 1, density: 1, punch: 1 } }).energy === 1)
})

test('with no genre tags at all, moods come from the analysis, relative to this library', () => {
  const L = lib()
  const energetic = M.albumsForMood(L, FEATURES, 'energetic').map(x => x.album.id)
  const chill = M.albumsForMood(L, FEATURES, 'chill').map(x => x.album.id)
  const dark = M.albumsForMood(L, FEATURES, 'dark').map(x => x.album.id)
  const happy = M.albumsForMood(L, FEATURES, 'happy').map(x => x.album.id)
  assert.deepEqual(energetic, ['A'])
  assert.deepEqual(chill, ['B'])
  assert.ok(dark.indexOf('C') === 0, 'the dark one leads: ' + dark)
  assert.ok(happy.indexOf('D') === 0, 'the bright one leads: ' + happy)
  assert.ok(!energetic.includes('E') && !chill.includes('E'), 'an unmeasured, untagged album never appears')
  assert.equal(M.albumsForMood(L, FEATURES, 'energetic')[0].via, 'analysis')
})

test('a genre tag admits an album the analysis knows nothing about, and marks how', () => {
  const L = lib()
  L[4].genre = 'Doom Metal'
  const dark = M.albumsForMood(L, FEATURES, 'dark')
  const e = dark.find(x => x.album.id === 'E')
  assert.ok(e && e.via === 'genre')
  L[2].genre = 'Black Metal'
  assert.equal(M.albumsForMood(L, FEATURES, 'dark').find(x => x.album.id === 'C').via, 'both')
})

test('moodCounts gives every mood a number, the profile says how much is analysed', () => {
  const counts = M.moodCounts(lib(), FEATURES)
  assert.deepEqual(Object.keys(counts).sort(), M.MOODS.map(m => m.id).sort())
  assert.equal(counts.energetic, 1)
  const p = M.profile(lib(), FEATURES)
  assert.equal(p.analysed, 4)
  assert.equal(p.total, 5)
})

test('unknown mood, empty library and missing features are all harmless', () => {
  assert.deepEqual(M.albumsForMood(lib(), FEATURES, 'nope'), [])
  assert.deepEqual(M.albumsForMood([], FEATURES, 'chill'), [])
  assert.deepEqual(M.albumsForMood(lib(), null, 'chill'), [])
  assert.deepEqual(M.albumsForMood(null, null, 'chill'), [])
  assert.equal(M.moodById('x'), null)
})

test('every mood has an emoji, a colour, keywords, and analysis weights', () => {
  for (const m of M.MOODS) {
    assert.ok(m.id && m.name && m.emoji && m.color)
    assert.ok(m.genres.length >= 5)
    assert.ok(Object.keys(m.weights).length >= 2)
    for (const k of Object.keys(m.weights)) assert.ok(M.FEATURE_KEYS.includes(k), k)
  }
})
