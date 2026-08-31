'use strict'
// Curated shelves for the Movies & TV home tab — pure definitions and URL
// builders over TMDB's discover endpoint. No I/O of its own: a shelf is a
// label, a note and a URL, and the caller fetches it with an injectable
// fetchFn. Nothing here throws; a shelf that cannot be described honestly is
// simply absent.
//
// Every keyword and company id below was checked against the live API. Ids
// that could not be verified were left out rather than guessed — a shelf that
// silently returns nothing is worse than a shelf that was never offered.

const TMDB_BASE = 'https://api.themoviedb.org/3'

// A rating sort with no vote floor is not a ranking, it is a list of accidents:
// three people who loved an obscure short outrank The Godfather. Verified on
// Kurosawa's crew filmography, which without a floor leads with "Enoken's
// Surprising Life" instead of Seven Samurai. Every shelf that sorts by rating
// therefore carries a floor, and the floor is tuned to how deep the pool is —
// a national cinema or a small movement cannot clear the canon's 5000.
const FLOOR = {
  canon: 5000,
  decade: 1000,
  director: 100,
  movement: 100,
  theme: 500,
  country: 150,
  anniversary: 1000,
  runtime: 1000,
  gems: 1000,
}

// Hidden gems need a ceiling as well as a floor: the point is a film enough
// people have seen to trust and few enough to still be a discovery.
//
// The numbers were tuned against the live catalogue rather than reasoned about,
// because the obvious ones do not work. A floor of 300 votes is not a sample,
// it is noise, and sorting by average rating over noise returned "Accidental
// Partners" and "Facing El Chapo". Raising the floor alone then surfaced
// whatever was being hyped that month — Demon Slayer, Project Hail Mary — because
// a film's average peaks in its first weeks, before the wider audience arrives
// to pull it back down.
//
// So a gem must also have had time to settle. Excluding the last few years is
// what turned this shelf from junk into Harakiri, Seven Samurai and Cinema
// Paradiso: films that are under-voted next to blockbusters precisely because
// fewer people have found them.
const GEMS_CEILING = 4500
const GEMS_MIN_RATING = 7.5
const GEMS_SETTLE_YEARS = 3

const RATED = 'vote_average.desc'

const DOCUMENTARY_GENRE = 99
const MUSIC_GENRE = 10402

// A film's average peaks in its first weeks, before the wider audience arrives
// to pull it back down, so any shelf that ranks by rating has to exclude the
// hype window or it fills with whatever came out this month. The Japanese
// shelf opened with three current anime releases until this was applied.
const SETTLE_YEARS = 3
function _settledBefore() {
  return (new Date().getFullYear() - SETTLE_YEARS) + '-12-31'
}

// Specificity ranking, used by dedupe(). A lower number is a stronger claim on
// a title: "Kurosawa" or "neo-noir" tells you something about the film, while
// "highly rated" tells you only that it is famous. Canon is deliberately last,
// because nearly every title on the page would otherwise be swallowed by it.
const RANK = {
  director: 1,
  movement: 1,
  theme: 1,
  studio: 1,
  country: 2,
  anniversary: 2,
  runtime: 2,
  gems: 2,
  decade: 3,
  canon: 4,
}

// TMDB genre ids for formats that are not films and never will be. The
// motivating case is Tagesschau (tv/1952), the German evening news bulletin,
// which outranks most drama in "Popular TV" purely because it has aired every
// single day since 1952. Popularity is a poor proxy for "worth watching" when
// the competitor is a daily broadcast.
const NEWS_GENRE = 10763
const REALITY_GENRE = 10764
const TALK_GENRE = 10767
const NON_FILM_GENRES = [NEWS_GENRE, REALITY_GENRE, TALK_GENRE]
const NON_FILM_GENRE_NAMES = ['news', 'talk', 'reality']

function _push(q, k, v) {
  if (v == null || v === '') return
  q.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
}

// Generic discover builder. The api key is a parameter rather than module state
// so nothing here can leak it into a cached shelf definition; pass null and the
// caller's fetch shell appends its own.
function buildDiscoverUrl(baseUrl, apiKey, params) {
  const base = (typeof baseUrl === 'string' && baseUrl) ? baseUrl : TMDB_BASE
  const kind = params && params.kind === 'tv' ? 'tv' : 'movie'
  const q = []
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (k === 'kind') continue
      _push(q, k, v)
    }
  }
  // Adult titles have no business on a home page nobody opted in on.
  if (!params || params.include_adult == null) _push(q, 'include_adult', 'false')
  if (apiKey) _push(q, 'api_key', apiKey)
  return `${base}/discover/${kind}?${q.join('&')}`
}

