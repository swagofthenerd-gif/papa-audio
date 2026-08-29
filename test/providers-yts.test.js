'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  DEFAULT_BASE_URLS,
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

// A fetch-like response that carries JSON via the `text()` contract the
// provider now relies on (mirrors a real fetch body read).
function jsonResponse(body, { ok = true } = {}) {
  return { ok, text: async () => JSON.stringify(body) }
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

test('createYtsProvider builds the list URL against the first default mirror and resolves a matched title', async () => {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    return jsonResponse({ data: { movies: [rawMovie] } })
  }
  const provider = createYtsProvider({ fetchFn })
  const entries = await provider({ type: 'movie', title: 'Inception', year: 2010 })
  assert.strictEqual(entries.length, 3)
  assert.strictEqual(entries[0].source, 'YTS')
  assert.strictEqual(entries[0].audioLayout, '5.1')
  assert.deepStrictEqual(calls, [
    `${DEFAULT_BASE_URLS[0]}/api/v2/list_movies.json?query_term=Inception%202010&limit=5`,
  ])
})

test('createYtsProvider omits year from query_term when request.year is absent', async () => {
  const fetchFn = async (url) => {
    assert.strictEqual(url, `${DEFAULT_BASE_URLS[0]}/api/v2/list_movies.json?query_term=Inception&limit=5`)
    return jsonResponse({ data: { movies: [rawMovie] } })
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
  const fetchFn = async () => jsonResponse({ data: { movies } })
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

test('createYtsProvider falls back to the next mirror when the first throws', async () => {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    if (url.startsWith('https://dead-one')) throw new Error('network down')
    return jsonResponse({ data: { movies: [rawMovie] } })
  }
  const provider = createYtsProvider({ fetchFn, baseUrls: ['https://dead-one', 'https://alive-two'] })
  const entries = await provider({ type: 'movie', title: 'Inception', year: 2010 })
  assert.strictEqual(entries.length, 3)
  assert.deepStrictEqual(calls, [
    'https://dead-one/api/v2/list_movies.json?query_term=Inception%202010&limit=5',
    'https://alive-two/api/v2/list_movies.json?query_term=Inception%202010&limit=5',
  ])
})

test('createYtsProvider falls back to the next mirror when the first returns non-JSON', async () => {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    if (url.startsWith('https://html-one')) return { ok: true, text: async () => '<!DOCTYPE html><title>404</title>' }
    return jsonResponse({ data: { movies: [rawMovie] } })
  }
  const provider = createYtsProvider({ fetchFn, baseUrls: ['https://html-one', 'https://json-two'] })
  const entries = await provider({ type: 'movie', title: 'Inception', year: 2010 })
  assert.strictEqual(entries.length, 3)
  assert.deepStrictEqual(calls, [
    'https://html-one/api/v2/list_movies.json?query_term=Inception%202010&limit=5',
    'https://json-two/api/v2/list_movies.json?query_term=Inception%202010&limit=5',
  ])
})

test('createYtsProvider treats a 200 response with a non-JSON body as a failed mirror', async () => {
  const fetchFn = async () => ({ ok: true, text: async () => '<html>Cloudflare challenge</html>' })
  const provider = createYtsProvider({ fetchFn, baseUrls: ['https://only-mirror'] })
  const entries = await provider({ type: 'movie', title: 'Inception', year: 2010 })
  assert.deepStrictEqual(entries, [])
})

test('createYtsProvider returns [] when every mirror fails', async () => {
  const fetchFn = async () => {
    throw new Error('all down')
  }
  const provider = createYtsProvider({ fetchFn, baseUrls: ['https://a', 'https://b', 'https://c'] })
  const entries = await provider({ type: 'movie', title: 'Inception', year: 2010 })
  assert.deepStrictEqual(entries, [])
})

test('createYtsProvider returns [] when baseUrls is empty and defaults would also fail', async () => {
  const fetchFn = async () => ({ ok: true, text: async () => 'not json' })
  const provider = createYtsProvider({ fetchFn, baseUrls: [] })
  const entries = await provider({ type: 'movie', title: 'Inception', year: 2010 })
  assert.deepStrictEqual(entries, [])
})

test('createYtsProvider returns [] when there is no title', async () => {
  let called = false
  const fetchFn = async () => {
    called = true
    return jsonResponse({ data: { movies: [rawMovie] } })
  }
  const provider = createYtsProvider({ fetchFn })
  const entries = await provider({ type: 'movie' })
  assert.deepStrictEqual(entries, [])
  assert.strictEqual(called, false)
})

test('DEFAULT_BASE_URLS no longer includes the dead yts.mx domain', () => {
  assert.ok(Array.isArray(DEFAULT_BASE_URLS) && DEFAULT_BASE_URLS.length > 0)
  assert.ok(DEFAULT_BASE_URLS.every(u => typeof u === 'string' && u.startsWith('https://')))
  assert.ok(!DEFAULT_BASE_URLS.includes('https://yts.mx'))
})
