'use strict'
// "Most of the films that I search and open are not opening and giving an
// error." The failure happened BEFORE opening anything.
//
// `video-search` ran both catalogues with `.catch(() => [])`, so a TMDB that
// answered 429 — or did not answer inside the 10 s timeout — produced the same
// thing as a film that does not exist: an empty list under `ok: true`. The
// renderer then printed "No matches for 'Oppenheimer' — check the spelling".
// A live audit hit that on five of twenty searches for famous films.
//
// A second shape of the same bug: "Spider-Man" returned 2 films + 4 anime three
// times and 0 films + 4 anime once, inside the same minute, with no warning.
//
// These run the REAL handler (lifted out of main.js) and the REAL renderer
// functions (lifted out of src/renderer.js). Nothing reaches the network.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { runHandler } = require('./helpers/lift-ipc')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// ── The handler side ────────────────────────────────────────────────────────

const FILM = { id: 1, type: 'movie', title: 'Oppenheimer', year: '2023', poster: '/p.jpg' }
const ANIME = { id: 9, type: 'anime', title: 'Naruto', year: '2002', poster: '/a.jpg' }

// Everything the 'all' branch of the handler reaches for. `healthy` catalogs
// report no outage, which is how the anime lane tells "nothing found" apart
// from "nobody answered".
function globalsFor({ tmdbSearch, animeSearch, animeDatabasesDown = false }) {
  const down = () => (animeDatabasesDown ? { at: Date.now(), message: 'down' } : null)
  return {
    tmdb: () => ({ search: tmdbSearch }),
    _animeSearch: animeSearch,
    anilist: () => ({ lastFailure: down }),
    jikan: () => ({ lastFailure: down }),
    kitsu: () => ({ lastFailure: down }),
    sortJunkLast: x => x,
    _sameShow: () => false,
  }
}

async function search(opts) {
  const { result } = await runHandler('video-search', {
    args: { query: opts.query || 'Oppenheimer', type: 'all' },
    globals: globalsFor(opts),
    timeoutMs: 1000,
  })
  return result
}

test('a dead film catalogue is reported, not disguised as "no such film"', async () => {
  const res = await search({
    tmdbSearch: async () => { throw new Error('TMDB request failed (429)') },
    animeSearch: async () => [],
  })
  assert.equal(res.ok, true, 'the search still answers — the anime lane was fine')
  assert.deepEqual(res.results, [], 'and it genuinely found nothing')
  assert.equal(res.sources.tmdb, 'failed', 'but it says WHY there is nothing')
  assert.equal(res.sources.anime, 'ok')
  assert.ok(res.failed.some(f => f.source === 'tmdb' && /429/.test(f.error)),
    'the reason rides along: ' + JSON.stringify(res.failed))
})

test('both catalogues answering is reported as such', async () => {
  const res = await search({
    tmdbSearch: async () => [FILM],
    animeSearch: async () => [ANIME],
  })
  assert.equal(res.ok, true)
  assert.equal(res.results.length, 2)
  assert.deepEqual(res.sources, { tmdb: 'ok', anime: 'ok' })
  assert.deepEqual(res.failed, [])
})

test('a healthy-but-empty search is NOT reported as a failure', async () => {
  // The distinction the whole fix rests on: "there is no such film" must stay
  // available as an honest answer, or the spelling advice can never be shown.
  const res = await search({
    query: 'zzzzqqqq',
    tmdbSearch: async () => [],
    animeSearch: async () => [],
  })
  assert.deepEqual(res.sources, { tmdb: 'ok', anime: 'ok' })
  assert.deepEqual(res.failed, [])
})

test('the anime lane degrading to empty while all three databases are down counts as failed', async () => {
  // _animeSearch does not throw on an outage — it returns [] and flags it. The
  // anime-only branch already checked those flags; the merged branch did not.
  const res = await search({
    tmdbSearch: async () => [FILM],
    animeSearch: async () => [],
    animeDatabasesDown: true,
  })
  assert.equal(res.sources.anime, 'failed')
  assert.equal(res.sources.tmdb, 'ok')
  assert.equal(res.results.length, 1, 'the films still come through')
})

test('a film that IS found while the anime lane is down still reports the loss', async () => {
  const res = await search({
    tmdbSearch: async () => [FILM],
    animeSearch: async () => { throw new Error('AniList request failed (503)') },
  })
  assert.equal(res.ok, true)
  assert.equal(res.results.length, 1)
  assert.equal(res.sources.anime, 'failed')
})

