'use strict'
// Jikan — the AniList stand-in.
//
// AniList is the anime catalog. Jikan (api.jikan.moe, the unofficial REST front
// for MyAnimeList) is what answers when AniList is down: same job, different
// source, so its answers are reshaped into the exact entry shape AniList's
// `normalizeMedia` produces (catalog/anilist.js) and a caller can drop them in
// where an AniList entry was expected without a second code path.
//
// Same house style as the other catalog modules: pure normalisation around a
// thin fetch shell, an injectable fetcher so tests never touch the network, and
// no throwing — every failure returns an empty list or null and the caller
// carries on without it.
//
// Rate limit: Jikan's public tier allows ~3 requests/second (and 60/minute).
// This module has no bursty path — search and byId are one request each — but
// calls are still serialised through a single-lane queue with a small inter-
// call delay so that a caller firing several lookups in a row (e.g. enriching a
// shelf) cannot trip the limiter. Going over earns a 429 and a temporary block,
// which is worse than being a few hundred milliseconds slower.

const JIKAN_BASE = 'https://api.jikan.moe/v4'

// 3 req/s is the ceiling, so ~334ms between calls is the floor. 350ms buys a
// little headroom against clock jitter without being noticeably slow.
const MIN_INTERVAL_MS = 350

// Abort a hung request rather than letting a lookup wait forever; the fallback
// exists to keep the app moving when AniList is down, so it must not itself
// become the thing that hangs.
const REQUEST_TIMEOUT_MS = 10000

// MAL scores are already 0-10 (unlike AniList's 0-100), which is the scale the
// rest of the app works in — so the value passes through, only rejecting the
// non-numbers MAL uses for an unrated title (null, 0, '').
function scoreTo10(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 10) / 10
}

// MAL's type enum ("TV", "Movie", "OVA", "ONA", "Special", "Music") maps onto
// AniList's MediaFormat enum so a mixed AniList/Jikan result list sorts and
// filters by one vocabulary. Anything unrecognised passes through uppercased
// rather than being dropped — an unknown format is better than a null one.
const FORMAT_MAP = {
  TV: 'TV',
  Movie: 'MOVIE',
  OVA: 'OVA',
  ONA: 'ONA',
  Special: 'SPECIAL',
  Music: 'MUSIC',
}

function _format(type) {
  if (typeof type !== 'string' || !type) return null
  return FORMAT_MAP[type] || type.toUpperCase()
}

// MAL's airing status ("Finished Airing", "Currently Airing", "Not yet aired")
// mapped onto AniList's MediaStatus enum for the same reason as format.
const STATUS_MAP = {
  'Finished Airing': 'FINISHED',
  'Currently Airing': 'RELEASING',
  'Not yet aired': 'NOT_YET_RELEASED',
}

function _status(status) {
  if (typeof status !== 'string' || !status) return null
  return STATUS_MAP[status] || null
}

function _str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

// MAL only titles anime in English and Japanese; there is no separate romaji
// field. Its plain `title` is the romaji transliteration ("Sousou no Frieren"),
// which is exactly the field fansub groups release under — so it fills the
// romaji slot, the one a torrent indexer actually needs. `title_english` and
// `title_japanese` fill the other two. The display pick then mirrors AniList's:
// english, then romaji, then native.
function _titles(raw) {
  const english = _str(raw.title_english)
  const romaji = _str(raw.title)
  const native = _str(raw.title_japanese)
  return { english, romaji, native }
}

// Jikan nests art as images.{jpg,webp}.{image_url,large_image_url}. The large
// JPG is the poster the cards want; webp is preferred where present because it
// is smaller, falling back to jpg.
function _poster(raw) {
  const img = raw && raw.images
  if (!img || typeof img !== 'object') return null
  const webp = img.webp || {}
  const jpg = img.jpg || {}
  return _str(webp.large_image_url) || _str(jpg.large_image_url) ||
    _str(webp.image_url) || _str(jpg.image_url)
}

// Genres, explicit_genres, themes and demographics are separate arrays of
// {mal_id,name} on MAL; only the plain genres feed the genre chips, matching
// what AniList's `genres` carries.
function _genres(raw) {
  const list = raw && raw.genres
  if (!Array.isArray(list)) return []
  return list.map(g => g && _str(g.name)).filter(Boolean)
}

// MAL exposes only a YouTube trailer, so `site` is always youtube when there is
// one. Shaped like AniList's trailer ({id, site}) so the player opens it the
// same way.
function _trailer(raw) {
  const t = raw && raw.trailer
  const id = t && _str(t.youtube_id)
  return id ? { id, site: 'youtube' } : null
}

