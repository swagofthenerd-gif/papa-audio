'use strict'
// TMDB catalog — pure normalisation + URL builders around a thin fetch shell.
// CommonJS only; no runtime deps beyond the global `fetch`. Every I/O path
// accepts an injectable `fetchFn` so tests run without the network.

const TMDB_BASE = 'https://api.themoviedb.org/3'
const IMG_BASE = 'https://image.tmdb.org/t/p/w500'
// Hero art is sized differently from a poster grid: a title logo is drawn at
// roughly a third of the hero width, a hero backdrop fills it. w500 posters
// are right for cards and wrong for both, so each gets its own base.
const LOGO_BASE = 'https://image.tmdb.org/t/p/w500'
const BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280'

function _year(date) {
  return typeof date === 'string' && date.length >= 4 ? date.slice(0, 4) : null
}

function _image(path) {
  return typeof path === 'string' && path.length ? `${IMG_BASE}${path}` : null
}

// genre_ids are numeric IDs without names, so they cannot populate the string
// genres[] the UI renders. Only raw.genres (detail responses, array of
// {id,name}) feeds genres; everything else falls back to [].
// TMDB puts the IMDb id at raw.imdb_id for movies and at
// raw.external_ids.imdb_id for tv (only when external_ids was appended).
function _imdbId(raw) {
  const id = raw?.imdb_id || raw?.external_ids?.imdb_id
  return typeof id === 'string' && id.length ? id : null
}

function _genres(raw) {
  if (!Array.isArray(raw?.genres)) return []
  return raw.genres.map(g => (typeof g === 'string' ? g : g?.name)).filter(Boolean)
}

// Cast/crew: keep the fields the detail page actually renders, and drop the
// rest so a 100-actor ensemble does not bloat a cached detail object.
function _people(list) {
  if (!Array.isArray(list)) return []
  return list
    .map(c => c && {
      id: c.id ?? null,
      name: c.name ?? null,
      character: c.character ?? null,
      job: c.job ?? null,
      department: c.department ?? null,
      profilePath: _image(c.profile_path),
      order: c.order ?? null,
    })
    .filter(p => p && p.name)
}

function _cast(raw) {
  return _people(raw?.credits?.cast)
}

function _crew(raw) {
  return _people(raw?.credits?.crew)
}

// A teaser is a poor substitute for a trailer but a good substitute for
// nothing, and plenty of titles have only one or the other. Both are kept and
// ranked: official trailers first, then unofficial, then teasers, and the
// newest within each band — an old teaser for a film that later got a proper
// trailer should never win.
const _TRAILER_RANK = { Trailer: 0, Teaser: 1 }

function _trailers(raw) {
  const results = raw?.videos?.results
  if (!Array.isArray(results)) return []
  return results
    .filter(v => v && v.key && _TRAILER_RANK[v.type] != null && v.site === 'YouTube')
    .map(v => ({
      key: v.key,
      name: v.name ?? null,
      site: v.site ?? null,
      type: v.type ?? null,
      size: v.size ?? null,
      official: v.official === true,
      publishedAt: v.published_at ?? null,
    }))
    .sort((a, b) => {
      const ta = _TRAILER_RANK[a.type], tb = _TRAILER_RANK[b.type]
      if (ta !== tb) return ta - tb
      if (a.official !== b.official) return a.official ? -1 : 1
      return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))
    })
}

// Studios and spoken languages are arrays of {name, ...}; keep the names.
function _names(list) {
  if (!Array.isArray(list)) return []
  return list.map(x => (x && (x.name || x.english_name)) || null).filter(Boolean)
}

