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
          status`

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
    rating: raw.averageScore ?? null,
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

function buildVariables(kind, { page, perPage, query, season, seasonYear, id } = {}) {
  // The byId query takes only $id; sending page/perPage would be rejected as
  // unknown variables are not, but keeping it clean matches the query shape.
  if (kind === 'byId') return { id: Number(id) }
  const vars = {
    page: page ?? 1,
    perPage: perPage ?? 20,
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
    const media = data?.data?.Page?.media
    return (media || []).map(normalizeMedia)
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
  }
}

module.exports = {
  normalizeMedia,
  buildQuery,
  buildVariables,
  createAnilistCatalog,
}