function _shelf(key, label, note, rank, params, opts) {
  opts = opts || {}
  return {
    key,
    label,
    note,
    rank,
    url: buildDiscoverUrl(opts.baseUrl, opts.apiKey, params),
  }
}

function canon(opts) {
  return _shelf(
    'canon',
    'The Canon',
    'Rated by enough people to mean something.',
    RANK.canon,
    { sort_by: RATED, 'vote_count.gte': FLOOR.canon },
    opts
  )
}

const DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020]

// A decade shelf is only honest if it covers a decade that has actually
// happened; asking TMDB for 2030 returns an empty row with a confident label.
function decade(start, opts) {
  const n = Number(start)
  if (!DECADES.includes(n)) return null
  return _shelf(
    `decade-${n}`,
    `Best of the ${n}s`,
    `The films from ${n}–${n + 9} people still argue about.`,
    RANK.decade,
    {
      'primary_release_date.gte': `${n}-01-01`,
      'primary_release_date.lte': `${n + 9}-12-31`,
      sort_by: RATED,
      'vote_count.gte': FLOOR.decade,
    },
    opts
  )
}

function directorInFocus(personId, name, opts) {
  if (personId == null || personId === '' || !name) return null
  return _shelf(
    `director-${personId}`,
    `Director in Focus: ${name}`,
    `${name}'s films, best first — early work you have never heard of is not the way in.`,
    RANK.director,
    { with_crew: personId, sort_by: RATED, 'vote_count.gte': FLOOR.director },
    opts
  )
}

// Movements are periods, not tags. TMDB's movement keywords are thin — the
// French New Wave keyword (279111) returns five films at any usable vote floor
// and none of them are The 400 Blows — so where a keyword fails, the movement
// is defined by the window and language that actually produced it. Dogme 95 is
// the exception: it is a signed manifesto with a handful of films, so its
// keyword is exactly right and its shelf is honestly short.
const MOVEMENTS = {
  'french-new-wave': {
    label: 'French New Wave',
    note: 'Paris, 1958–1968: young critics who picked up cameras.',
    params: {
      with_original_language: 'fr',
      'primary_release_date.gte': '1958-01-01',
      'primary_release_date.lte': '1968-12-31',
    },
    floor: 200,
  },
  'new-hollywood': {
    label: 'New Hollywood',
    note: 'The decade the studios lost control and the directors won.',
    params: {
      with_origin_country: 'US',
      'primary_release_date.gte': '1967-01-01',
      'primary_release_date.lte': '1980-12-31',
    },
    floor: 1000,
  },
  'italian-neorealism': {
    label: 'Italian Neorealism',
    note: 'Postwar Italy shot in the street, mostly with people who were not actors.',
    params: {
      with_original_language: 'it',
      'primary_release_date.gte': '1943-01-01',
      'primary_release_date.lte': '1954-12-31',
    },
    floor: 100,
  },
  'dogme-95': {
    label: 'Dogme 95',
    note: 'A short list, by design — the manifesto banned almost everything.',
    params: { with_keywords: 315002 },
    floor: 100,
  },
  'japanese-golden-age': {
    label: 'Japanese Golden Age',
    note: 'Kurosawa, Ozu, Mizoguchi and the fifteen years around them.',
    params: {
      with_original_language: 'ja',
      'primary_release_date.gte': '1950-01-01',
      'primary_release_date.lte': '1965-12-31',
    },
    floor: 200,
  },
}

function movement(key, opts) {
  const m = MOVEMENTS[key]
  if (!m) return null
  return _shelf(
    `movement-${key}`,
    m.label,
    m.note,
    RANK.movement,
    { ...m.params, sort_by: RATED, 'vote_count.gte': m.floor || FLOOR.movement },
    opts
  )
}

// Verified keyword ids. "one-location" is deliberately missing: TMDB's nearest
// keywords are "single location" (368386, nothing above 100 votes) and
// "confined" (206704, two films). There is no honest way to fill that shelf, so
// it does not exist.
const THEMES = {
  'neo-noir': {
    id: 207268,
    label: 'Neo-Noir',
    note: 'Old noir moves, newer cities, worse people.',
  },
  heist: {
    id: 10051,
    label: 'The Heist',
    note: 'A plan, a crew, and the part of the plan that was always going to fail.',
  },
  'coming-of-age': {
    id: 10683,
    label: 'Coming of Age',
    note: 'The year somebody stopped being a kid.',
  },
  'unreliable-narrator': {
    id: 174089,
    label: 'Unreliable Narrator',
    note: 'Films that lie to you on purpose. Short shelf — few do it well.',
    floor: 100,
  },
}

function theme(key, opts) {
  const t = THEMES[key]
  if (!t) return null
  return _shelf(
    `theme-${key}`,
    t.label,
    t.note,
    RANK.theme,
    { with_keywords: t.id, sort_by: RATED, 'vote_count.gte': t.floor || FLOOR.theme },
    opts
  )
}

