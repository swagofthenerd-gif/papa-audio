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
          trailer { id site }
          duration
          season
          nextAiringEpisode { airingAt episode }
          popularity`

// What only a detail page needs, on top of MEDIA_SELECTION: the facts panel,
// the characters rail and the recommendations rail. Fetched in the same
// request as the entry itself, so opening a show costs one round-trip for
// all of it.
const DETAIL_SELECTION = `startDate { year month day }
          endDate { year month day }
          studios(isMain: true) { nodes { name } }
          countryOfOrigin
          siteUrl
          popularity
          favourites
          source
          synonyms
          characters(sort: [ROLE, RELEVANCE], perPage: 12) {
            edges {
              role
              node { id name { full } image { large } }
              voiceActors(language: JAPANESE, sort: RELEVANCE) { name { full } }
            }
          }
          recommendations(sort: RATING_DESC, perPage: 12) {
            nodes {
              mediaRecommendation {
                id idMal seasonYear format averageScore episodes status
                title { english romaji native }
                coverImage { large extraLarge }
                bannerImage
                genres
              }
            }
          }`

// What a season-chain hop needs of each entry: enough for the rail card and
// the walk itself, nothing heavier.
const CHAIN_NODE_SELECTION = `id type format status seasonYear episodes
          title { english romaji native }
          coverImage { large }`

// AniList allows 90 requests a minute (it has run at 30 during incidents).
// Every request from this process goes through one lane with this much space
// between sends, so a home page, a hero, a search and a detail page opening
// at once queue up instead of bursting and being refused.
const MIN_GAP_MS = 700
// A refused request (429) is retried once after the wait AniList asks for,
// up to this ceiling; a longer wait is treated as an outage instead.
const RATE_LIMIT_WAIT_CAP_MS = 30 * 1000
const RATE_LIMIT_WAIT_DEFAULT_MS = 2000

// AniList's genre vocabulary as of 2026, kept so the Browse rail always has
// chips even when the vocabulary request itself is refused. The live list
// replaces it whenever it can be fetched.
const GENRES_FALLBACK = ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy',
  'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance',
  'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller']

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

// One airing-schedule entry with its show: the normalized media plus which
// episode and when (epoch ms). Hentai and shows with no title are dropped.
function normalizeScheduleEntry(raw) {
  if (!raw || !raw.media || raw.media.isAdult) return null
  const media = normalizeMedia(raw.media)
  if (!media.id || !media.title) return null
  return Object.assign(media, {
    aired: { episode: raw.episode ?? null, airingAt: Number(raw.airingAt) * 1000 },
  })
}
// The day's schedule without the shorts nobody follows — unless that would
// leave the strip near-empty, in which case everything stays.
const TODAY_POPULARITY_FLOOR = 2000
function _worthListing(list) {
  const kept = list.filter(e => (e.popularity || 0) >= TODAY_POPULARITY_FLOOR)
  return kept.length >= 4 ? kept : list
}
// A show that aired two episodes this week appears once, with the latest.
function _uniqueShows(list) {
  const seen = new Set()
  return list.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true })
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
    // Minutes per episode (or the film's length).
    duration: raw.duration ?? null,
    // WINTER / SPRING / SUMMER / FALL, paired with `year` for "Fall 1999".
    season: raw.season ?? null,
    // The next unaired episode, for a countdown; null once a run is over.
    nextAiring: raw.nextAiringEpisode && raw.nextAiringEpisode.airingAt != null
      ? { airingAt: Number(raw.nextAiringEpisode.airingAt) * 1000, episode: raw.nextAiringEpisode.episode ?? null }
      : null,
    // The detail-only facts. A list entry has none of these and reads null.
    startDate: _fuzzyDate(raw.startDate),
    endDate: _fuzzyDate(raw.endDate),
    studios: raw.studios && Array.isArray(raw.studios.nodes)
      ? raw.studios.nodes.map(n => n && n.name).filter(Boolean) : [],
    country: raw.countryOfOrigin ?? null,
    siteUrl: raw.siteUrl ?? null,
    popularity: raw.popularity ?? null,
    favourites: raw.favourites ?? null,
    source: raw.source ?? null,
    synonyms: Array.isArray(raw.synonyms) ? raw.synonyms.filter(Boolean) : [],
    characters: raw.characters && Array.isArray(raw.characters.edges)
      ? raw.characters.edges.map(_character).filter(Boolean) : [],
    recommendations: raw.recommendations && Array.isArray(raw.recommendations.nodes)
      ? raw.recommendations.nodes.map(n => n && n.mediaRecommendation).filter(m => m && m.id != null).map(normalizeMedia)
      : [],
  }
}

// AniList's FuzzyDate → "YYYY-MM-DD" (or just "YYYY" / "YYYY-MM" when that is
// all it knows); null when even the year is missing.
function _fuzzyDate(d) {
  if (!d || !d.year) return null
  const pad = n => String(n).padStart(2, '0')
  if (!d.month) return String(d.year)
  if (!d.day) return d.year + '-' + pad(d.month)
  return d.year + '-' + pad(d.month) + '-' + pad(d.day)
}

// One character on the rail: the name, the portrait, MAIN/SUPPORTING and the
// Japanese voice actor.
function _character(edge) {
  const n = edge && edge.node
  if (!n || !n.name || !n.name.full) return null
  const va = Array.isArray(edge.voiceActors) && edge.voiceActors[0] && edge.voiceActors[0].name
    ? edge.voiceActors[0].name.full : null
  return { id: n.id ?? null, name: n.name.full, image: (n.image && n.image.large) || null, role: edge.role || null, voiceActor: va }
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
                     $status: MediaStatus, $score: Int, $sort: [MediaSort], $isAdult: Boolean,
                     $minPopularity: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { total currentPage lastPage hasNextPage }
    media(type: ANIME, genre_in: $genre, tag_in: $tag, season: $season,
          seasonYear: $seasonYear, format_in: $format, status: $status,
          averageScore_greater: $score, sort: $sort, isAdult: $isAdult,
          popularity_greater: $minPopularity) {
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
    //
    // Two levels in one request: each related entry comes with its own
    // relations, so the walk expands two hops per round-trip. A franchise
    // that used to cost twelve requests (and drew AniList's rate limiter
    // every time a detail page opened) now costs three or four.
    case 'relations':
      return `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    relations {
      edges {
        relationType
        node {
          ${CHAIN_NODE_SELECTION}
          relations {
            edges {
              relationType
              node {
                ${CHAIN_NODE_SELECTION}
              }
            }
          }
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
    ${DETAIL_SELECTION}
  }
}`
    // The same entry looked up by its MyAnimeList id: a card that came from
    // the Jikan fallback ("mal-<id>") has no AniList id of its own, and the
    // season chain needs one to walk from.
    case 'byMal':
      return `query ($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
    ${MEDIA_SELECTION}
    ${DETAIL_SELECTION}
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
    // The whole anime home page in one request: seven shelves as aliases of
    // Page, plus the airing schedule behind "New episodes" (the last three
    // days, newest first) and "Airing today" (the next 24 hours, soonest
    // first). Seven separate requests through the lane would take five
    // seconds to fill the last row; one takes a second.
    case 'animeHome':
      return `query ($season: MediaSeason, $seasonYear: Int, $now: Int, $recent: Int, $tomorrow: Int) {
  trending: Page(page: 1, perPage: 20) { media(type: ANIME, sort: TRENDING_DESC) { ${MEDIA_SELECTION} } }
  popular: Page(page: 1, perPage: 20) { media(type: ANIME, sort: POPULARITY_DESC) { ${MEDIA_SELECTION} } }
  season: Page(page: 1, perPage: 20) { media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC) { ${MEDIA_SELECTION} } }
  topAiring: Page(page: 1, perPage: 20) { media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC) { ${MEDIA_SELECTION} } }
  upcoming: Page(page: 1, perPage: 20) { media(type: ANIME, status: NOT_YET_RELEASED, sort: POPULARITY_DESC) { ${MEDIA_SELECTION} } }
  topRated: Page(page: 1, perPage: 20) { media(type: ANIME, sort: SCORE_DESC, popularity_greater: 20000) { ${MEDIA_SELECTION} } }
  newEpisodes: Page(page: 1, perPage: 40) { airingSchedules(airingAt_greater: $recent, airingAt_lesser: $now, sort: TIME_DESC) { airingAt episode media { ${MEDIA_SELECTION} } } }
  today: Page(page: 1, perPage: 50) { airingSchedules(airingAt_greater: $now, airingAt_lesser: $tomorrow, sort: TIME) { airingAt episode media { ${MEDIA_SELECTION} } } }
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
  if (kind === 'animeHome') {
    const now = Math.floor((opts.now != null ? Number(opts.now) : Date.now()) / 1000)
    const d = new Date(now * 1000)
    const month = d.getMonth() + 1
    return {
      season: season ?? (month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL'),
      seasonYear: seasonYear ?? d.getFullYear(),
      now,
      recent: now - 3 * 86400,
      tomorrow: now + 86400,
    }
  }
  if (kind === 'byMal') return { idMal: Number(opts.idMal) }
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
    // "Top rated" without a popularity floor is a list of shows nobody has
    // heard of with ten perfect votes each.
    if (opts.minPopularity) vars.minPopularity = Number(opts.minPopularity)
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
// `minGapMs` and `rateLimitWaitCapMs` default to the production pacing only
// when the real network is used; an injected fetcher (the tests) gets no
// pacing and no internal 429 retry unless it asks for them.
function createAnilistCatalog({ fetchFn, retryDelayMs = 1000,
  timeoutMs = REQUEST_TIMEOUT_MS,
  minGapMs = fetchFn ? 0 : MIN_GAP_MS,
  rateLimitWaitCapMs = fetchFn ? 0 : RATE_LIMIT_WAIT_CAP_MS } = {}) {
  const fetcher = fetchFn || fetch

  // Every AniList request is the same POST; this wraps it in an AbortController
  // so a hung socket cannot wedge a lookup (or a season-chain hop). Not every
  // injected fetcher honours `signal`, so the timer is cleared regardless. The
  // response is returned untouched: callers decide what a non-OK status means.
  async function _fetchOnce(body) {
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

  // The one lane every request goes down. Requests are sent `minGapMs`
  // apart; a 429 is retried once after the wait AniList asks for (capped),
  // and the lane stays blocked meanwhile, because anything sent during that
  // wait would be refused too. A rejection never breaks the lane.
  let _lane = Promise.resolve()
  let _lastSentAt = 0
  let _rateLimitedUntil = 0
  // After a refusal the lane sends at a third of its pace for a minute:
  // AniList's limit drops during incidents, and a second burst into a
  // limiter that has already said no only earns a longer hold.
  let _slowUntil = 0
  const SLOW_FOR_MS = 60 * 1000
  const _gap = () => (Date.now() < _slowUntil ? minGapMs * 3 : minGapMs)
  const _rateLimitWait = res => {
    const headers = res && res.headers
    const ra = headers && typeof headers.get === 'function' ? Number(headers.get('retry-after')) : NaN
    const asked = Number.isFinite(ra) && ra > 0 ? ra * 1000 : RATE_LIMIT_WAIT_DEFAULT_MS
    return asked <= rateLimitWaitCapMs ? asked : null
  }
  function _fetchGraphql(body) {
    const run = _lane.then(async () => {
      const wait = Math.max(_gap() - (Date.now() - _lastSentAt), _rateLimitedUntil - Date.now())
      if (wait > 0) await _sleep(wait)
      _lastSentAt = Date.now()
      let res = await _fetchOnce(body)
      if (res && res.status === 429) {
        _slowUntil = Date.now() + SLOW_FOR_MS
        const ms = _rateLimitWait(res)
        if (ms != null) {
          _rateLimitedUntil = Date.now() + ms
          await _sleep(ms)
          _lastSentAt = Date.now()
          res = await _fetchOnce(body)
        }
      }
      return res
    })
    _lane = run.then(() => undefined, () => undefined)
    return run
  }

  // Identical requests in flight at the same moment share one round-trip:
  // the hero and a shelf asking for the same page, or two detail lookups of
  // one show, must not each spend a slot in the lane.
  const _inflight = new Map()
  function _post(kind, opts) {
    const query = buildQuery(kind, opts)
    const variables = buildVariables(kind, opts)
    const body = JSON.stringify({ query, variables })
    if (_inflight.has(body)) return _inflight.get(body)
    const p = _postBody(kind, body).finally(() => { _inflight.delete(body) })
    _inflight.set(body, p)
    return p
  }

  async function _postBody(kind, body) {
    const res = await _fetchGraphql(body)
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
    if (kind === 'byId' || kind === 'byMal') {
      const one = data?.data?.Media
      return one ? normalizeMedia(one) : null
    }
    if (kind === 'relations') {
      const edges = data?.data?.Media?.relations?.edges
      return Array.isArray(edges) ? edges : []
    }
    if (kind === 'animeHome') {
      const d = data?.data || {}
      const list = key => ((d[key] && d[key].media) || []).map(normalizeMedia)
      const sched = key => ((d[key] && d[key].airingSchedules) || []).map(normalizeScheduleEntry).filter(Boolean)
      return {
        trending: list('trending'), popular: list('popular'), season: list('season'),
        topAiring: list('topAiring'), upcoming: list('upcoming'), topRated: list('topRated'),
        // The schedule is full of shorts nobody follows; the shows people
        // actually watch come first, and the day's strip keeps its clock order.
        newEpisodes: _uniqueShows(sched('newEpisodes')).sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 20),
        today: _worthListing(sched('today')),
      }
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
  // Circuit breaker (S7). During an outage every shelf, hero rotation and
  // search kept asking AniList again on its own timer — a degraded request
  // every ~30 s for as long as the outage lasted. After a failure the next
  // calls are answered with the fallback immediately, for a window that
  // doubles on each further failure up to a ceiling, and resets on success.
  // 429s honour Retry-After when it is longer than the window.
  const BREAKER_BASE_MS = 30 * 1000
  const BREAKER_CEILING_MS = 10 * 60 * 1000
  let _breakerUntil = 0
  let _breakerStrikes = 0
  const _breakerOpen = () => Date.now() < _breakerUntil
  const _breakerTrip = (err) => {
    _breakerStrikes = Math.min(_breakerStrikes + 1, 20)
    let wait = Math.min(BREAKER_CEILING_MS, BREAKER_BASE_MS * Math.pow(2, _breakerStrikes - 1))
    const ra = err && Number(err.retryAfter)
    if (Number.isFinite(ra) && ra > 0) wait = Math.max(wait, Math.min(ra * 1000, BREAKER_CEILING_MS))
    _breakerUntil = Date.now() + wait
    return wait
  }
  const _breakerReset = () => { _breakerUntil = 0; _breakerStrikes = 0 }

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
    // Breaker open: the outage is known and recent. Answer with the fallback
    // now; _lastFailure still says why, so the shelves keep telling the truth.
    if (_breakerOpen()) return fallback
    try {
      const out = await fn()
      _lastFailure = null
      _breakerReset()
      return out
    } catch (err) {
      const message = (err && err.message) || String(err)
      const wait = _breakerTrip(err)
      console.warn('[anilist] request degraded:', message, '— pausing AniList calls for', Math.round(wait / 1000) + 's')
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
    // For tests and the doctor surface: is the breaker currently holding calls?
    breaker() {
      return { open: _breakerOpen(), until: _breakerUntil, strikes: _breakerStrikes }
    },
    _resetBreaker() { _breakerReset() },
    // For tests: is the lane in its slowed-down minute after a refusal?
    _slowed() { return Date.now() < _slowUntil },
    // The anime home bundle, or null when AniList cannot answer.
    home(opts) {
      return _degrade(null, () => _post('animeHome', opts || {}))
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
    async seasonChain(id, { maxHops = MAX_CHAIN_HOPS, idMal = null, title = null } = {}) {
      // No id means no walk ran, so there is nothing to be truncated: the
      // pre-walk shape stays exactly as it was. A card from the Jikan or
      // Kitsu fallback ("mal-9253", "kitsu-…") carries no AniList id: it is
      // resolved here — by MyAnimeList id, else by title — so the chain
      // walks for every show, whichever database the card came from.
      // (Steins;Gate opened from a MAL card listed no seasons at all.)
      let start = Number(id)
      if (!start) {
        const malMatch = /^mal-(\d+)$/.exec(String(id || ''))
        const mal = Number(idMal) || (malMatch ? Number(malMatch[1]) : 0)
        try {
          if (mal) { const byMal = await _post('byMal', { idMal: mal }); if (byMal && byMal.id) start = Number(byMal.id) }
          if (!start && title) {
            const hits = await _post('search', { query: title, page: 1, perPage: 5 })
            const list = Array.isArray(hits) ? hits : (hits && hits.items) || []
            const want = String(title).toLowerCase().trim()
            const exact = list.find(m => m && m.titles && [m.titles.english, m.titles.romaji, m.titles.native].some(t => t && String(t).toLowerCase().trim() === want))
            const pick = exact || list[0]
            if (pick && pick.id) start = Number(pick.id)
          }
        } catch (_) { /* resolution is best-effort; no id means no walk */ }
      }
      if (!start) return { seasons: [], related: [] }

      // The whole franchise, not just the prequel/sequel spine: AniList links
      // Steins;Gate to Steins;Gate 0 only through an ALTERNATIVE OVA, so a
      // spine-only walk never found the second series. Every franchise edge
      // (prequel, sequel, side story, spin-off, alternative, parent, summary)
      // is followed, breadth-first, under a request budget against a cycle or
      // a Gundam-sized graph; OTHER and CHARACTER links (the wider universe,
      // a crossover) are kept as related without being expanded. Television
      // entries of the franchise are the seasons; everything else — films,
      // OVAs, specials, the wider universe — is related, relation named.
      const EXPAND = new Set(['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'PARENT', 'SUMMARY', 'COMPILATION', 'CONTAINS'])
      // A season is a television entry on the story's own line: reached from
      // the start through prequel/sequel/parent/alternative/summary edges
      // only. A side story or spin-off — even a television one — and
      // everything reached through it is related, not a season.
      const SPINE = new Set(['PREQUEL', 'SEQUEL', 'PARENT', 'ALTERNATIVE', 'SUMMARY', 'COMPILATION', 'CONTAINS'])
      const MAX_REQUESTS = Math.max(4, maxHops)
      const franchise = new Map()   // id -> entry (+ relation by which it was reached)
      const related = new Map()
      let truncated = false
      let capped = false

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
      if (self) franchise.set(self.id, { id: self.id, title: self.title, titles: self.titles,
        year: self.year, episodeCount: self.episodeCount, format: self.format,
        status: self.status, poster: self.poster, relation: null, spine: true })

      const queue = [start]
      const visited = new Set()
      let requests = 0
      while (queue.length) {
        const current = queue.shift()
        if (visited.has(current)) continue
        if (requests >= MAX_REQUESTS) { capped = true; break }
        visited.add(current)
        let edges = []
        try {
          requests++
          edges = await _retryOnce(() => _post('relations', { id: current }))
        } catch (_) {
          // A failed hop after the retry is skipped, but the result says so
          // instead of passing off the partial graph as complete.
          truncated = true
          continue
        }
        absorb(current, edges)
      }

      // Files one entry's edges into the franchise. An expanded entry that
      // arrived with its own relations (the second level of the query) is
      // filed the same way at once and marked visited, so the walk never
      // spends a request on what it already holds.
      function absorb(fromId, list) {
        for (const edge of list) {
          const n = edge && edge.node
          if (!n || n.type !== 'ANIME' || n.id == null) continue
          const from = franchise.get(fromId)
          const entry = Object.assign({ relation: edge.relationType || null, spine: !!(from && from.spine !== false) && SPINE.has(edge.relationType) }, normalizeChainNode(n))
          if (EXPAND.has(edge.relationType)) {
            if (!franchise.has(entry.id)) { franchise.set(entry.id, entry); queue.push(entry.id) }
            else if (entry.spine && franchise.get(entry.id).spine === false) franchise.get(entry.id).spine = true
            const nested = n.relations && Array.isArray(n.relations.edges) ? n.relations.edges : null
            if (nested && !visited.has(entry.id)) {
              visited.add(entry.id)
              absorb(entry.id, nested)
            }
          } else if (!franchise.has(entry.id) && !related.has(entry.id)) {
            related.set(entry.id, entry)
          }
        }
      }

      const byYear = (a, b) => {
        const ay = Number(a.year) || Infinity
        const by = Number(b.year) || Infinity
        if (ay !== by) return ay - by
        return String(a.title || '').localeCompare(String(b.title || ''))
      }
      const isSeries = e => e.id === start || (e.spine !== false && /^TV/i.test(String(e.format || '')))
      // Chronological, which for a franchise is watch order. Entries with no
      // year sort last rather than to 1970.
      const seasons = [...franchise.values()].filter(isSeries).sort(byYear)
      const rest = [...franchise.values()].filter(e => !isSeries(e))
      for (const r of rest) if (!related.has(r.id)) related.set(r.id, r)
      for (const s of seasons) related.delete(s.id)
      return { seasons, related: [...related.values()].sort(byYear), truncated, capped }
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
  MIN_GAP_MS,
  RATE_LIMIT_WAIT_CAP_MS,
  GENRES_FALLBACK,
  normalizeChainNode,
  _retryDelayMs,
  scoreTo10,
  scoreTo100,
  normalizeMedia,
  normalizeAiring,
  normalizeScheduleEntry,
  buildQuery,
  buildVariables,
  createAnilistCatalog,
}
