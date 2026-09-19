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

test('pickDiscogsMaster takes the first master result', () => {
  const j = { results: [{ id: 5, type: 'master', resource_url: 'https://api.discogs.com/masters/5', uri: '/master/5-x' }] }
  assert.deepEqual(E.pickDiscogsMaster(j), { id: 5, url: 'https://www.discogs.com/master/5-x' })
  assert.equal(E.pickDiscogsMaster({ results: [] }), null)
})

test('discogsSummary reads rating, count, genres and styles', () => {
  const j = { community: { rating: { average: 4.62, count: 41000 } }, genres: ['Rock'], styles: ['Prog Rock', 'Art Rock'] }
  assert.deepEqual(E.discogsSummary(j), { rating: 4.6, count: 41000, genres: ['Rock'], styles: ['Prog Rock', 'Art Rock'] })
})

test('the four handlers exist in main and are exposed in preload', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  for (const h of ['musicbrainz-artist-tags', 'discogs-album', 'discogs-token-get', 'discogs-token-set']) {
    assert.ok(main.includes(`ipcMain.handle('${h}'`), h + ' handler')
    assert.ok(pre.includes(`'${h}'`), h + ' exposed')
  }
})

test('discogs-album never calls out without a token', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const body = main.slice(main.indexOf("ipcMain.handle('discogs-album'"))
  const guard = body.indexOf("reason: 'no-token'"), call = body.indexOf('_discogsGetJson(')
  assert.ok(guard > 0 && guard < call, 'the no-token return comes before the first request')
})
