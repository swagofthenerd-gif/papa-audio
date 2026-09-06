'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createVideoStore, _memoryStorage, _memoryBridge, WATCHED_AT, MIN_PROGRESS, MAX_ITEMS } = require('../src/video-store')

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

// ── Watched-duration guard (audit #8) ────────────────────────────────────────

test('setPosition does not mark watched when an episode duration is implausibly short', () => {
  const { store } = makeStore()
  // A 91s "duration" on a 24-min episode, position near its end. The old code
  // computed 87/91 ≥ 90% and set watched:true from a bogus duration.
  const item = store.setPosition('tv:1396:s1e18', { type: 'tv', id: 1396, season: 1, episode: 18 }, 87.5, 91.095)
  assert.strictEqual(item.watched, false, 'a 91s duration is not a plausible episode length')
})

test('setPosition does not mark watched when a movie duration is implausibly short', () => {
  const { store } = makeStore()
  // 200s is under the 15-min movie floor even though 190/200 ≥ 90%.
  const item = store.setPosition('movie:27205', { type: 'movie', id: 27205 }, 190, 200)
  assert.strictEqual(item.watched, false)
})

test('setPosition still marks watched at a plausible episode duration', () => {
  const { store } = makeStore()
  const item = store.setPosition('tv:1396:s1e2', { type: 'tv', id: 1396 }, 1350, 1440)
  assert.strictEqual(item.watched, true, '1440s is a real 24-min episode')
})

test('an implausibly short duration does not overwrite a longer recorded duration', () => {
  const { store } = makeStore()
  store.setPosition('tv:1396:s1e3', { type: 'tv', id: 1396 }, 600, 1440) // real 24-min duration
  now += 1000
  // A later tick from a bogus pack extra reports a 90s duration — keep 1440.
  const item = store.setPosition('tv:1396:s1e3', { type: 'tv', id: 1396 }, 80, 90)
  assert.strictEqual(item.duration, 1440, 'the longer, plausible duration is kept')
  assert.strictEqual(item.watched, false)
})

// ── Empty-id ghost guard (audit #5) ───────────────────────────────────────────

test('setPosition refuses to write an entry with an empty id', () => {
  const { store } = makeStore()
  const item = store.setPosition('movie:', { type: 'movie' }, 500, 1000)
  assert.strictEqual(item, null, 'no ghost entry is created')
  assert.deepStrictEqual(store._dump().items, {})
})

test('load drops stored ghost entries whose key has an empty id', () => {
  const seed = {
    items: {
      'movie:': { type: 'movie', position: 500, duration: 1000, updatedAt: 5 },
      'tv:': { type: 'tv', position: 100, duration: 1000, updatedAt: 6 },
      'movie:27205': { type: 'movie', id: 27205, position: 500, duration: 1000, updatedAt: 7 },
    },
    watchlist: [], skip: {}, prefs: {},
  }
  const store = createVideoStore({ storage: _memoryStorage(seed), now: () => now })
  const items = store._dump().items
  assert.ok(!('movie:' in items), 'the empty-id movie ghost is purged')
  assert.ok(!('tv:' in items), 'the empty-id tv ghost is purged')
  assert.ok('movie:27205' in items, 'the real entry survives')
})

// ── One card per show collapse (audit #6/#13) ─────────────────────────────────

test('continueWatching collapses episodes of one show to the latest episode', () => {
  const { store } = makeStore()
  store.setPosition('tv:99:s1e25', { type: 'tv', id: 99, season: 1, episode: 25 }, 500, 1440)
  now += 1000
  store.setPosition('tv:99:s1e26', { type: 'tv', id: 99, season: 1, episode: 26 }, 300, 1440)
  const rows = store.continueWatching()
  assert.strictEqual(rows.length, 1, 'one card per show')
  assert.strictEqual(rows[0].episode, 26, 'the most recently watched episode wins')
})

