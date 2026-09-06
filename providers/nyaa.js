'use strict'
// Nyaa torrent provider for anime episodes.
//
// Before this existed the anime provider shipped with `resolvers: []`, so the
// whole Anime section could never play anything — it rendered posters and then
// always said "No sources found".
//
// Nyaa has no JSON API but exposes a stable RSS feed:
// `GET <base>/?page=rss&q=<query>&c=1_2&f=0` (c=1_2 is "Anime - English
// translated"). Each <item> carries a <title>, a <link> to the .torrent, and a
// <nyaa:infoHash>. The info hash is what matters: a magnet is built from it,
// so no .torrent file has to be downloaded.
//
// Parsing is done with scoped regexes rather than an XML library to avoid
// adding a dependency to the main process. The feed is small, flat, and
// machine-generated, so that is safe here — but the parser is deliberately
// defensive: anything without a hash is dropped.

const { parseQuality, parseAudioLayout, parseDub, parseSub, magnetFromHash, parseSizeBytes } = require('./quality')
const { raceMirrors } = require('./mirror-race')

const DEFAULT_BASE_URLS = [
  'https://nyaa.si',
  'https://nyaa.land',
]

// Episode numbers appear as a zero-padded standalone token in nyaa titles
// ("[SubsPlease] Frieren - 09 (1080p)"). Two digits is the common form; one
// and three both occur.
function buildQuery(title, episode) {
  const base = String(title == null ? '' : title).trim()
  if (!base) return ''
  if (episode == null || episode === '') return base
  const n = Number(episode)
  if (!Number.isFinite(n) || n < 1) return base
  return `${base} ${String(n).padStart(2, '0')}`
}

// Nyaa's q= is a literal AND over the words in the query, so every extra word
// is another way to match nothing. A show's full AniList title routinely
// carries a season suffix and a subtitle that no release name contains
// ("BLEACH: Thousand-Year Blood War - The Calamity"), and fansub groups index
// under the ROMAJI name, not the English one.
//
// So: try the romaji title first, then english, then native, and for each one
// try progressively shorter forms until something matches. Ordered most- to
// least-specific so a precise hit is preferred over a loose one.
const SEASON_SUFFIX = /\s+(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+|final\s+season|\d+(?:st|nd|rd|th)\s+cour)\s*$/i

function _trimSeason(title) {
  let out = String(title || '').trim()
  // Repeated because "... Season 2 Part 2" carries two suffixes.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(SEASON_SUFFIX, '').trim()
    if (next === out) break
    out = next
  }
  return out
}

// Everything after a colon or a spaced dash is a subtitle that release names
// usually drop.
function _dropSubtitle(title) {
  return String(title || '').split(/\s*[:：]\s*|\s+[-–—]\s+/)[0].trim()
}

function titleCandidates(request) {
  const titles = request && request.titles ? request.titles : {}
  // Romaji first: it is what the release groups actually use.
  const ordered = [titles.romaji, titles.english, request && request.title, titles.native]
  const out = []
  const seen = new Set()
  const push = v => {
    const t = String(v == null ? '' : v).trim()
    if (!t) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }
  for (const t of ordered) {
    if (!t) continue
    push(t)
    push(_trimSeason(t))
    push(_dropSubtitle(t))
    push(_trimSeason(_dropSubtitle(t)))
  }
  return out
}

function buildFeedUrl(baseUrl, query) {
  return `${baseUrl}/?page=rss&q=${encodeURIComponent(query)}&c=1_2&f=0`
}

function _tag(block, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')
  const m = re.exec(block)
  if (!m) return null
  return m[1]
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

// Splits the feed into <item> blocks and reads the fields off each one.
function parseFeed(xml) {
  const text = String(xml == null ? '' : xml)
  const items = []
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const block = m[1]
    items.push({
      title: _tag(block, 'title'),
      infoHash: _tag(block, 'nyaa:infoHash'),
      seeders: Number(_tag(block, 'nyaa:seeders')) || 0,
      size: _tag(block, 'nyaa:size'),
    })
  }
  return items
}

