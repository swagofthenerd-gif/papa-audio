'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const {
  DEFAULT_BASE_URLS, CATEGORIES, buildEndpoint, buildBody, buildQueries,
  extractInfoHash, normalizeResult, createKnabenProvider, _resetMirrorHealth,
} = require('../providers/knaben')

// A captured real Knaben response (POST /v1). See providers/knaben.js for the
// documented shape this fixture exercises.
const MOVIE_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'knaben-movie.json'), 'utf8'))
const ANIME_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'knaben-anime.json'), 'utf8'))

const jsonResponse = body => ({ ok: true, text: async () => JSON.stringify(body) })
// Knaben is POST-only; the mock ignores the body and just serves a fixed feed.
const fetcherFor = body => async () => jsonResponse(body)

test.beforeEach(() => _resetMirrorHealth())

// --- query building -------------------------------------------------------

test('buildEndpoint targets the v1 POST endpoint', () => {
  assert.strictEqual(buildEndpoint('https://api.knaben.org'), 'https://api.knaben.org/v1')
})

// search_type MUST be "100%": "score" ignores the query and returns global
// top-seeded junk (verified live — it returned PC software for a film query).
test('buildBody uses the query-relevant search_type and per-type category', () => {
  const movie = buildBody('Oppenheimer 2023', 'movie', 30)
  assert.strictEqual(movie.search_type, '100%')
  assert.strictEqual(movie.query, 'Oppenheimer 2023')
  assert.deepStrictEqual(movie.categories, CATEGORIES.movie)
  assert.strictEqual(movie.hide_xxx, true)
  assert.strictEqual(movie.order_by, 'seeders')
  assert.deepStrictEqual(buildBody('x', 'tv', 5).categories, CATEGORIES.tv)
  assert.deepStrictEqual(buildBody('x', 'anime', 5).categories, CATEGORIES.anime)
})

test('buildBody clamps size into a sane range', () => {
  assert.strictEqual(buildBody('x', 'movie', 9999).size, 300)
  assert.strictEqual(buildBody('x', 'movie', 0).size, 50)
  assert.strictEqual(buildBody('x', 'movie', undefined).size, 50)
})

test('buildQueries adds a year-qualified movie query then a bare fallback', () => {
  assert.deepStrictEqual(
    buildQueries({ type: 'movie', title: 'Oppenheimer', year: 2023 }),
    ['Oppenheimer 2023', 'Oppenheimer'])
})

test('buildQueries builds SxxEyy, season, and bare queries for tv', () => {
  assert.deepStrictEqual(
    buildQueries({ type: 'tv', title: 'Breaking Bad', season: 1, episode: 2 }),
    ['Breaking Bad S01E02', 'Breaking Bad season 1', 'Breaking Bad'])
})

test('buildQueries builds a query per anime name, padded and absolute', () => {
  const qs = buildQueries({
    type: 'anime', title: 'Frieren',
    titles: { romaji: 'Sousou no Frieren', english: 'Frieren' },
    episode: 9, absoluteEpisode: 37,
  })
  // Romaji first (release groups index under it), padded episode, then absolute.
  assert.ok(qs.includes('Sousou no Frieren 09'))
  assert.ok(qs.includes('Sousou no Frieren 37'))
  assert.ok(qs.includes('Sousou no Frieren'))
})

// --- info hash / normalization -------------------------------------------

test('extractInfoHash reads the hash field and upper-cases it', () => {
  assert.strictEqual(
    extractInfoHash({ hash: '491aa0e19cbdb03b100961db82315c08643a6139' }),
    '491AA0E19CBDB03B100961DB82315C08643A6139')
})

