'use strict'
const test = require('node:test')
const assert = require('node:assert')
const SM = require('../src/search-memory')

const NOW = Date.UTC(2026, 8, 11, 20, 0, 0)
const min = n => NOW - n * 60000

// ── Commit ───────────────────────────────────────────────────────────────────

test('commit remembers a query newest-first with its surface and time', () => {
  let list = SM.commit([], { query: 'Camel Mirage', surface: 'music', now: min(5) })
  list = SM.commit(list, { query: 'tokyo revengers', surface: 'video', now: min(1) })
  assert.equal(list.length, 2)
  assert.equal(list[0].q, 'tokyo revengers')
  assert.equal(list[0].surfaces.video, min(1))
  assert.equal(list[1].q, 'Camel Mirage')
  assert.equal(list[1].key, 'camel mirage')
  assert.equal(list[1].surfaces.music, min(5))
})

test('a repeat on another surface merges into ONE entry that knows both', () => {
  let list = SM.commit([], { query: 'camel', surface: 'music', now: min(30) })
  list = SM.commit(list, { query: 'Camel', surface: 'soulseek', now: min(2) })
  assert.equal(list.length, 1, 'same query, one memory')
  assert.equal(list[0].q, 'Camel', 'latest spelling wins')
  assert.equal(list[0].n, 2)
  assert.equal(list[0].surfaces.music, min(30))
  assert.equal(list[0].surfaces.soulseek, min(2))
  assert.equal(list[0].ts, min(2))
})

test('blank and whitespace-only queries are ignored', () => {
  assert.deepEqual(SM.commit([], { query: '   ', surface: 'music' }), [])
  assert.deepEqual(SM.commit([], { query: null, surface: 'music' }), [])
})

test('a same-surface stepping stone ("tokyo" just before "tokyo revengers") is dropped', () => {
  let list = SM.commit([], { query: 'tokyo', surface: 'video', now: min(3) })
  list = SM.commit(list, { query: 'tokyo revengers', surface: 'video', now: min(2) })
  assert.deepEqual(list.map(e => e.q), ['tokyo revengers'])
})

test('an OLD prefix search is a real search and survives', () => {
  let list = SM.commit([], { query: 'tokyo', surface: 'video', now: NOW - 2 * 3600000 })
  list = SM.commit(list, { query: 'tokyo revengers', surface: 'video', now: NOW })
  assert.deepEqual(list.map(e => e.q), ['tokyo revengers', 'tokyo'])
})

test('a prefix committed on a DIFFERENT surface is not a stepping stone', () => {
  let list = SM.commit([], { query: 'camel', surface: 'music', now: min(3) })
  list = SM.commit(list, { query: 'camel mirage', surface: 'soulseek', now: min(2) })
  assert.equal(list.length, 2)
})

test('a stepping stone that also lives elsewhere only loses this surface', () => {
  let list = SM.commit([], { query: 'camel', surface: 'music', now: min(40) })
  list = SM.commit(list, { query: 'camel', surface: 'video', now: min(3) })
  list = SM.commit(list, { query: 'camel mirage', surface: 'video', now: min(2) })
  const camel = list.find(e => e.key === 'camel')
  assert.ok(camel, 'still remembered for the music surface')
  assert.deepEqual(Object.keys(camel.surfaces), ['music'])
})

test('the list is capped, newest kept', () => {
  let list = []
  for (let i = 0; i < SM.MAX_ENTRIES + 20; i++) list = SM.commit(list, { query: 'q' + i, surface: 'music', now: min(1000 - i) })
  assert.equal(list.length, SM.MAX_ENTRIES)
  assert.equal(list[0].q, 'q' + (SM.MAX_ENTRIES + 19))
  assert.equal(list.findIndex(e => e.q === 'q0'), -1)
})

// ── Remove / clear ───────────────────────────────────────────────────────────

test('remove forgets one query everywhere; clear(surface) keeps what lives elsewhere', () => {
  let list = SM.commit([], { query: 'camel', surface: 'music', now: min(5) })
  list = SM.commit(list, { query: 'camel', surface: 'video', now: min(4) })
  list = SM.commit(list, { query: 'jazz', surface: 'video', now: min(3) })
  assert.equal(SM.remove(list, 'CAMEL').length, 1)
  const cleared = SM.clear(list, 'video')
  assert.deepEqual(cleared.map(e => e.q), ['camel'], 'jazz lived only on video')
  assert.deepEqual(Object.keys(cleared[0].surfaces), ['music'])
  assert.deepEqual(SM.clear(list), [])
})

// ── Opened trail ─────────────────────────────────────────────────────────────

