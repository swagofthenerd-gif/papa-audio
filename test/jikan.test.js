'use strict'
// Jikan is the AniList stand-in: when AniList is down its answers have to reshape
// into the exact entry shape AniList's normalizeMedia produces, or every read
// site downstream needs a second code path. These tests pin that shape, the
// defensive nulls, the rate-limit serialisation, and the never-throw contract.
const test = require('node:test')
const assert = require('node:assert')

const {
  scoreTo10, normalizeMedia, buildSearchUrl, buildByIdUrl,
  buildTopUrl, buildSeasonNowUrl, _malIdOf, createJikanCatalog,
} = require('../catalog/jikan')

// Trimmed from a live api.jikan.moe/v4/anime/52991 (Frieren) response.
const FRIEREN = {
  mal_id: 52991,
  title: 'Sousou no Frieren',
  title_english: 'Frieren: Beyond Journey\'s End',
  title_japanese: '葬送のフリーレン',
  type: 'TV',
  episodes: 28,
  status: 'Finished Airing',
  score: 9.31,
  synopsis: 'During their decade-long quest to defeat the Demon King…',
  year: 2023,
  images: {
    jpg: { image_url: 'https://cdn.myanimelist.net/images/anime/small.jpg', large_image_url: 'https://cdn.myanimelist.net/images/anime/large.jpg' },
    webp: { large_image_url: 'https://cdn.myanimelist.net/images/anime/large.webp' },
  },
  trailer: { youtube_id: ' nShHzT_r_dc'.trim() },
  genres: [{ mal_id: 2, name: 'Adventure' }, { mal_id: 10, name: 'Fantasy' }],
}

// ── Normalisation to the AniList entry shape ─────────────────────────────────
// The reshape is the whole reason this module exists: a Jikan entry has to be
// indistinguishable from an AniList one at every read site.
test('a MAL anime is reshaped into the AniList entry shape', () => {
  const e = normalizeMedia(FRIEREN)
  assert.strictEqual(e.type, 'anime')
  // A fallback card carries no AniList id; its `id` is the routable `mal-<id>`
  // card key the detail router recognises, and idMal is the one AniSkip keys on.
  assert.strictEqual(e.id, 'mal-52991')
  assert.strictEqual(e.source, 'mal', 'the card is marked as a MAL fallback')
  assert.strictEqual(e.idMal, 52991)
  // Display pick mirrors AniList: english, then romaji, then native.
  assert.strictEqual(e.title, 'Frieren: Beyond Journey\'s End')
  assert.strictEqual(e.year, 2023)
  assert.strictEqual(e.overview, 'During their decade-long quest to defeat the Demon King…')
  assert.strictEqual(e.episodeCount, 28)
  assert.deepStrictEqual(e.genres, ['Adventure', 'Fantasy'])
})

// MAL's plain `title` is the romaji transliteration fansub groups release
// under — the field a torrent indexer actually needs — so it fills the romaji
// slot, not the english one.
test('MAL\'s plain title becomes romaji, the field an indexer searches on', () => {
  const e = normalizeMedia(FRIEREN)
  assert.deepStrictEqual(e.titles, {
    english: 'Frieren: Beyond Journey\'s End',
    romaji: 'Sousou no Frieren',
    native: '葬送のフリーレン',
  })
})

test('the MAL type and status enums map onto AniList\'s vocabulary', () => {
  assert.strictEqual(normalizeMedia({ type: 'TV', status: 'Finished Airing' }).format, 'TV')
  assert.strictEqual(normalizeMedia({ type: 'Movie' }).format, 'MOVIE')
  assert.strictEqual(normalizeMedia({ type: 'ONA' }).format, 'ONA')
  assert.strictEqual(normalizeMedia({ status: 'Currently Airing' }).status, 'RELEASING')
  assert.strictEqual(normalizeMedia({ status: 'Not yet aired' }).status, 'NOT_YET_RELEASED')
  // An unknown format survives uppercased rather than being dropped.
  assert.strictEqual(normalizeMedia({ type: 'PV' }).format, 'PV')
  // An unknown status has no AniList equivalent, so it is null, not a guess.
  assert.strictEqual(normalizeMedia({ status: 'Hiatus' }).status, null)
})