test('continueWatching keeps movies individual', () => {
  const { store } = makeStore()
  store.setPosition('movie:a', { type: 'movie', id: 'a' }, 500, 1000)
  now += 1000
  store.setPosition('movie:b', { type: 'movie', id: 'b' }, 500, 1000)
  assert.strictEqual(store.continueWatching().length, 2)
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
  assert.strictEqual(store.continueWatching(2)[0].id, '4')
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
  // Ids are normalised to strings at the boundary, whatever the caller sent.
  assert.deepStrictEqual(store.toggleWatchlist(a).map(x => x.id), ['1'])
  assert.deepStrictEqual(store.toggleWatchlist(b).map(x => x.id), ['1', '2'])
  assert.strictEqual(store.inWatchlist('movie', 1), true)
  assert.strictEqual(store.inWatchlist('tv', 2), true)
  assert.strictEqual(store.inWatchlist('movie', 99), false)
  assert.deepStrictEqual(store.toggleWatchlist(a).map(x => x.id), ['2'])
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
  assert.strictEqual(MAX_ITEMS, 1000)
})

// ── Corruption: quarantine, backup, recovery ─────────────────────────────────

// A storage that mimics localStorage the way the browser adapter sees it: the
// main key is raw text, so a truncated blob is visible as a parse failure
// instead of dissolving into {}.
function rawStorage(text) {
  const slots = { main: text === undefined ? null : text, bak: null, corrupt: null }
  return {
    readRaw: () => slots.main,
    write: v => { slots.main = JSON.stringify(v); return true },
    readBackup: () => slots.bak,
    writeBackup: v => { slots.bak = JSON.parse(JSON.stringify(v)); return true },
    quarantine: t => { slots.corrupt = t; return true },
    _slots: slots,
  }
}

test('a corrupt blob is quarantined, not overwritten', () => {
  const truncated = '{"items":{"movie:1":{"type":"movie","id":"1","posi'
  const storage = rawStorage(truncated)
  const store = createVideoStore({ storage, now: () => now })
  store.setPosition('movie:2', { type: 'movie', id: 2 }, 500, 1000)
  // The raw bytes survive under the quarantine slot even after a save has
  // rewritten the main key.
  assert.strictEqual(storage._slots.corrupt, truncated)
  assert.match(storage._slots.main, /movie:2/)
})

test('a corrupt blob recovers from the backup when one parses', () => {
  const bak = { items: {}, watchlist: [{ type: 'movie', id: '7', title: 'Kept', poster: null, addedAt: 1 }], skip: {}, prefs: {} }
  const storage = rawStorage('garbage{')
  storage._slots.bak = bak
  const store = createVideoStore({ storage, now: () => now })
  // Recovered from .bak beats starting empty — and the corrupt original is
  // still quarantined.
  assert.strictEqual(store.inWatchlist('movie', 7), true)
  assert.strictEqual(storage._slots.corrupt, 'garbage{')
  // The main key was rewritten with the recovered state right away.
  assert.match(storage._slots.main, /Kept/)
})

test('a corrupt blob with no backup starts empty, still quarantined', () => {
  const storage = rawStorage('{half a blob')
  const store = createVideoStore({ storage, now: () => now })
  assert.deepStrictEqual(store._dump(), { items: {}, watchlist: [], skip: {}, prefs: {} })
  assert.strictEqual(storage._slots.corrupt, '{half a blob')
})

test('the first valid load of a session refreshes the rolling backup', () => {
  const good = { items: {}, watchlist: [{ type: 'tv', id: '3', title: 'B', poster: null, addedAt: 1 }], skip: {}, prefs: {} }
  const storage = rawStorage(JSON.stringify(good))
  const store = createVideoStore({ storage, now: () => now })
  store.watchlist() // trigger the load
  assert.strictEqual(storage._slots.bak.watchlist[0].title, 'B')
})

