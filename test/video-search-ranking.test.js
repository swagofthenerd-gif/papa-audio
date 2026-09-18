'use strict'
// The search buried the obvious answer.
//
// Results were regrouped Films → Series → Anime in that fixed order whatever
// was asked for, and the merged list behind them was the film list with the
// anime list simply appended. Measured on the live app:
//
//   "Attack on Titan" → the two live-action films first, the famous series last
//   "Breaking Bad"    → El Camino above the show
//   "君の名は"          → five 1950s melodramas above Your Name
//
// The fix keeps the groups — a film, a series and an anime are different
// answers to one question, and the type chips are built from them — but orders
// BOTH the merged list and the groups by how well the title matches the query,
// with each catalogue's own rank as the tiebreak.
//
// Driven through the REAL catalogs with recorded payloads and an injected
// fetch. Nothing reaches the network.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const { createTmdbCatalog } = require('../catalog/tmdb')
const { createAnilistCatalog } = require('../catalog/anilist')
const { rankByRelevance, matchScore, sortJunkLast } = require('../catalog/search-rank')
const { runHandler } = require('./helpers/lift-ipc')

const FIX = path.join(__dirname, 'fixtures', 'video-search')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'))
}

function served(body) {
  return async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body })
}

// Both catalogues, fed the recorded payloads, merged the way `video-search`
// merges them.
async function page(slug, query) {
  const tmdb = createTmdbCatalog({ apiKey: 'k', fetchFn: served(fixture(slug + '.tmdb')) })
  const anilist = createAnilistCatalog({ fetchFn: served(fixture(slug + '.anilist')) })
  const films = await tmdb.search(query)
  const anime = await anilist.search(query)
  return { films, anime, ranked: sortJunkLast(rankByRelevance(query, [films, anime])) }
}

const titles = list => list.map(r => r.title)
const typeOf = r => r.type
// Where the entry the user obviously meant ended up.
function indexOfTitle(list, title) {
  return list.findIndex(r => r.title === title)
}

test('Attack on Titan: the series and the anime outrank the live-action films', async () => {
  const p = await page('attack-on-titan', 'Attack on Titan')
  // The baseline this test exists to beat: the old merge was films-then-anime,
  // so the AniList entry could only ever be at the very end.
  const before = p.films.concat(p.anime)
  assert.equal(typeOf(before[before.length - 1]), 'anime',
    'the old concatenation really did put the anime last')

  const anime = p.ranked.filter(r => r.type === 'anime')
  assert.ok(anime.length, 'AniList did answer')
  const animeAt = p.ranked.indexOf(anime[0])
  const sequelFilm = indexOfTitle(p.ranked, 'Attack on Titan II: End of the World')
  assert.ok(animeAt < sequelFilm,
    'the anime is above the live-action sequel, not below it: ' + JSON.stringify(titles(p.ranked)))
  assert.ok(animeAt <= 2, 'and it is near the top: position ' + animeAt)
  // The junior-high spin-off matched only partially and sinks.
  assert.ok(indexOfTitle(p.ranked, 'Attack on Titan: Junior High') > animeAt)
})

test('Breaking Bad: the series outranks the spin-off film', async () => {
  const p = await page('breaking-bad', 'Breaking Bad')
  const show = indexOfTitle(p.ranked, 'Breaking Bad')
  const elCamino = indexOfTitle(p.ranked, 'El Camino: A Breaking Bad Movie')
  assert.equal(show, 0, 'the show asked for is first: ' + JSON.stringify(titles(p.ranked)))
  assert.ok(show < elCamino, 'El Camino is below it')
  assert.ok(indexOfTitle(p.ranked, 'Better Call Saul') > elCamino, 'and the unrelated show is last')
})

test('君の名は: Your Name is not buried under the 1950s melodramas', async () => {
  const p = await page('kimi-no-na-wa', '君の名は')
  const yourName = p.ranked.findIndex(r => r.type === 'anime' || r.title === 'Your Name.')
  assert.ok(yourName <= 1,
    'Your Name is at the top, not behind three melodramas and a 1991 series: ' +
    JSON.stringify(titles(p.ranked)))
  // The exact-title melodramas are still there — they really are called 君の名は.
  assert.ok(p.ranked.length > 4)
})

test('a CJK query matches the native title, not just the English one', () => {
  assert.equal(matchScore('君の名は', { title: 'Your Name.', titles: { native: '君の名は。' } }), 1)
  assert.equal(matchScore('Kimi no Na wa', { title: 'Your Name.', titles: { romaji: 'Kimi no Na wa.' } }), 1)
})

test('rank ties interleave the catalogues instead of running one list out first', () => {
  // The exact shape of the old bug: at equal relevance, every film came before
  // every anime. A tie now alternates, so neither catalogue can bury the other.
  const films = [{ title: 'Ghost', type: 'movie' }, { title: 'Ghost', type: 'movie' }]
  const anime = [{ title: 'Ghost', type: 'anime' }, { title: 'Ghost', type: 'anime' }]
  const out = rankByRelevance('Ghost', [films, anime]).map(typeOf)
  assert.deepEqual(out, ['movie', 'anime', 'movie', 'anime'])
})

