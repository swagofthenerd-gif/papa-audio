'use strict'
const test = require('node:test')
const assert = require('node:assert')
const L = require('../src/library-manage')
const R = require('../src/manage-reclaim')

// Mirror library-manage's own fixture style, plus a codec so quality ranking has
// something real to read.
function trk(filePath, channels, opts = {}) {
  return Object.assign({
    filePath, channels,
    artist: 'Pink Floyd', albumArtist: 'Pink Floyd', album: 'Animals',
    fileSize: 100e6, codec: 'flac',
  }, opts)
}
function many(dir, n, channels, opts) {
  return Array.from({ length: n }, (_, i) => trk(`${dir}/${i + 1} Track.flac`, channels, opts))
}

// ── THE 0 MB BUG: the exact case that read "0 MB safely reclaimable" ──────────
test('two identical stereo rips report real reclaimable space (the 0 MB bug)', () => {
  // Same album, two full stereo copies — the common duplicate. library-manage
  // marks this UNRELIABLE (same layout) so deletableBytes is 0. The header used
  // to sum that 0. The keep-best rule must reclaim one whole copy.
  const groups = L.findDuplicates([
    ...many('/m/A-1', 10, 2, { fileSize: 30e6 }),
    ...many('/m/A-2', 10, 2, { fileSize: 30e6 }),
  ])
  assert.equal(groups.length, 1)
  // Baseline defect proof: the conservative number really is zero here.
  assert.equal(groups[0].deletableBytes, 0, 'precondition: conservative reclaimable is 0 for same-layout dupes')

  const pick = R.pickKeepBest(groups[0])
  assert.equal(pick.keep.length, 1, 'keeps exactly one copy')
  assert.equal(pick.drop.length, 1, 'drops the other copy')
  assert.equal(pick.reclaimBytes, 10 * 30e6, 'reclaims one full copy of the album')
})

test('reclaimableAcross sums per-group reclaim, not the broken 0', () => {
  const groups = L.findDuplicates([
    ...many('/m/A-1', 10, 2, { fileSize: 30e6 }),
    ...many('/m/A-2', 10, 2, { fileSize: 30e6 }),
    ...many('/m/B-1', 8, 2, { album: 'Meddle', fileSize: 20e6 }),
    ...many('/m/B-2', 8, 2, { album: 'Meddle', fileSize: 20e6 }),
  ])
  const total = R.reclaimableAcross(groups, 'best')
  assert.equal(total, 10 * 30e6 + 8 * 20e6)
  assert.ok(total > 0, 'the header number is no longer zero')
})

// ── keep-best chooses on quality, not size ───────────────────────────────────
test('keep-best keeps the lossless copy and drops the lossy one', () => {
  const groups = L.findDuplicates([
    ...many('/m/flac', 10, 2, { codec: 'flac', fileSize: 40e6 }),
    ...many('/m/mp3', 10, 2, { codec: 'mp3', fileSize: 8e6 }),
  ])
  const pick = R.pickKeepBest(groups[0])
  assert.deepEqual(pick.keep, ['/m/flac'])
  assert.deepEqual(pick.drop, ['/m/mp3'])
  assert.equal(pick.reclaimBytes, 10 * 8e6)
})

test('keep-best keeps higher bit depth when both are lossless', () => {
  const groups = L.findDuplicates([
    ...many('/m/24bit', 10, 2, { codec: 'flac', bitsPerSample: 24, fileSize: 80e6 }),
    ...many('/m/16bit', 10, 2, { codec: 'flac', bitsPerSample: 16, fileSize: 40e6 }),
  ])
  const pick = R.pickKeepBest(groups[0])
  assert.deepEqual(pick.keep, ['/m/24bit'])
  assert.equal(pick.reclaimBytes, 10 * 40e6)
})

