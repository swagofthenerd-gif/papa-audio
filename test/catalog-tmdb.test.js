'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
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
} = require('../catalog/tmdb')

const IMG = 'https://image.tmdb.org/t/p/w500'

// The extras a detail entry always carries, empty when TMDB sent nothing.
const NO_EXTRAS = {
  cast: [], crew: [], trailers: [], studios: [], languages: [],
  providers: null, collection: null, similar: [], recommendations: [],
}

test('normalizeMovie maps a raw movie to a catalog entry', () => {
  const raw = {
    id: 101,
    title: 'Inception',
    release_date: '2010-07-16',
    poster_path: '/abc.jpg',
    backdrop_path: '/back.jpg',
    overview: 'A thief who steals secrets.',
    vote_average: 8.3,
    genre_ids: [28, 12],
  }
  assert.deepStrictEqual(normalizeMovie(raw), {
    id: 101,
    type: 'movie',
    title: 'Inception',
    year: '2010',
    poster: `${IMG}/abc.jpg`,
    backdrop: `${IMG}/back.jpg`,
    overview: 'A thief who steals secrets.',
    rating: 8.3,
    genres: [],
    imdbId: null,
    runtime: null,
    tagline: null,
    certification: null,
    ...NO_EXTRAS,
  })
})

test('normalizeMovie nulls missing fields', () => {
  const e = normalizeMovie({ id: 5 })
  assert.strictEqual(e.id, 5)
  assert.strictEqual(e.type, 'movie')
  assert.strictEqual(e.title, null)
  assert.strictEqual(e.year, null)
  assert.strictEqual(e.poster, null)
  assert.strictEqual(e.backdrop, null)
  assert.strictEqual(e.overview, null)
  assert.strictEqual(e.rating, null)
  assert.deepStrictEqual(e.genres, [])
  assert.strictEqual(e.runtime, null)
  assert.strictEqual(e.certification, null)
  assert.deepStrictEqual(e.cast, [])
})

test('normalizeMovie maps genres from raw.genres names', () => {
  const e = normalizeMovie({
    id: 1,
    title: 'X',
    genres: [{ id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }],
  })
  assert.deepStrictEqual(e.genres, ['Action', 'Adventure'])
})

test('normalizeMovie extracts runtime, tagline and certification', () => {
  const e = normalizeMovie({
    id: 1, title: 'X', runtime: 148, tagline: 'Your mind is the scene of the crime.',
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', type: 3 }] }] },
  })
  assert.strictEqual(e.runtime, 148)
  assert.strictEqual(e.tagline, 'Your mind is the scene of the crime.')
  assert.strictEqual(e.certification, 'PG-13')
})

test('normalizeMovie maps cast, crew, trailers, studios, languages, providers', () => {
  const e = normalizeMovie({
    id: 1, title: 'X',
    credits: {
      cast: [{ id: 2, name: 'Actor', character: 'Role', profile_path: '/c.jpg', order: 0 }],
      crew: [{ id: 3, name: 'Director', job: 'Director', department: 'Directing' }],
    },
    videos: { results: [
      { key: 'k1', name: 'Trailer', site: 'YouTube', type: 'Trailer' },
      { key: 'k2', name: 'Teaser', site: 'YouTube', type: 'Teaser' },
    ] },
    production_companies: [{ name: 'Warner Bros.' }],
    spoken_languages: [{ english_name: 'English' }],
    'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Netflix' }] } } },
    belongs_to_collection: { id: 9, name: 'Saga', poster_path: '/p.jpg', backdrop_path: '/b.jpg' },
    similar: { results: [{ id: 7, title: 'S', release_date: '2012-01-01', poster_path: '/s.jpg' }] },
    recommendations: { results: [{ id: 8, title: 'R', release_date: '2013-01-01' }] },
  })
  assert.deepStrictEqual(e.cast, [{ id: 2, name: 'Actor', character: 'Role', job: null, department: null, profilePath: `${IMG}/c.jpg`, order: 0 }])
  assert.strictEqual(e.crew[0].name, 'Director')
  assert.strictEqual(e.crew[0].job, 'Director')
  // Teasers are kept now as a fallback for titles that have no trailer, ranked
  // below real trailers rather than discarded.
  assert.deepStrictEqual(e.trailers.map(t => t.key), ['k1', 'k2'])
  assert.deepStrictEqual(e.trailers[0], {
    key: 'k1', name: 'Trailer', site: 'YouTube', type: 'Trailer',
    size: null, official: false, publishedAt: null,
  })
  assert.deepStrictEqual(e.studios, ['Warner Bros.'])
  assert.deepStrictEqual(e.languages, ['English'])
  assert.deepStrictEqual(e.providers, { US: { flatrate: ['Netflix'] } })
  assert.deepStrictEqual(e.collection, { id: 9, name: 'Saga', poster: `${IMG}/p.jpg`, backdrop: `${IMG}/b.jpg` })
  assert.strictEqual(e.similar.length, 1)
  assert.strictEqual(e.similar[0].type, 'movie')
  assert.strictEqual(e.recommendations[0].id, 8)
})

