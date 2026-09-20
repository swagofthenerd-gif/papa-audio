'use strict'
// R16: a search that came back empty while slskd was rate-limiting is not
// "No results" — the network was never really asked. Main remembers the last
// 429; an empty search under it is returned as throttled; the renderer says so.
//
// This file used to be three blocks of assert.match against main.js and
// renderer.js source. A source pin cannot tell whether the memory is actually
// stamped, whether an empty search under it really comes back throttled, or
// whether the screen really says "Rate-limited" — it only checks the spelling.
// The three stages are now lifted out and executed: the fetch that meets the
// 429, the search that runs under it, and the row the person reads.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function slice(src, from, to, what) {
  const a = src.indexOf(from)
  assert.ok(a > -1, what + ': "' + from + '" must still exist')
  const b = src.indexOf(to, a + from.length)
  assert.ok(b > a, what + ': "' + to + '" must still follow it')
  return src.slice(a, b)
}

// ── Stage 1: the fetch that meets the 429 ───────────────────────────────────
// Both throttle paths must stamp the memory: the retry loop that eventually
// succeeds, and the give-up that throws. Only stamping one of them means a
// search that recovered on retry still reports itself as a plain empty search.

// `responses` is the sequence of statuses fetch() hands back, in order.
function liftFetch(responses, headers = {}) {
  const code = slice(MAIN,
    'const SLSKD_THROTTLE_BACKOFF_MS = ', '\nfunction verifyAudioFile(', 'slskdFetch')
  const calls = []
  let i = 0
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts })
    const status = responses[Math.min(i++, responses.length - 1)]
    return {
      status, ok: status >= 200 && status < 300,
      headers: { get: k => (k === 'retry-after' ? (headers['retry-after'] ?? null) : null) },
      text: async () => JSON.stringify({ id: 'search-1' }),
    }
  }
  // A virtual clock, so the backoff sleeps take the time they claim to take
  // without the test sleeping. Shadowing Date inside the lift is what makes the
  // 90-second memory window observable at all.
  let now = 1700000000000
  // DRY_RUN joined the lifted slice when the slskd write choke point landed
  // (2026-09-19). These tests are about live throttle behaviour, so it is false
  // here; the choke itself is covered by test/dry-run-slskd-choke.test.js.
  const names = ['fetch', 'slskdToken', 'slskdTokenExpiry', 'slskdAcquireToken', 'SLSKD_BASE',
    'setTimeout', 'console', 'Date', 'DRY_RUN']
  const waits = []
  const make = new Function(...names, `
    ${code}
    return { slskdFetch, slskdThrottledRecently, slskdIsThrottled }
  `)
  const api = make(
    fakeFetch, 'tok', now + 600000, async () => {}, 'http://localhost:5030/api/v0',
    // The backoff is real sleeping in production; here it advances the virtual
    // clock and resolves at once, recording how long it would have waited.
    (fn, ms) => { waits.push(ms); now += Number(ms) || 0; fn(); return { unref () {} } },
    { log () {}, error () {} },
    { now: () => now },
    false,
  )
  return { ...api, calls, waits, advance: ms => { now += ms }, at: () => now }
}

test('a 429 that recovers on retry is still remembered as a throttle', async () => {
  const f = liftFetch([429, 200])
  assert.strictEqual(f.slskdThrottledRecently(), false, 'nothing has happened yet')
  await f.slskdFetch('GET', '/searches')
  assert.strictEqual(f.calls.length, 2, 'it retried rather than failing')
  assert.strictEqual(f.slskdThrottledRecently(), true,
    'the retry loop must stamp the memory, or a recovered search reads as simply empty')
})

test('a 429 that never lets up throws a tagged error and is remembered too', async () => {
  const f = liftFetch([429])
  const err = await f.slskdFetch('POST', '/searches', {}).then(
    () => null, e => e)
  assert.ok(err, 'it gave up')
  assert.strictEqual(err.code, 'SLSKD_THROTTLED',
    'tagged so the health monitor does not restart a daemon that is merely busy')
  assert.strictEqual(err.throttled, true)
  assert.strictEqual(f.slskdThrottledRecently(), true, 'the give-up path stamps it too')
})

