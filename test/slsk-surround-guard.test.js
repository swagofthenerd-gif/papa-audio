'use strict'
// The 5.1 guard.
//
// The record shop's "Upgrades for you" shelf compared a peer's copy against the
// user's on lossless / bit depth / sample rate and NOTHING else. On his real
// library that put nine of his surround masters on the upgrade shelf — Dark Side
// of the Moon read "Yours: FLAC 24/88 → Theirs: FLAC 24/192" where his copy is
// six channels and theirs is two — and "Grab all" would have downloaded every
// one of them over the top.
//
// A stereo copy of a surround album is a different, smaller record. No sample
// rate buys back a rear channel. These tests hold that line from both sides:
// stereo is never an upgrade over surround, and surround IS an upgrade over a
// known-stereo copy.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')
const { buildTree } = require('../src/slsk-tree')
const { detectSurround } = require('../src/slsk-filters')

// A library album in the renderer's own shape, so libAlbumToComparable is the
// code under test rather than a hand-built comparable.
function libAlbum(extra) {
  return Object.assign({
    id: 'lib1',
    name: 'The Dark Side of the Moon',
    artist: 'Pink Floyd',
    maxBitsPerSample: 24,
    maxSampleRate: 88200,
    tracks: [
      { filePath: '/mnt/data/MUSIC/PF/DSOTM/01.flac', bitsPerSample: 24, sampleRate: 88200 },
      { filePath: '/mnt/data/MUSIC/PF/DSOTM/02.flac', bitsPerSample: 24, sampleRate: 88200 },
    ],
  }, extra || {})
}

// ── The comparable carries channels at all ───────────────────────────────────
test('libAlbumToComparable carries maxChannels', () => {
  const c = S.libAlbumToComparable(libAlbum({ maxChannels: 6 }))
  assert.strictEqual(c.channels, 6)
})

test('libAlbumToComparable falls back to the widest track when maxChannels is absent', () => {
  const c = S.libAlbumToComparable(libAlbum({
    tracks: [
      { filePath: '/m/01.flac', channels: 2 },
      { filePath: '/m/02.flac', channels: 6 },
    ],
  }))
  assert.strictEqual(c.channels, 6)
})

test('libAlbumToComparable reports 0 when nothing knows the channel count', () => {
  assert.strictEqual(S.libAlbumToComparable(libAlbum()).channels, 0)
})

// ── The gate itself ──────────────────────────────────────────────────────────
test('a stereo 24/192 is NOT an upgrade over a 6-channel 24/88.2 master', () => {
  const mine = S.libAlbumToComparable(libAlbum({ maxChannels: 6 }))
  const peer = { lossless: true, maxBitDepth: 24, maxSampleRate: 192000, surround: false }
  assert.strictEqual(S.upgradeReason(peer, mine), null)
})

test('nor is a stereo lossless copy over a lossy surround one', () => {
  // Every other ladder rung would have said yes: lossless beats lossy outright.
  const mine = S.libAlbumToComparable(libAlbum({
    maxChannels: 6, maxBitsPerSample: 0, maxSampleRate: 0,
    tracks: [{ filePath: '/m/01.mp3' }, { filePath: '/m/02.mp3' }],
  }))
  const peer = { lossless: true, maxBitDepth: 24, maxSampleRate: 96000, surround: false }
  assert.strictEqual(S.upgradeReason(peer, mine), null)
})

test('a surround peer IS an upgrade over a known-stereo copy', () => {
  const mine = S.libAlbumToComparable(libAlbum({ maxChannels: 2 }))
  const peer = { lossless: true, maxBitDepth: 24, maxSampleRate: 88200, surround: true }
  const r = S.upgradeReason(peer, mine)
  assert.ok(r, 'expected an upgrade')
  assert.strictEqual(r.kind, 'surround')
  // And it says so in words the card renders, on both sides.
  assert.match(r.theirs, /surround/)
  assert.doesNotMatch(r.yours, /surround|5\.1/)
})

test('surround over surround falls back to the ordinary quality ladder', () => {
  const mine = S.libAlbumToComparable(libAlbum({ maxChannels: 6 }))
  const peer = { lossless: true, maxBitDepth: 24, maxSampleRate: 192000, surround: true }
  const r = S.upgradeReason(peer, mine)
  assert.ok(r)
  assert.strictEqual(r.kind, 'samplerate')
  // Yours is labelled honestly as the 5.1 it is.
  assert.strictEqual(r.yours, 'FLAC 24/88 · 5.1')
})

