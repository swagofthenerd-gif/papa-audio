'use strict'
const test = require('node:test')
const assert = require('node:assert')
const LI = require('../src/library-index')

function lib() {
  return [
    {
      id: 'a1', name: 'OK Computer', artist: 'Radiohead', year: 1997,
      artPath: '/art/ok.jpg',
      tracks: [
        { title: 'Paranoid Android', filePath: '/m/1.flac', duration: 386 },
        { title: 'Karma Police', filePath: '/m/2.flac', duration: 261 },
      ],
    },
    {
      id: 'a2', name: 'Pablo Honey', artist: 'Radiohead', year: 1993,
      artPath: '/art/pablo.jpg',
      tracks: [
        { title: 'Creep', filePath: '/m/3.flac', duration: 238 },
      ],
    },
    {
      id: 'a3', name: 'Grace', artist: 'Jeff Buckley', year: 1994,
      artPath: '/art/grace.jpg',
      tracks: [
        { title: 'Hallelujah', filePath: '/m/4.flac', duration: 413 },
      ],
    },
  ]
}

test('build produces track, album and artist entries with counts', () => {
  const idx = LI.build(lib())
  assert.equal(idx.counts.albums, 3)
  assert.equal(idx.counts.tracks, 4)
  assert.equal(idx.counts.artists, 2) // Radiohead + Jeff Buckley
  assert.equal(idx.artists.find(a => a.name === 'Radiohead').albumCount, 2)
})

test('build tolerates malformed albums and tracks', () => {
  const idx = LI.build([null, { id: 'x' }, { id: 'y', tracks: [null, { title: 'ok', filePath: '/z' }] }])
  assert.equal(idx.counts.albums, 2)
  assert.equal(idx.counts.tracks, 1)
})

test('build on empty / non-array is safe', () => {
  assert.equal(LI.build([]).counts.tracks, 0)
  assert.equal(LI.build(null).counts.tracks, 0)
})

test('order-blind track search: "creep radiohead" and "radiohead creep" both hit', () => {
  const idx = LI.build(lib())
  const a = LI.query(idx, 'creep radiohead')
  const b = LI.query(idx, 'radiohead creep')
  assert.ok(a.tracks.length, 'creep radiohead finds the track')
  assert.equal(a.tracks[0].title, 'Creep')
  assert.equal(b.tracks[0].title, 'Creep')
})

test('song + band cross-field: song title and album artist together', () => {
  const idx = LI.build(lib())
  const r = LI.query(idx, 'hallelujah buckley')
  assert.ok(r.tracks.length)
  assert.equal(r.tracks[0].title, 'Hallelujah')
})

test('album and artist sections populate', () => {
  const idx = LI.build(lib())
  const r = LI.query(idx, 'radiohead')
  assert.ok(r.albums.length, 'albums section has Radiohead albums')
  assert.ok(r.artists.some(a => a.name === 'Radiohead'), 'artist section has Radiohead')
})

test('typo query hits via edit-distance scoring', () => {
  const idx = LI.build(lib())
  const r = LI.query(idx, 'radiohed creap')
  assert.ok(r.tracks.length, 'a two-typo query still finds Creep')
  assert.equal(r.tracks[0].title, 'Creep')
})

test('typo-tolerant scorer catches a single-token typo without needing correction', () => {
  const idx = LI.build(lib())
  // "paranoyd" is within the scorer's own edit-distance budget of "paranoid", so
  // it matches directly — no explicit correction needed. Documents that the
  // correction path is a *fallback*, not the first line of defence.
  const r = LI.query(idx, 'paranoyd')
  assert.ok(r.tracks.length, 'the typo still finds the track via scoring')
  assert.equal(r.tracks[0].title, 'Paranoid Android')
  assert.equal(r.corrected, null, 'no correction was needed')
})

test('zero-hit falls back to a vocabulary correction and reports the note', () => {
  const idx = LI.build(lib())
  // "radiuhaed" is edit distance 3 from "radiohead" — beyond the scorer's own
  // typo budget (2), so the raw search finds nothing. The correction pass uses a
  // wider budget (3), rescues it against the vocabulary, re-runs, and reports the
  // "did you mean" note. This is the genuine zero-hit → correction path.
  const raw = LI._rankList(idx.tracks, require('../src/smart-query').tokenize('radiuhaed'), 8)
  assert.equal(raw.length, 0, 'the scorer alone misses a distance-3 typo')
  const r = LI.query(idx, 'radiuhaed')
  assert.ok(r.tracks.length || r.albums.length, 'the corrected query finds Radiohead')
  assert.ok(r.corrected, 'a correction note is reported')
  assert.equal(r.corrected.to, 'radiohead')
  assert.equal(r.corrected.from, 'radiuhaed')
})

