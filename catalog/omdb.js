'use strict'
// OMDb — the second opinion.
//
// TMDB carries one score, averaged from its own users. A cinephile wants the
// disagreement: IMDb's two million votes, the Rotten Tomatoes critics' figure
// and Metacritic's weighted average say different things about the same film,
// and where they diverge is itself information. OMDb returns all three from one
// request, along with the awards line, the certificate, the runtime and the box
// office — none of which the app shows today.
//
// Same shape as the other catalog modules: pure normalisation around a thin
// fetch shell, an injectable fetchFn so tests never touch the network, and no
// throwing — a failure returns null and the caller carries on without it.

const BASE = 'https://www.omdbapi.com/'

// Abort a hung request rather than letting a lookup wait forever; the second
// opinion is an enhancement, so it must never itself become the thing that
// hangs. Same 10s ceiling as the other catalog modules (catalog/jikan.js).
const REQUEST_TIMEOUT_MS = 10000

// OMDb answers a bad request with HTTP 200 and { Response: 'False' }, so the
// status code alone never tells you whether it worked.
function isFailure(raw) {
  if (!raw || typeof raw !== 'object') return true
  if (raw.Response === 'False') return true
  return false
}

// "Request limit reached!" is the free tier's daily cap, not a fact about the
// title. Caching that null would keep the answer wrong until restart, long
// after the limit resets. "Movie not found!" is a real answer and cacheable.
function isRateLimited(raw) {
  return isFailure(raw) &&
    /limit/i.test(String(raw && typeof raw === 'object' ? raw.Error : ''))
}

// Everything is a string, and "N/A" is how it says nothing.
function _str(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t === 'N/A') return null
  return t
}

