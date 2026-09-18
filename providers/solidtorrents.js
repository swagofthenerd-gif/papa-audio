'use strict'
// SolidTorrents aggregator provider — a second meta-index alongside Knaben.
//
// SolidTorrents (solidtorrents.to) crawls many public trackers (TGx, YTS, RARBG
// re-ups, nyaa re-ups, …) and exposes a keyless JSON search API, so like Knaben
// it answers one query with results from several upstream sources. It is a
// distinct crawl from Knaben's, so it fills gaps Knaben misses and vice versa;
// running both widens coverage more than either alone.
//
// API (verified live 2026-09-04):
//   GET https://solidtorrents.to/api/v1/search?q=<query>&sort=seeders
// answers with
//   {
//     "success": true,
//     "query": "oppenheimer",
//     "results": [ {
//        "infohash": "491AA0E19CBDB03B100961DB82315C08643A6139", // 40-hex
//        "title": "Oppenheimer.2023.1080p.BluRay.DD5.1.x264-GalaxyRG[TGx]",
//        "size": 2166271375,      // bytes
//        "category": 2,           // 1=Other/catch-all, 2=Movies, 3=TV (UNRELIABLE:
//                                 //   anime and much else lands in 1)
//        "seeders": 1312, "leechers": 443,
//        "verified": true, "updatedAt": "..."
//     } ]
//   }
//
// The response carries no magnet — only the info hash — so the magnet is built
// locally from the hash the way apibay/nyaa do. Category is too coarse to gate
// on (anime falls into the catch-all `1`), so results are kept honest purely by
// the shared requested-title / year / episode matchers, never by category.
//
// Returns `kind: 'torrent'` entries with no direct URL, races its mirror, never
// throws, answers only movie/tv/anime.

const {
  parseQuality, parseAudioLayout, isLowQualitySource, parseDub, parseSub,
  magnetFromHash,
  fmtSize,
} = require('./quality')
const {
  matchesTitle, matchesYear, matchesEpisode, matchesAnimeEpisode, requestTitles,
} = require('./apibay')
const { isPack } = require('./nyaa')
const { raceMirrors } = require('./mirror-race')

const DEFAULT_BASE_URLS = [
  'https://solidtorrents.to',
  'https://solidtorrents.eu',
]

function buildSearchUrl(baseUrl, query) {
  return `${baseUrl}/api/v1/search?q=${encodeURIComponent(query)}&sort=seeders`
}

function extractInfoHash(raw) {
  const h = String((raw && raw.infohash) || '').trim()
  return /^[0-9a-f]{40}$/i.test(h) ? h.toUpperCase() : null
}

// Movies as "<title> <year>" then bare; tv as SxxEyy then season then bare;
// anime per known name with the padded episode / absolute number.
function buildQueries(request) {
  const title = String((request && request.title) || '').trim()
  if (request && request.type === 'anime') {
    const names = requestTitles(request)
    if (!names.length) return []
    const e = Number(request.episode)
    const abs = Number(request.absoluteEpisode)
    const out = []
    for (const name of names) {
      if (Number.isFinite(e) && e >= 1) out.push(`${name} ${String(e).padStart(2, '0')}`)
      if (Number.isFinite(abs) && abs >= 1 && abs !== e) {
        out.push(`${name} ${String(abs).padStart(2, '0')}`)
      }
      out.push(name)
    }
    return out
  }
  if (!title) return []
  if (request.type === 'tv') {
    const s = Number(request.season)
    const e = Number(request.episode)
    const out = []
    if (Number.isFinite(s) && Number.isFinite(e)) {
      out.push(`${title} S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`)
      out.push(`${title} season ${s}`)
    }
    out.push(title)
    return out
  }
  const out = []
  if (request.year != null && request.year !== '') out.push(`${title} ${request.year}`)
  out.push(title)
  return out
}

