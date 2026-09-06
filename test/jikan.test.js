'use strict'
// Jikan is the AniList stand-in: when AniList is down its answers have to reshape
// into the exact entry shape AniList's normalizeMedia produces, or every read
// site downstream needs a second code path. These tests pin that shape, the
// defensive nulls, the rate-limit serialisation, and the never-throw contract.
const test = require('node:test')
const assert = require('node:assert')

const {
  scoreTo10, normalizeMedia, buildSearchUrl, buildByIdUrl, createJikanCatalog,
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
  // No AniList id from MAL; idMal is the one that matters (AniSkip keys on it).
  assert.strictEqual(e.id, null)
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
