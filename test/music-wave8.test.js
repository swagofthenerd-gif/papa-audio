'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const T = require('../src/music-tools')

// ── Smart playlists: the four built-ins exist ─────────────────────────────────
test('the four built-in smart lists ship', () => {
  const ids = T.SMART_PLAYLISTS.map(s => s.id)
  for (const id of ['smart-recent', 'smart-unplayed', 'smart-top', 'smart-lossless']) {
    assert.ok(ids.includes(id), `missing built-in ${id}`)
  }
  for (const s of T.SMART_PLAYLISTS) {
    assert.ok(s.name && s.rule && s.rule.type, `smart list ${s.id} needs a name and a rule`)
  }
})

// A fixed clock so the time-based rule is deterministic.
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0) // 2026-09-04
const DAY = 24 * 60 * 60 * 1000
const smartLib = [
  { id: 'a1', name: 'Fresh', artist: 'A', addedAt: NOW - 5 * DAY, tracks: [
    { filePath: '/m/fresh1.flac', title: 'Fresh One' },
    { filePath: '/m/fresh2.flac', title: 'Fresh Two' }
  ] },
  { id: 'a2', name: 'Old', artist: 'B', addedAt: NOW - 200 * DAY, tracks: [
    { filePath: '/m/old1.mp3', title: 'Old One' },
    { filePath: '/m/old2.mp3', title: 'Old Two' }
  ] }
]
const smartCounts = { '/m/fresh1.flac': 10, '/m/old1.mp3': 3 }

test('recently-added returns only tracks added within the window', () => {
  const rule = { type: 'recentlyAdded', days: 30 }
  const tracks = T.evaluateSmartPlaylist(rule, smartLib, smartCounts, NOW)
  const paths = tracks.map(t => t.filePath)
  assert.deepEqual(paths.sort(), ['/m/fresh1.flac', '/m/fresh2.flac'])
})

test('recently-added ignores rows with no added timestamp', () => {
  const lib = [{ id: 'x', name: 'NoDate', tracks: [{ filePath: '/x/1.flac', title: 'a' }] }]
  const out = T.evaluateSmartPlaylist({ type: 'recentlyAdded', days: 30 }, lib, {}, NOW)
  assert.equal(out.length, 0, 'no addedAt means we cannot claim it is recent')
})

test('never-played returns exactly the zero-count tracks', () => {
  const out = T.evaluateSmartPlaylist({ type: 'neverPlayed' }, smartLib, smartCounts, NOW)
  const paths = out.map(t => t.filePath).sort()
  assert.deepEqual(paths, ['/m/fresh2.flac', '/m/old2.mp3'])
})

test('most-played ranks by play count and respects the limit', () => {
  const out = T.evaluateSmartPlaylist({ type: 'mostPlayed', limit: 1 }, smartLib, smartCounts, NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].filePath, '/m/fresh1.flac', 'the top track leads')
})

test('most-played excludes tracks that were never played', () => {
  const out = T.evaluateSmartPlaylist({ type: 'mostPlayed', limit: 50 }, smartLib, smartCounts, NOW)
  const paths = out.map(t => t.filePath)
  assert.ok(!paths.includes('/m/fresh2.flac'), 'a zero-play track is not "most played"')
  assert.equal(paths.length, 2)
})

test('lossless returns only lossless formats', () => {
  const out = T.evaluateSmartPlaylist({ type: 'lossless' }, smartLib, smartCounts, NOW)
  const paths = out.map(t => t.filePath).sort()
  assert.deepEqual(paths, ['/m/fresh1.flac', '/m/fresh2.flac'], 'mp3 is dropped')
})

test('a lossless rule accepts wav/alac/aiff, rejects mp3/aac/ogg', () => {
  const lib = [{ id: 'z', name: 'Mix', tracks: [
    { filePath: '/z/a.wav', title: '1' }, { filePath: '/z/b.alac', title: '2' },
    { filePath: '/z/c.aiff', title: '3' }, { filePath: '/z/d.aac', title: '4' },
    { filePath: '/z/e.ogg', title: '5' }
  ] }]
  const out = T.evaluateSmartPlaylist({ type: 'lossless' }, lib, {}, NOW).map(t => t.filePath)
  assert.deepEqual(out.sort(), ['/z/a.wav', '/z/b.alac', '/z/c.aiff'])
})

test('and/or composite rules combine children', () => {
  // Lossless AND never-played → only fresh2.flac.
  const andRule = { type: 'and', rules: [{ type: 'lossless' }, { type: 'neverPlayed' }] }
  const a = T.evaluateSmartPlaylist(andRule, smartLib, smartCounts, NOW).map(t => t.filePath)
  assert.deepEqual(a, ['/m/fresh2.flac'])
  // never-played OR lossless → fresh1, fresh2, old2.
  const orRule = { type: 'or', rules: [{ type: 'neverPlayed' }, { type: 'lossless' }] }
  const o = T.evaluateSmartPlaylist(orRule, smartLib, smartCounts, NOW).map(t => t.filePath).sort()
  assert.deepEqual(o, ['/m/fresh1.flac', '/m/fresh2.flac', '/m/old2.mp3'])
})

