'use strict'
// Browse through MyAnimeList when AniList refuses: the same filters under
// MAL's names, genres resolved from names to MAL ids, the AniList discover
// result shape. Live MAL was down (504) when this was written, so the
// contract is pinned here against recorded shapes.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { buildDiscoverUrl, buildGenresUrl, createJikanCatalog, JIKAN_SORT } = require('../catalog/jikan')

test('the discover URL carries genres, type, status, score floor, year and sort in MAL\'s vocabulary', () => {
  const u = new URL(buildDiscoverUrl({ page: 2, formats: ['TV'], status: 'RELEASING', minRating: 7, seasonYear: 2020, sort: 'rating' }, [18, 24]))
  assert.strictEqual(u.pathname, '/v4/anime')
  const p = u.searchParams
  assert.strictEqual(p.get('genres'), '18,24')
  assert.strictEqual(p.get('type'), 'tv')
  assert.strictEqual(p.get('status'), 'airing')
  assert.strictEqual(p.get('min_score'), '7')
  assert.strictEqual(p.get('start_date'), '2020-01-01')
  assert.strictEqual(p.get('end_date'), '2020-12-31')
  assert.strictEqual(p.get('order_by'), 'score')
  assert.strictEqual(p.get('sort'), 'desc')
  assert.strictEqual(p.get('page'), '2')
  assert.strictEqual(p.get('sfw'), 'true')
  // MAL's popularity is a rank, so "most popular" is ascending.
  assert.deepStrictEqual(JIKAN_SORT.popularity, ['popularity', 'asc'])
  // A season goes to the seasons endpoint, which takes only the page.
  assert.strictEqual(buildDiscoverUrl({ season: 'FALL', seasonYear: 2024, page: 3 }, [18]), 'https://api.jikan.moe/v4/seasons/2024/fall?page=3')
  assert.strictEqual(buildGenresUrl(), 'https://api.jikan.moe/v4/genres/anime')
})

test('discover resolves genre names through /genres/anime once, and returns the AniList discover shape', async () => {
  const urls = []
  const fetchFn = async (url) => {
    urls.push(url)
    if (url.includes('/genres/anime')) return { ok: true, status: 200, json: async () => ({ data: [{ mal_id: 18, name: 'Mecha' }, { mal_id: 24, name: 'Sci-Fi' }] }) }
    return { ok: true, status: 200, json: async () => ({ data: [{ mal_id: 30, title: 'Neon Genesis Evangelion', type: 'TV', score: 8.3 }], pagination: { current_page: 1, last_visible_page: 40, has_next_page: true, items: { total: 990 } } }) }
  }
  const cat = createJikanCatalog({ fetchFn, minIntervalMs: 0 })
  const out = await cat.discover({ genres: ['mecha', 'Sci-Fi'], sort: 'popularity', page: 1 })
  assert.deepStrictEqual(out.results.map(r => r.title), ['Neon Genesis Evangelion'])
  assert.strictEqual(out.results[0].id, 'mal-30')
  assert.deepStrictEqual({ page: out.page, totalPages: out.totalPages, totalResults: out.totalResults, hasMore: out.hasMore }, { page: 1, totalPages: 40, totalResults: 990, hasMore: true })
  assert.ok(urls[1].includes('genres=18%2C24'))
  await cat.discover({ genres: ['Mecha'] })
  assert.strictEqual(urls.filter(u => u.includes('/genres/anime')).length, 1, 'the genre map is fetched once')
  // A genre MAL does not know yields nothing rather than an unfiltered list.
  const none = await cat.discover({ genres: ['Isekai Cooking'] })
  assert.deepStrictEqual(none.results, [])
  // A dead MAL is an empty page, never a throw.
  const dead = createJikanCatalog({ fetchFn: async () => ({ ok: false, status: 504 }), minIntervalMs: 0 })
  assert.deepStrictEqual((await dead.discover({ sort: 'newest' })).results, [])
})

test('video-discover falls to MyAnimeList before the saved page when AniList refuses', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const start = main.indexOf("ipcMain.handle('video-discover'")
  const body = main.slice(start, main.indexOf('ipcMain.handle(', start + 10))
  const viaMal = body.indexOf('const viaMal = await _jikanDiscover(req)')
  const saved = body.indexOf("_animeBrowseCacheRead('discover:' + key)")
  assert.ok(viaMal > 0 && saved > viaMal, 'live MAL is tried before the saved page')
  assert.ok(/viaMal: true, outage: lf\.message/.test(body))
  assert.ok(/async function _jikanDiscover\(req\) \{\n  try \{ return await jikan\(\)\.discover\(req\) \} catch \(_\) \{ return null \}/.test(main))
})
