'use strict'
// EZTV torrent provider for TV episodes.
//
// Before this existed the TV section had no working source at all: the router
// asked YTS (movies only) and vidsrc (an embed page mpv cannot open), so every
// episode ended at "No sources found".
//
// EZTV's keyless API answers
// `GET <base>/api/get-torrents?imdb_id=<digits>&limit=100&page=<n>`
// with `{ torrents: [{ title, magnet_url, hash, seeds, season, episode }] }`.
// `imdb_id` is the numeric form — "tt0903747" must be sent as "0903747".
//
// Mirrors rotate, so like yts.js this takes an ordered list of base URLs and
// falls back across them. It never throws: a total failure returns [].

const { parseQuality, parseAudioLayout, magnetFromHash, parseSizeBytes } = require('./quality')
const { raceMirrors } = require('./mirror-race')

const DEFAULT_BASE_URLS = [
  'https://eztvx.to',
  'https://eztv.re',
]

// EZTV wants the digits only; TMDB hands back the "tt"-prefixed form.
function toNumericImdb(imdbId) {
  const m = /^(?:tt)?(\d+)$/.exec(String(imdbId == null ? '' : imdbId).trim())
  return m ? m[1] : null
}

function buildListUrl(baseUrl, numericImdb, { page = 1, limit = 100 } = {}) {
  return `${baseUrl}/api/get-torrents?imdb_id=${encodeURIComponent(numericImdb)}&limit=${limit}&page=${page}`
}

// EZTV returns every episode of the whole series in one payload, so the season
// and episode filter is applied here rather than in the request.
// Reads SxxEyy out of a release filename. EZTV normally populates the numeric
// season/episode fields, but not for every show, and a blank field would
// otherwise silently exclude every torrent.
function parseSxxExx(filename) {
  const m = /s(\d{1,3})[\s._-]?e(\d{1,4})/i.exec(String(filename || ''))
  return m ? { season: Number(m[1]), episode: Number(m[2]) } : null
}

function matchesEpisode(raw, season, episode) {
  if (season == null && episode == null) return true
  let s = Number(raw.season)
  let e = Number(raw.episode)
  if (!s || !e) {
    const parsed = parseSxxExx(raw.filename || raw.title)
    if (!parsed) return false
    if (!s) s = parsed.season
    if (!e) e = parsed.episode
  }
  if (season != null && s !== Number(season)) return false
  if (episode != null && e !== Number(episode)) return false
  return true
}

function normalizeTorrent(raw) {
  raw = raw || {}
  // `filename` is the real release name and always carries the resolution and
  // codec; `title` is a prettified form that often drops them. Parse the
  // filename, display the title.
  const filename = typeof raw.filename === 'string' ? raw.filename : ''
  const title = typeof raw.title === 'string' && raw.title.length ? raw.title : filename
  const parseFrom = filename || title
  const infoHash = typeof raw.hash === 'string' && raw.hash.length ? raw.hash : null
  const magnet = typeof raw.magnet_url === 'string' && raw.magnet_url.length
    ? raw.magnet_url
    : magnetFromHash(infoHash, title)
  if (!magnet || !infoHash) return null
  const quality = parseQuality(parseFrom)
  const audioLayout = parseAudioLayout(parseFrom)
  const seeds = Number(raw.seeds) || 0
  return {
    kind: 'torrent',
    url: null,
    magnet,
    infoHash,
    fileIndex: 0,
    source: 'EZTV',
    quality,
    title: title,
    label: `EZTV · ${quality}${audioLayout ? ` · ${audioLayout}` : ''}${seeds ? ` · ${seeds} seeds` : ''}`,
    title,
    audioLayout,
    seeds,
    seeders: seeds,
    sizeBytes: parseSizeBytes(raw.size_bytes),
    sub: null,
    dub: null,
  }
}

// The mirror that answered most recently leads the race on the next query.
// Mirrors are raced in parallel now, so this is a tiebreak rather than a
// timeout-saver: its request goes out first, which is what decides a race
// between two healthy mirrors. Module-level on purpose: remembered for the
// session, never persisted.
let _lastGoodMirror = null

function _orderMirrors(urls) {
  if (!_lastGoodMirror || !urls.includes(_lastGoodMirror)) return urls
  return [_lastGoodMirror, ...urls.filter(u => u !== _lastGoodMirror)]
}

function _resetMirrorHealth() {
  _lastGoodMirror = null
}

async function tryMirror(baseUrl, numericImdb, fetcher, signal) {
  try {
    const res = await fetcher(buildListUrl(baseUrl, numericImdb), { signal })
    if (!res || !res.ok) return null
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch (_err) { return null }
    const torrents = data && Array.isArray(data.torrents) ? data.torrents : null
    return torrents
  } catch (_err) {
    return null
  }
}

function createEztvProvider({ fetchFn, baseUrls = DEFAULT_BASE_URLS } = {}) {
  const fetcher = fetchFn || fetch
  const urls = Array.isArray(baseUrls) && baseUrls.length > 0 ? baseUrls : DEFAULT_BASE_URLS

  return async function eztvProvider(request) {
    request = request || {}
    if (request.type !== 'tv') return []
    const numericImdb = toNumericImdb(request.imdbId)
    if (!numericImdb) return []
    // All mirrors race; the first that answers with a torrent list wins and
    // the rest are aborted.
    const won = await raceMirrors(_orderMirrors(urls), (baseUrl, signal) =>
      tryMirror(baseUrl, numericImdb, fetcher, signal))
    if (!won) return []
    _lastGoodMirror = won.baseUrl
    // A mirror that answered but has no torrent for THIS episode is still a
    // working mirror; asking another one would only repeat the same answer.
    return won.result
      .filter(t => t && matchesEpisode(t, request.season, request.episode))
      .map(normalizeTorrent)
      .filter(Boolean)
  }
}

module.exports = {
  DEFAULT_BASE_URLS,
  toNumericImdb,
  parseSxxExx,
  buildListUrl,
  matchesEpisode,
  normalizeTorrent,
  createEztvProvider,
  _resetMirrorHealth,
}
