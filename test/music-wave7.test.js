'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const T = require('../src/music-tools')

// ── Radio: artist adjacency mining ────────────────────────────────────────────
test('adjacency links artists played in the same session', () => {
  const base = new Date(2026, 0, 1, 12, 0, 0).getTime()
  const min = 60000
  const hist = [
    { ts: base,            artist: 'A' },
    { ts: base + 2 * min,  artist: 'B' },
    { ts: base + 4 * min,  artist: 'C' },
  ]
  const adj = T.buildArtistAdjacency(hist, 30 * min)
  // All three in one session, so every pair co-occurs once.
  assert.equal(adj['A']['B'], 1)
  assert.equal(adj['A']['C'], 1)
  assert.equal(adj['B']['C'], 1)
})

test('a long gap starts a new session, so those artists are not adjacent', () => {
  const base = new Date(2026, 0, 1, 12, 0, 0).getTime()
  const min = 60000
  const hist = [
    { ts: base,             artist: 'A' },
    { ts: base + 5 * min,   artist: 'B' },        // same session as A
    { ts: base + 120 * min, artist: 'C' },        // two hours later: new session
  ]
  const adj = T.buildArtistAdjacency(hist, 30 * min)
  assert.equal(adj['A']['B'], 1, 'A and B shared a session')
  assert.ok(!adj['A'] || adj['A']['C'] == null, 'A and C are in different sessions')
})

test('repeated co-occurrence across sessions accumulates weight', () => {
  const day = 86400000
  const min = 60000
  const hist = [
    { ts: 1000000,           artist: 'A' },
    { ts: 1000000 + 2 * min, artist: 'B' },       // session 1: A+B
    { ts: 1000000 + day,     artist: 'A' },
    { ts: 1000000 + day + 2 * min, artist: 'B' }, // session 2: A+B again
  ]
  const adj = T.buildArtistAdjacency(hist, 30 * min)
  assert.equal(adj['A']['B'], 2, 'two shared sessions = weight 2')
})

test('an artist repeated within one session does not inflate its own weight', () => {
  const base = 1000000
  const min = 60000
  const hist = [
    { ts: base,           artist: 'A' },
    { ts: base + 1 * min, artist: 'A' },   // same artist twice, one session
    { ts: base + 2 * min, artist: 'B' },
  ]
  const adj = T.buildArtistAdjacency(hist, 30 * min)
  assert.equal(adj['A']['B'], 1, 'distinct-artist pairs only, counted once')
  assert.ok(!adj['A']['A'], 'no self-adjacency')
})

test('history rows missing ts or artist are skipped, not crashed on', () => {
  const hist = [{ ts: 1000, artist: 'A' }, { artist: 'B' }, { ts: 2000 }, null, { ts: 3000, artist: 'C' }]
  const adj = T.buildArtistAdjacency(hist, 60000)
  // Only A and C are usable and within 60s? 3000-1000 = 2000ms < 60000, so same session.
  assert.equal(adj['A']['C'], 1)
})

test('neighborsOf returns co-occurring artists strongest first', () => {
  const adj = { A: { B: 3, C: 1, D: 5 } }
  const n = T.neighborsOf(adj, 'A')
  assert.deepEqual(n.map(x => x.artist), ['D', 'B', 'C'])
  assert.equal(n[0].weight, 5)
})

test('neighborsOf on an unknown seed is empty, not an error', () => {
  assert.deepEqual(T.neighborsOf({ A: { B: 1 } }, 'Z'), [])
})

// ── Radio: weighted pick ──────────────────────────────────────────────────────
test('weighted pick lands in the bucket the rng points at', () => {
  // weights [1, 4, 5], total 10. rng 0.05 -> first bucket (0..1).
  assert.equal(T.weightedPickIndex([1, 4, 5], () => 0.05), 0)
  // 0.5 -> cumulative 1, then 5 -> falls in the second bucket (1..5).
  assert.equal(T.weightedPickIndex([1, 4, 5], () => 0.30), 1)
  // 0.99 -> last bucket.
  assert.equal(T.weightedPickIndex([1, 4, 5], () => 0.99), 2)
})

test('weighted pick with all-zero weights still returns a valid index', () => {
  const i = T.weightedPickIndex([0, 0, 0], () => 0.5)
  assert.ok(i >= 0 && i < 3)
})