test('an absent or invalid blob does not clobber the backup', () => {
  for (const text of [null, '42', '[]']) {
    const storage = rawStorage(text)
    storage._slots.bak = { items: {}, watchlist: [], skip: {}, prefs: { 'tv:1': { a: 1 } } }
    const store = createVideoStore({ storage, now: () => now })
    store.watchlist()
    assert.deepStrictEqual(storage._slots.bak.prefs, { 'tv:1': { a: 1 } }, `backup survives a stored ${text}`)
  }
})

// ── Write failures: the cache must not diverge silently ──────────────────────

test('storageHealthy reports a failed write and recovers on the next one', () => {
  let broken = false
  let value = null
  const storage = {
    read: () => value,
    write: v => { if (broken) return false; value = v; return true },
  }
  const store = createVideoStore({ storage, now: () => now })
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 100, 1000)
  assert.strictEqual(store.storageHealthy(), true)
  broken = true
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 200, 1000)
  assert.strictEqual(store.storageHealthy(), false)
  // Every save writes the whole blob, so the next save is the retry.
  broken = false
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 300, 1000)
  assert.strictEqual(store.storageHealthy(), true)
  assert.strictEqual(value.items['movie:1'].position, 300)
})

test('a write that throws is a failure, not a crash', () => {
  const storage = {
    read: () => null,
    write: () => { throw new Error('QuotaExceededError') },
  }
  const store = createVideoStore({ storage, now: () => now })
  assert.doesNotThrow(() => store.markWatched('movie:1'))
  assert.strictEqual(store.storageHealthy(), false)
})

// ── Id normalisation ─────────────────────────────────────────────────────────

test('a number id and its string twin are the same watchlist entry', () => {
  const { store } = makeStore()
  // Added from an API object (number), toggled off from a DOM data attribute
  // (string) — the old strict comparison saw two different shows.
  store.toggleWatchlist({ type: 'movie', id: 27205, title: 'Inception' })
  assert.strictEqual(store.inWatchlist('movie', '27205'), true)
  assert.deepStrictEqual(store.toggleWatchlist({ type: 'movie', id: '27205' }), [])
})

test('stored duplicate ids are deduped on load, keeping the newer entry', () => {
  const seed = {
    items: { 'movie:5': { type: 'movie', id: 5, position: 10, duration: 100, updatedAt: 1 } },
    watchlist: [
      { type: 'movie', id: 1396, title: 'Old title', poster: null, addedAt: 100 },
      { type: 'movie', id: '1396', title: 'New title', poster: '/p.jpg', addedAt: 200 },
      { type: 'tv', id: 2, title: 'Other', poster: null, addedAt: 150 },
    ],
    skip: {}, prefs: {},
  }
  const store = createVideoStore({ storage: _memoryStorage(seed), now: () => now })
  const list = store.watchlist()
  assert.strictEqual(list.length, 2)
  assert.strictEqual(list[0].id, '1396')
  assert.strictEqual(list[0].title, 'New title', 'the more recently added entry wins')
  // Item ids are normalised too.
  assert.strictEqual(store.get('movie:5').id, '5')
})

test('setPosition normalises the id in meta', () => {
  const { store } = makeStore()
  const item = store.setPosition('movie:9', { type: 'movie', id: 9 }, 100, 1000)
  assert.strictEqual(item.id, '9')
})

// ── Pruning ──────────────────────────────────────────────────────────────────

test('pruning evicts oldest watched items first and spares the watchlist', () => {
  const storage = _memoryStorage()
  const store = createVideoStore({ storage, now: () => now, maxItems: 4 })
  // Oldest and fully watched, but on the watchlist → protected.
  store.toggleWatchlist({ type: 'movie', id: 1, title: 'Listed' })
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 1000, 1000)
  now += 1000
  // Watched, not listed → first out.
  store.setPosition('movie:2', { type: 'movie', id: 2 }, 1000, 1000)
  now += 1000
  // Stale (under 2%) → also evictable.
  store.setPosition('movie:3', { type: 'movie', id: 3 }, 5, 1000)
  now += 1000
  // In progress → kept while anything cheaper remains.
  store.setPosition('movie:4', { type: 'movie', id: 4 }, 500, 1000)
  now += 1000
  // The fifth item pushes past the cap of 4.
  store.setPosition('movie:5', { type: 'movie', id: 5 }, 500, 1000)
  const keys = Object.keys(store._dump().items).sort()
  assert.deepStrictEqual(keys, ['movie:1', 'movie:3', 'movie:4', 'movie:5'],
    'the oldest watched unlisted item goes; the listed one stays')
})

