'use strict'
// Diary auto-log (roadmap #34): the video store fires an onWatched hook exactly
// on the watched false→true transition, and the key+day dedupe helpers match how
// the taste-store diary keys its entries.
const test = require('node:test')
const assert = require('node:assert')

const VS = require('../src/video-store')

function fixedClock(ts) { return () => ts }

test('onWatched fires once when an item flips to watched via setPosition', () => {
  const fired = []
  const store = VS.createVideoStore({
    storage: VS._memoryStorage(),
    bridge: null,
    onWatched: p => fired.push(p),
    now: fixedClock(1700000000000),
  })
  // A movie: needs a plausible duration (>= 15 min) and >= 90% to count watched.
  store.setPosition('movie:100', { type: 'movie', id: '100', title: 'Heat' }, 100, 6000)   // 1.6% — not watched
  assert.strictEqual(fired.length, 0)
  store.setPosition('movie:100', { type: 'movie', id: '100', title: 'Heat' }, 5700, 6000)   // 95% — watched
  assert.strictEqual(fired.length, 1)
  assert.strictEqual(fired[0].key, 'movie:100')
  assert.strictEqual(fired[0].type, 'movie')
  assert.strictEqual(fired[0].id, '100')
  assert.strictEqual(fired[0].title, 'Heat')
  assert.strictEqual(fired[0].watchedAt, 1700000000000)
})

test('a re-save of an already-watched item does NOT fire the hook again', () => {
  const fired = []
  const store = VS.createVideoStore({
    storage: VS._memoryStorage(), bridge: null,
    onWatched: p => fired.push(p), now: fixedClock(1700000000000),
  })
  store.setPosition('movie:1', { type: 'movie', id: '1' }, 5700, 6000)   // -> watched
  store.setPosition('movie:1', { type: 'movie', id: '1' }, 5900, 6000)   // still watched
  assert.strictEqual(fired.length, 1, 'transition fires once, not per position tick')
})

test('markWatched fires the hook on a fresh item, carrying episode fields', () => {
  const fired = []
  const store = VS.createVideoStore({
    storage: VS._memoryStorage(), bridge: null,
    onWatched: p => fired.push(p), now: fixedClock(1700000000000),
  })
  store.setPosition('tv:1396:s1e2', { type: 'tv', id: '1396', title: 'Breaking Bad', season: 1, episode: 2 }, 60, 1500)
  assert.strictEqual(fired.length, 0)   // 4% — in progress, not watched
  store.markWatched('tv:1396:s1e2')
  assert.strictEqual(fired.length, 1)
  assert.strictEqual(fired[0].type, 'tv')
  assert.strictEqual(fired[0].season, 1)
  assert.strictEqual(fired[0].episode, 2)
})

test('the hook throwing never breaks the save', () => {
  const store = VS.createVideoStore({
    storage: VS._memoryStorage(), bridge: null,
    onWatched: () => { throw new Error('boom') },
    now: fixedClock(1),
  })
  assert.doesNotThrow(() => store.setPosition('movie:9', { type: 'movie', id: '9' }, 5700, 6000))
  assert.strictEqual(store.get('movie:9').watched, true)
})

test('watchedLogKey is key@day', () => {
  const key = VS.watchedLogKey({ key: 'movie:5', watchedAt: Date.UTC(2026, 8, 6, 15, 0) + new Date(2026, 8, 6, 15, 0).getTimezoneOffset() * 0 })
  // Compute the expected local day the same way the helper does.
  const day = VS._dayOf(new Date(2026, 8, 6, 15, 0).getTime())
  assert.strictEqual(VS.watchedLogKey({ key: 'movie:5', watchedAt: new Date(2026, 8, 6, 15, 0).getTime() }), 'movie:5@' + day)
  assert.ok(key === null || typeof key === 'string')
})

test('alreadyLogged dedupes by key AND day', () => {
  const watchedAt = new Date(2026, 8, 6, 20, 0).getTime()
  const day = VS._dayOf(watchedAt)
  const payload = { key: 'movie:5', watchedAt }
  // A diary entry for the same title on the same day means "already logged".
  assert.strictEqual(alreadyDay(payload, [{ key: 'movie:5', date: day }]), true)
  // A different day does not dedupe — a rewatch tomorrow is a new entry.
  assert.strictEqual(alreadyDay(payload, [{ key: 'movie:5', date: '2020-01-01' }]), false)
  // A different title does not dedupe.
  assert.strictEqual(alreadyDay(payload, [{ key: 'movie:6', date: day }]), false)

  function alreadyDay(p, entries) { return VS.alreadyLogged(p, entries) }
})