// watch/providers → { "US": { flatrate: ["Netflix"], rent: [...], buy: [...] } }.
// Country keys are preserved; the UI decides which to show.
function _providers(wp) {
  const results = wp && wp.results
  if (!results || typeof results !== 'object') return null
  const out = {}
  for (const [country, entry] of Object.entries(results)) {
    if (!entry || typeof entry !== 'object') continue
    const kinds = {}
    for (const kind of ['flatrate', 'rent', 'buy', 'ads', 'free']) {
      const names = (Array.isArray(entry[kind]) ? entry[kind] : [])
        .map(p => p && p.provider_name).filter(Boolean)
      if (names.length) kinds[kind] = names
    }
    if (Object.keys(kinds).length) out[country] = kinds
  }
  return Object.keys(out).length ? out : null
}

function _collection(raw) {
  const c = raw?.belongs_to_collection
  if (!c) return null
  return { id: c.id ?? null, name: c.name ?? null, poster: _image(c.poster_path), backdrop: _image(c.backdrop_path) }
}

// similar / recommendations are full entries of the parent's own type, minus
// the expensive appended sub-objects. A light summary is enough for a rail.
function _related(list, type) {
  if (!Array.isArray(list)) return []
  const isTv = type === 'tv'
  return list
    .map(r => r && {
      id: r.id ?? null,
      type,
      title: (isTv ? r.name : r.title) ?? null,
      year: _year(isTv ? r.first_air_date : r.release_date),
      poster: _image(r.poster_path),
      rating: r.vote_average ?? null,
    })
    .filter(r => r && r.id != null)
}

// The append_to_response sub-objects are always present on a detail response
// (we ask for them), so the extras they produce are always present on the
// normalised entry — with empty defaults when TMDB sent nothing usable.
function _extras(raw, type) {
  return {
    cast: _cast(raw),
    crew: _crew(raw),
    trailers: _trailers(raw),
    studios: _names(raw.production_companies),
    languages: _names(raw.spoken_languages),
    providers: _providers(raw['watch/providers']),
    collection: _collection(raw),
    similar: _related(raw?.similar?.results, type),
    recommendations: _related(raw?.recommendations?.results, type),
  }
}

// ---------------------------------------------------------------------------
// Hero art: title logos and textless backdrops (images append).
// ---------------------------------------------------------------------------

function _imageAt(base, path) {
  return typeof path === 'string' && path.length ? `${base}${path}` : null
}

// The Godfather alone carries 84 logos, so "the first one" is not a choice, it
// is a coin toss between a clean English wordmark and a Hungarian VHS scan.
// The ranking below is deliberate, outermost key first:
//
// 1. Language. A logo in the language you asked for beats everything; English
//    is the fallback because most title art is designed in it; `null` (no
//    language) is next because those are usually the pure graphic marks. Any
//    other language is last resort — a Japanese wordmark on an English hero is
//    worse than a slightly small English one, so language outranks size.
// 2. Format. PNG over SVG. TMDB's SVG logos routinely depend on embedded or
//    referenced fonts and render blank or mis-kerned in Chromium, and they
//    report width/height of 0, so the hero cannot reserve layout for them.
//    A PNG is a known quantity at a known size. SVG is kept only as a last
//    resort so a title whose only art is vector still gets a hero.
// 3. Size. 800-1920px wide is the sweet spot: sharp on a 2x hero without being
//    a 4000px poster rip full of scan artefacts. Under 400px goes soft when
//    scaled up, so it ranks below the oversized ones.
// 4. Then TMDB's own vote_average, then the wider file.
const _LOGO_SVG = /\.svg$/i

function _langBand(iso, lang) {
  const want = typeof lang === 'string' && lang ? lang : 'en'
  if (iso === want) return 0
  if (iso === 'en') return 1
  if (iso == null) return 2
  return 3
}

function _sizeBand(width) {
  const w = Number(width) || 0
  if (w >= 800 && w <= 1920) return 0
  if (w > 1920) return 1
  if (w >= 400) return 2
  return 3
}

function _artEntry(base, img) {
  return {
    url: _imageAt(base, img.file_path),
    path: img.file_path,
    lang: img.iso_639_1 ?? null,
    width: img.width ?? null,
    height: img.height ?? null,
    voteAverage: img.vote_average ?? null,
  }
}

