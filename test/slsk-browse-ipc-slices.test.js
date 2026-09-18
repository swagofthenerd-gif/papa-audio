'use strict'
// Browsing a peer must not hand the whole library across in one reply.
//
// Measured on a large share: 114 MB structure-cloned, 594 ms to serialise in
// main and 1,208 ms to deserialise in the renderer. 1.8 seconds of frozen
// window, none of it interruptible, behind a static "Loading…" with no cancel.
//
// The tree now stays in main and the renderer pulls it in slices. The first
// half of this file drives the REAL pull contract against the REAL
// createTreeBuilder. The second half lifts the real session handlers out of
// main.js and executes them — an earlier version pinned their spelling
// instead, which test-guard's Rule 1 exists to forbid.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SH = require('../src/slsk-shelves.js')
const T = require('../src/slsk-tree.js')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function liftFn(name) {
  const start = MAIN.indexOf(`function ${name}(`)
  assert.ok(start > -1, `${name} must still exist in main.js`)
  return MAIN.slice(start, MAIN.indexOf('\n}', start) + 2)
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

// ── The pull contract, against the real tree builder ────────────────────────

async function pull(dirs, { limit = 400, expireAfter = Infinity } = {}) {
  const calls = []
  let served = 0
  const chunk = async ({ offset, limit: n }) => {
    calls.push({ offset, limit: n })
    if (served >= expireAfter) return { ok: false, expired: true, directories: [] }
    served++
    return { ok: true, directories: dirs.slice(offset, offset + n) }
  }
  const tb = SH.createTreeBuilder()
  for (let off = 0; off < dirs.length; off += limit) {
    const part = await chunk({ token: 't', offset: off, limit })
    if (!part.ok) return { tree: null, calls, expired: true }
    tb.add(part.directories)
  }
  return { tree: tb.finish(), calls, expired: false }
}

test('a tree built from slices is identical to one built in one go', async () => {
  const dirs = share(1200)
  const whole = T.buildTree(dirs)
  const { tree } = await pull(dirs, { limit: 400 })
  assert.strictEqual(tree.fileCount, whole.fileCount)
  assert.strictEqual(tree.dirs.size, whole.dirs.size)
  for (const start of ['', 'Artist 0', 'Artist 7\\Album 7']) {
    assert.deepStrictEqual(
      JSON.stringify(T.listDir(tree, start, { audioOnly: true })),
      JSON.stringify(T.listDir(whole, start, { audioOnly: true })),
      'listDir must agree at ' + JSON.stringify(start))
  }
})

test('it is identical at every slice size, including boundaries that split a folder', async () => {
  const dirs = share(97, 3)
  const whole = JSON.stringify(T.listDir(T.buildTree(dirs), '', { audioOnly: false }))
  for (const limit of [1, 2, 7, 96, 97, 98, 400]) {
    const { tree } = await pull(dirs, { limit })
    assert.strictEqual(JSON.stringify(T.listDir(tree, '', { audioOnly: false })), whole, 'slice size ' + limit)
  }
})

test('no single slice is anywhere near the whole library', async () => {
  const { calls } = await pull(share(4000), { limit: 400 })
  assert.ok(calls.length >= 10, 'a 4000-folder share must take many slices, took ' + calls.length)
  for (const c of calls) assert.ok(c.limit <= 400, 'a slice must stay small — that is the entire point')
})

test('an expired token stops the pull instead of reading as the end of the library', async () => {
  const { tree, expired } = await pull(share(2000), { limit: 400, expireAfter: 2 })
  assert.strictEqual(expired, true)
  assert.strictEqual(tree, null, 'a truncated pull must produce no tree at all')
})

// ── The main-side session handlers, executed ────────────────────────────────

function sessionHarness({ ttlMs = 2 * 60 * 1000, now } = {}) {
  const sessions = new Map()
  const clock = { t: now || 1_700_000_000_000 }
  const shelves = { fingerprintBrowseChunked: () => new Promise(() => {}) }   // never resolves; not under test here
  const fn = new Function('crypto', 'slskShelves', '_browseSessions', 'BROWSE_SESSION_TTL_MS', 'Date', 'console', `
    ${liftFn('_browseSessionSweep')}
    ${liftFn('_browseSessionOpen')}
    ${liftFn('_browseHead')}
    return { _browseHead, _browseSessionOpen, _browseSessionSweep }
  `)
  const FakeDate = { now: () => clock.t }
  const api = fn(require('crypto'), shelves, sessions, ttlMs, FakeDate, { warn() {} })
  return { ...api, sessions, clock }
}

test('the head is a few dozen bytes: counts and a token, never the directories', () => {
  const h = sessionHarness()
  const dirs = share(300)
  const head = h._browseHead(dirs, { fromCache: true, cachedAt: 5 })
  assert.ok(!('directories' in head), 'returning them here puts the 114 MB back on the wire')
  assert.strictEqual(head.dirCount, 300)
  assert.strictEqual(head.fileCount, 1800)
  assert.strictEqual(head.fromCache, true)
  assert.strictEqual(head.cachedAt, 5)
  assert.ok(JSON.stringify(head).length < 200, 'this is the whole point of the reply')
})

test('the session holds the SAME array, not a copy', () => {
  const h = sessionHarness()
  const dirs = share(10)
  const head = h._browseHead(dirs)
  assert.strictEqual(h.sessions.get(head.token).directories, dirs,
    'a copy would double the very memory this exists to stop moving')
})

test('every open gets its own token', () => {
  const h = sessionHarness()
  const a = h._browseHead(share(1)).token
  const b = h._browseHead(share(1)).token
  assert.notStrictEqual(a, b)
  assert.strictEqual(h.sessions.size, 2)
})

test('abandoned sessions are swept after the TTL, live ones are kept', () => {
  const h = sessionHarness({ ttlMs: 1000 })
  const old = h._browseHead(share(1)).token
  h.clock.t += 1500
  const fresh = h._browseHead(share(1)).token           // opening sweeps
  assert.strictEqual(h.sessions.has(old), false, 'an unclosed browse must not leak the tree forever')
  assert.strictEqual(h.sessions.has(fresh), true)
})
