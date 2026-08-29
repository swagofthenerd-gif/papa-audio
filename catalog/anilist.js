'use strict'
// AniList catalog — pure GraphQL normalisation around a thin fetch shell.
// CommonJS only; no runtime deps beyond the global `fetch`. Every I/O path
// accepts an injectable `fetchFn` so tests run without the network.
//
// AniList is a GraphQL API: requests are POSTs of `{ query, variables }` to
// https://graphql.anilist.co with header `Content-Type: application/json`.

const ANILIST_BASE = 'https://graphql.anilist.co'

const MEDIA_SELECTION = `id
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
    title: title.english || title.romaji || title.native || null,
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
    case 'trending':
      return `query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage, sort: TRENDING_DESC) {
    media {
      ${MEDIA_SELECTION}
    }
  }
}`
    case 'popular':
      return `query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage, sort: POPULARITY_DESC) {
    media {
      ${MEDIA_SELECTION}
    }
  }
}`
    case 'season':
      return `query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage, season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC) {
    media {
      ${MEDIA_SELECTION}
    }
  }
}`
    case 'search':
      return `query ($page: Int, $perPage: Int, $search: String, $type: MediaType) {
  Page(page: $page, perPage: $perPage, search: $search, type: $type) {
    media {
      ${MEDIA_SELECTION}
    }
  }
}`
    default:
      throw new Error(`Unknown AniList query kind: ${kind}`)
  }
}

function buildVariables(kind, { page, perPage, query, season, seasonYear } = {}) {
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
  }
}

module.exports = {
  normalizeMedia,
  buildQuery,
  buildVariables,
  createAnilistCatalog,
}