function _num(v) {
  const t = _str(v)
  if (t == null) return null
  const n = Number(t.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? n : null
}

// "2,222,804" -> 2222804
function _votes(v) {
  const t = _str(v)
  if (t == null) return null
  const n = Number(t.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

// "175 min" -> 175
function _runtime(v) {
  const t = _str(v)
  if (t == null) return null
  const m = /^(\d+)/.exec(t)
  return m ? Number(m[1]) : null
}

// "$136,381,073" -> 136381073
function _money(v) {
  const t = _str(v)
  if (t == null) return null
  const n = Number(t.replace(/[^0-9]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

// The Ratings array is the only place Rotten Tomatoes and Metacritic appear
// together, and each carries its own scale: "9.2/10", "97%", "100/100". They
// are normalised to a percentage so they can sit beside each other, and the
// original string is kept because "97%" is what a person recognises.
const RATING_SOURCES = {
  'Internet Movie Database': 'imdb',
  'Rotten Tomatoes': 'rottenTomatoes',
  Metacritic: 'metacritic',
}

function _percent(value) {
  const t = _str(value)
  if (t == null) return null
  const pct = /^([\d.]+)%$/.exec(t)
  if (pct) return Math.round(Number(pct[1]))
  const outOf = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(t)
  if (outOf) {
    const max = Number(outOf[2])
    if (!max) return null
    return Math.round((Number(outOf[1]) / max) * 100)
  }
  return null
}

function normalizeRatings(list) {
  const out = {}
  if (!Array.isArray(list)) return out
  for (const entry of list) {
    const key = RATING_SOURCES[entry?.Source]
    if (!key) continue
    const display = _str(entry.Value)
    if (!display) continue
    out[key] = { display, percent: _percent(entry.Value) }
  }
  return out
}

// "Won 3 Oscars. 31 wins & 31 nominations total" carries more than a score
// does, so the headline is kept whole and the numbers are pulled out for a
// compact badge.
function normalizeAwards(raw) {
  const text = _str(raw)
  if (!text) return null
  const oscars = /won (\d+) oscar/i.exec(text)
  const wins = /(\d+) win/i.exec(text)
  const noms = /(\d+) nomination/i.exec(text)
  return {
    text,
    oscars: oscars ? Number(oscars[1]) : 0,
    wins: wins ? Number(wins[1]) : 0,
    nominations: noms ? Number(noms[1]) : 0,
  }
}

function normalize(raw) {
  if (isFailure(raw)) return null
  const ratings = normalizeRatings(raw.Ratings)
  return {
    imdbId: _str(raw.imdbID),
    title: _str(raw.Title),
    year: _str(raw.Year),
    // Kept for the TMDB-down fallback (detailFromOmdb): the enrichment path
    // ignores them because TMDB already carries a plot and a poster, but when
    // OMDb is standing in for TMDB they are the only source there is.
    plot: _str(raw.Plot),
    poster: _str(raw.Poster),
    rated: _str(raw.Rated),
    runtime: _runtime(raw.Runtime),
    director: _str(raw.Director),
    writer: _str(raw.Writer),
    country: _str(raw.Country),
    language: _str(raw.Language),
    boxOffice: _money(raw.BoxOffice),
    awards: normalizeAwards(raw.Awards),
    ratings,
    // Hoisted because the card and the detail hero read these constantly.
    imdbRating: _num(raw.imdbRating),
    imdbVotes: _votes(raw.imdbVotes),
    metascore: _num(raw.Metascore),
    rottenTomatoes: ratings.rottenTomatoes ? ratings.rottenTomatoes.percent : null,
  }
}

function buildUrl(apiKey, params) {
  const q = new URLSearchParams({ apikey: String(apiKey || '') })
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') q.set(k, String(v))
  }
  // Short plots only: the app has TMDB's overview already and the long form is
  // several hundred wasted bytes per title.
  if (!q.has('plot')) q.set('plot', 'short')
  return `${BASE}?${q.toString()}`
}

function createOmdbCatalog({ apiKey, fetchFn, cache = null,
  timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const fetcher = fetchFn || fetch
  const key = () => (typeof apiKey === 'function' ? apiKey() : apiKey)

  async function _get(params) {
    const k = key()
    // No key is not an error. It is a second opinion the user has not set up,
    // and everything that uses it must work without it.
    if (!k) return null
    const url = buildUrl(k, params)
    if (cache) {
      const hit = cache.get(url)
      if (hit !== undefined) return hit
    }
    // AbortController bounds the request so a hung socket cannot stall the
    // detail page. Not every injected fetcher honours `signal`, so the timer is
    // cleared regardless of how the request settles.
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const res = await fetcher(url, controller ? { signal: controller.signal } : undefined)
      if (!res || !res.ok) return null
      const raw = await res.json()
      const value = normalize(raw)
      if (cache && !isRateLimited(raw)) cache.set(url, value)
      return value
    } catch (_) {
      // A timeout, a dead network — all the same to the caller: no second
      // opinion right now, and the app carries on.
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    // The reliable path: TMDB gives an IMDb id for almost everything.
    byImdbId(imdbId) {
      if (!imdbId) return Promise.resolve(null)
      return _get({ i: imdbId })
    },
    // The fallback, for titles TMDB has no IMDb id for. Year narrows it because
    // remakes share a title far more often than they share a year.
    byTitle(title, year) {
      if (!title) return Promise.resolve(null)
      return _get({ t: title, ...(year ? { y: year } : {}) })
    },

    // TMDB down: OMDb standing in for the detail page.
    //
    // The methods above return OMDb's own rich shape — ratings, awards, box
    // office — which the app layers ON TOP of a TMDB detail. But when TMDB
    // itself is unreachable there is no base to layer onto, and the detail page
    // needs a minimum it can render standalone. `detailFromOmdb` asks OMDb for
    // the full plot (not the short one the enrichment path uses) and reshapes
    // the answer into the small subset of the TMDB detail shape the hero and
    // card actually read, so a caller can drop it in where a TMDB entry was
    // expected without a second code path.
    //
    // Shape (a deliberate subset of the TMDB normalized entry — same key names
    // and types, so it is interchangeable at the read sites that matter):
    //   {
    //     title:    string|null,   // TMDB: entry.title
    //     year:     string|null,   // TMDB: entry.year  (a 4-char string)
    //     overview: string|null,   // TMDB: entry.overview  (OMDb's full Plot)
    //     poster:   string|null,   // TMDB: entry.poster (absolute image URL)
    //     rating:   number|null,   // TMDB: entry.rating (0-10; IMDb's 0-10)
    //     imdbId:   string|null,   // TMDB: entry.imdbId
    //     runtime:  number|null,   // minutes
    //   }
    // Every value can be null; the caller renders what is present. Returns null
    // (never throws, never a half-object) when OMDb has nothing or is down.
    //
    // Accepts either an IMDb id ('tt…') or a title, so the same call serves a
    // detail opened by id and one opened from a search that only had a name.
    // Year narrows a title lookup exactly as byTitle does.
    async detailFromOmdb(imdbIdOrTitle, year) {
      if (!imdbIdOrTitle) return null
      // 'tt' + digits is an IMDb id; anything else is a title to search for.
      const isImdbId = /^tt\d+$/i.test(String(imdbIdOrTitle))
      const params = isImdbId
        ? { i: imdbIdOrTitle, plot: 'full' }
        : { t: imdbIdOrTitle, plot: 'full', ...(year ? { y: year } : {}) }
      const d = await _get(params)
      if (!d) return null
      return {
        title: d.title,
        year: d.year,
        overview: d.plot,
        poster: d.poster,
        rating: d.imdbRating,
        imdbId: d.imdbId,
        runtime: d.runtime,
      }
    },
  }
}

module.exports = {
  BASE,
  REQUEST_TIMEOUT_MS,
  isFailure,
  isRateLimited,
  normalizeRatings,
  normalizeAwards,
  normalize,
  buildUrl,
  createOmdbCatalog,
}
