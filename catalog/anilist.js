'use strict'
// AniList catalog — pure GraphQL normalisation around a thin fetch shell.
// CommonJS only; no runtime deps beyond the global `fetch`. Every I/O path
// accepts an injectable `fetchFn` so tests run without the network.
//
// AniList is a GraphQL API: requests are POSTs of `{ query, variables }` to
// https://graphql.anilist.co with header `Content-Type: application/json`.

const ANILIST_BASE = 'https://graphql.anilist.co'

// idMal is the MyAnimeList id AniSkip keys on, so it has to ride along on every
// anime lookup — without it the skip-intro feature has nothing to ask AniSkip.
const MEDIA_SELECTION = `id
          idMal
          title { english romaji native }
          seasonYear
          bannerImage
          coverImage { large extraLarge }
          description
          averageScore
          genres
          episodes
          status
          format
          trailer { id site }`

function normalizeMedia(raw) {
  raw = raw || {}
  const title = raw.title || {}
  return {
    id: raw.id ?? null,
    type: 'anime',
    // The MyAnimeList id AniSkip needs; null for shows that have no MAL entry.
    idMal: raw.idMal ?? null,
    title: title.english || title.romaji || title.native || null,
    // All three variants are kept, not just the display pick. Fansub groups
    // release under the ROMAJI title ("Sousou no Frieren"), so searching a
    // torrent indexer with the English one ("Frieren: Beyond Journey's End")
    // finds nothing at all for a large share of shows.
    titles: {
      english: title.english || null,
      romaji: title.romaji || null,
      native: title.native || null,
    },
    year: raw.seasonYear ?? null,
    poster: raw.coverImage?.large ?? null,
    backdrop: raw.bannerImage || (raw.coverImage && raw.coverImage.extraLarge) || null,
    overview: raw.description ?? null,
    // 0-10, matching TMDB. The raw 0-100 value is kept for anyone who needs it.
    rating: scoreTo10(raw.averageScore),
    scoreRaw: raw.averageScore ?? null,
    format: raw.format ?? null,
    trailer: raw.trailer && raw.trailer.id
      ? { id: raw.trailer.id, site: String(raw.trailer.site || 'youtube').toLowerCase() }
      : null,
    genres: Array.isArray(raw.genres) ? raw.genres : [],
    episodeCount: raw.episodes ?? null,
    status: raw.status ?? null,
  }
}

// Pure GraphQL query builders. `buildQuery` returns the query string for a
// kind; `buildVariables` returns the matching variables object. Kept separate
// so the POST body is assembled by the fetch shell, mirroring tmdb.js.
function buildQuery(kind, options) {
  // `options` (page/perPage) is accepted for signature parity with tmdb.js
  // builders; pagination lives in `buildVariables`, not the query string.
  void options
  switch (kind) {
    // The browse query. Every argument is optional at the GraphQL level, so one
    // query shape serves every combination of filters — AniList ignores a
    // variable that is null rather than erroring, which is why this does not
    // need to be assembled as a string per request.
    case 'discover':
      return `query ($page: Int, $perPage: Int, $genre: [String], $tag: [String],
                     $season: MediaSeason, $seasonYear: Int, $format: [MediaFormat],
                     $status: MediaStatus, $score: Int, $sort: [MediaSort], $isAdult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(type: ANIME, genre_in: $genre, tag_in: $tag, season: $season,
          seasonYear: $seasonYear, format_in: $format, status: $status,
          averageScore_greater: $score, sort: $sort, isAdult: $isAdult) {
      ${MEDIA_SELECTION}
    }
  }
}`
    // NOTE: `sort`/`search`/`season`/`seasonYear`/`type` are arguments of the
    // `media` field, NOT of `Page`. Placing them on `Page` makes AniList return
    // a 400 (`Unknown argument "sort" on field "Page"`). `type: ANIME` is also
    // required on `media`, otherwise the page returns manga/other types too.
    case 'trending':
      return `query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: TRENDING_DESC) {
      ${MEDIA_SELECTION}
    }
  }
}`
    case 'popular':
      return `query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: POPULARITY_DESC) {
      ${MEDIA_SELECTION}
    }
  }
}`
    case 'season':
      return `query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage) {
    media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC) {
      ${MEDIA_SELECTION}
    }
  }
}`
    case 'search':
      return `query ($page: Int, $perPage: Int, $search: String, $type: MediaType) {
  Page(page: $page, perPage: $perPage) {
    media(search: $search, type: $type) {
      ${MEDIA_SELECTION}
    }
  }
}`
    // A detail lookup by id is NOT a text search. `Media(id:)` is a top-level
    // field, not a Page child, so this query shape differs from the others and
    // its result is read from `data.Media`, not `data.Page.media`.
    case 'byId':
      return `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    ${MEDIA_SELECTION}
  }
}`
    default:
      throw new Error(`Unknown AniList query kind: ${kind}`)
  }
}