// Reshape one MAL anime object into the AniList entry shape (see
// catalog/anilist.js `normalizeMedia`). Defensive on every field: a malformed
// or partial object yields nulls and empty arrays, never a throw.
function normalizeMedia(raw) {
  raw = raw || {}
  const titles = _titles(raw)
  const malId = Number.isFinite(Number(raw.mal_id)) ? Number(raw.mal_id) : null
  return {
    // A fallback card carries no AniList id — the whole point is that AniList is
    // unreachable. `id` still has to be a routable card key, so it is the MAL id
    // under a `mal-` prefix: _cardKey renders `anime:mal-<idMal>`, and
    // _videoShowDetail routes any `mal-`-prefixed anime id back to Jikan's byId
    // rather than AniList's (which would 403 during the outage this exists for).
    // `source: 'mal'` marks the card so the renderer can note where it came from
    // and the detail router knows not to trust it as an AniList id.
    id: malId != null ? 'mal-' + malId : null,
    source: 'mal',
    type: 'anime',
    idMal: malId,
    title: titles.english || titles.romaji || titles.native || null,
    titles,
    // `year` is a top-level field on a full entry; older/partial payloads only
    // carry it inside aired.prop.from.year, so both are read.
    year: _year(raw),
    poster: _poster(raw),
    // MAL has no separate banner art; the poster stands in for the backdrop so
    // the hero has something rather than nothing.
    backdrop: _poster(raw),
    overview: _str(raw.synopsis),
    // Already 0-10, matching AniList's converted rating and TMDB.
    rating: scoreTo10(raw.score),
    // AniList keeps the raw 0-100; MAL's raw is 0-10, kept as-is for parity of
    // the key even though the scale differs — documented so nobody compares the
    // two raw numbers directly.
    scoreRaw: raw.score == null || raw.score === '' ? null : Number(raw.score),
    format: _format(raw.type),
    trailer: _trailer(raw),
    genres: _genres(raw),
    episodeCount: Number.isFinite(Number(raw.episodes)) && raw.episodes != null
      ? Number(raw.episodes) : null,
    status: _status(raw.status),
  }
}

function _year(raw) {
  if (Number.isFinite(Number(raw.year)) && raw.year) return Number(raw.year)
  const from = raw && raw.aired && raw.aired.prop && raw.aired.prop.from
  const y = from && from.year
  return Number.isFinite(Number(y)) && y ? Number(y) : null
}

function buildSearchUrl(query, opts = {}) {
  const q = new URLSearchParams({ q: String(query || '') })
  // A modest page cap: the fallback wants the top matches, not a full catalogue
  // crawl, and a smaller page is one fewer chance to hit the rate limit.
  q.set('limit', String(opts.limit || 20))
  if (opts.page != null) q.set('page', String(opts.page))
  // No adult titles by default, matching the AniList catalog's isAdult=false.
  q.set('sfw', 'true')
  return `${JIKAN_BASE}/anime?${q.toString()}`
}

function buildByIdUrl(malId) {
  return `${JIKAN_BASE}/anime/${encodeURIComponent(malId)}`
}
function buildRelationsUrl(malId) {
  return `${JIKAN_BASE}/anime/${encodeURIComponent(malId)}/relations`
}
// MAL's relation names → AniList's vocabulary, so one renderer reads both.
const JIKAN_RELATION = { 'Sequel': 'SEQUEL', 'Prequel': 'PREQUEL', 'Side story': 'SIDE_STORY', 'Spin-off': 'SPIN_OFF', 'Alternative version': 'ALTERNATIVE', 'Alternative setting': 'ALTERNATIVE', 'Summary': 'SUMMARY', 'Parent story': 'PARENT', 'Full story': 'PARENT', 'Character': 'CHARACTER', 'Other': 'OTHER', 'Adaptation': 'ADAPTATION' }
const JIKAN_CHAIN_HOPS = 8

// The three shelf endpoints, mapped onto AniList's trending/popular/season rows:
//   trending -> /top/anime            (MAL's default "top", which tracks the
//                                       currently-hot titles the same way
//                                       AniList's TRENDING_DESC does)
//   popular  -> /top/anime?filter=bypopularity (all-time members count, the
//                                       direct analogue of POPULARITY_DESC)
//   season   -> /seasons/now          (the currently-airing season)
// The /top and /seasons endpoints are DELIBERATELY spare on query params. MAL's
// upstream (which Jikan proxies) intermittently 504s on the `limit` and `sfw`
// filters for these curated lists — observed live, reliably, during the very
// AniList outage this fallback is for — while a bare request or one carrying only
// `page` answers fine. Those two knobs are also unnecessary here: /top and
// /seasons/now are curated mainstream lists that do not surface adult titles at
// the top by default (unlike a free-text search, where sfw genuinely matters and
// buildSearchUrl keeps it), and MAL's default page size is a fine shelf length.
// So only `page` and `filter` are sent — the minimum that both works today and
// stays robust to MAL's flakier filter paths. The shelf slices to its own length
// downstream regardless.
function buildTopUrl(opts = {}) {
  const q = new URLSearchParams()
  if (opts.page != null) q.set('page', String(opts.page))
  if (opts.filter) q.set('filter', String(opts.filter))
  const qs = q.toString()
  return `${JIKAN_BASE}/top/anime${qs ? '?' + qs : ''}`
}

