'use strict'
const test = require('node:test')
const assert = require('node:assert')
const N = require('../src/anime-numbering')

// A tiny in-memory PapaLocal stand-in: readObject/write/remove over one object,
// matching the shape src/local-store.js exposes.
function fakeStore(seed) {
  const data = Object.assign({}, seed)
  return {
    _data: data,
    readObject(key) {
      const v = data[key]
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    },
    write(key, value) { data[key] = value; return true },
    remove(key) { delete data[key]; return true },
  }
}

// ── normalizeStart ────────────────────────────────────────────────────────────
test('normalizeStart accepts whole numbers >= 1 and floors, rejects the rest', () => {
  assert.strictEqual(N.normalizeStart(65), 65)
  assert.strictEqual(N.normalizeStart('65'), 65)
  assert.strictEqual(N.normalizeStart(65.9), 65)
  assert.strictEqual(N.normalizeStart(1), 1)
  assert.strictEqual(N.normalizeStart(0), null)
  assert.strictEqual(N.normalizeStart(-3), null)
  assert.strictEqual(N.normalizeStart(''), null)
  assert.strictEqual(N.normalizeStart('abc'), null)
  assert.strictEqual(N.normalizeStart(null), null)
})

// ── absoluteFor: the core math ────────────────────────────────────────────────
test('absoluteFor shifts episode E to N + (E - 1)', () => {
  // "episode 1 is absolute 65": ep 1 -> 65, ep 2 -> 66, ep 10 -> 74.
  assert.strictEqual(N.absoluteFor(65, 1), 65)
  assert.strictEqual(N.absoluteFor(65, 2), 66)
  assert.strictEqual(N.absoluteFor(65, 10), 74)
})

test('absoluteFor treats the identity (start 1) and bad input as no override', () => {
  assert.strictEqual(N.absoluteFor(1, 5), null)
  assert.strictEqual(N.absoluteFor(null, 5), null)
  assert.strictEqual(N.absoluteFor(65, 0), null)
  assert.strictEqual(N.absoluteFor(65, null), null)
  assert.strictEqual(N.absoluteFor(65, 'x'), null)
})

// ── persistence: get / set / clear ────────────────────────────────────────────
test('set then get round-trips a per-id override', () => {
  const store = fakeStore()
  assert.strictEqual(N.set(store, 12345, 65), 65)
  assert.strictEqual(N.get(store, 12345), 65)
  // A different id is independent.
  assert.strictEqual(N.get(store, 999), null)
  N.set(store, 999, 13)
  assert.strictEqual(N.get(store, 999), 13)
  assert.strictEqual(N.get(store, 12345), 65)
})

test('the map is keyed by string id so a number and its string agree', () => {
  const store = fakeStore()
  N.set(store, 12345, 65)
  assert.strictEqual(N.get(store, '12345'), 65)
})

test('setting the identity (1) or a bad value clears the entry', () => {
  const store = fakeStore()
  N.set(store, 7, 65)
  assert.strictEqual(N.set(store, 7, 1), null)
  assert.strictEqual(N.get(store, 7), null)
  N.set(store, 7, 65)
  assert.strictEqual(N.set(store, 7, 0), null)
  assert.strictEqual(N.get(store, 7), null)
})

test('clear removes an override and empties the key when it was the last one', () => {
  const store = fakeStore()
  N.set(store, 7, 65)
  N.clear(store, 7)
  assert.strictEqual(N.get(store, 7), null)
  // Last entry gone -> the whole key is removed, not left as {}.
  assert.strictEqual(store._data[N.KEY], undefined)
})

test('get is tolerant of a missing store, a bad blob and a missing member', () => {
  assert.strictEqual(N.get(null, 7), null)
  assert.strictEqual(N.get(fakeStore(), 7), null)
  const bad = { readObject() { return null }, write() {}, remove() {} }
  assert.strictEqual(N.get(bad, 7), null)
})

// ── applyToRequest: the renderer-only apply path ──────────────────────────────
test('applyToRequest shifts episode and drops anilistId so main cannot re-derive', () => {
  const req = { type: 'anime', anilistId: 12345, episode: 3, titles: { romaji: 'X' }, sub: false, dub: true }
  const out = N.applyToRequest(req, 65)
  assert.strictEqual(out.episode, 67)          // 65 + (3 - 1)
  assert.strictEqual(out.anilistId, undefined) // suppresses main's auto walk
  assert.strictEqual(out._numberingOverride, 67)
  // The rest of the request survives untouched.
  assert.deepStrictEqual(out.titles, { romaji: 'X' })
  assert.strictEqual(out.dub, true)
  // The input object is not mutated.
  assert.strictEqual(req.episode, 3)
  assert.strictEqual(req.anilistId, 12345)
})

test('applyToRequest is a pass-through with no override or a non-anime request', () => {
  const anime = { type: 'anime', anilistId: 1, episode: 3 }
  assert.strictEqual(N.applyToRequest(anime, null), anime)   // no override
  assert.strictEqual(N.applyToRequest(anime, 1), anime)      // identity
  const movie = { type: 'movie', tmdbId: 9, episode: 3 }
  assert.strictEqual(N.applyToRequest(movie, 65), movie)     // not anime
})

test('applyToRequest also clears a stray absoluteEpisode field', () => {
  const req = { type: 'anime', anilistId: 1, episode: 2, absoluteEpisode: 999 }
  const out = N.applyToRequest(req, 65)
  assert.strictEqual(out.episode, 66)
  assert.strictEqual(out.absoluteEpisode, undefined)
})
