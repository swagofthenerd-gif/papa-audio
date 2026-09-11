'use strict'
// Kitsu — the third rung of the anime fallback, behind AniList and Jikan.
//
// AniList is the anime catalog. Jikan (the unofficial REST front for
// MyAnimeList) is the second source that answers when AniList is down. Kitsu
// (kitsu.io, its own community anime database) is what answers when BOTH are
// down at once — which actually happened 2026-09-11: AniList in a multi-day
// global 403 outage while Jikan's upstream returned 504 "failed to connect to
// MyAnimeList" on every request. With the two usual sources dark, a third
// independent catalog is the difference between the anime tab working and the
// anime tab being empty.
//
// Its answers are reshaped into the exact entry shape AniList's `normalizeMedia`
// produces (catalog/anilist.js), the same contract catalog/jikan.js meets, so a
// caller can drop a Kitsu card in where an AniList or Jikan card was expected
// without a third code path at the read sites.
//
// Same house style as the other catalog modules: pure normalisation around a
// thin fetch shell, an injectable fetcher so tests never touch the network, and
// no throwing — every failure returns an empty list or null and the caller
// carries on without it.
//
// Rate limit: Kitsu's ceiling is generous (no published hard per-second cap for
// the keyless edge API), but this module still serialises through a single-lane
// queue with a small inter-call delay, exactly like jikan.js. The reasons are
// the same — a caller enriching a shelf can fire several lookups in a row, and a
// courteous constant spacing keeps this a good citizen rather than a burst — and
// keeping the two modules structurally identical means one mental model covers
// both.

const KITSU_BASE = 'https://kitsu.io/api/edge'

// Kitsu is a JSON:API server: every request must carry this Accept header or it
// answers 406. It is sent on every _get so the injected fetcher never has to
// know about it.
const KITSU_ACCEPT = 'application/vnd.api+json'

// A courtesy floor between calls. Kitsu's ceiling is generous, so 250ms is
// plenty of headroom while still serialising a shelf's worth of enrichment
// lookups behind one another. Overridable for tests, same as jikan.js.
const MIN_INTERVAL_MS = 250

// Abort a hung request rather than letting a lookup wait forever; the fallback
// exists to keep the app moving when AniList AND MyAnimeList are down, so it
// must not itself become the thing that hangs.
const REQUEST_TIMEOUT_MS = 10000

// Kitsu's averageRating is a STRING on a 0-100 scale ("79.92"), unlike MAL's
// 0-10 and like AniList's 0-100. The app works in 0-10, so it is divided by ten
// and rounded to one place — matching what AniList's scoreTo10 produces — with
// the not-yet-rated sentinels (null, '', 0) rejected to null rather than shown
// as a real zero.
function scoreTo10(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n) / 10
}

// Kitsu's subtype enum ("TV", "movie", "ONA", "OVA", "special", "music") maps
// onto AniList's MediaFormat enum so a mixed AniList/Jikan/Kitsu result list
// sorts and filters by one vocabulary. Kitsu's casing is inconsistent (upper
// "TV"/"ONA"/"OVA" but lower "movie"/"special"/"music"), so the lookup is done
// case-insensitively. Anything unrecognised passes through uppercased rather
// than being dropped — an unknown format is better than a null one.
const FORMAT_MAP = {
  TV: 'TV',
  MOVIE: 'MOVIE',
  OVA: 'OVA',
  ONA: 'ONA',
  SPECIAL: 'SPECIAL',
  MUSIC: 'MUSIC',
}

function _format(subtype) {
  if (typeof subtype !== 'string' || !subtype) return null
  return FORMAT_MAP[subtype.toUpperCase()] || subtype.toUpperCase()
}

