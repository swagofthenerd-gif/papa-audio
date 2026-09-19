'use strict'
// "5.1 Surround Sound" is not an album called "1 Surround Sound".
//
// Two faults stacked. The walker folded only disc children (CD1, Disc 2) into
// their parent, so a "5.1 Surround Sound" subfolder became an album of its own;
// and LEADING_NUM — meant for "01 - Album" — then ate the "5." off the front of
// it. The shop rendered the result as a card reading "1 Surround Sound /
// Appetite For Destruction · 1987", and that string went on to the wishlist.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')
const { buildTree } = require('../src/slsk-tree')

test('cleanSegment no longer eats the "5." off a channel layout', () => {
  assert.strictEqual(S.cleanSegment('5.1 Surround Sound'), '5.1 Surround Sound')
  assert.strictEqual(S.cleanSegment('7.1 Mix'), '7.1 Mix')
  assert.strictEqual(S.cleanSegment('2.0 Stereo'), '2.0 Stereo')
})

test('a real leading track number is still stripped', () => {
  assert.strictEqual(S.cleanSegment('01 - Appetite For Destruction'),
    'Appetite For Destruction')
  assert.strictEqual(S.cleanSegment('3. Nevermind'), 'Nevermind')
})

test('isSurroundFolder reads a surround-only leaf and nothing else', () => {
  for (const yes of ['5.1', '5.1 Surround Sound', '5_1', '7.1', '7.1 mix',
    'Multichannel', 'multi-channel', 'MCH', 'Quad', 'Quadraphonic',
    'Surround', 'Atmos', 'Dolby Atmos']) {
    assert.ok(S.isSurroundFolder(yes), `expected "${yes}" to read as a surround leaf`)
  }
  for (const no of ['Appetite For Destruction', 'Surrounded By Time', '5.1 Broadway Cast',
    'CD1', '', 'Quadrant']) {
    assert.ok(!S.isSurroundFolder(no), `"${no}" is not a bare surround leaf`)
  }
})

// ── Through the real walker ──────────────────────────────────────────────────
const dirs = [
  { name: "Guns N' Roses\\Appetite For Destruction (1987)\\5.1 Surround Sound", files: [
    { filename: "Guns N' Roses\\Appetite For Destruction (1987)\\5.1 Surround Sound\\01 Welcome to the Jungle.flac", size: 100, bitDepth: 24, sampleRate: 96000 },
    { filename: "Guns N' Roses\\Appetite For Destruction (1987)\\5.1 Surround Sound\\02 It's So Easy.flac", size: 100, bitDepth: 24, sampleRate: 96000 },
  ] },
]

test('the surround child folds into its parent album and is flagged', () => {
  const albums = S.extractAlbums(buildTree(dirs))
  assert.strictEqual(albums.length, 1, 'got: ' + albums.map(a => `"${a.album}"`).join(', '))
  const a = albums[0]
  assert.strictEqual(a.album, 'Appetite For Destruction')
  assert.strictEqual(a.artist, "Guns N' Roses")
  assert.strictEqual(a.year, 1987)
  assert.strictEqual(a.surround, true)
  assert.strictEqual(a.trackCount, 2, 'the folded tracks came with it')
  // The name that caused it all is nowhere.
  assert.notStrictEqual(a.album, '1 Surround Sound')
})

test('the chunked walker agrees', async () => {
  const albums = await S.extractAlbumsChunked(buildTree(dirs), { budgetMs: 1 })
  assert.deepStrictEqual(albums.map(a => a.album), ['Appetite For Destruction'])
  assert.strictEqual(albums[0].surround, true)
})

test('a folded surround album reaches the Surround shelf without any text to read', () => {
  const albums = S.extractAlbums(buildTree(dirs))
  // No detectSurround injected at all: the flag the walker set is the only
  // evidence left, because the labelled folder name is gone from the path.
  const sh = S.buildShelves(albums, [], {})
  assert.deepStrictEqual(sh.surround.map(a => a.album), ['Appetite For Destruction'])
  assert.strictEqual(sh.stats.surround, 1)
})

test('an ordinary disc child still folds, and is not called surround', () => {
  const discDirs = [
    { name: 'Pink Floyd\\The Wall (1979)\\CD1', files: [
      { filename: 'Pink Floyd\\The Wall (1979)\\CD1\\01 In the Flesh.flac', size: 100 },
      { filename: 'Pink Floyd\\The Wall (1979)\\CD1\\02 The Thin Ice.flac', size: 100 },
    ] },
    { name: 'Pink Floyd\\The Wall (1979)\\CD2', files: [
      { filename: 'Pink Floyd\\The Wall (1979)\\CD2\\01 Hey You.flac', size: 100 },
      { filename: 'Pink Floyd\\The Wall (1979)\\CD2\\02 Comfortably Numb.flac', size: 100 },
    ] },
  ]
  const albums = S.extractAlbums(buildTree(discDirs))
  assert.strictEqual(albums.length, 1)
  assert.strictEqual(albums[0].album, 'The Wall')
  assert.strictEqual(albums[0].trackCount, 4)
  assert.strictEqual(albums[0].surround, false)
})