test('an unranked catalogue answer is not reordered among itself', () => {
  // Within one relevance level each catalogue keeps the order it chose.
  const films = [{ title: 'Dune', type: 'movie', id: 1 }, { title: 'Dune', type: 'movie', id: 2 }]
  const out = rankByRelevance('Dune', [films, []]).map(r => r.id)
  assert.deepEqual(out, [1, 2])
})

// ── Through the real handler ────────────────────────────────────────────────
// The ranking above is only reached if `video-search` actually calls it. It
// used to concatenate the two lists instead, which is the bug.

test('the real video-search handler returns the ranked order, not film-then-anime', async () => {
  const p = await page('attack-on-titan', 'Attack on Titan')
  const { result } = await runHandler('video-search', {
    args: { query: 'Attack on Titan', type: 'all' },
    globals: {
      tmdb: () => ({ search: async () => p.films }),
      _animeSearch: async () => p.anime,
      anilist: () => ({ lastFailure: () => null }),
      jikan: () => ({ lastFailure: () => null }),
      kitsu: () => ({ lastFailure: () => null }),
      sortJunkLast,
      rankByRelevance,
      _sameShow: () => false,
    },
    timeoutMs: 1000,
  })
  assert.ok(result && result.ok, 'the handler answered')
  const last = result.results[result.results.length - 1]
  assert.notEqual(last.type, 'anime',
    'the anime entries are no longer all shoved to the end: ' +
    JSON.stringify(result.results.map(r => r.type)))
  const animeAt = result.results.findIndex(r => r.type === 'anime')
  assert.ok(animeAt <= 2, 'the AniList entry ranks near the top: ' + animeAt)
})

// ── The paint ───────────────────────────────────────────────────────────────
// Ranking the merged list is only half of it: the renderer regrouped the page
// Films → Series → Anime afterwards, which put the ranking straight back in
// the bin.

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  let depth = 0
  for (let j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

function paintHarness() {
  const target = {
    _html: '', dataset: {}, style: { display: '', removeProperty() {} },
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = v },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
  }
  const filled = []
  const sandbox = {
    document: { getElementById: id => (id === 'video-search-results' ? target : null) },
    state: {}, console,
    _vSearchFilter: { results: [], type: 'all', decade: 'all', query: '', sources: null },
    esc: s => String(s == null ? '' : s),
    _fillRow(key) { filled.push(key) },
    _releaseCardsIn() {}, _bindVideoSearchFilters() {}, _bindVideoSearchRetry() {},
    _vSearchIntentHtml: () => '', _shortQ: q => String(q),
    _VICON: { left: '<', right: '>' },
    Number, Array, String, Object, Set,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext([
    extractFn(SRC, '_setVideoSearchHtml'),
    extractFn(SRC, '_vRailSkeleton'),
    extractFn(SRC, '_vRowShell'),
    extractFn(SRC, '_videoDecadeLabel'),
    extractFn(SRC, '_videoResultDecades'),
    extractFn(SRC, '_filterVideoResults'),
    extractFn(SRC, '_vSearchFilterBarHtml'),
    extractFn(SRC, '_vSearchFailedSources'),
    extractFn(SRC, '_vSearchRetryHtml'),
    extractFn(SRC, '_vSearchSourceNoteHtml'),
    extractFn(SRC, '_vSearchGroupOrder'),
    extractFn(SRC, '_paintVideoSearchResults'),
    'const _VSEARCH_TYPE_CHIPS = ' + /var _VSEARCH_TYPE_CHIPS = (\[[\s\S]*?\n\])/.exec(SRC)[1],
  ].join('\n'), sandbox)
  return { sandbox, filled, html: () => target._html }
}

test('the groups are painted in the order their best match arrived', async () => {
  const p = await page('attack-on-titan', 'Attack on Titan')
  const h = paintHarness()
  h.sandbox._vSearchFilter.results = p.ranked
  h.sandbox._vSearchFilter.query = 'Attack on Titan'
  h.sandbox._paintVideoSearchResults()
  // Anime must not be painted last just because it is called anime.
  assert.notEqual(h.filled[h.filled.length - 1], 'search-anime',
    'the anime row is no longer pinned to the bottom: ' + JSON.stringify(h.filled))
  assert.equal(h.filled[0], 'search-' + (p.ranked[0].type || 'movie'),
    'the first row is the one holding the best match')
})

test('Breaking Bad paints Series above Films', async () => {
  const p = await page('breaking-bad', 'Breaking Bad')
  const h = paintHarness()
  h.sandbox._vSearchFilter.results = p.ranked
  h.sandbox._vSearchFilter.query = 'Breaking Bad'
  h.sandbox._paintVideoSearchResults()
  assert.ok(h.filled.indexOf('search-tv') < h.filled.indexOf('search-movie'),
    'El Camino no longer sits above the show it spun off from: ' + JSON.stringify(h.filled))
})

test('a one-kind result set still paints exactly one row', () => {
  const h = paintHarness()
  h.sandbox._vSearchFilter.results = [
    { type: 'movie', id: 1, title: 'Dune', year: 2021, poster: 'p' },
    { type: 'movie', id: 2, title: 'Dune: Part Two', year: 2024, poster: 'p' },
  ]
  h.sandbox._vSearchFilter.query = 'Dune'
  h.sandbox._paintVideoSearchResults()
  assert.deepEqual(h.filled, ['search-movie'])
})
