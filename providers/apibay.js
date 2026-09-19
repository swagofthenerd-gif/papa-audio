'use strict'
// The Pirate Bay (apibay) torrent provider — the broad-coverage source.
//
// YTS only indexes its own encodes, so any film YTS never released simply had
// no sources at all. apibay is a keyless JSON endpoint over the whole public
// index, which is what closes that gap:
//   GET <base>/q.php?q=<query>&cat=200        (200 = the whole Video category)
// answering with a flat array of
//   { id, name, info_hash, seeders, leechers, size, category }
//
// An empty search is signalled by a single sentinel row named "No results
// returned" with id "0" — not an empty array — so that has to be filtered out
// explicitly or it becomes an unplayable entry.
//
// Results are a plain text search over release names, so unrelated films come
// back for short titles. Every result is therefore checked against the
// requested title (and episode, for TV) before it is offered.

const {
  parseQuality, parseAudioLayout, isLowQualitySource, magnetFromHash,
  parseSizeBytes,
  fmtSize,
} = require('./quality')
const { raceMirrors } = require('./mirror-race')
const { matchesShowTitle, showTitles } = require('./show-title')

const DEFAULT_BASE_URLS = [
  'https://apibay.org',
  'https://thepiratebay10.org/apibay',
]

// The whole Video category: movies, HD movies, TV, HD TV.
const CATEGORY_VIDEO = 200

function buildSearchUrl(baseUrl, query, cat = CATEGORY_VIDEO) {
  return `${baseUrl}/q.php?q=${encodeURIComponent(query)}&cat=${cat}`
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Words too common to prove a match on their own.
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'part'])

function titleTokens(title) {
  return normalizeText(title).split(' ').filter(t => t && !STOPWORDS.has(t))
}

// Every significant word of the requested title must appear in the release
// name. Without this a search for "Dune" happily returns "Dune Drifter".
function matchesTitle(name, title) {
  const tokens = titleTokens(title)
  if (!tokens.length) return false
  // Space-bounded on both sides: normalizeText collapses punctuation to
  // spaces, so every real token is space-delimited. A bare prefix match let
  // "her" claim the tail of "another".
  const haystack = ` ${normalizeText(name)} `
  return tokens.every(t => haystack.includes(` ${t} `))
}

function matchesYear(name, year) {
  if (year == null || year === '') return true
  const n = Number(year)
  if (!Number.isFinite(n)) return true
  const text = String(name || '')
  // Re-releases and remasters carry a second year, so a one-year drift either
  // way is accepted rather than discarding a correct result.
  if ([n - 1, n, n + 1].some(y => text.includes(String(y)))) return true
  // A release name with no year in it at all cannot contradict the requested
  // one. Rejecting those would throw away exactly the results the bare-title
  // fallback query exists to find.
  return !/\b(19|20)\d{2}\b/.test(text)
}

// The season pack regex: a release that names the season without pinning a
// single episode ("Season 2", "S02") is treated as containing every episode of
// it. Shared by the full SxxEyy check and the season-only fallback below.
function _matchesSeasonPack(text, s) {
  return new RegExp(`(season[\\s._-]*0*${s}|s0*${s})\\b(?![\\s._-]*e)`, 'i').test(text)
}

function matchesEpisode(name, season, episode) {
  if (season == null && episode == null) return true
  // Number(null) and Number('') are both 0 — a finite value — so an absent
  // season or episode has to be mapped to NaN explicitly, otherwise "no episode"
  // would read as "episode 0" and skip the season-only path below.
  const s = season == null || season === '' ? NaN : Number(season)
  const e = episode == null || episode === '' ? NaN : Number(episode)
  const text = String(name || '')
  // A season WITHOUT a usable episode number must not fall through to accept-all
  // the way it used to: that flooded the sources list with every other season of
  // the show. Filter by season alone instead — accept a release that names the
  // requested season (an SxxEyy in it, an NxE form, or a whole-season pack), and
  // reject the wrong season. A movie request (neither number known) still
  // accepts everything, since the title/year filters carry it.
  if (Number.isFinite(s) && !Number.isFinite(e)) {
    if (new RegExp(`s0*${s}[\\s._-]?e\\d+\\b`, 'i').test(text)) return true
    if (new RegExp(`\\b${s}x\\d+\\b`, 'i').test(text)) return true
    return _matchesSeasonPack(text, s)
  }
  // Any other incomplete combination (movie request, or an episode with no
  // season) keeps the previous accept-all: the title filters carry those.
  if (!Number.isFinite(s) || !Number.isFinite(e)) return true
  if (new RegExp(`s0*${s}[\\s._-]?e0*${e}\\b`, 'i').test(text)) return true
  if (new RegExp(`\\b${s}x0*${e}\\b`, 'i').test(text)) return true
  // A complete-season pack contains the episode even though it does not name it.
  if (_matchesSeasonPack(text, s)) return true
  return false
}

