'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  normalizeMedia,
  normalizeAiring,
  buildQuery,
  buildVariables,
  createAnilistCatalog,
} = require('../catalog/anilist')

const ANILIST_BASE = 'https://graphql.anilist.co'

test('normalizeMedia maps a raw AniList media node to an anime catalog entry', () => {
  const raw = {
    id: 101,
    title: {
      english: 'Fullmetal Alchemist: Brotherhood',
      romaji: 'Hagane no Renkinjutsushi',
      native: '鋼の錬金術師 FULLMETAL ALCHEMIST',
    },
    seasonYear: 2009,
    coverImage: { large: 'https://example.com/fma.jpg' },
    description: 'Two brothers search for the Philosopher\'s Stone.',
    averageScore: 90,
    genres: ['Action', 'Adventure', 'Fantasy'],
    episodes: 64,
    status: 'FINISHED',
  }
  assert.deepStrictEqual(normalizeMedia(raw), {
    id: 101,
    type: 'anime',
    idMal: null,
    title: 'Fullmetal Alchemist: Brotherhood',
    // All three variants are kept: the torrent indexer needs the romaji name,
    // which is what release groups actually use.
    titles: {
      english: 'Fullmetal Alchemist: Brotherhood',
      romaji: 'Hagane no Renkinjutsushi',
      native: '鋼の錬金術師 FULLMETAL ALCHEMIST',
    },
    year: 2009,
    poster: 'https://example.com/fma.jpg',
    backdrop: null,
    overview: 'Two brothers search for the Philosopher\'s Stone.',
    // Normalised to TMDB's 0-10 at the catalog boundary; the raw 0-100 value
    // stays available for anything that needs it.
    rating: 9,
    scoreRaw: 90,
    format: null,
    trailer: null,
    genres: ['Action', 'Adventure', 'Fantasy'],
    episodeCount: 64,
    status: 'FINISHED',
    // The detail-page facts, present on every entry and null/empty when the
    // (lighter) list query did not ask for them.
    duration: null, season: null, nextAiring: null, startDate: null, endDate: null,
    studios: [], country: null, siteUrl: null, popularity: null, favourites: null,
    source: null, synonyms: [], characters: [], recommendations: [],
  })
})

test('normalizeMedia title falls back english → romaji → native', () => {
  const english = normalizeMedia({ id: 1, title: { english: 'E', romaji: 'R', native: 'N' } })
  assert.strictEqual(english.title, 'E')

  const romaji = normalizeMedia({ id: 2, title: { english: null, romaji: 'R', native: 'N' } })
  assert.strictEqual(romaji.title, 'R')

  const native = normalizeMedia({ id: 3, title: { english: null, romaji: null, native: 'N' } })
  assert.strictEqual(native.title, 'N')

  const none = normalizeMedia({ id: 4, title: null })
  assert.strictEqual(none.title, null)
})

test('normalizeMedia nulls missing fields', () => {
  const e = normalizeMedia({ id: 5 })
  assert.strictEqual(e.id, 5)
  assert.strictEqual(e.type, 'anime')
  assert.strictEqual(e.idMal, null)
  assert.strictEqual(e.title, null)
  assert.strictEqual(e.year, null)
  assert.strictEqual(e.poster, null)
  assert.strictEqual(e.backdrop, null)
  assert.strictEqual(e.overview, null)
  assert.strictEqual(e.rating, null)
  assert.deepStrictEqual(e.genres, [])
  assert.strictEqual(e.episodeCount, null)
  assert.strictEqual(e.status, null)
})

test('normalizeMedia leaves rating null when averageScore is null', () => {
  const e = normalizeMedia({ id: 6, averageScore: null })
  assert.strictEqual(e.rating, null)
})

test('normalizeMedia carries idMal through for AniSkip', () => {
  const e = normalizeMedia({ id: 21, idMal: 21 })
  assert.strictEqual(e.idMal, 21)
  const none = normalizeMedia({ id: 7 })
  assert.strictEqual(none.idMal, null)
})