// Only accept items whose title actually carries the requested episode number.
// The feed is a plain text search, so a query for "Frieren 09" happily returns
// batch packs and episode 19; playing one of those instead is worse than
// showing nothing.
// Whether a release is a season or batch pack rather than one episode.
//
// Packs are offered as sources because that is where the dubs live. Playing
// one relies on the streamer selecting the episode's file by name, and on the
// stream cache being deleted when playback ends — both of which are in place.
const RANGE_RE = /(\d{1,4})\s*(?:-|~|to)\s*(\d{1,4})/
const PACK_RE = /\b(batch|complete|season\s*\d+|collection|bd[\s._-]?box)\b/i

function isPack(title, episode) {
  const t = String(title || '')
  const n = Number(episode)
  // A single named episode is never a pack, whatever else the title says.
  if (/s\d{1,3}[\s._-]?e\d{1,4}/i.test(t)) return false
  const range = RANGE_RE.exec(t)
  if (range) {
    const from = Number(range[1]), to = Number(range[2])
    if (to > from) {
      // A stated range is authoritative in both directions. Falling through to
      // the keyword check when it does not span the episode would accept
      // "Batch 01~12" as a source for episode 20 purely because it says batch.
      return !Number.isFinite(n) || (n >= from && n <= to)
    }
  }
  return PACK_RE.test(t)
}

// Release groups tag a dub as "Dual Audio" far more often than "Dub", and the
// two together cover nearly everything. Asking for them explicitly is the
// difference between finding a dub and hoping one turns up in a general search.
const DUB_QUALIFIERS = ['Dual Audio', 'Dub']

function _matchesEpisodeNumber(t, n) {
  const pad = String(n).padStart(2, '0')
  // The SxxEyy form has a digit immediately before the E, so it can never
  // satisfy the separator-led pattern below and needs its own check.
  if (new RegExp(`s\\d{1,3}e0*${n}(?:v\\d)?\\b`, 'i').test(t)) return true
  // " - 09 ", "[09]", "Episode 9", " 09v2 " — bounded on both sides so 09
  // never matches inside 109 or 190.
  const re = new RegExp(`(?:^|[\\s\\-_\\[(.])(?:e|ep|episode\\s*)?0*${n}(?:v\\d)?(?:$|[\\s\\-_\\])."'])`, 'i')
  if (re.test(t)) return true
  return t.includes(` ${pad} `)
}

// The season a pack explicitly claims to be, or null when it does not say.
// SxxEyy titles are single episodes, not packs, and are excluded by isPack
// before this is consulted.
function _packSeason(title) {
  const m = /\b(?:season[\s._-]*0*(\d{1,3})|s0*(\d{1,3}))\b(?![\s._-]*e)/i.exec(String(title || ''))
  return m ? Number(m[1] || m[2]) : null
}

// Long-running anime is numbered absolutely at least as often as seasonally
// ("One Piece - 1071", never "S20E10" on nyaa), so when the caller supplies
// the absolute number a release naming either one is the requested episode.
function matchesEpisode(title, episode, { season = null, absoluteEpisode = null } = {}) {
  if (episode == null || episode === '') return true
  const n = Number(episode)
  if (!Number.isFinite(n)) return true
  const t = String(title || '')
  if (_matchesEpisodeNumber(t, n)) return true
  const abs = Number(absoluteEpisode)
  if (Number.isFinite(abs) && abs >= 1 && _matchesEpisodeNumber(t, abs)) return true
  // A pack spanning the episode is a legitimate source for it. Dubs are
  // released almost exclusively this way, so excluding packs excluded nearly
  // every dub there is. Safe now that the streamer selects the episode's file
  // by name and deletes the cache when the stream ends.
  if (!isPack(t, n) && !(Number.isFinite(abs) && abs >= 1 && isPack(t, abs))) return false
  // But a pack explicitly labelled some OTHER season cannot contain the
  // episode. Unlabelled "Complete"/"Batch" packs stay accepted as before.
  // Number(null) is 0, so the missing-season case must be caught first.
  const s = season == null || season === '' ? NaN : Number(season)
  const claimed = _packSeason(t)
  if (claimed != null && Number.isFinite(s) && claimed !== s) return false
  return true
}