function _usableImages(list) {
  return (Array.isArray(list) ? list : []).filter(i => i && typeof i.file_path === 'string' && i.file_path.length)
}

// images: the whole `images` sub-object, or the logos array directly.
// Returns null — never a half-built object — when there is nothing usable.
function pickTitleLogo(images, lang) {
  const list = _usableImages(Array.isArray(images) ? images : images && images.logos)
  if (!list.length) return null
  const scored = list.map(img => ({
    img,
    rank: [
      _langBand(img.iso_639_1 ?? null, lang),
      _LOGO_SVG.test(img.file_path) ? 1 : 0,
      _sizeBand(img.width),
    ],
  }))
  scored.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) {
      if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i]
    }
    const va = Number(a.img.vote_average) || 0, vb = Number(b.img.vote_average) || 0
    if (va !== vb) return vb - va
    return (Number(b.img.width) || 0) - (Number(a.img.width) || 0)
  })
  return _artEntry(LOGO_BASE, scored[0].img)
}

// The hero draws the title logo over the backdrop, so a backdrop that already
// has the title burned into it collides with the art. TMDB marks those with a
// language; the textless plates are the ones with `iso_639_1 === null`, and
// they are what a hero wants even when they score lower than the titled one.
function pickBackdrop(images, lang) {
  const list = _usableImages(Array.isArray(images) ? images : images && images.backdrops)
  if (!list.length) return null
  const band = img => {
    const iso = img.iso_639_1 ?? null
    if (iso == null) return 0
    if (typeof lang === 'string' && lang && iso === lang) return 1
    if (iso === 'en') return 2
    return 3
  }
  const sorted = list.slice().sort((a, b) => {
    const ba = band(a), bb = band(b)
    if (ba !== bb) return ba - bb
    const va = Number(a.vote_average) || 0, vb = Number(b.vote_average) || 0
    if (va !== vb) return vb - va
    return (Number(b.width) || 0) - (Number(a.width) || 0)
  })
  return _artEntry(BACKDROP_BASE, sorted[0])
}

// ---------------------------------------------------------------------------
// Crew
// ---------------------------------------------------------------------------

// Accepts the `credits` sub-object, a bare crew array, or a whole detail
// response — callers hold all three shapes at different points.
function _crewList(credits) {
  if (Array.isArray(credits)) return credits
  const crew = credits && (credits.crew || (credits.credits && credits.credits.crew))
  return Array.isArray(crew) ? crew : []
}

function _person(c) {
  return { id: c.id ?? null, name: c.name, job: c.job ?? null, profilePath: _image(c.profile_path) }
}

