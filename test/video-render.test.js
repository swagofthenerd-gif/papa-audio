'use strict'
// Executes the renderer's pure markup builders for real, rather than asserting
// that certain strings appear in the source. The renderer is one 17k-line file
// that cannot be required outside Electron, so each function is extracted by
// brace-matching and run in a vm context with only the globals it touches.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extract(name) {
  const start = SRC.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found in the renderer')
  let depth = 0
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

function sandbox({ store = null, tab = 'all' } = {}) {
  const ctx = {
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    window: {},
    _videoTab: tab,
    _videoTabs: [{ key: 'all', label: 'All' }, { key: 'movie', label: 'Movies' }],
    _VICON: { play: '<svg/>', plus: '<svg/>', check: '<svg/>', info: '<svg/>', left: '<svg/>', right: '<svg/>', search: '<svg/>' },
    _vStore: () => store,
    console,
  }
  vm.createContext(ctx)
  // The three ratings columns and the credit line are part of the card now, so
  // the sandbox needs them or every card assertion fails on a missing helper
  // rather than on anything real.
  vm.runInContext('const _VRATE_SOURCES = ' + JSON.stringify([
    { key: 'imdb', cls: 'vrate-imdb', src: 'IMDb', max: 10 },
    { key: 'rottenTomatoes', cls: 'vrate-rt', src: 'RT', max: 100 },
    { key: 'metacritic', cls: 'vrate-mc', src: 'MC', max: 100 },
  ]).replace(/}/g, '}') + ';', ctx)
  vm.runInContext(`_VRATE_SOURCES[0].fmt = v => v.toFixed(1)
    _VRATE_SOURCES[1].fmt = v => Math.round(v) + '%'
    _VRATE_SOURCES[2].fmt = v => String(Math.round(v))`, ctx)
  for (const fn of ['_videoCard', '_vHeadHtml', '_vRowShell', '_vRailSkeleton', '_stripTags',
    // _watchKey: the card keys its resume bar the same way the diary stores
    // positions, so the real function runs here rather than a stub of it.
    // _cwIsStale: the card's "resume?" nudge calls it (App §18), so the real
    // predicate runs rather than a stub that could disagree with the tests.
    // The This-week airing shelf card (App §25) shares the card sandbox: it
    // builds the same data-video key and reuses esc, so it is exercised here
    // for real alongside the catalog card.
    '_airingCardHtml', '_airingSubLabel', '_airingWhenLabel',
    '_vRatesHtml', '_vCreditHtml', '_vRuntime', '_watchKey', '_cwIsStale']) {
    vm.runInContext(extract(fn), ctx)
  }
  return ctx
}

function tagsBalanced(html) {
  const open = (html.match(/<(div|article|section|button|span|h1|h2)\b/g) || []).length
  const close = (html.match(/<\/(div|article|section|button|span|h1|h2)>/g) || []).length
  return open === close
}

// AniList scores out of 100, TMDB out of 10. One badge has to mean one thing.
test('ratings from both catalogs normalise to the same 0-10 badge', () => {
  const ctx = sandbox()
  assert.match(ctx._videoCard({ type: 'movie', id: 1, title: 'Dune', rating: 8.36 }), /★ 8\.4/)
  assert.match(ctx._videoCard({ type: 'anime', id: 2, title: 'Frieren', rating: 92 }), /★ 9\.2/)
})

// The This-week airing shelf card (App §25): balanced markup, the detail key,
// and the "Ep N · Weekday" sub-label the shelf promises.
test('an airing shelf card pins its key and shows the Ep-and-weekday line', () => {
  const ctx = sandbox()
  const now = new Date(2026, 8, 10, 12).getTime()   // Thu Sep 10 2026, noon
  const airs = new Date(2026, 8, 11, 20).getTime()  // Fri Sep 11 2026
  const html = ctx._airingCardHtml({ key: 'anime:21', title: 'One Piece', episode: 1089, airsAt: airs }, now)
  assert.match(html, /data-video="anime:21"/)
  assert.match(html, /Ep 1089 · /)
  assert.ok(tagsBalanced(html), 'airing card markup is balanced')
})

test('a zero or missing rating shows no badge rather than a zero', () => {
  const ctx = sandbox()
  assert.ok(!/vbadge-rating/.test(ctx._videoCard({ type: 'movie', id: 1, title: 'X' })))
  assert.ok(!/vbadge-rating/.test(ctx._videoCard({ type: 'movie', id: 1, title: 'X', rating: 0 })))
})

test('the resume bar appears only once something is meaningfully started', () => {
  const ctx = sandbox()
  assert.match(ctx._videoCard({ type: 'tv', id: 3, title: 'X', position: 1800, duration: 3600 }),
    /vcard-progress[\s\S]*?width:50%/)
  assert.ok(!/vcard-progress/.test(ctx._videoCard({ type: 'tv', id: 4, title: 'X', position: 2, duration: 3600 })))
  assert.ok(!/vcard-progress/.test(ctx._videoCard({ type: 'tv', id: 5, title: 'X' })))
})

