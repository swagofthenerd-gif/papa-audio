'use strict'
// AniList catalog — pure GraphQL normalisation around a thin fetch shell.
// CommonJS only; no runtime deps beyond the global `fetch`. Every I/O path
// accepts an injectable `fetchFn` so tests run without the network.
//
// AniList is a GraphQL API: requests are POSTs of `{ query, variables }` to
// https://graphql.anilist.co with header `Content-Type: application/json`.

const ANILIST_BASE = 'https://graphql.anilist.co'

// Abort a hung request rather than letting a lookup wait forever. A dead socket
// otherwise stalls a catalog row (or, worse, wedges a whole season-chain walk
// behind one hop). Same 10s ceiling the other catalog modules use
// (catalog/jikan.js) so the paths stay consistent.
const REQUEST_TIMEOUT_MS = 10000

// idMal is the MyAnimeList id AniSkip keys on, so it has to ride along on every
// anime lookup — without it the skip-intro feature has nothing to ask AniSkip.
const MEDIA_SELECTION = `id
          idMal
          title { english romaji native }
          seasonYear
          bannerImage
          coverImage { large extraLarge }
          description
          averageScore
          genres
          episodes
          status
          format
          trailer { id site }`

// PREQUEL and SEQUEL are the story spine. SIDE_STORY, SPIN_OFF, ALTERNATIVE,
// SUMMARY, CHARACTER and the rest are related works, not seasons, and putting
// them in a season list would misrepresent the watch order.
const CHAIN_RELATIONS = new Set(['PREQUEL', 'SEQUEL'])

// AniList's own data contains the occasional relation cycle; without a hop
// budget the walk would never terminate.
const MAX_CHAIN_HOPS = 12

function normalizeChainNode(n) {
  const title = (n && n.title) || {}
  return {
    id: n.id,
    title: title.english || title.romaji || title.native || null,
    titles: { english: title.english || null, romaji: title.romaji || null, native: title.native || null },
    year: n.seasonYear ?? null,
    episodeCount: n.episodes ?? null,
    format: n.format ?? null,
    status: n.status ?? null,
    poster: n.coverImage?.large ?? null,
  }
}

// One airing-schedule row: the show, its next unaired episode number, and when
// that episode airs (epoch SECONDS, as AniList reports airingAt). A show whose
// run has finished carries no nextAiringEpisode and is dropped — the schedule
// only ever lists shows that still have an episode coming. Returns null for
// those so a caller can filter in one pass.
function normalizeAiring(raw) {
  raw = raw || {}
  const next = raw.nextAiringEpisode
  if (!next || next.airingAt == null) return null
  const title = raw.title || {}
  return {
    id: raw.id ?? null,
    title: title.english || title.romaji || title.native || null,
    episode: next.episode ?? null,
    // airingAt is epoch seconds; the merge layer in main.js converts to ms once,
    // so every downstream airsAt is milliseconds regardless of source.
    airingAt: Number(next.airingAt),
  }
}

function normalizeMedia(raw) {
  raw = raw || {}
  const title = raw.title || {}
  return {
    id: raw.id ?? null,
    type: 'anime',
    // The MyAnimeList id AniSkip needs; null for shows that have no MAL entry.
    idMal: raw.idMal ?? null,
    title: title.english || title.romaji || title.native || null,
    // All three variants are kept, not just the display pick. Fansub groups
    // release under the ROMAJI title ("Sousou no Frieren"), so searching a
    // torrent indexer with the English one ("Frieren: Beyond Journey's End")
    // finds nothing at all for a large share of shows.
    titles: {
      english: title.english || null,
      romaji: title.romaji || null,
      native: title.native || null,
    },
    year: raw.seasonYear ?? null,
    poster: raw.coverImage?.large ?? null,
    backdrop: raw.bannerImage || (raw.coverImage && raw.coverImage.extraLarge) || null,
    overview: raw.description ?? null,
    // 0-10, matching TMDB. The raw 0-100 value is kept for anyone who needs it.
    rating: scoreTo10(raw.averageScore),
    scoreRaw: raw.averageScore ?? null,
    format: raw.format ?? null,
    trailer: raw.trailer && raw.trailer.id
      ? { id: raw.trailer.id, site: String(raw.trailer.site || 'youtube').toLowerCase() }
      : null,
    genres: Array.isArray(raw.genres) ? raw.genres : [],
    episodeCount: raw.episodes ?? null,
    status: raw.status ?? null,
  }
}

