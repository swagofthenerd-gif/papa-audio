'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createVideoStore, _memoryStorage, WATCHED_AT, MIN_PROGRESS } = require('../src/video-store')

let now = 1000000
function makeStore(seed) {
  const storage = _memoryStorage(seed)
  const store = createVideoStore({ storage, now: () => now })
  return { store, storage }
}

test('get returns null for an unknown key', () => {
  const { store } = makeStore()
  assert.strictEqual(store.get('movie:1'), null)
})

test('setPosition upserts and recomputes watched from the ratio', () => {
  const { store } = makeStore()
  const item = store.setPosition('movie:27205', { type: 'movie', id: 27205, title: 'Inception' }, 900, 1000)
  assert.strictEqual(item.watched, true, '900/1000 ≥ 90%')
  assert.strictEqual(item.position, 900)
  assert.strictEqual(item.duration, 1000)
  assert.strictEqual(item.type, 'movie')
  assert.strictEqual(item.title, 'Inception')
  assert.strictEqual(item.updatedAt, now)
  assert.strictEqual(store.get('movie:27205').watched, true)
})

test('setPosition below the threshold stays unfinished', () => {
  const { store } = makeStore()
  const item = store.setPosition('tv:1396:s1e2', { type: 'tv', id: 1396, season: 1, episode: 2 }, 500, 1000)
  assert.strictEqual(item.watched, false)
})

test('setPosition merges into an existing item rather than clobbering it', () => {
  const { store } = makeStore()
  store.setPosition('movie:1', { type: 'movie', id: 1, title: 'First', poster: '/p.jpg' }, 100, 1000)
  now += 5000
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 800, 1000)
  const item = store.get('movie:1')
  // title/poster survive a position-only update because meta is merged, not replaced.
  assert.strictEqual(item.title, 'First')
  assert.strictEqual(item.poster, '/p.jpg')
  assert.strictEqual(item.position, 800)
  assert.strictEqual(item.watched, false)
})

test('markWatched sets watched and touches updatedAt', () => {
  const { store } = makeStore()
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 100, 1000)
  now += 1000
  const item = store.markWatched('movie:1')
  assert.strictEqual(item.watched, true)
  assert.strictEqual(item.updatedAt, now)
})

test('continueWatching returns unfinished items newest-first', () => {
  const { store } = makeStore()
  store.setPosition('movie:a', { type: 'movie', id: 'a' }, 500, 1000) // in progress
  now += 1000
  store.setPosition('movie:b', { type: 'movie', id: 'b' }, 950, 1000) // watched
  now += 1000
  store.setPosition('movie:c', { type: 'movie', id: 'c' }, 10, 1000)  // under 2% → not in progress
  now += 1000
  store.setPosition('movie:d', { type: 'movie', id: 'd' }, 300, 1000) // in progress
  const rows = store.continueWatching()
  assert.deepStrictEqual(rows.map(r => r.id), ['d', 'a'])
})

test('continueWatching respects a limit', () => {
  const { store } = makeStore()
  for (let i = 0; i < 5; i++) {
    now += 1000
    store.setPosition(`movie:${i}`, { type: 'movie', id: i }, 500, 1000)
  }
  assert.strictEqual(store.continueWatching(2).length, 2)
  assert.strictEqual(store.continueWatching(2)[0].id, 4)
})

test('anything under 2% is not in progress', () => {
  const { store } = makeStore()
  store.setPosition('movie:x', { type: 'movie', id: 'x' }, 19, 1000)
  assert.deepStrictEqual(store.continueWatching(), [])
})

test('a zero duration is never in progress', () => {
  const { store } = makeStore()
  store.setPosition('movie:z', { type: 'movie', id: 'z' }, 500, 0)
  assert.deepStrictEqual(store.continueWatching(), [])
})