test('pruning falls back to oldest in-progress items when nothing else is left', () => {
  const store = createVideoStore({ storage: _memoryStorage(), now: () => now, maxItems: 2 })
  for (let i = 1; i <= 3; i++) {
    now += 1000
    store.setPosition(`movie:${i}`, { type: 'movie', id: i }, 500, 1000)
  }
  const keys = Object.keys(store._dump().items).sort()
  assert.deepStrictEqual(keys, ['movie:2', 'movie:3'], 'the oldest in-progress item is the sacrifice')
})

test('watchlist items are kept even over the cap', () => {
  const store = createVideoStore({ storage: _memoryStorage(), now: () => now, maxItems: 2 })
  for (let i = 1; i <= 4; i++) {
    now += 1000
    store.toggleWatchlist({ type: 'movie', id: i, title: `M${i}` })
    store.setPosition(`movie:${i}`, { type: 'movie', id: i }, 1000, 1000)
  }
  assert.strictEqual(Object.keys(store._dump().items).length, 4, 'never evicted, even over the cap')
})

test('under the cap nothing is pruned', () => {
  const store = createVideoStore({ storage: _memoryStorage(), now: () => now, maxItems: 10 })
  for (let i = 1; i <= 5; i++) store.setPosition(`movie:${i}`, { type: 'movie', id: i }, 1000, 1000)
  assert.strictEqual(Object.keys(store._dump().items).length, 5)
})

// ── The bridge: hydration, migration, debounce, flush, health ────────────────

// A PapaLocal-shaped fake for the localStorage side of bridge mode: the
// migration source, the quarantine shelf, and the backup fallback.
function fakeLocal(data) {
  const m = new Map(Object.entries(data || {}))
  return {
    readRaw: k => (m.has(k) ? m.get(k) : null),
    writeRaw: (k, t) => { m.set(k, String(t)); return true },
    write: (k, v) => { m.set(k, JSON.stringify(v)); return true },
    remove: k => { m.delete(k); return true },
    _map: m,
  }
}

function blob(patch) {
  return { items: {}, watchlist: [], skip: {}, prefs: {}, ...patch }
}

test('init hydrates the cache from the bridge; every method is synchronous after', async () => {
  const seeded = blob({
    items: { 'movie:1': { type: 'movie', id: '1', position: 400, duration: 1000, updatedAt: 1 } },
    watchlist: [{ type: 'tv', id: '9', title: 'Kept', poster: null, addedAt: 1 }],
  })
  const bridge = _memoryBridge(JSON.stringify(seeded))
  const store = createVideoStore({ bridge, legacy: fakeLocal(), now: () => now })
  await store.init()
  // No awaits from here down — the whole public surface stays synchronous.
  assert.strictEqual(store.get('movie:1').position, 400)
  assert.strictEqual(store.inWatchlist('tv', 9), true)
  assert.strictEqual(store.continueWatching()[0].id, '1')
})

test('a valid bridge blob refreshes the bridge-side rolling backup at init', async () => {
  const bridge = _memoryBridge(JSON.stringify(blob({
    watchlist: [{ type: 'movie', id: '3', title: 'B', poster: null, addedAt: 1 }],
  })))
  const store = createVideoStore({ bridge, legacy: fakeLocal(), now: () => now })
  await store.init()
  assert.match(bridge._bak(), /"B"/)
})

