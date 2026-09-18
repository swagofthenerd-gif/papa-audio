'use strict'
// Browsing a peer must not hand the whole library across in one reply.
//
// Measured on a large share: 114 MB structure-cloned, 594 ms to serialise in
// main and 1,208 ms to deserialise in the renderer. 1.8 seconds of frozen
// window, none of it interruptible, behind a static "Loading…" with no cancel.
//
// The tree now stays in main and the renderer PULLS it in slices. An earlier
// version of this file claimed to drive "the REAL pull loop" and drove a copy
// of it pasted into the test — so `dirCount: 0` in the shop, which renders
// every peer's library empty, left all seven tests green. This version lifts
// the real pull block out of slsk-shop-ui.js and the real session handlers out
// of main.js, and executes both against stubs at the IPC boundary.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SH = require('../src/slsk-shelves.js')
const T = require('../src/slsk-tree.js')
const ROOT = path.join(__dirname, '..')
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const SHOP = fs.readFileSync(path.join(ROOT, 'src', 'slsk-shop-ui.js'), 'utf8')

function liftFn(src, name) {
  let start = src.indexOf(`async function ${name}(`)
  if (start < 0) start = src.indexOf(`function ${name}(`)
  assert.ok(start > -1, `${name} must still exist`)
  return src.slice(start, src.indexOf('\n}', start) + 2)
}

function share(dirCount, filesPer = 6) {
  const dirs = []
  for (let d = 0; d < dirCount; d++) {
    const files = []
    for (let f = 0; f < filesPer; f++) {
      files.push({ filename: `Artist ${d}\\Album ${d}\\${String(f + 1).padStart(2, '0')} Track.flac`, size: 30e6 })
    }
    dirs.push({ name: `Artist ${d}\\Album ${d}`, files })
  }
  return dirs
}

// ── The REAL pull block from slsk-shop-ui.js ────────────────────────────────

// The block begins at `if (streaming) {` and ends at `tree = treeBuilder.finish()`.
// Inside the shop it lives in show(); a bare `return` there abandons the open.
// Wrapped in an async function here, a bare return yields undefined — which is
// exactly what "abandoned" means for these tests.
function liftPullBlock() {
  const start = SHOP.indexOf('  if (streaming) {\n    const loadingEl')
  assert.ok(start > -1, 'the streaming pull block must still exist')
  const end = SHOP.indexOf('    tree = treeBuilder.finish()', start) + '    tree = treeBuilder.finish()'.length
  // The slice stops before the if-block's closing brace (the source continues
  // into `} else if (...)`), so close it here or nothing compiles.
  return SHOP.slice(start, end) + '\n  }'
}

// dirs: what main holds. `serve` decides what each chunk request gets back.
function shopHarness(dirs, { serve, connected = () => true, endReply = { ok: true, fingerprint: 'fp-real' } } = {}) {
  const calls = { chunks: [], ended: 0, progress: [] }
  const loadingEl = { isConnected: true, set textContent(v) { calls.progress.push(v) } }
  const api = {
    slskBrowseChunk: async ({ token, offset, limit }) => {
      calls.chunks.push({ token, offset, limit })
      if (serve) return serve({ offset, limit })
      return { ok: true, directories: dirs.slice(offset, offset + limit) }
    },
    slskBrowseEnd: async () => { calls.ended++; return endReply },
  }
  const fn = new Function('SH', 'window', 'body', 'dlg', 'res', 'username', 'streaming', `
    return (async function () {
      let tree = null
      let shBrowseFp = null
      ${liftPullBlock()}
      return { tree, shBrowseFp }
    })()
  `)
  const run = () => fn(SH, { api }, { querySelector: () => loadingEl }, { get isConnected() { return connected() } },
    { token: 'tok-1', dirCount: dirs.length }, 'peer', true)
  return { run, calls }
}

test('the real pull block rebuilds a tree identical to a single-shot build', async () => {
  const dirs = share(1200)
  const whole = T.buildTree(dirs)
  const { run, calls } = shopHarness(dirs)
  const out = await run()
  assert.ok(out, 'a complete pull must not be abandoned')
  assert.strictEqual(out.tree.fileCount, whole.fileCount, 'dirCount drives the loop — a zero here renders every library empty')
  assert.strictEqual(out.tree.dirs.size, whole.dirs.size)
  for (const start of ['', 'Artist 0', 'Artist 7\\Album 7']) {
    assert.deepStrictEqual(
      JSON.stringify(T.listDir(out.tree, start, { audioOnly: true })),
      JSON.stringify(T.listDir(whole, start, { audioOnly: true })), 'listDir at ' + JSON.stringify(start))
  }
  assert.strictEqual(calls.chunks.length, 3, '1200 folders at 400 a slice')
  for (const c of calls.chunks) assert.ok(c.limit <= 400, 'a slice must stay small — that is the entire point')
  assert.strictEqual(calls.ended, 1, 'the session is closed exactly once')
})

