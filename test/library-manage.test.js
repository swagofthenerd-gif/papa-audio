const test = require('node:test')
const assert = require('node:assert')
const L = require('../src/library-manage')

function trk(filePath, channels, opts = {}) {
  return Object.assign({
    filePath, channels,
    artist: 'Pink Floyd', albumArtist: 'Pink Floyd', album: 'Animals',
    fileSize: 100e6,
  }, opts)
}

function many(dir, n, channels, opts) {
  return Array.from({ length: n }, (_, i) => trk(`${dir}/${i + 1} Track.flac`, channels, opts))
}

test('edition markers do not stop two rips matching as one album', () => {
  assert.equal(
    L.normalizeName('Wish You Were Here 50 (2025) [FLAC 24-192]'),
    L.normalizeName('Wish_You_Were_Here_50 2011 5.1 Surround Mix BLURAY'))
})

test('an INCOMPLETE surround rip never supersedes a complete stereo one', () => {
  // The exact trap in the real library: 6ch/5 tracks vs 2ch/30 tracks.
  const groups = L.findDuplicates([
    ...many('/m/WYWH-5.1', 5, 6),
    ...many('/m/WYWH-stereo', 30, 2),
  ])
  assert.equal(groups.length, 1)
  const stereo = groups[0].folders.find(f => f.maxChannels === 2)
  assert.equal(stereo.safeToDelete, false)
  assert.match(stereo.blockers.join(' '), /only 5 of these 30 tracks/)
})

test('a complete surround rip DOES supersede the stereo one', () => {
  const groups = L.findDuplicates([
    ...many('/m/A-5.1', 10, 6),
    ...many('/m/A-stereo', 10, 2),
  ])
  const stereo = groups[0].folders.find(f => f.maxChannels === 2)
  assert.equal(stereo.safeToDelete, true)
  assert.equal(stereo.supersededBy, '/m/A-5.1')
})

test('the best copy in a group is never marked deletable', () => {
  const groups = L.findDuplicates([
    ...many('/m/A-5.1', 10, 6),
    ...many('/m/A-stereo', 10, 2),
  ])
  const sur = groups[0].folders.find(f => f.maxChannels === 6)
  assert.equal(sur.safeToDelete, false)
  assert.match(sur.blockers.join(' '), /best copy/)
})

test('missing tags make a group unreliable and nothing deletable', () => {
  // Two unrelated albums collided under "unknown artist / unknown album".
  const groups = L.findDuplicates([
    ...many('/m/Yes-Atmos', 4, 8, { artist: 'Unknown Artist', albumArtist: 'Unknown Artist', album: 'Unknown Album' }),
    ...many('/m/EndlessRiver', 2, 0, { artist: 'Unknown Artist', albumArtist: 'Unknown Artist', album: 'Unknown Album' }),
  ])
  assert.equal(groups[0].reliable, false)
  assert.ok(groups[0].folders.every(f => !f.safeToDelete))
  assert.match(groups[0].warnings.join(' '), /may not be the same album/)
})

test('Disc 1 / Disc 2 folders count as one release, not rival copies', () => {
  const folders = L.buildFolders([
    ...many('/m/Red/Disc 1', 5, 6),
    ...many('/m/Red/Disc 2', 3, 6),
  ])
  assert.equal(folders.length, 1)
  assert.equal(folders[0].trackCount, 8)
  assert.equal(folders[0].partCount, 2)
})

test('a folder mixing stereo and surround tracks is never bulk-deletable', () => {
  const groups = L.findDuplicates([
    ...many('/m/A-5.1', 10, 6),
    ...many('/m/A-mixed', 5, 2),
    trk('/m/A-mixed/6 Track.flac', 6),
  ])
  const mixed = groups[0].folders.find(f => f.dir === '/m/A-mixed')
  assert.equal(mixed.mixedChannels, true)
  assert.equal(mixed.safeToDelete, false)
  assert.match(mixed.blockers.join(' '), /mixes stereo and surround/)
})

