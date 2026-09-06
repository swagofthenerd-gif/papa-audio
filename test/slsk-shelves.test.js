const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')
const { buildTree } = require('../src/slsk-tree')
const { detectSurround } = require('../src/slsk-filters')

// ── Folder-name parsing ───────────────────────────────────────────────────────
// The swamp: mixed separators, quality tags, disc markers, year placements.
test('parses "Artist - Year - Album"', () => {
  const p = S.parseAlbumFolder(['Pink Floyd - 1973 - The Dark Side of the Moon'])
  assert.equal(p.artist, 'Pink Floyd')
  assert.equal(p.album, 'The Dark Side of the Moon')
  assert.equal(p.year, 1973)
})

test('parses "Artist - Album (Year)"', () => {
  const p = S.parseAlbumFolder(['Radiohead - In Rainbows (2007)'])
  assert.equal(p.artist, 'Radiohead')
  assert.equal(p.album, 'In Rainbows')
  assert.equal(p.year, 2007)
})

test('parses "Artist - Album" with no year', () => {
  const p = S.parseAlbumFolder(['Miles Davis - Kind of Blue'])
  assert.equal(p.artist, 'Miles Davis')
  assert.equal(p.album, 'Kind of Blue')
  assert.equal(p.year, null)
})

test('parses "Artist/Album" two-segment form', () => {
  const p = S.parseAlbumFolder(['Boards of Canada', 'Geogaddi'])
  assert.equal(p.artist, 'Boards of Canada')
  assert.equal(p.album, 'Geogaddi')
})

test('parses "Artist/Year - Album" leaf', () => {
  const p = S.parseAlbumFolder(['Aphex Twin', '1996 - Richard D. James Album'])
  assert.equal(p.artist, 'Aphex Twin')
  assert.equal(p.album, 'Richard D. James Album')
  assert.equal(p.year, 1996)
})

test('strips [FLAC] [24-96] and other quality tags', () => {
  const p = S.parseAlbumFolder(['Opeth - Blackwater Park [FLAC] [24-96]'])
  assert.equal(p.artist, 'Opeth')
  assert.equal(p.album, 'Blackwater Park')
})

test('strips bare noise words (WEB, remaster, deluxe)', () => {
  const p = S.parseAlbumFolder(['Portishead - Dummy WEB FLAC Remastered Deluxe Edition'])
  assert.equal(p.artist, 'Portishead')
  assert.match(p.album, /Dummy/)
  assert.doesNotMatch(p.album, /FLAC|WEB|Remaster/i)
})

test('handles mixed forward/back slashes via buildTree segments', () => {
  const p = S.parseAlbumFolder(['Music', 'Rock', 'Led Zeppelin - IV (1971)'])
  assert.equal(p.artist, 'Led Zeppelin')
  assert.equal(p.album, 'IV')
  assert.equal(p.year, 1971)
})

test('does not split hyphenated titles with no surrounding spaces', () => {
  const p = S.parseAlbumFolder(['Taylor Swift - Anti-Hero Sessions'])
  assert.equal(p.artist, 'Taylor Swift')
  assert.equal(p.album, 'Anti-Hero Sessions')
})

test('generic container parent does not become the artist', () => {
  const p = S.parseAlbumFolder(['Music', 'Kind of Blue'])
  assert.equal(p.artist, '')
  assert.equal(p.album, 'Kind of Blue')
})

test('year embedded bare in a busy name is still found', () => {
  const p = S.parseAlbumFolder(['Nirvana - Nevermind 1991 [Vinyl Rip]'])
  assert.equal(p.year, 1991)
  assert.doesNotMatch(p.album, /1991/)
})

// ── Disc folding ──────────────────────────────────────────────────────────────
test('recognises disc folders in many spellings', () => {
  ;['CD1', 'CD 2', 'Disc 04', 'Disk 3', 'Disc One', 'CD01', 'cd', 'Disque 2'].forEach(n =>
    assert.ok(S.isDiscFolder(n), `${n} should be a disc folder`))
  ;['CD Rip Deluxe', 'Discovery', 'Disc Golf Sounds', 'The Wall'].forEach(n =>
    assert.ok(!S.isDiscFolder(n), `${n} should NOT be a disc folder`))
})