test('the fingerprint arrives from end, never from the reply, and only if still on screen', async () => {
  const { run } = shopHarness(share(10), { endReply: { ok: true, fingerprint: 'fp-from-end' } })
  const out = await run()
  assert.strictEqual(out.shBrowseFp, 'fp-from-end')
})

test('an expired token abandons the pull — it must not read as a small library', async () => {
  const dirs = share(2000)
  let served = 0
  const { run, calls } = shopHarness(dirs, {
    serve: ({ offset, limit }) => (served++ < 2
      ? { ok: true, directories: dirs.slice(offset, offset + limit) }
      : { ok: false, expired: true, directories: [] }),
  })
  const out = await run()
  assert.strictEqual(out, undefined, 'abandoned, not a truncated tree')
  assert.strictEqual(calls.ended, 1, 'finally still closes the session')
  assert.ok(calls.progress.some(t => /timed out/.test(t)), 'and the user is told why')
})

test('closing the dialog mid-pull simply stops asking', async () => {
  const dirs = share(2000)
  let asked = 0
  const { run, calls } = shopHarness(dirs, { connected: () => asked++ < 2 })
  const out = await run()
  assert.strictEqual(out, undefined)
  assert.ok(calls.chunks.length <= 2, 'no further slices are requested after the close, asked ' + calls.chunks.length)
  assert.strictEqual(calls.ended, 1)
})

test('progress moves as slices land', async () => {
  const { run, calls } = shopHarness(share(800))
  await run()
  const pct = calls.progress.map(t => (t.match(/(\d+)%/) || [])[1]).filter(Boolean).map(Number)
  assert.deepStrictEqual(pct, [50, 100], 'two slices of 400 out of 800')
})

// ── The main-side session handlers, executed ────────────────────────────────

function sessionHarness({ ttlMs = 2 * 60 * 1000 } = {}) {
  const sessions = new Map()
  const clock = { t: 1_700_000_000_000 }
  const shelves = { fingerprintBrowseChunked: () => new Promise(() => {}) }   // not under test here
  const fn = new Function('crypto', 'slskShelves', '_browseSessions', 'BROWSE_SESSION_TTL_MS', 'Date', 'console', `
    ${liftFn(MAIN, '_browseSessionSweep')}
    ${liftFn(MAIN, '_browseSessionOpen')}
    ${liftFn(MAIN, '_browseHead')}
    return { _browseHead, _browseSessionOpen, _browseSessionSweep }
  `)
  const api = fn(require('crypto'), shelves, sessions, ttlMs, { now: () => clock.t }, { warn() {} })
  return { ...api, sessions, clock }
}

test('the head is a few dozen bytes: counts and a token, never the directories', () => {
  const h = sessionHarness()
  const head = h._browseHead(share(300), { fromCache: true, cachedAt: 5 })
  assert.ok(!('directories' in head), 'returning them here puts the 114 MB back on the wire')
  assert.strictEqual(head.dirCount, 300)
  assert.strictEqual(head.fileCount, 1800)
  assert.strictEqual(head.fromCache, true)
  assert.ok(JSON.stringify(head).length < 200, 'this is the whole point of the reply')
})

test('the session holds the SAME array, not a copy', () => {
  const h = sessionHarness()
  const dirs = share(10)
  assert.strictEqual(h.sessions.get(h._browseHead(dirs).token).directories, dirs,
    'a copy would double the very memory this exists to stop moving')
})

test('every open gets its own token', () => {
  const h = sessionHarness()
  assert.notStrictEqual(h._browseHead(share(1)).token, h._browseHead(share(1)).token)
  assert.strictEqual(h.sessions.size, 2)
})

test('abandoned sessions are swept after the TTL, live ones are kept', () => {
  const h = sessionHarness({ ttlMs: 1000 })
  const old = h._browseHead(share(1)).token
  h.clock.t += 1500
  const fresh = h._browseHead(share(1)).token
  assert.strictEqual(h.sessions.has(old), false, 'an unclosed browse must not leak the tree forever')
  assert.strictEqual(h.sessions.has(fresh), true)
})
