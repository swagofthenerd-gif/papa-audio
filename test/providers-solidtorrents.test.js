'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const {
  DEFAULT_BASE_URLS, buildSearchUrl, buildQueries, extractInfoHash,
  normalizeResult, createSolidTorrentsProvider, _resetMirrorHealth,
} = require('../providers/solidtorrents')

// Captured real SolidTorrents responses (GET /api/v1/search). See
// providers/solidtorrents.js for the documented shape.
const MOVIE_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'solidtorrents-movie.json'), 'utf8'))
const ANIME_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'solidtorrents-anime.json'), 'utf8'))

const jsonResponse = body => ({ ok: true, text: async () => JSON.stringify(body) })
const fetcherFor = body => async () => jsonResponse(body)

test.beforeEach(() => _resetMirrorHealth())

// --- query building -------------------------------------------------------

test('buildSearchUrl targets the seeder-sorted JSON search', () => {
  assert.strictEqual(
    buildSearchUrl('https://solidtorrents.to', 'Dune 2024'),
    'https://solidtorrents.to/api/v1/search?q=Dune%202024&sort=seeders')
})

test('buildQueries: movie year-qualified then bare', () => {
  assert.deepStrictEqual(
    buildQueries({ type: 'movie', title: 'Oppenheimer', year: 2023 }),
    ['Oppenheimer 2023', 'Oppenheimer'])
})

test('buildQueries: tv SxxEyy then season then bare', () => {
  assert.deepStrictEqual(
    buildQueries({ type: 'tv', title: 'Breaking Bad', season: 1, episode: 2 }),
    ['Breaking Bad S01E02', 'Breaking Bad season 1', 'Breaking Bad'])
})

test('buildQueries: anime per name with padded and absolute episode', () => {
  const qs = buildQueries({
    type: 'anime', title: 'Frieren',
    titles: { romaji: 'Sousou no Frieren' }, episode: 9, absoluteEpisode: 37,
  })
  assert.ok(qs.includes('Sousou no Frieren 09'))
  assert.ok(qs.includes('Sousou no Frieren 37'))
})

// --- info hash / normalization -------------------------------------------

test('extractInfoHash upper-cases a valid 40-hex infohash and rejects junk', () => {
  assert.strictEqual(
    extractInfoHash({ infohash: '491aa0e19cbdb03b100961db82315c08643a6139' }),
    '491AA0E19CBDB03B100961DB82315C08643A6139')
  assert.strictEqual(extractInfoHash({ infohash: 'short' }), null)
  assert.strictEqual(extractInfoHash({}), null)
  assert.strictEqual(extractInfoHash(null), null)
})

test('normalizeResult builds a well-trackered magnet from the hash', () => {
  const raw = MOVIE_FIXTURE.results[0]
  const e = normalizeResult(raw, { type: 'movie' })
  assert.strictEqual(e.source, 'SolidTorrents')
  assert.strictEqual(e.kind, 'torrent')
  assert.match(e.magnet, /^magnet:\?xt=urn:btih:[0-9A-F]{40}/)
  assert.ok((e.magnet.match(/&tr=/g) || []).length >= 10)
  assert.strictEqual(e.url, null)
  assert.strictEqual(e.infoHash, extractInfoHash(raw))
})

test('normalizeResult reads quality, audio layout and size from the title', () => {
  const e = normalizeResult(
    { title: 'Movie.2024.2160p.BluRay.TrueHD.7.1.x265', infohash: 'a'.repeat(40),
      seeders: 12, size: 30e9 },
    { type: 'movie' })
  assert.strictEqual(e.quality, '2160p')
  assert.strictEqual(e.audioLayout, '7.1')
  assert.match(e.label, /GB/)
  assert.strictEqual(e.seeds, 12)
})

test('normalizeResult marks anime dub/sub and packs; flags cam sources', () => {
  const pack = normalizeResult(
    { title: '[Group] Frieren 01-28 Dual Audio', infohash: 'b'.repeat(40), seeders: 4 },
    { type: 'anime', episode: 9 })
  assert.strictEqual(pack.isPack, true)
  assert.strictEqual(pack.dub, true)
  const cam = normalizeResult(
    { title: 'Movie.2024.CAMRip.x264', infohash: 'c'.repeat(40), seeders: 1 },
    { type: 'movie' })
  assert.strictEqual(cam.lowQuality, true)
})

test('normalizeResult returns null when the infohash is missing', () => {
  assert.strictEqual(normalizeResult({ title: 'x' }, { type: 'movie' }), null)
  assert.strictEqual(normalizeResult(null, { type: 'movie' }), null)
})

// --- malformed-response resilience ---------------------------------------

test('the provider survives non-JSON, non-ok, success:false, and empty results', async () => {
  const req = { type: 'movie', title: 'Oppenheimer', year: 2023 }
  const cases = [
    async () => ({ ok: true, text: async () => 'not json' }),
    async () => ({ ok: false, text: async () => '' }),
    fetcherFor({ success: false }),
    fetcherFor({ success: true, results: [] }),
    async () => { throw new Error('network') },
  ]
  for (const fetchFn of cases) {
    _resetMirrorHealth()
    const provider = createSolidTorrentsProvider({ fetchFn })
    assert.deepStrictEqual(await provider(req), [])
  }
})

// --- type gating ----------------------------------------------------------

test('the provider answers only movie/tv/anime', async () => {
  const provider = createSolidTorrentsProvider({ fetchFn: fetcherFor(MOVIE_FIXTURE) })
  assert.deepStrictEqual(await provider({ type: 'music', title: 'x' }), [])
  assert.deepStrictEqual(await provider({}), [])
})

// --- end-to-end against real captured responses ---------------------------

test('the provider normalizes a captured movie response and gates by title', async () => {
  const provider = createSolidTorrentsProvider({ fetchFn: fetcherFor(MOVIE_FIXTURE) })
  const out = await provider({ type: 'movie', title: 'Oppenheimer', year: 2023 })
  assert.ok(out.length > 0)
  for (const e of out) {
    assert.strictEqual(e.source, 'SolidTorrents')
    assert.ok(/^[0-9A-F]{40}$/.test(e.infoHash))
    assert.ok(!('name' in e))
  }
  assert.deepStrictEqual(
    await provider({ type: 'movie', title: 'Barbie', year: 2023 }), [])
})

test('the provider normalizes a captured anime response for the episode', async () => {
  const provider = createSolidTorrentsProvider({ fetchFn: fetcherFor(ANIME_FIXTURE) })
  const out = await provider({
    type: 'anime', title: 'Frieren',
    titles: { romaji: 'Sousou no Frieren', english: 'Frieren' }, episode: 8,
  })
  assert.ok(out.length > 0)
  for (const e of out) assert.ok(typeof e.dub === 'boolean')
})

test('DEFAULT_BASE_URLS is a non-empty list', () => {
  assert.ok(Array.isArray(DEFAULT_BASE_URLS) && DEFAULT_BASE_URLS.length > 0)
})
