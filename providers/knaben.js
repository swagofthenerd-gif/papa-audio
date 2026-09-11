'use strict'
// Knaben aggregator provider — the single biggest source-count win.
//
// Knaben (knaben.org) is a meta-indexer: one query is fanned out across dozens
// of upstream trackers (The Pirate Bay, RuTracker, 1337x, nyaa, Rutor, TGx, …)
// and returned as one merged list. Where the specialist providers (YTS, EZTV,
// nyaa, apibay) each see one index, Knaben sees the union of many, so a film or
// episode that no single specialist carried often still turns up here.
//
// API (verified live 2026-09-04):
//   POST https://api.knaben.org/v1
//   Content-Type: application/json
//   {
//     "search_type": "100%",        // "100%" = query-relevant. "score" IGNORES
//                                   //   the query and returns global top-seeded
//                                   //   junk (PC software) — do NOT use it.
//     "query": "Oppenheimer 2023",
//     "categories": [3000000],      // optional; parent ids below. Omit = all.
//     "order_by": "seeders",
//     "order_direction": "desc",
//     "size": 50,
//     "hide_xxx": true
//   }
// answers with
//   {
//     "total": { "relation": "gte"|"eq", "value": N },
//     "hits": [ {
//        "title": "Oppenheimer.2023.1080p.BluRay.DD5.1.x264-GalaxyRG",
//        "hash": "491AA0E19CBDB03B100961DB82315C08643A6139",  // 40-hex info hash
//        "magnetUrl": "magnet:?xt=urn:btih:...&tr=...",        // full magnet
//        "seeders": 1087, "peers": 319,
//        "bytes": 2166271375,
//        "category": "Movies / HD",
//        "categoryId": [2000000, 3001000],                    // may be several
//        "cachedOrigin": "The Pirate Bay (proxy)",            // upstream tracker
//        "date": "...", "details": "...", "link": "...", ...
//     } ]
//   }
//
// Category taxonomy (parent ids, verified live):
//   3000000 Movies  (3001000 HD, 3003000 UHD, 3005000 Foreign, 3008000 …)
//   2000000 TV      (2001000 HD, 2003000 UHD)
//   6000000 Anime   (6001000 Subbed, 6002000 Dubbed …)
// A hit's `categoryId` is an array and often carries BOTH a movie/tv id and an
// anime id for anime releases, so category filtering is a hint, not a gate — the
// requested-title / episode check below is what actually keeps results honest.
//
// Like the other torrent providers this returns `kind: 'torrent'` entries with
// no direct URL, races its (single) mirror, never throws, and answers only the
// media types it can serve.

const {
  parseQuality, parseAudioLayout, isLowQualitySource, parseDub, parseSub,
  magnetFromHash,
} = require('./quality')
const {
  matchesTitle, matchesYear, matchesEpisode, matchesAnimeEpisode, requestTitles,
} = require('./apibay')
const { isPack } = require('./nyaa')
const { raceMirrors } = require('./mirror-race')

const DEFAULT_BASE_URLS = [
  'https://api.knaben.org',
]

// Parent category ids by request type. Used as a search hint only.
const CATEGORIES = {
  movie: [3000000],
  tv: [2000000],
  anime: [6000000],
}

function buildEndpoint(baseUrl) {
  return `${baseUrl}/v1`
}

// The POST body for a query. `search_type` MUST be "100%": "score" throws the
// query away and returns whatever is most-seeded globally.
function buildBody(query, type, size) {
  const body = {
    search_type: '100%',
    query: String(query == null ? '' : query),
    order_by: 'seeders',
    order_direction: 'desc',
    size: Number.isFinite(size) && size > 0 ? Math.min(size, 300) : 50,
    hide_xxx: true,
  }
  const cats = CATEGORIES[type]
  if (cats) body.categories = cats
  return body
}

// Knaben hands back both `hash` and a ready-made `magnetUrl`. Prefer the info
// hash for identity/dedupe; rebuild the magnet from the hash so every entry
// carries the same well-trackered magnet the rest of the app relies on (the
// upstream `magnetUrl` sometimes announces only to a dead private tracker).
function extractInfoHash(raw) {
  const h = String((raw && raw.hash) || '').trim()
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toUpperCase()
  // Fall back to the info hash embedded in the magnet, if any.
  const mag = String((raw && raw.magnetUrl) || '')
  const m = /btih:([0-9a-f]{40})/i.exec(mag)
  return m ? m[1].toUpperCase() : null
}