test('the memory runs from the last refusal, not from one three backoffs ago', () => {
  // The backoff chain spends seconds sleeping between 429s. If only the retry
  // loop stamped, the memory would already be part-spent by the time the call
  // gave up — and a search that finished just inside the window would come back
  // as plain "No results" after all. Measured from the give-up, it is not.
  const f = liftFetch([429])
  const backoff = JSON.parse(/const SLSKD_THROTTLE_BACKOFF_MS = (\[[^\]]+\])/.exec(MAIN)[1])
  const memory = Number(/const SLSKD_THROTTLE_MEMORY_MS = (\d+) \* 1000/.exec(MAIN)[1]) * 1000
  // The last stamp the retry loop takes is one backoff step before the end.
  const lastLoopStamp = backoff.slice(0, -1).reduce((a, b) => a + b, 0)
  const spentByBackoff = backoff.reduce((a, b) => a + b, 0) - lastLoopStamp
  assert.ok(spentByBackoff > 0, 'the chain really does spend time')

  return f.slskdFetch('GET', '/searches').catch(() => {
    // Just past the point where a loop-only stamp would have expired.
    f.advance(memory - spentByBackoff)
    assert.strictEqual(f.slskdThrottledRecently(), true,
      'still remembered, because the stamp is the last refusal')
    f.advance(spentByBackoff)
    assert.strictEqual(f.slskdThrottledRecently(), false, 'and it does eventually expire')
  })
})

test('a clean request leaves no throttle memory behind', async () => {
  const f = liftFetch([200])
  await f.slskdFetch('GET', '/searches')
  assert.strictEqual(f.slskdThrottledRecently(), false, 'never a false rate-limit claim')
  assert.strictEqual(f.slskdIsThrottled(), false)
})

test('the daemon\'s own Retry-After is honoured, but capped', async () => {
  const soon = liftFetch([429, 200], { 'retry-after': '2' })
  await soon.slskdFetch('GET', '/searches')
  assert.strictEqual(soon.waits[0], 2000, 'slskd knows better than a fixed schedule')

  const absurd = liftFetch([429, 200], { 'retry-after': '3600' })
  await absurd.slskdFetch('GET', '/searches')
  assert.ok(absurd.waits[0] <= 10000, 'but an hour-long hint must not hang the app')
})

test('the throttle memory outlives the backoff it came from', () => {
  // The backoff is seconds; a search takes up to 30. A memory that expired with
  // the backoff would be gone by the time the empty search came back.
  const memory = Number(/const SLSKD_THROTTLE_MEMORY_MS = (\d+) \* 1000/.exec(MAIN)?.[1]) * 1000
  const backoff = JSON.parse(/const SLSKD_THROTTLE_BACKOFF_MS = (\[[^\]]+\])/.exec(MAIN)[1])
  assert.ok(memory >= 30000, 'shorter than a search and the memory is useless: ' + memory)
  assert.ok(memory > Math.max(...backoff) * 4)
})

// ── Stage 2: the search that runs under it ──────────────────────────────────

function liftSearch({ results = [], throttledRecently = false, enabled = true } = {}) {
  const code = slice(MAIN,
    'async function slskRunSearch(', "\nipcMain.handle('slsk-download'", 'slskRunSearch')
  const names = ['_slskEnabled', 'slskdReady', 'fetch', 'SLSKD_BASE', 'slskdAcquireToken',
    '_searchCacheGet',
    '_searchCacheSet', '_searchPersistSet', 'slskdFetch', '_liveSearches', '_cancelledSearches',
    'safeSend', 'normalizeSearchResponses', 'slskdThrottledRecently', 'setTimeout', 'console']
  const make = new Function(...names, `${code}\nreturn slskRunSearch`)
  return make(
    // Whether the user has Soulseek switched on. Every case here is a search he
    // wants run; the off case is its own test at the end of the file.
    () => enabled,
    true, async () => ({ ok: true, status: 200 }), 'http://x', async () => {},
    () => null, () => {}, () => {},
    // POST /searches starts it; the first GET reports it complete; the
    // responses GET hands back whatever this case is testing.
    async (method, endpoint) => {
      if (method === 'POST') return { id: 'search-1' }
      if (endpoint.endsWith('/responses')) return results
      return { state: 'Completed' }
    },
    new Map(), new Set(),
    () => {}, r => r || [], () => throttledRecently,
    (fn) => { fn(); return { unref () {} } },
    { log () {}, error () {} },
  )
}

test('an empty search under a recent 429 comes back throttled, not empty', async () => {
  const run = liftSearch({ results: [], throttledRecently: true })
  const r = await run({ query: 'aphex twin selected ambient' })
  assert.deepStrictEqual(r.results, [])
  assert.strictEqual(r.throttled, true,
    'the network was never really asked, and the screen must be allowed to say so')
})

test('an empty search with no recent 429 is simply empty', async () => {
  const run = liftSearch({ results: [], throttledRecently: false })
  const r = await run({ query: 'aphex twin' })
  assert.strictEqual(r.throttled, false, 'never claim a rate-limit that did not happen')
})

