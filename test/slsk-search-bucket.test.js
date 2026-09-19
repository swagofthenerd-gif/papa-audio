'use strict'
// One search, one queue.
//
// A search fans out into as many as eight query variants, each its own
// POST /searches, all fired at once. slskd's own rate limiter answers that
// burst with 429; the per-REQUEST backoff in slskdFetch cannot help, because
// every variant backs off on its own clock and they all come back together. In
// the field that read as 27.5 s of "Searching 5 variants…" followed by the same
// error, and pressing Retry reproduced it exactly.
//
// The bucket under test is main.js's own. It is driven here on a VIRTUAL clock
// — a fake Date.now and a fake setTimeout, injected into the lift sandbox — so
// the test measures the schedule the bucket produces rather than waiting 4.5
// real seconds for it.
const test = require('node:test')
const assert = require('node:assert')
const { liftFns, MAIN } = require('./helpers/lift-main-fn')

// ── A virtual clock ──────────────────────────────────────────────────────────
function makeClock() {
  let now = 0
  let seq = 0
  const timers = []
  const api = {
    now: () => now,
    Date: { now: () => now },
    setTimeout: (fn, ms) => {
      const t = { at: now + Math.max(0, Number(ms) || 0), fn, seq: seq++ }
      timers.push(t)
      return t
    },
    clearTimeout: (t) => {
      const i = timers.indexOf(t)
      if (i >= 0) timers.splice(i, 1)
    },
    // Run until nothing is pending. Microtasks are flushed between timer
    // firings, so a body that awaits then sets another timer is followed.
    async drain(maxSteps = 5000) {
      for (let i = 0; i < maxSteps; i++) {
        await new Promise(r => setImmediate(r))
        if (!timers.length) return
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq)
        const t = timers.shift()
        now = Math.max(now, t.at)
        t.fn()
      }
      throw new Error('virtual clock did not settle')
    },
  }
  return api
}

function liftBucket(throttledUntil) {
  const clock = makeClock()
  const { fns, globals } = liftFns(
    ['_isSearchPost', '_searchBucketTake', '_searchBucketSleep'],
    {
      Date: clock.Date,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      _slskdThrottledUntil: throttledUntil || 0,
      _searchTokens: 2,
      _searchTokensAt: -1,
      _searchGate: Promise.resolve(),
    },
    ['SEARCH_BUCKET_INTERVAL_MS', 'SEARCH_BUCKET_BURST'])
  return { fns, globals, clock }
}

// The lift seeds the bucket's module-level `let`s by hand (liftFns only carries
// `const` declarations across), so pin those starting values to main.js's own.
// A seed that drifts from the shipped one would make every schedule below a
// measurement of the test rather than of the code.
test('the seeded bucket state matches what main.js actually declares', () => {
  assert.match(MAIN, /let _searchTokens = SEARCH_BUCKET_BURST\b/)
  assert.match(MAIN, /let _searchTokensAt = -1\b/)
  assert.match(MAIN, /const SEARCH_BUCKET_BURST = 2\b/)
  assert.match(MAIN, /const SEARCH_BUCKET_INTERVAL_MS = 1500\b/)
})

// ── Which requests the bucket is for ─────────────────────────────────────────
test('the bucket is for POST /searches and nothing else', () => {
  const { fns } = liftBucket()
  assert.strictEqual(fns._isSearchPost('POST', '/searches'), true)
  assert.strictEqual(fns._isSearchPost('post', '/searches?foo=1'), true)
  assert.strictEqual(fns._isSearchPost('POST', '/searches/abc/responses'), true)
  // Reads must stay instant: browse, transfer polling, the health check.
  assert.strictEqual(fns._isSearchPost('GET', '/searches'), false)
  assert.strictEqual(fns._isSearchPost('GET', '/users/x/browse'), false)
  assert.strictEqual(fns._isSearchPost('DELETE', '/searches/abc'), false)
  assert.strictEqual(fns._isSearchPost('POST', '/searchesomething'), false)
  assert.strictEqual(fns._isSearchPost('POST', '/transfers/downloads/x'), false)
})

// ── A stub daemon with slskd's kind of limiter ───────────────────────────────
// A real rate limiter is a bucket, not a metronome: it forgives a short burst
// and then holds you to the average. This one allows 1 request per second with
// a burst of 2 and answers 429 above that — the shape that produced the live
// failure.
function stubDaemon({ ratePerSec = 1, burst = 2 } = {}) {
  let tokens = burst
  let last = null
  return function request(atMs) {
    if (last === null) last = atMs
    tokens = Math.min(burst, tokens + ((atMs - last) / 1000) * ratePerSec)
    last = atMs
    if (tokens >= 1) { tokens -= 1; return 200 }
    return 429
  }
}