function buildSeasonNowUrl(opts = {}) {
  const q = new URLSearchParams()
  if (opts.page != null) q.set('page', String(opts.page))
  const qs = q.toString()
  return `${JIKAN_BASE}/seasons/now${qs ? '?' + qs : ''}`
}

function createJikanCatalog({ fetchFn, minIntervalMs = MIN_INTERVAL_MS,
  timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const fetcher = fetchFn || fetch

  // A one-lane queue: every request chains off the previous one and waits out
  // the inter-call delay before firing, so no two Jikan requests are ever in
  // flight closer together than the rate limit allows — even when a caller
  // fires several without awaiting between them.
  let lane = Promise.resolve()
  let lastAt = 0

  function _schedule(fn) {
    const run = lane.then(async () => {
      const wait = minIntervalMs - (Date.now() - lastAt)
      if (wait > 0) await _sleep(wait)
      try {
        return await fn()
      } finally {
        lastAt = Date.now()
      }
    })
    // The lane must not break on a rejection: a failed request still counts as
    // having happened (the delay was spent), and the next caller has to be able
    // to queue behind it. So the lane swallows the error while `run` keeps it
    // for the actual caller.
    lane = run.then(() => undefined, () => undefined)
    return run
  }

  // Why the last request came back empty-handed, mirroring the convention
  // catalog/anilist.js established: { at, message, status } after a swallowed
  // failure, cleared by the next success. Callers use it to tell "Jikan is
  // down" apart from "Jikan healthily found nothing" — the search fallback
  // chain needs that distinction to report an honest outage instead of a
  // misleading "no results".
  let _lastFailure = null

  async function _get(url) {
    // AbortController bounds the request so a hung socket cannot wedge the lane
    // and starve every queued lookup behind it. Not every injected fetcher
    // honours `signal`, so the timer is cleared regardless.
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const res = await fetcher(url, controller ? { signal: controller.signal } : undefined)
      if (!res || !res.ok) {
        _lastFailure = { at: Date.now(), message: res ? `HTTP ${res.status}` : 'no response', status: res ? res.status : null }
        return null
      }
      const body = await res.json()
      _lastFailure = null
      return body
    } catch (err) {
      // A 429, a timeout, a dead network — all the same to the caller: the
      // fallback has nothing to add right now, and the app carries on.
      _lastFailure = { at: Date.now(), message: (err && err.message) || String(err), status: null }
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    // Why the most recent call returned nothing: set by `_get` on a swallowed
    // failure, cleared on the next success, or null when nothing has failed.
    lastFailure() {
      return _lastFailure
    },

    // Text search. Returns a (possibly empty) array of normalized entries;
    // never throws, never null.
    async search(query, page) {
      if (!query) return []
      const data = await _schedule(() => _get(buildSearchUrl(query, { page })))
      const list = data && data.data
      if (!Array.isArray(list)) return []
      return list.map(normalizeMedia)
    },

    // The season chain from MAL's own relation graph, for when AniList is
    // down (the same shape anilist.seasonChain returns; ids are `mal-<id>`
    // card keys so navigation routes back here). Prequel/Sequel is the
    // spine; every other anime relation is kept under `related` with its
    // relation named in AniList's vocabulary. Each hop is one relations
    // request plus one detail request (year, poster), through the rate
    // limiter, with a hop budget against a cycle in MAL's data.
    async seasonChain(malId) {
      const start = _malIdOf(malId)
      if (!start) return { seasons: [], related: [] }
      const nodes = new Map(), related = new Map()
      let truncated = false
      const detail = async (id, name) => {
        const d = await this.byId(id)
        return d ? { id: 'mal-' + id, title: d.title || name || null, titles: d.titles, year: d.year, episodeCount: d.episodeCount ?? null, format: d.format ?? null, status: d.status ?? null, poster: d.poster } : { id: 'mal-' + id, title: name || null, titles: { english: name || null, romaji: null, native: null }, year: null, episodeCount: null, format: null, status: null, poster: null }
      }
      const edgesOf = async (id) => {
        const data = await _schedule(() => _get(buildRelationsUrl(id)))
        const list = data && Array.isArray(data.data) ? data.data : null
        if (!list) { truncated = true; return [] }
        const out = []
        for (const group of list) {
          const rel = JIKAN_RELATION[group && group.relation] || (group && group.relation ? String(group.relation).toUpperCase().replace(/\s+/g, '_') : null)
          for (const e of (group && group.entry) || []) {
            if (!e || e.type !== 'anime' || !Number.isFinite(Number(e.mal_id))) continue
            out.push({ relation: rel, malId: Number(e.mal_id), name: e.name || null })
          }
        }
        return out
      }
      const EXPAND = new Set(['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'PARENT', 'SUMMARY'])
      const SPINE = new Set(['PREQUEL', 'SEQUEL', 'PARENT', 'ALTERNATIVE', 'SUMMARY'])
      const self = await detail(start)
      nodes.set(self.id, Object.assign({ relation: null, spine: true }, self))
      // Breadth-first over the franchise (see anilist.seasonChain): every
      // franchise edge is followed under a request budget; Other/Character
      // links are related without being expanded. Television entries are the
      // seasons, everything else is related.
      const queue = [start]
      const visited = new Set()
      let requests = 0
      let capped = false
      while (queue.length) {
        const current = queue.shift()
        if (visited.has(current)) continue
        if (requests >= JIKAN_CHAIN_HOPS) { capped = true; break }
        visited.add(current)
        requests++
        const edges = await edgesOf(current)
        for (const e of edges) {
          const key = 'mal-' + e.malId
          const from = nodes.get('mal-' + current)
          const spine = !!(from && from.spine !== false) && SPINE.has(e.relation)
          if (EXPAND.has(e.relation)) {
            if (!nodes.has(key)) { nodes.set(key, Object.assign({ relation: e.relation, spine }, await detail(e.malId, e.name))); queue.push(e.malId) }
            else if (spine && nodes.get(key).spine === false) nodes.get(key).spine = true
          } else if (!nodes.has(key) && !related.has(key)) {
            related.set(key, { id: key, relation: e.relation, title: e.name, titles: { english: e.name, romaji: null, native: null }, year: null, episodeCount: null, format: null, status: null, poster: null })
          }
        }
      }
      const byYear = (a, b) => {
        const ay = Number(a.year) || Infinity, by = Number(b.year) || Infinity
        if (ay !== by) return ay - by
        return String(a.title || '').localeCompare(String(b.title || ''))
      }
      const isSeries = e => e.id === 'mal-' + start || (e.spine !== false && /^TV/i.test(String(e.format || '')))
      const seasons = [...nodes.values()].filter(isSeries).sort(byYear)
      for (const r of [...nodes.values()].filter(e => !isSeries(e))) if (!related.has(r.id)) related.set(r.id, r)
      for (const x of seasons) related.delete(x.id)
      return { seasons, related: [...related.values()].sort(byYear), truncated, capped }
    },

    // Detail lookup by MyAnimeList id. Returns one normalized entry, or null
    // when Jikan has nothing or is unreachable. A `mal-`-prefixed id (the card
    // key this module stamps) is accepted as-is: the prefix is stripped so a
    // caller can pass either the raw MAL id or the card's own id back in.
    async byId(malId) {
      const id = _malIdOf(malId)
      if (!id) return null
      const data = await _schedule(() => _get(buildByIdUrl(id)))
      const one = data && data.data
      return one && typeof one === 'object' ? normalizeMedia(one) : null
    },

    // The trending shelf: MAL's default /top/anime. Returns a (possibly empty)
    // array of normalized entries; never throws, never null.
    async top(page) {
      const data = await _schedule(() => _get(buildTopUrl({ page })))
      const list = data && data.data
      if (!Array.isArray(list)) return []
      return list.map(normalizeMedia)
    },

    // The popular shelf: /top/anime?filter=bypopularity (all-time members).
    async popular(page) {
      const data = await _schedule(() => _get(buildTopUrl({ page, filter: 'bypopularity' })))
      const list = data && data.data
      if (!Array.isArray(list)) return []
      return list.map(normalizeMedia)
    },

    // The this-season shelf: /seasons/now (the currently-airing season).
    async seasonNow(page) {
      const data = await _schedule(() => _get(buildSeasonNowUrl({ page })))
      const list = data && data.data
      if (!Array.isArray(list)) return []
      return list.map(normalizeMedia)
    },
  }
}

// Accept either a raw MAL id (number/string) or this module's own `mal-<id>`
// card key, returning the numeric id or null. The card key is what _cardKey
// produces from a fallback card, and the detail router hands it straight back.
function _malIdOf(value) {
  if (value == null) return null
  const s = String(value)
  const m = /^mal-(\d+)$/.exec(s)
  const n = Number(m ? m[1] : s)
  return Number.isFinite(n) && n > 0 ? n : null
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  buildRelationsUrl,
  JIKAN_BASE,
  MIN_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  FORMAT_MAP,
  STATUS_MAP,
  scoreTo10,
  normalizeMedia,
  buildSearchUrl,
  buildByIdUrl,
  buildTopUrl,
  buildSeasonNowUrl,
  _malIdOf,
  createJikanCatalog,
}