test('an unknown channel count makes no claim either way', () => {
  // channels 0 — the ladder behaves exactly as it did before the gate existed.
  const mine = S.libAlbumToComparable(libAlbum())
  assert.strictEqual(S.upgradeReason(
    { lossless: true, maxBitDepth: 24, maxSampleRate: 192000, surround: false }, mine).kind,
    'samplerate')
  assert.strictEqual(S.upgradeReason(
    { lossless: true, maxBitDepth: 24, maxSampleRate: 88200, surround: true }, mine), null)
})

test('stereo vs stereo, higher rate: unchanged', () => {
  const mine = S.libAlbumToComparable(libAlbum({ maxChannels: 2 }))
  const peer = { lossless: true, maxBitDepth: 24, maxSampleRate: 192000, surround: false }
  assert.strictEqual(S.upgradeReason(peer, mine).kind, 'samplerate')
})

// ── End to end, through buildShelves ─────────────────────────────────────────
// The live failure was not in upgradeReason alone: buildShelves never handed it
// the peer's surround reading. This drives the whole path with the real
// detectSurround and the real tree/album builders.
const peerDirs = [
  // A stereo hi-res rip of an album he owns in 5.1. The old code shelved this.
  { name: 'Pink Floyd\\The Dark Side of the Moon (1973) [FLAC 24-192]', files: [
    { filename: 'Pink Floyd\\The Dark Side of the Moon (1973) [FLAC 24-192]\\01 Speak to Me.flac', size: 100, bitDepth: 24, sampleRate: 192000 },
    { filename: 'Pink Floyd\\The Dark Side of the Moon (1973) [FLAC 24-192]\\02 Breathe.flac', size: 100, bitDepth: 24, sampleRate: 192000 },
  ] },
  // A genuine 5.1 of an album he owns in stereo.
  { name: 'Steely Dan\\Gaucho (1980) [5.1 DVD-A]', files: [
    { filename: 'Steely Dan\\Gaucho (1980) [5.1 DVD-A]\\01 Babylon Sisters.flac', size: 100, bitDepth: 24, sampleRate: 96000 },
    { filename: 'Steely Dan\\Gaucho (1980) [5.1 DVD-A]\\02 Hey Nineteen.flac', size: 100, bitDepth: 24, sampleRate: 96000 },
  ] },
]

const shelfLibrary = [
  libAlbum({ id: 'dsotm', maxChannels: 6 }),
  libAlbum({
    id: 'gaucho', name: 'Gaucho', artist: 'Steely Dan', maxChannels: 2,
    maxBitsPerSample: 16, maxSampleRate: 44100,
    tracks: [{ filePath: '/m/g/01.flac', bitsPerSample: 16, sampleRate: 44100 }],
  }),
]

function shelvesOf(build) {
  const albums = S.extractAlbums(buildTree(peerDirs))
  return build(albums)
}

test('buildShelves: the 5.1 master is not offered a stereo upgrade, the stereo one is offered 5.1', () => {
  const sh = shelvesOf(a => S.buildShelves(a, shelfLibrary, { detectSurround }))
  const kinds = new Map(sh.upgrades.map(u => [u.album, u.upgrade.kind]))
  assert.ok(!kinds.has('The Dark Side of the Moon'),
    'a stereo rip was shelved as an upgrade over a 5.1 master')
  assert.strictEqual(kinds.get('Gaucho'), 'surround')
})

test('buildShelvesChunked reaches the identical verdict', async () => {
  const albums = S.extractAlbums(buildTree(peerDirs))
  const sh = await S.buildShelvesChunked(albums, shelfLibrary, { detectSurround, budgetMs: 1 })
  const kinds = new Map(sh.upgrades.map(u => [u.album, u.upgrade.kind]))
  assert.ok(!kinds.has('The Dark Side of the Moon'))
  assert.strictEqual(kinds.get('Gaucho'), 'surround')
  // And the Surround shelf still finds the 5.1 folder — the flags feeding the
  // gate are the same flags feeding the shelf.
  assert.deepStrictEqual(sh.surround.map(a => a.album), ['Gaucho'])
})