// ── keep-largest chooses on size ─────────────────────────────────────────────
test('keep-largest keeps the biggest copy regardless of quality', () => {
  const groups = L.findDuplicates([
    ...many('/m/big-mp3', 10, 2, { codec: 'mp3', fileSize: 50e6 }),
    ...many('/m/small-flac', 10, 2, { codec: 'flac', fileSize: 20e6 }),
  ])
  const pick = R.pickKeepLargest(groups[0])
  assert.deepEqual(pick.keep, ['/m/big-mp3'])
  assert.equal(pick.reclaimBytes, 10 * 20e6)
})

// ── SAFETY: never propose dropping a copy that loses music ────────────────────
test('a copy holding a track the keeper lacks is protected, not dropped', () => {
  // keep-best would keep the surround copy (higher... no; same codec). Force the
  // keeper to be the smaller copy by quality, then prove the copy with a unique
  // track is protected. Here both lossless; keeper is the one with more tracks
  // (tiebreak). The 3-track copy keeps; the copy with a unique 4th survives.
  const groups = L.findDuplicates([
    trk('/m/full/A.flac', 2, { title: 'A' }),
    trk('/m/full/B.flac', 2, { title: 'B' }),
    trk('/m/full/C.flac', 2, { title: 'C' }),
    trk('/m/other/A.flac', 2, { title: 'A' }),
    trk('/m/other/Z.flac', 2, { title: 'Z' }), // unique song
  ])
  const pick = R.pickKeepBest(groups[0])
  // The 3-track copy is the keeper (more complete). The 2-track copy has a unique
  // song 'Z', so it must be protected.
  assert.deepEqual(pick.keep, ['/m/full'])
  assert.equal(pick.drop.length, 0, 'the copy with a unique track is not dropped')
  assert.equal(pick.protected.length, 1)
  assert.match(pick.protected[0].reason, /track the kept copy does not/)
  assert.equal(pick.reclaimBytes, 0)
})

test('a mixed stereo+surround folder is protected from bulk drop', () => {
  const groups = L.findDuplicates([
    ...many('/m/clean', 10, 2),
    ...many('/m/mixed', 9, 2),
    trk('/m/mixed/10 Track.flac', 6), // makes /m/mixed mixed-channel
  ])
  const mixed = groups[0].folders.find(f => f.dir === '/m/mixed')
  assert.equal(mixed.mixedChannels, true)
  // keep-best keeps /m/clean (10 tracks, stereo) — but /m/mixed also has 10
  // tracks. Whichever is kept, if /m/mixed is a candidate to drop it must be
  // protected for mixing channels.
  const pickBest = R.pickKeepBest(groups[0])
  const pickLargest = R.pickKeepLargest(groups[0])
  for (const pick of [pickBest, pickLargest]) {
    if (pick.drop.indexOf('/m/mixed') !== -1) assert.fail('mixed folder must never be dropped')
    if (pick.keep.indexOf('/m/mixed') === -1) {
      // it's neither kept nor dropped → protected
      assert.ok(pick.protected.some(p => p.dir === '/m/mixed' && /mixes stereo and surround/.test(p.reason)))
    }
  }
})

test('a single-copy group reclaims nothing', () => {
  const groups = L.buildFolders(many('/m/solo', 10, 2))
  const pick = R.pickKeepBest({ folders: groups })
  assert.equal(pick.drop.length, 0)
  assert.equal(pick.reclaimBytes, 0)
})

test('three copies keep one, drop two', () => {
  const groups = L.findDuplicates([
    ...many('/m/c1', 10, 2, { codec: 'flac', fileSize: 30e6 }),
    ...many('/m/c2', 10, 2, { codec: 'flac', fileSize: 30e6 }),
    ...many('/m/c3', 10, 2, { codec: 'flac', fileSize: 30e6 }),
  ])
  const pick = R.pickKeepBest(groups[0])
  assert.equal(pick.keep.length, 1)
  assert.equal(pick.drop.length, 2)
  assert.equal(pick.reclaimBytes, 2 * 10 * 30e6)
})
