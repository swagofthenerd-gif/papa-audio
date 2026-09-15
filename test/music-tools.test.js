'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const T = require('../src/music-tools')

// ── Sleep-timer fade curve ────────────────────────────────────────────────────
test('the fade ends in silence and starts below the current volume', () => {
  const steps = T.sleepFadeSteps(0.8, 5000, 250)
  assert.ok(steps.length > 1, 'a multi-second fade should have several steps')
  assert.ok(steps[0] < 0.8, 'the first step is quieter than where we started')
  assert.equal(steps[steps.length - 1], 0, 'the last step is exactly silent')
})

test('the fade never rises above the start or below zero', () => {
  const steps = T.sleepFadeSteps(0.5, 5000, 250)
  for (const v of steps) {
    assert.ok(v >= 0, 'no negative volume')
    assert.ok(v <= 0.5, 'never louder than the start')
  }
})

test('the fade is monotonically non-increasing', () => {
  const steps = T.sleepFadeSteps(1, 4000, 200)
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] <= steps[i - 1], `step ${i} rose: ${steps[i - 1]} -> ${steps[i]}`)
  }
})

test('a zero or already-silent start fades to nothing in one step', () => {
  assert.deepEqual(T.sleepFadeSteps(0, 5000, 250), [0])
  assert.deepEqual(T.sleepFadeSteps(-1, 5000, 250), [0])
})

test('nonsense durations degrade to a single silent step, not a crash', () => {
  assert.deepEqual(T.sleepFadeSteps(0.8, 0, 250), [0])
  assert.deepEqual(T.sleepFadeSteps(0.8, 5000, 0), [0])
  assert.deepEqual(T.sleepFadeSteps(0.8, NaN, 250), [0])
})

test('a volume above 1 is clamped before fading', () => {
  const steps = T.sleepFadeSteps(2, 5000, 250)
  assert.ok(steps[0] <= 1, 'first step must not exceed a full 1.0')
})

test('the preset menu offers end-of-track and the five minute presets', () => {
  const mins = T.SLEEP_PRESETS.map(p => p.mins)
  for (const m of [15, 30, 45, 60, 90]) assert.ok(mins.includes(m), `missing ${m}-minute preset`)
  assert.ok(T.SLEEP_PRESETS.some(p => p.endOfTrack), 'no end-of-track option')
})

// ── Album rows: wheel intent (roadmap 005) ───────────────────────────────────
test('plain vertical wheel over a row is left to the page', () => {
  assert.equal(T.rowWheelDelta({ deltaY: 120, deltaX: 0 }), 0)
  assert.equal(T.rowWheelDelta({ deltaY: -3, deltaX: 1 }), 0)
  assert.equal(T.rowWheelDelta(null), 0)
})

test('a horizontal gesture moves the row by its own delta', () => {
  assert.equal(T.rowWheelDelta({ deltaY: 2, deltaX: 50 }), 50)
  assert.equal(T.rowWheelDelta({ deltaY: 0, deltaX: -30 }), -30)
})

test('Shift+wheel turns a vertical wheel into row movement', () => {
  assert.equal(T.rowWheelDelta({ deltaY: 100, deltaX: 0, shiftKey: true }), 100)
  assert.equal(T.rowWheelDelta({ deltaY: 0, deltaX: 0, shiftKey: true }), 0)
})

// ── Queue: clear upcoming (roadmap 004) ──────────────────────────────────────
test('clearing upcoming drops everything after the current track and keeps it playing', () => {
  const q = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
  const res = T.clearUpcomingQueue(q, 1)
  assert.deepEqual(res.queue.map(t => t.id), [1, 2], 'played and current survive, upcoming go')
  assert.equal(res.queueIndex, 1, 'the current track is still the current track')
  assert.equal(res.queue[res.queueIndex].id, 2)
})

test('clearing upcoming with nothing after the current track changes nothing', () => {
  const q = [{ id: 1 }, { id: 2 }]
  assert.deepEqual(T.clearUpcomingQueue(q, 1), { queue: [{ id: 1 }, { id: 2 }], queueIndex: 1 })
})

test('clearing upcoming with nothing playing empties the queue', () => {
  assert.deepEqual(T.clearUpcomingQueue([{ id: 1 }], -1), { queue: [], queueIndex: -1 })
  assert.deepEqual(T.clearUpcomingQueue([{ id: 1 }], 7), { queue: [], queueIndex: -1 })
})

test('clearing upcoming does not mutate the original queue', () => {
  const q = [{ id: 1 }, { id: 2 }, { id: 3 }]
  T.clearUpcomingQueue(q, 0)
  assert.equal(q.length, 3, 'the caller keeps its array intact for undo')
})

