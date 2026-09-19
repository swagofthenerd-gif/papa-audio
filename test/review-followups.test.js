'use strict'
// Follow-ups from an adversarial review of the 17–18 Sep work.
//
// Two of them are about fixes that shipped with green tests and did not do
// what they said: the anime-episodes handler became honest at the wire while
// the screen showed the same nothing, and a browse fingerprint was moved onto
// the main thread under a comment claiming ~11 ms that measures at 95–183 ms.
//
// A first version of this file pinned the SPELLING of the fixes — regexes over
// main.js for `setImmediate`, `fingerprint`, `done.fingerprint`. A variable
// rename turned one red the same evening while the behaviour was intact, which
// is exactly the failure test-guard's Rule 1 describes. Everything below lifts
// the real functions out of main.js / renderer.js and EXECUTES them against
// stubs at the system boundary. The single remaining source-order check says
// so in its name.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8')
const SHOP = fs.readFileSync(path.join(ROOT, 'src', 'slsk-shop-ui.js'), 'utf8')
const dlSched = require('../src/download-scheduler.js')
const SH = require('../src/slsk-shelves.js')

// Slice a top-level `function name(` … `\n}` out of a source string.
function liftFn(src, name) {
  // `async function x(` contains `function x(`; slicing from the inner match
  // drops the `async` and the body's awaits then fail to compile. Look for the
  // async form first.
  let start = src.indexOf(`async function ${name}(`)
  if (start < 0) start = src.indexOf(`function ${name}(`)
  assert.ok(start > -1, `${name} must still exist`)
  const end = src.indexOf('\n}', start) + 2
  return src.slice(start, end)
}

// ── 1. A failed episode fetch is SAID on screen ─────────────────────────────

function runEpisodes(res) {
  const start = RENDERER.indexOf("const list = document.getElementById('video-episode-list')\n      const EL = typeof PapaEpisodeList")
  assert.ok(start > -1, 'the episode-titles block must still exist')
  const block = RENDERER.slice(start, RENDERER.indexOf('const byN = {}', start))
  const list = { html: [], querySelector: () => null, insertAdjacentHTML(_, h) { this.html.push(h) } }
  const ctx = vm.createContext({
    res, document: { getElementById: id => (id === 'video-episode-list' ? list : null) },
    PapaEpisodeList: { rows: () => [] }, esc: s => String(s), _shortQ: (s, n) => String(s).slice(0, n), Array,
  })
  vm.runInContext('(function(){' + block + '\n})()', ctx)
  return list
}

test('a FAILED fetch paints a note into the episode list instead of returning silently', () => {
  const list = runEpisodes({ ok: false, failed: true, episodes: [], error: 'ECONNRESET' })
  assert.strictEqual(list.html.length, 1)
  assert.match(list.html[0], /could not be fetched/)
  assert.match(list.html[0], /ECONNRESET/, 'the reason rides along')
})

test('a genuinely EMPTY answer still paints nothing — that is not a failure', () => {
  assert.deepStrictEqual(runEpisodes({ ok: true, episodes: [] }).html, [])
})

test('a null answer (renderer-side catch) paints nothing and does not throw', () => {
  assert.deepStrictEqual(runEpisodes(null).html, [])
})

// ── 2. The browse fingerprint is off the reply path ─────────────────────────

// Builds the real session-open / head pair with the shelves module stubbed at
// the boundary, so the test can see WHICH hash was called and WHEN.
function browseHarness() {
  const calls = { sync: 0, chunked: 0, chunkedOpts: null }
  let resolveHash
  const slskShelves = {
    fingerprintBrowse() { calls.sync++; throw new Error('the synchronous hash must never run on the reply path') },
    fingerprintBrowseChunked(_dirs, opts) { calls.chunked++; calls.chunkedOpts = opts; return new Promise(r => { resolveHash = r }) },
  }
  const sessions = new Map()
  const fn = new Function('crypto', 'slskShelves', '_browseSessions', 'BROWSE_SESSION_TTL_MS', 'console', `
    ${liftFn(MAIN, '_browseSessionSweep')}
    ${liftFn(MAIN, '_browseSessionOpen')}
    ${liftFn(MAIN, '_browseHead')}
    return { _browseHead, _browseSessionOpen, _browseSessionSweep }
  `)
  const api = fn(require('crypto'), slskShelves, sessions, 2 * 60 * 1000, { warn() {} })
  return { ...api, calls, sessions, finishHash: fp => resolveHash(fp) }
}

