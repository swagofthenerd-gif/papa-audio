'use strict'
// The slskd write choke point, and the download scheduler tick behind it.
//
// slskd at :5030 is the user's REAL Soulseek account. On 2026-09-19 a scan of
// main.js found four write paths with no dry-run check at all — slsk-download
// (which starts a transfer), slsk-chat-send (which messages a peer),
// slsk-wishlist-run (which enqueues downloads internally, around the gate on
// slsk-enqueue-downloads) and slsk-setup (which rewrites slskd.yml and restarts
// the daemon) — plus the download scheduler's own tick, which POSTs transfers
// with no IPC call involved, so a queued dlState carried into a twin profile
// would have started real downloads by itself.
//
// The fix is one choke point in slskdFetch, mirroring src/debrid.js's rd().
// These tests run the REAL slskdFetch source out of main.js, with a fake http
// client, and assert on what reached the wire — not on how main.js reads.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const MAIN_PATH = path.join(__dirname, '..', 'main.js')
const MAIN = fs.readFileSync(MAIN_PATH, 'utf8')
const dlSched = require('../src/download-scheduler')

// ── Lifting a top-level function out of main.js ─────────────────────────────
// Brace-balanced from the `function <name>(` header. main.js cannot be
// require()d (it boots Electron on load) and a test that reads it as text
// cannot see behaviour, so the shipped body is compiled into a sandbox and
// called for real.
function functionSource(name) {
  let header = MAIN.indexOf('function ' + name + '(')
  assert.ok(header > -1, 'main.js no longer declares function ' + name)
  // Keep the `async` keyword: sliced off, the body's own `await` is a syntax
  // error and the harness fails for a reason that has nothing to do with the gate.
  if (MAIN.slice(header - 6, header) === 'async ') header -= 6
  let depth = 0
  for (let i = MAIN.indexOf('{', header); i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth++
    else if (MAIN[i] === '}') { depth--; if (!depth) return MAIN.slice(header, i + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

// Anything the body reaches for that the sandbox does not define becomes a
// callable, truthy recorder, so "did it reach X" is answerable and nothing real
// is touched. `then` is undefined so an awaited stub settles immediately.
function makeStub(name, calls) {
  const fn = function () { calls.push(name); return makeStub(name + '()', calls) }
  return new Proxy(fn, {
    get(t, p) {
      if (p === 'then') return undefined
      if (typeof p === 'symbol') return Reflect.get(t, p)
      return makeStub(name + '.' + String(p), calls)
    },
    has() { return true },
  })
}

function sandbox(defined, calls) {
  const base = Object.assign(Object.create(null), {
    console: { log() {}, warn() {}, error() {} },
    Promise, Date, Math, JSON, Number, String, Boolean, Array, Object,
    Set, Map, Error, isFinite, parseInt, parseFloat, encodeURIComponent,
    Symbol, RegExp, setTimeout, clearTimeout, AbortSignal, AbortController,
  }, defined)
  return vm.createContext(new Proxy(base, {
    has() { return true },
    get(t, p) {
      if (p === Symbol.unscopables) return undefined
      if (p in t) return t[p]
      if (typeof p === 'symbol') return undefined
      return makeStub(String(p), calls)
    },
    set(t, p, v) { t[p] = v; return true },
  }))
}

// ── A slskdFetch with a fake wire ───────────────────────────────────────────
// Everything from the choke-point comment through the end of slskdFetch is
// compiled as one unit, so _slskdDryRunAllowed, the once-per-path log set and
// the function itself are the shipped ones.
function liftSlskdFetch(dryRun) {
  const start = MAIN.indexOf('// ── The slskd write choke point')
  assert.ok(start > -1, 'the choke-point block is gone from main.js')
  const body = functionSource('slskdFetch')
  const end = MAIN.indexOf(body) + body.length
  assert.ok(end > start, 'slskdFetch no longer follows the choke-point block')

  const wire = []
  const logged = []
  const calls = []
  const defined = {
    console: { log: m => logged.push(String(m)), warn() {}, error() {} },
    DRY_RUN: dryRun,
    SLSKD_BASE: 'http://127.0.0.1:1/api/v0',
    slskdToken: 'tok',
    // Far future, so the live path never detours through slskdAcquireToken.
    slskdTokenExpiry: Date.now() + 9e9,
    slskdAcquireToken: async () => true,
    SLSKD_THROTTLE_BACKOFF_MS: [1],
    _slskdThrottledUntil: 0,
    _slskdLastThrottleAt: 0,
    fetch: async (url, init) => {
      wire.push(((init && init.method) || 'GET') + ' ' +
        String(url).replace(/^.*\/api\/v0/, ''))
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{"ok":true}',
      }
    },
  }
  const ctx = sandbox(defined, calls)
  vm.runInContext(MAIN.slice(start, end), ctx, { filename: 'main.js:slskdFetch' })
  return { fetch: ctx.slskdFetch, wire, logged }
}

function isDryRefusal(e) {
  return !!e && e.dryRun === true && e.code === 'DRY_RUN' &&
    /^Dry run — .+ to slskd was not performed$/.test(e.message)
}

// ── The allow-list, exactly ─────────────────────────────────────────────────

const REFUSED = [
  ['POST', '/transfers/downloads/sherrybaaz'],
  ['DELETE', '/transfers/downloads/sherrybaaz/7?remove=true'],
  ['POST', '/conversations/somepeer'],
  ['PUT', '/options'],
  ['DELETE', '/users/somepeer'],
  // Not on the allow-list despite the prefix: only a real path segment counts.
  ['POST', '/searchesomething'],
]

for (const [method, endpoint] of REFUSED) {
  test(`a dry run refuses ${method} ${endpoint} and sends nothing`, async () => {
    const s = liftSlskdFetch(true)
    await assert.rejects(() => s.fetch(method, endpoint, [{ filename: 'f.flac', size: 1 }]),
      isDryRefusal)
    assert.deepStrictEqual(s.wire, [],
      'a dry run reached slskd: ' + s.wire.join(', '))
  })
}

const ALLOWED = [
  ['GET', '/transfers/downloads'],
  ['GET', '/application'],
  ['GET', '/session'],
  ['GET', '/users/somepeer/browse'],
  ['POST', '/searches'],
  ['GET', '/searches/abc/responses'],
  ['DELETE', '/searches/abc'],
]

for (const [method, endpoint] of ALLOWED) {
  test(`a dry run still allows ${method} ${endpoint}`, async () => {
    const s = liftSlskdFetch(true)
    const out = await s.fetch(method, endpoint, method === 'GET' ? undefined : { searchText: 'x' })
    assert.deepStrictEqual(out, { ok: true })
    assert.deepStrictEqual(s.wire, [method + ' ' + endpoint],
      'the request did not reach the wire: ' + s.wire.join(', '))
  })
}

test('searching is the only write a dry-run twin keeps, and it is the whole search cycle', async () => {
  const s = liftSlskdFetch(true)
  const id = 'sid'
  await s.fetch('POST', '/searches', { searchText: 'burial untrue' })
  await s.fetch('GET', `/searches/${id}`)
  await s.fetch('GET', `/searches/${id}/responses`)
  await s.fetch('DELETE', `/searches/${id}`)
  assert.deepStrictEqual(s.wire, [
    'POST /searches', 'GET /searches/sid', 'GET /searches/sid/responses',
    'DELETE /searches/sid',
  ])
})

test('with the dry run off, every one of those writes passes through untouched', async () => {
  for (const [method, endpoint] of REFUSED) {
    const s = liftSlskdFetch(false)
    await s.fetch(method, endpoint, [{ filename: 'f.flac', size: 1 }])
    assert.deepStrictEqual(s.wire, [method + ' ' + endpoint],
      `${method} ${endpoint} stopped reaching slskd with the dry run off`)
  }
})

test('the refusal names the method and the path, with the query stripped', async () => {
  const s = liftSlskdFetch(true)
  await assert.rejects(
    () => s.fetch('delete', '/transfers/downloads/u/7?remove=true'),
    e => e.message === 'Dry run — DELETE /transfers/downloads/u/7 to slskd was not performed')
})

test('the refusal is logged once per path, not once per poll', async () => {
  const s = liftSlskdFetch(true)
  for (let i = 0; i < 5; i++) {
    await s.fetch('POST', '/transfers/downloads/u').catch(() => {})
  }
  await s.fetch('POST', '/conversations/u').catch(() => {})
  // A different transfer id is the same path for logging purposes only when the
  // path itself matches; these two are genuinely different paths.
  assert.deepStrictEqual(s.logged, [
    '[papa] DRY RUN: refused POST /transfers/downloads/u to slskd',
    '[papa] DRY RUN: refused POST /conversations/u to slskd',
  ])
})

// ── The scheduler tick ──────────────────────────────────────────────────────
// The tick is the path with no IPC handler in front of it: a dlState carrying
// pending items, persisted into a twin profile, would dispatch them on the
// first tick. It must reach zero POSTs, and it must not turn the refusal into a
// peer failure — that would burn the file's retry budget and eventually mark it
// exhausted, so a twin would destroy the queue it was only meant to look at.

function tickHarness(dryRun) {
  const state = dlSched.createState()
  const filename = '@@\\Music\\Burial\\Untrue\\01 Archangel.flac'
  const size = 40 * 1024 * 1024
  const added = dlSched.addItem(state, { filename, size })
  assert.ok(added && !added.refused, 'the fixture item was not enqueued: ' +
    JSON.stringify(added))
  // addItem enqueues the want; the peers it can be got from arrive separately.
  // Without one, planDispatch has nothing eligible and the test would pass for
  // the wrong reason.
  assert.strictEqual(
    dlSched.addSources(state, added.key, [{ username: 'peerone', filename, size }]), 1)
  assert.strictEqual(state.pending.length, 1)

  const s = liftSlskdFetch(dryRun)
  const calls = []
  const defined = {
    console: { log() {}, warn() {}, error() {} },
    DRY_RUN: dryRun,
    dlSched,
    dlState: state,
    dlTicking: false,
    _dlTickStartedAt: 0,
    _dlTickFailures: 0,
    _dlEmptySnapshots: 0,
    DL_TICK_DEADLINE_MS: 600000,
    dlConfig: () => Object.assign({}, dlSched.DEFAULTS),
    // Reachable, empty: nothing is in flight, so the empty-snapshot guard that
    // protects a restarting daemon does not apply.
    dlSnapshot: async () => new Map(),
    slskdFetch: s.fetch,
    dlBaseName: f => String(f).split('\\').pop(),
    dlDiscoveryEnabled: () => false,
    _applyBandwidthSchedule() {},
    dlCheckCompletedGroups: async () => {},
    dlAutoNudge: async () => {},
    dlPurgeSucceeded: async () => {},
    dlTransferId: async () => '1',
    pruneDlDone() {},
    dlAdaptiveTune() {},
    dlPersist() {},
    dlBroadcast() {},
    dlSucceeded: new Set(),
  }
  const ctx = sandbox(defined, calls)
  vm.runInContext(functionSource('dlTick'), ctx, { filename: 'main.js:dlTick' })
  return { tick: ctx.dlTick, state, wire: s.wire }
}

test('the scheduler tick dispatches a pending file when the dry run is off', async () => {
  const h = tickHarness(false)
  await h.tick()
  assert.deepStrictEqual(h.wire, ['POST /transfers/downloads/peerone'],
    'the live tick stopped dispatching: ' + h.wire.join(', '))
  assert.strictEqual(h.state.pending.length, 0, 'the item should have left pending')
  assert.strictEqual(Object.keys(h.state.inflight).length, 1)
})

test('the scheduler tick starts nothing in a dry run, and the file stays pending', async () => {
  const h = tickHarness(true)
  await h.tick()
  assert.deepStrictEqual(h.wire, [],
    'the scheduler tick reached the user\'s real slskd: ' + h.wire.join(', '))
  assert.strictEqual(h.state.pending.length, 1, 'the item must stay pending')
  assert.strictEqual(Object.keys(h.state.inflight).length, 0,
    'nothing may be recorded as in flight when nothing was sent')
})

test('a dry-run refusal is not a peer failure — no retry budget is burned', async () => {
  const h = tickHarness(true)
  // Ten ticks: more than maxAttempts, so if the refusal counted as a failure the
  // file would be out of road and marked terminal by now.
  for (let i = 0; i < 10; i++) await h.tick()

  assert.deepStrictEqual(h.wire, [])
  assert.strictEqual(h.state.pending.length, 1, 'the item was consumed by retries')
  const item = h.state.pending[0]
  assert.strictEqual(item.attempts || 0, 0, 'attempts were spent on a refusal')
  assert.deepStrictEqual(item.tried || [], [],
    'the peer was marked tried for a request that was never sent')
  assert.deepStrictEqual(Object.keys(h.state.done), [],
    'the file was written off: ' + JSON.stringify(h.state.done))
  assert.deepStrictEqual(h.state.peerFailures, {},
    'a peer was benched for a refusal it never saw')
})

test('the held file says, in plain words, why it is sitting there', async () => {
  const h = tickHarness(true)
  await h.tick()
  assert.strictEqual(h.state.pending[0].reason,
    'Dry run — not dispatched to peerone')
})

// ── No write site is left outside the choke ─────────────────────────────────
// The point of a single choke point is that a write added later is covered
// without anyone remembering to gate it. That only holds while every slskd
// request goes through slskdFetch, so the exceptions are pinned by name.

test('nothing writes to slskd except through slskdFetch', () => {
  const raw = [...MAIN.matchAll(/fetch\(\s*`\$\{SLSKD_BASE\}([^`]*)`/g)]
    .map(m => m[1])
  // /session is slskdAcquireToken's login POST — it must stay live so a
  // read-only twin can authenticate at all, and a token grant moves no bytes.
  // The rest are slskdFetch's own three calls and the GET /application health
  // probes. Any NEW entry here is a write that bypassed the choke point.
  assert.deepStrictEqual(raw.sort(), [
    '${endpoint}', '${endpoint}', '${endpoint}',
    '/application', '/application', '/application',
    '/session',
  ].sort(), 'a new raw fetch to slskd appeared outside slskdFetch: ' + raw.join(', '))
})