// ── Queue: clear played ───────────────────────────────────────────────────────
test('clearing played drops everything before the current track', () => {
  const q = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
  const res = T.clearPlayedQueue(q, 2)
  assert.deepEqual(res.queue.map(t => t.id), [3, 4], 'the current track and what follows survive')
  assert.equal(res.queueIndex, 0, 'the current track becomes the new head')
})

test('clearing played leaves the current track in place', () => {
  const q = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const res = T.clearPlayedQueue(q, 1)
  assert.equal(res.queue[res.queueIndex].id, 2, 'still pointing at the same song')
})

test('clearing played at the head or past the end is a no-op', () => {
  const q = [{ id: 1 }, { id: 2 }]
  assert.deepEqual(T.clearPlayedQueue(q, 0).queue.map(t => t.id), [1, 2])
  assert.deepEqual(T.clearPlayedQueue(q, 5).queue.map(t => t.id), [1, 2])
})

test('clearing played does not mutate the original queue', () => {
  const q = [{ id: 1 }, { id: 2 }, { id: 3 }]
  T.clearPlayedQueue(q, 2)
  assert.equal(q.length, 3, 'the caller keeps its array intact for undo')
})

// ── Stats: top albums by play count ───────────────────────────────────────────
const albumFixture = [
  { id: 'a1', name: 'First', artist: 'X', tracks: [{ filePath: '/a/1' }, { filePath: '/a/2' }] },
  { id: 'a2', name: 'Second', artist: 'Y', tracks: [{ filePath: '/b/1' }] },
  { id: 'a3', name: 'Unplayed', artist: 'Z', tracks: [{ filePath: '/c/1' }] }
]
const counts = { '/a/1': 5, '/a/2': 2, '/b/1': 10 }

test('top albums roll track plays up to their album and rank them', () => {
  const top = T.topAlbumsByPlays(albumFixture, counts)
  assert.equal(top[0].album.id, 'a2', 'the 10-play album leads the 7-play one')
  assert.equal(top[0].plays, 10)
  assert.equal(top[1].album.id, 'a1')
  assert.equal(top[1].plays, 7)
})

test('albums with no plays never appear', () => {
  const top = T.topAlbumsByPlays(albumFixture, counts)
  assert.ok(!top.some(r => r.album.id === 'a3'), 'the unplayed album is left out')
})

test('top albums count how many of their tracks were touched', () => {
  const top = T.topAlbumsByPlays(albumFixture, counts)
  const first = top.find(r => r.album.id === 'a1')
  assert.equal(first.playedTracks, 2, 'both tracks on a1 were played')
})

test('top albums honours the limit', () => {
  assert.equal(T.topAlbumsByPlays(albumFixture, counts, 1).length, 1)
})

// ── Stats: plays per month ────────────────────────────────────────────────────
test('plays-per-month buckets history into the last six calendar months', () => {
  const now = new Date(2026, 8, 15).getTime() // Sep 2026
  const hist = [
    { ts: new Date(2026, 8, 1).getTime() },
    { ts: new Date(2026, 8, 20).getTime() },
    { ts: new Date(2026, 7, 10).getTime() }
  ]
  const months = T.playsPerMonth(hist, 6, now)
  assert.equal(months.length, 6, 'six buckets')
  assert.equal(months[months.length - 1].label, 'Sep', 'newest month is last, so a chart reads left-to-right')
  assert.equal(months[months.length - 1].plays, 2, 'two September plays')
  assert.equal(months[months.length - 2].plays, 1, 'one August play')
})

test('plays outside the window are dropped', () => {
  const now = new Date(2026, 8, 15).getTime()
  const hist = [{ ts: new Date(2025, 0, 1).getTime() }] // way out of range
  const months = T.playsPerMonth(hist, 6, now)
  assert.equal(months.reduce((s, b) => s + b.plays, 0), 0)
})

test('history entries with no timestamp are ignored, not counted', () => {
  const now = new Date(2026, 8, 15).getTime()
  const months = T.playsPerMonth([{ ts: 0 }, {}, { ts: new Date(2026, 8, 2).getTime() }], 6, now)
  assert.equal(months.reduce((s, b) => s + b.plays, 0), 1)
})

// ── Duplicate finder ──────────────────────────────────────────────────────────
test('normalize collapses remaster/feat noise so the same song matches', () => {
  const a = T.normalizeForDupe('The Beatles', 'Let It Be (Remastered 2009)')
  const b = T.normalizeForDupe('The Beatles', 'Let It Be')
  assert.equal(a, b, 'a remaster and the plain track are the same song')
})

