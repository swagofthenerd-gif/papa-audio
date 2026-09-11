'use strict'
// R16: a search that came back empty while slskd was rate-limiting is not
// "No results" — the network was never really asked. Main remembers the last
// 429; an empty search under it is returned as throttled; the renderer says so.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

test('main remembers the last 429 on both throttle paths and reports an empty search under it as throttled', () => {
  assert.match(MAIN, /function slskdThrottledRecently\(\) \{ return Date\.now\(\) - _slskdLastThrottleAt < SLSKD_THROTTLE_MEMORY_MS \}/)
  const loop = MAIN.slice(MAIN.indexOf('for (let attempt = 0; res.status === 429'), MAIN.indexOf("err.code = 'SLSKD_THROTTLED'"))
  assert.equal((loop.match(/_slskdLastThrottleAt = Date\.now\(\)/g) || []).length, 2, 'the retry loop and the give-up path both stamp it')
  const search = MAIN.slice(MAIN.indexOf('async function slskRunSearch('), MAIN.indexOf("ipcMain.handle('slsk-download'"))
  assert.match(search, /return \{ results, throttled: !results\.length && slskdThrottledRecently\(\) \}/)
})

test('renderer: a fresh search clears the flag, any throttled variant sets it, and the empty state says rate-limited', () => {
  const run = RENDERER.slice(RENDERER.indexOf('async function runSlskSearch('), RENDERER.indexOf('async function refreshSlskStatus('))
  assert.match(run, /slsk\.searched  = false\n  slsk\.throttledRecently = false/)
  assert.match(run, /if \(throttled\) slsk\.throttledRecently = true/)
  assert.match(run, /if \(_slskIsThrottleError\(e\)\) \{ slsk\.throttledRecently = true;/)
  const row = RENDERER.slice(RENDERER.indexOf('function renderSoulseekRow('), RENDERER.indexOf('function _buildSearchVariants('))
  assert.match(row, /const throttled = !failed && !!slsk\.throttledRecently/)
  assert.match(row, /throttled \? 'Rate-limited' : 'No results'/)
  assert.match(row, /Wait a minute or two, then click <strong>Retry<\/strong>/)
})
