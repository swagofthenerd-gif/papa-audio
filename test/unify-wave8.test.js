'use strict'
// Wave-8 unification (App §69 universal search Movies & TV strip, §70 unified
// home Continue-watching strip, §76 year recap).
//
// Two kinds of test here:
//   1. The pure aggregation behind the year-recap card (src/home-recap.js) is
//      require()'d and exercised directly, the way the stores are.
//   2. The renderer wiring is pinned by extracting the real functions from
//      renderer.js and running them in a vm context with just the globals they
//      touch — the same brace-extraction approach video-render.test.js uses,
//      because renderer.js cannot be required outside Electron.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const recap = require('../src/home-recap')

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

const YEAR = 2026
const MS = year => Date.UTC(year, 5, 1) // mid-year epoch ms for a given year

// ─── §76 aggregation: musicRecap ────────────────────────────────────────────

test('musicRecap counts only this year and sums hours', () => {
  const r = recap.musicRecap([
    { filePath: 'a', ts: MS(YEAR), artist: 'Miles Davis', duration: 3600 },
    { filePath: 'b', ts: MS(YEAR), artist: 'Miles Davis', duration: 1800 },
    { filePath: 'c', ts: MS(YEAR - 1), artist: 'Coltrane', duration: 3600 }, // last year: excluded
  ], { year: YEAR })
  assert.strictEqual(r.plays, 2, 'last-year play excluded')
  assert.strictEqual(r.topArtist, 'Miles Davis')
  assert.strictEqual(r.topArtistPlays, 2)
  assert.strictEqual(r.hours, 1.5, '3600+1800 seconds = 1.5h')
})

test('musicRecap falls back to library duration and artist when the row lacks them', () => {
  const durs = { x: 7200 }
  const arts = { x: 'Björk' }
  const r = recap.musicRecap([
    { filePath: 'x', ts: MS(YEAR) }, // no duration, no artist
  ], { year: YEAR, durationOf: fp => durs[fp], artistOf: fp => arts[fp] })
  assert.strictEqual(r.plays, 1)
  assert.strictEqual(r.hours, 2, 'library duration used')
  assert.strictEqual(r.topArtist, 'Björk', 'library artist used')
})

test('musicRecap on empty history yields zeros and no top artist', () => {
  const r = recap.musicRecap([], { year: YEAR })
  assert.strictEqual(r.plays, 0)
  assert.strictEqual(r.hours, 0)
  assert.strictEqual(r.topArtist, null)
})

test('musicRecap tolerates junk rows without throwing', () => {
  const r = recap.musicRecap([null, 42, {}, { ts: 'nope' }, { ts: MS(YEAR), artist: 'X' }], { year: YEAR })
  assert.strictEqual(r.plays, 1)
  assert.strictEqual(r.topArtist, 'X')
})

// ─── §76 aggregation: videoRecap ────────────────────────────────────────────

test('videoRecap counts this-year diary viewings including rewatches', () => {
  const r = recap.videoRecap([
    { key: 'movie:1', date: YEAR + '-03-04' },
    { key: 'movie:1', date: YEAR + '-06-10' }, // rewatch: still counts (a sitting)
    { key: 'tv:9', date: (YEAR - 1) + '-01-01' }, // last year: excluded
  ], [], { year: YEAR })
  assert.strictEqual(r.films, 2)
})

test('videoRecap derives hours from watched items, capped at duration', () => {
  const r = recap.videoRecap([], [
    { position: 3600, duration: 5400, updatedAt: MS(YEAR) }, // 1h watched
    { position: 9999, duration: 3600, updatedAt: MS(YEAR) }, // capped to 1h
    { position: 3600, duration: 3600, updatedAt: MS(YEAR - 1) }, // last year: excluded
  ], { year: YEAR })
  assert.strictEqual(r.hours, 2, '1h + 1h (capped), last-year excluded')
})

test('videoRecap hours is null when no item carries a duration', () => {
  const r = recap.videoRecap([], [{ position: 100, updatedAt: MS(YEAR) }], { year: YEAR })
  assert.strictEqual(r.hours, null, 'absence, not a false zero')
})

// ─── §76 aggregation: yearRecap merge + has gate ────────────────────────────

