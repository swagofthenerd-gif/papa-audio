'use strict'
// A peer whose whole library sits under one folder called "SURROUND" showed up
// in Hunt and Wander as a single album.
//
// extractAlbums folds disc-ish and format-ish child folders into their parent,
// because "…\Dark Side of the Moon\5.1\" is the same album one folder deeper.
// That decision was made on the folder's NAME alone. So a peer who files their
// whole collection under "SURROUND\" had all 6,797 of their folders fold into
// the share root, and 58,891 files became one card with nothing under it.
//
// The rule now asks about the folder's SHAPE as well: a disc or format folder
// that contains real albums is a shelf, not a disc, and gets walked.
//
// Measured on his own cached libraries (real slskd browse payloads):
//   adaravisar  6,797 folders   1 album  ->  3,593 albums
//   xronin        806 folders  487       ->    514
//   xcj         3,084 folders  2,835     ->  2,821
// and the 33 cards that reported 0 tracks across those peers are gone.

const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/slsk-shelves')
const { buildTree } = require('../src/slsk-tree')

const flac = (n) => ({ filename: n + '.flac', size: 1000, bitDepth: 16, sampleRate: 44100 })
const names = (albums) => albums.map(a => a.album).sort()

test('a SURROUND folder holding real albums is a shelf, not one album', () => {
  // The exact shape of his adaravisar share, in miniature.
  const tree = buildTree([
    { name: '@@ttgfi\\SURROUND\\Jack Bruce - Songs for a Tailor', files: [flac('01'), flac('02')] },
    { name: '@@ttgfi\\SURROUND\\Pink Floyd - Animals', files: [flac('01'), flac('02')] },
    { name: '@@ttgfi\\SURROUND\\Steven Wilson - The Raven', files: [flac('01'), flac('02')] },
  ])
  assert.deepEqual(names(S.extractAlbums(tree, { minTracks: 2 })),
    ['Animals', 'Songs for a Tailor', 'The Raven'])
})

test('a 5.1 folder inside an album still folds into it', () => {
  // The case the fold rule exists for, which must not regress.
  const tree = buildTree([
    { name: 'Music\\Pink Floyd - Dark Side of the Moon\\5.1', files: [flac('01'), flac('02')] },
  ])
  const albums = S.extractAlbums(tree, { minTracks: 2 })
  assert.equal(albums.length, 1)
  assert.equal(albums[0].album, 'Dark Side of the Moon', 'the 5.1 folder is not its own album')
  assert.equal(albums[0].trackCount, 2, 'its tracks come with it')
  assert.equal(albums[0].surround, true, 'and it is still known to be surround')
})

test('CD folders inside an album still fold into it', () => {
  const tree = buildTree([
    { name: 'Music\\The Beatles - White Album\\CD1', files: [flac('01'), flac('02')] },
    { name: 'Music\\The Beatles - White Album\\CD2', files: [flac('03'), flac('04')] },
  ])
  const albums = S.extractAlbums(tree, { minTracks: 2 })
  assert.equal(albums.length, 1, 'one album, not two discs')
  assert.equal(albums[0].trackCount, 4, 'both discs gathered')
})

test('a disc folder that itself holds separate works is walked, not folded', () => {
  // The Chopin box set on his xronin peer: Vol III\CD5\<work>\*.flac. Folding
  // CD5 produced a card reporting 0 tracks with 57 real FLACs unreachable
  // beneath it.
  const tree = buildTree([
    { name: 'Music\\Chopin Complete\\Vol III. Mazurkas\\CD5\\Mazurka op. 33', files: [flac('01'), flac('02')] },
    { name: 'Music\\Chopin Complete\\Vol III. Mazurkas\\CD5\\Mazurka op. 41', files: [flac('01'), flac('02')] },
  ])
  const albums = S.extractAlbums(tree, { minTracks: 2 })
  assert.deepEqual(names(albums), ['Mazurka op. 33', 'Mazurka op. 41'])
  assert.ok(albums.every(a => a.trackCount === 2), 'and each one has its music')
})

