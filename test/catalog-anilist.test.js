'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  normalizeMedia,
  buildQuery,
  createAnilistCatalog,
} = require('../catalog/anilist')

const ANILIST_BASE = 'https://graphql.anilist.co'

test('normalizeMedia maps a raw AniList media node to an anime catalog entry', () => {
  const raw = {
    id: 101,
    title: {
      english: 'Fullmetal Alchemist: Brotherhood',
      romaji: 'Hagane no Renkinjutsushi',
      native: '鋼の錬金術師 FULLMETAL ALCHEMIST',
    },
    seasonYear: 2009,
    coverImage: { large: 'https://example.com/fma.jpg' },
    description: 'Two brothers search for the Philosopher\'s Stone.',
    averageScore: 90,
    genres: ['Action', 'Adventure', 'Fantasy'],
    episodes: 64,
    status: 'FINISHED',
  }
  assert.deepStrictEqual(normalizeMedia(raw), {
    id: 101,
    type: 'anime',
    title: 'Fullmetal Alchemist: Brotherhood',
    year: 2009,
    poster: 'https://example.com/fma.jpg',
    overview: 'Two brothers search for the Philosopher\'s Stone.',
    rating: 90,
    genres: ['Action', 'Adventure', 'Fantasy'],
    episodeCount: 64,
    status: 'FINISHED',
  })
})

test('normalizeMedia title falls back english → romaji → native', () => {
  const english = normalizeMedia({ id: 1, title: { english: 'E', romaji: 'R', native: 'N' } })
  assert.strictEqual(english.title, 'E')

  const romaji = normalizeMedia({ id: 2, title: { english: null, romaji: 'R', native: 'N' } })
  assert.strictEqual(romaji.title, 'R')

  const native = normalizeMedia({ id: 3, title: { english: null, romaji: null, native: 'N' } })
  assert.strictEqual(native.title, 'N')

  const none = normalizeMedia({ id: 4, title: null })
  assert.strictEqual(none.title, null)
})

test('normalizeMedia nulls missing fields', () => {
  const e = normalizeMedia({ id: 5 })
  assert.strictEqual(e.id, 5)
  assert.strictEqual(e.type, 'anime')
  assert.strictEqual(e.title, null)
  assert.strictEqual(e.year, null)
  assert.strictEqual(e.poster, null)
  assert.strictEqual(e.overview, null)
  assert.strictEqual(e.rating, null)
  assert.deepStrictEqual(e.genres, [])
  assert.strictEqual(e.episodeCount, null)
  assert.strictEqual(e.status, null)
})

test('normalizeMedia leaves rating null when averageScore is null', () => {
  const e = normalizeMedia({ id: 6, averageScore: null })
  assert.strictEqual(e.rating, null)
})

test('buildQuery produces a query string per kind', () => {
  const q = buildQuery('search', { query: 'bebop' })
  assert.strictEqual(typeof q, 'string')
  assert.ok(q.includes('search: $search'))
  assert.ok(q.includes('type: $type'))
  assert.ok(q.includes('$type: MediaType'))

  assert.ok(buildQuery('trending').includes('TRENDING_DESC'))
  assert.ok(buildQuery('popular').includes('POPULARITY_DESC'))
  assert.ok(buildQuery('season').includes('season: $season'))
  assert.throws(() => buildQuery('bogus'), /Unknown AniList query kind/)
})

test('createAnilistCatalog.search POSTs the right variables and normalizes the response', async () => {
  const media = [
    {
      id: 1,
      title: { romaji: 'Cowboy Bebop' },
      seasonYear: 1998,
      coverImage: { large: 'http://x/cb.jpg' },
      description: 'Bounty hunters in space.',
      averageScore: 86,
      genres: ['Sci-Fi', 'Action'],
      episodes: 26,
      status: 'FINISHED',
    },
  ]
  const fetchFn = async (url, init) => {
    assert.strictEqual(url, ANILIST_BASE)
    assert.strictEqual(init.method, 'POST')
    assert.strictEqual(init.headers['Content-Type'], 'application/json')
    const body = JSON.parse(init.body)
    assert.strictEqual(typeof body.query, 'string')
    assert.deepStrictEqual(body.variables, { page: 2, perPage: 20, search: 'bebop', type: 'ANIME' })
    return { ok: true, json: async () => ({ data: { Page: { media } } }) }
  }
  const cat = createAnilistCatalog({ fetchFn })
  const res = await cat.search('bebop', 2)
  assert.strictEqual(res.length, 1)
  assert.strictEqual(res[0].type, 'anime')
  assert.strictEqual(res[0].title, 'Cowboy Bebop')
  assert.strictEqual(res[0].year, 1998)
})

test('createAnilistCatalog.trending/popular/season normalize data.Page.media', async () => {
  const media = [{ id: 10, title: { english: 'A' }, seasonYear: 2020 }]
  const fetchFn = async () => ({ ok: true, json: async () => ({ data: { Page: { media } } }) })
  const cat = createAnilistCatalog({ fetchFn })
  for (const kind of ['trending', 'popular', 'season']) {
    const res = await cat[kind](1)
    assert.strictEqual(res.length, 1)
    assert.strictEqual(res[0].type, 'anime')
    assert.strictEqual(res[0].title, 'A')
  }
})

test('createAnilistCatalog throws an Error containing AniList on non-OK response', async () => {
  const fetchFn = async () => ({ ok: false, status: 500 })
  const cat = createAnilistCatalog({ fetchFn })
  await assert.rejects(() => cat.trending(1), /AniList/)
})

test('createAnilistCatalog throws on a GraphQL error response', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'Rate limited' }] }) })
  const cat = createAnilistCatalog({ fetchFn })
  await assert.rejects(() => cat.popular(1), /Rate limited/)
})