test('an unknown rule type matches nothing (fails closed)', () => {
  const out = T.evaluateSmartPlaylist({ type: 'bogus' }, smartLib, smartCounts, NOW)
  assert.equal(out.length, 0)
})

test('the built-in smart rules all evaluate without throwing', () => {
  for (const s of T.SMART_PLAYLISTS) {
    const out = T.evaluateSmartPlaylist(s.rule, smartLib, smartCounts, NOW)
    assert.ok(Array.isArray(out), `${s.id} returned a list`)
  }
})

// ── Missing-track detector ────────────────────────────────────────────────────
function albumOf(nums, extra) {
  const tracks = nums.map(n => ({ trackNumber: n, title: 'T' + n, filePath: '/f/' + n + '.flac' }))
  return Object.assign({ id: 'x', name: 'Album', artist: 'A', tracks }, extra || {})
}

test('a single gap is detected (1,2,3,5 → missing 4)', () => {
  const g = T.albumGaps(albumOf([1, 2, 3, 5]))
  assert.ok(g, 'this album qualifies')
  assert.deepEqual(g.missing, [4])
  assert.equal(g.max, 5)
})

test('multiple gaps are all reported', () => {
  const g = T.albumGaps(albumOf([1, 2, 4, 6, 7, 8, 9, 10]))
  assert.deepEqual(g.missing, [3, 5])
})

test('a complete album returns null (no gap)', () => {
  assert.equal(T.albumGaps(albumOf([1, 2, 3, 4, 5])), null)
})

test('a too-sparse album is not called incomplete (below 60% coverage)', () => {
  // 1,2 present out of a max of 10 → 20% coverage → we do not trust the gap.
  assert.equal(T.albumGaps(albumOf([1, 2, 10])), null)
})

test('an album right at the coverage threshold qualifies', () => {
  // 1,2,3,5,6 present out of max 6 → 5/6 ≈ 83% coverage, missing 4.
  const g = T.albumGaps(albumOf([1, 2, 3, 5, 6]))
  assert.ok(g, 'well above the 60% threshold')
  assert.deepEqual(g.missing, [4])
  // Exactly 60%: 1,2,3 present, 4,5 missing out of max 5 → 3/5 = 0.60.
  const g2 = T.albumGaps(albumOf([1, 2, 3, 5]))
  assert.ok(g2, 'an album exactly at threshold coverage still qualifies')
  assert.deepEqual(g2.missing, [4], 'max is 5 here, missing 4 (5 is present)')
})

test('a custom stricter ratio can reject an otherwise-passing album', () => {
  const album = albumOf([1, 2, 3, 5]) // 4/5 = 80% coverage
  assert.ok(T.albumGaps(album, 0.6), 'passes at 60%')
  assert.equal(T.albumGaps(album, 0.9), null, 'rejected when we demand 90%')
})

test('a single-track album has no sequence to judge', () => {
  assert.equal(T.albumGaps(albumOf([1])), null)
})

test('an album with no track numbers is skipped, not crashed', () => {
  const album = { id: 'n', name: 'NoNums', tracks: [
    { title: 'a', filePath: '/a' }, { title: 'b', filePath: '/b' }
  ] }
  assert.equal(T.albumGaps(album), null)
})

test('track numbers in "5/12" form are parsed to 5', () => {
  const album = { id: 's', name: 'Slash', tracks: [
    { trackNumber: '1/12', title: 'a', filePath: '/a' },
    { trackNumber: '2/12', title: 'b', filePath: '/b' },
    { trackNumber: '4/12', title: 'd', filePath: '/d' }
  ] }
  const g = T.albumGaps(album)
  assert.deepEqual(g.missing, [3])
})

test('alternate track-number field names (track/no) are honored', () => {
  const album = { id: 'alt', name: 'Alt', tracks: [
    { track: 1, title: 'a', filePath: '/a' },
    { no: 3, title: 'c', filePath: '/c' },
    { track: 2, title: 'b', filePath: '/b' }
  ] }
  // 1,2,3 all present via mixed fields → complete → null.
  assert.equal(T.albumGaps(album), null)
})

test('alternate track-number field names still surface a real gap', () => {
  const album = { id: 'alt2', name: 'Alt2', tracks: [
    { track: 1, title: 'a', filePath: '/a' },
    { no: 4, title: 'd', filePath: '/d' },
    { track: 2, title: 'b', filePath: '/b' }
  ] }
  const g = T.albumGaps(album)
  assert.ok(g, 'a gap exists: 1,2,4 present, 3 missing')
  assert.deepEqual(g.missing, [3])
})

test('incompleteAlbums sweeps the library, worst first', () => {
  const lib = [
    albumOf([1, 2, 3, 4, 5], { name: 'Complete' }),
    albumOf([1, 2, 4], { name: 'OneGap' }),         // missing 3
    albumOf([1, 2, 5, 6, 7, 8, 9, 10], { name: 'TwoGaps' }) // missing 3,4
  ]
  const inc = T.incompleteAlbums(lib)
  assert.equal(inc.length, 2, 'the complete album is excluded')
  assert.equal(inc[0].album.name, 'TwoGaps', 'most-missing album leads')
  assert.deepEqual(inc[0].missing, [3, 4])
  assert.deepEqual(inc[1].missing, [3])
})