// A stated batch range in the title ("01-24", "1~24"), or null when there is
// none. Only counts as a range when the upper bound is above the lower — a lone
// "12-12" or a hyphenated date is not a batch span.
// Scanned, not first-match-only, and a pair of plausible years is skipped: a
// title that carries its broadcast years ("Monster (2004 - 2005) Complete")
// was being read as "episodes 2004 to 2005" and refused for every episode.
// nyaa's episodeRange makes the same reading, and the two indexers list the
// same releases, so they answer this the same way.
const { episodeRange: _statedRange } = require('./nyaa')

function _rangeSpans(range, n) {
  return Boolean(range && Number.isFinite(n) && n >= range.from && n <= range.to)
}

// Anime is numbered by a bare episode number far more often than by SxxEyy,
// and batch packs ("01-24") legitimately contain the episode.
function _matchesAnimeNumber(text, n) {
  if (new RegExp(`s\\d{1,3}[\\s._-]?e0*${n}\\b`, 'i').test(text)) return true
  if (new RegExp(`(?:^|[\\s\\-_\\[(.])(?:e|ep|episode\\s*)?0*${n}(?:v\\d)?(?:$|[\\s\\-_\\])."'])`, 'i').test(text)) return true
  // A range that spans the episode: "01-24", "1~24".
  return _rangeSpans(_statedRange(text), n)
}

// Long-running shows are numbered absolutely at least as often as seasonally
// ("One Piece - 1071", not "S20E10"), so when the caller knows the absolute
// number a release naming either one is the requested episode.
function matchesAnimeEpisode(name, episode, { season = null, absoluteEpisode = null } = {}) {
  if (episode == null || episode === '') return true
  const n = Number(episode)
  if (!Number.isFinite(n)) return true
  const text = String(name || '')
  if (_matchesAnimeNumber(text, n)) return true
  const abs = Number(absoluteEpisode)
  if (Number.isFinite(abs) && abs >= 1 && _matchesAnimeNumber(text, abs)) return true
  // A stated range is authoritative in BOTH directions (nyaa's isPack logic):
  // if the title states "01-12" it cannot be a source for episode 20 just
  // because it also says "Batch". _matchesAnimeNumber above already accepted a
  // range that spans, so reaching here with a stated range means it does not
  // span — reject rather than falling through to the keyword check below.
  const range = _statedRange(text)
  if (range && !_rangeSpans(range, n) &&
      !(Number.isFinite(abs) && abs >= 1 && _rangeSpans(range, abs))) {
    return false
  }
  // An unlabelled "Complete"/"Batch" pack is trusted to span the episode, but
  // a pack explicitly labelled some OTHER season cannot contain it.
  // Number(null) is 0, so the missing-season case must be caught first.
  const labelled = /\bseason\s*0*(\d{1,3})\b/i.exec(text)
  const s = season == null || season === '' ? NaN : Number(season)
  if (labelled && Number.isFinite(s) && Number(labelled[1]) !== s) return false
  if (labelled) return true
  if (/\b(complete|batch)\b/i.test(text)) return true
  return false
}

// apibay signals "nothing found" with one sentinel row rather than an empty
// array. Left in, it becomes an entry with a zero hash that can never play.
function isSentinel(raw) {
  return !raw || raw.id === '0' || raw.id === 0 ||
    /^no results returned$/i.test(String(raw.name || '')) ||
    !/^[0-9a-f]{40}$/i.test(String(raw.info_hash || ''))
}