test('normalizeMedia emits backdrop from bannerImage, falls back to coverImage.extraLarge, else null', () => {
  const banner = normalizeMedia({ id: 1, bannerImage: 'http://x/banner.jpg' })
  assert.strictEqual(banner.backdrop, 'http://x/banner.jpg')

  const cover = normalizeMedia({ id: 2, coverImage: { extraLarge: 'http://x/cover-xl.jpg' } })
  assert.strictEqual(cover.backdrop, 'http://x/cover-xl.jpg')

  const none = normalizeMedia({ id: 3 })
  assert.strictEqual(none.backdrop, null)
})

test('buildQuery produces a query string per kind', () => {
  const q = buildQuery('search', { query: 'bebop' })
  assert.strictEqual(typeof q, 'string')
  assert.ok(q.includes('search: $search'))
  assert.ok(q.includes('type: $type'))
  assert.ok(q.includes('$type: MediaType'))

  assert.ok(buildQuery('trending').includes('TRENDING_DESC'))
  assert.ok(buildQuery('popular').includes('POPULARITY_DESC'))
  assert.ok(buildQuery('season').includes('season: $season'))
  assert.throws(() => buildQuery('bogus'), /Unknown AniList query kind/)
})

test('buildQuery places sort/search/type/season on media, never on Page (AniList 400 regression)', () => {
  // AniList rejects `sort`/`search`/`season`/`type` as Page arguments with a
  // 400 ("Unknown argument ... on field Page"). They must sit on the `media`
  // field instead. Guard the exact query shapes so this can't regress.
  const trending = buildQuery('trending')
  const popular = buildQuery('popular')
  const season = buildQuery('season')
  const search = buildQuery('search')

  for (const q of [trending, popular, season, search]) {
    assert.ok(!q.includes('Page(page: $page, perPage: $perPage,'), 'no args on Page')
    assert.ok(q.includes('media('), 'media field carries the args')
  }

  assert.ok(trending.includes('media(type: ANIME, sort: TRENDING_DESC)'))
  assert.ok(popular.includes('media(type: ANIME, sort: POPULARITY_DESC)'))
  assert.ok(season.includes('media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC)'))
  assert.ok(search.includes('media(search: $search, type: $type)'))
})

test('buildQuery signature accepts an options object without changing the query', () => {
  const base = buildQuery('trending')
  const withOpts = buildQuery('trending', { page: 1, perPage: 20 })
  assert.strictEqual(base, withOpts)
})

test('buildVariables injects season/seasonYear for the season kind', () => {
  const v = buildVariables('season', { season: 'WINTER', seasonYear: 2020 })
  assert.strictEqual(v.season, 'WINTER')
  assert.strictEqual(v.seasonYear, 2020)
})

test('createAnilistCatalog.search POSTs the right variables and normalizes the response', async () => {
  const media = [
    {
      id: 1,
      title: { romaji: 'Cowboy Bebop' },
      seasonYear: 1998,
      coverImage: { large: 'http://x/cb.jpg' },
      description: 'Bounty hunters in space.',
      averageScore: 86,
      genres: ['Sci-Fi', 'Action'],
      episodes: 26,
      status: 'FINISHED',
    },
  ]
  const fetchFn = async (url, init) => {
    assert.strictEqual(url, ANILIST_BASE)
    assert.strictEqual(init.method, 'POST')
    assert.strictEqual(init.headers['Content-Type'], 'application/json')
    const body = JSON.parse(init.body)
    assert.strictEqual(typeof body.query, 'string')
    assert.deepStrictEqual(body.variables, { page: 2, perPage: 20, search: 'bebop', type: 'ANIME' })
    return { ok: true, json: async () => ({ data: { Page: { media } } }) }
  }
  const cat = createAnilistCatalog({ fetchFn })
  const res = await cat.search('bebop', 2)
  assert.strictEqual(res.length, 1)
  assert.strictEqual(res[0].type, 'anime')
  assert.strictEqual(res[0].title, 'Cowboy Bebop')
  assert.strictEqual(res[0].year, 1998)
})

