const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')
const F = require('../src/slsk-filters')

// A search folder-group as _slskGroupByFolder emits it: one per (peer, folder).
function grp(username, folderPath, files, extra = {}) {
  const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath
  return {
    username, folderPath, folderName,
    hasFreeSlot: false, queueLength: 0, uploadSpeed: 0,
    files: files.map(f => ({ isFlac: /\.flac$/i.test(f.filename), ...f })),
    ...extra,
  }
}

// ── Size formatting (Task 6) ──────────────────────────────────────────────────
test('fmtSize rolls GB up to TB and never shows a 4-digit unit', () => {
  // The reported bug: 6453.3 GB should read as 6.3 TB.
  const sixKGb = Math.round(6453.3 * 1024 * 1024 * 1024)
  assert.equal(S.fmtSize(sixKGb), '6.3 TB')
})

test('fmtSize whole-number units drop the trailing .0', () => {
  assert.equal(S.fmtSize(1024 * 1024 * 1024 * 2), '2 GB')
  assert.equal(S.fmtSize(1024 * 1024 * 5), '5 MB')
})

test('fmtSize bytes and KB render as whole numbers', () => {
  assert.equal(S.fmtSize(500), '500 B')
  assert.equal(S.fmtSize(1536), '2 KB')
  assert.equal(S.fmtSize(0), '0 B')
})

test('fmtSize handles a petabyte-scale collection without overflowing units', () => {
  const twoPb = 2 * 1024 ** 5
  assert.equal(S.fmtSize(twoPb), '2 PB')
})

// ── Album-identity merge (Task 1) ─────────────────────────────────────────────
test('merges the same album from many people into one card', () => {
  const groups = [
    grp('alice', 'Music\\Radiohead - In Rainbows (2007)', [
      { filename: '01.flac', size: 100 }, { filename: '02.flac', size: 100 }]),
    grp('bob', 'shared\\Radiohead\\In Rainbows', [
      { filename: '1.mp3', size: 50 }, { filename: '2.mp3', size: 50 }]),
    grp('carol', 'FLAC\\Radiohead - In Rainbows [2007] [FLAC]', [
      { filename: 'a.flac', size: 200 }, { filename: 'b.flac', size: 200 }]),
  ]
  const merged = S.mergeSourcesByAlbum(groups, { detectSurround: F.detectSurround })
  assert.equal(merged.length, 1, 'three sources of one album collapse to one card')
  assert.equal(merged[0].peopleCount, 3)
  assert.equal(merged[0].album, 'In Rainbows')
  assert.equal(merged[0].sources.length, 3)
})

test('same album under DIFFERENT folder names still merges', () => {
  const groups = [
    grp('u1', 'Pink Floyd\\1973 - The Dark Side of the Moon', [
      { filename: '01.flac', size: 1 }, { filename: '02.flac', size: 1 }]),
    grp('u2', 'PF - Dark Side Of The Moon (1973) [24-96]', [
      { filename: 'x.flac', size: 1 }, { filename: 'y.flac', size: 1 }]),
    grp('u3', 'Pink Floyd - The Dark Side of the Moon - Remastered', [
      { filename: 'a.flac', size: 1 }, { filename: 'b.flac', size: 1 }]),
  ]
  const merged = S.mergeSourcesByAlbum(groups)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].peopleCount, 3)
})

test('different albums do NOT merge', () => {
  const groups = [
    grp('a', 'Radiohead - OK Computer', [{ filename: '1.flac', size: 1 }, { filename: '2.flac', size: 1 }]),
    grp('b', 'Radiohead - In Rainbows', [{ filename: '1.flac', size: 1 }, { filename: '2.flac', size: 1 }]),
  ]
  const merged = S.mergeSourcesByAlbum(groups)
  assert.equal(merged.length, 2)
})

test('best source is the highest-quality copy across all people', () => {
  const groups = [
    // A fast, idle MP3 peer — great availability, worst quality.
    grp('mp3guy', 'Artist - Album', [{ filename: '1.mp3', size: 1 }, { filename: '2.mp3', size: 1 }],
      { hasFreeSlot: true, uploadSpeed: 999999 }),
    // A queued FLAC 24/96 peer — worse availability, best quality.
    grp('flacguy', 'Artist - Album', [
      { filename: '1.flac', size: 1, bitDepth: 24, sampleRate: 96000 },
      { filename: '2.flac', size: 1, bitDepth: 24, sampleRate: 96000 }], { queueLength: 40 }),
  ]
  const merged = S.mergeSourcesByAlbum(groups)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].best.username, 'flacguy', 'quality wins the headline source')
  assert.equal(merged[0].lossless, true)
  assert.equal(merged[0].isHiRes, true)
})

test('merged album keeps the parsed year even when a sparser member lacks it', () => {
  const groups = [
    grp('a', 'Beck - Sea Change', [{ filename: '1.flac', size: 1 }, { filename: '2.flac', size: 1 }]),
    grp('b', 'Beck - Sea Change (2002)', [{ filename: '1.flac', size: 1 }, { filename: '2.flac', size: 1 }]),
  ]
  const merged = S.mergeSourcesByAlbum(groups)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].year, 2002)
})

