'use strict'
// The AniList outage-resilience cache. AniList has gone globally dark before
// (HTTP 403, "temporarily disabled due to severe stability issues"), turning
// every anime detail click into an error page. These tests execute the REAL
// main.js functions — extracted and run in a sandbox against a real SideStore
// on a temp dir and a fake AniList — so the write-through, the cache-on-failure
// fallback and the eviction cap are exercised for real, not asserted on source
// text.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { SideStore } = require('../side-store')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// Pull one top-level function out of main.js by balanced braces, matching the
// extractor the other main.js/renderer tests use.
function extract(name) {
  let start = MAIN.indexOf('async function ' + name + '(')
  if (start === -1) start = MAIN.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found in main.js')
  let depth = 0
  for (let j = MAIN.indexOf('{', start); j < MAIN.length; j++) {
    if (MAIN[j] === '{') depth++
    else if (MAIN[j] === '}') { depth--; if (!depth) return MAIN.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

// Grab a `const NAME = ...` numeric constant's expression so the cap/evict
// numbers under test are the ones main.js actually ships, not a copy.
function constInt(name) {
  const m = MAIN.match(new RegExp('const ' + name + ' = (\\d+)'))
  assert.ok(m, name + ' not found in main.js')
  return Number(m[1])
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'papa-outage-'))

// A trivial in-memory stand-in for the makeCache() TTL cache: the outage logic
// only ever calls get/set/clear on it.
function memCache() {
  const m = new Map()
  return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), clear: () => m.clear() }
}

// Build a sandbox holding the real functions, wired to a real SideStore and an
// injectable fake AniList. `anilistById` decides what byId does per test.
function harness({ anilistById } = {}) {
  const dir = tmpdir()
  const errors = []
  const animeDetailCache = new SideStore({
    dir, name: 'anime-detail-cache', fallback: {}, debounceMs: 5, onError: e => errors.push(e),
  })
  const calls = { byId: 0 }
  const ctx = {
    console,
    Date,
    Object,
    Array,
    ANIME_DETAIL_CACHE_CAP: constInt('ANIME_DETAIL_CACHE_CAP'),
    ANIME_DETAIL_CACHE_EVICT: constInt('ANIME_DETAIL_CACHE_EVICT'),
    sideStores: { animeDetailCache },
    _videoDetailCache: memCache(),
    // The anime path never reaches these, but _videoShowDetail references them.
    tmdb: () => ({ detail: async () => null, season: async () => null }),
    _enrichExternalRatings: async d => d,
    _enrichAnimeDetail: async d => d,
    anilist: () => ({
      byId: async id => {
        calls.byId++
        return anilistById(id)
      },
    }),
  }
  vm.createContext(ctx)
  for (const fn of ['_animeDetailCacheWrite', '_animeDetailCacheRead', '_videoShowDetail']) {
    vm.runInContext(extract(fn), ctx)
  }
  return { ctx, dir, errors, calls, animeDetailCache }
}

const DETAIL = { id: 21, type: 'anime', title: 'One Piece', episodeCount: 1000 }

test('a successful byId is written through to the persistent cache', async () => {
  const { ctx, animeDetailCache } = harness({ anilistById: async () => ({ ...DETAIL }) })
  const detail = await ctx._videoShowDetail('anime', 21)
  assert.strictEqual(detail.title, 'One Piece')
  await animeDetailCache.flush()
  const entry = animeDetailCache.get()['anime:21']
  assert.ok(entry, 'the show was written to the outage cache')
  assert.strictEqual(entry.detail.title, 'One Piece')
  assert.ok(entry.cachedAt > 0, 'the entry is time-stamped for eviction')
})

