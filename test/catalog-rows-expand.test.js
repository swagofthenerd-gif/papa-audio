'use strict'
// Every catalogue row (Trending, Top airing, New episodes, Airing today…)
// opens into a full grid that pages, through the same shelf page the
// curated shelves use.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { buildQuery, buildVariables } = require('../catalog/anilist')

const r = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('catalogue rows and the Airing-today row carry a See-all', () => {
  assert.ok(/wanted\.map\(function \(r\) \{ return _vRowShell\(r\.key, r\.label, 0, '', true\) \}\)/.test(r))
  assert.ok(/_vRowShell\('today-anime', 'Airing today', 0, '', true\)/.test(r))
})

test('the shelf page fetches a catalogue section through video-catalog-get with the row\'s own label, and curated shelves as before', () => {
  const fn = r.slice(r.indexOf('async function _fetchShelfPage'), r.indexOf('async function _loadShelfPage'))
  assert.ok(/if \(_isCatalogSection\(key\)\)/.test(fn))
  assert.ok(/window\.api\.videoCatalogGet\(\{ section: key, page: page \}\)/.test(fn))
  assert.ok(/shelf: \{ label: _sectionLabel\(key\), note: '' \}/.test(fn))
  assert.ok(/return window\.api\.videoShelf\(\{ key: key, page: page \}\)/.test(fn))
  // New-episode cards keep their "Ep 12 · 3h ago" badge on the grid.
  assert.ok(/key === 'new-episodes-anime' \? items\.map\(_newEpisodeCard\)\n\s+: key === 'today-anime' \? items\.map\(_todayCard\) : items/.test(fn))
  // An outage on the first page is an error the page can show, not an empty grid.
  assert.ok(/if \(!items\.length && res\.outage && page === 1\) return \{ ok: false, error: res\.outage \}/.test(fn))
  assert.ok(/const res = await _fetchShelfPage\(_shelfPage\.key, _shelfPage\.page\)/.test(r))
})

test('main pages the home-bundle rows through discover and serves the schedule rows as one page', () => {
  const start = main.indexOf("ipcMain.handle('video-catalog-get'")
  const body = main.slice(start, main.indexOf('ipcMain.handle(', start + 10))
  assert.ok(/'top-airing-anime': c => c\.discover\(\{ status: 'RELEASING', sort: 'popularity', page \}\)/.test(body))
  assert.ok(/'upcoming-anime': c => c\.discover\(\{ status: 'NOT_YET_RELEASED', sort: 'popularity', page \}\)/.test(body))
  assert.ok(/'top-rated-anime': c => c\.discover\(\{ sort: 'rating', minPopularity: 20000, page \}\)/.test(body))
  assert.ok(/if \(section === 'new-episodes-anime' \|\| section === 'today-anime'\) \{\n      if \(Number\(page\) > 1\) return \{ ok: true, results: \[\] \}/.test(body))
  // The bundle memo is declared before the handler that reads it.
  assert.ok(main.indexOf('const _animeHomeCache = makeCache') < start)
})

test('discover takes a popularity floor, sent only when asked for', () => {
  assert.ok(buildQuery('discover').includes('popularity_greater: $minPopularity'))
  assert.strictEqual(buildVariables('discover', { sort: 'rating', minPopularity: 20000 }).minPopularity, 20000)
  assert.ok(!('minPopularity' in buildVariables('discover', { sort: 'rating' })))
})
