'use strict'
// Browse must always have anime genre chips: the live list is kept on disk,
// and the built-in list stands in when neither is available.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('the genre handler keeps the live list on disk and falls back to it, then to the built-in list', () => {
  const start = main.indexOf("ipcMain.handle('video-genres'")
  const body = main.slice(start, main.indexOf('ipcMain.handle(', start + 10))
  assert.ok(/_animeBrowseCacheWrite\('vocab:genres'/.test(body))
  assert.ok(/_animeBrowseCacheRead\('vocab:genres'\)/.test(body))
  assert.ok(/GENRES_FALLBACK\.map/.test(body))
})

test('the tag handler keeps the live list on disk and falls back to it', () => {
  const start = main.indexOf("ipcMain.handle('video-tags'")
  const body = main.slice(start, main.indexOf('ipcMain.handle(', start + 10))
  assert.ok(/_animeBrowseCacheWrite\('vocab:tags'/.test(body))
  assert.ok(/_animeBrowseCacheRead\('vocab:tags'\)/.test(body))
})

test('the production catalog asks for the request lane pacing explicitly', () => {
  assert.ok(/createAnilistCatalog\(\{ fetchFn: fetchWithTimeout\(15000\), minGapMs: ANILIST_MIN_GAP_MS, rateLimitWaitCapMs: ANILIST_RATE_WAIT_CAP_MS \}\)/.test(main))
})
