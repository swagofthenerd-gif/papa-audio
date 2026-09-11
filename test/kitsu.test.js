'use strict'
// Kitsu is the third rung of the anime fallback (behind AniList and Jikan): when
// both AniList and MyAnimeList are down its answers have to reshape into the exact
// entry shape AniList's normalizeMedia produces, or every read site downstream
// needs a third code path. These tests pin that shape, the defensive nulls, the
// status/subtype vocabulary mapping, the 0-100-string → 0-10 score conversion,
// the bracket-encoded URL builders, the rate-limit serialisation, and the
// never-throw contract — the same battery jikan.test.js runs on the second rung.
const test = require('node:test')
const assert = require('node:assert')

const {
  scoreTo10, normalizeMedia, buildSearchUrl, buildByIdUrl,
  buildTrendingUrl, _kitsuIdOf, createKitsuCatalog,
} = require('../catalog/kitsu')

// A trimmed but faithful copy of a LIVE kitsu.io/api/edge/anime/47278 response
// (Tokyo Revengers: Tenjiku-hen, S3), fetched 2026-09-11 during the double
// outage this rung is for. A Kitsu resource is { id, type, attributes:{...} };
// the interesting fields all live under attributes.
const TENJIKU = {
  id: '47278',
  type: 'anime',
  attributes: {
    slug: 'tokyo-revengers-tenjikuhen',
    synopsis: 'The third season of Tokyo Revengers.',
    description: 'The third season of Tokyo Revengers.',
    titles: {
      en: 'Tokyo Revengers: Tenjiku',
      en_jp: 'Tokyo Revengers: Tenjiku-hen',
      ja_jp: '東京リベンジャーズ 天竺編',
    },
    canonicalTitle: 'Tokyo Revengers: Tenjiku-hen',
    averageRating: '79.92',
    startDate: '2023-10-03',
    endDate: '2023-12-27',
    subtype: 'TV',
    status: 'finished',
    posterImage: {
      tiny: 'https://media.kitsu.app/anime/47278/poster_image/tiny.jpeg',
      small: 'https://media.kitsu.app/anime/47278/poster_image/small.jpeg',
      medium: 'https://media.kitsu.app/anime/47278/poster_image/medium.jpeg',
      large: 'https://media.kitsu.app/anime/47278/poster_image/large.jpeg',
      original: 'https://media.kitsu.app/anime/47278/poster_image/orig.jpg',
    },
    coverImage: {
      tiny: 'https://media.kitsu.app/anime/47278/cover_image/tiny.jpeg',
      small: 'https://media.kitsu.app/anime/47278/cover_image/small.jpeg',
      large: 'https://media.kitsu.app/anime/47278/cover_image/large.jpeg',
      original: 'https://media.kitsu.app/anime/47278/cover_image/orig.png',
    },
    episodeCount: 13,
    youtubeVideoId: 'OTlNyYfkM1s',
  },
}

// ── Normalisation to the AniList entry shape ─────────────────────────────────
// The reshape is the whole reason this module exists: a Kitsu entry has to be
// indistinguishable from an AniList or a Jikan one at every read site.
test('a Kitsu anime is reshaped into the AniList entry shape', () => {
  const e = normalizeMedia(TENJIKU)
  assert.strictEqual(e.type, 'anime')
  // A fallback card carries no AniList id; its `id` is the routable `kitsu-<id>`
  // card key the detail router recognises, mirroring jikan.js's `mal-` key.
  assert.strictEqual(e.id, 'kitsu-47278')
  assert.strictEqual(e.source, 'kitsu', 'the card is marked as a Kitsu fallback')
  // Kitsu carries no MAL id inline, so idMal is null — the same null a MAL-less
  // AniList entry carries.
  assert.strictEqual(e.idMal, null)
  // Display pick mirrors AniList: english, then romaji, then native.
  assert.strictEqual(e.title, 'Tokyo Revengers: Tenjiku')
  assert.strictEqual(e.year, 2023)
  assert.strictEqual(e.overview, 'The third season of Tokyo Revengers.')
  assert.strictEqual(e.episodeCount, 13)
})