function normalizeItem(raw, { preferDub = false, episode = null } = {}) {
  raw = raw || {}
  const title = typeof raw.title === 'string' ? raw.title : ''
  const pack = isPack(title, episode)
  const magnet = magnetFromHash(raw.infoHash, title)
  if (!magnet) return null
  const quality = parseQuality(title)
  const audioLayout = parseAudioLayout(title)
  const dub = parseDub(title)
  const seeds = Number(raw.seeders) || 0
  return {
    kind: 'torrent',
    url: null,
    magnet,
    infoHash: raw.infoHash,
    fileIndex: 0,
    source: 'Nyaa',
    quality,
    label: `Nyaa · ${quality}${dub ? ' · dub' : ' · sub'}${pack ? ' · season pack' : ''}${seeds ? ` · ${seeds} seeds` : ''}`,
    // The streamer needs to know it must find one episode inside many files.
    isPack: pack,
    audioLayout,
    seeds,
    seeders: seeds,
    sizeBytes: parseSizeBytes(raw.size),
    sub: !dub || parseSub(title),
    dub,
    // Not part of the entry contract the ranker reads — used only to order
    // within nyaa results when the caller asked for a dub.
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
    const res = await fetcher(buildFeedUrl(baseUrl, query), { signal })
    if (!res || !res.ok) return null
    const text = await res.text()
    if (typeof text !== 'string' || !text.includes('<item')) return null
    return parseFeed(text)
  } catch (_err) {
    return null
  }
}

function createNyaaProvider({ fetchFn, baseUrls = DEFAULT_BASE_URLS, maxResults = 20 } = {}) {
  const fetcher = fetchFn || fetch
  const urls = Array.isArray(baseUrls) && baseUrls.length > 0 ? baseUrls : DEFAULT_BASE_URLS

  return async function nyaaProvider(request) {
    request = request || {}
    if (request.type !== 'anime') return []
    const candidates = titleCandidates(request)
    if (!candidates.length) return []
    const preferDub = request.dub === true
    const seenHash = new Set()

    const collect = items => {
      const entries = []
      for (const i of items) {
        if (!i || !i.infoHash) continue
        if (seenHash.has(i.infoHash)) continue
        if (!matchesEpisode(i.title, request.episode, {
          season: request.season, absoluteEpisode: request.absoluteEpisode,
        })) continue
        const entry = normalizeItem(i, { preferDub, episode: request.episode })
        if (!entry) continue
        seenHash.add(i.infoHash)
        entries.push(entry)
      }
      return entries
    }

    // A dub request tries dub-qualified queries before the plain ones. A
    // general search is dominated by subs, so without this a dub sits behind
    // twenty subbed releases even when one exists.
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

    // Each query is tried in turn and the first that yields anything wins.
    // Stopping at the first hit keeps this to one request in the common case
    // while still rescuing the shows whose English title matches nothing.
    for (const query of queries) {
      if (!query) continue
      // All mirrors race per query; the first usable feed wins and the rest
      // are aborted.
      const won = await raceMirrors(_orderMirrors(urls), (baseUrl, signal) =>
        tryMirror(baseUrl, query, fetcher, signal))
      if (won) _lastGoodMirror = won.baseUrl
      const items = won ? won.result : null
      if (!items || !items.length) continue
      const entries = collect(items)
      if (!entries.length) continue
      // Seeds decide playability more than anything else on nyaa, and a
      // requested dub outranks a sub of the same popularity.
      entries.sort((a, b) => {
        if (a._preferred !== b._preferred) return a._preferred ? -1 : 1
        return b.seeds - a.seeds
      })
      return entries.slice(0, maxResults).map(e => {
        delete e._preferred
        return e
      })
    }
    return []
  }
}

module.exports = {
  DEFAULT_BASE_URLS,
  isPack,
  DUB_QUALIFIERS,
  buildQuery,
  titleCandidates,
  buildFeedUrl,
  parseFeed,
  matchesEpisode,
  normalizeItem,
  createNyaaProvider,
  _resetMirrorHealth,
}