// MAL scores are already 0-10, the app's scale — unlike AniList's 0-100 — so
// they pass through, only the not-yet-rated sentinels being rejected.
test('the MAL score is kept on the app\'s 0-10 scale, and an unrated title is null', () => {
  assert.strictEqual(scoreTo10(9.31), 9.3)
  assert.strictEqual(scoreTo10(0), null, 'an unrated title is not a zero')
  assert.strictEqual(scoreTo10(null), null)
  assert.strictEqual(scoreTo10(''), null)
  assert.strictEqual(normalizeMedia(FRIEREN).rating, 9.3)
})

test('webp poster wins over jpg, and stands in for the missing backdrop', () => {
  const e = normalizeMedia(FRIEREN)
  assert.strictEqual(e.poster, 'https://cdn.myanimelist.net/images/anime/large.webp')
  assert.strictEqual(e.backdrop, e.poster, 'MAL has no banner art')
})

test('a YouTube trailer is shaped like AniList\'s so the player opens it the same way', () => {
  assert.deepStrictEqual(normalizeMedia(FRIEREN).trailer, { id: 'nShHzT_r_dc', site: 'youtube' })
  assert.strictEqual(normalizeMedia({ trailer: {} }).trailer, null, 'no youtube id, no trailer')
})

// A partial payload reads year from aired.prop.from.year when the top-level
// field is absent (older/search shapes only carry it there).
test('the year falls back to the aired range when the top-level field is gone', () => {
  const e = normalizeMedia({ mal_id: 1, aired: { prop: { from: { year: 1998 } } } })
  assert.strictEqual(e.year, 1998)
})

// ── Defensive: malformed data never throws ───────────────────────────────────
test('a malformed or empty object yields nulls and empty arrays, never a throw', () => {
  const e = normalizeMedia({})
  assert.strictEqual(e.idMal, null)
  assert.strictEqual(e.title, null)
  assert.strictEqual(e.year, null)
  assert.strictEqual(e.poster, null)
  assert.strictEqual(e.rating, null)
  assert.strictEqual(e.format, null)
  assert.strictEqual(e.trailer, null)
  assert.deepStrictEqual(e.genres, [])
  assert.strictEqual(e.episodeCount, null)
  // Utterly garbage input is still not a crash.
  assert.doesNotThrow(() => normalizeMedia(null))
  assert.doesNotThrow(() => normalizeMedia({ genres: 'not an array', images: 'nope', trailer: 5 }))
})

// ── URL building ─────────────────────────────────────────────────────────────
test('search asks the anime endpoint, sfw, with an encoded query', () => {
  const url = buildSearchUrl('cowboy bebop')
  assert.match(url, /\/v4\/anime\?/)
  assert.match(url, /q=cowboy\+bebop/)
  assert.match(url, /sfw=true/, 'no adult titles by default, matching the AniList catalog')
})

test('byId targets the anime detail endpoint', () => {
  assert.strictEqual(buildByIdUrl(52991), 'https://api.jikan.moe/v4/anime/52991')
})

// The shelf endpoints are deliberately spare: MAL's upstream 504s on `limit` and
// `sfw` for /top and /seasons (observed live during an AniList outage), and those
// lists do not surface adult titles at the top by default, so only `page`/`filter`
// are sent. This pins that — a regression that re-adds limit/sfw would break the
// fallback exactly when it is needed.
test('the trending/popular shelf URL sends only page and filter — never limit or sfw', () => {
  assert.strictEqual(buildTopUrl(), 'https://api.jikan.moe/v4/top/anime')
  assert.strictEqual(buildTopUrl({ page: 2 }), 'https://api.jikan.moe/v4/top/anime?page=2')
  const pop = buildTopUrl({ page: 1, filter: 'bypopularity' })
  assert.match(pop, /filter=bypopularity/)
  assert.match(pop, /page=1/)
  assert.doesNotMatch(buildTopUrl({ page: 1 }), /limit=/, 'limit 504s on MAL upstream today')
  assert.doesNotMatch(buildTopUrl({ page: 1 }), /sfw=/, 'sfw 504s on MAL upstream today')
})

test('the season-now shelf URL sends only page — never limit or sfw', () => {
  assert.strictEqual(buildSeasonNowUrl(), 'https://api.jikan.moe/v4/seasons/now')
  assert.strictEqual(buildSeasonNowUrl({ page: 3 }), 'https://api.jikan.moe/v4/seasons/now?page=3')
  assert.doesNotMatch(buildSeasonNowUrl({ page: 1 }), /limit=|sfw=/)
})