// Pure GraphQL query builders. `buildQuery` returns the query string for a
// kind; `buildVariables` returns the matching variables object. Kept separate
// so the POST body is assembled by the fetch shell, mirroring tmdb.js.
function buildQuery(kind, options) {
  // `options` (page/perPage) is accepted for signature parity with tmdb.js
  // builders; pagination lives in `buildVariables`, not the query string.
  void options
  switch (kind) {
    // The browse query. Every argument is optional at the GraphQL level, so one
    // query shape serves every combination of filters — AniList ignores a
    // variable that is null rather than erroring, which is why this does not
    // need to be assembled as a string per request.
    case 'discover':
      return `query ($page: Int, $perPage: Int, $genre: [String], $tag: [String],
                     $season: MediaSeason, $seasonYear: Int, $format: [MediaFormat],
                     $status: MediaStatus, $score: Int, $sort: [MediaSort], $isAdult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(type: ANIME, genre_in: $genre, tag_in: $tag, season: $season,
          seasonYear: $seasonYear, format_in: $format, status: $status,
          averageScore_greater: $score, sort: $sort, isAdult: $isAdult) {
      ${MEDIA_SELECTION}
    }
  }
}`
    // NOTE: `sort`/`search`/`season`/`seasonYear`/`type` are arguments of the
    // `media` field, NOT of `Page`. Placing them on `Page` makes AniList return
    // a 400 (`Unknown argument "sort" on field "Page"`). `type: ANIME` is also
    // required on `media`, otherwise the page returns manga/other types too.
    case 'trending':
      return `query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: TRENDING_DESC) {
      ${MEDIA_SELECTION}
    }
  }
}`
    case 'popular':
      return `query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: POPULARITY_DESC) {
      ${MEDIA_SELECTION}
    }
  }
}`
    case 'season':
      return `query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage) {
    media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC) {
      ${MEDIA_SELECTION}
    }
  }
}`
    case 'search':
      return `query ($page: Int, $perPage: Int, $search: String, $type: MediaType) {
  Page(page: $page, perPage: $perPage) {
    media(search: $search, type: $type) {
      ${MEDIA_SELECTION}
    }
  }
}`
    // One hop of the season chain. AniList models a multi-season anime as
    // separate entries linked by PREQUEL/SEQUEL edges, unlike TMDB where
    // seasons nest inside one show — so "the other seasons of Baki" has to be
    // walked, one request per hop.
    case 'relations':
      return `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    relations {
      edges {
        relationType
        node {
          id type format status seasonYear episodes
          title { english romaji native }
          coverImage { large }
        }
      }
    }
  }
}`
    // A detail lookup by id is NOT a text search. `Media(id:)` is a top-level
    // field, not a Page child, so this query shape differs from the others and
    // its result is read from `data.Media`, not `data.Page.media`.
    case 'byId':
      return `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    ${MEDIA_SELECTION}
  }
}`
    // The airing schedule for a batch of shows the viewer already follows (App
    // #25/#26). One Page query with id_in fetches every show's next episode in a
    // single round-trip — the airing shelf and the calendar must never fan out
    // one request per followed title. Only the id, a display title and
    // `nextAiringEpisode { airingAt episode }` are selected: this is a schedule
    // lookup, not a detail fetch, so the heavy MEDIA_SELECTION is deliberately
    // not pulled in. A finished show simply has `nextAiringEpisode: null`.
    case 'airing':
      return `query ($page: Int, $perPage: Int, $ids: [Int]) {
  Page(page: $page, perPage: $perPage) {
    media(id_in: $ids, type: ANIME) {
      id
      title { english romaji native }
      nextAiringEpisode { airingAt episode }
    }
  }
}`
    default:
      throw new Error(`Unknown AniList query kind: ${kind}`)
  }
}