test('normalize strips featured-artist tails', () => {
  const a = T.normalizeForDupe('Drake', 'Song feat. Future')
  const b = T.normalizeForDupe('Drake', 'Song')
  assert.equal(a, b)
})

test('duplicate finder groups the same song across formats', () => {
  const lib = [
    { id: 'a1', name: 'FLAC Rip', artist: 'X', tracks: [{ filePath: '/f/song.flac', title: 'Song', fileSize: 30000000, sampleRate: 44100, bitsPerSample: 16 }] },
    { id: 'a2', name: 'MP3 Rip', artist: 'X', tracks: [{ filePath: '/m/song.mp3', title: 'Song (Remastered)', fileSize: 8000000 }] }
  ]
  const groups = T.findDuplicateTracks(lib)
  assert.equal(groups.length, 1, 'one duplicated song')
  assert.equal(groups[0].entries.length, 2, 'both copies grouped')
  const formats = groups[0].entries.map(e => e.format).sort()
  assert.deepEqual(formats, ['FLAC', 'MP3'])
})

test('a unique song is not reported as a duplicate', () => {
  const lib = [
    { id: 'a1', name: 'Album', artist: 'X', tracks: [{ filePath: '/f/one.flac', title: 'One' }, { filePath: '/f/two.flac', title: 'Two' }] }
  ]
  assert.deepEqual(T.findDuplicateTracks(lib), [])
})

test('the same file listed under two albums is not a self-duplicate', () => {
  const lib = [
    { id: 'a1', name: 'Album', artist: 'X', tracks: [{ filePath: '/f/song.flac', title: 'Song' }] },
    { id: 'comp', name: 'Compilation', artist: 'Various', tracks: [{ filePath: '/f/song.flac', title: 'Song', albumArtist: 'X' }] }
  ]
  assert.deepEqual(T.findDuplicateTracks(lib), [], 'one distinct file is not two copies')
})

test('duplicate finder estimates reclaimable bytes as all-but-the-largest', () => {
  const lib = [
    { id: 'a1', name: 'A', artist: 'X', tracks: [{ filePath: '/1.flac', title: 'S', fileSize: 30000000 }] },
    { id: 'a2', name: 'B', artist: 'X', tracks: [{ filePath: '/2.mp3', title: 'S', fileSize: 8000000 }] }
  ]
  const g = T.findDuplicateTracks(lib)[0]
  assert.equal(g.wastedBytes, 8000000, 'keeping the 30MB copy reclaims the 8MB one')
})

test('bigger duplicate groups surface first', () => {
  const lib = [
    { id: 'a', name: 'A', artist: 'X', tracks: [{ filePath: '/x1.flac', title: 'Pair' }] },
    { id: 'b', name: 'B', artist: 'X', tracks: [{ filePath: '/x2.mp3', title: 'Pair' }] },
    { id: 'c', name: 'C', artist: 'Y', tracks: [{ filePath: '/y1.flac', title: 'Trio' }] },
    { id: 'd', name: 'D', artist: 'Y', tracks: [{ filePath: '/y2.mp3', title: 'Trio' }] },
    { id: 'e', name: 'E', artist: 'Y', tracks: [{ filePath: '/y3.wav', title: 'Trio' }] }
  ]
  const groups = T.findDuplicateTracks(lib)
  assert.equal(groups[0].entries.length, 3, 'the three-copy song comes before the two-copy one')
})

// ── Cover-art sweep: albumsMissingArt (App #61) ───────────────────────────────
test('only albums with no local artPath count as missing', () => {
  const lib = [
    { id: 'a1', name: 'Has art', artPath: '/cache/a1.jpg' },
    { id: 'a2', name: 'No art' },
    { id: 'a3', name: 'Empty art', artPath: '' }
  ]
  const missing = T.albumsMissingArt(lib)
  assert.deepEqual(missing.map(a => a.id), ['a2', 'a3'], 'the two without a usable cover')
})

test('a remote (http) artPath is treated as having art, not refetched', () => {
  const lib = [{ id: 'yt', name: 'Stream', artPath: 'https://img/cover.jpg' }]
  assert.deepEqual(T.albumsMissingArt(lib), [], 'a streamed cover is not a missing cover')
})

test('an album with no id is skipped: it cannot be cached under one', () => {
  const lib = [{ name: 'Orphan' }, { id: 'ok', name: 'Real' }]
  assert.deepEqual(T.albumsMissingArt(lib).map(a => a.id), ['ok'])
})