test('createAnilistCatalog.trending/popular/season normalize data.Page.media', async () => {
  const media = [{ id: 10, title: { english: 'A' }, seasonYear: 2020 }]
  const fetchFn = async () => ({ ok: true, json: async () => ({ data: { Page: { media } } }) })
  const cat = createAnilistCatalog({ fetchFn })
  for (const kind of ['trending', 'popular', 'season']) {
    const res = await cat[kind](1)
    assert.strictEqual(res.length, 1)
    assert.strictEqual(res[0].type, 'anime')
    assert.strictEqual(res[0].title, 'A')
  }
})

test('createAnilistCatalog.season passes injected season/seasonYear to fetchFn', async () => {
  const media = [{ id: 11, title: { english: 'S' } }]
  let captured
  const fetchFn = async (url, init) => {
    captured = JSON.parse(init.body)
    return { ok: true, json: async () => ({ data: { Page: { media } } }) }
  }
  const cat = createAnilistCatalog({ fetchFn })
  const res = await cat.season(1, { season: 'WINTER', seasonYear: 2020 })
  assert.deepStrictEqual(captured.variables, { page: 1, perPage: 20, season: 'WINTER', seasonYear: 2020 })
  assert.strictEqual(res.length, 1)
  assert.strictEqual(res[0].title, 'S')
})

test('createAnilistCatalog.trending degrades to [] on a non-OK response', async () => {
  // Browse/search/detail calls degrade quietly rather than rejecting, matching
  // seasonChain/airingSchedule: a dead AniList leaves a row empty, it does not
  // blow up the whole request. (Previously these rejected; that was the bug.)
  const fetchFn = async () => ({ ok: false, status: 500 })
  const cat = createAnilistCatalog({ fetchFn })
  assert.deepStrictEqual(await cat.trending(1), [])
})

test('createAnilistCatalog.popular degrades to [] on a GraphQL error response', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'Rate limited' }] }) })
  const cat = createAnilistCatalog({ fetchFn })
  assert.deepStrictEqual(await cat.popular(1), [])
})

// ── lastFailure(): why a degraded list came back empty ───────────────────────
// The shelf handlers in main.js need to tell "AniList is down" apart from
// "AniList healthily returned nothing" so an outage-empty row serves the browse
// cache and shows an honest message instead of "Nothing here right now".
test('lastFailure is null before any call and after a healthy success', async () => {
  const media = { data: { Page: { media: [{ id: 1, title: { romaji: 'X' } }] } } }
  const fetchFn = async () => ({ ok: true, json: async () => media })
  const cat = createAnilistCatalog({ fetchFn })
  assert.strictEqual(cat.lastFailure(), null, 'no failure recorded before any call')
  await cat.trending(1)
  assert.strictEqual(cat.lastFailure(), null, 'a success leaves no failure behind')
})

test('lastFailure records the message and status when a degraded call fails', async () => {
  const fetchFn = async () => ({ ok: false, status: 403 })
  const cat = createAnilistCatalog({ fetchFn })
  assert.deepStrictEqual(await cat.trending(1), [], 'the row still degrades to empty')
  const lf = cat.lastFailure()
  assert.ok(lf, 'a failure was recorded')
  assert.match(lf.message, /AniList request failed \(403\)/, 'the failure carries the reason')
  assert.strictEqual(lf.status, 403, 'the HTTP status rides along for the caller')
  assert.ok(lf.at > 0, 'the failure is time-stamped')
})

test('a healthy empty result is NOT an outage (lastFailure stays cleared)', async () => {
  // AniList returned a valid, empty page — nothing to show, but not down.
  const empty = { data: { Page: { media: [] } } }
  const fetchFn = async () => ({ ok: true, json: async () => empty })
  const cat = createAnilistCatalog({ fetchFn })
  assert.deepStrictEqual(await cat.trending(1), [], 'an empty page is empty')
  assert.strictEqual(cat.lastFailure(), null, 'a healthy-but-empty page is not an outage')
})