function normalizeResult(raw, { type = 'movie', episode = null } = {}) {
  const infoHash = extractInfoHash(raw)
  if (!infoHash) return null
  const name = String((raw && raw.title) || '')
  const magnet = magnetFromHash(infoHash, name)
  if (!magnet) return null
  const quality = parseQuality(name)
  const audioLayout = parseAudioLayout(name)
  const seeds = Number(raw && raw.seeders) || 0
  const lowQuality = isLowQualitySource(name)
  const bytes = Number(raw && raw.size)
  const sizeGb = fmtSize(bytes)
  const pack = type === 'anime' ? isPack(name, episode) : false
  const dub = type === 'anime' ? parseDub(name) : false
  return {
    kind: 'torrent',
    url: null,
    magnet,
    infoHash,
    fileIndex: 0,
    source: 'SolidTorrents',
    quality,
    lowQuality,
    title: name,
    label: `SolidTorrents · ${lowQuality ? 'CAM/TS (poor quality)' : quality}` +
      `${audioLayout ? ` · ${audioLayout}` : ''}` +
      `${type === 'anime' ? (dub ? ' · dub' : ' · sub') : ''}` +
      `${pack ? ' · season pack' : ''}` +
      `${sizeGb ? ` · ${sizeGb}` : ''}` +
      `${seeds ? ` · ${seeds} seeds` : ''}`,
    audioLayout,
    seeds,
    seeders: seeds,
    sizeBytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
    isPack: pack,
    name,
    sub: type === 'anime' ? (!dub || parseSub(name)) : null,
    dub: type === 'anime' ? dub : null,
  }
}

let _lastGoodMirror = null

function _orderMirrors(urls) {
  if (!_lastGoodMirror || !urls.includes(_lastGoodMirror)) return urls
  return [_lastGoodMirror, ...urls.filter(u => u !== _lastGoodMirror)]
}

function _resetMirrorHealth() {
  _lastGoodMirror = null
}

async function tryMirror(baseUrl, query, fetcher, signal) {
  try {
    const res = await fetcher(buildSearchUrl(baseUrl, query), { signal })
    if (!res || !res.ok) return null
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch (_err) { return null }
    if (!data || data.success === false) return null
    const results = Array.isArray(data.results) ? data.results : null
    // Empty results is a valid answer, not a dead mirror.
    return Array.isArray(results) ? results : null
  } catch (_err) {
    return null
  }
}

function createSolidTorrentsProvider({ fetchFn, baseUrls = DEFAULT_BASE_URLS, maxResults = 30 } = {}) {
  const fetcher = fetchFn || fetch
  const urls = Array.isArray(baseUrls) && baseUrls.length > 0 ? baseUrls : DEFAULT_BASE_URLS

  return async function solidTorrentsProvider(request) {
    request = request || {}
    const type = request.type
    if (type !== 'movie' && type !== 'tv' && type !== 'anime') return []
    const queries = buildQueries(request)
    if (!queries.length) return []
    const names = type === 'anime' ? requestTitles(request) : [request.title]
    const seen = new Set()
    const entries = []

    for (const query of queries) {
      const won = await raceMirrors(_orderMirrors(urls), (baseUrl, signal) =>
        tryMirror(baseUrl, query, fetcher, signal))
      if (won) _lastGoodMirror = won.baseUrl
      const rows = won ? won.result : null
      if (!rows || !rows.length) continue
      for (const raw of rows) {
        const entry = normalizeResult(raw, { type, episode: request.episode })
        if (!entry) continue
        if (seen.has(entry.infoHash)) continue
        if (!names.some(n => matchesTitle(entry.name, n))) continue
        if (type === 'movie' && !matchesYear(entry.name, request.year)) continue
        if (type === 'tv' &&
          !matchesEpisode(entry.name, request.season, request.episode)) continue
        if (type === 'anime' && !matchesAnimeEpisode(entry.name, request.episode, {
          season: request.season, absoluteEpisode: request.absoluteEpisode,
        })) continue
        seen.add(entry.infoHash)
        entries.push(entry)
      }
      if (entries.length) break
    }

    entries.sort((a, b) => {
      if (a.lowQuality !== b.lowQuality) return a.lowQuality ? 1 : -1
      return b.seeds - a.seeds
    })
    return entries.slice(0, maxResults).map(e => {
      delete e.name
      return e
    })
  }
}

module.exports = {
  DEFAULT_BASE_URLS,
  buildSearchUrl,
  buildQueries,
  extractInfoHash,
  normalizeResult,
  createSolidTorrentsProvider,
  _resetMirrorHealth,
}
