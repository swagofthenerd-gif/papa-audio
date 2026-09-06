'use strict'
// Wave-2 UI feature helpers (music side): the A–B loop state machine, the genre
// normaliser/writer, and the tag-fixer apply mapping. All pure, so they pin the
// rules the renderer wires up without needing the DOM or mpv.
const { test } = require('node:test')
const assert = require('node:assert')
const T = require('../src/music-tools')

// ── A–B loop cycle (App #5) ──────────────────────────────────────────────────
test('abLoopCycle: null → drops A at the current position', () => {
  const r = T.abLoopCycle(null, 12.5)
  assert.strictEqual(r.action, 'set-a')
  assert.deepStrictEqual(r.loop, { a: 12.5, b: null })
})

test('abLoopCycle: A set → a later press sets B and starts the loop', () => {
  const r = T.abLoopCycle({ a: 10, b: null }, 40)
  assert.strictEqual(r.action, 'set-b')
  assert.deepStrictEqual(r.loop, { a: 10, b: 40 })
})

test('abLoopCycle: a B at or before A re-drops A instead of a bad window', () => {
  const r = T.abLoopCycle({ a: 30, b: null }, 20)
  assert.strictEqual(r.action, 're-set-a')
  assert.deepStrictEqual(r.loop, { a: 20, b: null })
})

test('abLoopCycle: a full loop → the next press clears it', () => {
  const r = T.abLoopCycle({ a: 10, b: 40 }, 25)
  assert.strictEqual(r.action, 'clear')
  assert.strictEqual(r.loop, null)
})

test('abLoopCycle: a NaN/negative position drops A at 0, never below', () => {
  assert.deepStrictEqual(T.abLoopCycle(null, -5).loop, { a: 0, b: null })
  assert.deepStrictEqual(T.abLoopCycle(null, NaN).loop, { a: 0, b: null })
})

test('abLoopCycle: a corrupt stored shape is treated as no loop (drops A)', () => {
  assert.strictEqual(T.abLoopCycle({ a: 'x' }, 5).action, 'set-a')
})

// ── A–B loop jump target (App #5) ────────────────────────────────────────────
test('abLoopJumpTarget: past B returns A, before B returns null', () => {
  const loop = { a: 10, b: 20 }
  assert.strictEqual(T.abLoopJumpTarget(loop, 20.1), 10)
  assert.strictEqual(T.abLoopJumpTarget(loop, 15), null)
})

test('abLoopJumpTarget: the epsilon catches a tick landing a hair short of B', () => {
  // Default epsilon is 0.25, so 19.8 (0.2 short of B=20) still jumps.
  assert.strictEqual(T.abLoopJumpTarget({ a: 5, b: 20 }, 19.8), 5)
  // 19.5 is 0.5 short — outside the epsilon, no jump.
  assert.strictEqual(T.abLoopJumpTarget({ a: 5, b: 20 }, 19.5), null)
})

test('abLoopJumpTarget: a pending or absent loop never jumps', () => {
  assert.strictEqual(T.abLoopJumpTarget(null, 100), null)
  assert.strictEqual(T.abLoopJumpTarget({ a: 10, b: null }, 100), null)
  assert.strictEqual(T.abLoopJumpTarget({ a: 20, b: 10 }, 100), null) // b<=a
})

// ── Genre normalisation (App #8) ─────────────────────────────────────────────
const genreLib = [
  { id: 'a1', name: 'One', genre: 'Rock', tracks: [{ filePath: '/m/1.flac', genre: 'Rock' }] },
  { id: 'a2', name: 'Two', genre: 'rock', tracks: [{ filePath: '/m/2.flac', genre: 'rock' }] },
  { id: 'a3', name: 'Three', genre: 'Rock ', tracks: [{ filePath: '/m/3.flac', genre: 'Rock ' }] },
  { id: 'a4', name: 'Four', genre: 'Jazz', tracks: [{ filePath: '/m/4.flac', genre: 'Jazz' }] },
  { id: 'a5', name: 'Five', genre: '', tracks: [{ filePath: '/m/5.flac' }] },
  { id: 'a6', name: 'Six', genre: 'null', tracks: [{ filePath: '/m/6.flac', genre: 'null' }] },
]

test('analyzeGenres: folds case/whitespace variants into one group', () => {
  const res = T.analyzeGenres(genreLib)
  const rock = res.groups.find(g => g.key === 'rock')
  assert.ok(rock, 'a rock group exists')
  assert.strictEqual(rock.albumCount, 3) // Rock + rock + "Rock " all fold in
  // "Rock " trims to "Rock" (same spelling as a1), so only two DISTINCT
  // spellings remain: "Rock" (×2) and "rock" (×1).
  assert.strictEqual(rock.variants.length, 2)
  assert.strictEqual(rock.variants[0].value, 'Rock')
  assert.strictEqual(rock.variants[0].albumCount, 2)
})

test('analyzeGenres: suggests the most-used spelling as the merge target', () => {
  // Give "rock" (lowercase) a clear majority so it wins the suggestion over the
  // capitalised spellings.
  const lib = genreLib.concat([
    { id: 'a7', name: 'Seven', genre: 'rock', tracks: [{ filePath: '/m/7.flac', genre: 'rock' }] },
    { id: 'a8', name: 'Eight', genre: 'rock', tracks: [{ filePath: '/m/8.flac', genre: 'rock' }] },
    { id: 'a9', name: 'Nine', genre: 'rock', tracks: [{ filePath: '/m/9.flac', genre: 'rock' }] },
  ])
  const res = T.analyzeGenres(lib)
  const rock = res.groups.find(g => g.key === 'rock')
  assert.strictEqual(rock.suggested, 'rock')
})