// Kitsu's en_jp is the romaji transliteration fansub groups release under — the
// field a torrent indexer actually needs — so it fills the romaji slot, not the
// english one.
test('Kitsu\'s en_jp becomes romaji, the field an indexer searches on', () => {
  const e = normalizeMedia(TENJIKU)
  assert.deepStrictEqual(e.titles, {
    english: 'Tokyo Revengers: Tenjiku',
    romaji: 'Tokyo Revengers: Tenjiku-hen',
    native: '東京リベンジャーズ 天竺編',
  })
})

// canonicalTitle is the romaji last resort when en_jp is missing.
test('canonicalTitle fills the romaji slot when en_jp is absent', () => {
  const e = normalizeMedia({ id: '1', attributes: {
    titles: { en: 'X', ja_jp: 'エックス' }, canonicalTitle: 'Ekkusu' } })
  assert.strictEqual(e.titles.romaji, 'Ekkusu')
})

test('the Kitsu subtype and status enums map onto AniList\'s vocabulary', () => {
  const s = (subtype, status) => normalizeMedia({ id: '1', attributes: { subtype, status } })
  assert.strictEqual(s('TV', 'finished').format, 'TV')
  assert.strictEqual(s('movie').format, 'MOVIE')
  assert.strictEqual(s('ONA').format, 'ONA')
  assert.strictEqual(s('special').format, 'SPECIAL')
  assert.strictEqual(s('music').format, 'MUSIC')
  assert.strictEqual(s(null, 'current').status, 'RELEASING')
  assert.strictEqual(s(null, 'finished').status, 'FINISHED')
  // upcoming, tba and unreleased all mean "announced but not aired".
  assert.strictEqual(s(null, 'upcoming').status, 'NOT_YET_RELEASED')
  assert.strictEqual(s(null, 'tba').status, 'NOT_YET_RELEASED')
  assert.strictEqual(s(null, 'unreleased').status, 'NOT_YET_RELEASED')
  // An unknown subtype survives uppercased rather than being dropped.
  assert.strictEqual(s('PV').format, 'PV')
  // An unknown status has no AniList equivalent, so it is null, not a guess.
  assert.strictEqual(s(null, 'hiatus').status, null)
})

// Kitsu's averageRating is a 0-100 STRING ("79.92"); the app works in 0-10, so
// it divides by ten and rounds — matching AniList's scoreTo10 exactly. The
// not-yet-rated sentinels are rejected to null rather than shown as a real zero.
test('the Kitsu rating string is converted to the app\'s 0-10 scale, unrated is null', () => {
  assert.strictEqual(scoreTo10('79.92'), 8)
  assert.strictEqual(scoreTo10('82.16'), 8.2)
  assert.strictEqual(scoreTo10(0), null, 'an unrated title is not a zero')
  assert.strictEqual(scoreTo10('0'), null)
  assert.strictEqual(scoreTo10(null), null)
  assert.strictEqual(scoreTo10(''), null)
  const e = normalizeMedia(TENJIKU)
  assert.strictEqual(e.rating, 8)
  // The raw 0-100 value is kept as a number, not the string, for the key.
  assert.strictEqual(e.scoreRaw, 79.92)
})

test('the large poster wins, and the large cover is the backdrop', () => {
  const e = normalizeMedia(TENJIKU)
  assert.strictEqual(e.poster, 'https://media.kitsu.app/anime/47278/poster_image/large.jpeg')
  // Unlike MAL, Kitsu HAS banner art (coverImage) — the backdrop is not the poster.
  assert.strictEqual(e.backdrop, 'https://media.kitsu.app/anime/47278/cover_image/large.jpeg')
  assert.notStrictEqual(e.backdrop, e.poster, 'Kitsu carries real cover art')
})