test('lastFailure is cleared once AniList recovers', async () => {
  let ok = false
  const media = { data: { Page: { media: [{ id: 1, title: { romaji: 'X' } }] } } }
  const fetchFn = async () => ok
    ? ({ ok: true, json: async () => media })
    : ({ ok: false, status: 403 })
  const cat = createAnilistCatalog({ fetchFn })
  await cat.trending(1)
  assert.ok(cat.lastFailure(), 'down: a failure is recorded')
  ok = true
  // The breaker (S7) holds calls for a window after a failure; a recovery is
  // observed on the first call after the window. Tests close it by hand.
  await cat.trending(1)
  assert.ok(cat.lastFailure(), 'inside the window the outage still stands — no call was made')
  cat._resetBreaker()
  await cat.trending(1)
  assert.strictEqual(cat.lastFailure(), null, 'recovered: the flag never outlives the outage')
})

// ── Detail by id ────────────────────────────────────────────────────────────
// The detail handler used to run a TEXT search for the numeric id — searching
// AniList for the string "21" — which routinely opened an unrelated show.
{
  const { buildQuery, buildVariables, createAnilistCatalog } = require('../catalog/anilist')

  test('buildQuery byId selects the top-level Media field, not a Page search', () => {
    const q = buildQuery('byId')
    assert.match(q, /Media\(id: \$id, type: ANIME\)/)
    assert.ok(!/Page\(/.test(q), 'byId must not go through Page')
    assert.ok(!/search:/.test(q), 'byId must not be a text search')
  })

  test('buildVariables byId sends a numeric id and nothing else', () => {
    assert.deepStrictEqual(buildVariables('byId', { id: '21' }), { id: 21 })
    assert.deepStrictEqual(buildVariables('byId', { id: 21, page: 3 }), { id: 21 })
  })

  test('byId reads data.Media and returns one normalized entry', async () => {
    let body = null
    const fetchFn = async (_url, opts) => {
      body = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          data: { Media: { id: 21, idMal: 21, title: { english: 'One Piece' }, seasonYear: 1999, episodes: 1100 } },
        }),
      }
    }
    const cat = createAnilistCatalog({ fetchFn })
    const detail = await cat.byId(21)
    assert.strictEqual(detail.id, 21)
    assert.strictEqual(detail.idMal, 21, 'the MAL id AniSkip needs must survive the normaliser')
    assert.strictEqual(detail.title, 'One Piece')
    assert.strictEqual(detail.type, 'anime')
    assert.strictEqual(detail.episodeCount, 1100)
    assert.deepStrictEqual(body.variables, { id: 21 })
    assert.match(body.query, /\bidMal\b/, 'the byId query must select idMal')
  })

  test('byId returns null for an unknown id rather than an unrelated show', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => ({ data: { Media: null } }) })
    const cat = createAnilistCatalog({ fetchFn })
    assert.strictEqual(await cat.byId(999999999), null)
  })

  test('byId RETHROWS a GraphQL error, carrying AniList\'s own message', async () => {
    // Unlike the browse/search shelves, a detail lookup must NOT degrade to
    // null: null erases the reason and forces a bare "Not found" on the detail
    // page. byId rethrows so the caller (main.js) can fall back to its
    // persistent cache and, failing that, show the real cause. The thrown
    // message carries AniList's own text verbatim.
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: 'The AniList API has been temporarily disabled due to severe stability issues.' }] }),
    })
    const cat = createAnilistCatalog({ fetchFn })
    await assert.rejects(() => cat.byId(1), /temporarily disabled due to severe stability issues/)
  })

  test('byId surfaces a transport failure (the real outage: HTTP 403)', async () => {
    // The live outage returns HTTP 403, not a 200-with-errors body. _post turns
    // a non-OK response into an Error whose message includes the status, and
    // byId lets it through rather than swallowing it.
    const fetchFn = async () => ({ ok: false, status: 403 })
    const cat = createAnilistCatalog({ fetchFn })
    await assert.rejects(() => cat.byId(1), /AniList request failed \(403\)/)
  })

  test('byId still returns null for a genuinely unknown id (no throw)', async () => {
    // A null data.Media is "no such show", not an error — that must not become
    // an exception, or every valid-but-missing id would look like an outage.
    const fetchFn = async () => ({ ok: true, json: async () => ({ data: { Media: null } }) })
    const cat = createAnilistCatalog({ fetchFn })
    assert.strictEqual(await cat.byId(999999999), null)
  })
}