// Titles and ids come from third-party APIs and are injected via innerHTML.
test('hostile metadata cannot break out of the card markup', () => {
  const ctx = sandbox()
  const html = ctx._videoCard({
    type: 'movie', id: '"><script>x</script>', title: '"><img onerror=alert(1)>', poster: '\'"><b>',
  })
  assert.ok(!/<img onerror/.test(html), 'title escaped')
  assert.ok(!/<script>/.test(html), 'id escaped')
  assert.ok(!/'"><b>/.test(html), 'poster url escaped')
})

test('a missing poster renders the fallback instead of a broken image', () => {
  const ctx = sandbox()
  const html = ctx._videoCard({ type: 'movie', id: 5, title: 'No Art' })
  assert.ok(!/<img/.test(html))
  assert.match(html, /vcard-fallback/)
})

test('every builder emits balanced markup', () => {
  const ctx = sandbox()
  for (const [name, html] of [
    ['card', ctx._videoCard({ type: 'movie', id: 1, title: 'X', poster: 'p.jpg', rating: 7 })],
    ['head', ctx._vHeadHtml()],
    ['shell', ctx._vRowShell('k', 'Label', 3)],
  ]) {
    assert.ok(tagsBalanced(html), name + ' has unbalanced tags')
  }
})

test('a card is announced and operable as a button', () => {
  const html = sandbox()._videoCard({ type: 'movie', id: 1, title: 'Dune' })
  assert.match(html, /role="button"/)
  assert.match(html, /tabindex="0"/)
  assert.match(html, /aria-label="Dune"/)
})

test('the watchlist button reflects stored state', () => {
  const inList = sandbox({ store: { inWatchlist: () => true } })
  const notIn = sandbox({ store: { inWatchlist: () => false } })
  assert.match(inList._videoCard({ type: 'movie', id: 1, title: 'X' }), /vcard-act-list on/)
  assert.match(inList._videoCard({ type: 'movie', id: 1, title: 'X' }), /aria-label="Remove from My List"/)
  assert.ok(!/vcard-act-list on/.test(notIn._videoCard({ type: 'movie', id: 1, title: 'X' })))
})

// The store ships with the engine work; a card must render before it exists.
test('cards render with no watch store loaded', () => {
  const html = sandbox({ store: null })._videoCard({ type: 'movie', id: 1, title: 'X' })
  assert.match(html, /vcard-act-list/)
})

test('a store that throws does not take the card down', () => {
  const ctx = sandbox({ store: { inWatchlist () { throw new Error('corrupt') } } })
  assert.doesNotThrow(() => ctx._videoCard({ type: 'movie', id: 1, title: 'X' }))
})

test('the tab strip is a real tablist with a selected tab', () => {
  const html = sandbox({ tab: 'all' })._vHeadHtml()
  assert.match(html, /role="tablist"/)
  assert.match(html, /aria-selected="true"/)
  assert.match(html, /aria-selected="false"/)
  assert.match(html, /class="vtab active"/)
})

// AniList overviews are HTML fragments; TMDB's are plain text.
test('AniList markup is flattened to text', () => {
  const ctx = sandbox()
  assert.strictEqual(ctx._stripTags('a<br>b <i>c</i>'), 'a b c')
  assert.strictEqual(ctx._stripTags(null), '')
  assert.strictEqual(ctx._stripTags('<p>Only</p>'), 'Only')
})

test('the rail skeleton fills a row width', () => {
  const ctx = sandbox()
  assert.strictEqual((ctx._vRailSkeleton().match(/vskel-card/g) || []).length, 7)
  assert.strictEqual((ctx._vRailSkeleton(3).match(/vskel-card/g) || []).length, 3)
})

test('the row shell carries the rail and both arrows', () => {
  const html = sandbox()._vRowShell('trending-movies', 'Trending Movies', 12)
  assert.match(html, /data-rail="trending-movies"/)
  assert.match(html, /vrail-prev[\s\S]*aria-label="Scroll left"/)
  assert.match(html, /vrail-next[\s\S]*aria-label="Scroll right"/)
  assert.match(html, /hidden/, 'arrows start hidden until scroll position is known')
})

// ── Episode grid windowing ──────────────────────────────────────────────────
// The anime grid renders one window of buttons rather than two thousand at
// once; the maths that picks the window is pure and runs here for real.
function windowCtx() {
  const ctx = { console }
  vm.createContext(ctx)
  vm.runInContext('var _EP_WINDOW = 120', ctx)
  for (const fn of ['_epWindowOf', '_epRangeJumperHtml']) vm.runInContext(extract(fn), ctx)
  return ctx
}

test('the window size in the source is the one these tests assume', () => {
  assert.match(SRC, /var _EP_WINDOW = 120\b/)
})

test('the default window holds the current episode', () => {
  const ctx = windowCtx()
  assert.deepStrictEqual({ ...ctx._epWindowOf(2000, 1) }, { start: 1, end: 120 })
  assert.deepStrictEqual({ ...ctx._epWindowOf(2000, 120) }, { start: 1, end: 120 })
  assert.deepStrictEqual({ ...ctx._epWindowOf(2000, 121) }, { start: 121, end: 240 })
  assert.deepStrictEqual({ ...ctx._epWindowOf(2000, 2000) }, { start: 1921, end: 2000 })
})

test('a short run is one window and gets no jumper', () => {
  const ctx = windowCtx()
  assert.deepStrictEqual({ ...ctx._epWindowOf(24, 12) }, { start: 1, end: 24 })
  assert.strictEqual(ctx._epRangeJumperHtml(24, { start: 1, end: 24 }), '')
})

test('an out-of-range episode still lands in a real window', () => {
  const ctx = windowCtx()
  assert.deepStrictEqual({ ...ctx._epWindowOf(300, 0) }, { start: 1, end: 120 })
  assert.deepStrictEqual({ ...ctx._epWindowOf(300, null) }, { start: 1, end: 120 })
  assert.deepStrictEqual({ ...ctx._epWindowOf(300, 9999) }, { start: 241, end: 300 })
})

test('the jumper names every range, marks the open one, and offers Show all', () => {
  const html = windowCtx()._epRangeJumperHtml(300, { start: 121, end: 240 })
  assert.match(html, /data-ep-start="1"[^>]*>1–120</)
  assert.match(html, / on" data-ep-start="121"/)
  assert.match(html, /data-ep-start="241"[^>]*>241–300</)
  assert.match(html, /data-ep-all="1"[^>]*>Show all 300</)
})

test('showing all lights the Show all control, not a range', () => {
  const html = windowCtx()._epRangeJumperHtml(300, { start: 1, end: 300 })
  assert.doesNotMatch(html, / on" data-ep-start=/)
  assert.match(html, /vep-range-all on"/)
})

test('the anime controls render the grid through the window, not all at once', () => {
  const controls = extract('_renderVideoControls')
  assert.match(controls, /paintWindow\(_epWindowOf\(total, _videoState\.episode\)\)/)
  assert.match(controls, /data-ep-start\],\[data-ep-all/)
})

// ── My List sorting and the watched filter ──────────────────────────────────
function extractConst(name) {
  const start = SRC.indexOf('const ' + name + ' = [')
  assert.ok(start > -1, name + ' not found in the renderer')
  const open = SRC.indexOf('[', start)
  let depth = 0
  for (let j = open; j < SRC.length; j++) {
    if (SRC[j] === '[') depth++
    else if (SRC[j] === ']') { depth--; if (!depth) return SRC.slice(start, j + 1) }
  }
  throw new Error('unbalanced brackets in ' + name)
}

function myListCtx(seenKeys) {
  const seen = new Set(seenKeys || [])
  const ctx = {
    console,
    window: { PapaTasteStore: { hasSeen: k => seen.has(k) } },
    esc: s => String(s == null ? '' : s),
  }
  vm.createContext(ctx)
  vm.runInContext(extractConst('_MYLIST_SORTS'), ctx)
  vm.runInContext(extractConst('_MYLIST_WATCHED'), ctx)
  for (const fn of ['_cardKey', '_vNullsLast', '_vSortItems', '_myListApply', '_myListChipsHtml']) {
    vm.runInContext(extract(fn), ctx)
  }
  return ctx
}

const mlList = [
  { type: 'movie', id: 1, title: 'B film', year: 2001, rating: 6, addedAt: 10 },
  { type: 'tv', id: 2, title: 'A show', year: 2020, rating: 9, addedAt: 30 },
  { type: 'movie', id: 3, title: 'C film', year: null, rating: null, addedAt: 20 },
]

test('Added puts the newest addition first', () => {
  const out = myListCtx()._myListApply(mlList, { sort: 'added', watched: 'all' })
  assert.deepStrictEqual([...out.shown].map(i => i.id), [2, 3, 1])
  assert.strictEqual(out.hidden, 0)
})

test('the watched filter uses the diary’s word for watched', () => {
  const ctx = myListCtx(['movie:1'])
  const watched = ctx._myListApply(mlList, { sort: 'added', watched: 'watched' })
  assert.deepStrictEqual([...watched.shown].map(i => i.id), [1])
  assert.strictEqual(watched.hidden, 2)
  const un = ctx._myListApply(mlList, { sort: 'added', watched: 'unwatched' })
  assert.deepStrictEqual([...un.shown].map(i => i.id), [2, 3])
})

test('Year and Rating sort what has the field and keep the rest last', () => {
  const ctx = myListCtx()
  assert.deepStrictEqual(
    [...ctx._myListApply(mlList, { sort: 'newest', watched: 'all' }).shown].map(i => i.id),
    [2, 1, 3], 'no year sorts last, not as year zero')
  assert.deepStrictEqual(
    [...ctx._myListApply(mlList, { sort: 'rating', watched: 'all' }).shown].map(i => i.id),
    [2, 1, 3])
})

test('the chips mark the active sort and filter', () => {
  const html = myListCtx()._myListChipsHtml({ sort: 'title', watched: 'unwatched' })
  assert.match(html, / on" data-mylist-sort="title" aria-pressed="true"/)
  assert.match(html, / on" data-mylist-watched="unwatched" aria-pressed="true"/)
  assert.match(html, /data-mylist-sort="added" aria-pressed="false"/)
})

test('the list view is a grid with a persisted preference, not a rail', () => {
  const render = extract('_renderMyList')
  assert.match(render, /vmylist-grid/)
  assert.doesNotMatch(render, /_vRowShell\('mylist'/)
  assert.match(render, /_writeMyListPref\(next\)/)
  assert.match(extract('_writeMyListPref'), /PapaLocal\.write\(_MYLIST_PREF_KEY/)
  assert.match(SRC, /const _MYLIST_PREF_KEY = 'papaMyListSort'/)
})

// ── Hero rotation ───────────────────────────────────────────────────────────
test('the hero declines to advance while hovered or focused', () => {
  const start = extract('_startVideoHero')
  assert.match(start, /if \(_videoHero\.paused\) return/)
  const bind = extract('_bindHeroPause')
  assert.match(bind, /pointerenter/)
  assert.match(bind, /focusin/)
  assert.match(bind, /contains\(e\.relatedTarget\)/, 'focus moving between hero buttons must not resume')
})

test('painting the same feature again does not rebuild the hero', () => {
  const paint = extract('_paintVideoHero')
  assert.match(paint, /dataset\.heroKey === key && mount\.querySelector\('\.vhero-title'\)/)
  assert.match(paint, /dataset\.heroKey = key/)
})

// ── Person page header ──────────────────────────────────────────────────────
test('the filmography heads itself from the catalog, with the click as a hint', () => {
  const render = extract('renderPerson')
  assert.match(render, /credits\.person && credits\.person\.name\) \? credits\.person : hint/)
  assert.match(render, /vperson-bio/)
  // The instant paint still uses what the clicked credit carried.
  assert.match(render, /_personName\(personId\)/)
})

// ── Genre chips on enriched card credit (App §30) ───────────────────────────
// The credit line grows genre chips when enrichment supplies them, and they
// carry the same data-genre-jump the detail-page chips do so the one delegated
// handler takes both to Browse.
function creditCtx() {
  const ctx = {
    console,
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  }
  vm.createContext(ctx)
  for (const fn of ['_vCreditHtml', '_vCardGenresHtml', '_vRuntime']) vm.runInContext(extract(fn), ctx)
  return ctx
}

test('a card with no enriched genres renders exactly the old credit line', () => {
  const html = creditCtx()._vCreditHtml({ directors: ['Denis Villeneuve'], runtime: 155 })
  assert.doesNotMatch(html, /vcard-genres/)
  assert.match(html, /Denis Villeneuve/)
})

test('enriched genres render as jump chips carrying the display name', () => {
  const html = creditCtx()._vCreditHtml({ directors: ['X'], genres: ['Horror', 'Thriller'] })
  assert.match(html, /vcard-genres/)
  assert.match(html, /data-genre-jump="Horror"[^>]*>Horror</)
  assert.match(html, /data-genre-jump="Thriller"[^>]*>Thriller</)
  // The same class the detail page uses, so one CSS rule and one handler cover both.
  assert.match(html, /video-genre-chip vcard-genre-chip/)
})

test('genre chips are capped at three so a card does not grow a second row', () => {
  const html = creditCtx()._vCardGenresHtml(['A', 'B', 'C', 'D', 'E'])
  assert.strictEqual((html.match(/data-genre-jump/g) || []).length, 3)
})

test('genre objects with a name field are accepted, nameless ones are dropped', () => {
  const ctx = creditCtx()
  assert.match(ctx._vCardGenresHtml([{ name: 'Action' }]), /data-genre-jump="Action"/)
  assert.strictEqual(ctx._vCardGenresHtml([{ id: 5 }]), '')
  assert.strictEqual(ctx._vCardGenresHtml([]), '')
  assert.strictEqual(ctx._vCardGenresHtml(null), '')
})

test('a hostile genre name cannot break out of the chip', () => {
  const html = creditCtx()._vCardGenresHtml(['"><img onerror=alert(1)>'])
  assert.doesNotMatch(html, /<img onerror/)
})

test('the enriched credit meta on main carries genre names', () => {
  // main.js passes genres through additively; the renderer only renders what
  // it is handed, so this guards the source of the data.
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const at = MAIN.indexOf("ipcMain.handle('video-enrich'")
  assert.ok(at > 0, 'found the enrich handler')
  const block = MAIN.slice(at, at + 1400)
  assert.match(block, /genres:/, 'the enrich meta carries genres')
})

test('the delegated genre handler derives the catalog from the card it sits in', () => {
  const bind = extract('_bindGlobalGenreJumps')
  // A TV chip must jump into the TV catalog, not movie — read off the card.
  assert.match(bind, /card\.dataset\.video[\s\S]*split\(':'\)/)
  assert.match(bind, /_jumpToGenre\(chip\.dataset\.genreJump, type\)/)
  // It must stop the card underneath from also opening its detail page.
  assert.match(bind, /stopPropagation/)
  // And be installed once.
  assert.match(bind, /if \(_genreJumpsBound\) return/)
})

test('the card click ignores a genre-chip click so it does not also open detail', () => {
  const bind = extract('_bindVideoCards')
  assert.match(bind, /closest\('\[data-genre-jump\]'\)\) return/)
})

// ── Detail page shows your history (App §29) ────────────────────────────────
function historyCtx(store) {
  const ctx = {
    console,
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    window: { PapaTasteStore: store || null },
  }
  vm.createContext(ctx)
  for (const fn of ['_watchHistoryLineHtml', '_watchDateLabel']) vm.runInContext(extract(fn), ctx)
  return ctx
}

test('no history line when nothing is logged or rated', () => {
  const store = { viewingsOf: () => [], ratingOf: () => null, hasSeen: () => false }
  assert.strictEqual(historyCtx(store)._watchHistoryLineHtml({ type: 'movie', id: 1 }), '')
})

test('no history line when the store is absent', () => {
  assert.strictEqual(historyCtx(null)._watchHistoryLineHtml({ type: 'movie', id: 1 }), '')
})

test('a logged viewing shows the date, newest sitting winning', () => {
  const store = {
    viewingsOf: () => [{ date: '2024-01-05' }, { date: '2024-03-12' }, { date: '2023-11-01' }],
    ratingOf: () => null, hasSeen: () => true,
  }
  const html = historyCtx(store)._watchHistoryLineHtml({ type: 'movie', id: 27205 })
  assert.match(html, /You watched this on/)
  assert.match(html, /2024|March/, 'the latest date drives the line')
  assert.doesNotMatch(html, /rated/)
})

test('a rating shows as a star, whole numbers without a decimal', () => {
  const four = { viewingsOf: () => [], ratingOf: () => 4, hasSeen: () => true }
  assert.match(historyCtx(four)._watchHistoryLineHtml({ type: 'movie', id: 1 }), /rated ★4\b/)
  const half = { viewingsOf: () => [], ratingOf: () => 4.5, hasSeen: () => true }
  assert.match(historyCtx(half)._watchHistoryLineHtml({ type: 'movie', id: 1 }), /rated ★4\.5/)
})

test('a rating with no viewing still produces a line', () => {
  const store = { viewingsOf: () => [], ratingOf: () => 5, hasSeen: () => false }
  const html = historyCtx(store)._watchHistoryLineHtml({ type: 'movie', id: 1 })
  assert.match(html, /rated ★5/)
})

test('a store that throws takes down the line, not the page', () => {
  const store = { viewingsOf () { throw new Error('corrupt') }, ratingOf: () => null, hasSeen: () => true }
  assert.doesNotThrow(() => historyCtx(store)._watchHistoryLineHtml({ type: 'movie', id: 1 }))
  assert.strictEqual(historyCtx(store)._watchHistoryLineHtml({ type: 'movie', id: 1 }), '')
})

test('the date label formats an ISO date and falls back to the raw string', () => {
  const ctx = historyCtx(null)
  assert.match(ctx._watchDateLabel('2024-03-12'), /2024/)
  assert.strictEqual(ctx._watchDateLabel('not a date'), 'not a date')
})

test('the detail shell places the history line under the meta', () => {
  const shell = extract('_videoDetailShell')
  assert.match(shell, /video-detail-meta[\s\S]*_watchHistoryLineHtml\(d\)/)
})

// ── App #71: Find soundtrack ─────────────────────────────────────────────────
test('the detail hero offers a Find soundtrack button', () => {
  const shell = extract('_videoDetailShell')
  assert.match(shell, /id="vdet-soundtrack"/)
  assert.match(shell, /Find soundtrack/)
})

test('the soundtrack button navigates to the music search with the built query', () => {
  const bind = extract('_bindDetailActions')
  assert.match(bind, /getElementById\('vdet-soundtrack'\)/)
  // It goes through the shared music search navigation, not a bespoke path.
  assert.match(bind, /navigate\('search', q\)/)
  // And the query comes from the tested helper, with a bare-title fallback.
  assert.match(bind, /soundtrackQuery\(d\.title\)/)
})

// ── TV episode grid windowing (App §28) ─────────────────────────────────────
// A single TV season TMDB files large (a daily soap, or One Piece reaching the
// TV path) windows exactly as the anime grid does. The grid painter is pure
// enough to run against a fake DOM.
function tvGridCtx() {
  const created = []
  function fakeEl() {
    return {
      innerHTML: '', children: [], _html: '',
      set innerHTML (v) { this._html = v },
      get innerHTML () { return this._html },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
    }
  }
  const ctx = {
    console,
    _EP_WINDOW: 120,
    _videoState: { episode: 1, season: 1 },
    esc: s => String(s == null ? '' : s),
    document: { getElementById: () => { const e = fakeEl(); created.push(e); return e } },
  }
  vm.createContext(ctx)
  for (const fn of ['_tvEpRenderGrid', '_epButton', '_epWindowOf', '_epRangeJumperHtml', '_epMark']) {
    vm.runInContext(extract(fn), ctx)
  }
  ctx.__created = created
  return ctx
}

test('a small TV season paints every episode and gets no jumper', () => {
  const ctx = tvGridCtx()
  const target = { _html: '', set innerHTML (v) { this._html = v }, get innerHTML () { return this._html }, querySelector: () => null }
  const eps = []
  for (let i = 1; i <= 24; i++) eps.push({ episodeNumber: i, name: 'Ep ' + i })
  ctx._tvEpRenderGrid(target, eps, { items: {} }, 24, () => {})
  assert.doesNotMatch(target.innerHTML, /vep-ranges/, 'no jumper for a short season')
  assert.doesNotMatch(target.innerHTML, /video-episode-wrap/)
})

test('a large TV season is wrapped and carries the range jumper', () => {
  const ctx = tvGridCtx()
  const target = { _html: '', set innerHTML (v) { this._html = v }, get innerHTML () { return this._html }, querySelector: () => ({ addEventListener: () => {} }) }
  const eps = []
  for (let i = 1; i <= 300; i++) eps.push({ episodeNumber: i, name: 'Ep ' + i })
  ctx._tvEpRenderGrid(target, eps, { items: {} }, 300, () => {})
  assert.match(target.innerHTML, /video-episode-wrap/)
  assert.match(target.innerHTML, /vep-ranges/)
  assert.match(target.innerHTML, /video-episode-list-inner/)
})

test('the TV refresh routes a large season through the windowing painter', () => {
  const fn = extract('_refreshTvEpisodes')
  assert.match(fn, /_tvEpRenderGrid\(target, episodes, prog, top, setEp\)/)
  // The top episode number, not the count, is what the range maths windows over.
  assert.match(fn, /Math\.max\.apply\(null, numbers\)/)
})

test('the window painter shows only the episodes in the open range', () => {
  const grid = extract('_tvEpRenderGrid')
  assert.match(grid, /ep\.episodeNumber >= win\.start && ep\.episodeNumber <= win\.end/)
  // And the jumper survives its own outerHTML repaint via delegation on the wrap.
  assert.match(grid, /video-episode-wrap[\s\S]*data-ep-start\],\[data-ep-all/)
})

// ── Predownload the next episode (App §44) ──────────────────────────────────
function predlCtx(api) {
  const ctx = {
    console,
    _VICON: { check: '<svg/>', plus: '<svg/>' },
    _packFiles: [],
    _videoDetail: { type: 'tv' },
    _videoState: { season: 1, episode: 1 },
    window: { api: api || {} },
  }
  vm.createContext(ctx)
  for (const fn of ['_nextEpisodePackFile', '_predownloadAvailable', '_nextEpisodeOf']) {
    vm.runInContext(extract(fn), ctx)
  }
  return ctx
}

test('the next episode pack file is matched by episode number', () => {
  const ctx = predlCtx({ videoPredownload: () => {} })
  ctx._packFiles = [
    { index: 0, episode: 1, current: true },
    { index: 1, episode: 2 },
    { index: 2, episode: 3 },
  ]
  ctx._videoDetail = { type: 'tv', d: { seasons: [{ seasonNumber: 1, episodes: [{ episodeNumber: 1 }, { episodeNumber: 2 }, { episodeNumber: 3 }] }] } }
  ctx._videoState = { season: 1, episode: 1 }
  const f = ctx._nextEpisodePackFile()
  assert.ok(f)
  assert.strictEqual(f.index, 1)
  assert.strictEqual(f.episode, 2)
})

test('no pack, no file — the whole surface no-ops', () => {
  const ctx = predlCtx({ videoPredownload: () => {} })
  ctx._packFiles = []
  assert.strictEqual(ctx._nextEpisodePackFile(), null)
  assert.strictEqual(ctx._predownloadAvailable(), false)
})

test('the surface is unavailable when the IPC is not wired, even with a pack', () => {
  const ctx = predlCtx({})   // no videoPredownload
  ctx._packFiles = [{ index: 0, episode: 1 }, { index: 1, episode: 2 }]
  ctx._videoDetail = { type: 'tv', d: { seasons: [{ seasonNumber: 1, episodes: [{ episodeNumber: 1 }, { episodeNumber: 2 }] }] } }
  ctx._videoState = { season: 1, episode: 1 }
  assert.strictEqual(ctx._predownloadAvailable(), false, 'no IPC means no control')
})

test('a movie has no next episode to predownload', () => {
  const ctx = predlCtx({ videoPredownload: () => {} })
  ctx._packFiles = [{ index: 0, episode: 1 }]
  ctx._videoDetail = { type: 'movie', d: {} }
  assert.strictEqual(ctx._nextEpisodePackFile(), null)
})

test('predownload progress is polled every two seconds and stops itself', () => {
  const poll = extract('_startPredownloadPoll')
  assert.match(poll, /setInterval\(tick, 2000\)/)
  assert.match(poll, /videoPredownloadProgress/)
  const stop = extract('_stopPredownloadPoll')
  assert.match(stop, /clearInterval/)
})

test('predownload is built defensively against a missing IPC', () => {
  const start = extract('_startPredownloadNext')
  assert.match(start, /typeof window\.api\.videoPredownload !== 'function'/)
})

// ── Up Next plays the pack, not a fresh source (App §40) ────────────────────
// The pure decision: given the pack's file list and the target episode, is the
// next episode already inside the torrent being streamed?
function packDecisionCtx() {
  const ctx = { console }
  vm.createContext(ctx)
  vm.runInContext(extract('_packFileForEpisode'), ctx)
  return ctx
}

test('pack contains the next episode → the in-torrent file is returned', () => {
  const ctx = packDecisionCtx()
  const files = [
    { index: 0, episode: 1, current: true },
    { index: 1, episode: 2 },
    { index: 2, episode: 3 },
  ]
  const f = ctx._packFileForEpisode(files, { season: null, episode: 2 })
  assert.ok(f)
  assert.strictEqual(f.index, 1)
  assert.strictEqual(f.episode, 2)
})

test('pack lacks the next episode → null, so the caller resolves from scratch', () => {
  const ctx = packDecisionCtx()
  // A single-file torrent, or the season finale: episode 4 is not in the pack.
  assert.strictEqual(
    ctx._packFileForEpisode([{ index: 0, episode: 3, current: true }], { season: null, episode: 4 }),
    null
  )
  // No pack at all.
  assert.strictEqual(ctx._packFileForEpisode([], { season: null, episode: 2 }), null)
  // No target.
  assert.strictEqual(ctx._packFileForEpisode([{ index: 0, episode: 1 }], null), null)
})

test('a pack file without an in-torrent index is not a switch target', () => {
  const ctx = packDecisionCtx()
  assert.strictEqual(
    ctx._packFileForEpisode([{ episode: 2 }], { season: null, episode: 2 }),
    null
  )
})

test('Up Next advances within the pack instead of re-resolving sources', () => {
  const next = extract('_playNextEpisode')
  // Same-season next episode present in the pack → switch within the torrent.
  assert.match(next, /_packFileForEpisode\(_packFiles, next\)/)
  assert.match(next, /_switchPackEpisode\(packFile\.index, \{ fromAdvance: true \}\)/)
  // In-season only: anime (season null) or a TV advance whose season still
  // equals the one being watched. A boundary roll skips the pack and takes the
  // resolve-from-scratch path, which carries the new season.
  assert.match(next, /const sameSeason = next\.season == null \|\| next\.season === _videoState\.season/)
  assert.match(next, /sameSeason \? _packFileForEpisode\(_packFiles, next\) : null/)
  // The fallback still exists for when the pack does not carry the next episode.
  assert.match(next, /window\.api\.videoStreams\(_videoStreamRequest\(\)\)/)
})

test('an in-pack advance plays from 0 and suppresses the stale resume prompt', () => {
  const sw = extract('_switchPackEpisode')
  // fromAdvance marks the play an advance: autoAdvanced short-circuits
  // _offerResume, resumed stays true so no resume seek is queued.
  assert.match(sw, /autoAdvanced: opts\.fromAdvance === true/)
  assert.match(sw, /resumed: opts\.fromAdvance !== true \? false : true/)
  // A manual strip click (no fromAdvance) leaves resumed false so the wave-2
  // rule lets _offerResume make its offer.
  const offer = extract('_offerResume')
  assert.match(offer, /if \(_watch\.autoAdvanced\) return/)
})

test('a completed predownload shows a ready-offline state', () => {
  const paint = extract('_paintPredownloadControl')
  assert.match(paint, /ready offline/i)
  assert.match(paint, /Downloading next episode/)
})

// ── Start over on resume (Player §17) ───────────────────────────────────────
test('the resume offer carries a Start over action, not just text', () => {
  const offer = extract('_offerResume')
  assert.match(offer, /showActionToast\('Resuming from ' \+ label, 'Start over'/)
  // Auto-resume stays the default: the pending seek is still queued.
  assert.match(offer, /_watch\.pendingResume = pos/)
})

test('Start over cancels the pending resume and seeks to zero', () => {
  const fn = extract('_startOver')
  assert.match(fn, /_watch\.pendingResume = null/)
  assert.match(fn, /seek.*seconds: 0.*absolute/)
})

test('the action toast pushes onto the stack with a button (App §82)', () => {
  // Toasts stack now (up to three, oldest evicted); the single #toast-notification
  // element that overwrote itself is gone. showActionToast is a thin wrapper over
  // _pushToast that supplies the action label and callback.
  const fn = extract('showActionToast')
  assert.match(fn, /_pushToast/)
  assert.match(fn, /actionLabel/)
  const push = extract('_pushToast')
  assert.match(push, /createElement\('button'\)/)
  assert.match(push, /has-action/)
  // The plain toast is also just a _pushToast call — no per-element mutation to
  // strip, because each toast is its own node.
  assert.match(extract('showToast'), /_pushToast/)
})

// ── Card context menu (App §83) ─────────────────────────────────────────────
test('the card context menu offers the four documented actions', () => {
  const fn = extract('_openVideoCardMenu')
  assert.match(fn, /label: 'Play'/)
  assert.match(fn, /'Go to details'/)
  assert.match(fn, /Add to My List|Remove from My List/)
  assert.match(fn, /Mark watched/)
})

test('the context menu is one delegated listener behind a run-once guard', () => {
  const fn = extract('_bindVideoCardContextMenu')
  assert.match(fn, /if \(_vCtxBound\) return/)
  assert.match(fn, /addEventListener\('contextmenu'/)
})

test('Shift+F10 opens the menu from a focused card, off the global budget', () => {
  // Handled in the per-card keydown, not a document listener, so it adds nothing
  // to the global-listener budget the soak probe polices.
  const bind = extract('_bindVideoCards')
  assert.match(bind, /e\.key === 'F10' && e\.shiftKey/)
  assert.match(bind, /_openVideoCardMenuAtCard/)
})

test('the menu dismisses on outside click, scroll, and Escape', () => {
  const open = extract('_openVideoCardMenu')
  assert.match(open, /addEventListener\('click', _vCtxDismiss/)
  assert.match(open, /addEventListener\('scroll', _vCtxDismiss/)
  assert.match(open, /e\.key === 'Escape'/)
  const close = extract('_closeVideoCardMenu')
  assert.match(close, /removeEventListener\('click', _vCtxDismiss/)
  assert.match(close, /removeEventListener\('scroll', _vCtxDismiss/)
})

// ── Search-result filters + typo tolerance (App §20, §21) ───────────────────
// The pure helpers run for real in a vm; the wiring is pinned by reading the
// source, the same split the rest of this file uses.
function searchSandbox() {
  const ctx = {
    esc: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    console,
  }
  vm.createContext(ctx)
  // _vSearchFilter is the mutable state the filter-bar builder reads for the
  // active chip; the tests set it before each build.
  vm.runInContext('var _vSearchFilter = { results: [], type: "all", decade: "all" }', ctx)
  vm.runInContext('const _VSEARCH_TYPE_CHIPS = ' + JSON.stringify([
    { key: 'all', label: 'All' }, { key: 'movie', label: 'Films' },
    { key: 'tv', label: 'Series' }, { key: 'anime', label: 'Anime' },
  ]) + ';', ctx)
  for (const fn of ['_simplifyVideoQuery', '_videoDecadeLabel', '_videoResultDecades',
    '_filterVideoResults', '_vSearchFilterBarHtml']) {
    vm.runInContext(extract(fn), ctx)
  }
  return ctx
}

test('simplify-query strips diacritics, punctuation, and collapsed spaces', () => {
  const ctx = searchSandbox()
  assert.strictEqual(ctx._simplifyVideoQuery('Amélie'), 'Amelie')
  assert.strictEqual(ctx._simplifyVideoQuery('Spider-Man: Homecoming'), 'Spider Man Homecoming')
  assert.strictEqual(ctx._simplifyVideoQuery('  the   matrix  '), 'the matrix')
  // A pun-free query with nothing to strip is returned unchanged, so the caller
  // can tell a no-op simplification apart and skip the retry.
  assert.strictEqual(ctx._simplifyVideoQuery('dune'), 'dune')
})

test('simplify-query is null-safe and empty-safe', () => {
  const ctx = searchSandbox()
  assert.strictEqual(ctx._simplifyVideoQuery(null), '')
  assert.strictEqual(ctx._simplifyVideoQuery(''), '')
  assert.strictEqual(ctx._simplifyVideoQuery('!!!'), '')
})

test('decade label buckets a year and rejects a non-year', () => {
  const ctx = searchSandbox()
  assert.strictEqual(ctx._videoDecadeLabel(1994), '1990s')
  assert.strictEqual(ctx._videoDecadeLabel(2001), '2000s')
  assert.strictEqual(ctx._videoDecadeLabel('2019-05-01'), '2010s')
  assert.strictEqual(ctx._videoDecadeLabel(null), null)
  assert.strictEqual(ctx._videoDecadeLabel(''), null)
  assert.strictEqual(ctx._videoDecadeLabel('n/a'), null)
})

test('result decades are the ones present, newest first, deduped', () => {
  const ctx = searchSandbox()
  const decades = ctx._videoResultDecades([
    { year: 1994 }, { year: 1999 }, { year: 2001 }, { year: null }, { year: 2020 }, { year: 2021 },
  ])
  assert.deepStrictEqual([...decades], ['2020s', '2000s', '1990s'])
})

test('filtering by type and decade narrows the fetched set', () => {
  const ctx = searchSandbox()
  const results = [
    { type: 'movie', year: 1994, id: 1 },
    { type: 'tv', year: 1999, id: 2 },
    { type: 'movie', year: 2001, id: 3 },
    { type: 'anime', year: 1995, id: 4 },
  ]
  assert.deepStrictEqual(ctx._filterVideoResults(results, 'movie', 'all').map(r => r.id), [1, 3])
  assert.deepStrictEqual(ctx._filterVideoResults(results, 'all', '1990s').map(r => r.id), [1, 2, 4])
  assert.deepStrictEqual(ctx._filterVideoResults(results, 'movie', '1990s').map(r => r.id), [1])
  assert.deepStrictEqual(ctx._filterVideoResults(results, 'all', 'all').map(r => r.id), [1, 2, 3, 4])
})

test('the filter bar drops type chips a one-kind set cannot use', () => {
  const ctx = searchSandbox()
  // One kind → no type chips, but a decade dropdown if there is more than one.
  const oneKind = ctx._vSearchFilterBarHtml([{ type: 'movie', year: 1994 }, { type: 'movie', year: 2004 }])
  assert.doesNotMatch(oneKind, /vsfilter-types/)
  assert.match(oneKind, /vsfilter-decade/)
  // Mixed kinds → the type chips appear, and only for kinds that are present.
  const mixed = ctx._vSearchFilterBarHtml([{ type: 'movie', year: 1994 }, { type: 'tv', year: 2004 }])
  assert.match(mixed, /data-vsfilter-type="movie"/)
  assert.match(mixed, /data-vsfilter-type="tv"/)
  assert.doesNotMatch(mixed, /data-vsfilter-type="anime"/)
})

test('the active type chip carries aria-pressed and the active class', () => {
  const ctx = searchSandbox()
  ctx._vSearchFilter.type = 'tv'
  const html = ctx._vSearchFilterBarHtml([{ type: 'movie', year: 1994 }, { type: 'tv', year: 2004 }])
  assert.match(html, /class="vsfilter-chip active" data-vsfilter-type="tv" aria-pressed="true"/)
})

test('a single decade offers no dropdown — there is nothing to narrow', () => {
  const ctx = searchSandbox()
  const html = ctx._vSearchFilterBarHtml([{ type: 'movie', year: 1994 }, { type: 'tv', year: 1996 }])
  assert.doesNotMatch(html, /vsfilter-decade/)
})

test('the title search resets the filter state on every new query', () => {
  const src = extract('_runVideoTitleSearch')
  // query is carried so a later result click can commit it to history
  // (audit #3: history is committed on click, not per keystroke).
  // …and the parsed intent behind the query (R11), computed fresh each time.
  assert.match(src, /_vSearchFilter = \{ results: \[\], type: 'all', decade: 'all', query: query, intent: _searchIntent\(query\) \}/)
})

test('a zero-result search retries once with a simplified query, only if it differs', () => {
  const src = extract('_runVideoTitleSearch')
  assert.match(src, /_simplifyVideoQuery\(query\)/)
  assert.match(src, /simplified && simplified !== query/)
  assert.match(src, /_retryVideoTitleSearch\(query, simplified, ticket\)/)
})

test('the retry paints under a "Showing results for" line and never loops', () => {
  const src = extract('_retryVideoTitleSearch')
  // One videoSearch call, no further simplification — the retry is terminal.
  assert.match(src, /videoSearch\(\{ query: simplified/)
  assert.doesNotMatch(src, /_simplifyVideoQuery/)
  assert.match(src, /Showing results for/)
  // A second miss falls back to the original query's empty state.
  assert.match(src, /_vSearchEmptyHtml\(original\)/)
})

test('the filter chips repaint the results with no fetch', () => {
  const bind = extract('_bindVideoSearchFilters')
  assert.match(bind, /data-vsfilter-type/)
  assert.match(bind, /_paintVideoSearchResults\(\)/)
  assert.match(bind, /vsfilter-decade-select/)
  // The painter is the one that maps state → grids, and it must not fetch.
  const paint = extract('_paintVideoSearchResults')
  assert.doesNotMatch(paint, /videoSearch/)
  assert.match(paint, /_filterVideoResults/)
})

// ── Person filmography filter (App §20b) ────────────────────────────────────
test('the credit filter narrows by title substring, accent-insensitively', () => {
  const ctx = searchSandbox()
  vm.runInContext(extract('_filterPersonCredits'), ctx)
  const credits = [
    { title: 'Amélie', type: 'movie' },
    { title: 'The Fabulous Destiny', type: 'movie' },
    { name: 'A Very Long Engagement', type: 'movie' },
  ]
  assert.deepStrictEqual(ctx._filterPersonCredits(credits, 'amelie').map(c => c.title), ['Amélie'])
  assert.deepStrictEqual(ctx._filterPersonCredits(credits, 'engagement').map(c => c.name), ['A Very Long Engagement'])
  // An empty needle is everything, not nothing.
  assert.strictEqual(ctx._filterPersonCredits(credits, '').length, 3)
  assert.strictEqual(ctx._filterPersonCredits(credits, '   ').length, 3)
})

test('the person filter box repaints only the grids, keeping focus and value', () => {
  const paint = extract('_paintPersonRows')
  // The input carries its current value back so a repaint does not blank it.
  assert.match(paint, /value="' \+ esc\(_person\.filter\)/)
  // Typing repaints the grids only — the full paint that would discard the
  // input is reserved for the sort control.
  assert.match(paint, /_person\.filter = this\.value/)
  assert.match(paint, /_paintPersonGrids\(\)/)
  const grids = extract('_paintPersonGrids')
  assert.match(grids, /_filterPersonCredits/)
  assert.doesNotMatch(grids, /videoPerson/)
})

// ── Hero trailer autoplay (App §15) ─────────────────────────────────────────
test('the hero trailer reuses the card trailer pipeline, gated on the same pref', () => {
  const start = extract('_startHeroTrailer')
  // Same IPC the cards call, same shared <video> factory.
  assert.match(start, /window\.api\.videoTrailerUrl/)
  assert.match(start, /_makeTrailerVideo\(res\.url, 'vhero-trailer'\)/)
  const allowed = extract('_heroTrailerAllowed')
  assert.match(allowed, /_hoverTrailersOn/)
  assert.match(allowed, /_prefersReducedMotion/)
})

test('reduced-motion skips the hero trailer entirely', () => {
  const allowed = extract('_heroTrailerAllowed')
  // The gate returns false under reduced motion, so nothing is ever armed.
  assert.match(allowed, /if \(_prefersReducedMotion\(\)\) return false/)
})

test('the hero trailer dwell is three seconds and armed on pointer-enter', () => {
  assert.match(extract('_armHeroTrailer'), /setTimeout\(_startHeroTrailer, HERO_TRAILER_DWELL_MS\)/)
  assert.match(SRC, /HERO_TRAILER_DWELL_MS = 3000/)
  const bind = extract('_bindHeroPause')
  assert.match(bind, /_armHeroTrailer\(\)/)
  // Touch is a tap on its way to opening the film, not a hover.
  assert.match(bind, /pointerType === 'touch'/)
})

test('pointer-leave, rotation, and stop all tear the hero trailer down', () => {
  // Pointer-leave stops it.
  assert.match(extract('_bindHeroPause'), /_stopHeroTrailer\(\)/)
  // A rotation to a new feature stops it before rebuilding the backdrop.
  assert.match(extract('_paintVideoHero'), /_stopHeroTrailer\(\)/)
  // Stopping the whole hero (a page change) stops the trailer too.
  assert.match(extract('_stopVideoHero'), /_stopHeroTrailer\(\)/)
})

test('stopping the hero trailer drops the source, not just the element', () => {
  const stop = extract('_stopHeroTrailer')
  assert.match(stop, /removeAttribute\('src'\)/)
  assert.match(stop, /\.load\(\)/)
  assert.match(stop, /is-hero-previewing/)
})

test('the shared trailer factory builds a muted, looping, hidden video', () => {
  const ctx = { document: { createElement: () => ({ setAttribute() {} }) } }
  vm.createContext(ctx)
  vm.runInContext(extract('_makeTrailerVideo'), ctx)
  const v = ctx._makeTrailerVideo('http://x/t.mp4', 'vcard-preview')
  assert.strictEqual(v.muted, true)
  assert.strictEqual(v.loop, true)
  assert.strictEqual(v.playsInline, true)
  assert.strictEqual(v.src, 'http://x/t.mp4')
  assert.strictEqual(v.className, 'vcard-preview')
})

test('the card preview still routes through the shared factory (behavior intact)', () => {
  const start = extract('_startHoverTrailer')
  assert.match(start, /_makeTrailerVideo\(res\.url, 'vcard-preview'\)/)
})

// V012: the detail page's primary button names its real behaviour.
test('the detail hero reads Play or Resume from <time>, with Start over only when resuming', () => {
  const R = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.ok(R.includes("id=\"vdet-play\">' + _VICON.play + esc(_detPrimary(d).label) + '</button>'"))
  assert.ok(R.includes("_detPrimary(d).startOver ? '<button class=\"vbtn\" id=\"vdet-startover\""))
  assert.ok(R.includes('return R.primaryAction(saved, fmt)'), 'through the shared watch rule')
  assert.ok(R.includes('_watch.startFromZero = true'), 'Start over suppresses the resume offer rather than deleting progress')
  assert.ok(R.includes("if (_watch.startFromZero) { _watch.startFromZero = false; return }"))
})

// V097: Close and Minimize are told apart by label and by what Esc does.
test('Stop reads as stop-and-close, Back as keep-watching, and the help says Esc never stops', () => {
  const H = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.html'), 'utf8')
  const R = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.match(H, /id="vt-stop" aria-label="Stop and close — ends this video"/)
  assert.match(H, /id="vmini-stop" aria-label="Stop and close — ends this video"/)
  assert.match(H, /id="vt-back" aria-label="Keep watching and go back to browsing"/)
  assert.match(R, /keys: \['Esc'\], desc: 'Back out one level[^']*Keeps playing; Stop \(■\) ends it'/)
})

// V052: inferred source badges are labelled as such; measured ones replace them.
test('source badges say whether they were read from the name or measured, and never invent a layout', () => {
  const R = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const E = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'video-engine.js'), 'utf8')
  assert.ok(R.includes("cls: 'video-source-badge inferred'") && R.includes("title: 'Read from the release name — not checked until it plays'"))
  assert.ok(R.includes("(s.audioLayout || 'audio ?')"), 'no layout is not stereo')
  assert.ok(!R.includes("(s.audioLayout || 'stereo')"))
  assert.ok(R.includes("cls: 'video-source-badge measured'"))
  assert.ok(R.includes('_recordMeasuredStream(res.tracks)'), 'measured after the first frame')
  assert.ok(E.includes("channels: Number(raw['demux-channel-count']) || null"), 'the engine passes the measured channel count')
})

// V113: the latest position survives close and crash.
test('position is flushed on exit and pagehide, throttled while playing, and checkpointed on pause', () => {
  const R = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const exit = R.slice(R.indexOf('onExit: function () {'), R.indexOf('onExit: function () {') + 300)
  assert.ok(exit.includes('_persistPosition(true)'), 'graceful close flushes')
  const ph = R.slice(R.indexOf("window.addEventListener('pagehide'"), R.indexOf("window.addEventListener('pagehide'") + 300)
  assert.ok(ph.includes('_persistPosition(true)') && ph.includes('PapaVideoStore?.flush?.()'), 'window close flushes through the bridge')
  assert.ok(R.includes('const justPaused = !!st.paused && !(_videoLastPaused === true)'), 'a pause is a checkpoint')
  assert.ok(R.includes('if (!justPaused && now - _watch.savedAt < 5000) return'))
})

// V109: media keys go to the one active session.
test('media keys drive the film while a video session is open, the album otherwise', () => {
  const R = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.ok(R.includes('const _mediaKeyToVideo = key => {'))
  assert.ok(R.includes("if (!_player || !_player.isOpen || !_player.isOpen()) return false"))
  assert.ok(R.includes("if (_mediaKeyToVideo(key)) return\n    if (key === 'play-pause') togglePlay()"), 'the media-key handler tries video first')
  assert.ok(R.includes("window.api.on('media-playpause', () => { if (!_mediaKeyToVideo('play-pause')) togglePlay() })"), 'so do the tray/MPRIS channels')
})