test('normalizeTv uses name and first_air_date', () => {
  const e = normalizeTv({ id: 9, name: 'Breaking Bad', first_air_date: '2008-01-20', poster_path: '/p.jpg' })
  assert.strictEqual(e.type, 'tv')
  assert.strictEqual(e.title, 'Breaking Bad')
  assert.strictEqual(e.year, '2008')
  assert.strictEqual(e.poster, `${IMG}/p.jpg`)
})

test('normalizeTv maps episode_run_time and content_ratings certification', () => {
  const e = normalizeTv({
    id: 9, name: 'BB', first_air_date: '2008-01-20',
    episode_run_time: [47, 55],
    content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
  })
  assert.strictEqual(e.runtime, 47)
  assert.strictEqual(e.certification, 'TV-MA')
})

test('normalizeTv includes seasons only when raw.seasons present, via normalizeSeason', () => {
  const raw = {
    id: 9,
    name: 'BB',
    first_air_date: '2008-01-20',
    seasons: [
      {
        season_number: 1,
        name: 'Season 1',
        episode_count: 2,
        episodes: [
          { episode_number: 1, name: 'Pilot', overview: 'o', still_path: '/s.jpg', air_date: '2008-01-20', runtime: 58, vote_average: 8.5, guest_stars: [{ name: 'G', character: 'C', profile_path: '/g.jpg' }] },
        ],
      },
    ],
  }
  const e = normalizeTv(raw)
  assert.strictEqual(e.seasons.length, 1)
  assert.strictEqual(e.seasons[0].seasonNumber, 1)
  assert.strictEqual(e.seasons[0].name, 'Season 1')
  assert.strictEqual(e.seasons[0].episodeCount, 2)
  const ep = e.seasons[0].episodes[0]
  assert.strictEqual(ep.episodeNumber, 1)
  assert.strictEqual(ep.name, 'Pilot')
  assert.strictEqual(ep.still, `${IMG}/s.jpg`)
  assert.strictEqual(ep.airDate, '2008-01-20')
  assert.strictEqual(ep.runtime, 58)
  assert.strictEqual(ep.rating, 8.5)
  assert.deepStrictEqual(ep.guestStars, [{ id: null, name: 'G', character: 'C', profilePath: `${IMG}/g.jpg` }])
})

test('normalizeEpisode drops nothing now: runtime, rating and guest stars survive', () => {
  const e = normalizeEpisode({ episode_number: 1, name: 'E', runtime: 47, vote_average: 7.9, guest_stars: [] })
  assert.strictEqual(e.runtime, 47)
  assert.strictEqual(e.rating, 7.9)
  assert.deepStrictEqual(e.guestStars, [])
})

