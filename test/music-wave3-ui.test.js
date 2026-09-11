'use strict'
// Pure-function tests for the Wave-3 UI features:
//   #11 smart-playlist field/op/value evaluator (evaluateFieldRules)
//   #13 fuzzy library search + recent searches (retired → shared brain/memory)
//   #15 home row order + hidden persistence logic
//   #16 year-end Wrapped aggregations
// Same house style as music-tools.test.js: real assertions over the pure
// module, no DOM. The renderer wiring is asserted separately (source checks)
// in music-wave3-wiring.test.js.
const { test } = require('node:test')
const assert = require('node:assert')
const T = require('../src/music-tools')
const R = require('../src/home-recap')

// ── #11 Smart playlist: field/op/value evaluator ──────────────────────────────

function trk(over) {
  return Object.assign({
    filePath: '/m/a.flac', title: 'A', artist: 'Artist', albumArtist: 'Artist',
    albumName: 'Album', genre: 'Rock', year: 2020,
    bitsPerSample: 16, sampleRate: 44100, addedAt: 0,
  }, over || {})
}

test('an empty or all-blank rule set matches nothing, not everything', () => {
  const tracks = [trk(), trk({ filePath: '/m/b.mp3' })]
  assert.deepEqual(T.evaluateFieldRules(tracks, [], {}), [])
  assert.deepEqual(T.evaluateFieldRules(tracks, [{ field: 'genre', op: 'is', value: '' }], {}), [])
})

test('a genre "is" rule matches case-insensitively', () => {
  const tracks = [trk({ genre: 'Rock' }), trk({ filePath: '/m/b.flac', genre: 'Jazz' })]
  const out = T.evaluateFieldRules(tracks, [{ field: 'genre', op: 'is', value: 'rock' }], {})
  assert.equal(out.length, 1)
  assert.equal(out[0].genre, 'Rock')
})

test('a year range (gte + lte) AND-combines into a window', () => {
  const tracks = [trk({ year: 1999 }), trk({ filePath: '/b.flac', year: 2005 }), trk({ filePath: '/c.flac', year: 2020 })]
  const out = T.evaluateFieldRules(tracks, [
    { field: 'year', op: 'gte', value: '2000' },
    { field: 'year', op: 'lte', value: '2010' },
  ], {})
  assert.deepEqual(out.map(t => t.year), [2005])
})

test('formatClass lossless / hires / lossy classify by extension and bit depth', () => {
  const tracks = [
    trk({ filePath: '/cd.flac', bitsPerSample: 16, sampleRate: 44100 }),   // lossless
    trk({ filePath: '/hr.flac', bitsPerSample: 24, sampleRate: 96000 }),   // hires
    trk({ filePath: '/lo.mp3',  bitsPerSample: 0,  sampleRate: 0 }),       // lossy
  ]
  const lossless = T.evaluateFieldRules(tracks, [{ field: 'formatClass', op: 'is', value: 'lossless' }], {})
  const hires = T.evaluateFieldRules(tracks, [{ field: 'formatClass', op: 'is', value: 'hires' }], {})
  const lossy = T.evaluateFieldRules(tracks, [{ field: 'formatClass', op: 'is', value: 'lossy' }], {})
  assert.deepEqual(lossless.map(t => t.filePath), ['/cd.flac'])
  assert.deepEqual(hires.map(t => t.filePath), ['/hr.flac'])
  assert.deepEqual(lossy.map(t => t.filePath), ['/lo.mp3'])
})

test('playCount ≥ / ≤ compares numerically, not lexically', () => {
  const tracks = [trk({ filePath: '/a.flac' }), trk({ filePath: '/b.flac' }), trk({ filePath: '/c.flac' })]
  const ctx = { playCounts: { '/a.flac': 2, '/b.flac': 10, '/c.flac': 100 } }
  const ge = T.evaluateFieldRules(tracks, [{ field: 'playCount', op: 'gte', value: '10' }], ctx)
  assert.deepEqual(ge.map(t => t.filePath).sort(), ['/b.flac', '/c.flac'])
  const le = T.evaluateFieldRules(tracks, [{ field: 'playCount', op: 'lte', value: '9' }], ctx)
  assert.deepEqual(le.map(t => t.filePath), ['/a.flac'])
})

test('a liked rule reads the isLiked callback and defaults to wanting liked', () => {
  const tracks = [trk({ filePath: '/a.flac' }), trk({ filePath: '/b.flac' })]
  const ctx = { isLiked: t => t.filePath === '/a.flac' }
  const liked = T.evaluateFieldRules(tracks, [{ field: 'liked', op: 'is', value: 'true' }], ctx)
  assert.deepEqual(liked.map(t => t.filePath), ['/a.flac'])
  const notLiked = T.evaluateFieldRules(tracks, [{ field: 'liked', op: 'is', value: 'false' }], ctx)
  assert.deepEqual(notLiked.map(t => t.filePath), ['/b.flac'])
})