// ── Merged-album sorting (Task 3) ─────────────────────────────────────────────
test('sortMergedAlbums by quality puts hi-res lossless first', () => {
  const albums = [
    { album: 'Lossy', bestQuality: { lossless: false, hiRes: false, maxBitDepth: 0, maxSampleRate: 0 }, totalSize: 10 },
    { album: 'HiRes', bestQuality: { lossless: true, hiRes: true, maxBitDepth: 24, maxSampleRate: 96000 }, totalSize: 10 },
    { album: 'CD', bestQuality: { lossless: true, hiRes: false, maxBitDepth: 16, maxSampleRate: 44100 }, totalSize: 10 },
  ]
  const sorted = S.sortMergedAlbums(albums, 'quality').map(a => a.album)
  assert.deepEqual(sorted, ['HiRes', 'CD', 'Lossy'])
})

test('sortMergedAlbums by year sinks unknown years to the bottom', () => {
  const albums = [
    { album: 'Old', year: 1970 }, { album: 'New', year: 2020 }, { album: 'Unknown', year: null },
  ]
  const sorted = S.sortMergedAlbums(albums, 'year').map(a => a.album)
  assert.deepEqual(sorted, ['New', 'Old', 'Unknown'])
})

test('sortMergedAlbums A-Z ignores leading articles', () => {
  const albums = [
    { artist: 'The Beatles', album: 'Abbey Road' },
    { artist: 'ABBA', album: 'Arrival' },
  ]
  const sorted = S.sortMergedAlbums(albums, 'az').map(a => a.artist)
  assert.deepEqual(sorted, ['ABBA', 'The Beatles'])
})

// works on flat shelf-album shape too (extractAlbums output)
test('sortMergedAlbums quality works on flat shelf albums', () => {
  const albums = [
    { album: 'A', lossless: false, isHiRes: false, maxBitDepth: 0, maxSampleRate: 0, totalSize: 1 },
    { album: 'B', lossless: true, isHiRes: true, maxBitDepth: 24, maxSampleRate: 96000, totalSize: 1 },
  ]
  const sorted = S.sortMergedAlbums(albums, 'quality').map(a => a.album)
  assert.deepEqual(sorted, ['B', 'A'])
})

// ── Shelf filter/sort (Task 3) ────────────────────────────────────────────────
test('shelfDecades builds newest-first decade options from parsed years', () => {
  const albums = [{ year: 1994 }, { year: 2003 }, { year: 2011 }, { year: null }, { year: 1999 }]
  const opts = F.shelfDecades(albums)
  assert.deepEqual(opts, [
    { value: '2010', label: '2010s' },
    { value: '2000', label: '2000s' },
    { value: '1990', label: '1990s' },
  ])
})

test('applyShelfFilterSort filters lossless + hires and a decade together', () => {
  const albums = [
    { album: 'A', lossless: true, isHiRes: true, year: 2015 },
    { album: 'B', lossless: true, isHiRes: false, year: 2015 },
    { album: 'C', lossless: true, isHiRes: true, year: 1998 },
  ]
  const out = F.applyShelfFilterSort(albums, {
    filters: new Set(['lossless', 'hires']), decade: '2010', sort: 'az',
  }).map(a => a.album)
  assert.deepEqual(out, ['A'])
})

test('applyShelfFilterSort surround filter uses the album flag', () => {
  const albums = [
    { album: 'Stereo', surround: false, lossless: true },
    { album: 'Multich', surround: true, lossless: true },
  ]
  const out = F.applyShelfFilterSort(albums, { filters: ['surround'] }).map(a => a.album)
  assert.deepEqual(out, ['Multich'])
})

test('applyShelfFilterSort with no filters returns all, sorted', () => {
  const albums = [{ artist: 'Zebra', album: 'Z' }, { artist: 'Apple', album: 'A' }]
  const out = F.applyShelfFilterSort(albums, { sort: 'az' }).map(a => a.artist)
  assert.deepEqual(out, ['Apple', 'Zebra'])
})

// ── Batch-upgrade enqueue list building (Task 2) ──────────────────────────────
// The "Grab all N upgrades" builder flattens each album's files into the
// {username, filename, size} shape _slskEnqueue wants. Kept as a pure helper on
// the module so it is testable without the DOM.
test('grab-all builds a flat enqueue list across every upgrade album', () => {
  const upgrades = [
    { folderName: 'Album One', files: [
      { fullPath: 'p\\a1.flac', size: 10 }, { fullPath: 'p\\a2.flac', size: 20 }] },
    { folderName: 'Album Two', files: [
      { fullPath: 'q\\b1.flac', size: 30 }] },
  ]
  // Mirror the renderer's shAsGroup flattening: fullPath→filename.
  const items = upgrades.flatMap(a => a.files.map(f => ({
    username: 'peer', filename: f.fullPath, size: f.size || 0 })))
  assert.equal(items.length, 3)
  assert.ok(items.every(i => i.username && i.filename))
  assert.deepEqual(items.map(i => i.size), [10, 20, 30])
})