test('yearRecap merges music+video and flags has when something is derivable', () => {
  const out = recap.yearRecap({
    year: YEAR,
    playHistory: [{ filePath: 'a', ts: MS(YEAR), artist: 'A', duration: 3600 }],
    diary: [{ key: 'movie:1', date: YEAR + '-02-02' }],
    watchedItems: [{ position: 3600, duration: 3600, updatedAt: MS(YEAR) }],
  })
  assert.strictEqual(out.has, true)
  assert.strictEqual(out.plays, 1)
  assert.strictEqual(out.topArtist, 'A')
  assert.strictEqual(out.films, 1)
  assert.strictEqual(out.hours, 2, 'music 1h + video 1h')
})

test('yearRecap has=false on a fresh install', () => {
  const out = recap.yearRecap({ year: YEAR, playHistory: [], diary: [], watchedItems: [] })
  assert.strictEqual(out.has, false, 'nothing to show → card not drawn')
  assert.strictEqual(out.plays, 0)
  assert.strictEqual(out.films, 0)
  assert.strictEqual(out.hours, null)
})

test('yearRecap has=true on music alone (video side absent)', () => {
  const out = recap.yearRecap({
    year: YEAR,
    playHistory: [{ filePath: 'a', ts: MS(YEAR), artist: 'A' }],
  })
  assert.strictEqual(out.has, true, 'music-only recap still worth drawing')
  assert.strictEqual(out.films, 0)
})

test('yearRecap is defensive against a non-object input', () => {
  const out = recap.yearRecap(null)
  assert.strictEqual(out.has, false)
})

// ─── Renderer wiring pins ───────────────────────────────────────────────────

// A minimal DOM: just enough getElementById/innerHTML/hidden semantics for the
// wiring functions, which only touch the mounts and read a couple of globals.
function makeEl(id) {
  return {
    id, innerHTML: '', hidden: false, isConnected: true,
    _listeners: {},
    style: { display: '', removeProperty() {} },
    addEventListener(ev, fn) { this._listeners[ev] = fn },
    querySelectorAll() { return [] },
    querySelector() { return null },
    closest() { return null },
  }
}

function rendererSandbox(extra) {
  const els = {}
  const ctx = Object.assign({
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    console,
    navigate: () => { ctx._navCalls.push(Array.from(arguments)) },
    _videoCard: item => '<article class="vcard" data-video="' + (item.type || 'movie') + ':' + item.id + '"></article>',
    _bindVideoCards: () => { ctx._bindCalls++ },
    _vSearchRemember: () => {},
    _attachRecents: () => null,
    _rememberOpen: () => {},
    _runVideoTitleSearch: q => { ctx._titleSearchCalls.push(q) },
    _navCalls: [],
    _bindCalls: 0,
    _titleSearchCalls: [],
    document: {
      getElementById: id => els[id] || null,
      querySelectorAll: () => [],
    },
    _ensureEl: id => (els[id] = els[id] || makeEl(id)),
  }, extra)
  ctx.window = ctx.window || {}
  // navigate needs a stable reference that records calls
  ctx.navigate = function () { ctx._navCalls.push(Array.prototype.slice.call(arguments)) }
  vm.createContext(ctx)
  return ctx
}

test('requestVideoSearch parks a trimmed query and _bindVideoSearch consumes it once', () => {
  const ctx = rendererSandbox({ state: { currentPage: 'video' } })
  const input = { value: '', dataset: {}, addEventListener() {}, dispatchEvent() {} }
  ctx.document.getElementById = id => (id === 'video-search-input' ? input : null)
  vm.runInContext('var _videoSearchTicket = 0; var _videoSearchPending = null;', ctx)
  vm.runInContext(extract('requestVideoSearch'), ctx)
  vm.runInContext(extract('_bindVideoSearch'), ctx)

  vm.runInContext('requestVideoSearch("  Blade Runner  ")', ctx)
  assert.strictEqual(ctx._videoSearchPending, 'Blade Runner', 'query parked and trimmed')

  vm.runInContext('_bindVideoSearch()', ctx)
  assert.strictEqual(ctx._titleSearchCalls.length, 1, 'parked query ran once')
  assert.strictEqual(ctx._titleSearchCalls[0], 'Blade Runner')
  assert.strictEqual(ctx._videoSearchPending, null, 'consumed — cleared')
  assert.strictEqual(input.value, 'Blade Runner', 'input populated')

  // A second bind with nothing parked must NOT re-run the old search.
  vm.runInContext('_bindVideoSearch()', ctx)
  assert.strictEqual(ctx._titleSearchCalls.length, 1, 'no stale re-run')
})