test('extractInfoHash falls back to the magnet btih and rejects garbage', () => {
  assert.strictEqual(
    extractInfoHash({ magnetUrl: 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=x' }),
    'ABCDEF0123456789ABCDEF0123456789ABCDEF01')
  assert.strictEqual(extractInfoHash({ hash: 'nope' }), null)
  assert.strictEqual(extractInfoHash({}), null)
  assert.strictEqual(extractInfoHash(null), null)
})

test('normalizeResult builds a well-trackered magnet and provenance label', () => {
  const raw = MOVIE_FIXTURE.hits[0]
  const e = normalizeResult(raw, { type: 'movie' })
  assert.strictEqual(e.kind, 'torrent')
  assert.strictEqual(e.source, 'Knaben')
  assert.match(e.magnet, /^magnet:\?xt=urn:btih:[0-9A-F]{40}/)
  // The magnet carries the shared public tracker list, not just DHT.
  assert.ok((e.magnet.match(/&tr=/g) || []).length >= 10)
  assert.strictEqual(e.infoHash, extractInfoHash(raw))
  assert.strictEqual(e.url, null)
  // cachedOrigin is surfaced so the user can see which index it came from.
  assert.match(e.label, /via /)
})

test('normalizeResult marks anime dub/sub and season packs', () => {
  const sub = normalizeResult(
    { title: '[SubsPlease] Frieren - 09 (1080p)', hash: 'a'.repeat(40), seeders: 5 },
    { type: 'anime', episode: 9 })
  assert.strictEqual(sub.dub, false)
  assert.strictEqual(sub.sub, true)
  assert.strictEqual(sub.isPack, false)
  const pack = normalizeResult(
    { title: '[Group] Frieren 01-28 Batch Dual Audio', hash: 'b'.repeat(40), seeders: 5 },
    { type: 'anime', episode: 9 })
  assert.strictEqual(pack.isPack, true)
  assert.strictEqual(pack.dub, true)
})

test('normalizeResult flags cam/telesync sources without dropping them', () => {
  const e = normalizeResult(
    { title: 'Some.Movie.2024.HDCAM.x264', hash: 'c'.repeat(40), seeders: 3 },
    { type: 'movie' })
  assert.strictEqual(e.lowQuality, true)
  assert.match(e.label, /CAM\/TS/)
})

// --- malformed-response resilience ---------------------------------------

test('normalizeResult returns null for an entry with no usable hash', () => {
  assert.strictEqual(normalizeResult({ title: 'x', hash: '' }, { type: 'movie' }), null)
  assert.strictEqual(normalizeResult({}, { type: 'movie' }), null)
  assert.strictEqual(normalizeResult(null, { type: 'movie' }), null)
})

test('the provider survives non-JSON, non-ok, and empty-hits responses', async () => {
  const req = { type: 'movie', title: 'Oppenheimer', year: 2023 }
  const garbage = createKnabenProvider({ fetchFn: async () => ({ ok: true, text: async () => '<html>nope' }) })
  assert.deepStrictEqual(await garbage(req), [])
  _resetMirrorHealth()
  const notOk = createKnabenProvider({ fetchFn: async () => ({ ok: false, text: async () => '' }) })
  assert.deepStrictEqual(await notOk(req), [])
  _resetMirrorHealth()
  const empty = createKnabenProvider({ fetchFn: fetcherFor({ hits: [] }) })
  assert.deepStrictEqual(await empty(req), [])
  _resetMirrorHealth()
  const threw = createKnabenProvider({ fetchFn: async () => { throw new Error('down') } })
  assert.deepStrictEqual(await threw(req), [])
})

// --- type gating ----------------------------------------------------------

test('the provider answers only movie/tv/anime requests', async () => {
  const provider = createKnabenProvider({ fetchFn: fetcherFor(MOVIE_FIXTURE) })
  assert.deepStrictEqual(await provider({ type: 'music', title: 'x' }), [])
  assert.deepStrictEqual(await provider({ type: undefined, title: 'x' }), [])
  assert.deepStrictEqual(await provider({}), [])
})

// --- end-to-end against a real captured response --------------------------

test('the provider normalizes a captured Knaben movie response and matches title/year', async () => {
  const provider = createKnabenProvider({ fetchFn: fetcherFor(MOVIE_FIXTURE) })
  const out = await provider({ type: 'movie', title: 'Oppenheimer', year: 2023 })
  assert.ok(out.length > 0, 'the fixture yields at least one Oppenheimer source')
  for (const e of out) {
    assert.strictEqual(e.source, 'Knaben')
    assert.strictEqual(e.kind, 'torrent')
    assert.ok(e.infoHash && /^[0-9A-F]{40}$/.test(e.infoHash))
    assert.ok(!('name' in e), 'the internal match field is stripped before return')
  }
  // A wrong film must not survive the title gate.
  assert.deepStrictEqual(
    await provider({ type: 'movie', title: 'Barbie', year: 2023 }), [])
})

test('the provider normalizes a captured Knaben anime response for the requested episode', async () => {
  const provider = createKnabenProvider({ fetchFn: fetcherFor(ANIME_FIXTURE) })
  const out = await provider({
    type: 'anime', title: 'Frieren',
    titles: { romaji: 'Sousou no Frieren', english: 'Frieren' },
    episode: 10,
  })
  assert.ok(out.length > 0, 'the fixture yields at least one episode-10 source')
  for (const e of out) {
    assert.strictEqual(e.source, 'Knaben')
    assert.ok(typeof e.dub === 'boolean')
    assert.ok(typeof e.sub === 'boolean')
  }
})

test('DEFAULT_BASE_URLS is a non-empty list', () => {
  assert.ok(Array.isArray(DEFAULT_BASE_URLS) && DEFAULT_BASE_URLS.length > 0)
})
