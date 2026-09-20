const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), path = require('path')
const E = require('../src/peer-enrich')

test('pickArtistTags takes the top-scored artist and its tags by count, max 8', () => {
  const j = { artists: [{ score: 100, tags: [{ name: 'trip hop', count: 9 }, { name: 'electronic', count: 4 }, { name: 'x', count: 0 }] }, { score: 50, tags: [{ name: 'wrong', count: 99 }] }] }
  assert.deepEqual(E.pickArtistTags(j), ['trip hop', 'electronic'])
})

test('pickArtistTags is empty on no artists', () => {
  assert.deepEqual(E.pickArtistTags({}), [])
})

const fixture = n => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'album-info', n), 'utf8'))

test('pickDiscogsMaster takes the master whose title is this record', () => {
  const j = { results: [{ id: 5, type: 'master', title: 'Portishead - Dummy', resource_url: 'https://api.discogs.com/masters/5', uri: '/master/5-x' }] }
  assert.deepEqual(E.pickDiscogsMaster(j, { title: 'Dummy' }),
    { id: 5, title: 'Dummy', url: 'https://www.discogs.com/master/5-x' })
  assert.equal(E.pickDiscogsMaster({ results: [] }, { title: 'Dummy' }), null)
})

test('pickDiscogsMaster skips the Tubular Bells II / III master at the 0.6 bar', () => {
  // His own cache holds `discogs:mike oldfield::tubular bells` against master
  // 937480 — "Tubular Bells II / Tubular Bells III" — which is what an
  // unchecked results[0] does. The saved live search carries that master among
  // the real ones.
  const live = fixture('discogs-search-tubular-bells.json')
  const wrong = live.results.find(r => r.id === 937480)
  assert.ok(wrong, 'the mismatching master is in the saved search')
  assert.equal(E.pickDiscogsMaster({ results: [wrong] }, { title: 'Tubular Bells' }), null,
    'alone, it is still not this album — no master beats the wrong master')
  const picked = E.pickDiscogsMaster(live, { title: 'Tubular Bells' })
  assert.notEqual(picked.id, 937480)
  assert.equal(picked.title, 'Tubular Bells')
})

test('pickDiscogsMaster reads the album half of an "Artist - Album" title', () => {
  const live = fixture('discogs-search-dummy.json')
  assert.equal(live.results[0].title, 'Portishead - Dummy', 'the live search title shape')
  assert.equal(E.pickDiscogsMaster(live, { title: 'Dummy' }).id, 5542)
})

test('discogsSummary carries the year and the pressing notes through', () => {
  const j = {
    title: 'Wish You Were Here', year: 1975,
    community: { rating: { average: 4.62, count: 41000 } },
    genres: ['Rock'], styles: ['Prog Rock', 'Art Rock'],
    notes: 'Recorded at [l=Abbey Road].',
  }
  assert.deepEqual(E.discogsSummary(j), {
    rating: 4.6, count: 41000, genres: ['Rock'], styles: ['Prog Rock', 'Art Rock'],
    year: 1975, masterTitle: 'Wish You Were Here', notes: 'Recorded at Abbey Road.',
  })
})

test('cleanDiscogsNotes strips the bracket markup off the live Dummy notes', () => {
  const master = fixture('discogs-master-dummy.json')
  assert.ok(/\[url=/.test(master.notes) && /\r\n/.test(master.notes), 'the raw field really is markup + CRLF')
  const out = E.cleanDiscogsNotes(master.notes)
  assert.ok(out.startsWith('Winner of the 1995 Mercury Music Prize. Following the initial issue'),
    'a single line break is a wrapped sentence, so it becomes a space')
  assert.ok(!/\[|\]|\r/.test(out), 'no bracket markup and no carriage returns survive')
  assert.ok(out.includes('"Danube Incident"'), 'the link text survives, the URL does not')
  assert.ok(!out.includes('discogs.com/Lalo-Schifrin'))
  assert.ok(out.includes('\n\n'), 'the submitter\'s own paragraph break survives')
})

test('cleanDiscogsNotes unwraps the artist, label and master references', () => {
  assert.equal(E.cleanDiscogsNotes('Produced by [a=Beth Gibbons] for [l=Go! Beat].'),
    'Produced by Beth Gibbons for Go! Beat.')
  assert.equal(E.cleanDiscogsNotes('See [m=Dummy] and [a1234] and [b]this[/b].'),
    'See Dummy and and this.')
  assert.equal(E.cleanDiscogsNotes(null), '')
  assert.equal(E.cleanDiscogsNotes(''), '')
})

test('the four handlers exist in main and are exposed in preload', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  for (const h of ['musicbrainz-artist-tags', 'discogs-album', 'discogs-token-get', 'discogs-token-set']) {
    assert.ok(main.includes(`ipcMain.handle('${h}'`), h + ' handler')
    assert.ok(pre.includes(`'${h}'`), h + ' exposed')
  }
})

// The old assertion here was "discogs-album never calls out without a token":
// the guard returned { ok:false, reason:'no-token' } before any request, and
// the panel printed "Add a Discogs token in Settings to see ratings and tags."
// It has been REPLACED on purpose, and test/album-info-ipc.test.js now asserts
// the opposite — that a token-less lookup does make its two calls. The guard
// existed to keep a credential off the wire, and no credential goes on the wire
// either way; what it actually cost a token-less user was the release year, the
// pressing notes, the genre chips and the Discogs link, in exchange for a
// community rating that a Discogs MASTER does not carry at all.

test('slsk-cached-peer-albums exists, is exposed, and skips the asking peer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(main.includes("ipcMain.handle('slsk-cached-peer-albums'"))
  assert.ok(pre.includes("'slsk-cached-peer-albums'"))
  const body = main.slice(main.indexOf("ipcMain.handle('slsk-cached-peer-albums'"), main.indexOf("ipcMain.handle('slsk-cached-peer-albums'") + 2500)
  assert.ok(/except/.test(body) && /continue/.test(body))
})
