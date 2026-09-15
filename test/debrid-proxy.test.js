'use strict'
// Groundwork for the real debrid fix (2026-09-15). Measured against a fresh
// RealDebrid link, four requests in the same second:
//     plain GET               → 200, 94,007,336 bytes
//     Range: bytes=0-         → 503, a 2,252-byte error page
//     Range: bytes=0-100000   → 206, 100,001 bytes
//     HEAD                    → 200
// An OPEN-ENDED range is exactly what ffmpeg/mpv sends when it opens a file,
// so the player was handed an error page as if it were the film, could not
// find the container headers, and gave up — debrid playback never worked.
// Proved by running mpv with seekable=0 (which forces a plain GET): it played.
//
// The relay below translates the player's open-ended range into the bounded
// one the server accepts, so seeking survives. Verified end to end against a
// real link: mpv opened and played through it, and seeking to ten minutes
// played too — both of which failed on the direct link.
const test = require('node:test')
const assert = require('node:assert')
const { parseRange, UPSTREAM_TRIES } = require('../src/debrid-proxy')

test('an open-ended range becomes a bounded one — the whole point', () => {
  assert.deepStrictEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 })
  assert.deepStrictEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 })
})

test('bounded and suffix ranges are passed through faithfully', () => {
  assert.deepStrictEqual(parseRange('bytes=10-99', 1000), { start: 10, end: 99 })
  assert.deepStrictEqual(parseRange('bytes=-38', 1000), { start: 962, end: 999 },
    'the last 38 bytes: what a player reads to find the index')
})

test('nonsense is refused rather than guessed at', () => {
  assert.strictEqual(parseRange('bananas', 1000), null)
  assert.strictEqual(parseRange('', 1000), null)
  assert.strictEqual(parseRange(null, 1000), null)
  assert.strictEqual(parseRange('bytes=-', 1000), null)
  assert.strictEqual(parseRange('bytes=900-100', 1000), null, 'end before start')
  assert.strictEqual(parseRange('bytes=0-', 0), null, 'no known size, no bound to give')
})

test('upstream requests are retried, because these servers 503 intermittently', () => {
  assert.ok(UPSTREAM_TRIES >= 2, 'two in five requests failed when measured')
})

test('every debrid play goes through the relay, built once per title and reused', () => {
  const fs = require('fs'); const path = require('path')
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.ok(/require\('\.\/src\/debrid-proxy'\)/.test(MAIN))
  // Both players take the relay's local URL, never the debrid link itself.
  assert.strictEqual((MAIN.match(/_debridPlayable\(result\.magnet\)/g) || []).length, 2)
  assert.ok(!/debrid\(\)\.linkFor\(result\.magnet\)/.test(MAIN), 'the raw link must not reach the player')
  const fn = MAIN.slice(MAIN.indexOf('async function _debridPlayable('), MAIN.indexOf('const DEBRID_BUDGET_MS'))
  // A relay already standing for this magnet is reused outright — that reuse
  // is the whole reason Play is instant instead of losing to the swarm.
  assert.ok(/_debridReady\.magnet === magnet/.test(fn) && /return _debridReady\.url/.test(fn))
  // The link is proved first, then put behind the relay.
  assert.ok(fn.indexOf('debrid().linkFor(magnet)') < fn.indexOf('proxy.serve(direct)'))
  // A relay older than its link's life is rebuilt, never trusted.
  assert.ok(/DEBRID_RELAY_TTL_MS/.test(fn))
  // Teardown must NOT stop it: that is what keeps the next play instant.
  const td = MAIN.slice(MAIN.indexOf('function _videoTeardown()'), MAIN.indexOf('function _wireVideoEngine'))
  assert.ok(!/_debridProxyStop\(\)/.test(td), 'stopping the ready relay here would undo the fix')
})

test('a client that vanishes mid-stream cannot strand the upstream connection', () => {
  const fs = require('fs'); const path = require('path')
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'debrid-proxy.js'), 'utf8')
  // Leaked connections are what made the server start refusing everything.
  assert.ok(/res\.once\('close', giveUp\)/.test(SRC) && /ctrl\.abort\(\)/.test(SRC))
  assert.ok(/signal \? \{ signal \} : \{\}/.test(SRC), 'the abort reaches the upstream fetch')
  assert.ok(/await reader\.cancel\(\)/.test(SRC), 'the upstream read is always closed')
  // A drain that never comes must not park the handler for ever.
  assert.ok(/res\.once\('close', finish\)/.test(SRC))
})