// Kitsu's status enum ("current"/"finished"/"upcoming"/"tba"/"unreleased")
// mapped onto AniList's MediaStatus enum for the same reason as format. "tba"
// and "unreleased" both mean "announced but not aired", which is AniList's
// NOT_YET_RELEASED. Anything unrecognised is null, not a guess — same as the
// jikan.js status map.
const STATUS_MAP = {
  current: 'RELEASING',
  finished: 'FINISHED',
  upcoming: 'NOT_YET_RELEASED',
  tba: 'NOT_YET_RELEASED',
  unreleased: 'NOT_YET_RELEASED',
}

function _status(status) {
  if (typeof status !== 'string' || !status) return null
  return STATUS_MAP[status.toLowerCase()] || null
}

function _str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

// Kitsu titles anime in three keyed variants: en (English), en_jp (the romaji
// transliteration — "Tokyo Revengers: Tenjiku-hen"), and ja_jp (the native
// Japanese). en_jp is exactly the field fansub groups release under, so it fills
// the romaji slot — the one a torrent indexer actually needs — just as MAL's
// plain `title` does in jikan.js. `canonicalTitle` is Kitsu's own display pick
// and a good last resort for the romaji slot when en_jp is missing. The display
// pick then mirrors AniList's: english, then romaji, then native.
function _titles(raw) {
  const t = (raw && raw.titles) || {}
  const english = _str(t.en)
  const romaji = _str(t.en_jp) || _str(raw && raw.canonicalTitle)
  const native = _str(t.ja_jp)
  return { english, romaji, native }
}

// Kitsu's posterImage is a size ladder (tiny/small/medium/large/original). The
// large JPEG is the poster the cards want, falling down the ladder if a size is
// missing — never assuming a particular size exists.
function _poster(raw) {
  const img = raw && raw.posterImage
  if (!img || typeof img !== 'object') return null
  return _str(img.large) || _str(img.medium) || _str(img.original) ||
    _str(img.small) || _str(img.tiny)
}

// Unlike MAL, Kitsu DOES carry banner/backdrop art: coverImage, its own size
// ladder. The large cover is the backdrop the hero wants; it falls back to the
// poster when there is no cover so the hero has something rather than nothing,
// exactly as jikan.js falls back to the poster for its (always-absent) backdrop.
function _backdrop(raw) {
  const cover = raw && raw.coverImage
  if (cover && typeof cover === 'object') {
    const c = _str(cover.large) || _str(cover.original) || _str(cover.small) ||
      _str(cover.tiny)
    if (c) return c
  }
  return _poster(raw)
}

// Kitsu keeps genres in a JSON:API relationship, not inline on the attributes —
// fetching them is a second request per title, which the fallback deliberately
// does not spend (jikan.js reads its inline genres; there is no cheap inline
// equivalent here). So the genre chips are empty for a Kitsu card, matching the
// empty-array convention rather than inventing genres. The key still exists for
// shape parity.
function _genres(raw) {
  const list = raw && raw.genres
  if (!Array.isArray(list)) return []
  return list.map(g => _str(typeof g === 'string' ? g : g && g.name)).filter(Boolean)
}

// Kitsu exposes only a YouTube trailer id (youtubeVideoId), so `site` is always
// youtube when there is one. Shaped like AniList's trailer ({id, site}) so the
// player opens it the same way jikan.js's does.
function _trailer(raw) {
  const id = raw && _str(raw.youtubeVideoId)
  return id ? { id, site: 'youtube' } : null
}

// The year from Kitsu's startDate ("2021-04-11" → 2021). Defensive: a missing or
// malformed date yields null rather than a NaN year.
function _year(raw) {
  const d = raw && _str(raw.startDate)
  if (!d) return null
  const y = Number(d.slice(0, 4))
  return Number.isFinite(y) && y > 0 ? y : null
}

