'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  normalizeMovieResult,
  createYtsProvider,
} = require('../providers/yts')

const rawMovie = {
  id: 101,
  title: 'Inception',
  year: 2010,
  torrents: [
    { url: 'magnet:?xt=urn:btih:AAA1&dn=Inception.2010.720p', hash: 'AAA1', quality: '720p', seeds: 10, peers: 2, size: '800MB' },
    { url: 'magnet:?xt=urn:btih:AAA2&dn=Inception.2010.1080p', hash: 'AAA2', quality: '1080p', seeds: 9, peers: 1, size: '1.5GB' },
    { url: 'magnet:?xt=urn:btih:AAA3&dn=Inception.2010.2160p', hash: 'AAA3', quality: '2160p', seeds: 4, peers: 0, size: '4GB' },
    { url: 'magnet:?xt=urn:btih:NOHASH', quality: '3D', seeds: 0, peers: 0, size: '2GB' },
  ],
}

test('normalizeMovieResult maps torrents to torrent entries and drops hashless torrents', () => {
  const entries = normalizeMovieResult(rawMovie)
  assert.strictEqual(entries.length, 3)
  assert.deepStrictEqual(entries[0], {
    kind: 'torrent',
    url: null,
    magnet: 'magnet:?xt=urn:btih:AAA1&dn=Inception.2010.720p',
    infoHash: 'AAA1',
    fileIndex: 0,
    source: 'YTS',
    quality: '720p',
    label: 'YTS · 720p',
    audioLayout: '5.1',
    sub: null,
    dub: null,
  })
  assert.deepStrictEqual(entries.map(e => e.quality), ['720p', '1080p', '2160p'])
  assert.deepStrictEqual(entries.map(e => e.infoHash), ['AAA1', 'AAA2', 'AAA3'])
})

test('normalizeMovieResult maps unrecognized qualities to unknown', () => {
  const entries = normalizeMovieResult({
    torrents: [{ url: 'magnet:?xt=urn:btih:X', hash: 'X', quality: '3D' }],
  })
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].quality, 'unknown')
  assert.strictEqual(entries[0].label, 'YTS · unknown')
})

test('createYtsProvider builds the list URL and resolves a matched title', async () => {
  const fetchFn = async (url) => {
    assert.strictEqual(url, 'https://yts.mx/api/v2/list_movies.json?query_term=Inception%202010&limit=5')
    return { ok: true, json: async () => ({ data: { movies: [rawMovie] } }) }
  }
  const provider = createYtsProvider({ fetchFn })
  const entries = await provider({ type: 'movie', title: 'Inception', year: 2010 })
  assert.strictEqual(entries.length, 3)
  assert.strictEqual(entries[0].source, 'YTS')
  assert.strictEqual(entries[0].audioLayout, '5.1')
})

test('createYtsProvider omits year from query_term when request.year is absent', async () => {
  const fetchFn = async (url) => {
    assert.strictEqual(url, 'https://yts.mx/api/v2/list_movies.json?query_term=Inception&limit=5')
    return { ok: true, json: async () => ({ data: { movies: [rawMovie] } }) }
  }
  const provider = createYtsProvider({ fetchFn })
  const entries = await provider({ type: 'movie', title: 'Inception' })
  assert.strictEqual(entries.length, 3)
})

test('createYtsProvider prefers a movie whose year matches request.year', async () => {
  const movies = [
    { id: 1, title: 'Inception', year: 2000, torrents: [{ url: 'magnet:?xt=urn:btih:OLD', hash: 'OLD', quality: '720p' }] },
    { id: 2, title: 'Inception', year: 2010, torrents: [{ url: 'magnet:?xt=urn:btih:NEW', hash: 'NEW', quality: '1080p' }] },
  ]
  const fetchFn = async () => ({ ok: true, json: async () => ({ data: { movies } }) })
  const provider = createYtsProvider({ fetchFn })
  const entries = await provider({ type: 'movie', title: 'Inception', year: 2010 })
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].infoHash, 'NEW')
})

test('createYtsProvider returns [] on a non-OK response without throwing', async () => {
  const fetchFn = async () => ({ ok: false, status: 500 })
  const provider = createYtsProvider({ fetchFn })
  const entries = await provider({ type: 'movie', title: 'Inception', year: 2010 })
  assert.deepStrictEqual(entries, [])
})
