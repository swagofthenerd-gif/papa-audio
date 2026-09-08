'use strict'
const test = require('node:test')
const assert = require('node:assert')
const RD = require('../src/manage-redundant')
const S = require('../src/slsk-shelves') // real identity matcher — same one the shop uses

function album(id, name, artist, ext, sizeEach = 10e6, tracks = 10) {
  return {
    id, name, artist,
    tracks: Array.from({ length: tracks }, (_, i) => ({
      filePath: `/m/${id}/${i + 1}.${ext}`, fileSize: sizeEach,
      codec: ext === 'mp3' ? 'mp3' : 'flac',
    })),
  }
}

test('an mp3 album with no flac twin is not redundant', () => {
  const lib = [album('a', 'Kind of Blue', 'Miles Davis', 'mp3')]
  const r = RD.findRedundantLossy(lib, S)
  assert.equal(r.pairs.length, 0)
  assert.equal(r.totalReclaimBytes, 0)
})

test('an mp3 album WITH a flac twin of the same identity is redundant', () => {
  const lib = [
    album('flac', 'Kind of Blue', 'Miles Davis', 'flac', 40e6),
    album('mp3', 'Kind of Blue', 'Miles Davis', 'mp3', 8e6),
  ]
  const r = RD.findRedundantLossy(lib, S)
  assert.equal(r.pairs.length, 1)
  assert.equal(r.pairs[0].lossyAlbum.id, 'mp3')
  assert.equal(r.pairs[0].losslessAlbum.id, 'flac')
  assert.equal(r.pairs[0].lossyBytes, 10 * 8e6)
  assert.equal(r.totalReclaimBytes, 10 * 8e6)
})

test('identity, not string equality: a remaster/edition still matches', () => {
  const lib = [
    album('flac', 'Kind of Blue (Legacy Edition)', 'Miles Davis', 'flac'),
    album('mp3', 'Kind of Blue', 'Miles Davis', 'mp3'),
  ]
  const r = RD.findRedundantLossy(lib, S)
  assert.equal(r.pairs.length, 1, 'edition suffix must not hide the redundancy')
})

test('different albums by the same artist are not paired', () => {
  const lib = [
    album('flac', 'Bitches Brew', 'Miles Davis', 'flac'),
    album('mp3', 'Kind of Blue', 'Miles Davis', 'mp3'),
  ]
  const r = RD.findRedundantLossy(lib, S)
  assert.equal(r.pairs.length, 0)
})

test('two lossless copies are not a redundant-lossy pair', () => {
  const lib = [
    album('flac1', 'Kind of Blue', 'Miles Davis', 'flac'),
    album('flac2', 'Kind of Blue', 'Miles Davis', 'flac'),
  ]
  const r = RD.findRedundantLossy(lib, S)
  assert.equal(r.pairs.length, 0, 'lossless duplicates belong to the Duplicates tool, not here')
})

test('lossyPathsOf returns every track path of the lossy copies', () => {
  const lib = [
    album('flac', 'Kind of Blue', 'Miles Davis', 'flac'),
    album('mp3', 'Kind of Blue', 'Miles Davis', 'mp3', 8e6, 3),
  ]
  const r = RD.findRedundantLossy(lib, S)
  const paths = RD.lossyPathsOf(r.pairs)
  assert.deepEqual(paths, ['/m/mp3/1.mp3', '/m/mp3/2.mp3', '/m/mp3/3.mp3'])
})

test('albumIsLossless reads codec then extension', () => {
  assert.equal(RD.albumIsLossless(album('a', 'X', 'Y', 'flac')), true)
  assert.equal(RD.albumIsLossless(album('a', 'X', 'Y', 'mp3')), false)
  assert.equal(RD.albumIsLossless({ tracks: [] }), false)
})

test('a missing/degraded shelves module fails closed, not throws', () => {
  const r = RD.findRedundantLossy([album('a', 'X', 'Y', 'mp3')], null)
  assert.deepEqual(r, { pairs: [], totalReclaimBytes: 0 })
})

test('biggest waste is listed first', () => {
  const lib = [
    album('flacA', 'Album A', 'Artist A', 'flac'),
    album('mp3A', 'Album A', 'Artist A', 'mp3', 5e6, 10),   // 50 MB
    album('flacB', 'Album B', 'Artist B', 'flac'),
    album('mp3B', 'Album B', 'Artist B', 'mp3', 12e6, 10),  // 120 MB
  ]
  const r = RD.findRedundantLossy(lib, S)
  assert.equal(r.pairs.length, 2)
  assert.equal(r.pairs[0].lossyAlbum.id, 'mp3B', 'largest lossy copy first')
})