// The detail router hands byId either a raw MAL id or the card's own `mal-<id>`
// key. Both must resolve to the numeric id; anything else is null (no request).
test('_malIdOf accepts a raw id or a mal- card key, and rejects the rest', () => {
  assert.strictEqual(_malIdOf(52991), 52991)
  assert.strictEqual(_malIdOf('52991'), 52991)
  assert.strictEqual(_malIdOf('mal-52991'), 52991)
  assert.strictEqual(_malIdOf('mal-0'), null, 'a zero id is not a real MAL id')
  assert.strictEqual(_malIdOf('anime'), null)
  assert.strictEqual(_malIdOf(null), null)
  assert.strictEqual(_malIdOf(''), null)
})

// ── The client ───────────────────────────────────────────────────────────────
function client(opts = {}) {
  const calls = []
  const fetchFn = opts.fetchFn || (async (url) => {
    calls.push({ url, at: Date.now() })
    return { ok: true, json: async () => ({ data: opts.byId ? FRIEREN : [FRIEREN] }) }
  })
  // A near-zero interval keeps the rate-limit tests fast while still exercising
  // the serialisation lane; the ordering tests set their own.
  return { calls, api: createJikanCatalog({ fetchFn, minIntervalMs: opts.minIntervalMs ?? 0 }) }
}

test('search returns a list of normalized entries', async () => {
  const { api } = client()
  const list = await api.search('frieren')
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].idMal, 52991)
  assert.strictEqual(list[0].title, 'Frieren: Beyond Journey\'s End')
})

test('byId returns one normalized entry', async () => {
  const { api } = client({ byId: true })
  const one = await api.byId(52991)
  assert.strictEqual(one.idMal, 52991)
  // The card the shelf renders carries a routable id and its MAL source mark.
  assert.strictEqual(one.id, 'mal-52991')
  assert.strictEqual(one.source, 'mal')
})

// byId is what the detail router calls with the card's OWN id ("mal-52991"), not
// a bare number — so it must strip the prefix and still hit /anime/52991.
test('byId accepts the card\'s mal- key and requests the numeric detail endpoint', async () => {
  const { calls, api } = client({ byId: true })
  const one = await api.byId('mal-52991')
  assert.strictEqual(one.idMal, 52991)
  assert.strictEqual(calls[0].url, 'https://api.jikan.moe/v4/anime/52991')
})