test('a cached show still opens when AniList throws (stale beats an error)', async () => {
  // First a good fetch to seed the cache, then a fresh harness whose byId
  // always throws — the pre-seeded on-disk entry must be served.
  const seed = harness({ anilistById: async () => ({ ...DETAIL }) })
  await seed.ctx._videoShowDetail('anime', 21)
  await seed.animeDetailCache.flush()

  // A new sandbox reading the SAME file, with a failing network.
  const { ctx, calls } = (() => {
    const errors = []
    const animeDetailCache = new SideStore({
      dir: seed.dir, name: 'anime-detail-cache', fallback: {}, debounceMs: 5, onError: e => errors.push(e),
    })
    const c = { byId: 0 }
    const sctx = {
      console, Date, Object, Array,
      ANIME_DETAIL_CACHE_CAP: constInt('ANIME_DETAIL_CACHE_CAP'),
      ANIME_DETAIL_CACHE_EVICT: constInt('ANIME_DETAIL_CACHE_EVICT'),
      sideStores: { animeDetailCache },
      _videoDetailCache: memCache(),
      tmdb: () => ({ detail: async () => null, season: async () => null }),
      _enrichExternalRatings: async d => d,
      _enrichAnimeDetail: async d => d,
      anilist: () => ({ byId: async () => { c.byId++; throw new Error('The AniList API has been temporarily disabled due to severe stability issues.') } }),
    }
    vm.createContext(sctx)
    for (const fn of ['_animeDetailCacheWrite', '_animeDetailCacheRead', '_videoShowDetail']) {
      vm.runInContext(extract(fn), sctx)
    }
    return { ctx: sctx, calls: c }
  })()

  const detail = await ctx._videoShowDetail('anime', 21)
  assert.strictEqual(calls.byId, 1, 'the network was tried first (fresh-first)')
  assert.strictEqual(detail.title, 'One Piece', 'the stale cached detail was served')
})

test('a never-seen show surfaces AniList\'s own message, not "Not found"', async () => {
  const { ctx } = harness({
    anilistById: async () => { throw new Error('The AniList API has been temporarily disabled due to severe stability issues.') },
  })
  await assert.rejects(
    () => ctx._videoShowDetail('anime', 99999),
    /temporarily disabled due to severe stability issues/,
    'with no cache the honest error propagates to the detail handler',
  )
})

test('the network wins even when a cache entry exists (cache is failure-only)', async () => {
  // Seed 21 with an old title, then have byId return a NEW title. The fresh
  // value must be returned and written through, never the stale cache.
  const { ctx, animeDetailCache } = harness({ anilistById: async () => ({ ...DETAIL, title: 'One Piece (updated)' }) })
  // Pre-seed a stale entry directly.
  ctx._animeDetailCacheWrite('anime:21', { detail: { ...DETAIL, title: 'One Piece (stale)' } })
  await animeDetailCache.flush()

  const detail = await ctx._videoShowDetail('anime', 21)
  assert.strictEqual(detail.title, 'One Piece (updated)', 'the live answer wins over the cache')
  await animeDetailCache.flush()
  assert.strictEqual(animeDetailCache.get()['anime:21'].detail.title, 'One Piece (updated)', 'the cache was refreshed')
})

test('the cache is capped and evicts the oldest entries in one pass', async () => {
  const cap = constInt('ANIME_DETAIL_CACHE_CAP')
  const evict = constInt('ANIME_DETAIL_CACHE_EVICT')
  const { ctx, animeDetailCache } = harness({ anilistById: async () => ({ ...DETAIL }) })

  // Write cap+1 entries with strictly increasing timestamps so the ordering is
  // deterministic (real Date.now() can collide across a tight loop).
  let t = 1
  const origNow = Date.now
  Date.now = () => t++
  try {
    for (let i = 0; i < cap + 1; i++) ctx._animeDetailCacheWrite('anime:' + i, { detail: { id: i } })
  } finally {
    Date.now = origNow
  }
  await animeDetailCache.flush()
  const map = animeDetailCache.get()
  const keys = Object.keys(map)
  // Crossing the cap triggers one eviction pass dropping `evict` oldest.
  assert.strictEqual(keys.length, cap + 1 - evict, 'over-cap write evicts a slice of the oldest')
  // The oldest (0..evict-1) are gone; the newest (cap) survives.
  assert.ok(!('anime:0' in map), 'the very oldest entry was evicted')
  assert.ok(('anime:' + cap) in map, 'the newest entry survived')
})