// When there is no cover, the poster stands in for the backdrop, exactly as
// jikan.js does for its always-absent banner.
test('the poster stands in for the backdrop when there is no cover image', () => {
  const e = normalizeMedia({ id: '1', attributes: {
    posterImage: { large: 'https://x/poster.jpg' } } })
  assert.strictEqual(e.backdrop, 'https://x/poster.jpg')
})

test('a YouTube trailer is shaped like AniList\'s so the player opens it the same way', () => {
  assert.deepStrictEqual(normalizeMedia(TENJIKU).trailer, { id: 'OTlNyYfkM1s', site: 'youtube' })
  assert.strictEqual(normalizeMedia({ id: '1', attributes: { youtubeVideoId: null } }).trailer, null)
})

test('the year comes from startDate', () => {
  assert.strictEqual(normalizeMedia({ id: '1', attributes: { startDate: '1998-04-03' } }).year, 1998)
  assert.strictEqual(normalizeMedia({ id: '1', attributes: { startDate: null } }).year, null)
})

// ── Defensive: malformed data never throws ───────────────────────────────────
test('a malformed or empty resource yields nulls and empty arrays, never a throw', () => {
  const e = normalizeMedia({})
  assert.strictEqual(e.id, null)
  assert.strictEqual(e.idMal, null)
  assert.strictEqual(e.title, null)
  assert.strictEqual(e.year, null)
  assert.strictEqual(e.poster, null)
  assert.strictEqual(e.backdrop, null)
  assert.strictEqual(e.rating, null)
  assert.strictEqual(e.scoreRaw, null)
  assert.strictEqual(e.format, null)
  assert.strictEqual(e.trailer, null)
  assert.deepStrictEqual(e.genres, [])
  assert.strictEqual(e.episodeCount, null)
  assert.strictEqual(e.status, null)
  // The source mark is always present — it is what tells a read site this is a
  // Kitsu card, not an AniList one.
  assert.strictEqual(e.source, 'kitsu')
  // Utterly garbage input is still not a crash.
  assert.doesNotThrow(() => normalizeMedia(null))
  assert.doesNotThrow(() => normalizeMedia({ attributes: 'nope' }))
  assert.doesNotThrow(() => normalizeMedia({ id: '1', attributes: {
    titles: 5, posterImage: 'nope', coverImage: 7, youtubeVideoId: 9 } }))
})

// The normalized entry must be INDISTINGUISHABLE in shape from jikan.js's and
// anilist.js's output — same keys, in the same spirit. This pins full key parity.
test('a Kitsu card has full AniList/Jikan key parity', () => {
  const keys = ['id', 'source', 'type', 'idMal', 'title', 'titles', 'year',
    'poster', 'backdrop', 'overview', 'rating', 'scoreRaw', 'format', 'trailer',
    'genres', 'episodeCount', 'status']
  const e = normalizeMedia(TENJIKU)
  assert.deepStrictEqual(Object.keys(e).sort(), keys.slice().sort())
})

// ── URL building ─────────────────────────────────────────────────────────────
test('search asks the anime endpoint with a bracket-encoded filter[text]', () => {
  const url = buildSearchUrl('cowboy bebop')
  assert.match(url, /\/api\/edge\/anime\?/)
  // URLSearchParams brackets-encodes filter[text] to filter%5Btext%5D.
  assert.match(url, /filter%5Btext%5D=cowboy\+bebop/)
  assert.match(url, /page%5Blimit%5D=20/, 'a modest page cap, like the Jikan search')
})

test('byId targets the anime detail endpoint', () => {
  assert.strictEqual(buildByIdUrl(47278), 'https://kitsu.io/api/edge/anime/47278')
})

test('the trending shelf URL hits /trending/anime with a limit', () => {
  assert.strictEqual(buildTrendingUrl(), 'https://kitsu.io/api/edge/trending/anime?limit=20')
  assert.strictEqual(buildTrendingUrl({ limit: 5 }), 'https://kitsu.io/api/edge/trending/anime?limit=5')
})

