'use strict'
const test = require('node:test')
const assert = require('node:assert')

const {
  isFailure, normalizeRatings, normalizeAwards, normalize, buildUrl, createOmdbCatalog,
} = require('../catalog/omdb')

// Captured from the live API on 2026-08-31, trimmed to the fields used.
const GODFATHER = {
  Title: 'The Godfather',
  Year: '1972',
  Rated: 'R',
  Runtime: '175 min',
  Director: 'Francis Ford Coppola',
  Writer: 'Mario Puzo, Francis Ford Coppola',
  Country: 'United States',
  Language: 'English, Italian, Latin',
  Awards: 'Won 3 Oscars. 31 wins & 31 nominations total',
  Ratings: [
    { Source: 'Internet Movie Database', Value: '9.2/10' },
    { Source: 'Rotten Tomatoes', Value: '97%' },
    { Source: 'Metacritic', Value: '100/100' },
  ],
  Metascore: '100',
  imdbRating: '9.2',
  imdbVotes: '2,222,804',
  imdbID: 'tt0068646',
  BoxOffice: '$136,381,073',
  Response: 'True',
}

// ── Failure detection ───────────────────────────────────────────────────────
// OMDb answers a bad request with HTTP 200 and Response:'False', so the status
// code alone never tells you whether it worked. Trusting the status would turn
// every unknown title into a normalised object full of nulls.
test('a refusal is recognised even though it arrives as a success', () => {
  assert.strictEqual(isFailure({ Response: 'False', Error: 'Incorrect IMDb ID.' }), true)
  assert.strictEqual(isFailure(null), true)
  assert.strictEqual(isFailure('nope'), true)
  assert.strictEqual(isFailure(GODFATHER), false)
})

test('a refusal normalises to nothing rather than to empty fields', () => {
  assert.strictEqual(normalize({ Response: 'False', Error: 'Movie not found!' }), null)
})

// ── Ratings ─────────────────────────────────────────────────────────────────
// The three sources each use their own scale — 9.2/10, 97%, 100/100 — so they
// cannot be compared until they are on one. The original string is kept because
// "97%" is what a person recognises, and the percentage is what a bar can draw.
test('the three ratings are normalised to one scale and keep their own wording', () => {
  const r = normalizeRatings(GODFATHER.Ratings)
  assert.deepStrictEqual(r.imdb, { display: '9.2/10', percent: 92 })
  assert.deepStrictEqual(r.rottenTomatoes, { display: '97%', percent: 97 })
  assert.deepStrictEqual(r.metacritic, { display: '100/100', percent: 100 })
})

test('an unknown rating source is ignored rather than guessed at', () => {
  const r = normalizeRatings([{ Source: 'Some Blog', Value: '4 stars' }])
  assert.deepStrictEqual(r, {})
})

test('a missing ratings array is not a crash', () => {
  assert.deepStrictEqual(normalizeRatings(undefined), {})
  assert.deepStrictEqual(normalizeRatings('9/10'), {})
})

// ── Awards ──────────────────────────────────────────────────────────────────
// "Won 3 Oscars" is a stronger signal than any score, and the sentence is worth
// keeping whole — but the numbers are wanted separately for a compact badge.
test('the awards line is kept whole and its numbers pulled out', () => {
  const a = normalizeAwards(GODFATHER.Awards)
  assert.strictEqual(a.text, 'Won 3 Oscars. 31 wins & 31 nominations total')
  assert.strictEqual(a.oscars, 3)
  assert.strictEqual(a.wins, 31)
  assert.strictEqual(a.nominations, 31)
})

test('a film with nominations but no wins reads correctly', () => {
  const a = normalizeAwards('Nominated for 2 Oscars. 5 nominations total')
  assert.strictEqual(a.oscars, 0, 'nominated is not won')
  assert.strictEqual(a.nominations, 5)
})

test('no awards is nothing, not an empty badge', () => {
  assert.strictEqual(normalizeAwards('N/A'), null)
  assert.strictEqual(normalizeAwards(''), null)
  assert.strictEqual(normalizeAwards(undefined), null)
})

// ── Field parsing ───────────────────────────────────────────────────────────
// Every value arrives as a string, and "N/A" is how OMDb says nothing. Treating
// that as text puts the literal characters "N/A" on a card.
test('N/A becomes nothing, not the text "N/A"', () => {
  const d = normalize({ ...GODFATHER, Rated: 'N/A', BoxOffice: 'N/A', Awards: 'N/A' })
  assert.strictEqual(d.rated, null)
  assert.strictEqual(d.boxOffice, null)
  assert.strictEqual(d.awards, null)
})

test('numbers come back as numbers', () => {
  const d = normalize(GODFATHER)
  assert.strictEqual(d.runtime, 175, '"175 min" is a number of minutes')
  assert.strictEqual(d.imdbVotes, 2222804, 'the comma grouping is not part of the number')
  assert.strictEqual(d.boxOffice, 136381073)
  assert.strictEqual(d.imdbRating, 9.2)
  assert.strictEqual(d.metascore, 100)
})