// De-duplicated by id, falling back to name when TMDB omits the id. Order is
// the credit order TMDB returned, so a co-directed film keeps both names in
// the order the billing block shows them — the Coens must not collapse to one.
function _pickJobs(credits, jobs) {
  const want = new Set(jobs)
  const seen = new Set()
  const out = []
  for (const c of _crewList(credits)) {
    if (!c || !c.name || !want.has(c.job)) continue
    const key = c.id != null ? `id:${c.id}` : `name:${c.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(_person(c))
  }
  return out
}

const CREW_JOBS = {
  directors: ['Director'],
  writers: ['Writer', 'Screenplay', 'Story', 'Teleplay', 'Author'],
  cinematographers: ['Director of Photography'],
  composers: ['Original Music Composer', 'Music'],
  editors: ['Editor'],
}

function directorsOf(credits) {
  return _pickJobs(credits, CREW_JOBS.directors)
}

// A stable five-key shape: every key is always an array, so the detail page can
// render its crew block without a null check per row.
function keyCrewOf(credits) {
  const out = {}
  for (const [key, jobs] of Object.entries(CREW_JOBS)) out[key] = _pickJobs(credits, jobs)
  return out
}

// ---------------------------------------------------------------------------
// Certification
// ---------------------------------------------------------------------------

// Reads both TMDB shapes: movie `release_dates` ({results:[{iso_3166_1,
// release_dates:[{certification,type}]}]}) and tv `content_ratings`
// ({results:[{iso_3166_1,rating}]}).
function _certOfEntry(entry) {
  if (!entry) return null
  if (typeof entry.rating === 'string' && entry.rating.trim()) return entry.rating.trim()
  const list = Array.isArray(entry.release_dates) ? entry.release_dates : []
  // Prefer the theatrical rating (type 3): a director's cut can carry a later
  // re-rating that is not the one on the poster.
  const theatrical = list.find(r => r && r.type === 3 && typeof r.certification === 'string' && r.certification.trim())
  const any = list.find(r => r && typeof r.certification === 'string' && r.certification.trim())
  const cert = (theatrical || any || {}).certification
  return cert && cert.trim() ? cert.trim() : null
}

// Fallback chain: the region asked for, then US, then GB, then any region that
// actually has one — a film with no US release should still show its BBFC or
// its home certificate rather than nothing. An empty string is never returned:
// TMDB fills unrated regions with "", and "" rendered as a certificate badge is
// an empty box the user cannot explain.
function certificationFor(releaseDates, region) {
  const results = releaseDates && releaseDates.results
  if (!Array.isArray(results) || !results.length) return null
  const order = []
  for (const code of [region, 'US', 'GB']) {
    if (typeof code === 'string' && code && !order.includes(code)) order.push(code)
  }
  for (const code of order) {
    const cert = _certOfEntry(results.find(r => r && r.iso_3166_1 === code))
    if (cert) return cert
  }
  for (const entry of results) {
    const cert = _certOfEntry(entry)
    if (cert) return cert
  }
  return null
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

// The two media types disagree: a movie's appended keywords land at
// `keywords.keywords`, a series' at `keywords.results`. Both are read here so
// one thematic-shelf path serves film and television.
function keywordsOf(raw) {
  const k = raw && raw.keywords
  const list = Array.isArray(raw) ? raw
    : Array.isArray(k) ? k
      : Array.isArray(k && k.keywords) ? k.keywords
        : Array.isArray(k && k.results) ? k.results
          : Array.isArray(raw && raw.results) ? raw.results
            : []
  const seen = new Set()
  const out = []
  for (const item of list) {
    const name = typeof item === 'string' ? item : item && item.name
    if (!name) continue
    const id = (item && typeof item === 'object' ? item.id : null) ?? null
    const key = id != null ? `id:${id}` : `name:${name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id, name })
  }
  return out
}

// Fields that only exist when the richer append list was requested
// (buildAppendedDetailUrl). They are added only when their sub-object is
// actually present, so an entry built from a trending/search payload keeps the
// exact shape it has always had rather than growing a row of empty keys.
function _appended(raw, lang) {
  const out = {}
  if (raw && raw.images && typeof raw.images === 'object') {
    out.logo = pickTitleLogo(raw.images, lang)
    out.backdropTextless = pickBackdrop(raw.images, lang)
  }
  if (raw && raw.credits && Array.isArray(raw.credits.crew)) {
    out.directors = directorsOf(raw.credits)
    out.keyCrew = keyCrewOf(raw.credits)
  }
  if (raw && raw.keywords && typeof raw.keywords === 'object') {
    out.keywords = keywordsOf(raw)
  }
  return out
}

function normalizeMovie(raw) {
  raw = raw || {}
  return {
    id: raw.id ?? null,
    type: 'movie',
    title: raw.title ?? null,
    year: _year(raw.release_date),
    poster: _image(raw.poster_path),
    backdrop: _image(raw.backdrop_path),
    overview: raw.overview ?? null,
    rating: raw.vote_average ?? null,
    genres: _genres(raw),
    imdbId: _imdbId(raw),
    // Anime films are anime. Without this they route to the film indexers,
    // which carry no dub and none of nyaa's releases.
    originalName: raw.original_title ?? null,
    originalLanguage: raw.original_language ?? null,
    isAnime: _isAnime(raw),
    runtime: raw.runtime ?? null,
    tagline: raw.tagline ?? null,
    certification: certificationFor(raw.release_dates, 'US'),
    ..._extras(raw, 'movie'),
    ..._appended(raw, raw.original_language),
  }
}