test('query with no plausible hit and no correction returns empty', () => {
  const idx = LI.build(lib())
  const r = LI.query(idx, 'zzzqqqxxx')
  assert.equal(r.tracks.length, 0)
  assert.equal(r.albums.length, 0)
  assert.equal(r.artists.length, 0)
  assert.equal(r.corrected, null)
})

test('limits cap each section', () => {
  const idx = LI.build(lib())
  const r = LI.query(idx, 'radiohead', { limits: { albums: 1 } })
  assert.equal(r.albums.length, 1)
})

test('rebuild after a rescan reflects the new library', () => {
  let idx = LI.build(lib())
  assert.equal(idx.counts.tracks, 4)
  const grown = lib()
  grown[0].tracks.push({ title: 'Exit Music', filePath: '/m/5.flac' })
  idx = LI.build(grown)
  assert.equal(idx.counts.tracks, 5)
  const r = LI.query(idx, 'exit music')
  assert.ok(r.tracks.length, 'the newly-added track is searchable after rebuild')
})

// ── Performance honesty: 10k-track synthetic library ─────────────────────────
test('micro-bench: index lookup stays under 20ms/query at 10k tracks', () => {
  const artists = ['Radiohead', 'Jeff Buckley', 'Portishead', 'Massive Attack',
    'Bjork', 'Aphex Twin', 'Boards of Canada', 'Burial', 'Four Tet', 'Bonobo']
  const words = ['dream', 'night', 'ocean', 'ghost', 'light', 'shadow', 'river',
    'ember', 'static', 'pulse', 'drift', 'signal', 'aurora', 'crystal', 'velvet']
  const big = []
  let tracks = 0
  let albumN = 0
  while (tracks < 10000) {
    const artist = artists[albumN % artists.length]
    const name = words[albumN % words.length] + ' ' + words[(albumN * 3) % words.length]
    const tr = []
    for (let k = 0; k < 10 && tracks < 10000; k++) {
      tr.push({
        title: words[(albumN + k) % words.length] + ' ' + words[(albumN * 2 + k) % words.length],
        filePath: '/m/' + tracks + '.flac',
      })
      tracks++
    }
    big.push({ id: 'al' + albumN, name, artist, tracks: tr })
    albumN++
  }

  const t0 = Date.now()
  const idx = LI.build(big)
  const buildMs = Date.now() - t0
  assert.equal(idx.counts.tracks, 10000)

  // Warm + measured runs across a spread of query shapes.
  const queries = ['dream night', 'radiohead ocean', 'ghost light burial',
    'aphex signal', 'bonobo drift velvet', 'massive attack pulse']
  for (const q of queries) LI.query(idx, q) // warm

  const runs = 200
  const s0 = process.hrtime.bigint()
  for (let i = 0; i < runs; i++) {
    LI.query(idx, queries[i % queries.length])
  }
  const s1 = process.hrtime.bigint()
  const perQueryMs = Number(s1 - s0) / 1e6 / runs

  // Reported for the record; the ceiling is the acceptance bar.
  console.log(`[bench] build ${buildMs}ms for 10k tracks; ${perQueryMs.toFixed(3)}ms/query`)
  assert.ok(perQueryMs < 20, `index lookup must stay under 20ms/query, got ${perQueryMs.toFixed(3)}ms`)
})

// ── J3: the library grid uses the same brain ─────────────────────────────────
function progLib() {
  return [
    { id: 'c1', name: 'Mirage', artist: 'Camel', year: 1974, tracks: [{ title: 'Lady Fantasy', filePath: '/c/1.flac' }] },
    { id: 'c2', name: 'Moonmadness', artist: 'Camel', year: 1976, tracks: [{ title: 'Song Within a Song', filePath: '/c/2.flac' }] },
    { id: 'k1', name: 'Discipline', artist: 'King Crimson', year: 1981, tracks: [{ title: 'Elephant Talk', filePath: '/k/1.flac' }] },
    { id: 's1', name: 'Crime of the Century', artist: 'Supertramp', year: 1974, tracks: [{ title: 'School', filePath: '/s/1.flac' }, { title: 'Dreamer', filePath: '/s/2.flac' }] },
  ]
}

test('filterAlbums: "camel mirage" (artist + album together) finds the album — the verified zero-result case', () => {
  const idx = LI.build(progLib())
  const r = LI.filterAlbums(idx, 'camel mirage')
  assert.deepEqual(r.ids, ['c1'])
  assert.equal(r.corrected, null)
  assert.equal(r.viaTracks, false)
})