test('the sweep is capped so a run stays polite', () => {
  const lib = []
  for (let i = 0; i < 50; i++) lib.push({ id: 'a' + i, name: 'A' + i })
  assert.equal(T.albumsMissingArt(lib).length, 20, 'the default cap is 20 per run')
  assert.equal(T.albumsMissingArt(lib, 5).length, 5, 'the cap is honoured')
})

test('albumsMissingArt on an empty library is an empty list, not a crash', () => {
  assert.deepEqual(T.albumsMissingArt(), [])
  assert.deepEqual(T.albumsMissingArt([]), [])
})

// ── Synced lyrics: parseLrc + activeLyricIndex (App #57) ──────────────────────
test('parseLrc turns timestamped lines into sorted {time,text}', () => {
  const lines = T.parseLrc('[00:10.00]first\n[00:20.50]second')
  assert.deepEqual(lines, [
    { time: 10, text: 'first' },
    { time: 20.5, text: 'second' }
  ])
})

test('parseLrc expands a chorus stacked on one line into one entry per stamp', () => {
  const lines = T.parseLrc('[00:10.00][01:20.00][02:30.00]same words')
  assert.equal(lines.length, 3, 'one entry per timestamp')
  assert.ok(lines.every(l => l.text === 'same words'), 'all carry the same words, none with a leftover stamp')
  assert.deepEqual(lines.map(l => l.time), [10, 80, 150], 'sorted by time')
})

test('parseLrc tolerates the [mm:ss:cc] colon variant', () => {
  const lines = T.parseLrc('[01:05:50]line')
  assert.equal(lines[0].time, 65.5)
})

test('parseLrc drops metadata and blank lines, and returns null for plain text', () => {
  assert.equal(T.parseLrc('[ar:Artist]\n[length:03:20]\n\njust some prose\nmore prose'), null,
    'no timestamps anywhere means this is not synced')
})

test('parseLrc returns null for empty input', () => {
  assert.equal(T.parseLrc(''), null)
  assert.equal(T.parseLrc(null), null)
})

test('activeLyricIndex points at the last line whose time has been reached', () => {
  const lines = [{ time: 0, text: 'a' }, { time: 10, text: 'b' }, { time: 20, text: 'c' }]
  assert.equal(T.activeLyricIndex(lines, -1), -1, 'before the first line, nothing is active')
  assert.equal(T.activeLyricIndex(lines, 0), 0, 'exactly on a stamp counts as reached')
  assert.equal(T.activeLyricIndex(lines, 15), 1, 'between b and c, b is active')
  assert.equal(T.activeLyricIndex(lines, 999), 2, 'past the end, the last line stays active')
})

test('activeLyricIndex degrades to -1 on nonsense', () => {
  assert.equal(T.activeLyricIndex([{ time: 0, text: 'a' }], NaN), -1)
  assert.equal(T.activeLyricIndex(null, 5), -1)
})

// ── Crossfade per playlist: resolvePlaylistCrossfade (App #51) ────────────────
const gGapless = { mode: 'gapless', crossfadeSecs: 4 }
const gCross = { mode: 'crossfade', crossfadeSecs: 4 }

test('an inherit/undefined override hands the global config back unchanged', () => {
  assert.deepEqual(T.resolvePlaylistCrossfade(gGapless, undefined), { mode: 'gapless', crossfadeSecs: 4 })
  assert.deepEqual(T.resolvePlaylistCrossfade(gCross, 'inherit'), { mode: 'crossfade', crossfadeSecs: 4 })
  assert.deepEqual(T.resolvePlaylistCrossfade(gCross, null), { mode: 'crossfade', crossfadeSecs: 4 })
})

test('an off override forces gapless for this playlist even under a global crossfade', () => {
  assert.deepEqual(T.resolvePlaylistCrossfade(gCross, 'off'), { mode: 'gapless', crossfadeSecs: 4 })
  assert.deepEqual(T.resolvePlaylistCrossfade(gCross, 0), { mode: 'gapless', crossfadeSecs: 4 })
})

test('a numeric override turns crossfade on at that length', () => {
  assert.deepEqual(T.resolvePlaylistCrossfade(gGapless, 8), { mode: 'crossfade', crossfadeSecs: 8 })
  assert.deepEqual(T.resolvePlaylistCrossfade(gGapless, '6'), { mode: 'crossfade', crossfadeSecs: 6 })
})

