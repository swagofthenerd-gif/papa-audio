'use strict'
// Jackett / Prowlarr provider (App roadmap #39) — a second tier of torrent
// sources on top of the built-in indexers.
//
// Jackett and Prowlarr both expose the same Torznab "results" JSON API that
// Sonarr/Radarr drive:
//   GET <base>/api/v2.0/indexers/all/results?apikey=<key>&Query=<terms>
// answering with
//   { "Results": [ {
//       "Title": "Oppenheimer.2023.1080p.BluRay.DDP5.1.x264-GalaxyRG",
//       "MagnetUri": "magnet:?xt=urn:btih:...&tr=...",   // may be absent
//       "Link": "https://.../download.torrent",          // a .torrent file URL
//       "InfoHash": "491AA0E19CBDB03B100961DB82315C08643A6139", // may be absent
//       "Seeders": 1087, "Peers": 319,
//       "Size": 2166271375,                              // bytes
//       "PublishDate": "...", "CategoryDesc": "...", "Tracker": "1337x", ...
//   } ] }
// Prowlarr mirrors this at the same path with an identical body, so one provider
// serves both. The user points it at their own instance and pastes the api key
// (stored keys `jackettUrl`, `jackettApiKey`); with either blank the provider is
// never even constructed, so it is off by default (main gates registration).
//
// Config-gated, so unlike the built-in indexers there is no default mirror list:
// the base URL is whatever the user configured. Like every other provider it
// returns `kind: 'torrent'` entries, never throws (a dead instance returns []),
// and answers only the media types the router asks it for (movie/tv/anime).
//
// MAGNET-ONLY on purpose. A Torznab `Link` is a URL to a .torrent metadata file,
// not a magnet and not a media stream — the app's WebTorrent path takes a magnet
// (torrent-stream.js), and fetching + parsing a .torrent to derive one is out of
// scope here. So a result is kept only when a magnet is present (a real
// `MagnetUri`, or one rebuilt from an `InfoHash`); a link-only result is skipped
// rather than offered as an entry the streamer cannot open.

const {
  parseQuality, parseAudioLayout, isLowQualitySource, parseDub, parseSub,
  magnetFromHash, parseSizeBytes,
} = require('./quality')
const {
  matchesTitle, matchesYear, matchesEpisode, matchesAnimeEpisode, requestTitles,
} = require('./apibay')
const { isPack } = require('./nyaa')

// The Torznab results path WITHOUT the api key — safe to log. The real request
// URL (buildRequestUrl) adds the key, which never belongs in a log line.
function buildUrl(baseUrl, query, { limit = 100 } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const q = encodeURIComponent(String(query == null ? '' : query))
  return `${base}/api/v2.0/indexers/all/results?Query=${q}&Limit=${limit}`
}

// The key is a secret, so it is not baked into the display URL above; the real
// request URL (with the key) is built here and kept out of any log line.
function buildRequestUrl(baseUrl, apiKey, query, { limit = 100 } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const q = encodeURIComponent(String(query == null ? '' : query))
  const key = encodeURIComponent(String(apiKey == null ? '' : apiKey))
  return `${base}/api/v2.0/indexers/all/results?apikey=${key}&Query=${q}&Limit=${limit}`
}

// Torznab hands back an InfoHash on many results and a full MagnetUri on some;
// prefer the explicit hash, fall back to the one embedded in the magnet. The
// hash is the identity used for dedupe and dead-magnet memory, so a magnet with
// no derivable hash is treated as hash-less (still usable, keyed by its magnet).
function extractInfoHash(raw) {
  const h = String((raw && raw.InfoHash) || '').trim()
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toUpperCase()
  const mag = String((raw && raw.MagnetUri) || '')
  const m = /btih:([0-9a-f]{40})/i.exec(mag)
  return m ? m[1].toUpperCase() : null
}

// Build one query per media type, mirroring the built-in providers so the same
// title/episode matchers apply. Anime tries each known name; tv adds an SxxEyy
// form; movies add the year. Returns [] when there is nothing to search for.
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

