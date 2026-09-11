'use strict'
// Direct-stream (HTTP) provider adapter for movies and TV.
//
// Unlike `providers/yts.js` (which owns its fetch path), this module is an
// *adapter*: it runs an injectable list of `resolvers` and merges their
// entries, wrapping each in try/catch so a dead resolver is silently skipped.
// Resolvers are plain `async (request) => entries[]` functions — swapped in by
// the caller — so a site that changes or rotates can be retired without
// touching the router, the engine, or the UI.
//
// The single concrete resolver shipped here is `vidsrc`: a best-effort mapper
// from a TMDB id to a known embed URL template. It returns one `kind:'http'`
// entry tagged `quality:'1080p'`, `audioLayout:null`. It is deliberately tiny
// and does no page scraping — treat it as a stub to be replaced or tuned live.

const VIDSRC_BASE = 'https://vidsrc.to'

// Coerce an arbitrary resolver result into a valid `kind:'http'` entry.
// Missing fields become `null`; `source` defaults to `'http'`.
function normalizeHttpEntry(raw) {
  raw = raw || {}
  return {
    kind: 'http',
    url: typeof raw.url === 'string' && raw.url.length > 0 ? raw.url : null,
    source: typeof raw.source === 'string' && raw.source.length > 0 ? raw.source : 'http',
    quality: raw.quality != null ? raw.quality : null,
    title: typeof raw.title === 'string' ? raw.title : null,
    label: raw.label != null ? raw.label : (typeof raw.title === 'string' ? raw.title : null),
    audioLayout: raw.audioLayout != null ? raw.audioLayout : null,
    sub: raw.sub != null ? raw.sub : null,
    dub: raw.dub != null ? raw.dub : null,
  }
}

// Pure URL builder for the vidsrc embed template. Returns `null` when there is
// no `tmdbId` to map.
function buildVidsrcUrl(request, baseUrl = VIDSRC_BASE) {
  request = request || {}
  const tmdbId = request.tmdbId
  if (tmdbId == null || tmdbId === '') return null
  if (request.type === 'tv') {
    const season = request.season != null ? request.season : 1
    const episode = request.episode != null ? request.episode : 1
    return `${baseUrl}/embed/tv/${tmdbId}/${season}/${episode}`
  }
  return `${baseUrl}/embed/movie/${tmdbId}`
}

// Best-effort vidsrc resolver: maps a TMDB id to the embed URL and returns a
// single entry. No network, no scraping — the URL may not resolve against the
// live site, which is exactly why it sits behind the adapter's try/catch.
function createVidsrcResolver({ baseUrl = VIDSRC_BASE } = {}) {
  return async function vidsrcResolver(request) {
    request = request || {}
    const url = buildVidsrcUrl(request, baseUrl)
    if (!url) return []
    return [
      normalizeHttpEntry({
        url,
        source: 'vidsrc',
        quality: '1080p',
        label: 'vidsrc · 1080p',
        audioLayout: null,
        sub: null,
        dub: null,
      }),
    ]
  }
}

// Adapter: fan out to each resolver, flatten their entries, skip anything that
// throws or returns a non-array. No resolvers → `[]`.
function createMovieTvProvider({ fetchFn, resolvers = [] } = {}) {
  void fetchFn // resolvers own their I/O; `fetchFn` accepted for interface parity
  const list = Array.isArray(resolvers) ? resolvers : []
  return async function movieTvProvider(request) {
    request = request || {}
    const entries = []
    for (const resolver of list) {
      if (typeof resolver !== 'function') continue
      try {
        const result = await resolver(request)
        if (!Array.isArray(result)) continue
        for (const entry of result) {
          if (entry && typeof entry === 'object') entries.push(entry)
        }
      } catch (_err) {
        // dead resolver — skip
      }
    }
    return entries
  }
}

module.exports = {
  normalizeHttpEntry,
  buildVidsrcUrl,
  createVidsrcResolver,
  createMovieTvProvider,
}