// Reshape one Kitsu JSON:API anime resource into the AniList entry shape (see
// catalog/anilist.js `normalizeMedia`, and catalog/jikan.js for the sibling that
// meets the same contract). The resource is { id, type, attributes: {...} }; the
// interesting fields all live under `attributes`, but this is defensive on every
// field so a malformed or partial resource yields nulls and empty arrays, never
// a throw.
function normalizeMedia(resource) {
  resource = resource || {}
  const attr = resource.attributes || {}
  const titles = _titles(attr)
  // Kitsu's id is a numeric string ("47278"); keep the numeric value for the
  // card key and null it when it is not a real positive id.
  const kitsuId = Number.isFinite(Number(resource.id)) && Number(resource.id) > 0
    ? Number(resource.id) : null
  return {
    // A fallback card carries no AniList id — the whole point is that AniList is
    // unreachable. `id` still has to be a routable card key, so it is the Kitsu
    // id under a `kitsu-` prefix, mirroring jikan.js's `mal-` convention:
    // _cardKey renders `anime:kitsu-<id>`, and _videoShowDetail routes any
    // `kitsu-`-prefixed anime id back to Kitsu's byId rather than AniList's
    // (which would 403 during the outage this exists for). `source: 'kitsu'`
    // marks the card so the renderer can note where it came from and the detail
    // router knows not to trust it as an AniList id.
    id: kitsuId != null ? 'kitsu-' + kitsuId : null,
    source: 'kitsu',
    type: 'anime',
    // Kitsu carries NO MAL id inline (that mapping lives in a relationship the
    // fallback does not fetch), so idMal is null — the same null a MAL-less
    // AniList entry carries. AniSkip keys on it and simply has nothing to key on
    // for a Kitsu card, which is acceptable during a two-source outage.
    idMal: null,
    title: titles.english || titles.romaji || titles.native || null,
    titles,
    year: _year(attr),
    poster: _poster(attr),
    // Kitsu, unlike MAL, has real banner art (coverImage); the backdrop is that
    // cover, falling back to the poster when absent.
    backdrop: _backdrop(attr),
    overview: _str(attr.synopsis) || _str(attr.description),
    // Converted to 0-10, matching AniList's converted rating and TMDB.
    rating: scoreTo10(attr.averageRating),
    // AniList keeps the raw 0-100; Kitsu's raw is also a 0-100 STRING, kept as a
    // number for parity of the key. Documented so nobody compares a raw Kitsu
    // number against a raw MAL (0-10) one directly.
    scoreRaw: attr.averageRating == null || attr.averageRating === ''
      ? null : Number(attr.averageRating),
    format: _format(attr.subtype),
    trailer: _trailer(attr),
    genres: _genres(attr),
    episodeCount: Number.isFinite(Number(attr.episodeCount)) && attr.episodeCount != null
      ? Number(attr.episodeCount) : null,
    status: _status(attr.status),
  }
}

// Kitsu's free-text search is filter[text]. URLSearchParams brackets-encodes the
// key to filter%5Btext%5D, which Kitsu accepts. page[limit] caps the page: the
// fallback wants the top matches, not a full catalogue crawl.
function buildSearchUrl(query, opts = {}) {
  const q = new URLSearchParams()
  q.set('filter[text]', String(query || ''))
  q.set('page[limit]', String(opts.limit || 20))
  return `${KITSU_BASE}/anime?${q.toString()}`
}

function buildByIdUrl(kitsuId) {
  return `${KITSU_BASE}/anime/${encodeURIComponent(kitsuId)}`
}

// The trending shelf: Kitsu's /trending/anime, a curated currently-hot list, the
// analogue of AniList's TRENDING_DESC and Jikan's /top/anime. `limit` is a plain
// query param here (not the JSON:API page[limit]) — that is the documented shape
// for the trending endpoint. This is the only shelf Kitsu serves in the third
// rung; popular and this-season have no equally cheap keyless equivalent, so
// those sections stay empty rather than being faked from the trending list.
function buildTrendingUrl(opts = {}) {
  const q = new URLSearchParams()
  q.set('limit', String(opts.limit || 20))
  return `${KITSU_BASE}/trending/anime?${q.toString()}`
}

