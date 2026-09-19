'use strict'
// Stop hammering iTunes.
//
// The record shop prefetches a cover for every album a peer holds. iTunes
// answers a burst of those with 429, then with 403 once it has decided about
// this IP. One real session logged 848 [papa][art] lines — 438 of them 429 and
// 410 of them 403, one per peer album — because fetch-album-art caught the
// throttle, logged it, returned null and let the next lookup fire anyway.
//
// These drive the real main.js code: _artThrottled / _artNoteThrottle are
// lifted out and share one sandbox (so the module-level cooldown really
// persists between calls), and the fetch-album-art handler itself is run
// against a counting httpsGet.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { liftFns } = require('./helpers/lift-main-fn')
const { runHandler } = require('./helpers/lift-ipc')

const MINUTE = 60 * 1000

function lift() {
  const { fns, globals } = liftFns(
    ['_artThrottled', '_artNoteThrottle', '_artRetryAfterMs'],
    { _artCooldownUntil: 0, _artCooldownMs: 0 },
    ['ART_COOLDOWN_BASE_MS', 'ART_COOLDOWN_MAX_MS'])
  return { fns, globals }
}

const throttleErr = (code, retryAfter) => {
  const e = new Error(`HTTP ${code} for https://itunes.apple.com/search`)
  e.statusCode = code
  if (retryAfter !== undefined) e.retryAfter = retryAfter
  return e
}

// ── The cooldown itself ──────────────────────────────────────────────────────
test('a 429 opens a one-minute cooldown; a 403 does too', () => {
  for (const code of [429, 403]) {
    const { fns, globals } = lift()
    const now = 1_000_000
    assert.strictEqual(fns._artThrottled(now), false)
    assert.strictEqual(fns._artNoteThrottle(throttleErr(code), now), true)
    assert.strictEqual(fns._artThrottled(now), true)
    assert.strictEqual(globals._artCooldownUntil, now + MINUTE)
    assert.strictEqual(fns._artThrottled(now + MINUTE + 1), false)
  }
})

test('anything that is not a throttle is left to the ordinary miss path', () => {
  const { fns, globals } = lift()
  assert.strictEqual(fns._artNoteThrottle(throttleErr(404), 1000), false)
  assert.strictEqual(fns._artNoteThrottle(new Error('Timeout'), 1000), false)
  assert.strictEqual(globals._artCooldownUntil, 0)
})

test('a repeat throttle doubles, and stops at fifteen minutes', () => {
  const { fns, globals } = lift()
  let now = 1_000_000
  const waits = []
  for (let i = 0; i < 8; i++) {
    fns._artNoteThrottle(throttleErr(429), now)
    waits.push(globals._artCooldownUntil - now)
    // Come back after it expires and get throttled again.
    now = globals._artCooldownUntil + 1
  }
  assert.deepStrictEqual(waits.slice(0, 4), [1, 2, 4, 8].map(n => n * MINUTE))
  assert.strictEqual(waits[waits.length - 1], 15 * MINUTE, 'capped at fifteen minutes')
  assert.ok(waits.every(w => w <= 15 * MINUTE))
})

test('Retry-After wins over the guess, in seconds or as a date', () => {
  const { fns, globals } = lift()
  const now = 1_000_000
  fns._artNoteThrottle(throttleErr(429, '120'), now)
  assert.strictEqual(globals._artCooldownUntil, now + 120_000)

  const { fns: f2, globals: g2 } = lift()
  const at = Date.now() + 90_000
  f2._artNoteThrottle(throttleErr(429, new Date(at).toUTCString()), Date.now())
  // Second-resolution HTTP dates, so allow a second of slack.
  assert.ok(Math.abs(g2._artCooldownUntil - at) <= 1500,
    `expected ~${at}, got ${g2._artCooldownUntil}`)
})

test('a burst already in flight does not multiply the cooldown or the log line', () => {
  const { fns, globals } = lift()
  const now = 1_000_000
  fns._artNoteThrottle(throttleErr(429), now)
  const first = globals._artCooldownUntil
  // Nine siblings land a millisecond later, as they did in the real session.
  for (let i = 1; i <= 9; i++) fns._artNoteThrottle(throttleErr(429), now + i)
  assert.strictEqual(globals._artCooldownUntil, first)
})

// ── The handler: zero requests while paused ──────────────────────────────────
// The state lives in the lifted sandbox, so the same _artThrottled /
// _artNoteThrottle pair carries it from one handler run to the next — exactly
// as the module-level variables do in the real process.
function artEnv(shared, httpsGet) {
  return {
    httpsGet,
    path,
    artworkDir: '/tmp/papa-art-test',
    fs: {
      existsSync: () => false,
      readFileSync: () => Buffer.alloc(0),
      writeFileSync: () => {},
      renameSync: () => {},
      unlinkSync: () => {},
    },
    _artMisses: shared.misses,
    ART_MISS_TTL_MS: 24 * 60 * 60 * 1000,
    _artThrottled: shared.fns._artThrottled,
    _artNoteThrottle: shared.fns._artNoteThrottle,
    Buffer,
  }
}

test('once throttled, every later lookup makes ZERO requests until it expires', async () => {
  const { fns, globals } = lift()
  const shared = { fns, misses: new Map() }
  let requests = 0
  const httpsGet = async () => { requests++; throw throttleErr(429) }

  const args = { albumId: 'a1', artist: 'Pink Floyd', album: 'Animals' }

  const r1 = await runHandler('fetch-album-art', { args, globals: artEnv(shared, httpsGet) })
  assert.strictEqual(requests, 1, 'the first lookup asks once')
  // The handler's object is built inside the vm realm, so compare by field
  // rather than by prototype identity.
  assert.strictEqual(r1.result && r1.result.throttled, true)
  assert.strictEqual(r1.result.artPath, undefined)
  assert.ok(globals._artCooldownUntil > Date.now(), 'the cooldown is open')
  assert.strictEqual(shared.misses.size, 0, 'a throttle is not recorded as a missing cover')

  // Four more albums from the same sweep.
  for (const id of ['a2', 'a3', 'a4', 'a5']) {
    const r = await runHandler('fetch-album-art', {
      args: { albumId: id, artist: 'X', album: 'Y' }, globals: artEnv(shared, httpsGet) })
    assert.strictEqual(r.result && r.result.throttled, true)
  }
  assert.strictEqual(requests, 1, 'the sweep made no further requests')

  // After the cooldown, exactly one request goes out again.
  globals._artCooldownUntil = Date.now() - 1
  await runHandler('fetch-album-art', {
    args: { albumId: 'a6', artist: 'X', album: 'Y' }, globals: artEnv(shared, httpsGet) })
  assert.strictEqual(requests, 2, 'the cooldown expired, so one request went out')
})

test('an ordinary failure still records a miss and does not pause anything', async () => {
  const { fns, globals } = lift()
  const shared = { fns, misses: new Map() }
  let requests = 0
  const httpsGet = async () => { requests++; throw throttleErr(404) }
  const args = { albumId: 'b1', artist: 'Obscure', album: 'Nothing' }

  const r = await runHandler('fetch-album-art', { args, globals: artEnv(shared, httpsGet) })
  assert.strictEqual(r.result, null)
  assert.strictEqual(shared.misses.size, 1)
  assert.strictEqual(globals._artCooldownUntil, 0)

  await runHandler('fetch-album-art', {
    args: { albumId: 'b2', artist: 'Other', album: 'Thing' }, globals: artEnv(shared, httpsGet) })
  assert.strictEqual(requests, 2, 'a 404 does not stop the next album being looked up')
})