test('a genuinely unknown id returns null without throwing or caching', async () => {
  const { ctx, animeDetailCache } = harness({ anilistById: async () => null })
  const detail = await ctx._videoShowDetail('anime', 424242)
  assert.strictEqual(detail, null, 'null byId is "no such show", not an outage')
  await animeDetailCache.flush()
  assert.ok(!('anime:424242' in animeDetailCache.get()), 'nothing was cached for a missing show')
})

// ── The anime BROWSE cache: keeping the shelves through an AniList outage ─────
// The row sibling of the detail cache above. These run the REAL
// video-catalog-get / video-discover handlers extracted from main.js in a
// sandbox with a real SideStore and a fake AniList, so the write-through and the
// serve-on-failure fallback are exercised for real.

// Capture an ipcMain.handle('<name>', fn) call by balanced parens, so the real
// handler arrow can be run directly against a controlled sandbox.
function extractHandler(name) {
  const marker = "ipcMain.handle('" + name + "'"
  const start = MAIN.indexOf(marker)
  assert.ok(start > -1, name + ' handler not found in main.js')
  let depth = 0
  for (let j = MAIN.indexOf('(', start); j < MAIN.length; j++) {
    if (MAIN[j] === '(') depth++
    else if (MAIN[j] === ')') { depth--; if (!depth) return MAIN.slice(start, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

// A sandbox holding the real anime-browse-cache helpers, the real
// _anilistListWithOutage, and the two real handlers, wired to a real SideStore
// and a fake AniList whose list results (and lastFailure) each test controls.
function browseHarness({ list, lastFailure, discover } = {}) {
  const dir = tmpdir()
  const errors = []
  const animeBrowseCache = new SideStore({
    dir, name: 'anime-browse-cache', fallback: {}, debounceMs: 5, onError: e => errors.push(e),
  })
  const handlers = {}
  const ctx = {
    console, Date, Object, Array, JSON, Number, String, Math,
    ANIME_BROWSE_CACHE_CAP: constInt('ANIME_BROWSE_CACHE_CAP'),
    ANIME_BROWSE_CACHE_EVICT: constInt('ANIME_BROWSE_CACHE_EVICT'),
    sideStores: { animeBrowseCache },
    _videoCatalogCache: memCache(),
    _videoDiscoverCache: memCache(),
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    _currentAnimeSeasonTag: () => 'FALL-2026',
    tmdb: () => ({ trending: async () => [], popular: async () => [], discover: async () => ({ results: [] }) }),
    anilist: () => ({
      lastFailure: () => (lastFailure || null),
      trending: async () => { if (typeof list === 'function') return list('trending'); return list || [] },
      popular: async () => { if (typeof list === 'function') return list('popular'); return list || [] },
      // season() throws on failure rather than degrading — a test can make it do so.
      season: async () => {
        if (lastFailure && lastFailure._throw) throw Object.assign(new Error(lastFailure.message), { status: lastFailure.status })
        if (typeof list === 'function') return list('season')
        return list || []
      },
      discover: async () => discover || { results: [], page: 1, totalPages: 1, totalResults: 0, hasMore: false },
    }),
  }
  vm.createContext(ctx)
  for (const fn of ['_animeBrowseCacheWrite', '_animeBrowseCacheRead', '_anilistListWithOutage']) {
    vm.runInContext(extract(fn), ctx)
  }
  vm.runInContext(extractHandler('video-catalog-get'), ctx)
  vm.runInContext(extractHandler('video-discover'), ctx)
  return { ctx, dir, errors, animeBrowseCache, handlers }
}

const ANIME_ROWS = [
  { id: 1, title: 'Frieren' }, { id: 2, title: 'Dandadan' },
  { id: 3, title: 'One Piece' }, { id: 4, title: 'Bleach' },
]

test('a good anime row is written through to the persistent browse cache', async () => {
  const h = browseHarness({ list: ANIME_ROWS })
  const res = await h.handlers['video-catalog-get'](null, { section: 'trending-anime', page: 1 })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.results.length, 4)
  assert.ok(!res.fromCache && !res.outage, 'a live result carries no outage flags')
  await h.animeBrowseCache.flush()
  const entry = h.animeBrowseCache.get()['list:trending-anime:1']
  assert.ok(entry, 'the row was saved for a future outage')
  assert.strictEqual(entry.value.length, 4)
})

test('an outage-empty row serves the last saved list, marked fromCache', async () => {
  // Seed with a good result, then re-open with AniList down.
  const seed = browseHarness({ list: ANIME_ROWS })
  await seed.handlers['video-catalog-get'](null, { section: 'trending-anime', page: 1 })
  await seed.animeBrowseCache.flush()

  // A new sandbox over the SAME file, degrading to empty with a recorded failure.
  const down = browseHarness({
    list: [], lastFailure: { at: Date.now(), message: 'AniList request failed (403)', status: 403 },
  })
  // Point the new store at the seeded dir by re-reading it.
  const animeBrowseCache = new SideStore({ dir: seed.dir, name: 'anime-browse-cache', fallback: {}, debounceMs: 5, onError: () => {} })
  down.ctx.sideStores.animeBrowseCache = animeBrowseCache
  const res = await down.handlers['video-catalog-get'](null, { section: 'trending-anime', page: 1 })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.fromCache, true, 'the saved list was served')
  assert.strictEqual(res.results.length, 4, 'the real content is shown, not an empty shelf')
  assert.match(res.outage, /403/, "AniList's own reason rides along")
})

test('an outage with NO saved list returns empty + the outage reason (never a lie)', async () => {
  const h = browseHarness({
    list: [], lastFailure: { at: Date.now(), message: 'AniList request failed (403)', status: 403 },
  })
  const res = await h.handlers['video-catalog-get'](null, { section: 'popular-anime', page: 1 })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.results.length, 0)
  assert.ok(!res.fromCache, 'there was nothing saved to serve')
  assert.match(res.outage, /403/, 'the row is empty BECAUSE of the outage, and says so')
})

test('a healthy-but-empty row carries no outage flag (plain empty stays plain)', async () => {
  // AniList is up and honestly returned nothing: lastFailure is null.
  const h = browseHarness({ list: [], lastFailure: null })
  const res = await h.handlers['video-catalog-get'](null, { section: 'trending-anime', page: 1 })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.results.length, 0)
  assert.ok(!res.outage, 'no outage flag — the renderer still shows "nothing here"')
  assert.ok(!res.fromCache)
})