test('an unrecognised override falls back to inherit, not to a guess', () => {
  assert.deepEqual(T.resolvePlaylistCrossfade(gCross, 'weird'), { mode: 'crossfade', crossfadeSecs: 4 })
  assert.deepEqual(T.resolvePlaylistCrossfade(gGapless, -3), { mode: 'gapless', crossfadeSecs: 4 })
})

test('a missing/zero global crossfadeSecs defaults to 4 before resolving', () => {
  assert.deepEqual(T.resolvePlaylistCrossfade({ mode: 'gapless' }, 'inherit'), { mode: 'gapless', crossfadeSecs: 4 })
})

test('crossfadeConfigDiffers only fires when the effective setting really changed', () => {
  // Same mode, same secs → no rebuild.
  assert.equal(T.crossfadeConfigDiffers(gGapless, { mode: 'gapless', crossfadeSecs: 4 }), false)
  // Mode flip → rebuild.
  assert.equal(T.crossfadeConfigDiffers(gGapless, { mode: 'crossfade', crossfadeSecs: 4 }), true)
  // Length change while crossfading → rebuild.
  assert.equal(T.crossfadeConfigDiffers(gCross, { mode: 'crossfade', crossfadeSecs: 8 }), true)
  // Length differs but both are gapless → irrelevant, no rebuild.
  assert.equal(T.crossfadeConfigDiffers({ mode: 'gapless', crossfadeSecs: 4 }, { mode: 'gapless', crossfadeSecs: 8 }), false)
})

// ── Global crossfade vs same-album gapless: resolveTransitionCrossfade (#24) ───

test('global crossfade off means gapless for every transition', () => {
  assert.deepEqual(T.resolveTransitionCrossfade({ crossfadeSeconds: 0 }),
    { mode: 'gapless', crossfadeSecs: 4 })
  assert.deepEqual(T.resolveTransitionCrossfade({ crossfadeSeconds: 0, sameAlbumAdjacent: true }),
    { mode: 'gapless', crossfadeSecs: 4 })
})

test('a global crossfade applies to a normal (cross-album) transition', () => {
  assert.deepEqual(T.resolveTransitionCrossfade({ crossfadeSeconds: 6 }),
    { mode: 'crossfade', crossfadeSecs: 6 })
})

test('same-album adjacency stays gapless even with a global crossfade set', () => {
  // The headline of #24: album integrity wins over the global crossfade.
  assert.deepEqual(
    T.resolveTransitionCrossfade({ crossfadeSeconds: 6, sameAlbumAdjacent: true }),
    { mode: 'gapless', crossfadeSecs: 6 })
})

test('a playlist crossfade override wins over the global, even inside an album', () => {
  // Most specific wins: an explicit playlist choice beats both the album rule and
  // the global.
  assert.deepEqual(
    T.resolveTransitionCrossfade({ crossfadeSeconds: 0, playlistOverride: 8, sameAlbumAdjacent: true }),
    { mode: 'crossfade', crossfadeSecs: 8 })
  assert.deepEqual(
    T.resolveTransitionCrossfade({ crossfadeSeconds: 6, playlistOverride: 3 }),
    { mode: 'crossfade', crossfadeSecs: 3 })
})

test('a playlist off-override forces gapless over a global crossfade', () => {
  assert.deepEqual(
    T.resolveTransitionCrossfade({ crossfadeSeconds: 6, playlistOverride: 'off' }),
    { mode: 'gapless', crossfadeSecs: 6 })
})

test('an inheriting playlist falls through to the album/global rules', () => {
  // inherit is not an explicit choice: same-album still stays gapless, cross-album
  // still takes the global.
  assert.deepEqual(
    T.resolveTransitionCrossfade({ crossfadeSeconds: 6, playlistOverride: 'inherit', sameAlbumAdjacent: true }),
    { mode: 'gapless', crossfadeSecs: 6 })
  assert.deepEqual(
    T.resolveTransitionCrossfade({ crossfadeSeconds: 6, playlistOverride: 'inherit' }),
    { mode: 'crossfade', crossfadeSecs: 6 })
})

test('bit-perfect forces gapless over everything, even a playlist crossfade override (#65)', () => {
  // Highest precedence: the audiophile path is not something a per-playlist
  // crossfade gets to defeat — crossfade mixes two streams, never bit-perfect.
  assert.deepEqual(
    T.resolveTransitionCrossfade({ crossfadeSeconds: 6, playlistOverride: 8, bitPerfect: true }),
    { mode: 'gapless', crossfadeSecs: 6 })
  assert.deepEqual(
    T.resolveTransitionCrossfade({ crossfadeSeconds: 0, bitPerfect: true }),
    { mode: 'gapless', crossfadeSecs: 4 })
})