// The three shelves reshape MAL's list endpoints into the same marked cards, so a
// shelf can drop them where AniList entries were expected. This is the mapping the
// fallback depends on.
test('top/popular/seasonNow return marked, AniList-shaped cards', async () => {
  const { calls, api } = client()  // default fetch returns { data: [FRIEREN] } for lists
  const anilistKeys = ['id', 'type', 'idMal', 'title', 'titles', 'year', 'poster',
    'backdrop', 'overview', 'rating', 'scoreRaw', 'format', 'trailer', 'genres',
    'episodeCount', 'status']
  for (const [method, path] of [['top', '/top/anime'], ['popular', '/top/anime'], ['seasonNow', '/seasons/now']]) {
    calls.length = 0
    const list = await api[method](1)
    assert.strictEqual(list.length, 1, `${method} returns cards`)
    assert.strictEqual(list[0].source, 'mal', `${method} cards are MAL-marked`)
    assert.strictEqual(list[0].id, 'mal-52991', `${method} cards carry a routable id`)
    assert.ok(anilistKeys.every(k => k in list[0]), `${method} card has full AniList key parity`)
    assert.match(calls[0].url, new RegExp(path.replace(/\//g, '\\/')), `${method} hits ${path}`)
  }
  // popular carries the bypopularity filter; top does not.
  calls.length = 0; await api.popular(1)
  assert.match(calls[0].url, /filter=bypopularity/)
  calls.length = 0; await api.top(1)
  assert.doesNotMatch(calls[0].url, /filter=/)
})

// A dead or rate-limited Jikan must leave a shelf empty, never throw — it is the
// second source behind AniList, and the caller falls through to the saved cache.
test('a shelf degrades to an empty list on failure, never throws', async () => {
  const down = createJikanCatalog({ fetchFn: async () => ({ ok: false, status: 504, json: async () => ({}) }), minIntervalMs: 0 })
  assert.deepStrictEqual(await down.top(1), [])
  assert.deepStrictEqual(await down.popular(1), [])
  assert.deepStrictEqual(await down.seasonNow(1), [])
})

test('an empty query or id makes no request', async () => {
  const { calls, api } = client()
  assert.deepStrictEqual(await api.search(''), [])
  assert.strictEqual(await api.byId(null), null)
  assert.strictEqual(calls.length, 0)
})

// The fallback exists to keep the app moving when AniList is down; it must not
// itself become a thing that throws or hangs.
test('a network failure is silent — an empty list from search, null from byId', async () => {
  const api = createJikanCatalog({ fetchFn: async () => { throw new Error('offline') }, minIntervalMs: 0 })
  assert.deepStrictEqual(await api.search('x'), [])
  assert.strictEqual(await api.byId(1), null)
})

test('a 429 or non-200 is treated as nothing, not parsed', async () => {
  const api = createJikanCatalog({ fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }), minIntervalMs: 0 })
  assert.deepStrictEqual(await api.search('x'), [])
  assert.strictEqual(await api.byId(1), null)
})

test('a response missing its data array is an empty list, not a crash', async () => {
  const api = createJikanCatalog({ fetchFn: async () => ({ ok: true, json: async () => ({}) }), minIntervalMs: 0 })
  assert.deepStrictEqual(await api.search('x'), [])
  assert.strictEqual(await api.byId(1), null)
})

// ── lastFailure ──────────────────────────────────────────────────────────────
// The search fallback chain has to tell "Jikan is down" apart from "Jikan
// healthily found nothing" to report an honest outage instead of a misleading
// "no results". Same convention as catalog/anilist.js.
test('a swallowed failure is recorded in lastFailure and cleared by a success', async () => {
  let fail = true
  const api = createJikanCatalog({
    fetchFn: async () => fail
      ? { ok: false, status: 504, json: async () => ({}) }
      : { ok: true, json: async () => ({ data: [] }) },
    minIntervalMs: 0,
  })
  assert.strictEqual(api.lastFailure(), null)
  await api.search('frieren')
  assert.strictEqual(api.lastFailure().status, 504)
  assert.strictEqual(api.lastFailure().message, 'HTTP 504')
  fail = false
  await api.search('frieren')
  assert.strictEqual(api.lastFailure(), null)
})

test('a thrown network error records lastFailure with its message', async () => {
  const api = createJikanCatalog({ fetchFn: async () => { throw new Error('offline') }, minIntervalMs: 0 })
  await api.search('x')
  assert.strictEqual(api.lastFailure().message, 'offline')
  assert.strictEqual(api.lastFailure().status, null)
})

// ── Rate-limit serialisation ─────────────────────────────────────────────────
// Jikan allows ~3 req/s. Several lookups fired without awaiting between them
// must not go out closer together than the interval — a burst earns a 429 and a
// temporary block, worse than being a little slower.
test('back-to-back calls are spaced by at least the interval', async () => {
  const at = []
  const api = createJikanCatalog({
    minIntervalMs: 60,
    fetchFn: async () => { at.push(Date.now()); return { ok: true, json: async () => ({ data: [] }) } },
  })
  // Fire three without awaiting — the lane has to serialise them.
  await Promise.all([api.search('a'), api.search('b'), api.search('c')])
  assert.strictEqual(at.length, 3)
  assert.ok(at[1] - at[0] >= 55, `second call waited the interval (was ${at[1] - at[0]}ms)`)
  assert.ok(at[2] - at[1] >= 55, `third call waited the interval (was ${at[2] - at[1]}ms)`)
})

// A rejection in the lane must not wedge it: the next queued call still runs.
test('one failed request does not wedge the queue behind it', async () => {
  let n = 0
  const api = createJikanCatalog({
    minIntervalMs: 0,
    fetchFn: async () => {
      n++
      if (n === 1) throw new Error('boom')
      return { ok: true, json: async () => ({ data: [FRIEREN] }) }
    },
  })
  const [first, second] = await Promise.all([api.search('a'), api.search('b')])
  assert.deepStrictEqual(first, [], 'the failed one degraded to empty')
  assert.strictEqual(second.length, 1, 'the one behind it still ran')
})