test('recordOpen keeps what was opened from a search, newest first, deduped, capped', () => {
  let list = SM.commit([], { query: 'camel', surface: 'music', now: min(5) })
  list = SM.recordOpen(list, { query: 'camel', surface: 'music', item: { kind: 'album', id: 'a1', label: 'Mirage' }, now: min(4) })
  list = SM.recordOpen(list, { query: 'camel', surface: 'music', item: { kind: 'album', id: 'a2', label: 'Moonmadness' }, now: min(3) })
  list = SM.recordOpen(list, { query: 'camel', surface: 'music', item: { kind: 'album', id: 'a1', label: 'Mirage' }, now: min(2) })
  assert.equal(list.length, 1)
  assert.deepEqual(list[0].opened.map(o => o.label), ['Mirage', 'Moonmadness'])
  assert.equal(SM.lastOpened(list[0]).label, 'Mirage')
  assert.equal(list[0].n, 1, 'opening is not a second commit')
  for (let i = 0; i < 10; i++) list = SM.recordOpen(list, { query: 'camel', surface: 'music', item: { kind: 'track', id: 't' + i, label: 'T' + i } })
  assert.equal(list[0].opened.length, SM.MAX_OPENED)
})

test('recordOpen on a never-committed query commits it first (a click is an act)', () => {
  const list = SM.recordOpen([], { query: 'reacher', surface: 'video', item: { kind: 'tv', id: '1', label: 'Reacher' }, now: NOW })
  assert.equal(list.length, 1)
  assert.equal(list[0].surfaces.video, NOW)
  assert.equal(list[0].opened[0].label, 'Reacher')
})

test('recordOpen without a usable item changes nothing', () => {
  const list = SM.commit([], { query: 'camel', surface: 'music' })
  assert.deepEqual(SM.recordOpen(list, { query: 'camel', surface: 'music', item: null }), list)
})

// ── Recent (what a box offers) ───────────────────────────────────────────────

test('recent offers own-surface entries first, then elsewhere tagged with where', () => {
  let list = SM.commit([], { query: 'camel', surface: 'music', now: min(10) })
  list = SM.commit(list, { query: 'tokyo revengers', surface: 'video', now: min(1) })
  list = SM.commit(list, { query: 'king crimson', surface: 'soulseek', now: min(5) })
  const r = SM.recent(list, { surface: 'music' })
  assert.deepEqual(r.own.map(e => e.q), ['camel'])
  assert.deepEqual(r.elsewhere.map(e => e.q), ['tokyo revengers', 'king crimson'])
  assert.equal(r.elsewhere[0].fromLabel, 'Movies & TV')
  assert.equal(r.elsewhere[1].fromLabel, 'Soulseek')
})

test('recent orders own entries by their time on THAT surface, not the global time', () => {
  let list = SM.commit([], { query: 'a', surface: 'music', now: min(10) })
  list = SM.commit(list, { query: 'b', surface: 'music', now: min(8) })
  list = SM.commit(list, { query: 'a', surface: 'video', now: min(1) }) // a is globally newest now
  const r = SM.recent(list, { surface: 'music' })
  assert.deepEqual(r.own.map(e => e.q), ['b', 'a'], 'on the music box, b was searched more recently')
})

test('recent filters both groups by the typed text and honours limits', () => {
  let list = []
  for (let i = 0; i < 12; i++) list = SM.commit(list, { query: 'camel ' + i, surface: 'music', now: min(20 - i) })
  list = SM.commit(list, { query: 'camel moonmadness', surface: 'video', now: min(1) })
  list = SM.commit(list, { query: 'jazz', surface: 'video', now: min(1) })
  const r = SM.recent(list, { surface: 'music', filter: 'CAMEL', limit: 5 })
  assert.equal(r.own.length, 5)
  assert.deepEqual(r.elsewhere.map(e => e.q), ['camel moonmadness'])
})

// ── Migration ────────────────────────────────────────────────────────────────

test('migrate folds the three legacy lists into one, keeping real music times and list order', () => {
  const list = SM.migrate({
    music: [{ query: 'radiohead', ts: min(2) }, { query: 'camel', ts: min(60) }, 'old string entry'],
    library: ['king crimson', 'camel'],
    video: ['toky', 'tokyo r', 'tokyo revengers', 'reacher'],
  }, NOW)
  const qs = list.map(e => e.q)
  assert.ok(qs.indexOf('toky') === -1 && qs.indexOf('tokyo r') === -1, 'video prefix junk is dropped')
  assert.ok(qs.indexOf('tokyo revengers') !== -1)
  assert.ok(qs.indexOf('old string entry') !== -1, 'a pre-timestamp string entry survives')
  const camel = list.find(e => e.key === 'camel')
  assert.ok(camel.surfaces.music === min(60), 'the real music time is kept')
  assert.ok('library' in camel.surfaces, 'the library copy merged into the same entry')
  assert.equal(list[0].q, 'radiohead', 'the newest real time leads')
  // Library order survives: king crimson was newer than camel on that box.
  const kc = list.find(e => e.key === 'king crimson')
  assert.ok(kc.surfaces.library > camel.surfaces.library)
})