test('first bridge run migrates the localStorage blob and keeps the old copy', async () => {
  const old = JSON.stringify(blob({
    watchlist: [{ type: 'movie', id: '7', title: 'History', poster: null, addedAt: 1 }],
  }))
  const bridge = _memoryBridge() // empty: this is the first run
  const legacy = fakeLocal({ 'papa-video-store': old })
  const store = createVideoStore({ bridge, legacy, now: () => now })
  await store.init()
  // The blob crossed over byte-for-byte…
  assert.strictEqual(bridge._text(), old)
  // …the localStorage copy survives under .migrated, the live key is gone…
  assert.strictEqual(legacy._map.get('papa-video-store.migrated'), old)
  assert.strictEqual(legacy._map.has('papa-video-store'), false)
  // …and this session sees the history without a restart.
  assert.strictEqual(store.inWatchlist('movie', 7), true)
})

test('no migration when the bridge store already has data', async () => {
  const bridge = _memoryBridge(JSON.stringify(blob()))
  const legacy = fakeLocal({ 'papa-video-store': JSON.stringify(blob({ prefs: { 'tv:1': { a: 1 } } })) })
  const store = createVideoStore({ bridge, legacy, now: () => now })
  await store.init()
  // A non-empty bridge store is the source of truth; localStorage is not
  // consulted, renamed, or removed.
  assert.deepStrictEqual(store.prefs('tv:1'), {})
  assert.strictEqual(legacy._map.has('papa-video-store'), true)
  assert.strictEqual(legacy._map.has('papa-video-store.migrated'), false)
})

test('a failed migration write leaves localStorage untouched for the next launch', async () => {
  const old = JSON.stringify(blob({ watchlist: [{ type: 'movie', id: '7', title: 'H', poster: null, addedAt: 1 }] }))
  const bridge = _memoryBridge()
  bridge._fail(true)
  const legacy = fakeLocal({ 'papa-video-store': old })
  const store = createVideoStore({ bridge, legacy, now: () => now })
  await store.init()
  assert.strictEqual(legacy._map.get('papa-video-store'), old, 'the live key is not renamed')
  assert.strictEqual(legacy._map.has('papa-video-store.migrated'), false)
  assert.strictEqual(store.storageHealthy(), false)
  // The session still hydrates from the old blob rather than starting empty.
  assert.strictEqual(store.inWatchlist('movie', 7), true)
})

test('without a bridge, init and flush are settled no-ops over the old path', async () => {
  const storage = _memoryStorage()
  const store = createVideoStore({ storage, now: () => now })
  await store.init()
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 400, 1000)
  // The write already landed synchronously — flush has nothing to wait for.
  assert.strictEqual(storage._dump().items['movie:1'].position, 400)
  assert.strictEqual(await store.flush(), true)
})

test('bridge saves are debounced: many saves, one write, newest blob wins', async () => {
  const bridge = _memoryBridge()
  const store = createVideoStore({ bridge, legacy: fakeLocal(), now: () => now, debounceMs: 60000 })
  await store.init()
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 100, 1000)
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 200, 1000)
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 300, 1000)
  assert.strictEqual(bridge._writes(), 0, 'nothing crosses the bridge inside the debounce window')
  await store.flush()
  assert.strictEqual(bridge._writes(), 1, 'one whole-blob write for three saves')
  assert.match(bridge._text(), /"position":300/)
})

test('the debounce timer fires on its own without a flush', async () => {
  const bridge = _memoryBridge()
  const store = createVideoStore({ bridge, legacy: fakeLocal(), now: () => now, debounceMs: 5 })
  await store.init()
  store.markWatched('movie:1')
  await new Promise(r => setTimeout(r, 40))
  assert.strictEqual(bridge._writes(), 1)
  assert.match(bridge._text(), /"watched":true/)
})