test('normalizeTv omits seasons when absent', () => {
  const e = normalizeTv({ id: 9, name: 'BB', first_air_date: '2008-01-20' })
  assert.ok(!('seasons' in e))
})

test('normalizeSeason maps season fields', () => {
  assert.deepStrictEqual(
    normalizeSeason({ season_number: 3, name: 'Final', episode_count: 16, episodes: [] }),
    { seasonNumber: 3, name: 'Final', episodeCount: 16, episodes: [] }
  )
})

test('normalizeSearchResult handles movie/tv and ignores others', () => {
  assert.deepStrictEqual(
    normalizeSearchResult({ media_type: 'movie', id: 1, title: 'M', release_date: '2020-05-05', poster_path: '/p.jpg' }),
    // originalName and isAnime ride along so a merged search can spot the
    // duplicate an anime title produces across the two catalogs.
    { id: 1, type: 'movie', title: 'M', year: '2020', poster: `${IMG}/p.jpg`,
      originalName: null, isAnime: false }
  )
  assert.deepStrictEqual(
    normalizeSearchResult({ media_type: 'tv', id: 2, name: 'T', first_air_date: '2021-06-06', poster_path: null }),
    { id: 2, type: 'tv', title: 'T', year: '2021', poster: null,
      originalName: null, isAnime: false }
  )
  assert.strictEqual(normalizeSearchResult({ media_type: 'person', id: 3 }), null)
  assert.strictEqual(normalizeSearchResult(null), null)
})

test('URL builders produce exact strings', () => {
  assert.strictEqual(buildTrendingUrl('movie'), 'https://api.themoviedb.org/3/trending/movie/week')
  assert.strictEqual(buildTrendingUrl('tv', { timeWindow: 'day' }), 'https://api.themoviedb.org/3/trending/tv/day')
  assert.strictEqual(buildPopularUrl('movie'), 'https://api.themoviedb.org/3/movie/popular')
  assert.strictEqual(buildPopularUrl('tv'), 'https://api.themoviedb.org/3/tv/popular')
  assert.strictEqual(buildSearchUrl('inception'), 'https://api.themoviedb.org/3/search/multi?query=inception')
  assert.strictEqual(buildSearchUrl('breaking bad'), 'https://api.themoviedb.org/3/search/multi?query=breaking%20bad')
  // The detail request bundles all the sub-objects the page renders, so one
  // round-trip carries cast, trailers, certification and the rest.
  assert.strictEqual(buildDetailUrl('movie', 101), `https://api.themoviedb.org/3/movie/101?append_to_response=${MOVIE_APPEND}`)
  assert.strictEqual(buildDetailUrl('tv', 9), `https://api.themoviedb.org/3/tv/9?append_to_response=${TV_APPEND}`)
  // Paging is threaded through popular/search, not silently dropped.
  assert.strictEqual(buildPopularUrl('movie', { page: 3 }), 'https://api.themoviedb.org/3/movie/popular?page=3')
  assert.strictEqual(buildSearchUrl('dune', { page: 2 }), 'https://api.themoviedb.org/3/search/multi?query=dune&page=2')
  assert.strictEqual(buildSeasonUrl(9, 1), 'https://api.themoviedb.org/3/tv/9/season/1')
})

test('the detail append list differs per type (release_dates vs content_ratings)', () => {
  assert.match(MOVIE_APPEND, /release_dates/)
  assert.ok(!MOVIE_APPEND.includes('content_ratings'), 'movies do not have content_ratings')
  assert.match(TV_APPEND, /content_ratings/)
  assert.ok(!TV_APPEND.includes('release_dates'), 'TV has no release_dates endpoint')
  assert.ok(MOVIE_APPEND.includes('watch/providers') && TV_APPEND.includes('watch/providers'))
})

