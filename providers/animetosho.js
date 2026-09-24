'use strict'
// AnimeTosho torrent provider for anime episodes.
//
// AnimeTosho mirrors essentially everything nyaa carries, and unlike nyaa it
// serves a real JSON API — no RSS scraping, and it stays up when nyaa's
// mirrors are down, which is exactly when a second anime source earns its
// keep:
//   GET <base>/json?qx=1&q=<query>
// answering with a flat array of
//   { title, magnet_uri, torrent_url, info_hash, seeders, leechers,
//     total_size, num_files, ... }
// `qx=1` selects the extended query syntax, which treats the query as plain
// AND-ed words the same way nyaa's q= does, so the same progressively-shorter
// title candidates work here unchanged.
//
// The adapter contract is nyaa's exactly: a factory returning an async
// `provider(request) -> entries[]` that only answers `type: 'anime'`, never
// throws, and rides the shared mirror race. Title variants, episode matching
// (absolute numbering included) and season-aware pack handling are nyaa's own
// helpers — the two providers index the same releases, so diverging rules
// would only mean disagreeing about the same torrent.

const { parseQuality, parseAudioLayout, parseDub, parseSub, magnetFromHash, parseSizeBytes, fmtSize } = require('./quality')
const { buildQuery, titleCandidates, matchesEpisode, isPack, DUB_QUALIFIERS, PACK_QUALIFIERS } = require('./nyaa')
const { raceMirrors } = require('./mirror-race')
const { matchesShowTitle, showTitles } = require('./show-title')

const DEFAULT_BASE_URLS = [
  'https://feed.animetosho.org',
  'https://animetosho.org/feed',
]

function buildSearchUrl(baseUrl, query) {
  return `${baseUrl}/json?qx=1&q=${encodeURIComponent(query)}`
}

// A magnet_uri is preferred (it carries AnimeTosho's own tracker list); a bare
// info_hash still works through the shared public-tracker magnet builder. An
// entry with neither is undownloadable and dropped.
function _infoHash(raw) {
  if (typeof raw.info_hash === 'string' && /^[0-9a-f]{40}$/i.test(raw.info_hash)) {
    return raw.info_hash
  }
  const m = /xt=urn:btih:([0-9a-z]{32,40})/i.exec(String(raw.magnet_uri || ''))
  return m ? m[1] : null
}