test('flush awaits the pending write and is safe to call when idle', async () => {
  const bridge = _memoryBridge()
  const store = createVideoStore({ bridge, legacy: fakeLocal(), now: () => now, debounceMs: 60000 })
  await store.init()
  assert.strictEqual(await store.flush(), true, 'idle flush settles immediately')
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 500, 1000)
  const ok = await store.flush()
  assert.strictEqual(ok, true)
  assert.match(bridge._text(), /"position":500/, 'the blob is on the bridge before flush resolves')
})

test('a failed bridge write flips health, and the next save is the retry', async () => {
  const bridge = _memoryBridge()
  const store = createVideoStore({ bridge, legacy: fakeLocal(), now: () => now, debounceMs: 0 })
  await store.init()
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 100, 1000)
  await store.flush()
  assert.strictEqual(store.storageHealthy(), true)
  bridge._fail(true)
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 200, 1000)
  await store.flush()
  assert.strictEqual(store.storageHealthy(), false)
  // Every save writes the whole blob, so the next save is the retry.
  bridge._fail(false)
  store.setPosition('movie:1', { type: 'movie', id: 1 }, 300, 1000)
  await store.flush()
  assert.strictEqual(store.storageHealthy(), true)
  assert.match(bridge._text(), /"position":300/)
})

test('a bridge write that rejects is a failure, not a crash', async () => {
  const bridge = {
    read: async () => null,
    write: async () => { throw new Error('IPC gone') },
  }
  const store = createVideoStore({ bridge, legacy: fakeLocal(), now: () => now, debounceMs: 0 })
  await store.init()
  store.markWatched('movie:1')
  await store.flush()
  assert.strictEqual(store.storageHealthy(), false)
})

test('a corrupt bridge blob is quarantined to localStorage and recovers from the bridge backup', async () => {
  const truncated = '{"items":{"movie:1":{"type":"movie","posi'
  const bridge = _memoryBridge(truncated)
  bridge.writeBackup(JSON.stringify(blob({
    watchlist: [{ type: 'movie', id: '7', title: 'Kept', poster: null, addedAt: 1 }],
  })))
  const legacy = fakeLocal()
  const store = createVideoStore({ bridge, legacy, now: () => now, debounceMs: 0 })
  await store.init()
  // The raw bytes survive on the quarantine shelf, the state comes back from
  // the backup, and the recovered blob replaces the corrupt one.
  assert.strictEqual(legacy._map.get('papa-video-store.corrupt'), truncated)
  assert.strictEqual(store.inWatchlist('movie', 7), true)
  await store.flush()
  assert.match(bridge._text(), /Kept/)
})

test('a corrupt bridge blob falls back to the localStorage backup when the bridge has none', async () => {
  const bridge = _memoryBridge('garbage{')
  const legacy = fakeLocal({
    'papa-video-store.bak': JSON.stringify(blob({
      watchlist: [{ type: 'tv', id: '3', title: 'OldBak', poster: null, addedAt: 1 }],
    })),
  })
  const store = createVideoStore({ bridge, legacy, now: () => now, debounceMs: 0 })
  await store.init()
  assert.strictEqual(store.inWatchlist('tv', 3), true)
})

test('a bridge that cannot read parks the session on the storage adapter', async () => {
  const seed = blob({ prefs: { 'tv:1': { a: 1 } } })
  const bridge = { read: async () => { throw new Error('IPC gone') }, write: async () => true }
  const storage = _memoryStorage(seed)
  const store = createVideoStore({ bridge, legacy: fakeLocal(), storage, now: () => now })
  await store.init()
  // Reads come from the old path, and writes land there synchronously — the
  // broken bridge is never written to, so nothing can be clobbered.
  assert.deepStrictEqual(store.prefs('tv:1'), { a: 1 })
  store.setPrefs('tv:1', { b: 2 })
  assert.deepStrictEqual(storage._dump().prefs['tv:1'], { a: 1, b: 2 })
  assert.strictEqual(store.storageHealthy(), true)
})