// The detail router hands byId either a raw Kitsu id or the card's own
// `kitsu-<id>` key. Both must resolve to the numeric id; anything else is null.
test('_kitsuIdOf accepts a raw id or a kitsu- card key, and rejects the rest', () => {
  assert.strictEqual(_kitsuIdOf(47278), 47278)
  assert.strictEqual(_kitsuIdOf('47278'), 47278)
  assert.strictEqual(_kitsuIdOf('kitsu-47278'), 47278)
  assert.strictEqual(_kitsuIdOf('kitsu-0'), null, 'a zero id is not a real Kitsu id')
  assert.strictEqual(_kitsuIdOf('mal-47278'), null, 'a MAL card key is not a Kitsu id')
  assert.strictEqual(_kitsuIdOf('anime'), null)
  assert.strictEqual(_kitsuIdOf(null), null)
  assert.strictEqual(_kitsuIdOf(''), null)
})

// ── The client ───────────────────────────────────────────────────────────────
function client(opts = {}) {
  const calls = []
  const fetchFn = opts.fetchFn || (async (url, o) => {
    calls.push({ url, opts: o, at: Date.now() })
    return { ok: true, json: async () => ({ data: opts.byId ? TENJIKU : [TENJIKU] }) }
  })
  return { calls, api: createKitsuCatalog({ fetchFn, minIntervalMs: opts.minIntervalMs ?? 0 }) }
}

test('search returns a list of normalized entries', async () => {
  const { api } = client()
  const list = await api.search('tokyo revengers')
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].id, 'kitsu-47278')
  assert.strictEqual(list[0].title, 'Tokyo Revengers: Tenjiku')
})

// Kitsu answers 406 without the JSON:API Accept header, so it must be sent on
// every request.
test('every request carries the JSON:API Accept header', async () => {
  const { calls, api } = client()
  await api.search('x')
  assert.strictEqual(calls[0].opts.headers.Accept, 'application/vnd.api+json')
})

test('byId returns one normalized entry', async () => {
  const { api } = client({ byId: true })
  const one = await api.byId(47278)
  assert.strictEqual(one.id, 'kitsu-47278')
  assert.strictEqual(one.source, 'kitsu')
})

// byId is what the detail router calls with the card's OWN id ("kitsu-47278"),
// not a bare number — so it must strip the prefix and still hit /anime/47278.
test('byId accepts the card\'s kitsu- key and requests the numeric detail endpoint', async () => {
  const { calls, api } = client({ byId: true })
  const one = await api.byId('kitsu-47278')
  assert.strictEqual(one.id, 'kitsu-47278')
  assert.strictEqual(calls[0].url, 'https://kitsu.io/api/edge/anime/47278')
})

// byId's JSON:API response is a single object under data, not an array — a list
// there is not a valid detail and must not be normalized as one.
test('byId returns null when data is an array, not a single resource', async () => {
  const api = createKitsuCatalog({
    fetchFn: async () => ({ ok: true, json: async () => ({ data: [TENJIKU] }) }),
    minIntervalMs: 0,
  })
  assert.strictEqual(await api.byId(47278), null)
})

test('trending returns marked, AniList-shaped cards', async () => {
  const { calls, api } = client()
  const list = await api.trending()
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].source, 'kitsu')
  assert.strictEqual(list[0].id, 'kitsu-47278')
  assert.match(calls[0].url, /\/trending\/anime/)
})

// A dead or rate-limited Kitsu must leave a shelf empty, never throw — it is the
// third source, and the caller falls through to the saved cache.
test('a shelf degrades to an empty list on failure, never throws', async () => {
  const down = createKitsuCatalog({ fetchFn: async () => ({ ok: false, status: 503, json: async () => ({}) }), minIntervalMs: 0 })
  assert.deepStrictEqual(await down.trending(), [])
  assert.deepStrictEqual(await down.search('x'), [])
})

test('an empty query or id makes no request', async () => {
  const { calls, api } = client()
  assert.deepStrictEqual(await api.search(''), [])
  assert.strictEqual(await api.byId(null), null)
  assert.strictEqual(calls.length, 0)
})

