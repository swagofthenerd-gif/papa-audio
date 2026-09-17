'use strict'
// Browsing a peer must not hand the whole library across in one reply.
//
// Measured on a large share: 114 MB structure-cloned, 594 ms to serialise in
// main and 1,208 ms to deserialise in the renderer. 1.8 seconds of frozen
// window, none of it interruptible, behind a static "Loading…" with no cancel.
//
// The tree now stays in main and the renderer pulls it in slices. This drives
// the REAL pull loop lifted out of slsk-shop-ui.js against fake IPC, and the
// REAL createTreeBuilder, so the assertion is about what actually happens.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SH = require('../src/slsk-shelves.js')
const T = require('../src/slsk-tree.js')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

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

// The pull loop, reduced to its contract: slice, build, finish.
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
  // The whole refactor rests on this.
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
    assert.strictEqual(JSON.stringify(T.listDir(tree, '', { audioOnly: false })), whole,
      'slice size ' + limit + ' must not change the answer')
  }
})

test('no single slice is anywhere near the whole library', async () => {
  const dirs = share(4000)
  const { calls } = await pull(dirs, { limit: 400 })
  assert.ok(calls.length >= 10, 'a 4000-folder share must take many slices, took ' + calls.length)
  for (const c of calls) {
    assert.ok(c.limit <= 400, 'a slice must stay small — that is the entire point')
  }
})

test('an expired token stops the pull instead of reading as the end of the library', async () => {
  // The dangerous failure: a short tree looks like a peer with a small share.
  const dirs = share(2000)
  const { tree, expired } = await pull(dirs, { limit: 400, expireAfter: 2 })
  assert.strictEqual(expired, true)
  assert.strictEqual(tree, null, 'a truncated pull must produce no tree at all')
})

test('main hands back a head, not the directories', () => {
  const at = MAIN.indexOf("ipcMain.handle('slsk-browse-begin'")
  assert.ok(at > -1, 'the begin handler must exist')
  const body = MAIN.slice(at, MAIN.indexOf('\n})', at)).replace(/^[ \t]*\/\/.*$/gm, '')
  assert.doesNotMatch(body, /directories:/,
    'returning the directories here would put the 114 MB back on the wire')
  const head = MAIN.slice(MAIN.indexOf('function _browseHead'), MAIN.indexOf('\n}', MAIN.indexOf('function _browseHead')))
  assert.match(head, /token/)
  assert.match(head, /dirCount/)
  assert.match(head, /fingerprint/, 'main fingerprints it while it still holds the array')
})

test('the session holds a reference, not a copy', () => {
  const fn = MAIN.slice(MAIN.indexOf('function _browseSessionOpen'), MAIN.indexOf('\n}', MAIN.indexOf('function _browseSessionOpen')))
  assert.doesNotMatch(fn, /\.slice\(\)|\[\s*\.\.\./,
    'copying the array would double the very memory this exists to stop moving')
})

test('abandoned sessions are swept, so an unclosed browse cannot leak the tree', () => {
  assert.match(MAIN, /_browseSessionSweep/)
  assert.match(MAIN, /BROWSE_SESSION_TTL_MS/)
})