function normalizeItem(raw, { preferDub = false, episode = null } = {}) {
  raw = raw || {}
  const title = typeof raw.title === 'string' ? raw.title : ''
  const infoHash = _infoHash(raw)
  const magnet = typeof raw.magnet_uri === 'string' && raw.magnet_uri.length
    ? raw.magnet_uri
    : magnetFromHash(infoHash, title)
  if (!magnet || !infoHash) return null
  const pack = isPack(title, episode)
  const quality = parseQuality(title)
  const audioLayout = parseAudioLayout(title)
  const dub = parseDub(title)
  // Seeder counts are scraped and can be null while a release is fresh; null
  // is honest-unknown and sorts as 0 rather than being invented.
  const seeds = Number(raw.seeders) || 0
  const sizeGb = fmtSize(raw.total_size)
  return {
    kind: 'torrent',
    url: null,
    magnet,
    infoHash,
    fileIndex: 0,
    source: 'AnimeTosho',
    quality,
    title: title,
    label: `AnimeTosho · ${quality}${dub ? ' · dub' : ' · sub'}${pack ? ' · season pack' : ''}` +
      `${sizeGb ? ` · ${sizeGb}` : ''}${seeds ? ` · ${seeds} seeds` : ''}`,
    // The streamer needs to know it must find one episode inside many files.
    isPack: pack,
    audioLayout,
    seeds,
    seeders: seeds,
    sizeBytes: parseSizeBytes(raw.total_size),
    sub: !dub || parseSub(title),
    dub,
    // Not part of the entry contract the ranker reads — used only to order
    // within animetosho results when the caller asked for a dub.
    _preferred: preferDub === dub,
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

async function tryMirror(baseUrl, query, fetcher, signal) {
  try {
    const res = await fetcher(buildSearchUrl(baseUrl, query), { signal })
    if (!res || !res.ok) return null
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch (_err) { return null }
    return Array.isArray(data) ? data : null
  } catch (_err) {
    return null
  }
}

// The same clock nyaa's loop keeps, for the same reason: the query list
// multiplies out and this loop is what resolveStream kills at 20 s, taking
// everything found so far with it. Measured 2026-09-23/24: a full healthy run
// here takes 13.3 s, and with the Dub toggle adding two forms per title variant
// it tips over — episode 17, same minute, dub off answered 7 and dub on
// answered nothing. A partial answer beats a timeout answering nothing.
const QUERY_TIME_BUDGET_MS = 14000

function createAnimetoshoProvider({ fetchFn, baseUrls = DEFAULT_BASE_URLS, maxResults = 20, timeBudgetMs = QUERY_TIME_BUDGET_MS } = {}) {
  const fetcher = fetchFn || fetch
  const urls = Array.isArray(baseUrls) && baseUrls.length > 0 ? baseUrls : DEFAULT_BASE_URLS

  return async function animetoshoProvider(request) {
    request = request || {}
    if (request.type !== 'anime') return []
    const candidates = titleCandidates(request)
    if (!candidates.length) return []
    const preferDub = request.dub === true
    const seenHash = new Set()

    // Same plain AND-over-words search as nyaa, so the same trap: without this
    // a one-word title ("Monster") matches every unrelated show that contains
    // the word, and the episode-number check waves them all through.
    const names = showTitles(request)

    const collect = items => {
      const entries = []
      for (const i of items) {
        if (!i || typeof i !== 'object') continue
        if (!matchesShowTitle(i.title, names)) continue
        if (!matchesEpisode(i.title, request.episode, {
          season: request.season, absoluteEpisode: request.absoluteEpisode,
        })) continue
        const entry = normalizeItem(i, { preferDub, episode: request.episode })
        if (!entry) continue
        if (seenHash.has(entry.infoHash)) continue
        seenHash.add(entry.infoHash)
        entries.push(entry)
      }
      return entries
    }

    // A dub request tries dub-qualified queries before the plain ones, same as
    // nyaa: a general search is dominated by subs, so without this a dub sits
    // behind twenty subbed releases even when one exists.
    const queries = []
    const abs = Number(request.absoluteEpisode)
    for (const candidate of candidates) {
      if (preferDub) for (const q of DUB_QUALIFIERS) queries.push(`${candidate} ${q}`)
      queries.push(buildQuery(candidate, request.episode))
      // Long-running shows are indexed by absolute number ("One Piece 1071"),
      // so the absolute form is a distinct query, not a substitute.
      if (Number.isFinite(abs) && abs >= 1 && abs !== Number(request.episode)) {
        queries.push(buildQuery(candidate, abs))
      }
    }

    // A bare-title query after the episode-specific ones, for the same reason
    // nyaa has one: the answer is one page ordered by recency, so a show that
    // finished years ago is buried under everything airing now, and its batch
    // and BD packs are what is actually seeded. A pack is a valid source for
    // any episode it holds.
    if (request.episode != null && request.episode !== '') {
      for (const candidate of candidates) queries.push(candidate)
      for (const candidate of candidates) {
        for (const q of PACK_QUALIFIERS) queries.push(`${candidate} ${q}`)
      }
    }

    // Results accumulate across queries and stop as soon as there are enough,
    // so a well-stocked first page still costs one request while a thin one
    // keeps looking. See the same reasoning in providers/nyaa.js.
    const ENOUGH = 8
    const entries = []
    const tried = new Set()
    const deadline = timeBudgetMs > 0 ? Date.now() + timeBudgetMs : Infinity
    for (const query of queries) {
      if (!query || tried.has(query)) continue
      tried.add(query)
      // Out of time: answer with what is already found. The race below is capped
      // by the time left so a hung mirror cannot spend the whole budget; clamped
      // to at least 1 ms because raceMirrors reads a non-positive timeout as
      // "no backstop".
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const won = await raceMirrors(_orderMirrors(urls), (baseUrl, signal) =>
        tryMirror(baseUrl, query, fetcher, signal),
        { timeoutMs: Math.max(1, Math.min(10000, remaining)) })
      if (won) _lastGoodMirror = won.baseUrl
      const items = won ? won.result : null
      if (!items || !items.length) continue
      // `collect` dedupes against seenHash, which is shared across queries.
      for (const entry of collect(items)) entries.push(entry)
      if (entries.length >= ENOUGH) break
    }
    if (!entries.length) return []
    // Seeds decide playability, and a requested dub outranks a sub of the
    // same popularity.
    entries.sort((a, b) => {
      if (a._preferred !== b._preferred) return a._preferred ? -1 : 1
      return b.seeds - a.seeds
    })
    return entries.slice(0, maxResults).map(e => {
      delete e._preferred
      return e
    })
  }
}

module.exports = {
  DEFAULT_BASE_URLS,
  buildSearchUrl,
  normalizeItem,
  createAnimetoshoProvider,
  _resetMirrorHealth,
}