test('season-anime throwing is treated exactly like a degraded outage', async () => {
  const h = browseHarness({
    list: [], lastFailure: { _throw: true, message: 'The AniList API has been temporarily disabled', status: 403 },
  })
  const res = await h.handlers['video-catalog-get'](null, { section: 'season-anime', page: 1 })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.results.length, 0)
  assert.match(res.outage, /temporarily disabled/, 'a thrown season() is an outage, not an error page')
})

test('video-discover serves the saved anime grid through an outage', async () => {
  const good = { results: ANIME_ROWS, page: 1, totalPages: 3, totalResults: 60, hasMore: true }
  const seed = browseHarness({ discover: good })
  const req = { catalog: 'anime', page: 1, genres: ['Action'] }
  await seed.handlers['video-discover'](null, req)
  await seed.animeBrowseCache.flush()

  const down = browseHarness({
    discover: { results: [], page: 1, totalPages: 1, totalResults: 0, hasMore: false },
    lastFailure: { at: Date.now(), message: 'AniList request failed (403)', status: 403 },
  })
  down.ctx.sideStores.animeBrowseCache = new SideStore({ dir: seed.dir, name: 'anime-browse-cache', fallback: {}, debounceMs: 5, onError: () => {} })
  const res = await down.handlers['video-discover'](null, req)
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.fromCache, true, 'the saved Browse page was served')
  assert.strictEqual(res.results.length, 4)
  assert.match(res.outage, /403/)
})