test('analyzeGenres: counts un-genred albums (empty and junk values)', () => {
  const res = T.analyzeGenres(genreLib)
  assert.strictEqual(res.ungenred, 2) // '' and 'null'
})

test('genreWritesForAlbums: emits only tracks whose genre actually changes', () => {
  const albums = [
    { tracks: [
      { filePath: '/m/a.flac', genre: 'rock' },   // needs change → Rock
      { filePath: '/m/b.flac', genre: 'Rock' },   // already Rock → skip
      { filePath: '/m/c.flac' },                  // no genre → change
    ] },
  ]
  const writes = T.genreWritesForAlbums(albums, 'Rock')
  assert.strictEqual(writes.length, 2)
  assert.deepStrictEqual(writes[0], { filePath: '/m/a.flac', tags: { genre: 'Rock' } })
  assert.deepStrictEqual(writes[1], { filePath: '/m/c.flac', tags: { genre: 'Rock' } })
})

// ── Tag-fixer apply (App #9) ─────────────────────────────────────────────────
// Paired by track number (the reliable key): all three local tracks carry the
// number MusicBrainz uses, so each pairs to its release counterpart.
const localTracks = [
  { filePath: '/m/t1.flac', title: 'Song One', trackNumber: 1 },              // clean
  { filePath: '/m/t2.flac', title: 'Song Too', trackNumber: 2 },              // title differs
  { filePath: '/m/t3.flac', title: 'Song Three (Remastered)', trackNumber: 3 }, // cosmetic title
]
const mbTracks = [
  { title: 'Song One', position: 1 },
  { title: 'Song Two', position: 2 },
  { title: 'Song Three', position: 3 },
]

test('tagFixApplicableRows: only match rows with a real difference are applicable', () => {
  const diff = T.buildTagDiff(localTracks, mbTracks)
  const rows = T.tagFixApplicableRows(diff.rows)
  // t1 is clean (skip), t2 title differs, t3 cosmetic title.
  assert.strictEqual(rows.length, 2)
})

test('tagFixWrites: accepted rows become title/track tag writes', () => {
  const diff = T.buildTagDiff(localTracks, mbTracks)
  const applicable = T.tagFixApplicableRows(diff.rows)
  const writes = T.tagFixWrites(diff.rows, localTracks, applicable)
  const byPath = {}
  writes.forEach(w => { byPath[w.filePath] = w.tags })
  assert.deepStrictEqual(byPath['/m/t2.flac'], { title: 'Song Two' })
  // t3: cosmetic title only (the "(Remastered)" the release does not carry).
  assert.deepStrictEqual(byPath['/m/t3.flac'], { title: 'Song Three' })
  assert.ok(!byPath['/m/t1.flac'], 'a clean row writes nothing')
})

test('tagFixWrites: a track-number difference becomes a track tag write', () => {
  // A local track numbered 2 but titled to match MB position 3: pairs by number
  // to MB #2 ("Song Two"), so both title and number would be corrected.
  const loc = [{ filePath: '/m/x.flac', title: 'Wrong', trackNumber: 2 }]
  const mb = [{ title: 'Right', position: 2 }]
  const diff = T.buildTagDiff(loc, mb)
  const writes = T.tagFixWrites(diff.rows, loc, T.tagFixApplicableRows(diff.rows))
  assert.strictEqual(writes.length, 1)
  assert.strictEqual(writes[0].tags.title, 'Right')
})

test('tagFixWrites: an empty selection writes nothing', () => {
  const diff = T.buildTagDiff(localTracks, mbTracks)
  assert.strictEqual(T.tagFixWrites(diff.rows, localTracks, []).length, 0)
})

// ── Multi-disc grouping (App #10) ────────────────────────────────────────────
test('discNumberOf: prefers the tagged disc number', () => {
  assert.strictEqual(T.discNumberOf({ discNumber: 2, filePath: '/m/a.flac' }), 2)
})

test('discNumberOf: parses a disc number from the path when untagged', () => {
  assert.strictEqual(T.discNumberOf({ filePath: '/m/Album/Disc 2/03.flac' }), 2)
  assert.strictEqual(T.discNumberOf({ filePath: '/m/Album/CD2/03.flac' }), 2)
  assert.strictEqual(T.discNumberOf({ filePath: '/m/Album/03.flac' }), 1) // no hint → 1
})

test('albumHasMultipleDiscs: two distinct disc numbers → true', () => {
  assert.strictEqual(T.albumHasMultipleDiscs([
    { discNumber: 1 }, { discNumber: 1 }, { discNumber: 2 },
  ]), true)
})

test('albumHasMultipleDiscs: an untagged single-disc album → false', () => {
  // A mix of untagged (→disc 1) tracks must NOT read as multi-disc.
  assert.strictEqual(T.albumHasMultipleDiscs([
    { filePath: '/m/1.flac' }, { discNumber: 1 }, {},
  ]), false)
})
