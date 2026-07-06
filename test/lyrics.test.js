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

test('fetchLyrics: local sidecar .lrc wins over network', async () => {
  _clearCacheForTest()
  const fs = require('fs')
  const dir = fs.mkdtempSync('/tmp/lyr-')
  fs.writeFileSync(dir + '/song.lrc', '[00:05.00]From the sidecar')
  let netCalls = 0
  _setHttpForTest(async () => { netCalls++; return { status: 404, body: '' } })
  const r = await fetchLyrics({ artist: 'A', title: 'T', duration: 100, filePath: dir + '/song.flac' })
  assert.strictEqual(r.source, 'file')
  assert.strictEqual(r.synced[0].text, 'From the sidecar')
  assert.strictEqual(netCalls, 0)
  _setHttpForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('fetchLyrics: http filePath never checks disk', async () => {
  _clearCacheForTest()
  _setHttpForTest(async () => ({ status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]Net', plainLyrics: 'Net' }) }))
  const r = await fetchLyrics({ artist: 'B', title: 'U', duration: 10, filePath: 'https://www.youtube.com/watch?v=x' })
  assert.strictEqual(r.source, 'lrclib')
  _setHttpForTest(null)
})

test('saveLyrics writes sidecar and clears cache', async () => {
  _clearCacheForTest()
  const fs = require('fs')
  const { saveLyrics } = require('../lyrics')
  const dir = fs.mkdtempSync('/tmp/lyr-')
  const audioPath = dir + '/tune.flac'
  fs.writeFileSync(audioPath, 'x')
  const r = saveLyrics({ filePath: audioPath, lrcContent: '[00:01.00]Saved line' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(fs.readFileSync(dir + '/tune.lrc', 'utf8'), '[00:01.00]Saved line')
  const again = await fetchLyrics({ artist: 'C', title: 'V', duration: 10, filePath: audioPath })
  assert.strictEqual(again.source, 'file')
  assert.strictEqual(again.synced[0].text, 'Saved line')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('saveLyrics rejects http paths', () => {
  const { saveLyrics } = require('../lyrics')
  const r = saveLyrics({ filePath: 'https://youtube.com/watch?v=x', lrcContent: '[00:01.00]x' })
  assert.strictEqual(r.ok, false)
})

test('fetchLyrics: force bypasses a cached miss', async () => {
  _clearCacheForTest()
  let calls = 0
  _setHttpForTest(async () => {
    calls++
    if (calls === 1) return { status: 404, body: '' }
    return { status: 200, body: JSON.stringify({ syncedLyrics: '[00:01.00]Found now', plainLyrics: 'Found now' }) }
  })
  const miss = await fetchLyrics({ artist: 'D', title: 'W', duration: 10 })
  assert.strictEqual(miss.plain, null)
  const cached = await fetchLyrics({ artist: 'D', title: 'W', duration: 10 })
  assert.strictEqual(cached.plain, null)
  const forced = await fetchLyrics({ artist: 'D', title: 'W', duration: 10, force: true })
  assert.strictEqual(forced.synced[0].text, 'Found now')
  _setHttpForTest(null)
})