test('filterAlbums: "king crimson discipline" — the most natural query form — works', () => {
  const idx = LI.build(progLib())
  assert.deepEqual(LI.filterAlbums(idx, 'king crimson discipline').ids, ['k1'])
  assert.deepEqual(LI.filterAlbums(idx, 'discipline crimson').ids, ['k1'], 'order-blind')
})

test('filterAlbums: an artist-only query returns that artist\'s albums in relevance order', () => {
  const idx = LI.build(progLib())
  const r = LI.filterAlbums(idx, 'camel')
  assert.deepEqual(r.ids.sort(), ['c1', 'c2'])
})

test('filterAlbums falls back to song titles only when artist/album find nothing', () => {
  const idx = LI.build(progLib())
  const r = LI.filterAlbums(idx, 'supertramp school')
  assert.deepEqual(r.ids, ['s1'])
  assert.equal(r.viaTracks, true, 'the caller can say "matched a song on this album"')
  // But a query that already matches on artist/album never widens.
  assert.equal(LI.filterAlbums(idx, 'supertramp').viaTracks, false)
})

test('filterAlbums corrects a heavy typo and reports it, or returns empty honestly', () => {
  const idx = LI.build(progLib())
  const r = LI.filterAlbums(idx, 'camel mirraagge')
  assert.deepEqual(r.ids, ['c1'])
  assert.ok(r.corrected && r.corrected.to === 'camel mirage' && r.corrected.from === 'camel mirraagge', JSON.stringify(r))
  const none = LI.filterAlbums(idx, 'zzzz qqqq')
  assert.deepEqual(none.ids, [])
  assert.equal(none.corrected, null)
  assert.deepEqual(LI.filterAlbums(idx, 'camel mirraagge', { correct: false }).ids, [], 'correction can be refused (the undo path)')
  assert.deepEqual(LI.filterAlbums(idx, '   ').ids, [])
  assert.deepEqual(LI.filterAlbums(null, 'camel').ids, [])
})

test('the wide album field carries every song word once', () => {
  const idx = LI.build(progLib())
  const s = idx.albums.find(a => a.id === 's1')
  assert.ok(s.allTokens.indexOf('school') !== -1 && s.allTokens.indexOf('dreamer') !== -1)
  assert.ok(s.tokens.indexOf('school') === -1, 'the narrow field stays artist + album')
})

// ── J3: did-you-mean that can be acted on ────────────────────────────────────

test('suggest returns runnable queries with human labels for a query the search missed', () => {
  const idx = LI.build(progLib())
  const s = LI.suggest(idx, 'camle mirge', 3)
  assert.ok(s.length >= 1)
  assert.equal(s[0].query, 'camel mirage', 'a real tokenized query, not an "Artist — Album" string')
  assert.equal(s[0].label, 'Camel — Mirage')
  // And the suggested query really works when run.
  assert.deepEqual(LI.filterAlbums(idx, s[0].query).ids, ['c1'])
})

test('suggest offers alternatives when the automatic correction was ambiguous', () => {
  // "dreamr" is one edit from "dreamer" and nothing else; "camel" is real.
  const idx = LI.build(progLib())
  const s = LI.suggest(idx, 'supertramp dreamr', 3)
  assert.ok(s.some(x => x.query === 'supertramp dreamer'))
  assert.ok(s.every(x => x.query && x.label))
})

test('suggest is empty when every word is already real (nothing to suggest) or nothing is near', () => {
  const idx = LI.build(progLib())
  assert.deepEqual(LI.suggest(idx, 'camel mirage'), [])
  assert.deepEqual(LI.suggest(idx, 'xxxxxxxx yyyyyyyy'), [])
  assert.deepEqual(LI.suggest(idx, ''), [])
  assert.deepEqual(LI.suggest(null, 'camel'), [])
})

test('suggest never returns two suggestions that mean the same thing', () => {
  const idx = LI.build(progLib())
  const s = LI.suggest(idx, 'camle', 5)
  const labels = s.map(x => x.label)
  assert.equal(new Set(labels).size, labels.length)
})

test('suggest never offers a record that merely typo-scores against the suggestion', () => {
  const idx = LI.build(progLib().concat([{ id: 'l1', name: 'All My Rage', artist: 'Laura Marling', tracks: [] }]))
  const s = LI.suggest(idx, 'camle mirraagge', 5)
  assert.ok(s.every(x => x.label !== 'Laura Marling — All My Rage'), JSON.stringify(s))
  assert.equal(s[0].query, 'camel mirage')
})
