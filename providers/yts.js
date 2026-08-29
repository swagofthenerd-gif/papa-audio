'use strict'
// YTS torrent provider — pure normalisation + URL builder around a thin fetch
// shell. CommonJS only; no runtime deps beyond the global `fetch`. Every I/O
// path accepts an injectable `fetchFn` so tests run without the network.
//
// YTS (keyless public API) answers
// `GET https://yts.mx/api/v2/list_movies.json?query_term=<title year>&limit=5`
// with `{ data: { movies: [{ id, title, year, torrents: [...] }] } }`. Each
// torrent carries `url` (the magnet link) and `hash` (the info hash). This
// provider returns `kind: 'torrent'` entries with no direct URL — a later task
// streams the magnet through the existing WebTorrent client.

const YTS_BASE = 'https://yts.mx'
const VALID_QUALITIES = ['2160p', '1080p', '720p', '480p']

function mapQuality(q) {
  return VALID_QUALITIES.includes(q) ? q : 'unknown'
}

function buildListUrl(baseUrl, query) {
  return `${baseUrl}/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=5`
}

// One entry per torrent in `raw.torrents`. A torrent missing its `hash` is
// skipped (there is nothing to hand to the torrent engine).
function normalizeMovieResult(raw, { baseUrl = YTS_BASE } = {}) {
  void baseUrl
  raw = raw || {}
  const torrents = Array.isArray(raw.torrents) ? raw.torrents : []
  return torrents
    .filter(t => t && typeof t.hash === 'string' && t.hash.length > 0)
    .map(t => {
      const quality = mapQuality(t.quality)
      return {
        kind: 'torrent',
        url: null,
        magnet: typeof t.url === 'string' && t.url.length > 0 ? t.url : null,
        infoHash: t.hash,
        fileIndex: 0,
        source: 'YTS',
        quality,
        label: `YTS · ${quality}`,
        audioLayout: '5.1',
        sub: null,
        dub: null,
      }
    })
}

// Pick the best movie for a request: exact (case-insensitive, trimmed) title
// match, then — when `request.year` is given — prefer the title match whose
// `year` equals it.
function pickBestMovie(movies, request) {
  const title = (request.title || '').trim().toLowerCase()
  if (!title) return null
  const year = request.year != null && request.year !== '' ? String(request.year) : null
  const titleMatches = (movies || []).filter(
    m => m && (m.title || '').trim().toLowerCase() === title
  )
  if (titleMatches.length === 0) return null
  if (year) {
    const yearMatch = titleMatches.find(m => String(m.year) === year)
    if (yearMatch) return yearMatch
  }
  return titleMatches[0]
}

function createYtsProvider({ fetchFn } = {}) {
  const fetcher = fetchFn || fetch

  return async function ytsProvider(request) {
    request = request || {}
    const title = (request.title || '').trim()
    if (!title) return []
    const term = request.year != null && request.year !== '' ? `${title} ${request.year}` : title
    const url = buildListUrl(YTS_BASE, term)
    const res = await fetcher(url)
    if (!res || !res.ok) return []
    const data = await res.json()
    const movies = (data && data.data && data.data.movies) || []
    const movie = pickBestMovie(movies, request)
    if (!movie) return []
    return normalizeMovieResult(movie)
  }
}

module.exports = {
  mapQuality,
  buildListUrl,
  normalizeMovieResult,
  createYtsProvider,
}