function _guestStars(list) {
  if (!Array.isArray(list)) return []
  return list
    .map(g => g && { id: g.id ?? null, name: g.name ?? null, character: g.character ?? null, profilePath: _image(g.profile_path) })
    .filter(g => g && g.name)
}

function normalizeEpisode(raw) {
  raw = raw || {}
  return {
    episodeNumber: raw.episode_number ?? null,
    name: raw.name ?? null,
    overview: raw.overview ?? null,
    still: _image(raw.still_path),
    airDate: raw.air_date ?? null,
    runtime: raw.runtime ?? null,
    rating: raw.vote_average ?? null,
    guestStars: _guestStars(raw.guest_stars),
  }
}

function normalizeSeason(raw) {
  raw = raw || {}
  return {
    seasonNumber: raw.season_number ?? null,
    name: raw.name ?? null,
    episodeCount: raw.episode_count ?? null,
    episodes: Array.isArray(raw.episodes) ? raw.episodes.map(normalizeEpisode) : [],
  }
}

function normalizeTv(raw) {
  raw = raw || {}
  const entry = {
    id: raw.id ?? null,
    type: 'tv',
    title: raw.name ?? null,
    year: _year(raw.first_air_date),
    poster: _image(raw.poster_path),
    backdrop: _image(raw.backdrop_path),
    overview: raw.overview ?? null,
    rating: raw.vote_average ?? null,
    genres: _genres(raw),
    imdbId: _imdbId(raw),
    // TMDB files anime as ordinary television, so a search for an anime title
    // returns a tv entry alongside AniList's. Routed as tv its sources come
    // from the TV indexer, which barely carries anime — the same show opened
    // from the Anime tab gets nyaa and a far better list. Flagging it here lets
    // the source router treat it as what it is, whichever entry was opened.
    originalName: raw.original_name ?? null,
    originalLanguage: raw.original_language ?? null,
    isAnime: _isAnime(raw),
    // A show has no single runtime; TMDB reports episode_run_time as an array.
    // The first entry is the representative number for the hero's "· 47m".
    runtime: (Array.isArray(raw.episode_run_time) && raw.episode_run_time.length) ? raw.episode_run_time[0] : null,
    tagline: raw.tagline ?? null,
    // TV certification comes from content_ratings, not release_dates; the
    // helper reads either shape (see video-format.certification).
    certification: certificationFor(raw.content_ratings, 'US'),
    ..._extras(raw, 'tv'),
    ..._appended(raw, raw.original_language),
  }
  if (Array.isArray(raw.seasons)) entry.seasons = raw.seasons.map(normalizeSeason)
  return entry
}

function normalizePerson(raw) {
  if (!raw || raw.id == null) return null
  return {
    id: raw.id,
    type: 'person',
    title: raw.name ?? null,
    poster: _image(raw.profile_path),
    department: raw.known_for_department ?? null,
    // The titles TMDB considers this person best known for — enough to tell
    // two actors with the same name apart without a second request.
    knownFor: (raw.known_for || [])
      .map(k => (k && k.media_type === 'tv' ? k.name : k && k.title))
      .filter(Boolean).slice(0, 3),
  }
}

// Japanese animation. TMDB has no anime flag, but genre 16 is Animation and
// the original language and origin country settle the rest. Deliberately
// narrow: a French cartoon is animation, not anime, and routing it to an
// anime indexer would find nothing.
const TMDB_ANIMATION_GENRE = 16