test('migrate of nothing is an empty list', () => {
  assert.deepEqual(SM.migrate({}, NOW), [])
  assert.deepEqual(SM.migrate(null, NOW), [])
})

// ── Sanitize ─────────────────────────────────────────────────────────────────

test('sanitize drops damaged entries, unknown surfaces and duplicate keys', () => {
  const out = SM.sanitize([
    null, 5, { q: '' }, { q: 'ok', ts: 3, surfaces: { music: 3, bogus: 1, video: 'x' }, opened: [{ label: 'A' }, null, { nolabel: 1 }] },
    { q: 'OK', ts: 1 },
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(Object.keys(out[0].surfaces), ['music'])
  assert.deepEqual(out[0].opened.map(o => o.label), ['A'])
  assert.deepEqual(SM.sanitize('nope'), [])
})

// ── Relative time / labels ───────────────────────────────────────────────────

test('relativeTime reads like a person', () => {
  assert.equal(SM.relativeTime(NOW - 5000, NOW), 'just now')
  assert.equal(SM.relativeTime(min(7), NOW), '7m ago')
  assert.equal(SM.relativeTime(NOW - 3 * 3600000, NOW), '3h ago')
  assert.equal(SM.relativeTime(NOW - 30 * 3600000, NOW), 'yesterday')
  assert.equal(SM.relativeTime(NOW - 5 * 86400000, NOW), '5d ago')
  assert.equal(SM.relativeTime(NOW - 70 * 86400000, NOW), '2mo ago')
  assert.equal(SM.relativeTime(0, NOW), '')
  assert.equal(SM.surfaceLabel('video'), 'Movies & TV')
})

// ── Store ────────────────────────────────────────────────────────────────────

function memIo(seed) {
  const m = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.stringify(v)]))
  return {
    m,
    getRaw: k => (m.has(k) ? m.get(k) : null),
    readArray: k => { try { const v = JSON.parse(m.get(k)); return Array.isArray(v) ? v : [] } catch (_) { return [] } },
    write: (k, v) => { m.set(k, JSON.stringify(v)); return true },
    remove: k => { m.delete(k) },
  }
}

test('the store migrates the legacy keys on first load, persists, and retires them', () => {
  const io = memIo({
    pa_search_history: [{ query: 'radiohead', ts: min(2) }],
    'papa-lib-recent-searches': ['king crimson'],
    papaVideoRecentSearches: ['reacher'],
  })
  const store = SM.createStore(io, { now: NOW })
  const list = store.list()
  assert.equal(list.length, 3)
  assert.ok(io.m.has(SM.STORAGE_KEY), 'unified key written')
  assert.ok(!io.m.has('pa_search_history') && !io.m.has('papa-lib-recent-searches') && !io.m.has('papaVideoRecentSearches'), 'legacy keys removed')
})

test('the store never re-migrates once the unified key exists (even when empty)', () => {
  const io = memIo({ [SM.STORAGE_KEY]: [], pa_search_history: [{ query: 'ghost', ts: 1 }] })
  const store = SM.createStore(io, { now: NOW })
  assert.deepEqual(store.list(), [])
  assert.ok(io.m.has('pa_search_history'), 'a legacy key left behind is not read again')
})

test('store mutations write through and notify listeners', () => {
  const io = memIo({})
  const store = SM.createStore(io, { now: NOW })
  let seen = 0
  const off = store.onChange(() => { seen++ })
  store.commit('camel', 'music')
  store.recordOpen('camel', 'music', { kind: 'album', id: 'a1', label: 'Mirage' })
  assert.equal(seen, 2)
  assert.equal(io.readArray(SM.STORAGE_KEY)[0].opened[0].label, 'Mirage')
  assert.deepEqual(store.recent('soulseek').elsewhere.map(e => e.q), ['camel'])
  off()
  store.remove('camel')
  assert.equal(seen, 2, 'unsubscribed')
  assert.deepEqual(store.list(), [])
  store.commit('x', 'video'); store.clear('video')
  assert.deepEqual(store.list(), [])
})

test('the shared debounce budget exists for every box to read', () => {
  assert.ok(SM.DEBOUNCE.local > 0 && SM.DEBOUNCE.remote >= SM.DEBOUNCE.local)
})
