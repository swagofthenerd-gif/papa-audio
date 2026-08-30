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

// A teaser is a poor substitute for a trailer but a good substitute for
// nothing, and plenty of titles have only one or the other. Both are kept and
// ranked: official trailers first, then unofficial, then teasers, and the
// newest within each band — an old teaser for a film that later got a proper
// trailer should never win.
const _TRAILER_RANK = { Trailer: 0, Teaser: 1 }

function _trailers(raw) {
  const results = raw?.videos?.results
  if (!Array.isArray(results)) return []
  return results
    .filter(v => v && v.key && _TRAILER_RANK[v.type] != null && v.site === 'YouTube')
    .map(v => ({
      key: v.key,
      name: v.name ?? null,
      site: v.site ?? null,
      type: v.type ?? null,
      size: v.size ?? null,
      official: v.official === true,
      publishedAt: v.published_at ?? null,
    }))
    .sort((a, b) => {
      const ta = _TRAILER_RANK[a.type], tb = _TRAILER_RANK[b.type]
      if (ta !== tb) return ta - tb
      if (a.official !== b.official) return a.official ? -1 : 1
      return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))
    })
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
    // Anime films are anime. Without this they route to the film indexers,
    // which carry no dub and none of nyaa's releases.
    originalName: raw.original_title ?? null,
    originalLanguage: raw.original_language ?? null,
    isAnime: _isAnime(raw),
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
    // TMDB files anime as ordinary television, so a search for an anime title
    // returns a tv entry alongside AniList's. Routed as tv its sources come
    // from the TV indexer, which barely carries anime — the same show opened
    // from the Anime tab gets nyaa and a far better list. Flagging it here lets
    // the source router treat it as what it is, whichever entry was opened.
    originalName: raw.original_name ?? null,
    originalLanguage: raw.original_language ?? null,
    isAnime: _isAnime(raw),
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

function normalizePerson(raw) {
  if (!raw || raw.id == null) return null
  return {
    id: raw.id,
    type: 'person',
    title: raw.name ?? null,
    poster: _image(raw.profile_path),
    department: raw.known_for_department ?? null,
    // The titles TMDB considers this person best known for — enough to tell
    // two actors with the same name apart without a second request.
    knownFor: (raw.known_for || [])
      .map(k => (k && k.media_type === 'tv' ? k.name : k && k.title))
      .filter(Boolean).slice(0, 3),
  }
}

// Japanese animation. TMDB has no anime flag, but genre 16 is Animation and
// the original language and origin country settle the rest. Deliberately
// narrow: a French cartoon is animation, not anime, and routing it to an
// anime indexer would find nothing.
const TMDB_ANIMATION_GENRE = 16