// Anime queries can build a query per known name; movies/tv use the one title.
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
  const bytes = Number(raw && raw.bytes)
  const sizeGb = Number.isFinite(bytes) && bytes > 0
    ? (bytes / 1e9).toFixed(1) + ' GB' : null
  const origin = String((raw && raw.cachedOrigin) || '').trim()
  const pack = type === 'anime' ? isPack(name, episode) : false
  const dub = type === 'anime' ? parseDub(name) : false
  return {
    kind: 'torrent',
    url: null,
    magnet,
    infoHash,
    fileIndex: 0,
    source: 'Knaben',
    quality,
    // Kept but flagged, exactly like apibay: a cam is playable but never chosen
    // ahead of a real encode.
    lowQuality,
    title: name,
    label: `Knaben · ${lowQuality ? 'CAM/TS (poor quality)' : quality}` +
      `${audioLayout ? ` · ${audioLayout}` : ''}` +
      `${type === 'anime' ? (dub ? ' · dub' : ' · sub') : ''}` +
      `${pack ? ' · season pack' : ''}` +
      `${sizeGb ? ` · ${sizeGb}` : ''}` +
      `${seeds ? ` · ${seeds} seeds` : ''}` +
      `${origin ? ` · via ${origin}` : ''}`,
    audioLayout,
    seeds,
    seeders: seeds,
    sizeBytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
    // The streamer needs to know when it must pick one episode out of many.
    isPack: pack,
    // Carried for the per-request matcher; stripped before return.
    name,
    sub: type === 'anime' ? (!dub || parseSub(name)) : null,
    dub: type === 'anime' ? dub : null,
  }
}

// The mirror that answered most recently leads the race on the next query.
// Module-level on purpose: remembered for the session, never persisted.
let _lastGoodMirror = null

function _orderMirrors(urls) {
  if (!_lastGoodMirror || !urls.includes(_lastGoodMirror)) return urls
  return [_lastGoodMirror, ...urls.filter(u => u !== _lastGoodMirror)]
}

function _resetMirrorHealth() {
  _lastGoodMirror = null
}

async function tryMirror(baseUrl, query, type, size, fetcher, signal) {
  try {
    const res = await fetcher(buildEndpoint(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(query, type, size)),
      signal,
    })
    if (!res || !res.ok) return null
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch (_err) { return null }
    const hits = data && Array.isArray(data.hits) ? data.hits : null
    // An empty hits array is a valid "nothing found" answer, not a dead mirror.
    // Returning null there would make the race treat a working mirror as failed
    // and burn the whole timeout looking for one that "works".
    return Array.isArray(hits) ? hits : null
  } catch (_err) {
    return null
  }
}

function createKnabenProvider({ fetchFn, baseUrls = DEFAULT_BASE_URLS, maxResults = 30 } = {}) {
  const fetcher = fetchFn || fetch
  const urls = Array.isArray(baseUrls) && baseUrls.length > 0 ? baseUrls : DEFAULT_BASE_URLS

  return async function knabenProvider(request) {
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
        tryMirror(baseUrl, query, type, maxResults, fetcher, signal))
      if (won) _lastGoodMirror = won.baseUrl
      const hits = won ? won.result : null
      if (!hits || !hits.length) continue
      for (const raw of hits) {
        const entry = normalizeResult(raw, { type, episode: request.episode })
        if (!entry) continue
        if (seen.has(entry.infoHash)) continue
        // A release only has to match one of the names the title goes by.
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
      // A query that produced usable results is enough; the broader fallback
      // queries exist only to rescue an empty first attempt.
      if (entries.length) break
    }

    // Real encodes first, then by seeds — the router does the final ordering,
    // this only keeps a cam rip off the head of the provider's own list.
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
  CATEGORIES,
  buildEndpoint,
  buildBody,
  buildQueries,
  extractInfoHash,
  normalizeResult,
  createKnabenProvider,
  _resetMirrorHealth,
}
