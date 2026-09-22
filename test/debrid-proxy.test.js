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
  // Both play paths call it; the third match is the function's own
  // definition line.
  assert.ok(/Promise\.race\(\[_debridPlayableAny\(result\), budget\]\)/.test(MAIN), 'smooth path')
  assert.ok(/_debridPlayableAny\(result\),\n\s*new Promise/.test(MAIN), 'purist path')
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

// Opening or seeking costs FOUR upstream requests, each waiting ~750 ms
// (logged 2026-09-15 against a real link): open the file, read the index at
// the very end, read the headers near the start, then finally the place you
// asked for. Three of those four touch the same two small regions every time,
// so both are fetched once and served from memory. Measured after: opening a
// film fell 6.05s -> 2.40s and seeking 9.02s -> 4.48s.
test('the ends of the file are cached once and then served with no network wait', async () => {
  const { createDebridProxy } = require('../src/debrid-proxy')
  // Comfortably larger than head (4 MB) + tail (8 MB) so the two regions do
  // not overlap — a file smaller than that has no middle to fetch anyway.
  const TOTAL = 40 * 1024 * 1024
  const body = Buffer.alloc(TOTAL)
  for (let i = 0; i < TOTAL; i += 7) body[i] = (i / 7) % 251
  const upstream = []
  const fetchFn = async (url, init) => {
    if (init && init.method === 'HEAD') {
      return { ok: true, status: 200, headers: { get: k => (k === 'content-length' ? String(TOTAL) : null) } }
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec((init && init.headers && init.headers.Range) || '')
    const start = Number(m[1]); const end = Number(m[2])
    upstream.push([start, end])
    const slice = body.subarray(start, end + 1)
    // A 206 names the bytes it is sending. RFC 9110 requires it, every real
    // server sends it, and the relay now CHECKS it — a 206 whose Content-Range
    // starts somewhere other than where the range asked is how a seek served the
    // opening titles. This fake omitted the field, which made it a model of a
    // server that does not exist.
    return {
      ok: true, status: 206, body: null,
      arrayBuffer: async () => slice,
      headers: { get: k => (k === 'content-range' ? `bytes ${start}-${end}/${TOTAL}` : null) },
    }
  }
  const proxy = createDebridProxy({ fetchFn })
  try {
    const local = await proxy.serve('https://rd.example/film.mkv')
    // The warm-up is deliberately NOT awaited by serve() any more — making the
    // player wait for 12 MiB before it gets a URL was the startup cost. A test
    // about what the cache holds has to wait for it on purpose.
    await proxy._warmed()
    const cached = proxy._cached()
    assert.ok(cached.head > 0 && cached.tail > 0, 'both ends held: ' + JSON.stringify(cached))
    const afterWarm = upstream.length

    // Reading the very end — the index — must cost nothing upstream.
    const tailRes = await fetch(local, { headers: { Range: `bytes=${TOTAL - 1000}-${TOTAL - 1}` } })
    const tailBuf = Buffer.from(await tailRes.arrayBuffer())
    assert.strictEqual(tailRes.status, 206)
    assert.ok(tailBuf.equals(body.subarray(TOTAL - 1000)), 'the bytes are right, not merely fast')
    assert.strictEqual(upstream.length, afterWarm, 'served from memory, no upstream request')

    // The opening headers likewise.
    const headRes = await fetch(local, { headers: { Range: 'bytes=0-4095' } })
    const headBuf = Buffer.from(await headRes.arrayBuffer())
    assert.ok(headBuf.equals(body.subarray(0, 4096)))
    assert.strictEqual(upstream.length, afterWarm, 'still no upstream request')

    // A read starting inside the cache but running past it is served from
    // memory first and only then goes upstream for the remainder.
    const mixed = await fetch(local, { headers: { Range: 'bytes=0-8388607' } })
    const mixedBuf = Buffer.from(await mixed.arrayBuffer())
    assert.strictEqual(mixedBuf.length, 8388608)
    assert.ok(mixedBuf.equals(body.subarray(0, 8388608)), 'the join is seamless')
    assert.ok(upstream.length > afterWarm, 'the part beyond the cache did come from upstream')
  } finally {
    proxy.stop()
  }
  assert.deepStrictEqual(proxy._cached(), { head: 0, tail: 0 }, 'released on stop')
})