// Normalise one Torznab result to the shared entry contract. Returns null for a
// result that carries no magnet (link-only — the streamer cannot open a .torrent
// file URL, see the header) or no usable identity.
function normalizeResult(raw, { type = 'movie', episode = null } = {}) {
  const name = String((raw && raw.Title) || '')
  if (!name) return null
  const infoHash = extractInfoHash(raw)
  // Prefer a real MagnetUri; otherwise rebuild one from the hash so every entry
  // carries the same well-trackered magnet the rest of the app relies on. If
  // there is neither a magnet nor a hash, this is a link-only result and is
  // dropped — offering it would put an unplayable row at the top of the list.
  const rawMagnet = String((raw && raw.MagnetUri) || '')
  const magnet = /^magnet:/i.test(rawMagnet) ? rawMagnet : magnetFromHash(infoHash, name)
  if (!magnet) return null
  const quality = parseQuality(name)
  const audioLayout = parseAudioLayout(name)
  const lowQuality = isLowQualitySource(name)
  const seeds = Number(raw && raw.Seeders) || 0
  const sizeBytes = parseSizeBytes(raw && raw.Size)
  const sizeGb = Number.isFinite(sizeBytes) && sizeBytes > 0
    ? (sizeBytes / 1e9).toFixed(1) + ' GB' : null
  const tracker = String((raw && raw.Tracker) || '').trim()
  const pack = type === 'anime' ? isPack(name, episode) : false
  const dub = type === 'anime' ? parseDub(name) : false
  return {
    kind: 'torrent',
    url: null,
    magnet,
    infoHash,
    fileIndex: 0,
    source: 'Jackett',
    quality,
    lowQuality,
    label: `Jackett · ${lowQuality ? 'CAM/TS (poor quality)' : quality}` +
      `${audioLayout ? ` · ${audioLayout}` : ''}` +
      `${type === 'anime' ? (dub ? ' · dub' : ' · sub') : ''}` +
      `${pack ? ' · season pack' : ''}` +
      `${sizeGb ? ` · ${sizeGb}` : ''}` +
      `${seeds ? ` · ${seeds} seeds` : ''}` +
      `${tracker ? ` · via ${tracker}` : ''}`,
    audioLayout,
    seeds,
    seeders: seeds,
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : null,
    isPack: pack,
    // Carried for the per-request matcher; stripped before return.
    name,
    sub: type === 'anime' ? (!dub || parseSub(name)) : null,
    dub: type === 'anime' ? dub : null,
  }
}

// A source name attached to the returned function so the router's health/ranking
// machinery buckets it correctly (see providers/index.js orderBackendsByHealth).
const SOURCE_NAME = 'Jackett'

function createJackettProvider({ fetchFn, baseUrl, apiKey, maxResults = 50 } = {}) {
  const fetcher = fetchFn || fetch
  const base = String(baseUrl || '').trim()
  const key = String(apiKey || '').trim()

  async function jackettProvider(request) {
    request = request || {}
    const type = request.type
    if (type !== 'movie' && type !== 'tv' && type !== 'anime') return []
    // No instance configured → nothing to ask. main only registers this backend
    // when both are set, but the guard keeps the provider safe to call directly.
    if (!base || !key) return []
    const queries = buildQueries(request)
    if (!queries.length) return []
    const names = type === 'anime' ? requestTitles(request) : [request.title]
    const seen = new Set()
    const entries = []

    for (const query of queries) {
      let results = null
      try {
        const res = await fetcher(buildRequestUrl(base, key, query, { limit: maxResults }))
        if (!res || !res.ok) continue
        const text = await res.text()
        let data
        try { data = JSON.parse(text) } catch (_err) { continue }
        results = data && Array.isArray(data.Results) ? data.Results : null
      } catch (_err) {
        // A dead or misconfigured instance must never fail the whole lookup —
        // the built-in providers still ran. Skip this query and move on.
        continue
      }
      if (!results || !results.length) continue
      for (const rawResult of results) {
        const entry = normalizeResult(rawResult, { type, episode: request.episode })
        if (!entry) continue
        // Dedupe by hash when there is one, otherwise by magnet, so a hash-less
        // result is not silently collapsed with an unrelated one.
        const dedupeKey = entry.infoHash || entry.magnet
        if (seen.has(dedupeKey)) continue
        // A release only has to match one of the names the title goes by.
        if (!names.some(n => matchesTitle(entry.name, n))) continue
        if (type === 'movie' && !matchesYear(entry.name, request.year)) continue
        if (type === 'tv' &&
          !matchesEpisode(entry.name, request.season, request.episode)) continue
        if (type === 'anime' && !matchesAnimeEpisode(entry.name, request.episode, {
          season: request.season, absoluteEpisode: request.absoluteEpisode,
        })) continue
        seen.add(dedupeKey)
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
  jackettProvider.sourceName = SOURCE_NAME
  return jackettProvider
}

module.exports = {
  SOURCE_NAME,
  buildUrl,
  buildRequestUrl,
  buildQueries,
  extractInfoHash,
  normalizeResult,
  createJackettProvider,
}
