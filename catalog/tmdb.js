'use strict'
// TMDB catalog — pure normalisation + URL builders around a thin fetch shell.
// CommonJS only; no runtime deps beyond the global `fetch`. Every I/O path
// accepts an injectable `fetchFn` so tests run without the network.

const TMDB_BASE = 'https://api.themoviedb.org/3'
const IMG_BASE = 'https://image.tmdb.org/t/p/w500'

function _year(date) {
  return typeof date === 'string' && date.length >= 4 ? date.slice(0, 4) : null
}

function _image(path) {
  return typeof path === 'string' && path.length ? `${IMG_BASE}${path}` : null
}

// genre_ids are numeric IDs without names, so they cannot populate the string
// genres[] the UI renders. Only raw.genres (detail responses, array of
// {id,name}) feeds genres; everything else falls back to [].
function _genres(raw) {
  if (!Array.isArray(raw?.genres)) return []
  return raw.genres.map(g => (typeof g === 'string' ? g : g?.name)).filter(Boolean)
}

function normalizeMovie(raw) {
  raw = raw || {}
  return {
    id: raw.id ?? null,
    type: 'movie',
    title: raw.title ?? null,
    year: _year(raw.release_date),
    poster: _image(raw.poster_path),
    backdrop: _image(raw.backdrop_path),
    overview: raw.overview ?? null,
    rating: raw.vote_average ?? null,
    genres: _genres(raw),
  }
}

function normalizeEpisode(raw) {
  raw = raw || {}
  return {
    episodeNumber: raw.episode_number ?? null,
    name: raw.name ?? null,
    overview: raw.overview ?? null,
    still: _image(raw.still_path),
    airDate: raw.air_date ?? null,
  }
}

function normalizeSeason(raw) {
  raw = raw || {}
  return {
    seasonNumber: raw.season_number ?? null,
    name: raw.name ?? null,
    episodeCount: raw.episode_count ?? null,
    episodes: Array.isArray(raw.episodes) ? raw.episodes.map(normalizeEpisode) : [],
  }
}

function normalizeTv(raw) {
  raw = raw || {}
  const entry = {
    id: raw.id ?? null,
    type: 'tv',
    title: raw.name ?? null,
    year: _year(raw.first_air_date),
    poster: _image(raw.poster_path),
    backdrop: _image(raw.backdrop_path),
    overview: raw.overview ?? null,
    rating: raw.vote_average ?? null,
    genres: _genres(raw),
  }
  if (Array.isArray(raw.seasons)) entry.seasons = raw.seasons.map(normalizeSeason)
  return entry
}

function normalizeSearchResult(raw) {
  if (!raw || (raw.media_type !== 'movie' && raw.media_type !== 'tv')) return null
  const isTv = raw.media_type === 'tv'
  const date = isTv ? raw.first_air_date : raw.release_date
  return {
    id: raw.id ?? null,
    type: raw.media_type,
    title: (isTv ? raw.name : raw.title) ?? null,
    year: _year(date),
    poster: _image(raw.poster_path),
  }
}

// Pure URL builders. The `api_key` query param is appended by the caller
// (the fetch shell), never baked in here.
function buildTrendingUrl(kind, opts = {}) {
  const timeWindow = opts.timeWindow || 'week'
  let url = `${TMDB_BASE}/trending/${kind}/${timeWindow}`
  if (opts.page != null) url += `?page=${opts.page}`
  return url
}

function buildPopularUrl(kind) {
  return `${TMDB_BASE}/${kind}/popular`
}

function buildSearchUrl(query) {
  return `${TMDB_BASE}/search/multi?query=${encodeURIComponent(query)}`
}

function buildDetailUrl(type, id) {
  return `${TMDB_BASE}/${type}/${id}`
}

function buildSeasonUrl(tvId, n) {
  return `${TMDB_BASE}/tv/${tvId}/season/${n}`
}

function createTmdbCatalog({ apiKey, fetchFn } = {}) {
  const fetcher = fetchFn || fetch

  async function _fetch(url) {
    const sep = url.includes('?') ? '&' : '?'
    const key = typeof apiKey === 'function' ? apiKey() : apiKey
    const full = key ? `${url}${sep}api_key=${key}` : url
    const res = await fetcher(full)
    if (!res || !res.ok) {
      const status = res && res.status != null ? res.status : 'unknown'
      if (status === 401) throw new Error('Invalid or missing TMDB API key (401)')
      throw new Error(`TMDB request failed (${status})`)
    }
    return res.json()
  }

  return {
    async trending(kind) {
      const data = await _fetch(buildTrendingUrl(kind))
      const norm = kind === 'tv' ? normalizeTv : normalizeMovie
      return (data.results || []).map(norm)
    },
    async popular(kind) {
      const data = await _fetch(buildPopularUrl(kind))
      const norm = kind === 'tv' ? normalizeTv : normalizeMovie
      return (data.results || []).map(norm)
    },
    async search(query) {
      const data = await _fetch(buildSearchUrl(query))
      return (data.results || []).map(normalizeSearchResult).filter(Boolean)
    },
    async detail(type, id) {
      const data = await _fetch(buildDetailUrl(type, id))
      return type === 'tv' ? normalizeTv(data) : normalizeMovie(data)
    },
    async season(tvId, n) {
      const data = await _fetch(buildSeasonUrl(tvId, n))
      return normalizeSeason(data)
    },
  }
}

module.exports = {
  normalizeMovie,
  normalizeTv,
  normalizeSeason,
  normalizeEpisode,
  normalizeSearchResult,
  buildTrendingUrl,
  buildPopularUrl,
  buildSearchUrl,
  buildDetailUrl,
  buildSeasonUrl,
  createTmdbCatalog,
}