test('results under a recent 429 speak for themselves', async () => {
  const hits = [{ username: 'peer', files: [] }]
  const run = liftSearch({ results: hits, throttledRecently: true })
  const r = await run({ query: 'aphex twin' })
  assert.strictEqual(r.results.length, 1)
  assert.strictEqual(r.throttled, false,
    'a search that found things was not prevented from running')
})

// ── Stage 3: the row the person reads ───────────────────────────────────────

function liftRow(slsk) {
  let code = ''
  for (const [name, from, to] of [
    ['esc', 'function esc(', '\nfunction highlightMatch('],
    ['renderSoulseekRow', 'function renderSoulseekRow(', '\nfunction _buildSearchVariants('],
  ]) code += slice(RENDERER, from, to, name) + '\n'
  return new Function('slsk', '_slskGroupByFolder', '_slskCorrectionChip', 'window', `
    ${code}
    return renderSoulseekRow
  `)(slsk, () => [], () => '', { PapaSlskFilters: null })
}

const searched = extra => Object.assign({
  status: { installed: true, configured: true, connected: true, running: true },
  results: [], searching: false, searched: true, error: null,
  throttledRecently: false, searchStart: 0, pendingSearches: 0,
}, extra)

test('an empty search under a rate-limit says rate-limited, not "No results"', () => {
  const html = liftRow(searched({ throttledRecently: true }))('aphex twin')
  assert.match(html, /Rate-limited/)
  assert.doesNotMatch(html, /No results/, 'that sentence sends a person hunting for a record that exists')
  assert.match(html, /Wait a minute or two/, 'and it says what to do about it')
  assert.match(html, /Retry/)
})

test('an ordinary empty search still says no results', () => {
  const html = liftRow(searched({}))('aphex twin')
  assert.match(html, /No results/)
  assert.doesNotMatch(html, /Rate-limited/, 'never invent a rate-limit')
})

test('a real error outranks a rate-limit, because retrying cannot fix it', () => {
  const html = liftRow(searched({ error: 'Soulseek not connected', throttledRecently: true }))('x')
  assert.match(html, /Soulseek not connected/)
  assert.doesNotMatch(html, /Rate-limited/)
  assert.match(html, /needs fixing first/)
})

test('the error text is escaped, never injected as markup', () => {
  const html = liftRow(searched({ error: '<img src=x onerror=1>' }))('x')
  assert.doesNotMatch(html, /<img/)
})

// ── The renderer's own bookkeeping ──────────────────────────────────────────
// runSlskSearch is a long async function wired straight into the DOM and the
// IPC bridge; it is not liftable without a production change (it would have to
// take its side effects as arguments). These stay source pins, and are the only
// ones left in this file.
test('a fresh search clears the flag, and any throttled variant sets it', () => {
  const run = RENDERER.slice(RENDERER.indexOf('async function runSlskSearch('),
    RENDERER.indexOf('async function refreshSlskStatus('))
  // The per-search reset lives in _slskBeginSearchPaint since QA #5 (it runs
  // before the spelling-correction await as well); pin it there.
  const begin = RENDERER.slice(RENDERER.indexOf('function _slskBeginSearchPaint('),
    RENDERER.indexOf('async function runSlskSearch('))
  assert.match(begin, /slsk\.searched  = false\n  slsk\.throttledRecently = false/)
  assert.match(run, /_slskBeginSearchPaint\(query\)/, 'and runSlskSearch calls it')
  assert.match(run, /if \(throttled\) slsk\.throttledRecently = true/)
  assert.match(run, /if \(_slskIsThrottleError\(e\)\) \{ slsk\.throttledRecently = true;/)
})

// ── Stage 3: a search he switched Soulseek off for ──────────────────────────
// Not "Soulseek is not connected", which reads as a fault and offers a Retry
// that retries nothing. The self-heal at the top of slskRunSearch re-probes
// /application and re-authenticates whenever slskdReady is false — which is
// exactly the state an off leaves behind — so without the gate the search box
// would quietly turn Soulseek back on.
// That nothing is probed or re-authenticated is asserted in
// test/slskd-enabled-gate.test.js, which counts the calls. This is the shape of
// the refusal, which is what the search box branches on.
test('a search while Soulseek is off refuses with the off error, not a fault', async () => {
  const run = liftSearch({ enabled: false })
  await assert.rejects(
    () => run({ query: 'aphex twin selected ambient' }),
    (e) => e.code === 'SLSK_OFF' && e.slskOff === true && /off/i.test(e.message))
})
