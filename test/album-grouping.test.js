'use strict'
const test = require('node:test')
const assert = require('node:assert')
const G = require('../src/album-grouping')
const tagEdit = require('../src/tag-edit')

const legacy = t => tagEdit.albumKeyOf(t)
const group = tracks => {
  const keyFor = G.buildGroupKeyResolver(tracks, legacy)
  const m = new Map()
  for (const t of tracks) {
    const k = keyFor(t)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(t)
  }
  return m
}

// The real shape, read from his files: one album name, one folder, and a
// DIFFERENT album artist on every track. albumKeyOf keys on
// (albumArtist || artist) + album, so this became one "album" per performer —
// 16 cards for one disc, each sitting in a real artist's discography as though
// they had released it.
test('a compilation tagged with a different album artist per track is one album', () => {
  const dir = '/mnt/data/MUSIC/Downloads/Best 5.1 Tracks'
  const tracks = [
    { album: 'Best 5.1 Songs', artist: 'Tom Petty And The Heartbreakers', albumArtist: 'Tom Petty', filePath: dir + '/01.flac' },
    { album: 'Best 5.1 Songs', artist: 'Queen', albumArtist: 'Queen', filePath: dir + '/02.flac' },
    { album: 'Best 5.1 Songs', artist: 'Pink Floyd', albumArtist: 'Pink Floyd', filePath: dir + '/03.flac' },
    { album: 'Best 5.1 Songs', artist: 'Rush', albumArtist: 'Rush', filePath: dir + '/04.flac' },
  ]
  assert.strictEqual(group(tracks).size, 1, 'one release, not four')
  assert.strictEqual(new Set(tracks.map(legacy)).size, 4, 'and the old key really did give four')
})

test('a compilation with no album artist at all is also one album', () => {
  const dir = '/music/Various/Anthology'
  const tracks = [
    { album: 'Anthology', artist: 'Shpongle', albumArtist: '', filePath: dir + '/01.flac' },
    { album: 'Anthology', artist: 'Quintessence', albumArtist: '', filePath: dir + '/02.flac' },
  ]
  assert.strictEqual(group(tracks).size, 1)
})

test('a normally tagged album is left exactly as it was', () => {
  const dir = '/music/Bob Dylan/Love and Theft'
  const tracks = [
    { album: 'Love and Theft', artist: 'Bob Dylan', albumArtist: 'Bob Dylan', filePath: dir + '/01.flac' },
    { album: 'Love and Theft', artist: 'Bob Dylan', albumArtist: 'Bob Dylan', filePath: dir + '/02.flac' },
  ]
  const m = group(tracks)
  assert.strictEqual(m.size, 1)
  assert.strictEqual([...m.keys()][0], legacy(tracks[0]), 'still keyed by its tags, not by its folder')
})

// Different records that all ended up tagged "Unknown Album" must stay apart —
// his library has seven of them, in seven folders.
test('same album name in different folders stays separate', () => {
  const tracks = [
    { album: 'Unknown Album', artist: 'A', albumArtist: '', filePath: '/music/one/01.flac' },
    { album: 'Unknown Album', artist: 'B', albumArtist: '', filePath: '/music/two/01.flac' },
    { album: 'Unknown Album', artist: 'C', albumArtist: '', filePath: '/music/three/01.flac' },
  ]
  assert.strictEqual(group(tracks).size, 3)
})

// The regression the obvious version of this fix introduces.
test('a multi-disc compilation does not split into CD1 and CD2', () => {
  const base = '/music/Various/Big Box'
  const tracks = [
    { album: 'Big Box', artist: 'A', albumArtist: 'A', filePath: base + '/CD1/01.flac' },
    { album: 'Big Box', artist: 'B', albumArtist: 'B', filePath: base + '/CD1/02.flac' },
    { album: 'Big Box', artist: 'C', albumArtist: 'C', filePath: base + '/CD2/01.flac' },
  ]
  assert.strictEqual(group(tracks).size, 1, 'both discs are one release')
})

test('disc folders are recognised in their common spellings', () => {
  for (const seg of ['CD1', 'CD 2', 'Disc 1', 'disc-2', 'Disk 3', 'Vol 1', 'volume_2']) {
    assert.strictEqual(G.folderKey(`/music/Set/${seg}/01.flac`), '/music/set',
      `${seg} should collapse into its parent`)
  }
  assert.strictEqual(G.folderKey('/music/Set/Bonus/01.flac'), '/music/set/bonus',
    'a folder that is not a disc is left alone')
})

test('the display artist says Various Artists only when the tracks disagree', () => {
  assert.strictEqual(G.displayArtistFor([{ artist: 'A' }, { artist: 'B' }], 'x'), 'Various Artists')
  assert.strictEqual(G.displayArtistFor([{ artist: 'A' }, { artist: 'A' }], 'x'), 'A')
  assert.strictEqual(G.displayArtistFor([], 'fallback'), 'fallback')
  assert.strictEqual(G.displayArtistFor([{ artist: '' }], 'fallback'), 'fallback')
})

test('a track with no path falls back to its tags rather than throwing', () => {
  const tracks = [{ album: 'X', artist: 'A', albumArtist: 'A' }]
  assert.doesNotThrow(() => group(tracks))
  assert.strictEqual(group(tracks).size, 1)
})