test('no album is ever emitted with nothing in it', () => {
  // A shelf with no loose audio of its own, whose disc child holds the music.
  // The old gate counted the gathered total but built the card from the node's
  // own audio, so this emitted a card reading 0 tracks / 0 bytes / no format.
  // "Some Box" owns no loose audio; its CD1 child (a real disc leaf, which
  // still folds) holds the music, and an Extras subfolder makes Box a shelf.
  // The old gate counted CD1's gathered tracks and then built the card from
  // Box's own audio — of which there is none.
  const tree = buildTree([
    { name: 'Music\\Some Box\\CD1', files: [flac('01'), flac('02')] },
    { name: 'Music\\Some Box\\Extras', files: [flac('bonus 1'), flac('bonus 2')] },
  ])
  const albums = S.extractAlbums(tree, { minTracks: 2 })
  assert.ok(albums.length > 0, 'the music is still reachable')
  for (const a of albums) {
    assert.ok(a.trackCount >= 2, a.album + ' has real tracks')
    assert.ok(a.totalSize > 0, a.album + ' has real bytes')
  }
})

test('a shelf with its own loose tracks is still an album in its own right', () => {
  // The case the mixed-node branch exists for: keep it working.
  const tree = buildTree([
    { name: 'Music\\Singles', files: [flac('Loose A'), flac('Loose B')] },
    { name: 'Music\\Singles\\Some EP', files: [flac('01'), flac('02')] },
  ])
  const albums = S.extractAlbums(tree, { minTracks: 2 })
  const singles = albums.find(a => a.folderName === 'Singles')
  assert.ok(singles, 'the shelf itself is emitted')
  assert.equal(singles.trackCount, 2, 'built from its own loose audio')
  assert.ok(albums.find(a => a.folderName === 'Some EP'), 'and the subfolder too')
})

test('the chunked walker agrees with the recursive one on all of it', async () => {
  const corpus = [
    { name: '@@ttgfi\\SURROUND\\Jack Bruce - Songs for a Tailor', files: [flac('01'), flac('02')] },
    { name: '@@ttgfi\\SURROUND\\Pink Floyd - Animals', files: [flac('01'), flac('02')] },
    { name: 'Music\\Pink Floyd - Dark Side of the Moon\\5.1', files: [flac('01'), flac('02')] },
    { name: 'Music\\The Beatles - White Album\\CD1', files: [flac('01'), flac('02')] },
    { name: 'Music\\The Beatles - White Album\\CD2', files: [flac('03'), flac('04')] },
    { name: 'Music\\Chopin\\Vol III\\CD5\\Mazurka op. 33', files: [flac('01'), flac('02')] },
    { name: 'Music\\Chopin\\Vol III\\CD5\\Mazurka op. 41', files: [flac('01'), flac('02')] },
    { name: 'Music\\Boxed\\CD1', files: [flac('01'), flac('02')] },
    { name: 'Music\\Boxed\\Extras', files: [flac('b1'), flac('b2')] },
    { name: 'Music\\Singles', files: [flac('Loose A'), flac('Loose B')] },
    { name: 'Music\\Singles\\Some EP', files: [flac('01'), flac('02')] },
  ]
  const tree = buildTree(corpus)
  const sync = S.extractAlbums(tree, { minTracks: 2 })
  const chunked = await S.extractAlbumsChunked(tree, { minTracks: 2 })
  assert.deepEqual(chunked, sync, 'the two walkers must never drift')
})

test('the shape question is asked of the node, not its name', () => {
  const leaf = buildTree([{ name: 'Album\\5.1', files: [flac('01')] }])
  const shelf = buildTree([{ name: 'SURROUND\\Some Artist - Some Album', files: [flac('01')] }])
  assert.equal(S.isFoldableChild('5.1'), true, 'the name alone still says "foldable"')
  assert.equal(S.isFoldableChild('SURROUND'), true, 'for both of them')
  assert.equal(S.foldsIntoParent(leaf.dirs.get('album').dirs.get('5.1')), true, 'but a leaf folds')
  assert.equal(S.foldsIntoParent(shelf.dirs.get('surround')), false, 'and a shelf does not')
})