// ── The renderer side ───────────────────────────────────────────────────────

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
    else if (source[j] === '}') {
      depth--
      if (!depth) return source.slice(start, j + 1)
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

// A results box just real enough for the paint paths: it holds html, and it can
// hand back the retry buttons that html contains so a click can be fired.
function box() {
  return {
    id: 'video-search-results',
    _html: '',
    _buttons: [],
    dataset: {},
    style: { display: '', removeProperty() { this.display = '' } },
    get innerHTML() { return this._html },
    set innerHTML(v) {
      this._html = v
      const n = (String(v).match(/data-vsearch-retry/g) || []).length
      this._buttons = []
      for (let i = 0; i < n; i++) {
        this._buttons.push({ _on: [], addEventListener(_e, fn) { this._on.push(fn) }, click() { this._on.forEach(f => f()) } })
      }
    },
    querySelectorAll(sel) {
      return sel === '[data-vsearch-retry]' ? this._buttons.slice() : []
    },
    querySelector() { return null },
    addEventListener() {},
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
    _releaseCardsIn() {},
    _bindVideoSearchFilters() {},
    _vSearchIntentHtml: () => '',
    _searchIntent: () => null,
    _shortQ: q => String(q),
    _simplifyVideoQuery: q => q,
    _retryVideoTitleSearch() {},
    _rememberSearch() {},
    Date, Promise, Array, String, Number, Object, JSON,
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
    extractFn(SRC, '_bindVideoSearchRetry'),
    extractFn(SRC, '_vSearchEmptyHtml'),
    extractFn(SRC, '_paintVideoSearchResults'),
    extractFn(SRC, '_runVideoTitleSearch'),
    'const _VSEARCH_TYPE_CHIPS = ' + /var _VSEARCH_TYPE_CHIPS = (\[[\s\S]*?\n\])/.exec(SRC)[1],
  ].join('\n'), sandbox)
  return { sandbox, els, filled, html: () => els['video-search-results']._html }
}

const settle = () => new Promise(r => setTimeout(r, 0))

test('an empty result caused by a dead catalogue does not blame the spelling', async () => {
  const h = harness(async () => ({ ok: true, results: [], sources: { tmdb: 'failed', anime: 'ok' }, failed: [{ source: 'tmdb', error: '429' }] }))
  h.sandbox._runVideoTitleSearch('Oppenheimer')
  await settle()
  const html = h.html()
  assert.ok(!/spelling/i.test(html), 'the spelling advice is gone: ' + html)
  assert.match(html, /film catalogue/i, 'it names what actually failed')
  assert.match(html, /data-vsearch-retry/, 'and offers to run the same query again')
})

test('the Retry runs the SAME query, not a simplified one', async () => {
  const asked = []
  const h = harness(async ({ query }) => {
    asked.push(query)
    return { ok: true, results: [], sources: { tmdb: 'failed', anime: 'ok' }, failed: [] }
  })
  h.sandbox._runVideoTitleSearch('Dune: Part Two')
  await settle()
  const buttons = h.els['video-search-results'].querySelectorAll('[data-vsearch-retry]')
  assert.equal(buttons.length, 1, 'there is exactly one retry control')
  buttons[0].click()
  await settle()
  assert.deepEqual(asked, ['Dune: Part Two', 'Dune: Part Two'])
})

test('a genuine miss still gets the spelling advice', async () => {
  const h = harness(async () => ({ ok: true, results: [], sources: { tmdb: 'ok', anime: 'ok' }, failed: [] }))
  h.sandbox._runVideoTitleSearch('zzzzqqqq')
  await settle()
  assert.match(h.html(), /spelling/i, 'the honest empty state is untouched')
  assert.ok(!/didn.t answer/i.test(h.html()))
})

test('results that arrived with one lane missing carry a one-line note and a Retry', async () => {
  const h = harness(async () => ({
    ok: true,
    results: [{ type: 'anime', id: 9, title: 'Naruto', year: '2002', poster: 'p' }],
    sources: { tmdb: 'failed', anime: 'ok' },
    failed: [{ source: 'tmdb', error: '429' }],
  }))
  h.sandbox._runVideoTitleSearch('Naruto')
  await settle()
  const html = h.html()
  assert.match(html, /showing anime only/i, 'the note says what is missing: ' + html)
  assert.match(html, /data-vsearch-retry/, 'with a way to try again')
  assert.ok(h.filled.length > 0, 'and the results it DID get are still painted')
})

test('the note survives a filter chip repaint — the catalogue is still down', async () => {
  const h = harness(async () => ({
    ok: true,
    results: [{ type: 'anime', id: 9, title: 'Naruto', year: '2002', poster: 'p' }],
    sources: { tmdb: 'failed', anime: 'ok' },
    failed: [],
  }))
  h.sandbox._runVideoTitleSearch('Naruto')
  await settle()
  h.sandbox._paintVideoSearchResults()
  assert.match(h.html(), /showing anime only/i)
})

test('a healthy search paints no note at all', async () => {
  const h = harness(async () => ({
    ok: true,
    results: [{ type: 'movie', id: 1, title: 'Oppenheimer', year: '2023', poster: 'p' }],
    sources: { tmdb: 'ok', anime: 'ok' },
    failed: [],
  }))
  h.sandbox._runVideoTitleSearch('Oppenheimer')
  await settle()
  assert.ok(!/vsearch-note/.test(h.html()), 'nothing to warn about: ' + h.html())
})