test('weighted pick on an empty pool returns -1', () => {
  assert.equal(T.weightedPickIndex([], () => 0.5), -1)
})

// ── Radio: batch composition ──────────────────────────────────────────────────
const seed = [
  { filePath: '/s/1', playCount: 0 },
  { filePath: '/s/2', playCount: 0 },
  { filePath: '/s/3', playCount: 0 },
]
const mix = [
  { filePath: '/m/1', playCount: 0 },
  { filePath: '/m/2', playCount: 0 },
]

test('radio batch never repeats a track inside one batch', () => {
  const batch = T.composeRadioBatch({ seedTracks: seed, mixTracks: mix, count: 5, rng: seqRng() })
  const paths = batch.map(t => t.filePath)
  assert.equal(new Set(paths).size, paths.length, 'every track in the batch is distinct')
})

test('radio batch never picks a track in the no-repeat window', () => {
  const batch = T.composeRadioBatch({
    seedTracks: seed, mixTracks: mix, count: 10,
    recentPaths: ['/s/1', '/s/2', '/m/1'], rng: seqRng(),
  })
  const paths = batch.map(t => t.filePath)
  assert.ok(!paths.includes('/s/1') && !paths.includes('/s/2') && !paths.includes('/m/1'),
    'nothing from the recent window is served')
})

test('radio batch stops cleanly when both pools are exhausted', () => {
  // Only 5 distinct tracks exist; asking for 20 must yield exactly 5, not loop.
  const batch = T.composeRadioBatch({ seedTracks: seed, mixTracks: mix, count: 20, rng: seqRng() })
  assert.equal(batch.length, 5)
})

test('radio batch draws entirely from the seed when the mix is empty', () => {
  const batch = T.composeRadioBatch({ seedTracks: seed, mixTracks: [], count: 3, rng: seqRng() })
  assert.equal(batch.length, 3)
  assert.ok(batch.every(t => t.filePath.startsWith('/s/')))
})

test('radio batch honours a favourite via play-count weighting', () => {
  // One seed track with a huge play count should dominate a rng that always
  // points at the front of the cumulative range.
  const heavy = [
    { filePath: '/s/hot', playCount: 999 },
    { filePath: '/s/cold', playCount: 0 },
  ]
  // rng ~0 always lands in the first candidate bucket; the hot track sorts
  // first in the pool order, so it is chosen first.
  const batch = T.composeRadioBatch({ seedTracks: heavy, mixTracks: [], count: 1, mixRatio: 0, rng: () => 0.001 })
  assert.equal(batch[0].filePath, '/s/hot')
})

// A deterministic-ish rng: cycles through a fixed low-entropy sequence so the
// tests are reproducible. Values chosen to exercise both pools.
function seqRng() {
  const seq = [0.1, 0.9, 0.4, 0.7, 0.2, 0.6, 0.3, 0.8, 0.5, 0.05]
  let i = 0
  return () => seq[(i++) % seq.length]
}

// ── Radio: no-repeat window ───────────────────────────────────────────────────
test('pushRecent caps the window at the given size', () => {
  let win = []
  for (let i = 0; i < 60; i++) win = T.pushRecent(win, '/p/' + i, 50)
  assert.equal(win.length, 50)
  assert.equal(win[0], '/p/10', 'oldest entries fall off the front')
  assert.equal(win[win.length - 1], '/p/59')
})

test('pushRecent does not mutate the input array', () => {
  const win = ['/a']
  T.pushRecent(win, '/b', 50)
  assert.deepEqual(win, ['/a'])
})

// ── Storage dashboard ─────────────────────────────────────────────────────────
const storageLib = [
  { id: 'a', name: 'FLAC Album', tracks: [
    { filePath: '/music/a/1.flac', fileSize: 30000000 },
    { filePath: '/music/a/2.flac', fileSize: 20000000 },
  ] },
  { id: 'b', name: 'MP3 Album', tracks: [
    { filePath: '/music/b/1.mp3', fileSize: 8000000 },
  ] },
  { id: 'c', name: 'Sizeless', tracks: [
    { filePath: '/music/c/1.flac' }, // no fileSize recorded
  ] },
]