// ── Playlist import: parsing ──────────────────────────────────────────────────
test('a plain "Artist - Title" line yields both interpretations', () => {
  const parsed = T.parseImportLines('Radiohead - Karma Police')
  assert.equal(parsed.length, 1)
  const c = parsed[0].candidates
  assert.deepEqual(c[0], { artist: 'Radiohead', title: 'Karma Police' })
  assert.deepEqual(c[1], { artist: 'Karma Police', title: 'Radiohead' })
})

test('blank lines and numeric leaders are handled', () => {
  const parsed = T.parseImportLines('1. Nirvana - Lithium\n\n02) Pixies - Debaser\n')
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0].candidates[0], { artist: 'Nirvana', title: 'Lithium' })
  assert.deepEqual(parsed[1].candidates[0], { artist: 'Pixies', title: 'Debaser' })
})

test('en/em dashes are accepted as separators', () => {
  const parsed = T.parseImportLines('Bjork – Hyperballad\nAphex Twin — Xtal')
  assert.deepEqual(parsed[0].candidates[0], { artist: 'Bjork', title: 'Hyperballad' })
  assert.deepEqual(parsed[1].candidates[0], { artist: 'Aphex Twin', title: 'Xtal' })
})

test('a line with no separator becomes a title-only candidate', () => {
  const parsed = T.parseImportLines('Just A Title')
  assert.deepEqual(parsed[0].candidates, [{ artist: '', title: 'Just A Title' }])
})

test('a title containing a dash keeps the whole tail as the title', () => {
  const parsed = T.parseImportLines('The Beatles - Sgt. Pepper - Reprise')
  assert.deepEqual(parsed[0].candidates[0], { artist: 'The Beatles', title: 'Sgt. Pepper - Reprise' })
})

// ── Playlist import: matching against the library ─────────────────────────────
const importLib = [
  { id: 'a1', name: 'OK Computer', artist: 'Radiohead', tracks: [
    { filePath: '/lib/karma.flac', title: 'Karma Police', artist: 'Radiohead' },
    { filePath: '/lib/lucky.flac', title: 'Lucky', artist: 'Radiohead' }
  ] },
  { id: 'a2', name: 'Doolittle', artist: 'Pixies', tracks: [
    { filePath: '/lib/debaser.flac', title: 'Debaser', artist: 'Pixies' }
  ] }
]

test('matching resolves "Artist - Title" lines to library tracks', () => {
  const index = T.buildLibraryIndex(importLib)
  const parsed = T.parseImportLines('Radiohead - Karma Police\nPixies - Debaser')
  const res = T.matchImportedTracks(parsed, index)
  assert.equal(res.matched.length, 2)
  assert.deepEqual(res.matched.map(t => t.filePath).sort(),
    ['/lib/debaser.flac', '/lib/karma.flac'])
  assert.equal(res.misses.length, 0)
})

test('matching also resolves the reversed "Title - Artist" order', () => {
  const index = T.buildLibraryIndex(importLib)
  const parsed = T.parseImportLines('Karma Police - Radiohead') // reversed
  const res = T.matchImportedTracks(parsed, index)
  assert.equal(res.matched.length, 1, 'the second candidate interpretation hits')
  assert.equal(res.matched[0].filePath, '/lib/karma.flac')
})

test('normalization lets "(Remastered)" and case differences match', () => {
  const index = T.buildLibraryIndex(importLib)
  const parsed = T.parseImportLines('RADIOHEAD - Karma Police (Remastered 2017)')
  const res = T.matchImportedTracks(parsed, index)
  assert.equal(res.matched.length, 1)
  assert.equal(res.matched[0].filePath, '/lib/karma.flac')
})

test('a line with no library match becomes a miss carrying its raw text', () => {
  const index = T.buildLibraryIndex(importLib)
  const parsed = T.parseImportLines('Radiohead - Karma Police\nUnknown Band - Nonexistent Song')
  const res = T.matchImportedTracks(parsed, index)
  assert.equal(res.matched.length, 1)
  assert.equal(res.misses.length, 1)
  assert.equal(res.misses[0].raw, 'Unknown Band - Nonexistent Song')
})

test('a title-only line falls back to a title match', () => {
  const index = T.buildLibraryIndex(importLib)
  const parsed = T.parseImportLines('Debaser')
  const res = T.matchImportedTracks(parsed, index)
  assert.equal(res.matched.length, 1)
  assert.equal(res.matched[0].filePath, '/lib/debaser.flac')
})

test('duplicate lines yield the same track only once', () => {
  const index = T.buildLibraryIndex(importLib)
  const parsed = T.parseImportLines('Radiohead - Karma Police\nKarma Police - Radiohead')
  const res = T.matchImportedTracks(parsed, index)
  assert.equal(res.matched.length, 1, 'both forms point at one file — de-duplicated')
})