test('folds CD1/CD2 into one album', () => {
  const dirs = [
    { name: 'The Beatles - 1968 - The White Album\\CD1', files: [
      { filename: '01 Back in the USSR.flac', size: 1000 },
      { filename: '02 Dear Prudence.flac', size: 1000 } ] },
    { name: 'The Beatles - 1968 - The White Album\\CD2', files: [
      { filename: '01 Birthday.flac', size: 1000 },
      { filename: '02 Yer Blues.flac', size: 1000 } ] },
  ]
  const tree = buildTree(dirs)
  const albums = S.extractAlbums(tree)
  assert.equal(albums.length, 1, 'two discs should collapse to one album')
  assert.equal(albums[0].artist, 'The Beatles')
  assert.equal(albums[0].album, 'The White Album')
  assert.equal(albums[0].trackCount, 4)
})

// ── extractAlbums over a messy tree ───────────────────────────────────────────
test('extractAlbums finds leaf albums and skips shelves', () => {
  const dirs = [
    { name: 'Music\\Rock\\Pink Floyd - 1973 - Dark Side of the Moon', files: [
      { filename: '01 Speak to Me.flac', size: 100, bitDepth: 24, sampleRate: 96000 },
      { filename: '02 Breathe.flac', size: 200, bitDepth: 24, sampleRate: 96000 } ] },
    { name: 'Music\\Jazz\\Miles Davis - Kind of Blue', files: [
      { filename: '01 So What.mp3', size: 50, bitRate: 320 },
      { filename: '02 Freddie Freeloader.mp3', size: 50, bitRate: 320 } ] },
    // A folder with a single track — below minTracks, should be ignored.
    { name: 'Music\\Singles\\Some Single', files: [{ filename: 'a.flac', size: 10 }] },
    // Non-audio-only folder — ignored.
    { name: 'Music\\Artwork', files: [{ filename: 'cover.jpg', size: 5 }] },
  ]
  const tree = buildTree(dirs)
  const albums = S.extractAlbums(tree)
  const names = albums.map(a => a.album).sort()
  assert.deepEqual(names, ['Dark Side of the Moon', 'Kind of Blue'])
  const dsotm = albums.find(a => a.album === 'Dark Side of the Moon')
  assert.equal(dsotm.lossless, true)
  assert.equal(dsotm.isHiRes, true)
  assert.equal(dsotm.maxBitDepth, 24)
  const kob = albums.find(a => a.album === 'Kind of Blue')
  assert.equal(kob.lossless, false)
})

// ── Fuzzy matching ────────────────────────────────────────────────────────────
test('albumsMatch handles articles, punctuation, order', () => {
  assert.ok(S.albumsMatch(
    { artist: 'The Beatles', album: 'Sgt. Pepper\'s Lonely Hearts Club Band' },
    { artist: 'Beatles', album: 'Sgt Peppers Lonely Hearts Club Band' }))
  assert.ok(!S.albumsMatch(
    { artist: 'Metallica', album: 'Live' },
    { artist: 'Nirvana', album: 'Live' }))
})

// ── Upgrade detection ─────────────────────────────────────────────────────────
test('upgrade: lossless beats lossy', () => {
  const peer = { lossless: true, maxBitDepth: 16, maxSampleRate: 44100 }
  const mine = { lossless: false, maxBitDepth: 0, maxSampleRate: 0 }
  const r = S.upgradeReason(peer, mine)
  assert.ok(r)
  assert.equal(r.kind, 'lossless')
  assert.equal(r.yours, 'MP3')
  assert.match(r.theirs, /FLAC/)
})

test('upgrade: 24/96 beats 16/44', () => {
  const peer = { lossless: true, maxBitDepth: 24, maxSampleRate: 96000 }
  const mine = { lossless: true, maxBitDepth: 16, maxSampleRate: 44100 }
  const r = S.upgradeReason(peer, mine)
  assert.ok(r)
  assert.equal(r.kind, 'bitdepth')
  assert.equal(r.yours, 'FLAC 16/44')
  assert.equal(r.theirs, 'FLAC 24/96')
})

test('upgrade: higher sample rate at equal depth', () => {
  const peer = { lossless: true, maxBitDepth: 24, maxSampleRate: 192000 }
  const mine = { lossless: true, maxBitDepth: 24, maxSampleRate: 96000 }
  const r = S.upgradeReason(peer, mine)
  assert.ok(r)
  assert.equal(r.kind, 'samplerate')
})

test('no upgrade: equal quality', () => {
  const peer = { lossless: true, maxBitDepth: 16, maxSampleRate: 44100 }
  const mine = { lossless: true, maxBitDepth: 16, maxSampleRate: 44100 }
  assert.equal(S.upgradeReason(peer, mine), null)
})

