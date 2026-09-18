'use strict'
// Typing "Intersteller" was a dead end.
//
// The film catalogue found nothing for the misspelling. The anime catalogue —
// whose search is fuzzy — answered with eighteen unrelated shows. Because the
// result list was not EMPTY, the spelling retry (which only ever fired on zero
// results) never ran, and there was no route from the typo to Interstellar at
// all. The user just got eighteen anime and no explanation.
//
// Two changes. Anime entries that only matched fuzzily are dropped when the
// film catalogue found nothing solid either and the query is not Japanese, so
// the list CAN be empty. And the retry fires on a weak best match, not only on
// zero, with a shortened query to try: TMDB matches title prefixes, so
// "Interstel" finds the film the typo meant.
//
// Driven through the REAL handler and the REAL renderer with recorded payloads.
// Nothing reaches the network.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const { createTmdbCatalog } = require('../catalog/tmdb')
const { createAnilistCatalog } = require('../catalog/anilist')
const rank = require('../catalog/search-rank')
const { runHandler } = require('./helpers/lift-ipc')

const FIX = path.join(__dirname, 'fixtures', 'video-search')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

const fixture = name => JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'))
const served = body => async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body })

// The handler, wired to the two real catalogs over recorded payloads.
async function realSearch(slug, query) {
  const tmdb = createTmdbCatalog({ apiKey: 'k', fetchFn: served(fixture(slug + '.tmdb')) })
  const anilist = createAnilistCatalog({ fetchFn: served(fixture(slug + '.anilist')) })
  const { result } = await runHandler('video-search', {
    args: { query, type: 'all' },
    globals: {
      tmdb: () => tmdb,
      _animeSearch: q => anilist.search(q),
      anilist: () => ({ lastFailure: () => null }),
      jikan: () => ({ lastFailure: () => null }),
      kitsu: () => ({ lastFailure: () => null }),
      sortJunkLast: rank.sortJunkLast,
      rankByRelevance: rank.rankByRelevance,
      floorAnimeNoise: rank.floorAnimeNoise,
      matchScore: rank.matchScore,
      _sameShow: () => false,
    },
    timeoutMs: 2000,
  })
  return result
}

test('the misspelling no longer returns a wall of unrelated anime', async () => {
  // The baseline: AniList really does answer the typo with four unrelated shows.
  const anilist = createAnilistCatalog({ fetchFn: served(fixture('intersteller.anilist')) })
  assert.ok((await anilist.search('Intersteller')).length >= 4, 'the noise is real')

  const res = await realSearch('intersteller', 'Intersteller')
  assert.equal(res.ok, true)
  assert.deepEqual(res.results, [],
    'nothing matched, which is the truth and is what lets the retry fire: ' +
    JSON.stringify(res.results.map(r => r.title)))
  assert.equal(res.topScore, 0)
})

test('the floor does not eat a real anime hit', async () => {
  const res = await realSearch('attack-on-titan', 'Attack on Titan')
  assert.ok(res.results.some(r => r.type === 'anime'),
    'a query that genuinely names an anime still gets it')
})

test('the floor leaves a Japanese query alone', () => {
  // A CJK query is exactly where AniList's fuzzy matching is the useful one.
  const noise = [{ title: 'Weathering With You', titles: { native: '天気の子' } }]
  assert.equal(rank.floorAnimeNoise('君の名は', [], noise).length, 1)
})

test('the floor leaves anime alone when the film catalogue found the thing', () => {
  const films = [{ title: 'Interstellar' }]
  const anime = [{ title: 'Planetes' }]
  assert.equal(rank.floorAnimeNoise('Interstellar', films, anime).length, 1,
    'the anime sorts below the film anyway — there is nothing to protect against')
})

// ── The shortened query ─────────────────────────────────────────────────────

test('a shortened query finds what the typo meant', async () => {
  const res = await realSearch('interstel', 'Interstel')
  assert.ok(res.results.some(r => r.title === 'Interstellar'),
    'the prefix reaches the film: ' + JSON.stringify(res.results.map(r => r.title)))
  assert.ok(res.topScore >= 0.6, 'and it scores as a real match: ' + res.topScore)
})

// ── The renderer's retry chain ──────────────────────────────────────────────

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

function box() {
  return {
    id: 'video-search-results', _html: '', dataset: {},
    style: { display: '', removeProperty() {} },
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = v },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
  }
}

function harness(videoSearch) {
  const els = { 'video-search-results': box(), vrows: box(), 'vhero-mount': box(), 'vtaste-row': box() }
  const filled = []
  const sandbox = {
    document: { getElementById: id => els[id] || null },
    window: { api: { videoSearch: videoSearch } },
    state: { currentPage: 'video', currentVideoQuery: '' },
    _videoSearchTicket: 0,
    _vSearchFilter: { results: [], type: 'all', decade: 'all', query: '', sources: null },
    _lastVideoSearch: null,
    _VICON: { left: '<', right: '>' },
    esc: s => String(s == null ? '' : s),
    console,
    _fillRow(key, items) { filled.push([key, items.length]) },
    _releaseCardsIn() {}, _bindVideoSearchFilters() {}, _bindVideoSearchRetry() {},
    _vSearchIntentHtml: () => '', _searchIntent: () => null, _shortQ: q => String(q),
    _rememberSearch() {}, _videoErrorText: m => String(m),
    Date, Promise, Array, String, Number, Object, JSON, Math, Set,
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
    extractFn(SRC, '_vSearchOutageHtml'),
    extractFn(SRC, '_vSearchGroupOrder'),
    extractFn(SRC, '_vSearchEmptyHtml'),
    extractFn(SRC, '_simplifyVideoQuery'),
    extractFn(SRC, '_relaxVideoQuery'),
    extractFn(SRC, '_videoRetryQueries'),
    extractFn(SRC, '_paintVideoSearchResults'),
    extractFn(SRC, '_retryVideoTitleSearch'),
    extractFn(SRC, '_runVideoTitleSearch'),
    /var VSEARCH_WEAK_MATCH = [\d.]+/.exec(SRC)[0],
    'const _VSEARCH_TYPE_CHIPS = ' + /var _VSEARCH_TYPE_CHIPS = (\[[\s\S]*?\n\])/.exec(SRC)[1],
  ].join('\n'), sandbox)
  return { sandbox, els, filled, html: () => els['video-search-results']._html }
}

