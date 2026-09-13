'use strict'
// The anime home page (measured against miruro.to, 2026-09-13): one AniList
// request carries seven shelves and the airing schedule; the renderer fills
// every anime row from it, badges new episodes and today's airings, puts a
// countdown on the spotlight and a genre strip under it.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { buildQuery, buildVariables, createAnilistCatalog, normalizeScheduleEntry } = require('../catalog/anilist')

test('the home query aliases every shelf and both schedule windows in one document', () => {
  const q = buildQuery('animeHome')
  for (const alias of ['trending:', 'popular:', 'season:', 'topAiring:', 'upcoming:', 'topRated:', 'newEpisodes:', 'today:']) {
    assert.ok(q.includes(alias), 'missing ' + alias)
  }
  assert.ok(q.includes('status: RELEASING') && q.includes('status: NOT_YET_RELEASED') && q.includes('sort: SCORE_DESC, popularity_greater: 20000'))
  assert.strictEqual((q.match(/airingSchedules\(/g) || []).length, 2)
})

test('the home variables are the current season and a three-day / one-day window around now', () => {
  const now = Date.UTC(2026, 8, 13, 12, 0, 0)
  const v = buildVariables('animeHome', { now })
  assert.strictEqual(v.season, 'SUMMER')
  assert.strictEqual(v.seasonYear, 2026)
  assert.strictEqual(v.now, Math.floor(now / 1000))
  assert.strictEqual(v.now - v.recent, 3 * 86400)
  assert.strictEqual(v.tomorrow - v.now, 86400)
})

test('a schedule entry is the show plus which episode aired when; adult and untitled entries are dropped', () => {
  const e = normalizeScheduleEntry({ airingAt: 1700000000, episode: 12, media: { id: 5, title: { romaji: 'X' }, popularity: 5000 } })
  assert.strictEqual(e.id, 5)
  assert.deepStrictEqual(e.aired, { episode: 12, airingAt: 1700000000000 })
  assert.strictEqual(normalizeScheduleEntry({ airingAt: 1, episode: 1, media: { id: 6, title: { romaji: 'Y' }, isAdult: true } }), null)
  assert.strictEqual(normalizeScheduleEntry({ airingAt: 1, episode: 1, media: { id: 7, title: {} } }), null)
})

test('home() returns every list; new episodes are one per show ranked by popularity, today keeps clock order minus the shorts', async () => {
  const media = (id, pop) => ({ id, title: { romaji: 'S' + id }, popularity: pop })
  const page = list => ({ media: list })
  const data = {
    trending: page([media(1, 10)]), popular: page([media(2, 10)]), season: page([media(3, 10)]),
    topAiring: page([media(4, 10)]), upcoming: page([media(5, 10)]), topRated: page([media(6, 10)]),
    newEpisodes: { airingSchedules: [
      { airingAt: 300, episode: 3, media: media(9, 100) },
      { airingAt: 200, episode: 2, media: media(9, 100) },
      { airingAt: 100, episode: 7, media: media(8, 90000) },
    ] },
    today: { airingSchedules: [
      { airingAt: 10, episode: 1, media: media(21, 10) },
      { airingAt: 20, episode: 1, media: media(22, 5000) },
      { airingAt: 30, episode: 1, media: media(23, 5000) },
      { airingAt: 40, episode: 1, media: media(24, 5000) },
      { airingAt: 50, episode: 1, media: media(25, 5000) },
    ] },
  }
  const cat = createAnilistCatalog({ fetchFn: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data }) }) })
  const home = await cat.home()
  assert.deepStrictEqual(Object.keys(home), ['trending', 'popular', 'season', 'topAiring', 'upcoming', 'topRated', 'newEpisodes', 'today'])
  assert.deepStrictEqual(home.newEpisodes.map(e => e.id + ':' + e.aired.episode), ['8:7', '9:3'], 'popular first, one entry per show with its latest episode')
  assert.deepStrictEqual(home.today.map(e => e.id), [22, 23, 24, 25], 'the short nobody follows is dropped, the order is the clock')
  // A refused request is null, not a throw.
  const down = createAnilistCatalog({ fetchFn: async () => ({ ok: false, status: 500, headers: { get: () => null } }) })
  assert.strictEqual(await down.home(), null)
})

test('main serves the bundle with a half-hour memo and the saved copy during an outage; preload exposes it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const start = main.indexOf("ipcMain.handle('video-anime-home'")
  assert.ok(start > 0)
  const body = main.slice(start, main.indexOf('ipcMain.handle(', start + 10))
  assert.ok(/cat\.home\(\)/.test(body) && /_animeBrowseCacheWrite\('home', home\)/.test(body) && /_animeBrowseCacheRead\('home'\)/.test(body) && /fromCache: true/.test(body))
  assert.ok(/_animeHomeCache = makeCache\(\{ cap: 2, ttlMs: 1000 \* 60 \* 30 \}\)/.test(main))
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(/videoAnimeHome:\s+\(\) => ipcRenderer\.invoke\('video-anime-home'\)/.test(preload))
})

test('the renderer fills the anime rows from the bundle, badges the schedule cards, and puts the strip and countdown on the page', () => {
  const r = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  // Every anime-only row names the bundle list it is filled from.
  for (const [key, home] of [['top-airing-anime', 'topAiring'], ['new-episodes-anime', 'newEpisodes'], ['season-anime', 'season'], ['popular-anime', 'popular'], ['top-rated-anime', 'topRated'], ['upcoming-anime', 'upcoming']]) {
    assert.ok(new RegExp("key: '" + key + "'[^\\n]*home: '" + home + "'").test(r), key + ' → ' + home)
  }
  const fill = r.slice(r.indexOf('async function _fillAnimeHome'), r.indexOf('function _newEpisodeCard'))
  assert.ok(/window\.api\.videoAnimeHome\(\)/.test(fill) && /_startVideoHero\(list, ticket\)/.test(fill) && /_renderTodayRow\(home\.today\)/.test(fill) && /if \(!list\.length\) return _dropRow\(row\.key\)/.test(fill))
  // Rows the bundle served are not requested again.
  assert.ok(/pending = wanted\.filter\(function \(r\) \{ return served\.indexOf\(r\.key\) === -1 \}\)/.test(r))
  // The card badge and the spotlight countdown.
  assert.ok(/if \(item\.badge\) badges\.push\('<span class="vbadge vbadge-ep">'/.test(r))
  assert.ok(/vhero-chip/.test(r) && /_untilLabel\(Number\(na\.airingAt\) - Date\.now\(\)\)/.test(r))
  // The genre strip sits under the spotlight, above Continue Watching, and opens Browse on the anime catalogue.
  const shell = r.slice(r.indexOf("rows.innerHTML = '<div class=\"vrows-tools\">'"), r.indexOf('curated.map(function (r) { return _vRowShell(r.key'))
  assert.ok(shell.indexOf('_animeGenreStripHtml()') < shell.indexOf('personal.map('), 'strip before the personal rows')
  assert.ok(/_browse\.filters = Object\.assign\(_emptyFilters\(\), \{ catalog: 'anime' \}\)\n  _browse\.pendingGenreNames = genre \? \[genre\] : \[\]/.test(r))
})