// ISO 3166-1 codes checked against with_origin_country; each returns a real
// list at the 500-vote floor.
const COUNTRIES = {
  KR: 'South Korea',
  JP: 'Japan',
  IN: 'India',
  FR: 'France',
  IT: 'Italy',
  IR: 'Iran',
  TW: 'Taiwan',
  HK: 'Hong Kong',
  MX: 'Mexico',
  DE: 'Germany',
  SE: 'Sweden',
  DK: 'Denmark',
  BR: 'Brazil',
  PL: 'Poland',
  ES: 'Spain',
  GB: 'United Kingdom',
  TH: 'Thailand',
  AR: 'Argentina',
}

function country(code, opts) {
  const name = COUNTRIES[code]
  if (!name) return null
  return _shelf(
    `country-${code}`,
    `Made in ${name}`,
    `The best-reviewed films out of ${name}.`,
    RANK.country,
    {
      with_origin_country: code,
      sort_by: RATED,
      // National cinemas are under-voted by definition on a database whose
      // users are mostly American: Kiarostami's Close-Up, one of the most
      // admired films ever made in Iran, has 458 votes. A floor set for
      // Hollywood returned five Iranian films and none of the ones a person
      // would name; at this floor it returns Close-Up, Where Is The Friend's
      // House?, A Separation and Children of Heaven.
      'vote_count.gte': FLOOR.country,
      // Which then admits concert films — the Korean shelf opened with two BTS
      // tour recordings, because their fans rate them very highly and there are
      // a lot of fans. A concert film is not a national cinema.
      without_genres: `${DOCUMENTARY_GENRE},${MUSIC_GENRE}`,
      'primary_release_date.lte': _settledBefore(),
    },
    opts
  )
}

// The films everyone means by "world cinema": the best of what was not made in
// English, from anywhere. A per-country shelf can only show you one country at a
// time and the small ones are thin; this is the shelf where Rashomon sits next
// to Parasite and Close-Up.
//
// The language list is explicit because the catalogue has no "not English"
// filter. The floor is deliberately low for a shelf ranked by rating — 400
// rather than the canon's 5000 — because the alternative excludes the very
// films the shelf exists for. Close-Up has 458 votes; Rashomon has 2588;
// Parasite has 21204. A floor that keeps the noise out also keeps Kiarostami
// out, so the rating floor does that work instead.
const WORLD_LANGUAGES = ['ja', 'fa', 'ko', 'fr', 'it', 'es', 'hi', 'zh', 'cn',
  'ru', 'sv', 'de', 'da', 'pt', 'pl', 'tr', 'th']
const WORLD_MIN_RATING = 7.8
const WORLD_MIN_VOTES = 400

function worldCinema(opts) {
  return _shelf(
    'world-cinema',
    'World Cinema',
    'The greatest films never made in English.',
    RANK.canon,
    {
      with_original_language: WORLD_LANGUAGES.join('|'),
      sort_by: RATED,
      'vote_count.gte': WORLD_MIN_VOTES,
      'vote_average.gte': WORLD_MIN_RATING,
      'primary_release_date.lte': _settledBefore(),
      without_genres: `${DOCUMENTARY_GENRE},${MUSIC_GENRE}`,
    },
    opts
  )
}

// Company ids confirmed via /company/{id}.
const STUDIOS = {
  41077: { name: 'A24', note: 'One distributor with a taste you can actually describe.' },
  10342: { name: 'Studio Ghibli', note: 'Everything they made, best first.' },
  3: { name: 'Pixar', note: 'The whole run, ranked — including the ones nobody defends.' },
}

function studio(id, opts) {
  const s = STUDIOS[id]
  if (!s) return null
  return _shelf(
    `studio-${id}`,
    s.name,
    s.note,
    RANK.studio,
    { with_companies: id, sort_by: RATED, 'vote_count.gte': FLOOR.gems },
    opts
  )
}

// A gem needs a ceiling as well as a floor. Without the ceiling this shelf is
// just the canon again; without the floor it is whatever four people rated 10.
function hiddenGems(opts) {
  return _shelf(
    'hidden-gems',
    'Hidden Gems',
    'Seen by enough people to trust, few enough to still be a find.',
    RANK.gems,
    {
      sort_by: RATED,
      'vote_average.gte': GEMS_MIN_RATING,
      'vote_count.gte': FLOOR.gems,
      'vote_count.lte': GEMS_CEILING,
      'primary_release_date.lte': (new Date().getFullYear() - GEMS_SETTLE_YEARS) + '-12-31',
    },
    opts
  )
}