// AniList scores out of 100. Everything downstream — the card badge, the
// filter rail, the sort — works in TMDB's 0-10, so the conversion happens once
// here rather than at each display site.
// null and '' both coerce to 0 through Number(), so they have to be rejected
// before the finite check — otherwise an unrated title scores 0, which shows
// as "0.0" on the badge and sorts below everything rather than as unrated.
function _score(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function scoreTo10(score) {
  const n = _score(score)
  return n == null ? null : Math.round(n) / 10
}

function scoreTo100(score) {
  const n = _score(score)
  return n == null ? null : Math.round(n * 10)
}

const SORTS = {
  popularity: ['POPULARITY_DESC'],
  rating: ['SCORE_DESC'],
  newest: ['START_DATE_DESC'],
  oldest: ['START_DATE'],
  title: ['TITLE_ROMAJI'],
  trending: ['TRENDING_DESC'],
}

function buildVariables(kind, opts = {}) {
  const { page, perPage, query, season, seasonYear, id } = opts
  // The byId query takes only $id; sending page/perPage would be rejected as
  // unknown variables are not, but keeping it clean matches the query shape.
  if (kind === 'byId' || kind === 'relations') return { id: Number(id) }
  if (kind === 'airing') {
    // ids arrive as strings from the video store and as numbers from API
    // objects; AniList's id_in is [Int], so each is coerced and anything that
    // is not a finite id is dropped rather than sent as NaN.
    const ids = (Array.isArray(opts.ids) ? opts.ids : [])
      .map(Number).filter(n => Number.isFinite(n) && n > 0)
    // perPage caps at 50 upstream; a follow list longer than that pages, but the
    // caller batches in 50s so one page is the norm.
    return { page: page ?? 1, perPage: perPage ?? 50, ids }
  }
  const vars = {
    page: page ?? 1,
    perPage: perPage ?? 20,
  }
  if (kind === 'discover') {
    // Only set what the caller asked for: AniList treats an explicit null as
    // "no filter", but leaving the key out entirely is clearer and avoids any
    // argument that does not accept null.
    if (Array.isArray(opts.genres) && opts.genres.length) vars.genre = opts.genres
    if (Array.isArray(opts.tags) && opts.tags.length) vars.tag = opts.tags
    if (Array.isArray(opts.formats) && opts.formats.length) vars.format = opts.formats
    if (opts.season) vars.season = opts.season
    if (opts.seasonYear) vars.seasonYear = Number(opts.seasonYear)
    if (opts.status) vars.status = opts.status
    // The caller works in 0-10; AniList's averageScore_greater is 0-100.
    if (opts.minRating != null && opts.minRating !== '') vars.score = scoreTo100(opts.minRating)
    vars.sort = SORTS[opts.sort] || SORTS.popularity
    vars.isAdult = opts.includeAdult === true
    return vars
  }
  if (kind === 'search') {
    vars.search = query ?? ''
    vars.type = 'ANIME'
  }
  if (kind === 'season') {
    // "Season" browsing means the currently-airing season, computed at call
    // time from the current date (AniList defines WINTER as Jan–Mar). Injected
    // season/seasonYear override the computed defaults.
    const now = new Date()
    const month = now.getMonth() + 1
    const year = now.getFullYear()
    vars.season = season ?? (month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL')
    vars.seasonYear = seasonYear ?? year
  }
  return vars
}

// How long to wait before retrying a failed season-chain hop. One second is
// enough for a blip; a 429 carries its own Retry-After, honoured up to three
// times the base so a rate-limited walk waits out the window instead of
// immediately failing again. Pure so the policy is testable without timers.
function _retryDelayMs(err, base) {
  if (err && Number(err.status) === 429) {
    const ra = Number(err.retryAfter)
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, base * 3)
  }
  return base
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// `retryDelayMs` is a test seam: production always uses the 1 s default.
function createAnilistCatalog({ fetchFn, retryDelayMs = 1000,
  timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const fetcher = fetchFn || fetch

  // Every AniList request is the same POST; this wraps it in an AbortController
  // so a hung socket cannot wedge a lookup (or a season-chain hop). Not every
  // injected fetcher honours `signal`, so the timer is cleared regardless. The
  // response is returned untouched: callers decide what a non-OK status means.
  async function _fetchGraphql(body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      return await fetcher(ANILIST_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        ...(controller ? { signal: controller.signal } : {}),
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function _post(kind, opts) {
    const query = buildQuery(kind, opts)
    const variables = buildVariables(kind, opts)
    const res = await _fetchGraphql(JSON.stringify({ query, variables }))
    if (!res || !res.ok) {
      const status = res && res.status != null ? res.status : 'unknown'
      const err = new Error(`AniList request failed (${status})`)
      // The status and Retry-After ride along so the season-chain retry can
      // treat a 429 differently from a dead network.
      err.status = res ? res.status : null
      const headers = res && res.headers
      if (headers && typeof headers.get === 'function') {
        err.retryAfter = headers.get('retry-after')
      }
      throw err
    }
    const data = await res.json()
    if (data && Array.isArray(data.errors) && data.errors.length) {
      throw new Error(`AniList GraphQL error: ${data.errors[0].message}`)
    }
    if (kind === 'byId') {
      const one = data?.data?.Media
      return one ? normalizeMedia(one) : null
    }
    if (kind === 'relations') {
      const edges = data?.data?.Media?.relations?.edges
      return Array.isArray(edges) ? edges : []
    }
    if (kind === 'airing') {
      const list = data?.data?.Page?.media
      return (Array.isArray(list) ? list : []).map(normalizeAiring).filter(Boolean)
    }
    const page = data?.data?.Page
    const media = (page?.media || []).map(normalizeMedia)
    // Browsing needs to know how many there are and whether to keep paging;
    // the fixed rows only ever wanted the list.
    if (kind === 'discover') {
      const info = page?.pageInfo || {}
      return {
        results: media,
        page: info.currentPage || 1,
        totalPages: info.lastPage || 1,
        totalResults: info.total || media.length,
        hasMore: info.hasNextPage === true,
      }
    }
    return media
  }

  // The last time a degraded call swallowed a failure, kept so a caller can tell
  // "AniList is down" apart from "AniList healthily returned nothing". Cleared on
  // the next successful degraded call, so a recovered API stops reporting an
  // outage. Shape: { at, message, status } or null.
  let _lastFailure = null

  // The browse/search/detail calls degrade quietly rather than rejecting, the
  // same convention seasonChain and airingSchedule already follow: a dead or
  // rate-limited AniList should leave a catalog row empty, not blow up the whole
  // request. The error is logged once (so a real outage is still diagnosable)
  // and a shape-appropriate empty value is returned — [] for a list, null for a
  // single lookup, an empty page object for discover. `_post` itself still
  // throws, because the season-chain walk relies on that to drive its retry and
  // `truncated` flag; only these public entry points swallow.
  //
  // On failure the reason is recorded in `_lastFailure` (and read back via the
  // exported `lastFailure()`), so the shelf handlers in main.js can serve the
  // persistent browse cache and tell the renderer the row is empty *because*
  // AniList is down — not because there was nothing to show. A success clears
  // it, so the flag never outlives the outage that set it.
  const _degrade = async (fallback, fn) => {
    try {
      const out = await fn()
      _lastFailure = null
      return out
    } catch (err) {
      const message = (err && err.message) || String(err)
      console.warn('[anilist] request degraded:', message)
      _lastFailure = { at: Date.now(), message, status: (err && err.status) ?? null }
      return fallback
    }
  }
  const _emptyDiscover = () => ({
    results: [], page: 1, totalPages: 1, totalResults: 0, hasMore: false,
  })

  return {
    // Why the most recent degraded list came back empty: a { at, message, status }
    // set by `_degrade` on a swallowed failure and cleared on the next success,
    // or null when the last degraded call succeeded (or none has run). The shelf
    // handlers read this immediately after a list call to distinguish an outage
    // from a healthy-but-empty result.
    lastFailure() {
      return _lastFailure
    },
    trending(page) {
      return _degrade([], () => _post('trending', { page }))
    },
    popular(page) {
      return _degrade([], () => _post('popular', { page }))
    },
    season(page, { season, seasonYear } = {}) {
      return _post('season', { page, season, seasonYear })
    },
    search(query, page) {
      return _degrade([], () => _post('search', { query, page }))
    },
    // Unlike the browse/search calls, byId does NOT degrade. A list shelf can
    // quietly render empty when AniList is down, but a detail page must be able
    // to say *why* it failed — degrading to null erases the reason and forces a
    // bare "Not found". `_post` throws an Error whose message carries AniList's
    // own text (e.g. the API-disabled notice, or a request-failed status), and
    // the video-detail handler in main.js surfaces `e.message` to the renderer's
    // error page. So this rethrows and lets the caller decide (main.js falls
    // back to its persistent detail cache before letting the error through).
    // A genuinely unknown id still returns null here without throwing: `_post`
    // maps a null `data.Media` to null, which is not an error.
    byId(id) {
      return _post('byId', { id })
    },
    discover(opts) {
      return _degrade(_emptyDiscover(), () => _post('discover', opts || {}))
    },
    relations(id) {
      return _degrade([], () => _post('relations', { id }))
    },

    // The next-episode schedule for a batch of followed shows (App #25/#26).
    // One batched query for every id; a finished show is simply absent from the
    // result. An empty or all-invalid id list never touches the network.
    async airingSchedule(ids) {
      const clean = (Array.isArray(ids) ? ids : [])
        .map(Number).filter(n => Number.isFinite(n) && n > 0)
      if (!clean.length) return []
      return _post('airing', { ids: clean })
    },

    // The full run of a series, in watch order.
    //
    // AniList has no concept of "season 3 of Baki": each season is its own
    // entry, linked to its neighbours by PREQUEL and SEQUEL edges. So the run
    // is reconstructed by walking backwards to the first entry and then
    // forwards to the last, one request per hop.
    //
    // Only ANIME nodes are followed — a manga ADAPTATION edge is not a season.
    // Only PREQUEL and SEQUEL build the spine; SIDE_STORY, SPIN_OFF and the
    // rest are collected separately as related titles rather than being
    // presented as seasons, because they are not part of the main story.
    // Returns `{ seasons, related, truncated }`. `truncated: true` means a
    // fetch failed even after the retry, so the walk stopped early and the
    // list may be missing seasons — a caller that caches season chains should
    // refuse to cache a truncated one. (The current caller caches on
    // `seasons.length` alone, which is exactly why the retry lives here: a
    // transient blip must not become a permanently cached half-chain.)
    async seasonChain(id, { maxHops = MAX_CHAIN_HOPS } = {}) {
      // No id means no walk ran, so there is nothing to be truncated: the
      // pre-walk shape stays exactly as it was.
      const start = Number(id)
      if (!start) return { seasons: [], related: [] }

      const nodes = new Map()      // id -> normalized entry
      const related = new Map()
      const seen = new Set()
      let truncated = false

      // One retry after a backoff before a hop is given up on. AniList's rate
      // limiter answers a burst of hops with 429s, and giving up on the first
      // one silently truncated the chain.
      const _retryOnce = async fn => {
        try {
          return await fn()
        } catch (err) {
          await _sleep(_retryDelayMs(err, retryDelayMs))
          return fn()
        }
      }

      const record = (edge) => {
        const n = edge && edge.node
        if (!n || n.type !== 'ANIME' || n.id == null) return null
        const entry = normalizeChainNode(n)
        if (CHAIN_RELATIONS.has(edge.relationType)) return entry
        if (!nodes.has(entry.id)) related.set(entry.id, entry)
        return null
      }

      // Walk one direction until the chain ends or the hop budget runs out.
      // The budget is a guard against a cycle in AniList's own data, which
      // does happen — a bad edge would otherwise loop forever.
      const walk = async (fromId, relation, out) => {
        let current = fromId
        for (let hop = 0; hop < maxHops; hop++) {
          if (seen.has(current)) break
          seen.add(current)
          let edges = []
          try {
            edges = await _retryOnce(() => _post('relations', { id: current }))
          } catch (_) {
            // A failed hop after the retry ends this direction of the walk,
            // but the result now says so instead of passing off the partial
            // chain as complete.
            truncated = true
            break
          }
          let next = null
          for (const edge of edges) {
            const entry = record(edge)
            if (!entry) continue
            if (edge.relationType === relation && !seen.has(entry.id)) next = entry
            if (!nodes.has(entry.id)) nodes.set(entry.id, entry)
          }
          if (!next) break
          current = next.id
        }
      }

      // The starting entry belongs in the list even if it has no relations.
      // Guarded like every hop: a season list is an enhancement, and losing it
      // must never take the detail page down with it.
      let self = null
      try {
        self = await _retryOnce(() => _post('byId', { id: start }))
      } catch (_) {
        // Degrade to empty, but flagged: a chain missing its own starting
        // entry is truncated by any definition.
        truncated = true
      }
      if (self) nodes.set(self.id, { id: self.id, title: self.title, titles: self.titles,
        year: self.year, episodeCount: self.episodeCount, format: self.format,
        status: self.status, poster: self.poster })

      // The visited set is per direction. Sharing it meant the sequel walk saw
      // the start id already marked and stopped on its first iteration, so a
      // series only ever gained the one sequel picked up incidentally while
      // walking backwards — Baki ended at 2020 with Baki Hanma missing.
      await walk(start, 'PREQUEL', nodes)
      seen.clear()
      await walk(start, 'SEQUEL', nodes)

      // Chronological, which for a prequel/sequel chain is watch order. Entries
      // with no year sort last rather than to 1970.
      const seasons = [...nodes.values()].sort((a, b) => {
        const ay = Number(a.year) || Infinity
        const by = Number(b.year) || Infinity
        if (ay !== by) return ay - by
        return String(a.title || '').localeCompare(String(b.title || ''))
      })
      for (const s of seasons) related.delete(s.id)
      return { seasons, related: [...related.values()], truncated }
    },
    // The browse vocabularies. Both are static enough to cache for a week: 19
    // genres, and 361 tags that change when AniList's editors add one.
    async genres() {
      const res = await _fetchGraphql(JSON.stringify({ query: '{ GenreCollection }' }))
      if (!res || !res.ok) return []
      const data = await res.json()
      const list = data?.data?.GenreCollection
      // Hentai is a genre in AniList's vocabulary; it is filtered here rather
      // than in the UI so it cannot leak into a chip list by accident.
      return Array.isArray(list) ? list.filter(g => g && g !== 'Hentai') : []
    },
    async tags() {
      const res = await _fetchGraphql(
        JSON.stringify({ query: '{ MediaTagCollection { name category isAdult } }' }))
      if (!res || !res.ok) return []
      const data = await res.json()
      const list = data?.data?.MediaTagCollection
      if (!Array.isArray(list)) return []
      // Grouped by category: 361 tags as a flat list is unusable.
      const byCategory = new Map()
      for (const t of list) {
        if (!t || !t.name || t.isAdult) continue
        const cat = t.category || 'Other'
        if (!byCategory.has(cat)) byCategory.set(cat, [])
        byCategory.get(cat).push(t.name)
      }
      return [...byCategory.entries()]
        .map(([category, tags]) => ({ category, tags: tags.sort() }))
        .sort((a, b) => a.category.localeCompare(b.category))
    },
  }
}

module.exports = {
  SORTS,
  CHAIN_RELATIONS,
  MAX_CHAIN_HOPS,
  REQUEST_TIMEOUT_MS,
  normalizeChainNode,
  _retryDelayMs,
  scoreTo10,
  scoreTo100,
  normalizeMedia,
  normalizeAiring,
  buildQuery,
  buildVariables,
  createAnilistCatalog,
}