test('addedWithin matches by a clock-injected now, not the wall clock', () => {
  const now = 1_700_000_000_000
  const day = 24 * 60 * 60 * 1000
  const tracks = [
    trk({ filePath: '/new.flac', addedAt: now - 3 * day }),
    trk({ filePath: '/old.flac', addedAt: now - 40 * day }),
    trk({ filePath: '/none.flac', addedAt: 0 }),
  ]
  const out = T.evaluateFieldRules(tracks, [{ field: 'addedWithin', op: 'is', value: '30' }], { now })
  assert.deepEqual(out.map(t => t.filePath), ['/new.flac'])
})

test('all rules must pass (AND): genre AND lossless', () => {
  const tracks = [
    trk({ filePath: '/a.flac', genre: 'Rock', bitsPerSample: 16 }),
    trk({ filePath: '/b.mp3',  genre: 'Rock' }),
    trk({ filePath: '/c.flac', genre: 'Jazz', bitsPerSample: 16 }),
  ]
  const out = T.evaluateFieldRules(tracks, [
    { field: 'genre', op: 'is', value: 'Rock' },
    { field: 'formatClass', op: 'is', value: 'lossless' },
  ], {})
  assert.deepEqual(out.map(t => t.filePath), ['/a.flac'])
})

test('a malformed rule (unknown op) fails closed', () => {
  const tracks = [trk()]
  const out = T.evaluateFieldRules(tracks, [{ field: 'genre', op: 'wat', value: 'Rock' }], {})
  assert.deepEqual(out, [])
})

// ── #13 Fuzzy search + recent searches ───────────────────────────────────────
// Retired: the grid now ranks with the shared brain (library-index.js
// filterAlbums, tested there) and recents live in the one shared memory
// (search-memory.js, tested there). music-tools must not grow them back.
test('the private fuzzy matcher and recents list are gone from music-tools', () => {
  assert.equal(T.fuzzyFilter, undefined)
  assert.equal(T.fuzzyMatches, undefined)
  assert.equal(T.levenshtein, undefined)
  assert.equal(T.pushRecentSearch, undefined)
})

// ── #15 Home personalization ──────────────────────────────────────────────────

const DEF = ['greeting', 'jumpback', 'quick', 'recent', 'added', 'library']

test('with no preference, the default order is used and everything is visible', () => {
  const r = T.resolveHomeRows(DEF, null)
  assert.deepEqual(r.order, DEF)
  assert.deepEqual(r.visible, DEF)
})

test('a saved order is honoured and hidden rows are dropped from visible', () => {
  const pref = { order: ['recent', 'quick', 'greeting'], hidden: ['added'] }
  const r = T.resolveHomeRows(DEF, pref)
  // saved order first, then the default rows the save never saw, in default order
  assert.deepEqual(r.order, ['recent', 'quick', 'greeting', 'jumpback', 'added', 'library'])
  assert.ok(!r.visible.includes('added'), 'hidden row is not visible')
  assert.ok(r.visible.includes('recent'))
})

test('a stale saved order drops unknown ids and appends genuinely new rows', () => {
  const pref = { order: ['gone', 'recent'], hidden: ['alsogone'] }
  const r = T.resolveHomeRows(DEF, pref)
  assert.ok(!r.order.includes('gone'), 'an id no longer in the app is dropped')
  assert.equal(r.order[0], 'recent', 'the surviving saved row leads')
  // Every current default row still appears exactly once.
  for (const id of DEF) assert.equal(r.order.filter(x => x === id).length, 1)
})