// The fallback exists to keep the app moving when AniList AND MyAnimeList are
// down; it must not itself become a thing that throws or hangs.
test('a network failure is silent — an empty list from search, null from byId', async () => {
  const api = createKitsuCatalog({ fetchFn: async () => { throw new Error('offline') }, minIntervalMs: 0 })
  assert.deepStrictEqual(await api.search('x'), [])
  assert.strictEqual(await api.byId(1), null)
})

test('a 406 or non-200 is treated as nothing, not parsed', async () => {
  const api = createKitsuCatalog({ fetchFn: async () => ({ ok: false, status: 406, json: async () => ({}) }), minIntervalMs: 0 })
  assert.deepStrictEqual(await api.search('x'), [])
  assert.strictEqual(await api.byId(1), null)
})

test('a response missing its data is an empty list, not a crash', async () => {
  const api = createKitsuCatalog({ fetchFn: async () => ({ ok: true, json: async () => ({}) }), minIntervalMs: 0 })
  assert.deepStrictEqual(await api.search('x'), [])
  assert.deepStrictEqual(await api.trending(), [])
  assert.strictEqual(await api.byId(1), null)
})

// ── lastFailure ──────────────────────────────────────────────────────────────
// The search fallback chain has to tell "Kitsu is down" apart from "Kitsu
// healthily found nothing" to report an honest outage instead of a misleading
// "no results". Same convention as catalog/anilist.js and catalog/jikan.js.
test('a swallowed failure is recorded in lastFailure and cleared by a success', async () => {
  let fail = true
  const api = createKitsuCatalog({
    fetchFn: async () => fail
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, json: async () => ({ data: [] }) },
    minIntervalMs: 0,
  })
  assert.strictEqual(api.lastFailure(), null)
  await api.search('tokyo revengers')
  assert.strictEqual(api.lastFailure().status, 503)
  assert.strictEqual(api.lastFailure().message, 'HTTP 503')
  fail = false
  await api.search('tokyo revengers')
  assert.strictEqual(api.lastFailure(), null)
})

test('a thrown network error records lastFailure with its message', async () => {
  const api = createKitsuCatalog({ fetchFn: async () => { throw new Error('offline') }, minIntervalMs: 0 })
  await api.search('x')
  assert.strictEqual(api.lastFailure().message, 'offline')
  assert.strictEqual(api.lastFailure().status, null)
})

// ── Rate-limit serialisation ─────────────────────────────────────────────────
// Several lookups fired without awaiting between them must not go out closer
// together than the courtesy interval — the same one-lane discipline jikan.js
// keeps, so one mental model covers both.
test('back-to-back calls are spaced by at least the interval', async () => {
  const at = []
  const api = createKitsuCatalog({
    minIntervalMs: 60,
    fetchFn: async () => { at.push(Date.now()); return { ok: true, json: async () => ({ data: [] }) } },
  })
  await Promise.all([api.search('a'), api.search('b'), api.search('c')])
  assert.strictEqual(at.length, 3)
  assert.ok(at[1] - at[0] >= 55, `second call waited the interval (was ${at[1] - at[0]}ms)`)
  assert.ok(at[2] - at[1] >= 55, `third call waited the interval (was ${at[2] - at[1]}ms)`)
})

// A rejection in the lane must not wedge it: the next queued call still runs.
test('one failed request does not wedge the queue behind it', async () => {
  let n = 0
  const api = createKitsuCatalog({
    minIntervalMs: 0,
    fetchFn: async () => {
      n++
      if (n === 1) throw new Error('boom')
      return { ok: true, json: async () => ({ data: [TENJIKU] }) }
    },
  })
  const [first, second] = await Promise.all([api.search('a'), api.search('b')])
  assert.deepStrictEqual(first, [], 'the failed one degraded to empty')
  assert.strictEqual(second.length, 1, 'the one behind it still ran')
})
