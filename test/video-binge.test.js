'use strict'
// Episode advance and watch-state wiring. _nextEpisodeOf is pure, so it is
// extracted and run for real rather than asserted against source text.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

const ctx = { console }
vm.createContext(ctx)
vm.runInContext(extract('_nextEpisodeOf'), ctx)
vm.runInContext(extract('_watchKey'), ctx)
// Objects built inside the vm belong to another realm, so deepStrictEqual
// fails on prototype identity even when the values match. Spreading gives the
// result this realm's prototype without weakening the comparison.
const plain = o => (o == null ? o : { ...o })
const nextEpisodeOf = (...a) => plain(ctx._nextEpisodeOf(...a))
const watchKey = ctx._watchKey

const show = seasons => ({
  type: 'tv',
  d: { id: 1396, title: 'X', seasons: seasons.map(([n, c]) => ({ seasonNumber: n, episodeCount: c })) },
})

test('a film has no next episode', () => {
  assert.strictEqual(nextEpisodeOf({ type: 'movie', d: { id: 1 } }, { episode: 1 }), null)
  assert.strictEqual(nextEpisodeOf(null, {}), null)
})

test('advancing within a season increments the episode', () => {
  assert.deepStrictEqual(
    nextEpisodeOf(show([[1, 7]]), { season: 1, episode: 3 }),
    { season: 1, episode: 4 }
  )
})

test('the end of a season rolls into the next one at episode 1', () => {
  assert.deepStrictEqual(
    nextEpisodeOf(show([[1, 7], [2, 13]]), { season: 1, episode: 7 }),
    { season: 2, episode: 1 }
  )
})

// Specials are season 0 and are never what "next" means after a finale.
test('season 0 specials are skipped when rolling over', () => {
  assert.deepStrictEqual(
    nextEpisodeOf(show([[0, 4], [1, 7], [2, 10]]), { season: 1, episode: 7 }),
    { season: 2, episode: 1 }
  )
})

test('the last episode of the last season has no next', () => {
  assert.strictEqual(nextEpisodeOf(show([[1, 7], [2, 13]]), { season: 2, episode: 13 }), null)
})

// TMDB sometimes reports episodeCount as 0 for an airing season; refusing to
// advance there would strand the user mid-series.
test('an unknown episode count still advances', () => {
  assert.deepStrictEqual(
    nextEpisodeOf(show([[1, 0]]), { season: 1, episode: 5 }),
    { season: 1, episode: 6 }
  )
})

test('anime advances by episode and stops at the known total', () => {
  const anime = { type: 'anime', d: { id: 21, episodeCount: 12 } }
  assert.deepStrictEqual(nextEpisodeOf(anime, { episode: 3 }), { season: null, episode: 4 })
  assert.strictEqual(nextEpisodeOf(anime, { episode: 12 }), null)
})

test('an anime with no episode count keeps advancing', () => {
  const ongoing = { type: 'anime', d: { id: 21, episodeCount: null } }
  assert.deepStrictEqual(nextEpisodeOf(ongoing, { episode: 1100 }), { season: null, episode: 1101 })
})

// A film, an episode and an anime episode must never collide in the store, or
// resuming one would jump you into another.
test('watch keys are distinct per title and per episode', () => {
  assert.strictEqual(watchKey('movie', 27205), 'movie:27205')
  assert.strictEqual(watchKey('tv', 1396, 1, 2), 'tv:1396:s1e2')
  assert.strictEqual(watchKey('tv', 1396, 2, 1), 'tv:1396:s2e1')
  assert.strictEqual(watchKey('anime', 21, null, 9), 'anime:21:e9')
  const keys = [watchKey('movie', 1), watchKey('tv', 1, 1, 1), watchKey('anime', 1, null, 1)]
  assert.strictEqual(new Set(keys).size, 3, 'the same id in different catalogs must not collide')
})

// ── Store wiring, against the real store with in-memory storage ──────────────
const { createVideoStore, _memoryStorage } = require('../src/video-store')

test('a position written during playback comes back for resume', () => {
  const store = createVideoStore({ storage: _memoryStorage() })
  const key = watchKey('tv', 1396, 1, 2)
  store.setPosition(key, { type: 'tv', id: 1396, title: 'X' }, 1800, 3600)
  const saved = store.get(key)
  assert.strictEqual(saved.position, 1800)
  assert.strictEqual(saved.watched, false)
  assert.strictEqual(saved.title, 'X')
})

test('past ninety percent counts as watched and leaves Continue Watching', () => {
  const store = createVideoStore({ storage: _memoryStorage() })
  const key = watchKey('movie', 1)
  store.setPosition(key, { type: 'movie', id: 1, title: 'Film' }, 3500, 3600)
  assert.strictEqual(store.get(key).watched, true)
  assert.ok(!store.continueWatching(10).some(i => i.title === 'Film'))
})

test('barely started is not "in progress"', () => {
  const store = createVideoStore({ storage: _memoryStorage() })
  store.setPosition(watchKey('movie', 2), { type: 'movie', id: 2, title: 'Barely' }, 5, 3600)
  assert.ok(!store.continueWatching(10).some(i => i.title === 'Barely'))
})

test('Continue Watching is newest first', () => {
  let t = 1000
  const store = createVideoStore({ storage: _memoryStorage(), now: () => t })
  store.setPosition(watchKey('movie', 1), { type: 'movie', id: 1, title: 'First' }, 900, 3600)
  t = 2000
  store.setPosition(watchKey('movie', 2), { type: 'movie', id: 2, title: 'Second' }, 900, 3600)
  assert.strictEqual(store.continueWatching(10)[0].title, 'Second')
})

// This is the bug the catalog shipped with: toggleWatchlist returns the new
// list, and an array is always truthy, so the UI always said "Added".
test('toggleWatchlist returns a list, so membership must be asked for', () => {
  const store = createVideoStore({ storage: _memoryStorage() })
  const item = { type: 'movie', id: 7, title: 'Z' }
  const afterAdd = store.toggleWatchlist(item)
  assert.ok(Array.isArray(afterAdd), 'the return value is a list, not a boolean')
  assert.strictEqual(store.inWatchlist('movie', 7), true)
  const afterRemove = store.toggleWatchlist(item)
  assert.ok(Array.isArray(afterRemove))
  assert.ok(afterRemove.length === 0 || !store.inWatchlist('movie', 7))
  assert.strictEqual(store.inWatchlist('movie', 7), false)
})