// ── Airing schedule (App §25/§26) ───────────────────────────────────────────

test('normalizeAiring maps a media node with a next airing episode', () => {
  const raw = {
    id: 21,
    title: { english: 'One Piece', romaji: 'One Piece' },
    nextAiringEpisode: { airingAt: 1757000000, episode: 1089 },
  }
  assert.deepStrictEqual(normalizeAiring(raw), {
    id: 21,
    title: 'One Piece',
    episode: 1089,
    airingAt: 1757000000,
  })
})

test('normalizeAiring falls back english → romaji → native for the title', () => {
  const r = normalizeAiring({ id: 1, title: { romaji: 'R', native: 'N' }, nextAiringEpisode: { airingAt: 5, episode: 2 } })
  assert.strictEqual(r.title, 'R')
})

test('normalizeAiring returns null for a finished show (no nextAiringEpisode)', () => {
  assert.strictEqual(normalizeAiring({ id: 1, title: { english: 'Done' } }), null)
  assert.strictEqual(normalizeAiring({ id: 1, nextAiringEpisode: null }), null)
  assert.strictEqual(normalizeAiring({ id: 1, nextAiringEpisode: { episode: 3 } }), null)
})

test('buildQuery airing selects nextAiringEpisode and id_in', () => {
  const q = buildQuery('airing')
  assert.match(q, /nextAiringEpisode\s*\{\s*airingAt\s+episode\s*\}/)
  assert.match(q, /id_in:\s*\$ids/)
  assert.match(q, /type:\s*ANIME/)
})

test('buildVariables airing coerces ids to ints and drops junk', () => {
  const v = buildVariables('airing', { ids: ['21', 44, 'x', 0, -3, null] })
  assert.deepStrictEqual(v, { page: 1, perPage: 50, ids: [21, 44] })
})

test('createAnilistCatalog.airingSchedule batches ids and normalizes, dropping finished shows', async () => {
  const media = [
    { id: 21, title: { romaji: 'One Piece' }, nextAiringEpisode: { airingAt: 100, episode: 1089 } },
    { id: 99, title: { romaji: 'Finished' }, nextAiringEpisode: null },
  ]
  let sentBody = null
  const fetchFn = async (url, init) => {
    sentBody = JSON.parse(init.body)
    return { ok: true, json: async () => ({ data: { Page: { media } } }) }
  }
  const cat = createAnilistCatalog({ fetchFn })
  const res = await cat.airingSchedule(['21', 99])
  assert.deepStrictEqual(sentBody.variables.ids, [21, 99])
  assert.strictEqual(res.length, 1)
  assert.strictEqual(res[0].id, 21)
  assert.strictEqual(res[0].episode, 1089)
})

test('createAnilistCatalog.airingSchedule never touches the network for an empty/invalid id list', async () => {
  let called = false
  const fetchFn = async () => { called = true; return { ok: true, json: async () => ({}) } }
  const cat = createAnilistCatalog({ fetchFn })
  assert.deepStrictEqual(await cat.airingSchedule([]), [])
  assert.deepStrictEqual(await cat.airingSchedule(['x', 0, null]), [])
  assert.strictEqual(called, false)
})