test('no upgrade: yours is lossless, theirs is lossy', () => {
  const peer = { lossless: false, maxBitDepth: 0, maxSampleRate: 0 }
  const mine = { lossless: true, maxBitDepth: 16, maxSampleRate: 44100 }
  assert.equal(S.upgradeReason(peer, mine), null)
})

// ── buildShelves end-to-end ───────────────────────────────────────────────────
test('buildShelves classifies upgrades, missing, surround, hires', () => {
  const dirs = [
    // Upgrade: I own this as MP3, peer has FLAC 24/96.
    { name: 'Radiohead - OK Computer [FLAC] [24-96]', files: [
      { filename: '01 Airbag.flac', size: 100, bitDepth: 24, sampleRate: 96000 },
      { filename: '02 Paranoid Android.flac', size: 100, bitDepth: 24, sampleRate: 96000 } ] },
    // Missing: not in my library at all.
    { name: 'Aphex Twin - Selected Ambient Works 85-92', files: [
      { filename: '01 Xtal.flac', size: 100, bitDepth: 16, sampleRate: 44100 },
      { filename: '02 Tha.flac', size: 100, bitDepth: 16, sampleRate: 44100 } ] },
    // Surround-labelled.
    { name: 'Pink Floyd - The Wall (5.1 SACD)', files: [
      { filename: '01 In the Flesh.flac', size: 100, bitDepth: 24, sampleRate: 88200 },
      { filename: '02 The Thin Ice.flac', size: 100, bitDepth: 24, sampleRate: 88200 } ] },
  ]
  const tree = buildTree(dirs)
  const peerAlbums = S.extractAlbums(tree)
  const library = [
    { id: 'lib1', name: 'OK Computer', artist: 'Radiohead',
      tracks: [{ filePath: '/m/ok/01.mp3', bitsPerSample: 0, sampleRate: 0 }] },
  ]
  const shelves = S.buildShelves(peerAlbums, library, { detectSurround })

  assert.equal(shelves.upgrades.length, 1)
  assert.equal(shelves.upgrades[0].album, 'OK Computer')
  assert.equal(shelves.upgrades[0].upgrade.kind, 'lossless')

  const missingNames = shelves.missing.map(a => a.album)
  assert.ok(missingNames.includes('Selected Ambient Works 85-92'))
  assert.ok(missingNames.includes('The Wall'))
  // OK Computer is matched (upgrade), so NOT missing.
  assert.ok(!missingNames.includes('OK Computer'))

  assert.equal(shelves.surround.length, 1)
  assert.equal(shelves.surround[0].album, 'The Wall')

  // Hi-res: OK Computer (24/96), The Wall (24/88.2). SAW is 16/44 — not hires.
  const hiresNames = shelves.hires.map(a => a.album).sort()
  assert.deepEqual(hiresNames, ['OK Computer', 'The Wall'])
})

// ── Stats ─────────────────────────────────────────────────────────────────────
test('computeStats totals tracks, size, lossless%, hires', () => {
  const albums = [
    { trackCount: 10, totalSize: 1000, losslessCount: 10, isHiRes: true },
    { trackCount: 10, totalSize: 500, losslessCount: 0, isHiRes: false },
  ]
  const st = S.computeStats(albums, { surroundCount: 1 })
  assert.equal(st.albums, 2)
  assert.equal(st.tracks, 20)
  assert.equal(st.size, 1500)
  assert.equal(st.losslessPct, 50)
  assert.equal(st.hiRes, 1)
  assert.equal(st.surround, 1)
})

// ── Alphabetical grouping ─────────────────────────────────────────────────────
test('groupByLetter buckets by artist, articles stripped, non-letters under #', () => {
  const albums = [
    { artist: 'The Beatles', album: 'Abbey Road' },
    { artist: 'Aphex Twin', album: 'Drukqs' },
    { artist: '65daysofstatic', album: 'Wild Light' },
  ]
  const groups = S.groupByLetter(albums)
  const letters = groups.map(g => g.letter)
  // "The Beatles" → B (article stripped), Aphex → A, 65days → #.
  assert.deepEqual(letters, ['#', 'A', 'B'])
})

test('albumQualityLabel formats lossless and lossy', () => {
  assert.equal(S.albumQualityLabel({ topExt: 'flac', lossless: true, maxBitDepth: 24, maxSampleRate: 96000, files: [] }), 'FLAC · 24/96')
  assert.equal(S.albumQualityLabel({ topExt: 'mp3', lossless: false, maxBitDepth: 0, maxSampleRate: 0, files: [{ bitRate: 320 }] }), 'MP3 · 320')
})
