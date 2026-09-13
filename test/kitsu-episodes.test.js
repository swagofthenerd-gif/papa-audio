'use strict'
// The anime episode list: Kitsu maps a MyAnimeList id to its entry in one
// request (the /mappings resource, with the item included — filtering /anime
// by mapping fields is refused), then serves twenty episodes a page in the
// shape the television rows already render.
const test = require('node:test')
const assert = require('node:assert')
const { buildMalMappingUrl, buildEpisodesUrl, normalizeEpisode, createKitsuCatalog, EPISODE_PAGE } = require('../catalog/kitsu')

test('the mapping URL asks /mappings for the MAL id with the item included', () => {
  const u = buildMalMappingUrl(21)
  assert.ok(u.startsWith('https://kitsu.io/api/edge/mappings?'))
  assert.ok(u.includes('filter%5BexternalSite%5D=myanimelist%2Fanime') && u.includes('filter%5BexternalId%5D=21') && u.includes('include=item'))
})

test('the episodes URL pages by twenty, sorted by number', () => {
  const u = buildEpisodesUrl(12, 40)
  assert.ok(u.includes('/anime/12/episodes?') && u.includes('page%5Blimit%5D=20') && u.includes('page%5Boffset%5D=40') && u.includes('sort=number'))
  assert.strictEqual(EPISODE_PAGE, 20)
})

test('a Kitsu episode becomes a television-shaped episode', () => {
  const ep = normalizeEpisode({ id: '1', attributes: { number: 3, titles: { en_jp: 'Morgan vs. Luffy', en: 'Morgan versus Luffy!' }, canonicalTitle: 'Morgan vs. Luffy', synopsis: 'Luffy and Zoro fight.', airdate: '1999-11-17', length: 24, thumbnail: { original: 'https://media/3.jpg' } } })
  assert.deepStrictEqual(ep, { episodeNumber: 3, name: 'Morgan versus Luffy!', overview: 'Luffy and Zoro fight.', still: 'https://media/3.jpg', airDate: '1999-11-17', runtime: 24 })
  // A placeholder title is dropped so the row makes its own; a bad number is no episode.
  assert.strictEqual(normalizeEpisode({ attributes: { number: 4, canonicalTitle: 'Episode 4' } }).name, null)
  assert.strictEqual(normalizeEpisode({ attributes: { number: 0 } }), null)
})

test('idForMal reads the mapped anime id, and episodes returns the page with its total', async () => {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    if (url.includes('/mappings?')) return { ok: true, status: 200, json: async () => ({ data: [{ id: '1175', type: 'mappings', relationships: { item: { data: { type: 'anime', id: '12' } } } }] }) }
    return { ok: true, status: 200, json: async () => ({ data: [{ id: '9', attributes: { number: 1, canonicalTitle: 'First', airdate: '1999-10-20' } }], meta: { count: 1401 } }) }
  }
  const cat = createKitsuCatalog({ fetchFn, minIntervalMs: 0 })
  assert.strictEqual(await cat.idForMal(21), 12)
  const page = await cat.episodes(12, 0)
  assert.strictEqual(page.total, 1401)
  assert.deepStrictEqual(page.episodes.map(e => e.name), ['First'])
  // No mapping, no id; a dead Kitsu is an empty page, never a throw.
  const dead = createKitsuCatalog({ fetchFn: async () => ({ ok: false, status: 500 }), minIntervalMs: 0 })
  assert.strictEqual(await dead.idForMal(21), null)
  assert.deepStrictEqual(await dead.episodes(12, 0), { episodes: [], total: null })
})

test('the main process serves the window from the persistent cache, one page per twenty, and the renderer asks for it', () => {
  const fs = require('fs'); const path = require('path')
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const start = main.indexOf("ipcMain.handle('video-anime-episodes'")
  assert.ok(start > 0)
  const body = main.slice(start, main.indexOf('ipcMain.handle(', start + 10))
  assert.ok(/kitsumap:\$\{mal\}/.test(body) && /eps:\$\{kitsuId\}:\$\{offset\}/.test(body))
  assert.ok(/cat\.idForMal\(mal\)/.test(body) && /cat\.episodes\(kitsuId, offset\)/.test(body))
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.ok(/videoAnimeEpisodes: \(p\) => ipcRenderer\.invoke\('video-anime-episodes', p\)/.test(preload))
  const r = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.ok(/window\.api\.videoAnimeEpisodes\(\{ idMal: idMal, start: win\.start, end: win\.end \}\)/.test(r))
  // Rows play on press, like television's; buttons only select.
  const enrich = r.slice(r.indexOf('const enrichWindow = async function'), r.indexOf('const ticketAtPaint'))
  assert.ok(/\.vep-row'\)\.forEach/.test(enrich) && /_autoPlayTicket = _videoDetailTicket/.test(enrich))
  // An airing show with no total still gets a grid of the episodes aired so far.
  assert.ok(/Number\(na\.episode\) > 1 \? Number\(na\.episode\) - 1 : 0/.test(r))
})
