'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  normalizeMovie,
  normalizeTv,
  normalizeSeason,
  normalizeSearchResult,
  buildTrendingUrl,
  buildPopularUrl,
  buildSearchUrl,
  buildDetailUrl,
  buildSeasonUrl,
  createTmdbCatalog,
} = require('../catalog/tmdb')

const IMG = 'https://image.tmdb.org/t/p/w500'

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
})

test('normalizeMovie maps genres from raw.genres names', () => {
  const e = normalizeMovie({
    id: 1,
    title: 'X',
    genres: [{ id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }],
  })
  assert.deepStrictEqual(e.genres, ['Action', 'Adventure'])
})

test('normalizeTv uses name and first_air_date', () => {
  const e = normalizeTv({ id: 9, name: 'Breaking Bad', first_air_date: '2008-01-20', poster_path: '/p.jpg' })
  assert.strictEqual(e.type, 'tv')
  assert.strictEqual(e.title, 'Breaking Bad')
  assert.strictEqual(e.year, '2008')
  assert.strictEqual(e.poster, `${IMG}/p.jpg`)
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
          { episode_number: 1, name: 'Pilot', overview: 'o', still_path: '/s.jpg', air_date: '2008-01-20' },
        ],
      },
    ],
  }
  const e = normalizeTv(raw)
  assert.strictEqual(e.seasons.length, 1)
  assert.strictEqual(e.seasons[0].seasonNumber, 1)
  assert.strictEqual(e.seasons[0].name, 'Season 1')
  assert.strictEqual(e.seasons[0].episodeCount, 2)
  assert.strictEqual(e.seasons[0].episodes[0].episodeNumber, 1)
  assert.strictEqual(e.seasons[0].episodes[0].name, 'Pilot')
  assert.strictEqual(e.seasons[0].episodes[0].still, `${IMG}/s.jpg`)
  assert.strictEqual(e.seasons[0].episodes[0].airDate, '2008-01-20')
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
    { id: 1, type: 'movie', title: 'M', year: '2020', poster: `${IMG}/p.jpg` }
  )
  assert.deepStrictEqual(
    normalizeSearchResult({ media_type: 'tv', id: 2, name: 'T', first_air_date: '2021-06-06', poster_path: null }),
    { id: 2, type: 'tv', title: 'T', year: '2021', poster: null }
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
  assert.strictEqual(buildDetailUrl('movie', 101), 'https://api.themoviedb.org/3/movie/101')
  assert.strictEqual(buildDetailUrl('tv', 9), 'https://api.themoviedb.org/3/tv/9')
  assert.strictEqual(buildSeasonUrl(9, 1), 'https://api.themoviedb.org/3/tv/9/season/1')
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
  assert.deepStrictEqual(res[0], { id: 1, type: 'movie', title: 'M', year: '2020', poster: `${IMG}/p.jpg` })
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
