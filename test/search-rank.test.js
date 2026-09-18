'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { isJunk, sortJunkLast } = require('../catalog/search-rank')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('an entry with no year and no poster is junk; either one makes it real', () => {
  assert.equal(isJunk({ title: 'Reacher' }), true)
  assert.equal(isJunk({ title: 'Reacher', year: '2022' }), false)
  assert.equal(isJunk({ title: 'Reacher', poster: 'http://x/p.jpg' }), false)
  assert.equal(isJunk(null), true)
})

test('junk sinks to the end, everything keeps its order (the verified "Reacher" case)', () => {
  const out = sortJunkLast([
    { id: 1, title: 'Reacher' },
    { id: 2, title: 'Reacher', year: '2022', poster: 'p' },
    { id: 3, title: 'Reacher', year: '2016', poster: 'p' },
    { id: 4, title: 'Reacher' },
  ])
  assert.deepEqual(out.map(r => r.id), [2, 3, 1, 4])
  assert.deepEqual(sortJunkLast(null), [])
})

test('main: the video search ranks junk last, and the OMDb title fallback is gated by year, type and agreement', () => {
  const search = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-search'"), MAIN.indexOf("ipcMain.handle('video-search'") + 4200)
  assert.match(search, /sortJunkLast\(\(await tmdb\(\)\.search\(query\)\)\.filter/)
  // The merged list is ranked by relevance across BOTH catalogues before the
  // junk sink runs — concatenating them put every anime entry after every
  // film whatever was searched for. Behaviour: test/video-search-ranking.test.js.
  assert.match(search, /results: sortJunkLast\(rankByRelevance\(query, \[merged, animeRes\]\)\)/)
  const enrich = MAIN.slice(MAIN.indexOf('async function _enrichExternalRatings'), MAIN.indexOf('async function _enrichAnimeDetail'))
  assert.match(enrich, /else if \(detail\.year\) \{/, 'no year → no title lookup')
  assert.match(enrich, /client\.byTitle\(detail\.title, detail\.year, omdbTypeFor\(detail\.type\)\)/)
  assert.match(enrich, /if \(external && !omdbPlausibleMatch\(external, detail\)\) external = null/)
})