test('storage sums bytes by format', () => {
  const s = T.storageByFormat(storageLib)
  const flac = s.formats.find(f => f.format === 'FLAC')
  const mp3 = s.formats.find(f => f.format === 'MP3')
  assert.equal(flac.bytes, 50000000, 'two sized FLACs; the sizeless one adds 0 bytes')
  assert.equal(flac.tracks, 3, 'but the sizeless FLAC still counts toward the track total')
  assert.equal(mp3.bytes, 8000000)
  assert.equal(s.totalBytes, 58000000)
})

test('storage reports the partial-data limitation honestly', () => {
  const s = T.storageByFormat(storageLib)
  assert.equal(s.tracksMissingSize, 1, 'one track has no recorded size')
  assert.equal(s.partial, true, 'flagged so the UI can say sizes are approximate')
})

test('storage on an all-sized library is not marked partial', () => {
  const s = T.storageByFormat([storageLib[0], storageLib[1]])
  assert.equal(s.partial, false)
})

test('largest albums rank by summed track size', () => {
  const rows = T.largestAlbums(storageLib, 10)
  assert.equal(rows[0].album.id, 'a', 'the 50MB album leads')
  assert.equal(rows[0].bytes, 50000000)
  assert.equal(rows[1].album.id, 'b')
})

test('largest albums honours the limit', () => {
  assert.equal(T.largestAlbums(storageLib, 1).length, 1)
})

test('downloads subset matches the Downloads path segment', () => {
  const lib = [
    { id: 'x', name: 'X', tracks: [
      { filePath: '/mnt/data/MUSIC/Downloads/Song/1.flac', fileSize: 5000000 },
      { filePath: '/mnt/data/MUSIC/Filed/2.flac', fileSize: 6000000 },
    ] },
  ]
  const d = T.downloadsSubset(lib)
  assert.equal(d.count, 1, 'only the track under Downloads counts')
  assert.equal(d.bytes, 5000000)
})

test('downloads subset is case-insensitive and root-agnostic', () => {
  const lib = [{ id: 'x', name: 'X', tracks: [{ filePath: '/home/u/downloads/a.mp3', fileSize: 100 }] }]
  assert.equal(T.downloadsSubset(lib).count, 1)
})

// ── Alarm time math ───────────────────────────────────────────────────────────
test('alarm schedules for later today when the time is still ahead', () => {
  const now = new Date(2026, 0, 1, 8, 0, 0).getTime() // 08:00
  const ms = T.msUntilAlarm('09:30', now)
  assert.equal(ms, (90 * 60 * 1000), '90 minutes until 09:30')
})

test('alarm rolls over to tomorrow when the time has passed', () => {
  const now = new Date(2026, 0, 1, 10, 0, 0).getTime() // 10:00
  const ms = T.msUntilAlarm('09:30', now)
  // 09:30 already passed; next is tomorrow 09:30 = 23h30m away.
  assert.equal(ms, (23 * 60 + 30) * 60 * 1000)
})

test('alarm set to exactly now rolls to tomorrow, not zero', () => {
  const now = new Date(2026, 0, 1, 7, 15, 0).getTime()
  const ms = T.msUntilAlarm('07:15', now)
  assert.equal(ms, 24 * 60 * 60 * 1000, 'a full day, never a fire-immediately 0')
})

test('malformed alarm times return null', () => {
  assert.equal(T.msUntilAlarm('99:99', 0), null)
  assert.equal(T.msUntilAlarm('nonsense', 0), null)
  assert.equal(T.msUntilAlarm('', 0), null)
  assert.equal(T.msUntilAlarm('7', 0), null)
})

test('alarm fade rises from near-zero to the target', () => {
  const steps = T.alarmFadeSteps(0.8, 30000, 1000)
  assert.ok(steps.length > 1)
  assert.ok(steps[0] > 0 && steps[0] < 0.8, 'starts quiet but audible')
  assert.equal(steps[steps.length - 1], 0.8, 'ends exactly at the target')
})

test('alarm fade is monotonically non-decreasing and never exceeds the target', () => {
  const steps = T.alarmFadeSteps(0.5, 30000, 1000)
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] >= steps[i - 1], 'rises')
    assert.ok(steps[i] <= 0.5, 'never above target')
  }
})

test('alarm fade clamps a target above 1', () => {
  const steps = T.alarmFadeSteps(2, 30000, 1000)
  assert.equal(steps[steps.length - 1], 1)
})

test('alarm fade with a nonsense duration yields a single at-target step', () => {
  assert.deepEqual(T.alarmFadeSteps(0.7, 0, 1000), [0.7])
})
