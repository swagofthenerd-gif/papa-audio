const test = require('node:test')
const assert = require('node:assert')
const W = require('../src/slsk-wander')

const A = (artist, album, year, extra) => ({ artist, album, year, folderPath: artist + '\\' + album, lossless: true, files: [], ...extra })

test('goDeep lists artists with 8+ albums, most first, with how many I lack', () => {
  const albums = []
  for (let i = 0; i < 9; i++) albums.push(A('Pink Floyd', 'PF' + i, 1970 + i))
  for (let i = 0; i < 8; i++) albums.push(A('Miles Davis', 'MD' + i, 1959))
  albums.push(A('Solo', 'One', 2000))
  const own = new Set(['pink floyd::pf0', 'pink floyd::pf1'])
  const out = W.goDeep(albums, a => own.has(W.albumKey(a)))
  assert.deepEqual(out.map(x => [x.artist, x.count, x.lacking]), [['Pink Floyd', 9, 7], ['Miles Davis', 8, 8]])
})

test('decadeShelf picks the decade with the most albums and reports its share', () => {
  const albums = [A('a', '1', 1971), A('b', '2', 1975), A('c', '3', 1999), A('d', '4', null)]
  const d = W.decadeShelf(albums)
  assert.equal(d.decade, 1970)
  assert.equal(d.albums.length, 2)
  assert.equal(d.share, 67)   // of the 3 with a year
})

test('decadeShelf is null when fewer than 5 albums carry a year', () => {
  assert.equal(W.decadeShelf([A('a', '1', 1971)]), null)
})

test('onlyHere keeps albums no other cached peer holds, and needs 3 peers', () => {
  const mine = [A('Can', 'Ege Bamyasi', 1972), A('Pink Floyd', 'Meddle', 1971)]
  const others = [[A('x', 'Meddle', 1971, { artist: 'Pink Floyd' })], [], []]
  const out = W.onlyHere(mine, others)
  assert.equal(out.peersChecked, 3)
  assert.deepEqual(out.albums.map(a => a.album), ['Ege Bamyasi'])
  assert.equal(W.onlyHere(mine, others.slice(0, 2)), null)
})

test('becauseYouOwn groups peer albums whose artist shares 2+ tags with a seed', () => {
  const albums = [A('Massive Attack', 'Mezzanine', 1998), A('Tricky', 'Maxinquaye', 1995), A('Yes', 'Fragile', 1971)]
  const tags = { 'portishead': ['trip hop', 'electronic', 'bristol'], 'massive attack': ['trip hop', 'electronic'],
    'tricky': ['trip hop', 'bristol'], 'yes': ['progressive rock'] }
  const out = W.becauseYouOwn(albums, [{ artist: 'Portishead', album: 'Dummy' }], tags)
  assert.equal(out.length, 1)
  assert.equal(out[0].seed.album, 'Dummy')
  assert.deepEqual(out[0].albums.map(a => a.artist).sort(), ['Massive Attack', 'Tricky'])
})

test('characterLine names genre-looking top folders and the dominant decade', () => {
  const tree = { dirs: new Map([['rock', { name: 'Rock', fileCount: 900 }], ['jazz', { name: 'Jazz', fileCount: 400 }], ['misc', { name: 'Misc', fileCount: 10 }]]) }
  const albums = [A('a', '1', 1971), A('b', '2', 1975), A('c', '3', 1977), A('d', '4', 1999), A('e', '5', 1972)]
  assert.equal(W.characterLine(tree, albums), 'A 70s rock and jazz collector')
})

test('characterLine falls back to counts when nothing looks like a genre', () => {
  const tree = { dirs: new Map([['music', { name: 'Music', fileCount: 5 }]]) }
  assert.equal(W.characterLine(tree, [A('a', '1', null)]), '1 album')
})