test('opening a browse never runs the synchronous hash, and does not wait for the chunked one', () => {
  const h = browseHarness()
  const dirs = [{ name: 'A', files: [{ filename: 'A\\1.flac', size: 1 }] }]
  const head = h._browseHead(dirs)                       // returns synchronously
  assert.strictEqual(h.calls.sync, 0, '183 ms on the main thread per shop open')
  assert.strictEqual(h.calls.chunked, 1, 'the sliced hash is started in the background')
  assert.ok(!('fingerprint' in head), 'the reply does not carry a fingerprint; end does')
  assert.strictEqual(head.dirCount, 1)
  assert.strictEqual(head.fileCount, 1)
  assert.ok(typeof head.token === 'string' && head.token.length === 32)
})

test('the background hash yields with a Node-safe primitive and lands on the session', async () => {
  const h = browseHarness()
  const head = h._browseHead([{ name: 'A', files: [] }])
  assert.strictEqual(typeof h.calls.chunkedOpts.yieldFn, 'function', 'main has no requestIdleCallback')
  await h.calls.chunkedOpts.yieldFn()                    // must resolve, not throw
  h.finishHash('fp-1')
  await new Promise(r => setImmediate(r))
  assert.strictEqual(h.sessions.get(head.token).fingerprint, 'fp-1')
})

test('a session that was closed before the hash finished is told to stop', () => {
  const h = browseHarness()
  const head = h._browseHead([{ name: 'A', files: [] }])
  assert.strictEqual(h.calls.chunkedOpts.shouldAbort(), false)
  h.sessions.delete(head.token)
  assert.strictEqual(h.calls.chunkedOpts.shouldAbort(), true, 'no point hashing for nobody')
})

test('the chunked hash really runs in a bare Node context with that yield, and agrees with the one-shot', async () => {
  const dirs = []
  for (let d = 0; d < 400; d++) dirs.push({ name: 'A\\B' + d, files: [{ filename: 'A\\B' + d + '\\01.flac', size: 1 }] })
  const fp = await SH.fingerprintBrowseChunked(dirs, { budgetMs: 1, yieldFn: () => new Promise(r => setImmediate(r)) })
  assert.strictEqual(fp, SH.fingerprintBrowse(dirs))
})

// ── 3. One fetch rule for both browse entry points ──────────────────────────

function fetchRuleHarness({ cached = null, failWith = [] } = {}) {
  const log = { fetches: [], refreshed: 0, written: 0 }
  let attempt = 0
  const fn = new Function('_browseCacheRead', '_browseRefresh', '_browseFetch', '_browseCacheWrite', '_browseRecordDiff', `
    ${liftFn(MAIN, '_browseDirectories')}
    return _browseDirectories
  `)
  const run = fn(
    () => cached,
    () => { log.refreshed++ },
    async (_u, deadline) => { log.fetches.push(deadline); const e = failWith[attempt++]; if (e) throw new Error(e); return [{ name: 'D', files: [] }] },
    () => { log.written++ },
    () => {},
  )
  return { run, log }
}

test('a cache hit answers instantly and refreshes in the background — no fetch', async () => {
  const h = fetchRuleHarness({ cached: { directories: [{ name: 'C' }], cachedAt: 123 } })
  const got = await h.run('peer')
  // newDirs is always an array on the internal reply (the IPC boundary drops
  // it when empty) — the visit is recorded even on a cache hit.
  assert.deepStrictEqual(got, { ok: true, dirs: [{ name: 'C' }], fromCache: true, cachedAt: 123, newDirs: [] })
  assert.deepStrictEqual(h.log.fetches, [])
  assert.strictEqual(h.log.refreshed, 1)
})

test('a timeout gets exactly ONE retry, on the longer deadline', async () => {
  const h = fetchRuleHarness({ failWith: ['request timed out'] })
  const got = await h.run('peer')
  assert.strictEqual(got.ok, true)
  assert.deepStrictEqual(h.log.fetches, [30000, 60000], 'first at 30 s, retry at 60 s')
  assert.strictEqual(h.log.written, 1, 'the successful attempt is cached once')
})

