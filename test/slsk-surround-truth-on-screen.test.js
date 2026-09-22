'use strict'
// The row said "upgrade" while showing a bare "FLAC 24/88" beside
// "yours: FLAC 16/44 · 5.1" — which reads as "trade your surround for a
// stereo". It was not: the peer copy WAS the 5.1 mix, and upgradeReason knew
// it, because buildShelves decided surround with detectSurround and fed that
// to the comparison. It just never told the screen: the album objects handed
// back to the UI kept their own narrower `surround`, so the quality string had
// no channel suffix to print.
//
// Measured on his own cached peers before the fix: all 16 surround-to-surround
// upgrades rendered with no surround marker on the peer side, and 0 were
// actually stereo. The decision was right the whole time; the display lied.
//
// The second half is what he asked for directly: when his copy IS the surround
// one and the peer's is not, gate 0a refuses the upgrade — and the row now
// says so instead of falling through to a bland "same as yours".

const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')
const H = require('../src/slsk-hunt')
const { buildTree } = require('../src/slsk-tree')

// A peer share whose surround-ness is only knowable from the path, which is
// exactly the case detectSurround exists for.
const peerDirs = [
  { name: 'Share\\SURROUND\\Bob Dylan - Another Side (5.1 Mix)', files: [
    { filename: '01.flac', size: 100, bitDepth: 24, sampleRate: 88200 },
    { filename: '02.flac', size: 100, bitDepth: 24, sampleRate: 88200 } ] },
]
const detectSurround = (text) => /surround|5\.1/i.test(String(text || ''))

// His copy: a 5.1 SACD rip at 16/44, the shape of the real one in his library.
const mySurround = [{
  id: 'lib1', artist: 'Bob Dylan', name: 'Another Side',
  maxBitsPerSample: 16, maxSampleRate: 44100, maxChannels: 6, codec: 'FLAC', isHiRes: false,
  tracks: [{ filePath: '/m/1.flac' }, { filePath: '/m/2.flac' }],
}]

function rowsFor(dirs, library) {
  const albums = S.extractAlbums(buildTree(dirs), { minTracks: 2 })
  return H.buildRows(S.buildShelves(albums, library, { detectSurround }), library)
}

test('a peer 5.1 upgrade says so on the peer side of the row', () => {
  const row = rowsFor(peerDirs, mySurround)[0]
  assert.equal(row.verdictKind, 'upgrade', 'a higher-res 5.1 over a 16/44 5.1 is a real upgrade')
  assert.match(row.yours, /5\.1/, 'his copy is shown as surround')
  assert.match(row.theirs, /surround|5\.1/,
    'and so is theirs — otherwise the row reads "trade your 5.1 for a stereo"')
})

test('the flag the decision used is the flag the shelves hand back', () => {
  const albums = S.extractAlbums(buildTree(peerDirs), { minTracks: 2 })
  assert.equal(albums[0].surround, false, 'the album itself cannot tell')
  const shelves = S.buildShelves(albums, mySurround, { detectSurround })
  assert.equal(shelves.everything[0].surround, true, 'but the shelf it is handed back on can')
  assert.equal(shelves.upgrades[0].surround, true)
  assert.equal(shelves.surround[0].surround, true)
})

test('deciding surround does not mutate the caller\'s albums', () => {
  const albums = S.extractAlbums(buildTree(peerDirs), { minTracks: 2 })
  S.buildShelves(albums, mySurround, { detectSurround })
  assert.equal(albums[0].surround, false, 'the input is left exactly as it was')
})

test('a stereo copy is still refused, and now the row says why', () => {
  // Their copy is better on paper — 24/192 against his 16/44 — and stereo.
  const stereo = [
    { name: 'Share\\Bob Dylan - Another Side [24-192]', files: [
      { filename: '01.flac', size: 100, bitDepth: 24, sampleRate: 192000 },
      { filename: '02.flac', size: 100, bitDepth: 24, sampleRate: 192000 } ] },
  ]
  const row = rowsFor(stereo, mySurround)[0]
  assert.notEqual(row.verdictKind, 'upgrade', 'no sample rate buys back a rear channel')
  assert.equal(row.verdictKind, 'keepsurround')
  assert.match(row.verdictText, /yours is surround/i)
  assert.match(row.verdictText, /theirs is not/i)
})

test('an album whose channels were never read makes no claim', () => {
  const stereo = [
    { name: 'Share\\Bob Dylan - Another Side [24-192]', files: [
      { filename: '01.flac', size: 100, bitDepth: 24, sampleRate: 192000 },
      { filename: '02.flac', size: 100, bitDepth: 24, sampleRate: 192000 } ] },
  ]
  const unknown = [{ ...mySurround[0], maxChannels: 0 }]
  const row = rowsFor(stereo, unknown)[0]
  assert.notEqual(row.verdictKind, 'keepsurround', 'silence is not evidence of surround')
})

test('keepsMySurround needs a known count on his side and no surround on theirs', () => {
  assert.equal(H.keepsMySurround({ surround: false }, { maxChannels: 6 }), true)
  assert.equal(H.keepsMySurround({ surround: true }, { maxChannels: 6 }), false, 'both surround')
  assert.equal(H.keepsMySurround({ surround: false }, { maxChannels: 2 }), false, 'his is stereo')
  assert.equal(H.keepsMySurround({ surround: false }, { maxChannels: 0 }), false, 'unknown')
  assert.equal(H.keepsMySurround({ surround: false }, null), false, 'no match at all')
})

test('the chunked shelf builder decides surround identically', async () => {
  const albums = S.extractAlbums(buildTree(peerDirs), { minTracks: 2 })
  const sync = S.buildShelves(albums, mySurround, { detectSurround })
  const chunked = await S.buildShelvesChunked(albums, mySurround, { detectSurround })
  assert.equal(chunked.everything[0].surround, sync.everything[0].surround)
  assert.deepEqual(chunked.upgrades, sync.upgrades)
  assert.deepEqual(chunked.surround, sync.surround)
  assert.deepEqual(chunked.everything, sync.everything)
})

test('markInLibrary still stamps the caller\'s own albums', async () => {
  // decided[] hands the walker copies for surround albums; the stamp has to
  // reach the originals or the shop's "In Library" marking stops working on
  // exactly the surround ones.
  const albums = S.extractAlbums(buildTree(peerDirs), { minTracks: 2 })
  await S.buildShelvesChunked(albums, mySurround, { detectSurround, markInLibrary: true })
  assert.equal(albums[0].inLibrary, true, 'the input album is marked')
})