async function grantTimes(n, opts) {
  const { fns, clock } = liftBucket(opts && opts.throttledUntil)
  const grants = []
  const waiting = []
  for (let i = 0; i < n; i++) {
    waiting.push(fns._searchBucketTake().then(() => { grants.push(clock.now()) }))
  }
  await clock.drain()
  await Promise.all(waiting)
  return grants
}

test('five variants leave one at a time; the stub daemon 429s none of them', async () => {
  const grants = await grantTimes(5)
  assert.strictEqual(grants.length, 5, 'every variant was let through')
  // Burst of two, then one every 1.5 s.
  assert.deepStrictEqual(grants, [0, 0, 1500, 3000, 4500])

  const daemon = stubDaemon()
  const statuses = grants.map(t => daemon(t))
  assert.deepStrictEqual(statuses, [200, 200, 200, 200, 200],
    'the daemon rate-limited a variant: ' + statuses.join(','))
})

test('eight variants — the real fan-out ceiling — still land clean', async () => {
  const grants = await grantTimes(8)
  const daemon = stubDaemon()
  const statuses = grants.map(t => daemon(t))
  assert.ok(statuses.every(s => s === 200), 'statuses: ' + statuses.join(','))
})

test('the same burst WITHOUT the bucket is what the daemon refuses', async () => {
  // Not a test of our code — a check that the stub daemon is actually capable
  // of failing, so the two tests above are not green by construction.
  const daemon = stubDaemon()
  const statuses = [0, 0, 0, 0, 0].map(t => daemon(t))
  assert.deepStrictEqual(statuses, [200, 200, 429, 429, 429])
})

test('a Retry issued during the throttle window waits it out instead of firing', async () => {
  // slskd told us to back off until t=5000. A per-request backoff would let a
  // fresh Retry fire straight into that window; every waiter honours it now.
  const grants = await grantTimes(3, { throttledUntil: 5000 })
  assert.ok(grants.every(t => t >= 5000),
    'a request left during the throttle window: ' + grants.join(','))
  // And once it lifts, the ordinary spacing resumes rather than dumping all
  // three at once.
  assert.deepStrictEqual(grants, [5000, 5000, 6500])
})

// ── The wiring ───────────────────────────────────────────────────────────────
// A bucket nothing calls is decoration. This lifts the shipped slskdFetch
// ALONGSIDE the bucket (liftFns compiles them into one sandbox) and measures
// when each request actually reaches the wire.
function liftFetch() {
  const clock = makeClock()
  const wire = []
  const { fns } = liftFns(
    ['_isSearchPost', '_searchBucketSleep', '_searchBucketTake',
      '_slskdDryRunAllowed', 'slskdFetch'],
    {
      Date: clock.Date,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      DRY_RUN: false,
      SLSKD_BASE: 'http://127.0.0.1:1/api/v0',
      slskdToken: 'tok',
      slskdTokenExpiry: Number.MAX_SAFE_INTEGER,
      slskdAcquireToken: async () => true,
      _slskdThrottledUntil: 0,
      _slskdLastThrottleAt: 0,
      _searchTokens: 2,
      _searchTokensAt: -1,
      _searchGate: Promise.resolve(),
      fetch: async (url, init) => {
        wire.push({
          at: clock.now(),
          method: (init && init.method) || 'GET',
          path: String(url).replace(/^.*\/api\/v0/, ''),
        })
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }
      },
    },
    ['SEARCH_BUCKET_INTERVAL_MS', 'SEARCH_BUCKET_BURST', 'SLSKD_THROTTLE_BACKOFF_MS'])
  return { slskdFetch: fns.slskdFetch, wire, clock }
}

test('slskdFetch really routes search POSTs through the bucket, and reads past it', async () => {
  const { slskdFetch, wire, clock } = liftFetch()
  const pending = []
  for (let i = 0; i < 5; i++) pending.push(slskdFetch('POST', '/searches', { searchText: 'q' + i }))
  // A read fired in the middle of the fan-out must not wait behind it.
  pending.push(slskdFetch('GET', '/users/sherrybaaz/browse'))
  await clock.drain()
  await Promise.all(pending)

  const posts = wire.filter(w => w.method === 'POST').map(w => w.at)
  const gets = wire.filter(w => w.method === 'GET').map(w => w.at)
  assert.deepStrictEqual(posts, [0, 0, 1500, 3000, 4500],
    'search POSTs did not leave on the bucket schedule')
  assert.deepStrictEqual(gets, [0], 'a read queued behind the search fan-out')

  const daemon = stubDaemon()
  assert.ok(posts.map(t => daemon(t)).every(s => s === 200))
})