test('the scores the card reads are hoisted to the top level', () => {
  const d = normalize(GODFATHER)
  assert.strictEqual(d.rottenTomatoes, 97)
  assert.strictEqual(d.director, 'Francis Ford Coppola')
  assert.strictEqual(d.imdbId, 'tt0068646')
})

// ── URL building ────────────────────────────────────────────────────────────
// The API key rides in the query string, so a plaintext request hands it to
// every hop on the path. OMDb serves https, so there is no reason not to.
test('requests go over https, never plaintext http', () => {
  const url = buildUrl('KEY123', { i: 'tt0068646' })
  assert.ok(url.startsWith('https://'), 'the key must not travel in the clear')
})

test('the key and query are encoded, and the long plot is never fetched', () => {
  const url = buildUrl('KEY123', { i: 'tt0068646' })
  assert.match(url, /apikey=KEY123/)
  assert.match(url, /i=tt0068646/)
  assert.match(url, /plot=short/, 'the app already has TMDB’s overview')
})

test('empty parameters are left out rather than sent blank', () => {
  const url = buildUrl('K', { t: 'Seven Samurai', y: '' })
  assert.match(url, /t=Seven\+Samurai/)
  assert.ok(!/[?&]y=/.test(url), 'an empty year must not narrow the search to nothing')
})

// ── The client ──────────────────────────────────────────────────────────────
function client (opts = {}) {
  const calls = []
  const fetchFn = opts.fetchFn || (async url => {
    calls.push(url)
    return { ok: true, json: async () => GODFATHER }
  })
  return { calls, api: createOmdbCatalog({ apiKey: 'K', fetchFn, ...opts }) }
}

test('a title is looked up by its IMDb id', async () => {
  const { calls, api } = client()
  const d = await api.byImdbId('tt0068646')
  assert.strictEqual(d.title, 'The Godfather')
  assert.match(calls[0], /i=tt0068646/)
})

// Remakes share a title far more often than they share a year.
test('the title fallback narrows by year when there is one', async () => {
  const { calls, api } = client()
  await api.byTitle('Seven Samurai', 1954)
  assert.match(calls[0], /t=Seven\+Samurai/)
  assert.match(calls[0], /y=1954/)
})

// A second opinion the user has not set up must never break the first.
test('no key means no second opinion, not an error', async () => {
  let called = false
  const api = createOmdbCatalog({ apiKey: '', fetchFn: async () => { called = true } })
  assert.strictEqual(await api.byImdbId('tt0068646'), null)
  assert.strictEqual(called, false, 'it must not even try')
})

test('a network failure is silent, because this is optional information', async () => {
  const api = createOmdbCatalog({ apiKey: 'K', fetchFn: async () => { throw new Error('offline') } })
  assert.strictEqual(await api.byImdbId('tt0068646'), null)
})

test('a non-200 response is not parsed as a result', async () => {
  const api = createOmdbCatalog({ apiKey: 'K', fetchFn: async () => ({ ok: false, json: async () => ({}) }) })
  assert.strictEqual(await api.byImdbId('tt0068646'), null)
})

test('asking for nothing does not make a request', async () => {
  const { calls, api } = client()
  assert.strictEqual(await api.byImdbId(null), null)
  assert.strictEqual(await api.byTitle(''), null)
  assert.strictEqual(calls.length, 0)
})

// Every card on a shelf may want this. Without a cache one scroll is fifty
// requests to a free service with a daily limit.
test('repeated lookups are served from the cache', async () => {
  const store = new Map()
  const cache = { get: k => store.get(k), set: (k, v) => store.set(k, v) }
  const { calls, api } = client({ cache })
  await api.byImdbId('tt0068646')
  await api.byImdbId('tt0068646')
  assert.strictEqual(calls.length, 1, 'the second lookup must not hit the network')
})

// A film OMDb has never heard of is cached as "nothing" too, or every shelf
// render asks again for the same missing title.
test('a miss is cached as well, so it is not asked for repeatedly', async () => {
  const store = new Map()
  const cache = { get: k => store.get(k), set: (k, v) => store.set(k, v) }
  let hits = 0
  const api = createOmdbCatalog({
    apiKey: 'K',
    cache,
    fetchFn: async () => { hits++; return { ok: true, json: async () => ({ Response: 'False' }) } },
  })
  assert.strictEqual(await api.byImdbId('tt0000001'), null)
  assert.strictEqual(await api.byImdbId('tt0000001'), null)
  assert.strictEqual(hits, 1)
})

