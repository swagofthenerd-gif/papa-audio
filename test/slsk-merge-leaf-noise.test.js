'use strict'
// One album, one card.
//
// The search grid merges folder-groups by parsed {artist, album}. It parsed the
// RAW leaf segment, so a peer who files "…\In Rainbows\Disc 1" produced the
// album "Disc 1" — and "CD1", "disc 1", "Disc One" and "44.1" each produced
// their own one-person album, all of them sitting beside the real merged card
// for the same record. The shelves walker has folded disc folders since day
// one; this is the search side catching up.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')

function group(username, folderPath, n) {
  const files = []
  for (let i = 1; i <= (n || 4); i++) {
    files.push({
      name: `${String(i).padStart(2, '0')}.flac`,
      filename: `${folderPath}\\${String(i).padStart(2, '0')}.flac`,
      size: 25e6, isFlac: true, bitDepth: 16, sampleRate: 44100,
    })
  }
  return {
    username,
    folderPath,
    folderName: folderPath.split('\\').pop(),
    files,
    hasFreeSlot: true,
    queueLength: 0,
    uploadSpeed: 100000,
  }
}

const BASE = 'Music\\Radiohead\\In Rainbows'

test('isQualityLeaf reads a bare label and leaves real titles alone', () => {
  for (const yes of ['FLAC', 'flac', '44.1', '16-44', '24bit', '24 bit', 'WEB',
    'lossless', 'Hi-Res', 'Vinyl', '96', '192', 'mp3', 'Scans']) {
    assert.ok(S.isQualityLeaf(yes), `expected "${yes}" to read as a quality leaf`)
  }
  for (const no of ['In Rainbows', '1999', '24 Carat Black', 'Kid A',
    'Flaco Jimenez', 'Webster Hall', '']) {
    assert.ok(!S.isQualityLeaf(no), `"${no}" is an album, not a quality leaf`)
  }
})

test('stripLeafNoise never strips a path down to nothing', () => {
  assert.deepStrictEqual(S.stripLeafNoise(['FLAC']), ['FLAC'])
  assert.deepStrictEqual(S.stripLeafNoise(['Radiohead', 'In Rainbows', 'CD1', 'FLAC']),
    ['Radiohead', 'In Rainbows'])
})

test('disc and quality leaves merge into the album card instead of standing beside it', () => {
  const groups = [
    group('alice', BASE),
    group('bob', `${BASE}\\Disc 1`),
    group('carol', `${BASE}\\CD1`),
    group('dave', `${BASE}\\disc 1`),
    group('erin', `${BASE}\\Disc One`),
    group('frank', `${BASE}\\44.1`),
    group('grace', `${BASE}\\flac`),
  ]
  const merged = S.mergeSourcesByAlbum(groups)
  assert.strictEqual(merged.length, 1, 'expected one album card, got: ' +
    merged.map(m => `"${m.album}"`).join(', '))
  assert.strictEqual(merged[0].album, 'In Rainbows')
  assert.strictEqual(merged[0].peopleCount, 7)
})

test('a genuinely different album still gets its own card', () => {
  const merged = S.mergeSourcesByAlbum([
    group('alice', BASE),
    group('bob', 'Music\\Radiohead\\Kid A'),
    group('carol', `${BASE}\\Disc 2`),
  ])
  const albums = merged.map(m => m.album).sort()
  assert.deepStrictEqual(albums, ['In Rainbows', 'Kid A'])
})

test('an injected parser still wins — the default is only a default', () => {
  const merged = S.mergeSourcesByAlbum(
    [group('alice', BASE), group('bob', `${BASE}\\Disc 1`)],
    { parse: (g) => ({ artist: 'X', album: g.folderName, year: null }) })
  assert.strictEqual(merged.length, 2)
})