test('a group where every copy is the same layout offers nothing to delete', () => {
  const groups = L.findDuplicates([
    ...many('/m/A-1', 10, 2),
    ...many('/m/A-2', 10, 2),
  ])
  assert.equal(groups[0].reliable, false)
  assert.ok(groups[0].folders.every(f => !f.safeToDelete))
})

test('channel labels read the way a person would say them', () => {
  assert.equal(L.channelLabel(8), '7.1')
  assert.equal(L.channelLabel(6), '5.1')
  assert.equal(L.channelLabel(2), 'Stereo')
  assert.equal(L.channelLabel(0), 'Unknown')
})

test('same track COUNT is not coverage — the songs must actually match', () => {
  // The real-library trap: nine 1-track stereo folders were marked deletable
  // because a 1-track 5.1 folder existed. Different songs entirely.
  const groups = L.findDuplicates([
    trk('/m/disc-5.1/Elephant Talk.flac', 6, { album: 'Discipline' }),
    trk('/m/lp-stereo/Frame by Frame.flac', 2, { album: 'Discipline' }),
  ])
  const stereo = groups[0].folders.find(f => f.maxChannels === 2)
  assert.equal(stereo.safeToDelete, false, 'a different song must never be treated as covered')
})

test('matching songs under different filenames still count as covered', () => {
  const groups = L.findDuplicates([
    trk('/m/sur/01 - Elephant Talk (2011 Remaster).flac', 6, { album: 'Discipline', title: 'Elephant Talk' }),
    trk('/m/st/Elephant Talk.flac', 2, { album: 'Discipline', title: 'Elephant Talk' }),
  ])
  const stereo = groups[0].folders.find(f => f.maxChannels === 2)
  assert.equal(stereo.safeToDelete, true)
})

test('a partial surround copy names how many tracks it is missing', () => {
  const groups = L.findDuplicates([
    trk('/m/sur/A.flac', 6), trk('/m/sur/B.flac', 6), trk('/m/sur/Z.flac', 6),
    trk('/m/st/A.flac', 2), trk('/m/st/B.flac', 2), trk('/m/st/C.flac', 2),
  ])
  const stereo = groups[0].folders.find(f => f.maxChannels === 2)
  assert.equal(stereo.safeToDelete, false)
  assert.match(stereo.blockers.join(' '), /missing 1 track/)
})

test('track identity ignores numbering and remaster noise', () => {
  assert.equal(L.trackIdentity({ filePath: '/x/03 - Time (2011 Remaster).flac' }),
               L.trackIdentity({ filePath: '/y/Time.flac' }))
})

// Roadmap 086: byte-identical copies, other encodings, and different releases are told apart.
test('relationOf: identical sizes are byte-identical copies; edition words or years make releases; else encodings', () => {
  const L2 = require('../src/library-manage')
  const t = (dir, album, year, size, n, codec) => ({ filePath: dir + '/' + String(n).padStart(2, '0') + ' T' + n + '.flac', title: 'T' + n, trackNumber: n, fileSize: size, album, year, channels: 2, codec })
  const same = L2.buildFolders([t('/a', 'X', 2000, 100, 1), t('/a', 'X', 2000, 200, 2), t('/b', 'X', 2000, 100, 1), t('/b', 'X', 2000, 200, 2)])
  assert.equal(L2.relationOf(same), 'identical')
  const enc = L2.buildFolders([t('/a', 'X', 2000, 100, 1), t('/b', 'X', 2000, 900, 1)])
  assert.equal(L2.relationOf(enc), 'recordings')
  const ed = L2.buildFolders([t('/a', 'X', 2000, 100, 1), t('/b', 'X (Remastered)', 2000, 100, 1)])
  assert.equal(L2.relationOf(ed), 'editions')
  const yr = L2.buildFolders([t('/a', 'X', 1975, 100, 1), t('/b', 'X', 2011, 100, 1)])
  assert.equal(L2.relationOf(yr), 'editions')
  const g = L2.assessGroup({ folders: ed })
  assert.ok(g.folders.every(f => !f.safeToDelete), 'a different release is never marked safe to delete')
  assert.ok(g.warnings.some(w => /different releases/.test(w)))
  assert.deepEqual(L2.editionTokens('Kind of Blue (Mono, Remastered)'), ['mono', 'remastered'])
})
