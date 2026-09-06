'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const {
  SOURCE_NAME, buildUrl, buildRequestUrl, buildQueries, extractInfoHash,
  normalizeResult, createJackettProvider,
} = require('../providers/jackett')

// A Torznab "results" JSON payload as Jackett/Prowlarr return it. The fixture
// mixes a full magnet, a hash-only result, a LINK-ONLY result (no magnet, must be
// skipped), a cam rip, and an unrelated film — so filtering and the magnet-only
// rule are both exercised. See providers/jackett.js for the documented shape.
const MOVIE_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'jackett-movie.json'), 'utf8'))

const jsonResponse = body => ({ ok: true, text: async () => JSON.stringify(body) })
const fetcherFor = body => async () => jsonResponse(body)

// --- URL building ---------------------------------------------------------

test('buildUrl targets the Torznab results path and omits the api key', () => {
  const url = buildUrl('https://jackett.example/', 'Oppenheimer 2023')
  assert.match(url, /\/api\/v2\.0\/indexers\/all\/results\?/)
  assert.match(url, /Query=Oppenheimer%202023/)
  assert.doesNotMatch(url, /apikey/i, 'the display URL must never carry the secret')
})

test('buildRequestUrl carries the api key and trims a trailing slash', () => {
  const url = buildRequestUrl('https://jackett.example/', 'SECRET', 'Frieren')
  assert.match(url, /apikey=SECRET/)
  assert.match(url, /https:\/\/jackett\.example\/api\/v2\.0\//)
  assert.doesNotMatch(url, /example\/\/api/, 'the trailing slash must be normalised away')
})

// --- query building -------------------------------------------------------

test('buildQueries adds the year for a movie', () => {
  assert.deepStrictEqual(
    buildQueries({ type: 'movie', title: 'Oppenheimer', year: 2023 }),
    ['Oppenheimer 2023', 'Oppenheimer'])
})

test('buildQueries adds an SxxEyy form for a tv episode', () => {
  const q = buildQueries({ type: 'tv', title: 'Severance', season: 2, episode: 3 })
  assert.ok(q.includes('Severance S02E03'))
  assert.ok(q.includes('Severance'))
})

test('buildQueries returns nothing without a title', () => {
  assert.deepStrictEqual(buildQueries({ type: 'movie', title: '' }), [])
})

// --- normalisation --------------------------------------------------------

test('extractInfoHash prefers InfoHash, falls back to the magnet, else null', () => {
  assert.strictEqual(
    extractInfoHash({ InfoHash: '491aa0e19cbdb03b100961db82315c08643a6139' }),
    '491AA0E19CBDB03B100961DB82315C08643A6139')
  assert.strictEqual(
    extractInfoHash({ MagnetUri: 'magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01' }),
    'ABCDEF0123456789ABCDEF0123456789ABCDEF01')
  assert.strictEqual(extractInfoHash({ Title: 'x' }), null)
})

test('normalizeResult maps to the shared torrent entry contract', () => {
  const entry = normalizeResult(MOVIE_FIXTURE.Results[0], { type: 'movie' })
  assert.strictEqual(entry.kind, 'torrent')
  assert.strictEqual(entry.source, SOURCE_NAME)
  assert.strictEqual(entry.url, null)
  assert.match(entry.magnet, /^magnet:\?xt=urn:btih:/)
  assert.strictEqual(entry.infoHash, '491AA0E19CBDB03B100961DB82315C08643A6139')
  assert.strictEqual(entry.quality, '1080p')
  assert.strictEqual(entry.audioLayout, '5.1')
  assert.strictEqual(entry.seeds, 1087)
  assert.strictEqual(entry.seeders, 1087)
  assert.strictEqual(entry.sizeBytes, 2166271375)
  assert.strictEqual(entry.lowQuality, false)
})

test('normalizeResult rebuilds a magnet from a hash-only result', () => {
  const entry = normalizeResult(MOVIE_FIXTURE.Results[1], { type: 'movie' })
  assert.ok(entry)
  assert.strictEqual(entry.quality, '2160p')
  assert.strictEqual(entry.audioLayout, '7.1')
  // No MagnetUri in the fixture — the magnet is assembled from the InfoHash with
  // the shared public tracker list.
  assert.match(entry.magnet, /491|A1B2C3D4E5F60718293A4B5C6D7E8F9012345678/)
  assert.match(entry.magnet, /tr=/, 'a rebuilt magnet carries the public trackers')
})

test('normalizeResult drops a link-only result (no magnet, no hash)', () => {
  // The third fixture row has only a Link (a .torrent file URL) — the streamer
  // cannot open one, so it must not become an entry.
  const entry = normalizeResult(MOVIE_FIXTURE.Results[2], { type: 'movie' })
  assert.strictEqual(entry, null)
})

test('normalizeResult flags a cam rip as low quality but still keeps it', () => {
  const entry = normalizeResult(MOVIE_FIXTURE.Results[3], { type: 'movie' })
  assert.ok(entry)
  assert.strictEqual(entry.lowQuality, true)
})

// --- provider end to end --------------------------------------------------

test('provider filters by title and year, skips link-only, sorts real encodes first', async () => {
  const provider = createJackettProvider({
    fetchFn: fetcherFor(MOVIE_FIXTURE), baseUrl: 'https://jackett.example', apiKey: 'SECRET',
  })
  const out = await provider({ type: 'movie', title: 'Oppenheimer', year: 2023 })
  // Kept: the 1080p magnet and the 2160p hash-only. Dropped: link-only (no
  // magnet), the 2019 cam (wrong year), and the unrelated 2021 film (wrong title).
  assert.strictEqual(out.length, 2)
  assert.deepStrictEqual(out.map(e => e.quality).sort(), ['1080p', '2160p'])
  for (const e of out) assert.strictEqual(e.source, 'Jackett')
  // The internal `name` field used for matching is stripped before return.
  for (const e of out) assert.strictEqual(e.name, undefined)
})

test('provider is disabled (returns []) when the url or key is missing', async () => {
  const noUrl = createJackettProvider({ fetchFn: fetcherFor(MOVIE_FIXTURE), baseUrl: '', apiKey: 'K' })
  const noKey = createJackettProvider({ fetchFn: fetcherFor(MOVIE_FIXTURE), baseUrl: 'https://x', apiKey: '' })
  assert.deepStrictEqual(await noUrl({ type: 'movie', title: 'Oppenheimer', year: 2023 }), [])
  assert.deepStrictEqual(await noKey({ type: 'movie', title: 'Oppenheimer', year: 2023 }), [])
})

test('provider returns [] for a type it does not serve, and never throws on a dead instance', async () => {
  const dead = createJackettProvider({
    fetchFn: async () => { throw new Error('ECONNREFUSED') },
    baseUrl: 'https://jackett.example', apiKey: 'SECRET',
  })
  assert.deepStrictEqual(await dead({ type: 'person', title: 'x' }), [])
  assert.deepStrictEqual(await dead({ type: 'movie', title: 'Oppenheimer', year: 2023 }), [])
})

test('provider carries a sourceName so the router health machinery buckets it', () => {
  const provider = createJackettProvider({ baseUrl: 'https://x', apiKey: 'k' })
  assert.strictEqual(provider.sourceName, 'Jackett')
})