// AniList scores out of 100. Everything downstream — the card badge, the
// filter rail, the sort — works in TMDB's 0-10, so the conversion happens once
// here rather than at each display site.
// null and '' both coerce to 0 through Number(), so they have to be rejected
// before the finite check — otherwise an unrated title scores 0, which shows
// as "0.0" on the badge and sorts below everything rather than as unrated.
function _score(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function scoreTo10(score) {
  const n = _score(score)
  return n == null ? null : Math.round(n) / 10
}

function scoreTo100(score) {
  const n = _score(score)
  return n == null ? null : Math.round(n * 10)
}

const SORTS = {
  popularity: ['POPULARITY_DESC'],
  rating: ['SCORE_DESC'],
  newest: ['START_DATE_DESC'],
  oldest: ['START_DATE'],
  title: ['TITLE_ROMAJI'],
  trending: ['TRENDING_DESC'],
}

function buildVariables(kind, opts = {}) {
  const { page, perPage, query, season, seasonYear, id } = opts
  // The byId query takes only $id; sending page/perPage would be rejected as
  // unknown variables are not, but keeping it clean matches the query shape.
  if (kind === 'byId') return { id: Number(id) }
  const vars = {
    page: page ?? 1,
    perPage: perPage ?? 20,
  }
  if (kind === 'discover') {
    // Only set what the caller asked for: AniList treats an explicit null as
    // "no filter", but leaving the key out entirely is clearer and avoids any
    // argument that does not accept null.
    if (Array.isArray(opts.genres) && opts.genres.length) vars.genre = opts.genres
    if (Array.isArray(opts.tags) && opts.tags.length) vars.tag = opts.tags
    if (Array.isArray(opts.formats) && opts.formats.length) vars.format = opts.formats
    if (opts.season) vars.season = opts.season
    if (opts.seasonYear) vars.seasonYear = Number(opts.seasonYear)
    if (opts.status) vars.status = opts.status
    // The caller works in 0-10; AniList's averageScore_greater is 0-100.
    if (opts.minRating != null && opts.minRating !== '') vars.score = scoreTo100(opts.minRating)
    vars.sort = SORTS[opts.sort] || SORTS.popularity
    vars.isAdult = opts.includeAdult === true
    return vars
  }
  if (kind === 'search') {
    vars.search = query ?? ''
    vars.type = 'ANIME'
  }
  if (kind === 'season') {
    // "Season" browsing means the currently-airing season, computed at call
    // time from the current date (AniList defines WINTER as Jan–Mar). Injected
    // season/seasonYear override the computed defaults.
    const now = new Date()
    const month = now.getMonth() + 1
    const year = now.getFullYear()
    vars.season = season ?? (month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL')
    vars.seasonYear = seasonYear ?? year
  }
  return vars
}

function createAnilistCatalog({ fetchFn } = {}) {
  const fetcher = fetchFn || fetch

  async function _post(kind, opts) {
    const query = buildQuery(kind, opts)
    const variables = buildVariables(kind, opts)
    const res = await fetcher(ANILIST_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    if (!res || !res.ok) {
      const status = res && res.status != null ? res.status : 'unknown'
      throw new Error(`AniList request failed (${status})`)
    }
    const data = await res.json()
    if (data && Array.isArray(data.errors) && data.errors.length) {
      throw new Error(`AniList GraphQL error: ${data.errors[0].message}`)
    }
    if (kind === 'byId') {
      const one = data?.data?.Media
      return one ? normalizeMedia(one) : null
    }
    const page = data?.data?.Page
    const media = (page?.media || []).map(normalizeMedia)
    // Browsing needs to know how many there are and whether to keep paging;
    // the fixed rows only ever wanted the list.
    if (kind === 'discover') {
      const info = page?.pageInfo || {}
      return {
        results: media,
        page: info.currentPage || 1,
        totalPages: info.lastPage || 1,
        totalResults: info.total || media.length,
        hasMore: info.hasNextPage === true,
      }
    }
    return media
  }

  return {
    trending(page) {
      return _post('trending', { page })
    },
    popular(page) {
      return _post('popular', { page })
    },
    season(page, { season, seasonYear } = {}) {
      return _post('season', { page, season, seasonYear })
    },
    search(query, page) {
      return _post('search', { query, page })
    },
    byId(id) {
      return _post('byId', { id })
    },
    discover(opts) {
      return _post('discover', opts || {})
    },
    // The browse vocabularies. Both are static enough to cache for a week: 19
    // genres, and 361 tags that change when AniList's editors add one.
    async genres() {
      const res = await fetcher(ANILIST_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ GenreCollection }' }),
      })
      if (!res || !res.ok) return []
      const data = await res.json()
      const list = data?.data?.GenreCollection
      // Hentai is a genre in AniList's vocabulary; it is filtered here rather
      // than in the UI so it cannot leak into a chip list by accident.
      return Array.isArray(list) ? list.filter(g => g && g !== 'Hentai') : []
    },
    async tags() {
      const res = await fetcher(ANILIST_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ MediaTagCollection { name category isAdult } }' }),
      })
      if (!res || !res.ok) return []
      const data = await res.json()
      const list = data?.data?.MediaTagCollection
      if (!Array.isArray(list)) return []
      // Grouped by category: 361 tags as a flat list is unusable.
      const byCategory = new Map()
      for (const t of list) {
        if (!t || !t.name || t.isAdult) continue
        const cat = t.category || 'Other'
        if (!byCategory.has(cat)) byCategory.set(cat, [])
        byCategory.get(cat).push(t.name)
      }
      return [...byCategory.entries()]
        .map(([category, tags]) => ({ category, tags: tags.sort() }))
        .sort((a, b) => a.category.localeCompare(b.category))
    },
  }
}

module.exports = {
  SORTS,
  scoreTo10,
  scoreTo100,
  normalizeMedia,
  buildQuery,
  buildVariables,
  createAnilistCatalog,
}