function _isAnime(raw) {
  if (!raw) return false
  const ids = Array.isArray(raw.genres)
    ? raw.genres.map(g => (g && typeof g === 'object' ? g.id : g))
    : (Array.isArray(raw.genre_ids) ? raw.genre_ids : [])
  if (!ids.includes(TMDB_ANIMATION_GENRE)) return false
  if (raw.original_language === 'ja') return true
  return Array.isArray(raw.origin_country) && raw.origin_country.includes('JP')
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
    // search/multi returns genre_ids rather than genres, which _isAnime reads
    // too. Carried so a merged search can tell a tv entry that is really anime
    // from one that is not, without a second request per result.
    // A film uses original_title where a series uses original_name.
    originalName: (isTv ? raw.original_name : raw.original_title) ?? null,
    // Anime films — Jujutsu Kaisen 0, Suzume, A Silent Voice — are just as
    // much anime as the series, and restricting this to television left them
    // routed to the film indexers with no dub and no nyaa.
    isAnime: _isAnime(raw),
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

// The discover endpoint is what makes real browsing possible: everything the
// catalog rows do is a fixed slice of it. Params are whitelisted rather than
// passed through, so a UI bug cannot send arbitrary query keys to TMDB.
//
// TMDB names differ per media type — a movie has primary_release_date and a
// series has first_air_date — so the caller passes neutral names and the
// mapping happens here.
const SORTS = {
  popularity: 'popularity.desc',
  rating: 'vote_average.desc',
  newest: 'primary_release_date.desc',
  oldest: 'primary_release_date.asc',
  title: 'title.asc',
  revenue: 'revenue.desc',
}

const TV_SORTS = {
  popularity: 'popularity.desc',
  rating: 'vote_average.desc',
  newest: 'first_air_date.desc',
  oldest: 'first_air_date.asc',
  title: 'name.asc',
  revenue: 'popularity.desc',
}

function buildDiscoverUrl(kind, opts = {}) {
  const isTv = kind === 'tv'
  const q = []
  const push = (k, v) => { if (v != null && v !== '') q.push(`${k}=${encodeURIComponent(v)}`) }

  push('page', opts.page || 1)
  push('sort_by', (isTv ? TV_SORTS : SORTS)[opts.sort] || (isTv ? TV_SORTS : SORTS).popularity)
  if (Array.isArray(opts.genres) && opts.genres.length) push('with_genres', opts.genres.join(','))
  if (Array.isArray(opts.excludeGenres) && opts.excludeGenres.length) push('without_genres', opts.excludeGenres.join(','))
  push(isTv ? 'first_air_date.gte' : 'primary_release_date.gte', opts.yearFrom ? `${opts.yearFrom}-01-01` : null)
  push(isTv ? 'first_air_date.lte' : 'primary_release_date.lte', opts.yearTo ? `${opts.yearTo}-12-31` : null)
  push('vote_average.gte', opts.minRating)
  push('with_original_language', opts.language)
  push('with_runtime.gte', opts.runtimeFrom)
  push('with_runtime.lte', opts.runtimeTo)
  push('with_watch_providers', opts.provider)
  push('with_keywords', opts.keyword)
  push('with_people', Array.isArray(opts.people) && opts.people.length ? opts.people.join(',') : null)
  // A rating sort with no vote floor surfaces titles with three votes and a
  // perfect score, which is noise rather than a recommendation.
  if (opts.sort === 'rating') push('vote_count.gte', opts.minVotes != null ? opts.minVotes : 200)
  if (opts.includeAdult !== true) push('include_adult', 'false')

  return `${TMDB_BASE}/discover/${isTv ? 'tv' : 'movie'}?${q.join('&')}`
}

function buildGenresUrl(kind) {
  return `${TMDB_BASE}/genre/${kind === 'tv' ? 'tv' : 'movie'}/list`
}

function buildPersonSearchUrl(query, opts = {}) {
  let url = `${TMDB_BASE}/search/person?query=${encodeURIComponent(query)}`
  if (opts.page != null) url += `&page=${opts.page}`
  return url
}

function buildPersonCreditsUrl(personId) {
  return `${TMDB_BASE}/person/${personId}/combined_credits`
}

function buildCollectionUrl(collectionId) {
  return `${TMDB_BASE}/collection/${collectionId}`
}

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
    async discover(kind, opts) {
      const data = await _fetch(buildDiscoverUrl(kind, opts))
      const norm = kind === 'tv' ? normalizeTv : normalizeMovie
      return {
        results: (data.results || []).map(norm),
        page: data.page || 1,
        totalPages: data.total_pages || 1,
        totalResults: data.total_results || 0,
      }
    },
    async genres(kind) {
      const data = await _fetch(buildGenresUrl(kind))
      return (data.genres || []).filter(g => g && g.id != null && g.name)
        .map(g => ({ id: g.id, name: g.name }))
    },
    async searchPeople(query, page) {
      const data = await _fetch(buildPersonSearchUrl(query, { page }))
      return (data.results || []).map(normalizePerson).filter(Boolean)
    },
    async personCredits(personId) {
      const data = await _fetch(buildPersonCreditsUrl(personId))
      const cast = Array.isArray(data.cast) ? data.cast : []
      const crew = Array.isArray(data.crew) ? data.crew : []
      // One person can appear many times on the same title (writer and
      // director, or a recurring role); the filmography wants each title once.
      const seen = new Set()
      const out = []
      for (const raw of cast.concat(crew)) {
        const type = raw && raw.media_type
        if (type !== 'movie' && type !== 'tv') continue
        const key = type + ':' + raw.id
        if (seen.has(key)) continue
        seen.add(key)
        out.push(type === 'tv' ? normalizeTv(raw) : normalizeMovie(raw))
      }
      return out.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0))
    },
    async collection(collectionId) {
      const data = await _fetch(buildCollectionUrl(collectionId))
      return {
        id: data.id ?? null,
        name: data.name ?? null,
        overview: data.overview ?? null,
        poster: _image(data.poster_path),
        backdrop: _image(data.backdrop_path),
        parts: (data.parts || []).map(normalizeMovie)
          .sort((a, b) => (Number(a.year) || 0) - (Number(b.year) || 0)),
      }
    },
    async season(tvId, n) {
      const data = await _fetch(buildSeasonUrl(tvId, n))
      return normalizeSeason(data)
    },
  }
}

module.exports = {
  _trailers,
  _isAnime,
  TMDB_ANIMATION_GENRE,
  SORTS,
  TV_SORTS,
  buildDiscoverUrl,
  buildGenresUrl,
  buildPersonSearchUrl,
  buildPersonCreditsUrl,
  buildCollectionUrl,
  normalizePerson,
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