function _isAnime(raw) {
  if (!raw) return false
  const ids = Array.isArray(raw.genres)
    ? raw.genres.map(g => (g && typeof g === 'object' ? g.id : g))
    : (Array.isArray(raw.genre_ids) ? raw.genre_ids : [])
  if (!ids.includes(TMDB_ANIMATION_GENRE)) return false
  if (raw.original_language === 'ja') return true
  return Array.isArray(raw.origin_country) && raw.origin_country.includes('JP')
}

function normalizeSearchResult(raw) {
  if (!raw || (raw.media_type !== 'movie' && raw.media_type !== 'tv')) return null
  const isTv = raw.media_type === 'tv'
  const date = isTv ? raw.first_air_date : raw.release_date
  return {
    id: raw.id ?? null,
    type: raw.media_type,
    title: (isTv ? raw.name : raw.title) ?? null,
    year: _year(date),
    poster: _image(raw.poster_path),
    // search/multi returns genre_ids rather than genres, which _isAnime reads
    // too. Carried so a merged search can tell a tv entry that is really anime
    // from one that is not, without a second request per result.
    // A film uses original_title where a series uses original_name.
    originalName: (isTv ? raw.original_name : raw.original_title) ?? null,
    // Anime films — Jujutsu Kaisen 0, Suzume, A Silent Voice — are just as
    // much anime as the series, and restricting this to television left them
    // routed to the film indexers with no dub and no nyaa.
    isAnime: _isAnime(raw),
  }
}

// Pure URL builders. The `api_key` query param is appended by the caller
// (the fetch shell), never baked in here.
function buildTrendingUrl(kind, opts = {}) {
  const timeWindow = opts.timeWindow || 'week'
  let url = `${TMDB_BASE}/trending/${kind}/${timeWindow}`
  if (opts.page != null) url += `?page=${opts.page}`
  return url
}

function buildPopularUrl(kind, opts = {}) {
  let url = `${TMDB_BASE}/${kind}/popular`
  if (opts.page != null) url += `?page=${opts.page}`
  return url
}

function buildSearchUrl(query, opts = {}) {
  let url = `${TMDB_BASE}/search/multi?query=${encodeURIComponent(query)}`
  if (opts.page != null) url += `&page=${opts.page}`
  return url
}

// The detail sub-requests, per media type. `release_dates` is a movie concept;
// TV certification lives in `content_ratings`. Asking TMDB for the wrong one is
// a 422 that would break every detail page of that type, so the two lists differ.
const MOVIE_APPEND = 'credits,videos,similar,recommendations,release_dates,external_ids,watch/providers'
const TV_APPEND = 'credits,videos,similar,recommendations,content_ratings,external_ids,watch/providers'

// The discover endpoint is what makes real browsing possible: everything the
// catalog rows do is a fixed slice of it. Params are whitelisted rather than
// passed through, so a UI bug cannot send arbitrary query keys to TMDB.
//
// TMDB names differ per media type — a movie has primary_release_date and a
// series has first_air_date — so the caller passes neutral names and the
// mapping happens here.
const SORTS = {
  popularity: 'popularity.desc',
  rating: 'vote_average.desc',
  newest: 'primary_release_date.desc',
  oldest: 'primary_release_date.asc',
  title: 'title.asc',
  revenue: 'revenue.desc',
}

const TV_SORTS = {
  popularity: 'popularity.desc',
  rating: 'vote_average.desc',
  newest: 'first_air_date.desc',
  oldest: 'first_air_date.asc',
  title: 'name.asc',
  revenue: 'popularity.desc',
}