test('a second timeout is the answer — no third attempt', async () => {
  const h = fetchRuleHarness({ failWith: ['request timed out', 'request timed out again'] })
  const got = await h.run('peer')
  assert.deepStrictEqual(got, { ok: false, error: 'request timed out again' })
  assert.strictEqual(h.log.fetches.length, 2)
})

test('a non-timeout failure is not retried', async () => {
  const h = fetchRuleHarness({ failWith: ['slskd 404 on GET /users/peer/browse'] })
  const got = await h.run('peer')
  assert.strictEqual(got.ok, false)
  assert.match(got.error, /404/)
  assert.deepStrictEqual(h.log.fetches, [30000], 'a peer who is offline does not get a longer wait')
})

// ── 4. The hunt refuses loudly when it cannot identify the file ─────────────

test('sameRecordingSize with an unknown wanted size is false — the premise', () => {
  assert.strictEqual(dlSched.sameRecordingSize(0, 5e7), false)
  assert.strictEqual(dlSched.sameRecordingSize(null, 5e7), false)
})

test('dlSearchAlbum with no wanted size logs a refusal and issues NO search', async () => {
  const fetches = []
  const logged = []
  const fn = new Function('slskdFetch', 'dlSched', 'dlState', 'console', 'dlBaseName', `
    ${liftFn(MAIN, 'dlSearchAlbum')}
    return dlSearchAlbum
  `)(
    async (...a) => { fetches.push(a); return { id: 'x' } },
    { ...dlSched, logSubstitution: (_, e) => logged.push(e) },
    {}, { warn() {}, error() {} }, p => String(p).split(/[\\/]/).pop(),
  )
  assert.deepStrictEqual(await fn('some album name', ['01 - Intro.flac'], 0), [])
  assert.strictEqual(fetches.length, 0, 'must not spend a 15-second slskd search that cannot succeed')
  assert.strictEqual(logged.length, 1)
  assert.match(logged[0].reason, /no known size/)
  assert.strictEqual(logged[0].accepted, false)
})

// ── 5. The On Device action guards its re-render ────────────────────────────

function deviceActionHarness(rowsPresent) {
  const renders = []
  const fn = new Function('document', '_renderDeviceTab', '_videoCatalogTicket', 'showSnackbar', '_shortQ', `
    ${liftFn(RENDERER, '_deviceAction')}
    return _deviceAction
  `)
  const run = fn(
    { getElementById: id => (id === 'vrows' && rowsPresent ? { id } : null) },
    (rows, t) => { renders.push({ rows: rows && rows.id, t }) },
    9, () => {}, s => String(s),
  )
  return { run, renders }
}

test('after the action, the page repaints only if it is still on screen', async () => {
  const there = deviceActionHarness(true)
  await there.run(Promise.resolve({ ok: true }), 'done', 'failed')
  assert.deepStrictEqual(there.renders, [{ rows: 'vrows', t: 9 }])

  const gone = deviceActionHarness(false)
  const out = await gone.run(Promise.resolve({ ok: true }), 'done', 'failed')
  assert.deepStrictEqual(gone.renders, [], 'navigating away mid-action must not dereference a missing mount')
  assert.deepStrictEqual(out, { ok: true }, 'and the result still comes back')
})

test('a rejected action is reported, not thrown, and still does not repaint a missing page', async () => {
  const gone = deviceActionHarness(false)
  const out = await gone.run(Promise.reject(new Error('boom')), 'done', 'failed')
  assert.strictEqual(out, null)
  assert.deepStrictEqual(gone.renders, [])
})

// ── 6. Source order: the refresh listener exists before the pull starts ─────

test('[source order] the shop subscribes to slsk-browse-refreshed BEFORE it begins the pull', () => {
  // The one property here that is genuinely about the ORDER of statements in
  // a 500-line function, and cannot be observed without a DOM harness. Stated
  // as what it is. The pull takes seconds; a refresh landing with no listener
  // leaves stale data on screen for a whole cycle.
  const sub = SHOP.indexOf('onSlskBrowseRefreshed(async')
  const begin = SHOP.indexOf('slskBrowseBegin({ username })')
  assert.ok(sub > -1 && begin > -1)
  assert.ok(sub < begin, `subscription at ${sub} must precede the pull at ${begin}`)
})