test('runVideoStrip renders up to six cards and wires the See-all handoff', async () => {
  const ctx = rendererSandbox({ state: { currentPage: 'search' } })
  const sec = ctx._ensureEl('video-strip-section')
  const results = Array.from({ length: 10 }, (_, i) => ({ type: 'movie', id: i + 1, title: 'M' + i }))
  ctx.window.api = { videoSearch: () => Promise.resolve({ ok: true, results }) }
  const allBtn = makeEl('video-strip-all')
  const origGet = ctx.document.getElementById
  ctx.document.getElementById = id => (id === 'video-strip-all' ? allBtn : origGet(id))
  let parked = null
  ctx.requestVideoSearch = q => { parked = q }

  vm.runInContext('var _videoStripRun = 0;', ctx)
  vm.runInContext(extract('runVideoStrip'), ctx)
  vm.runInContext('runVideoStrip("dune")', ctx)
  await new Promise(r => setTimeout(r, 10))

  assert.ok(!sec.hidden, 'strip shown when there are results')
  const cardCount = (sec.innerHTML.match(/class="vcard"/g) || []).length
  assert.strictEqual(cardCount, 6, 'capped at six posters')
  assert.ok(/Movies &amp; TV/.test(sec.innerHTML), 'header present')
  assert.ok(ctx._bindCalls >= 1, 'cards bound via _bindVideoCards')

  // Fire the See-all handoff: parks the query then navigates to the video tab.
  allBtn._listeners.click()
  assert.strictEqual(parked, 'dune', 'query parked for the video tab')
  assert.deepStrictEqual(ctx._navCalls.pop(), ['video'], 'navigated to Movies & TV')
})

test('runVideoStrip hides the strip on empty results and is defensive without the API', async () => {
  const ctx = rendererSandbox({ state: { currentPage: 'search' } })
  const sec = ctx._ensureEl('video-strip-section')
  ctx.window.api = { videoSearch: () => Promise.resolve({ ok: true, results: [] }) }
  vm.runInContext('var _videoStripRun = 0;', ctx)
  vm.runInContext(extract('runVideoStrip'), ctx)
  vm.runInContext('runVideoStrip("nothing-matches")', ctx)
  await new Promise(r => setTimeout(r, 10))
  assert.strictEqual(sec.hidden, true, 'empty → strip hidden')

  // No api.videoSearch at all: must not throw.
  ctx.window.api = {}
  assert.doesNotThrow(() => vm.runInContext('runVideoStrip("x")', ctx))
})

test('runVideoStrip ignores a stale response after a newer query', async () => {
  const ctx = rendererSandbox({ state: { currentPage: 'search' } })
  const sec = ctx._ensureEl('video-strip-section')
  // First call resolves slowly; a second bumps the run counter before it lands.
  let resolveFirst
  const first = new Promise(r => { resolveFirst = r })
  let call = 0
  ctx.window.api = { videoSearch: () => (++call === 1
    ? first
    : Promise.resolve({ ok: true, results: [{ type: 'movie', id: 99 }] })) }
  vm.runInContext('var _videoStripRun = 0;', ctx)
  vm.runInContext(extract('runVideoStrip'), ctx)
  vm.runInContext('runVideoStrip("first")', ctx)
  vm.runInContext('runVideoStrip("second")', ctx)
  await new Promise(r => setTimeout(r, 5))
  // Now let the first (stale) search resolve — it must not paint over the strip.
  resolveFirst({ ok: true, results: [{ type: 'movie', id: 1 }, { type: 'movie', id: 2 }] })
  await new Promise(r => setTimeout(r, 10))
  const cardCount = (sec.innerHTML.match(/data-video="movie:99"/g) || []).length
  assert.strictEqual(cardCount, 1, 'newest query owns the strip')
  assert.ok(!/data-video="movie:1"/.test(sec.innerHTML), 'stale results discarded')
})