const settle = () => new Promise(r => setTimeout(r, 5))

test('_relaxVideoQuery shortens the longest word, and refuses when there is nothing to shorten', () => {
  const ctx = harness(async () => ({ ok: true, results: [] })).sandbox
  assert.equal(ctx._relaxVideoQuery('Intersteller'), 'Interstel')
  assert.equal(ctx._relaxVideoQuery('The Intersteller Movie'), 'The Interstel Movie')
  assert.equal(ctx._relaxVideoQuery('Dune'), null, 'a short word is not worth cutting')
  assert.equal(ctx._relaxVideoQuery(''), null)
})

test('"Intersteller" reaches Interstellar', async () => {
  // Exactly what the two fixtures say the catalogues answer.
  const typo = await realSearch('intersteller', 'Intersteller')
  const prefix = await realSearch('interstel', 'Interstel')
  const asked = []
  const h = harness(async ({ query }) => {
    asked.push(query)
    if (query === 'Intersteller') return typo
    if (query === 'Interstel') return prefix
    return { ok: true, results: [], topScore: 0, sources: { tmdb: 'ok', anime: 'ok' }, failed: [] }
  })
  h.sandbox._runVideoTitleSearch('Intersteller')
  await settle()
  assert.deepEqual(asked, ['Intersteller', 'Interstel'],
    'the typo was retried with a shortened query')
  const shown = h.sandbox._vSearchFilter.results.map(r => r.title)
  assert.ok(shown.indexOf('Interstellar') > -1, 'and the film is on screen: ' + JSON.stringify(shown))
  assert.match(h.html(), /Showing results for/, 'the swap is not silent')
})

test('the retry also fires on a weak top match, not only on zero results', async () => {
  const asked = []
  const h = harness(async ({ query }) => {
    asked.push(query)
    return query === 'Intersteller'
      // Something came back, but it is barely related — the old code stopped here.
      ? { ok: true, results: [{ type: 'anime', id: 7, title: 'Interstella 5555', year: 2003, poster: 'p' }], topScore: 0.2, sources: { tmdb: 'ok', anime: 'ok' }, failed: [] }
      : { ok: true, results: [{ type: 'movie', id: 157336, title: 'Interstellar', year: 2014, poster: 'p' }], topScore: 0.65, sources: { tmdb: 'ok', anime: 'ok' }, failed: [] }
  })
  h.sandbox._runVideoTitleSearch('Intersteller')
  await settle()
  assert.equal(asked.length, 2, 'a weak answer was not accepted as final')
  assert.equal(h.sandbox._vSearchFilter.results[0].title, 'Interstellar')
})

test('a strong answer is never retried', async () => {
  const asked = []
  const h = harness(async ({ query }) => {
    asked.push(query)
    return { ok: true, results: [{ type: 'movie', id: 1, title: 'Oppenheimer', year: 2023, poster: 'p' }], topScore: 1, sources: { tmdb: 'ok', anime: 'ok' }, failed: [] }
  })
  h.sandbox._runVideoTitleSearch('Oppenheimer')
  await settle()
  assert.deepEqual(asked, ['Oppenheimer'], 'one fetch, no second-guessing')
  assert.ok(!/Showing results for/.test(h.html()))
})

test('a retry that is no better keeps what the original query found', async () => {
  const weak = { ok: true, results: [{ type: 'anime', id: 7, title: 'Interstella 5555', year: 2003, poster: 'p' }], topScore: 0.2, sources: { tmdb: 'ok', anime: 'ok' }, failed: [] }
  const h = harness(async ({ query }) => (query === 'Intersteller' ? weak : { ok: true, results: [], topScore: 0, sources: { tmdb: 'ok', anime: 'ok' }, failed: [] }))
  h.sandbox._runVideoTitleSearch('Intersteller')
  await settle()
  assert.equal(h.sandbox._vSearchFilter.results.length, 1,
    'the weak results are better than an empty screen')
  assert.ok(!/Showing results for/.test(h.html()), 'and nothing was swapped')
})

test('the retry chain terminates — it cannot ask forever', async () => {
  let calls = 0
  const h = harness(async () => { calls++; return { ok: true, results: [], topScore: 0, sources: { tmdb: 'ok', anime: 'ok' }, failed: [] } })
  h.sandbox._runVideoTitleSearch('Intersteller')
  await settle()
  assert.ok(calls <= 3, 'bounded: ' + calls)
  assert.match(h.html(), /spelling/i, 'and it ends on the honest empty state')
})

test('a dead catalogue stops the retry chain instead of hammering it', async () => {
  let calls = 0
  const h = harness(async () => {
    calls++
    return { ok: true, results: [], topScore: 0, sources: { tmdb: 'failed', anime: 'ok' }, failed: [{ source: 'tmdb', error: '503' }] }
  })
  h.sandbox._runVideoTitleSearch('Intersteller')
  await settle()
  assert.equal(calls, 1, 'no point trying another spelling against a server that is down')
  assert.match(h.html(), /didn’t answer/)
})
