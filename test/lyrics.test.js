'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { parseLrc, pickSearchHit, fetchLyrics, _setHttpForTest, _clearCacheForTest } = require('../lyrics')

test('parseLrc parses timestamps, sorts, ignores metadata lines', () => {
  const lrc = '[ar:X]\n[00:12.50]First line\n[00:01.00]Early line\n[01:02.30]Later <i>line</i>\n\nnot a lyric'
  const lines = parseLrc(lrc)
  assert.strictEqual(lines.length, 3)
  assert.deepStrictEqual(lines[0], { time: 1, text: 'Early line' })
  assert.strictEqual(lines[1].time, 12.5)
  assert.strictEqual(lines[2].time, 62.3)
})

test('parseLrc returns null for non-LRC text', () => {
  assert.strictEqual(parseLrc('just some plain lyrics\nwith lines'), null)
})

test('pickSearchHit prefers duration match', () => {
  const hits = [
    { trackName: 'Song', artistName: 'A', duration: 500, syncedLyrics: 'x' },
    { trackName: 'Song', artistName: 'A', duration: 301, syncedLyrics: 'y' },
  ]
  assert.strictEqual(pickSearchHit(hits, 300), hits[1])
  assert.strictEqual(pickSearchHit([], 300), null)
})

test('fetchLyrics: LRCLIB get hit returns synced lines', async () => {
  _clearCacheForTest()
  _setHttpForTest(async (url) => {
    assert.ok(url.includes('lrclib.net/api/get'))
    return { status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]Hello', plainLyrics: 'Hello' }) }
  })
  const r = await fetchLyrics({ artist: 'A', title: 'T', duration: 100 })
  assert.strictEqual(r.source, 'lrclib')
  assert.strictEqual(r.synced.length, 1)
  assert.strictEqual(r.synced[0].text, 'Hello')
  _setHttpForTest(null)
})

test('fetchLyrics: falls back to search, then plain-only', async () => {
  _clearCacheForTest()
  let calls = 0
  _setHttpForTest(async (url) => {
    calls++
    if (url.includes('/api/get')) return { status: 404, body: '' }
    return { status: 200, body: JSON.stringify([{ trackName: 'T', artistName: 'A', duration: 100, plainLyrics: 'plain text', syncedLyrics: null }]) }
  })
  const r = await fetchLyrics({ artist: 'A', title: 'T', duration: 100 })
  assert.strictEqual(calls, 2)
  assert.strictEqual(r.synced, null)
  assert.strictEqual(r.plain, 'plain text')
  _setHttpForTest(null)
})

test('fetchLyrics: caches per artist|title', async () => {
  _clearCacheForTest()
  let calls = 0
  _setHttpForTest(async () => {
    calls++
    return { status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]Hi', plainLyrics: 'Hi' }) }
  })
  await fetchLyrics({ artist: 'A', title: 'T', duration: 100 })
  await fetchLyrics({ artist: 'A', title: 'T', duration: 100 })
  assert.strictEqual(calls, 1)
  _setHttpForTest(null)
})

test('fetchLyrics: returns nulls when nothing found and no videoId', async () => {
  _clearCacheForTest()
  _setHttpForTest(async () => ({ status: 404, body: '' }))
  const r = await fetchLyrics({ artist: 'A', title: 'T', duration: 100 })
  assert.strictEqual(r.synced, null)
  assert.strictEqual(r.plain, null)
  _setHttpForTest(null)
})
