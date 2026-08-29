'use strict'
// TMDB catalog — pure normalisation + URL builders around a thin fetch shell.
// CommonJS only; no runtime deps beyond the global `fetch`. Every I/O path
// accepts an injectable `fetchFn` so tests run without the network.

const { certification } = require('../src/video-format')

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
// TMDB puts the IMDb id at raw.imdb_id for movies and at
// raw.external_ids.imdb_id for tv (only when external_ids was appended).
function _imdbId(raw) {
  const id = raw?.imdb_id || raw?.external_ids?.imdb_id
  return typeof id === 'string' && id.length ? id : null
}

function _genres(raw) {
  if (!Array.isArray(raw?.genres)) return []
  return raw.genres.map(g => (typeof g === 'string' ? g : g?.name)).filter(Boolean)
}

// Cast/crew: keep the fields the detail page actually renders, and drop the
// rest so a 100-actor ensemble does not bloat a cached detail object.
function _people(list) {
  if (!Array.isArray(list)) return []
  return list
    .map(c => c && {
      id: c.id ?? null,
      name: c.name ?? null,
      character: c.character ?? null,
      job: c.job ?? null,
      department: c.department ?? null,
      profilePath: _image(c.profile_path),
      order: c.order ?? null,
    })
    .filter(p => p && p.name)
}

function _cast(raw) {
  return _people(raw?.credits?.cast)
}

function _crew(raw) {
  return _people(raw?.credits?.crew)
}

function _trailers(raw) {
  const results = raw?.videos?.results
  if (!Array.isArray(results)) return []
  return results
    .filter(v => v && v.type === 'Trailer')
    .map(v => ({ key: v.key ?? null, name: v.name ?? null, site: v.site ?? null, type: v.type ?? null, size: v.size ?? null }))
    .filter(v => v.key)
}

// Studios and spoken languages are arrays of {name, ...}; keep the names.
function _names(list) {
  if (!Array.isArray(list)) return []
  return list.map(x => (x && (x.name || x.english_name)) || null).filter(Boolean)
}

// watch/providers → { "US": { flatrate: ["Netflix"], rent: [...], buy: [...] } }.
// Country keys are preserved; the UI decides which to show.
function _providers(wp) {
  const results = wp && wp.results
  if (!results || typeof results !== 'object') return null
  const out = {}
  for (const [country, entry] of Object.entries(results)) {
    if (!entry || typeof entry !== 'object') continue
    const kinds = {}
    for (const kind of ['flatrate', 'rent', 'buy', 'ads', 'free']) {
      const names = (Array.isArray(entry[kind]) ? entry[kind] : [])
        .map(p => p && p.provider_name).filter(Boolean)
      if (names.length) kinds[kind] = names
    }
    if (Object.keys(kinds).length) out[country] = kinds
  }
  return Object.keys(out).length ? out : null
}

function _collection(raw) {
  const c = raw?.belongs_to_collection
  if (!c) return null
  return { id: c.id ?? null, name: c.name ?? null, poster: _image(c.poster_path), backdrop: _image(c.backdrop_path) }
}

// similar / recommendations are full entries of the parent's own type, minus
// the expensive appended sub-objects. A light summary is enough for a rail.
function _related(list, type) {
  if (!Array.isArray(list)) return []
  const isTv = type === 'tv'
  return list
    .map(r => r && {
      id: r.id ?? null,
      type,
      title: (isTv ? r.name : r.title) ?? null,
      year: _year(isTv ? r.first_air_date : r.release_date),
      poster: _image(r.poster_path),
      rating: r.vote_average ?? null,
    })
    .filter(r => r && r.id != null)
}

// The append_to_response sub-objects are always present on a detail response
// (we ask for them), so the extras they produce are always present on the
// normalised entry — with empty defaults when TMDB sent nothing usable.
function _extras(raw, type) {
  return {
    cast: _cast(raw),
    crew: _crew(raw),
    trailers: _trailers(raw),
    studios: _names(raw.production_companies),
    languages: _names(raw.spoken_languages),
    providers: _providers(raw['watch/providers']),
    collection: _collection(raw),
    similar: _related(raw?.similar?.results, type),
    recommendations: _related(raw?.recommendations?.results, type),
  }
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
    imdbId: _imdbId(raw),
    runtime: raw.runtime ?? null,
    tagline: raw.tagline ?? null,
    certification: certification(raw.release_dates),
    ..._extras(raw, 'movie'),
  }
}

function _guestStars(list) {
  if (!Array.isArray(list)) return []
  return list
    .map(g => g && { id: g.id ?? null, name: g.name ?? null, character: g.character ?? null, profilePath: _image(g.profile_path) })
    .filter(g => g && g.name)
}

function normalizeEpisode(raw) {
  raw = raw || {}
  return {
    episodeNumber: raw.episode_number ?? null,
    name: raw.name ?? null,
    overview: raw.overview ?? null,
    still: _image(raw.still_path),
    airDate: raw.air_date ?? null,
    runtime: raw.runtime ?? null,
    rating: raw.vote_average ?? null,
    guestStars: _guestStars(raw.guest_stars),
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
    imdbId: _imdbId(raw),
    // A show has no single runtime; TMDB reports episode_run_time as an array.
    // The first entry is the representative number for the hero's "· 47m".
    runtime: (Array.isArray(raw.episode_run_time) && raw.episode_run_time.length) ? raw.episode_run_time[0] : null,
    tagline: raw.tagline ?? null,
    // TV certification comes from content_ratings, not release_dates; the
    // helper reads either shape (see video-format.certification).
    certification: certification(raw.content_ratings),
    ..._extras(raw, 'tv'),
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

function buildPopularUrl(kind, opts = {}) {
  let url = `${TMDB_BASE}/${kind}/popular`
  if (opts.page != null) url += `?page=${opts.page}`
  return url
}

function buildSearchUrl(query, opts = {}) {
  let url = `${TMDB_BASE}/search/multi?query=${encodeURIComponent(query)}`
  if (opts.page != null) url += `&page=${opts.page}`
  return url
}

// The detail sub-requests, per media type. `release_dates` is a movie concept;
// TV certification lives in `content_ratings`. Asking TMDB for the wrong one is
// a 422 that would break every detail page of that type, so the two lists differ.
const MOVIE_APPEND = 'credits,videos,similar,recommendations,release_dates,external_ids,watch/providers'
const TV_APPEND = 'credits,videos,similar,recommendations,content_ratings,external_ids,watch/providers'

function buildDetailUrl(type, id) {
  const append = type === 'tv' ? TV_APPEND : MOVIE_APPEND
  return `${TMDB_BASE}/${type}/${id}?append_to_response=${append}`
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
    async trending(kind, page) {
      const data = await _fetch(buildTrendingUrl(kind, { page }))
      const norm = kind === 'tv' ? normalizeTv : normalizeMovie
      return (data.results || []).map(norm)
    },
    async popular(kind, page) {
      const data = await _fetch(buildPopularUrl(kind, { page }))
      const norm = kind === 'tv' ? normalizeTv : normalizeMovie
      return (data.results || []).map(norm)
    },
    async search(query, page) {
      const data = await _fetch(buildSearchUrl(query, { page }))
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
  MOVIE_APPEND,
  TV_APPEND,
}