function normalizeResult(raw) {
  if (isSentinel(raw)) return null
  const name = String(raw.name || '')
  const infoHash = String(raw.info_hash)
  const magnet = magnetFromHash(infoHash, name)
  if (!magnet) return null
  const quality = parseQuality(name)
  const audioLayout = parseAudioLayout(name)
  const seeds = Number(raw.seeders) || 0
  const lowQuality = isLowQualitySource(name)
  const sizeGb = fmtSize(raw.size)
  return {
    kind: 'torrent',
    url: null,
    magnet,
    infoHash,
    fileIndex: 0,
    source: 'TPB',
    quality,
    // Flagged rather than dropped: a film with nothing but a cam rip should
    // still be playable, just never chosen ahead of a real encode.
    lowQuality,
    title: name,
    label: `TPB · ${lowQuality ? 'CAM/TS (poor quality)' : quality}` +
      `${audioLayout ? ` · ${audioLayout}` : ''}${sizeGb ? ` · ${sizeGb}` : ''}${seeds ? ` · ${seeds} seeds` : ''}`,
    audioLayout,
    seeds,
    seeders: seeds,
    sizeBytes: parseSizeBytes(raw.size),
    name,
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

// Movies are searched as "<title> <year>" and, if that finds nothing, as the
// bare title — some releases omit the year entirely.
// Every name the show is known by: AniList hands back romaji/english/native,
// and releases are indexed under any of them.
function requestTitles(request) {
  const t = (request && request.titles) || {}
  const out = []
  for (const v of [t.romaji, t.english, request && request.title, t.native]) {
    const s = String(v == null ? '' : v).trim()
    if (s && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return out
}

function buildQueries(request) {
  const title = String(request.title || '').trim()
  if (request.type === 'anime') {
    const names = requestTitles(request)
    if (!names.length) return []
    const e = Number(request.episode)
    const abs = Number(request.absoluteEpisode)
    const out = []
    for (const name of names) {
      if (Number.isFinite(e) && e >= 1) out.push(`${name} ${String(e).padStart(2, '0')}`)
      // Long-running shows are indexed by absolute number ("One Piece 1071").
      if (Number.isFinite(abs) && abs >= 1 && abs !== e) out.push(`${name} ${String(abs).padStart(2, '0')}`)
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

function createApibayProvider({ fetchFn, baseUrls = DEFAULT_BASE_URLS, maxResults = 25 } = {}) {
  const fetcher = fetchFn || fetch
  const urls = Array.isArray(baseUrls) && baseUrls.length > 0 ? baseUrls : DEFAULT_BASE_URLS

  return async function apibayProvider(request) {
    request = request || {}
    if (request.type !== 'movie' && request.type !== 'tv' && request.type !== 'anime') return []
    const queries = buildQueries(request)
    if (!queries.length) return []
    const seen = new Set()
    const entries = []

    for (const query of queries) {
      // All mirrors race per query; the first usable answer wins and the rest
      // are aborted.
      const won = await raceMirrors(_orderMirrors(urls), (baseUrl, signal) =>
        tryMirror(baseUrl, query, fetcher, signal))
      if (won) _lastGoodMirror = won.baseUrl
      const rows = won ? won.result : null
      if (!rows || !rows.length) continue
      for (const raw of rows) {
        const entry = normalizeResult(raw)
        if (!entry) continue
        if (seen.has(entry.infoHash)) continue
        // A release only has to match one of the names the show goes by.
        const names = request.type === 'anime' ? requestTitles(request) : [request.title]
        if (!names.some(n => matchesTitle(entry.name, n))) continue
        // matchesTitle above only asks that every word of the title appear in
        // the release name, which a one-word title ("Monster", "Heat", "It")
        // can never fail — it accepted Monster House, Red Heat and Blaze and
        // the Monster Machines. The other direction is the missing half: a
        // release carrying words the title does not have is a different show.
        // See providers/show-title.js.
        if (!matchesShowTitle(entry.name, showTitles(request))) continue
        if (request.type === 'movie' && !matchesYear(entry.name, request.year)) continue
        if (request.type === 'tv' && !matchesEpisode(entry.name, request.season, request.episode)) continue
        if (request.type === 'anime' && !matchesAnimeEpisode(entry.name, request.episode, {
          season: request.season, absoluteEpisode: request.absoluteEpisode,
        })) continue
        seen.add(entry.infoHash)
        entries.push(entry)
      }
      // A query that produced usable results is enough; the broader fallback
      // queries exist only to rescue an empty first attempt.
      if (entries.length) break
    }

    // Real encodes first, then by seeds. The final ordering is the router's
    // job; this only makes sure a cam rip never heads the provider's own list.
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
  CATEGORY_VIDEO,
  buildSearchUrl,
  buildQueries,
  normalizeText,
  matchesTitle,
  matchesYear,
  matchesEpisode,
  matchesAnimeEpisode,
  requestTitles,
  isSentinel,
  normalizeResult,
  createApibayProvider,
  _resetMirrorHealth,
}