test('moveHomeRow swaps neighbours and no-ops at the ends', () => {
  assert.deepEqual(T.moveHomeRow(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c'])
  assert.deepEqual(T.moveHomeRow(['a', 'b', 'c'], 1, +1), ['a', 'c', 'b'])
  assert.deepEqual(T.moveHomeRow(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c'], 'top-up is a no-op')
  assert.deepEqual(T.moveHomeRow(['a', 'b', 'c'], 2, +1), ['a', 'b', 'c'], 'bottom-down is a no-op')
})

test('toggleHomeRow flips a row in and out of the hidden set', () => {
  let pref = { order: DEF, hidden: [] }
  pref = T.toggleHomeRow(pref, 'added')
  assert.deepEqual(pref.hidden, ['added'])
  pref = T.toggleHomeRow(pref, 'added')
  assert.deepEqual(pref.hidden, [])
  assert.deepEqual(pref.order, DEF, 'order travels through unchanged')
})

// ── #16 Year-end Wrapped ──────────────────────────────────────────────────────

function play(fp, iso, artist, dur) {
  return { filePath: fp, ts: new Date(iso).getTime(), artist, duration: dur }
}

test('wrappedRecap has:false on an empty year', () => {
  const w = R.wrappedRecap([], { year: 2026 })
  assert.equal(w.has, false)
  assert.equal(w.plays, 0)
})

test('wrappedRecap counts only the target year and sums hours from durations', () => {
  const hist = [
    play('/a.flac', '2026-01-02T10:00:00Z', 'A', 1800),
    play('/b.flac', '2026-01-02T11:00:00Z', 'B', 1800),
    play('/c.flac', '2025-12-31T10:00:00Z', 'C', 3600), // prior year, ignored
  ]
  const w = R.wrappedRecap(hist, { year: 2026 })
  assert.equal(w.has, true)
  assert.equal(w.plays, 2)
  assert.equal(w.hours, 1) // 1800 + 1800 = 3600s = 1.0h
})

test('wrappedRecap ranks top artists by listening seconds', () => {
  const hist = [
    play('/a.flac', '2026-01-01T10:00:00Z', 'Loud', 60),
    play('/b.flac', '2026-01-01T10:05:00Z', 'Quiet', 30),
    play('/c.flac', '2026-01-01T10:10:00Z', 'Loud', 60),
  ]
  const w = R.wrappedRecap(hist, { year: 2026 })
  assert.equal(w.topArtists[0].name, 'Loud')
  assert.equal(w.topArtists[0].plays, 2)
  assert.equal(w.topArtists[0].seconds, 120)
})

test('wrappedRecap resolves album/genre/title via callbacks', () => {
  const hist = [
    play('/a.flac', '2026-02-01T10:00:00Z', 'A', 100),
    play('/a.flac', '2026-02-01T10:02:00Z', 'A', 100),
    play('/b.flac', '2026-02-01T10:05:00Z', 'A', 100),
  ]
  const w = R.wrappedRecap(hist, {
    year: 2026,
    albumOf: fp => fp === '/a.flac' ? 'Alpha' : 'Beta',
    genreOf: () => 'Ambient',
    titleOf: fp => fp === '/a.flac' ? 'Song A' : 'Song B',
  })
  assert.equal(w.topAlbums[0].name, 'Alpha')
  assert.equal(w.topGenre, 'Ambient')
  assert.equal(w.topTracks[0].filePath, '/a.flac')
  assert.equal(w.topTracks[0].plays, 2)
  assert.equal(w.topTracks[0].title, 'Song A')
})

test('wrappedRecap finds the biggest listening day', () => {
  const hist = [
    play('/a.flac', '2026-03-01T10:00:00Z', 'A', 10),
    play('/b.flac', '2026-03-02T10:00:00Z', 'A', 10),
    play('/c.flac', '2026-03-02T11:00:00Z', 'A', 10),
    play('/d.flac', '2026-03-02T12:00:00Z', 'A', 10),
  ]
  const w = R.wrappedRecap(hist, { year: 2026 })
  assert.equal(w.biggestDay.date, '2026-03-02')
  assert.equal(w.biggestDay.plays, 3)
})

test('wrappedRecap computes the longest session on a 30-min gap split', () => {
  // Session 1: two plays 5 min apart (600s total). Session 2 (after a 40-min
  // gap): one play (300s). Longest by summed duration is session 1.
  const hist = [
    play('/a.flac', '2026-04-01T10:00:00Z', 'A', 300),
    play('/b.flac', '2026-04-01T10:05:00Z', 'A', 300),
    play('/c.flac', '2026-04-01T10:50:00Z', 'A', 300), // 45 min after the last
  ]
  const w = R.wrappedRecap(hist, { year: 2026 })
  assert.equal(w.longestSessionMins, 10) // 600s
})

test('wrappedRecap counts first-listen discoveries of the year', () => {
  const hist = [
    play('/old.flac', '2025-06-01T10:00:00Z', 'A', 10), // first heard last year
    play('/old.flac', '2026-01-01T10:00:00Z', 'A', 10), // replayed this year
    play('/new.flac', '2026-01-02T10:00:00Z', 'A', 10), // first heard this year
  ]
  const w = R.wrappedRecap(hist, { year: 2026 })
  assert.equal(w.discoveries, 1, 'only /new.flac is a this-year discovery')
})

test('wrappedRecap honours an explicit firstListenBefore signal', () => {
  const hist = [
    play('/x.flac', '2026-01-01T10:00:00Z', 'A', 10),
    play('/y.flac', '2026-01-02T10:00:00Z', 'A', 10),
  ]
  const w = R.wrappedRecap(hist, {
    year: 2026,
    firstListenBefore: fp => fp === '/x.flac', // x was known before, y is new
  })
  assert.equal(w.discoveries, 1)
})