function buildDiscoverUrl(kind, opts = {}) {
  const isTv = kind === 'tv'
  const q = []
  const push = (k, v) => { if (v != null && v !== '') q.push(`${k}=${encodeURIComponent(v)}`) }

  push('page', opts.page || 1)
  push('sort_by', (isTv ? TV_SORTS : SORTS)[opts.sort] || (isTv ? TV_SORTS : SORTS).popularity)
  if (Array.isArray(opts.genres) && opts.genres.length) push('with_genres', opts.genres.join(','))
  if (Array.isArray(opts.excludeGenres) && opts.excludeGenres.length) push('without_genres', opts.excludeGenres.join(','))
  push(isTv ? 'first_air_date.gte' : 'primary_release_date.gte', opts.yearFrom ? `${opts.yearFrom}-01-01` : null)
  push(isTv ? 'first_air_date.lte' : 'primary_release_date.lte', opts.yearTo ? `${opts.yearTo}-12-31` : null)
  push('vote_average.gte', opts.minRating)
  push('with_original_language', opts.language)
  push('with_runtime.gte', opts.runtimeFrom)
  push('with_runtime.lte', opts.runtimeTo)
  push('with_watch_providers', opts.provider)
  push('with_keywords', opts.keyword)
  push('with_people', Array.isArray(opts.people) && opts.people.length ? opts.people.join(',') : null)
  // A rating sort with no vote floor surfaces titles with three votes and a
  // perfect score, which is noise rather than a recommendation.
  if (opts.sort === 'rating') push('vote_count.gte', opts.minVotes != null ? opts.minVotes : 200)
  if (opts.includeAdult !== true) push('include_adult', 'false')

  return `${TMDB_BASE}/discover/${isTv ? 'tv' : 'movie'}?${q.join('&')}`
}

function buildGenresUrl(kind) {
  return `${TMDB_BASE}/genre/${kind === 'tv' ? 'tv' : 'movie'}/list`
}

function buildPersonSearchUrl(query, opts = {}) {
  let url = `${TMDB_BASE}/search/person?query=${encodeURIComponent(query)}`
  if (opts.page != null) url += `&page=${opts.page}`
  return url
}

function buildPersonCreditsUrl(personId) {
  return `${TMDB_BASE}/person/${personId}/combined_credits`
}

function buildCollectionUrl(collectionId) {
  return `${TMDB_BASE}/collection/${collectionId}`
}

function buildDetailUrl(type, id) {
  const append = type === 'tv' ? TV_APPEND : MOVIE_APPEND
  return `${TMDB_BASE}/${type}/${id}?append_to_response=${append}`
}

// The cinephile detail request. `keywords` powers the thematic shelves,
// `images` the logo hero, and both arrive in the same round-trip as the credits
// — a second request per detail page would double the latency of every open.
// include_image_language is not optional: without it TMDB returns only art in
// the title's original language, so an English hero for a Japanese film gets no
// logo at all. `null` asks for the textless plates the hero backdrop needs.
const MOVIE_APPEND_FULL = `${MOVIE_APPEND},keywords,images`
const TV_APPEND_FULL = `${TV_APPEND},keywords,images`

function buildAppendedDetailUrl(type, id, opts = {}) {
  const isTv = type === 'tv'
  const lang = typeof opts.lang === 'string' && opts.lang ? opts.lang : 'en'
  const langs = [lang, 'en', 'null'].filter((v, i, a) => a.indexOf(v) === i).join(',')
  return `${TMDB_BASE}/${isTv ? 'tv' : 'movie'}/${id}` +
    `?append_to_response=${isTv ? TV_APPEND_FULL : MOVIE_APPEND_FULL}` +
    `&include_image_language=${langs}`
}

function buildSeasonUrl(tvId, n) {
  return `${TMDB_BASE}/tv/${tvId}/season/${n}`
}

