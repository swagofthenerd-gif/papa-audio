'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  parseSites,
  createYarrlistDirectory,
} = require('../yarrlist-directory')

const fixture = `
<html>
  <body>
    <a href="https://yarrlist.net/movies-and-tv-shows">Movies/TV Shows</a>
    <a href="#">Skip me</a>
    <a href="">Empty anchor</a>
    <a href="relative/page">Relative</a>
    <a href="mailto:test@example.com">Mail</a>
    <div class="button-container">
      <a href="https://hokejatv.com/redirect.php" class="play-button">
        <i class="fas fa-play"></i>soap2night.cc
      </a>
      <a href="https://ramoflix.net/" class="play-button">
        <i class="fas fa-play"></i>ramoflix.net
      </a>
      <a href="https://hokejatv.com/other-page" class="play-button">
        <i class="fas fa-play"></i>duplicate-host
      </a>
      <a href="https://anime.xyz/" class="play-button">
        <i class="fas fa-play"></i>Anime Hub
      </a>
    </div>
  </body>
</html>
`

test('parseSites extracts absolute links, strips markup, and tags category', () => {
  const sites = parseSites(fixture, 'movies-tv')
  assert.deepStrictEqual(sites, [
    { name: 'soap2night.cc', url: 'https://hokejatv.com/redirect.php', category: 'movies-tv' },
    { name: 'ramoflix.net', url: 'https://ramoflix.net/', category: 'movies-tv' },
    { name: 'Anime Hub', url: 'https://anime.xyz/', category: 'movies-tv' },
  ])
})

test('parseSites de-duplicates by hostname and drops yarrlist/#/empty/relative/mailto links', () => {
  const sites = parseSites(fixture, 'movies-tv')
  const hostnames = sites.map(s => new URL(s.url).hostname)
  assert.deepStrictEqual(hostnames, ['hokejatv.com', 'ramoflix.net', 'anime.xyz'])
  const urls = sites.map(s => s.url)
  assert.ok(!urls.some(u => u.includes('yarrlist')))
  assert.ok(!urls.some(u => u.startsWith('#') || u === ''))
})

test('parseSites tags entries with the given category', () => {
  const anime = parseSites(fixture, 'anime')
  assert.ok(anime.length > 0)
  assert.ok(anime.every(s => s.category === 'anime'))
})

test('parseSites returns [] for non-string or empty input', () => {
  assert.deepStrictEqual(parseSites('', 'movies-tv'), [])
  assert.deepStrictEqual(parseSites(null, 'movies-tv'), [])
  assert.deepStrictEqual(parseSites(undefined, 'movies-tv'), [])
})

test('createYarrlistDirectory.refresh fetches both pages and returns both categories', async () => {
  const moviesTvHtml = '<a href="https://site-one.com/"><i></i>Site One</a>'
  const animeHtml = '<a href="https://site-two.com/"><i></i>Site Two</a>'
  const fetchFn = async (url) => {
    if (url === 'https://yarrlist.net/movies-and-tv-shows') {
      return { ok: true, text: async () => moviesTvHtml }
    }
    if (url === 'https://yarrlist.net/anime-list') {
      return { ok: true, text: async () => animeHtml }
    }
    throw new Error(`unexpected url: ${url}`)
  }
  const directory = createYarrlistDirectory({ fetchFn })
  const result = await directory.refresh()
  assert.deepStrictEqual(result.moviesTv, [
    { name: 'Site One', url: 'https://site-one.com/', category: 'movies-tv' },
  ])
  assert.deepStrictEqual(result.anime, [
    { name: 'Site Two', url: 'https://site-two.com/', category: 'anime' },
  ])
  assert.strictEqual(typeof result.fetchedAt, 'number')
  assert.ok(result.fetchedAt > 0)
})

test('createYarrlistDirectory.refresh returns empty lists on non-OK responses', async () => {
  const fetchFn = async () => ({ ok: false, status: 500 })
  const directory = createYarrlistDirectory({ fetchFn })
  const result = await directory.refresh()
  assert.deepStrictEqual(result.moviesTv, [])
  assert.deepStrictEqual(result.anime, [])
  assert.strictEqual(typeof result.fetchedAt, 'number')
})