test('watchlist toggle adds then removes, preserving insertion order', () => {
  const { store } = makeStore()
  const a = { type: 'movie', id: 1, title: 'A' }
  const b = { type: 'tv', id: 2, title: 'B' }
  assert.deepStrictEqual(store.toggleWatchlist(a).map(x => x.id), [1])
  assert.deepStrictEqual(store.toggleWatchlist(b).map(x => x.id), [1, 2])
  assert.strictEqual(store.inWatchlist('movie', 1), true)
  assert.strictEqual(store.inWatchlist('tv', 2), true)
  assert.strictEqual(store.inWatchlist('movie', 99), false)
  assert.deepStrictEqual(store.toggleWatchlist(a).map(x => x.id), [2])
  assert.strictEqual(store.inWatchlist('movie', 1), false)
})

test('watchlist entries carry addedAt and nulls for missing metadata', () => {
  const { store } = makeStore()
  const list = store.toggleWatchlist({ type: 'tv', id: 9 })
  assert.strictEqual(list[0].addedAt, now)
  assert.strictEqual(list[0].title, null)
  assert.strictEqual(list[0].poster, null)
})

test('history returns watched items newest-first', () => {
  const { store } = makeStore()
  store.setPosition('movie:a', { type: 'movie', id: 'a' }, 500, 1000)
  now += 1000
  store.setPosition('movie:b', { type: 'movie', id: 'b' }, 1000, 1000) // watched
  now += 1000
  store.markWatched('movie:a')
  const hist = store.history()
  assert.deepStrictEqual(hist.map(r => r.id), ['a', 'b'])
})

test('prefs start empty and merge patches', () => {
  const { store } = makeStore()
  assert.deepStrictEqual(store.prefs('tv:1396'), {})
  store.setPrefs('tv:1396', { autoNext: true })
  store.setPrefs('tv:1396', { subLang: 'en' })
  assert.deepStrictEqual(store.prefs('tv:1396'), { autoNext: true, subLang: 'en' })
  // A different show has its own prefs.
  assert.deepStrictEqual(store.prefs('tv:999'), {})
})

test('setPrefs ignores a non-object patch', () => {
  const { store } = makeStore()
  store.setPrefs('tv:1', { a: 1 })
  store.setPrefs('tv:1', null)
  assert.deepStrictEqual(store.prefs('tv:1'), { a: 1 })
})

test('skip segments round-trip per season key', () => {
  const { store } = makeStore()
  const segments = [
    { kind: 'intro', start: 28.7, end: 118.7, origin: 'aniskip', confidence: 0.9 },
    { kind: 'credits', start: 1388, end: 1500, origin: 'chapters', confidence: 0.8 },
  ]
  assert.deepStrictEqual(store.skip('tv:1396:s1'), [])
  const saved = store.setSkip('tv:1396:s1', segments)
  assert.deepStrictEqual(saved, segments)
  assert.deepStrictEqual(store.skip('tv:1396:s1'), segments)
  assert.deepStrictEqual(store.skip('tv:1396:s2'), [])
})

test('the store persists across instances through the shared storage', () => {
  const storage = _memoryStorage()
  const a = createVideoStore({ storage, now: () => now })
  a.setPosition('movie:1', { type: 'movie', id: 1, title: 'Persist' }, 400, 1000)
  const b = createVideoStore({ storage, now: () => now })
  assert.strictEqual(b.get('movie:1').title, 'Persist')
  assert.strictEqual(b.get('movie:1').position, 400)
})

test('a corrupt or wrong-shaped blob is sanitised to defaults', () => {
  for (const seed of [null, 'garbage', [], 42, { items: 'nope', watchlist: {}, skip: [], prefs: 'x' }]) {
    const storage = _memoryStorage(seed)
    const store = createVideoStore({ storage })
    assert.deepStrictEqual(store._dump(), { items: {}, watchlist: [], skip: {}, prefs: {} })
  }
})

test('WATCHED_AT and MIN_PROGRESS are the documented thresholds', () => {
  assert.strictEqual(WATCHED_AT, 0.9)
  assert.strictEqual(MIN_PROGRESS, 0.02)
})
