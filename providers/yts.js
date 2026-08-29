'use strict'
// YTS torrent provider — pure normalisation + URL builder around a thin fetch
// shell. CommonJS only; no runtime deps beyond the global `fetch`. Every I/O
// path accepts an injectable `fetchFn` so tests run without the network.
//
// YTS (keyless public API) answers
// `GET <base>/api/v2/list_movies.json?query_term=<title year>&limit=5`
// with `{ data: { movies: [{ id, title, year, torrents: [...] }] } }`. Each
// torrent carries `url` (the magnet link) and `hash` (the info hash). This
// provider returns `kind: 'torrent'` entries with no direct URL — a later task
// streams the magnet through the existing WebTorrent client.
//
// The canonical `yts.mx` domain is dead, so the provider takes an ordered list
// of `baseUrls` and falls back across them: a mirror that does not answer with
// valid `list_movies` JSON (HTML 404, Cloudflare challenge, non-JSON body, or a
// network error) is treated as failed and the next mirror is tried. If every
// mirror fails the provider returns `[]` — it never throws.

const DEFAULT_BASE_URLS = [
  'https://movies-api.accel.li',
  'https://yts.gg',
]
const VALID_QUALITIES = ['2160p', '1080p', '720p', '480p']

function mapQuality(q) {
  return VALID_QUALITIES.includes(q) ? q : 'unknown'
}

// YTS reports `audio_channels` as a string ("2", "5.1", "7.1") on newer API
// responses and omits it on older ones. This used to be hardcoded to '5.1' for
// every torrent, which made the surround-aware ranker sort on a value that was
// simply invented — most YTS web-rips are stereo. Unknown now means null, and
// the ranker treats null as "not surround" rather than promoting it.
function mapAudioLayout(raw) {
  const ch = raw == null ? null : String(raw).trim()
  if (!ch) return null
  if (ch === '5.1' || ch === '6') return '5.1'
  if (ch === '7.1' || ch === '8') return '7.1'
  if (ch === '2' || ch === '2.0') return 'stereo'
  if (ch === '1' || ch === '1.0') return 'mono'
  return null
}

// Titles differ between TMDB and YTS in punctuation and separators far more
// often than in words ("Spider-Man: Across the Spider-Verse" vs
// "Spider Man Across the Spider Verse"). Comparing on a punctuation-stripped,
// collapsed-whitespace form turns most of those near-misses into matches,
// while still refusing genuinely different films.
function normalizeTitle(title) {
  return String(title == null ? '' : title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function buildListUrl(baseUrl, query) {
  return `${baseUrl}/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=5`
}

// One entry per torrent in `raw.torrents`. A torrent missing its `hash` is
// skipped (there is nothing to hand to the torrent engine).
function normalizeMovieResult(raw) {
  raw = raw || {}
  const torrents = Array.isArray(raw.torrents) ? raw.torrents : []
  return torrents
    .filter(t => t && typeof t.hash === 'string' && t.hash.length > 0)
    .map(t => {
      const quality = mapQuality(t.quality)
      const audioLayout = mapAudioLayout(t.audio_channels)
      const seeds = Number(t.seeds) || 0
      return {
        kind: 'torrent',
        url: null,
        magnet: typeof t.url === 'string' && t.url.length > 0 ? t.url : null,
        infoHash: t.hash,
        fileIndex: 0,
        source: 'YTS',
        quality,
        label: `YTS · ${quality}${audioLayout ? ` · ${audioLayout}` : ''}${seeds ? ` · ${seeds} seeds` : ''}`,
        audioLayout,
        seeds,
        sub: null,
        dub: null,
      }
    })
}

// Pick the best movie for a request: exact (case-insensitive, trimmed) title
// match, then — when `request.year` is given — prefer the title match whose
// `year` equals it.
function pickBestMovie(movies, request) {
  const title = normalizeTitle(request.title)
  if (!title) return null
  const year = request.year != null && request.year !== '' ? String(request.year) : null
  // Exact (normalized) title first; only if nothing matches do we accept a
  // title that merely contains the requested one, which catches YTS entries
  // carrying an edition suffix ("Dune Part Two Extended").
  let titleMatches = (movies || []).filter(m => m && normalizeTitle(m.title) === title)
  if (titleMatches.length === 0) {
    titleMatches = (movies || []).filter(m => {
      const t = normalizeTitle(m && m.title)
      return t && (t.startsWith(title + ' ') || t === title)
    })
  }
  if (titleMatches.length === 0) return null
  if (year) {
    const yearMatch = titleMatches.find(m => String(m.year) === year)
    if (yearMatch) return yearMatch
  }
  return titleMatches[0]
}

// Try a single mirror. Returns the matched movie object, or `null` when the
// mirror is dead (network error / non-OK status / non-JSON body / no match).
async function tryMirror(baseUrl, term, request, fetcher) {
  try {
    const url = buildListUrl(baseUrl, term)
    const res = await fetcher(url)
    if (!res || !res.ok) return null
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch (_err) {
      return null
    }
    const movies = (data && data.data && data.data.movies) || []
    return pickBestMovie(movies, request)
  } catch (_err) {
    return null
  }
}

function createYtsProvider({ fetchFn, baseUrls = DEFAULT_BASE_URLS } = {}) {
  const fetcher = fetchFn || fetch
  const urls = Array.isArray(baseUrls) && baseUrls.length > 0 ? baseUrls : DEFAULT_BASE_URLS

  return async function ytsProvider(request) {
    request = request || {}
    const title = (request.title || '').trim()
    if (!title) return []
    const term = request.year != null && request.year !== '' ? `${title} ${request.year}` : title
    for (const baseUrl of urls) {
      const movie = await tryMirror(baseUrl, term, request, fetcher)
      if (movie) return normalizeMovieResult(movie)
    }
    return []
  }
}

module.exports = {
  DEFAULT_BASE_URLS,
  mapQuality,
  mapAudioLayout,
  normalizeTitle,
  buildListUrl,
  normalizeMovieResult,
  pickBestMovie,
  createYtsProvider,
}