test('createTmdbCatalog.search fetches, appends api_key, returns normalized results', async () => {
  const results = [{ media_type: 'movie', id: 1, title: 'M', release_date: '2020-05-05', poster_path: '/p.jpg' }]
  const fetchFn = async (url) => {
    assert.ok(url.startsWith('https://api.themoviedb.org/3/search/multi?query='))
    assert.ok(url.includes('api_key=KEY'))
    return { ok: true, json: async () => ({ results }) }
  }
  const cat = createTmdbCatalog({ apiKey: 'KEY', fetchFn })
  const res = await cat.search('M')
  assert.strictEqual(res.length, 1)
  assert.deepStrictEqual(res[0], {
    id: 1, type: 'movie', title: 'M', year: '2020', poster: `${IMG}/p.jpg`,
    originalName: null, isAnime: false,
  })
})

test('createTmdbCatalog.detail normalizes a full movie', async () => {
  const movie = {
    id: 101, title: 'Inception', release_date: '2010-07-16', poster_path: '/abc.jpg',
    overview: 'x', vote_average: 8.3, genres: [{ id: 28, name: 'Action' }],
  }
  const fetchFn = async (url) => {
    assert.ok(url.startsWith('https://api.themoviedb.org/3/movie/101'))
    return { ok: true, json: async () => movie }
  }
  const cat = createTmdbCatalog({ apiKey: 'KEY', fetchFn })
  const e = await cat.detail('movie', 101)
  assert.strictEqual(e.type, 'movie')
  assert.deepStrictEqual(e.genres, ['Action'])
})

test('createTmdbCatalog.trending maps full entries by kind', async () => {
  const results = [{ id: 1, title: 'M', release_date: '2020-01-01', media_type: 'movie' }]
  const fetchFn = async (url) => {
    assert.ok(url.startsWith('https://api.themoviedb.org/3/trending/movie/week'))
    return { ok: true, json: async () => ({ results }) }
  }
  const cat = createTmdbCatalog({ apiKey: 'KEY', fetchFn })
  const res = await cat.trending('movie')
  assert.strictEqual(res[0].type, 'movie')
  assert.strictEqual(res[0].year, '2020')
})

test('createTmdbCatalog.season normalizes a season', async () => {
  const season = { season_number: 1, name: 'S1', episode_count: 2, episodes: [] }
  const fetchFn = async (url) => {
    assert.ok(url.startsWith('https://api.themoviedb.org/3/tv/9/season/1'))
    return { ok: true, json: async () => season }
  }
  const cat = createTmdbCatalog({ apiKey: 'KEY', fetchFn })
  const s = await cat.season(9, 1)
  assert.strictEqual(s.seasonNumber, 1)
})

test('createTmdbCatalog throws an Error containing TMDB on non-OK response', async () => {
  const fetchFn = async () => ({ ok: false, status: 401 })
  const cat = createTmdbCatalog({ apiKey: 'KEY', fetchFn })
  await assert.rejects(() => cat.search('x'), /TMDB/)
})

test('a function apiKey is resolved fresh on every fetch', async () => {
  let counter = 0
  const seen = []
  const apiKey = () => `KEY${++counter}`
  const fetchFn = async (url) => {
    seen.push(url)
    return { ok: true, json: async () => ({ results: [] }) }
  }
  const cat = createTmdbCatalog({ apiKey, fetchFn })
  await cat.search('a')
  await cat.search('b')
  assert.strictEqual(counter, 2)
  assert.ok(seen[0].includes('api_key=KEY1'))
  assert.ok(seen[1].includes('api_key=KEY2'))
})

test('a 401 response rejects with a clear API key message', async () => {
  const fetchFn = async () => ({ ok: false, status: 401, json: async () => ({}) })
  const cat = createTmdbCatalog({ apiKey: 'KEY', fetchFn })
  await assert.rejects(() => cat.search('x'), /TMDB API key/)
})

test('a non-401 failure rejects with the generic status message', async () => {
  const fetchFn = async () => ({ ok: false, status: 500 })
  const cat = createTmdbCatalog({ apiKey: 'KEY', fetchFn })
  await assert.rejects(() => cat.search('x'), /TMDB request failed \(500\)/)
})