function createKitsuCatalog({ fetchFn, minIntervalMs = MIN_INTERVAL_MS,
  timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const fetcher = fetchFn || fetch

  // A one-lane queue: every request chains off the previous one and waits out
  // the inter-call delay before firing, so no two Kitsu requests are ever in
  // flight closer together than the courtesy interval allows — even when a
  // caller fires several without awaiting between them. Identical to jikan.js.
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
  // catalog/anilist.js and catalog/jikan.js established: { at, message, status }
  // after a swallowed failure, cleared by the next success. Callers use it to
  // tell "Kitsu is down" apart from "Kitsu healthily found nothing" — the search
  // fallback chain needs that distinction to report an honest outage instead of
  // a misleading "no results".
  let _lastFailure = null

  async function _get(url) {
    // AbortController bounds the request so a hung socket cannot wedge the lane
    // and starve every queued lookup behind it. Not every injected fetcher
    // honours `signal`, so the timer is cleared regardless.
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    // Kitsu answers 406 without the JSON:API Accept header, so it is sent on
    // every request. The signal (when present) is merged into the same options.
    const opts = { headers: { Accept: KITSU_ACCEPT } }
    if (controller) opts.signal = controller.signal
    try {
      const res = await fetcher(url, opts)
      if (!res || !res.ok) {
        _lastFailure = { at: Date.now(), message: res ? `HTTP ${res.status}` : 'no response', status: res ? res.status : null }
        return null
      }
      const body = await res.json()
      _lastFailure = null
      return body
    } catch (err) {
      // A timeout, a dead network, a 406 — all the same to the caller: the
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
    // never throws, never null. Kitsu's JSON:API returns { data: [ ... ] }.
    async search(query, page) {
      if (!query) return []
      // `page` is accepted for signature parity with jikan.js's search; the
      // fallback only ever wants the first page of top matches, so it is not
      // threaded into the URL (Kitsu paginates with page[offset], not a page
      // number, and the fallback never asks for a second page).
      void page
      const data = await _schedule(() => _get(buildSearchUrl(query)))
      const list = data && data.data
      if (!Array.isArray(list)) return []
      return list.map(normalizeMedia)
    },

    // Detail lookup by Kitsu id. Returns one normalized entry, or null when
    // Kitsu has nothing or is unreachable. A `kitsu-`-prefixed id (the card key
    // this module stamps) is accepted as-is: the prefix is stripped so a caller
    // can pass either the raw Kitsu id or the card's own id back in. byId's
    // JSON:API response is { data: { ... } } — a single object, not an array.
    async byId(kitsuId) {
      const id = _kitsuIdOf(kitsuId)
      if (!id) return null
      const data = await _schedule(() => _get(buildByIdUrl(id)))
      const one = data && data.data
      return one && typeof one === 'object' && !Array.isArray(one)
        ? normalizeMedia(one) : null
    },

    // The trending shelf: Kitsu's /trending/anime. Returns a (possibly empty)
    // array of normalized entries; never throws, never null. This is the only
    // shelf section Kitsu serves in the third rung — see buildTrendingUrl.
    async trending(opts) {
      const data = await _schedule(() => _get(buildTrendingUrl(opts || {})))
      const list = data && data.data
      if (!Array.isArray(list)) return []
      return list.map(normalizeMedia)
    },
  }
}

// Accept either a raw Kitsu id (number/string) or this module's own
// `kitsu-<id>` card key, returning the numeric id or null. The card key is what
// _cardKey produces from a fallback card, and the detail router hands it
// straight back. Mirrors jikan.js's _malIdOf.
function _kitsuIdOf(value) {
  if (value == null) return null
  const s = String(value)
  const m = /^kitsu-(\d+)$/.exec(s)
  const n = Number(m ? m[1] : s)
  return Number.isFinite(n) && n > 0 ? n : null
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  KITSU_BASE,
  KITSU_ACCEPT,
  MIN_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  FORMAT_MAP,
  STATUS_MAP,
  scoreTo10,
  normalizeMedia,
  buildSearchUrl,
  buildByIdUrl,
  buildTrendingUrl,
  _kitsuIdOf,
  createKitsuCatalog,
}