test('loadHomeContinueWatching renders in-progress items as cards; empty store leaves the mount blank', () => {
  const ctx = rendererSandbox({ state: { currentPage: 'home' } })
  const mount = ctx._ensureEl('home-continue-watching')
  const cwBtn = makeEl('home-cw-all')
  const origGet = ctx.document.getElementById
  ctx.document.getElementById = id => (id === 'home-cw-all' ? cwBtn : origGet(id))
  const items = [{ type: 'movie', id: 5, title: 'Heat', position: 500, duration: 1000 }]
  ctx._vStore = () => ({ continueWatching: () => items })
  vm.runInContext(extract('loadHomeContinueWatching'), ctx)

  vm.runInContext('loadHomeContinueWatching()', ctx)
  assert.ok(/Continue watching/.test(mount.innerHTML), 'header rendered')
  assert.ok(/data-rail="continue"/.test(mount.innerHTML), 'rail marker present')
  assert.ok(/data-video="movie:5"/.test(mount.innerHTML), 'card rendered')
  assert.ok(ctx._bindCalls >= 1, 'cards bound')

  // Empty store: mount stays blank.
  mount.innerHTML = ''
  ctx._vStore = () => ({ continueWatching: () => [] })
  vm.runInContext('loadHomeContinueWatching()', ctx)
  assert.strictEqual(mount.innerHTML, '', 'no items → empty mount')

  // Absent store: defensive, no throw, blank.
  ctx._vStore = () => null
  assert.doesNotThrow(() => vm.runInContext('loadHomeContinueWatching()', ctx))
  assert.strictEqual(mount.innerHTML, '')
})

test('loadHomeContinueWatching does not paint after navigating away from Home', () => {
  const ctx = rendererSandbox({ state: { currentPage: 'library' } })
  const mount = ctx._ensureEl('home-continue-watching')
  ctx._vStore = () => ({ continueWatching: () => [{ type: 'movie', id: 1, position: 1, duration: 2 }] })
  vm.runInContext(extract('loadHomeContinueWatching'), ctx)
  vm.runInContext('loadHomeContinueWatching()', ctx)
  assert.strictEqual(mount.innerHTML, '', 'off-Home render suppressed')
})

test('loadHomeYearRecap draws the derivable figures and omits the rest', () => {
  const ctx = rendererSandbox({
    state: {
      currentPage: 'home',
      library: [{ albumArtist: 'A', tracks: [{ filePath: 'a', duration: 3600, albumArtist: 'A' }] }],
      playHistory: [
        { filePath: 'a', ts: MS(new Date().getFullYear()), artist: 'A', duration: 3600 },
        { filePath: 'a', ts: MS(new Date().getFullYear()), artist: 'A', duration: 3600 },
      ],
    },
  })
  const mount = ctx._ensureEl('home-year-recap')
  ctx.window.PapaHomeRecap = recap
  ctx.window.PapaTasteStore = { diary: () => [
    { key: 'movie:1', date: new Date().getFullYear() + '-01-01' },
    { key: 'movie:2', date: new Date().getFullYear() + '-02-01' },
  ] }
  ctx._vStore = () => ({ history: () => [{ position: 3600, duration: 3600, updatedAt: MS(new Date().getFullYear()) }] })
  vm.runInContext(extract('loadHomeYearRecap'), ctx)
  vm.runInContext('loadHomeYearRecap()', ctx)

  assert.ok(/Your year so far/.test(mount.innerHTML), 'card drawn')
  assert.ok(/tracks played/.test(mount.innerHTML), 'plays figure present')
  assert.ok(/most-played artist/.test(mount.innerHTML), 'top artist present')
  assert.ok(/watched/.test(mount.innerHTML), 'films figure present')
  assert.ok(/streamed/.test(mount.innerHTML), 'hours figure present')
})

test('loadHomeYearRecap draws nothing on a fresh install', () => {
  const ctx = rendererSandbox({ state: { currentPage: 'home', library: [], playHistory: [] } })
  const mount = ctx._ensureEl('home-year-recap')
  ctx.window.PapaHomeRecap = recap
  ctx.window.PapaTasteStore = { diary: () => [] }
  ctx._vStore = () => ({ history: () => [] })
  vm.runInContext(extract('loadHomeYearRecap'), ctx)
  vm.runInContext('loadHomeYearRecap()', ctx)
  assert.strictEqual(mount.innerHTML, '', 'nothing derivable → card absent')
})