function anniversary(yearsAgo, opts) {
  const n = Number(yearsAgo)
  if (!Number.isFinite(n) || n <= 0) return null
  const year = new Date().getFullYear() - Math.floor(n)
  return _shelf(
    `anniversary-${Math.floor(n)}`,
    `${Math.floor(n)} Years On`,
    `Released in ${year}, and holding up.`,
    RANK.anniversary,
    {
      'primary_release_date.gte': `${year}-01-01`,
      'primary_release_date.lte': `${year}-12-31`,
      sort_by: RATED,
      'vote_count.gte': FLOOR.anniversary,
    },
    opts
  )
}

// The lower bound exists because with_runtime.lte alone sweeps in TV specials,
// concert films and titles whose runtime TMDB simply does not know (stored as
// 0, which is <= 90).
const SHORT_RUNTIME_MIN = 60

function runtimeUnder(minutes, opts) {
  const n = Number(minutes)
  if (!Number.isFinite(n) || n <= SHORT_RUNTIME_MIN) return null
  return _shelf(
    `runtime-under-${n}`,
    `Under ${n} Minutes`,
    'For a night where you are already half asleep.',
    RANK.runtime,
    {
      'with_runtime.gte': SHORT_RUNTIME_MIN,
      'with_runtime.lte': n,
      sort_by: RATED,
      'vote_count.gte': FLOOR.runtime,
    },
    opts
  )
}

function runtimeOver(minutes, opts) {
  const n = Number(minutes)
  if (!Number.isFinite(n) || n <= 0) return null
  return _shelf(
    `runtime-over-${n}`,
    `Clear the Evening`,
    `${n} minutes and up. Eat first.`,
    RANK.runtime,
    { 'with_runtime.gte': n, sort_by: RATED, 'vote_count.gte': FLOOR.runtime },
    opts
  )
}

function _genreIds(item) {
  if (Array.isArray(item?.genre_ids)) return item.genre_ids
  if (Array.isArray(item?.genres)) {
    return item.genres.map(g => (g && typeof g === 'object' ? g.id : g))
  }
  return []
}

function isLowQualityForFilmShelf(item) {
  if (!item || typeof item !== 'object') return true
  for (const id of _genreIds(item)) {
    if (NON_FILM_GENRES.includes(Number(id))) return true
  }
  // Normalised entries carry genre names rather than ids (see tmdb._genres),
  // so the same check has to work on strings.
  const names = Array.isArray(item.genres) ? item.genres : []
  for (const g of names) {
    const name = typeof g === 'string' ? g : (g && g.name)
    if (typeof name === 'string' && NON_FILM_GENRE_NAMES.includes(name.trim().toLowerCase())) return true
  }
  return false
}

function _itemKey(item) {
  if (!item || item.id == null) return null
  return `${item.type || 'movie'}:${item.id}`
}

// A title appears once per page. Precedence is by shelf.rank — the more
// specific claim keeps it — and ties are broken by the order the caller passed,
// so a hand-ordered page stays in the order it was written. Shelves left empty
// by deduping are dropped: an empty row reads as a bug, not as an editorial
// choice.
function dedupe(shelves) {
  if (!Array.isArray(shelves)) return []
  const ordered = shelves
    .map((s, i) => ({ s, i }))
    .filter(e => e.s && typeof e.s === 'object')
    .sort((a, b) => {
      const ra = Number.isFinite(a.s.rank) ? a.s.rank : Number.MAX_SAFE_INTEGER
      const rb = Number.isFinite(b.s.rank) ? b.s.rank : Number.MAX_SAFE_INTEGER
      return ra === rb ? a.i - b.i : ra - rb
    })

  const seen = new Set()
  const kept = new Map()
  for (const { s, i } of ordered) {
    const items = Array.isArray(s.items) ? s.items : []
    const out = []
    for (const item of items) {
      const key = _itemKey(item)
      if (key == null || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
    if (out.length) kept.set(i, { ...s, items: out })
  }

  return shelves.map((s, i) => kept.get(i)).filter(Boolean)
}

module.exports = {
  TMDB_BASE,
  FLOOR,
  GEMS_CEILING,
  GEMS_MIN_RATING,
  GEMS_SETTLE_YEARS,
  RANK,
  DECADES,
  MOVEMENTS,
  THEMES,
  STUDIOS,
  COUNTRIES,
  NON_FILM_GENRES,
  NEWS_GENRE,
  REALITY_GENRE,
  TALK_GENRE,
  buildDiscoverUrl,
  canon,
  decade,
  directorInFocus,
  movement,
  theme,
  country,
  studio,
  hiddenGems,
  worldCinema,
  WORLD_LANGUAGES,
  WORLD_MIN_RATING,
  WORLD_MIN_VOTES,
  SETTLE_YEARS,
  anniversary,
  runtimeUnder,
  runtimeOver,
  dedupe,
  isLowQualityForFilmShelf,
}