function createTmdbCatalog({ apiKey, fetchFn } = {}) {
  const fetcher = fetchFn || fetch

  async function _fetch(url) {
    const sep = url.includes('?') ? '&' : '?'
    const key = typeof apiKey === 'function' ? apiKey() : apiKey
    const full = key ? `${url}${sep}api_key=${key}` : url
    const res = await fetcher(full)
    if (!res || !res.ok) {
      const status = res && res.status != null ? res.status : 'unknown'
      if (status === 401) throw new Error('Invalid or missing TMDB API key (401)')
      throw new Error(`TMDB request failed (${status})`)
    }
    return res.json()
  }

  return {
    async trending(kind, page) {
      const data = await _fetch(buildTrendingUrl(kind, { page }))
      const norm = kind === 'tv' ? normalizeTv : normalizeMovie
      return (data.results || []).map(norm)
    },
    async popular(kind, page) {
      const data = await _fetch(buildPopularUrl(kind, { page }))
      const norm = kind === 'tv' ? normalizeTv : normalizeMovie
      return (data.results || []).map(norm)
    },
    async search(query, page) {
      const data = await _fetch(buildSearchUrl(query, { page }))
      return (data.results || []).map(normalizeSearchResult).filter(Boolean)
    },
    async detail(type, id, opts) {
      const data = await _fetch(buildAppendedDetailUrl(type, id, opts))
      return type === 'tv' ? normalizeTv(data) : normalizeMovie(data)
    },
    async discover(kind, opts) {
      const data = await _fetch(buildDiscoverUrl(kind, opts))
      const norm = kind === 'tv' ? normalizeTv : normalizeMovie
      return {
        results: (data.results || []).map(norm),
        page: data.page || 1,
        totalPages: data.total_pages || 1,
        totalResults: data.total_results || 0,
      }
    },
    async genres(kind) {
      const data = await _fetch(buildGenresUrl(kind))
      return (data.genres || []).filter(g => g && g.id != null && g.name)
        .map(g => ({ id: g.id, name: g.name }))
    },
    async searchPeople(query, page) {
      const data = await _fetch(buildPersonSearchUrl(query, { page }))
      return (data.results || []).map(normalizePerson).filter(Boolean)
    },
    async personCredits(personId) {
      const data = await _fetch(buildPersonCreditsUrl(personId))
      const cast = Array.isArray(data.cast) ? data.cast : []
      const crew = Array.isArray(data.crew) ? data.crew : []
      // One person can appear many times on the same title (writer and
      // director, or a recurring role); the filmography wants each title once.
      const seen = new Set()
      const out = []
      for (const raw of cast.concat(crew)) {
        const type = raw && raw.media_type
        if (type !== 'movie' && type !== 'tv') continue
        const key = type + ':' + raw.id
        if (seen.has(key)) continue
        seen.add(key)
        out.push(type === 'tv' ? normalizeTv(raw) : normalizeMovie(raw))
      }
      return out.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0))
    },
    async collection(collectionId) {
      const data = await _fetch(buildCollectionUrl(collectionId))
      return {
        id: data.id ?? null,
        name: data.name ?? null,
        overview: data.overview ?? null,
        poster: _image(data.poster_path),
        backdrop: _image(data.backdrop_path),
        parts: (data.parts || []).map(normalizeMovie)
          .sort((a, b) => (Number(a.year) || 0) - (Number(b.year) || 0)),
      }
    },
    async season(tvId, n) {
      const data = await _fetch(buildSeasonUrl(tvId, n))
      return normalizeSeason(data)
    },
  }
}

module.exports = {
  _trailers,
  pickTitleLogo,
  pickBackdrop,
  directorsOf,
  keyCrewOf,
  CREW_JOBS,
  certificationFor,
  keywordsOf,
  buildAppendedDetailUrl,
  MOVIE_APPEND_FULL,
  TV_APPEND_FULL,
  _isAnime,
  TMDB_ANIMATION_GENRE,
  SORTS,
  TV_SORTS,
  buildDiscoverUrl,
  buildGenresUrl,
  buildPersonSearchUrl,
  buildPersonCreditsUrl,
  buildCollectionUrl,
  normalizePerson,
  normalizeMovie,
  normalizeTv,
  normalizeSeason,
  normalizeEpisode,
  normalizeSearchResult,
  buildTrendingUrl,
  buildPopularUrl,
  buildSearchUrl,
  buildDetailUrl,
  buildSeasonUrl,
  createTmdbCatalog,
  MOVIE_APPEND,
  TV_APPEND,
}
