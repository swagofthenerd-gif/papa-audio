'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  normalizeHttpEntry,
  buildVidsrcUrl,
  createVidsrcResolver,
  createMovieTvProvider,
} = require('../providers/movie-tv')
const { createAnimeProvider } = require('../providers/anime')

function httpEntry(overrides) {
  return Object.assign(
    {
      kind: 'http',
      url: 'https://cdn.example/stream.mp4',
      source: 'fake',
      quality: '1080p',
      title: null,
      label: 'Fake stream',
      audioLayout: null,
      sub: null,
      dub: null,
    },
    overrides
  )
}

test('normalizeHttpEntry coerces a raw object into a valid http entry', () => {
  assert.deepStrictEqual(
    normalizeHttpEntry({ url: 'https://cdn/x.mp4', quality: '1080p', title: 'Inception', sub: true, dub: false }),
    {
      kind: 'http',
      url: 'https://cdn/x.mp4',
      source: 'http',
      quality: '1080p',
      title: 'Inception',
      label: 'Inception',
      audioLayout: null,
      sub: true,
      dub: false,
    }
  )
})

test('normalizeHttpEntry defaults source to http and nulls missing fields', () => {
  assert.deepStrictEqual(normalizeHttpEntry({}), {
    kind: 'http',
    url: null,
    source: 'http',
    quality: null,
    title: null,
    label: null,
    audioLayout: null,
    sub: null,
    dub: null,
  })
})

test('normalizeHttpEntry keeps an explicit source and prefers label over title', () => {
  const entry = normalizeHttpEntry({ url: 'https://cdn/x.mp4', source: 'vidsrc', label: 'Vid', title: 'Title', quality: '720p' })
  assert.strictEqual(entry.source, 'vidsrc')
  assert.strictEqual(entry.label, 'Vid')
  assert.strictEqual(entry.quality, '720p')
})

test('normalizeHttpEntry is idempotent on an already-normalised entry', () => {
  const entry = httpEntry({ source: 'http', sub: true, dub: false })
  assert.deepStrictEqual(normalizeHttpEntry(entry), entry)
})

test('createMovieTvProvider returns only the working resolver entries and never throws', async () => {
  const good = httpEntry({ url: 'https://cdn/good.mp4', source: 'ok' })
  const resolvers = [
    async () => [good],
    async () => {
      throw new Error('resolver down')
    },
  ]
  const provider = createMovieTvProvider({ resolvers, fetchFn: async () => ({}) })
  const entries = await provider({ type: 'movie', title: 'Inception' })
  assert.deepStrictEqual(entries, [good])
})

test('createMovieTvProvider returns [] when no resolvers are configured', async () => {
  const provider = createMovieTvProvider({ fetchFn: async () => ({}) })
  assert.deepStrictEqual(await provider({ type: 'movie', title: 'Inception' }), [])
})

test('createMovieTvProvider skips non-function resolvers and non-array results', async () => {
  const good = httpEntry({ url: 'https://cdn/good.mp4', source: 'ok' })
  const provider = createMovieTvProvider({
    resolvers: [async () => good, 'not-a-function', async () => null],
  })
  const entries = await provider({ type: 'movie' })
  assert.deepStrictEqual(entries, [])
})

test('createAnimeProvider returns [] when no resolvers are configured', async () => {
  const provider = createAnimeProvider({ fetchFn: async () => ({}) })
  assert.deepStrictEqual(await provider({ type: 'anime', title: 'Frieren' }), [])
})

test('createAnimeProvider tags sub/dub from each raw result', async () => {
  const resolver = async () => [
    { url: 'https://cdn/frieren-sub.mp4', quality: '1080p', title: 'Frieren', sub: true, dub: false },
  ]
  const provider = createAnimeProvider({ resolvers: [resolver] })
  const entries = await provider({ type: 'anime', title: 'Frieren' })
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].kind, 'http')
  assert.strictEqual(entries[0].sub, true)
  assert.strictEqual(entries[0].dub, false)
  assert.strictEqual(entries[0].quality, '1080p')
})

test('createAnimeProvider skips a throwing resolver and returns the survivors', async () => {
  const good = httpEntry({ url: 'https://cdn/anime.mp4', source: 'ok', sub: true })
  const provider = createAnimeProvider({
    resolvers: [
      async () => {
        throw new Error('anime resolver down')
      },
      async () => [good],
    ],
  })
  const entries = await provider({ type: 'anime' })
  assert.deepStrictEqual(entries, [good])
})

test('buildVidsrcUrl maps a movie request to the movie embed template', () => {
  assert.strictEqual(
    buildVidsrcUrl({ type: 'movie', tmdbId: 27205 }),
    'https://vidsrc.to/embed/movie/27205'
  )
})

test('buildVidsrcUrl maps a tv request to the season/episode embed template', () => {
  assert.strictEqual(
    buildVidsrcUrl({ type: 'tv', tmdbId: 1399, season: 2, episode: 3 }),
    'https://vidsrc.to/embed/tv/1399/2/3'
  )
})

test('buildVidsrcUrl returns null when tmdbId is absent', () => {
  assert.strictEqual(buildVidsrcUrl({ type: 'movie' }), null)
})

test('createVidsrcResolver returns a single best-effort 1080p entry for a tmdbId', async () => {
  const resolver = createVidsrcResolver()
  const entries = await resolver({ type: 'movie', tmdbId: 27205 })
  assert.strictEqual(entries.length, 1)
  assert.deepStrictEqual(entries[0], {
    kind: 'http',
    url: 'https://vidsrc.to/embed/movie/27205',
    source: 'vidsrc',
    quality: '1080p',
    title: null,
    label: 'vidsrc · 1080p',
    audioLayout: null,
    sub: null,
    dub: null,
  })
})

test('createVidsrcResolver returns [] when tmdbId is absent', async () => {
  const resolver = createVidsrcResolver()
  assert.deepStrictEqual(await resolver({ type: 'movie' }), [])
})