// "Request limit reached!" is the free tier's daily cap, not a fact about the
// title. Caching that null would keep the answer wrong until restart, long
// after the limit resets.
test('a rate-limited miss is not cached, so the next lookup asks again', async () => {
  const store = new Map()
  const cache = { get: k => store.get(k), set: (k, v) => store.set(k, v) }
  let hits = 0
  const api = createOmdbCatalog({
    apiKey: 'K',
    cache,
    fetchFn: async () => {
      hits++
      if (hits === 1) return { ok: true, json: async () => ({ Response: 'False', Error: 'Request limit reached!' }) }
      return { ok: true, json: async () => GODFATHER }
    },
  })
  assert.strictEqual(await api.byImdbId('tt0068646'), null, 'the limit still means no answer now')
  const second = await api.byImdbId('tt0068646')
  assert.strictEqual(hits, 2, 'the limited miss must not be served from the cache')
  assert.strictEqual(second.title, 'The Godfather')
})

// ── The TMDB-down fallback ───────────────────────────────────────────────────
// When TMDB is unreachable there is no base to enrich, so OMDb has to stand in
// for the whole detail. detailFromOmdb reshapes OMDb's answer into the small
// subset of the TMDB detail shape the hero reads — same key names and types, so
// it drops in where a TMDB entry was expected.
const GODFATHER_FULL = {
  ...GODFATHER,
  Plot: 'The aging patriarch of an organized crime dynasty transfers control…',
  Poster: 'https://m.media-amazon.com/images/M/poster.jpg',
}

test('the fallback detail is shaped like the TMDB entry the hero reads', async () => {
  const calls = []
  const api = createOmdbCatalog({
    apiKey: 'K',
    fetchFn: async url => { calls.push(url); return { ok: true, json: async () => GODFATHER_FULL } },
  })
  const d = await api.detailFromOmdb('tt0068646')
  assert.deepStrictEqual(d, {
    title: 'The Godfather',
    year: '1972',
    overview: 'The aging patriarch of an organized crime dynasty transfers control…',
    poster: 'https://m.media-amazon.com/images/M/poster.jpg',
    rating: 9.2,
    imdbId: 'tt0068646',
    runtime: 175,
  })
})

// The whole point of the fallback is the detail the hero shows; the short plot
// the enrichment path uses would leave it with a truncated overview.
test('the fallback asks for the full plot, not the short one', async () => {
  const calls = []
  const api = createOmdbCatalog({
    apiKey: 'K',
    fetchFn: async url => { calls.push(url); return { ok: true, json: async () => GODFATHER_FULL } },
  })
  await api.detailFromOmdb('tt0068646')
  assert.match(calls[0], /plot=full/, 'the standalone detail wants the whole synopsis')
  assert.match(calls[0], /i=tt0068646/, 'an id is looked up by id')
})

// A detail opened from a search may only have a name, not an id, so the same
// call has to accept a title too — narrowed by year exactly as byTitle is.
test('the fallback takes a title and year when there is no IMDb id', async () => {
  const calls = []
  const api = createOmdbCatalog({
    apiKey: 'K',
    fetchFn: async url => { calls.push(url); return { ok: true, json: async () => GODFATHER_FULL } },
  })
  await api.detailFromOmdb('Seven Samurai', 1954)
  assert.match(calls[0], /t=Seven\+Samurai/, 'a non-id argument is a title search')
  assert.match(calls[0], /y=1954/)
  assert.ok(!/[?&]i=/.test(calls[0]), 'a title is not sent as an id')
})

// Missing fields come back as null, never as a half-object the caller has to
// guard field by field.
test('the fallback fills absent fields with null, not junk', async () => {
  const api = createOmdbCatalog({
    apiKey: 'K',
    fetchFn: async () => ({ ok: true, json: async () => ({
      Response: 'True', Title: 'Obscure Film', Year: '1980',
      Plot: 'N/A', Poster: 'N/A', imdbRating: 'N/A', Runtime: 'N/A', imdbID: 'tt9999999',
    }) }),
  })
  const d = await api.detailFromOmdb('tt9999999')
  assert.strictEqual(d.title, 'Obscure Film')
  assert.strictEqual(d.overview, null, 'N/A is nothing, not the text "N/A"')
  assert.strictEqual(d.poster, null)
  assert.strictEqual(d.rating, null)
  assert.strictEqual(d.runtime, null)
})

test('the fallback is null when OMDb has nothing, and never even asks for nothing', async () => {
  let hits = 0
  const api = createOmdbCatalog({
    apiKey: 'K',
    fetchFn: async () => { hits++; return { ok: true, json: async () => ({ Response: 'False', Error: 'Movie not found!' }) } },
  })
  assert.strictEqual(await api.detailFromOmdb('tt0000001'), null)
  assert.strictEqual(await api.detailFromOmdb(''), null, 'an empty argument is not a request')
  assert.strictEqual(await api.detailFromOmdb(null), null)
  assert.strictEqual(hits, 1, 'only the real lookup hit the network')
})
