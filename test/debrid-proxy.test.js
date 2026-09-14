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
// one the server accepts, so seeking survives. NOT yet wired into the app:
// its streaming path still has a fault under a bounded request, and shipping
// a half-working relay on top of this is not worth it.
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

test('the relay is not wired into the app yet', () => {
  const fs = require('fs'); const path = require('path')
  for (const f of ['main.js', 'preload.js', path.join('src', 'renderer.js')]) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    assert.ok(!/debrid-proxy/.test(src), f + ' must not use the relay until it is finished')
  }
})
