'use strict'
// "Keep this episode" — the real video-keep-file handler, run.
//
// The handler destructured an `index` argument and then, further down, declared
// `const index = ...` for the kept-file list. One `const` per block shadows the
// whole block, so the earlier `streamer.fileInfo(Number(index))` sat in the
// temporal dead zone and EVERY keep threw "Cannot access 'index' before
// initialization". Nothing caught it because no test had ever run the handler —
// only its pure helpers in video-keep.js.
//
// So these tests lift the real source out of main.js (test/helpers/lift-ipc.js)
// and call it the way preload.js does: videoKeepFile(index, show) →
// invoke('video-keep-file', { index, show }).

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const crypto = require('crypto')
const { runHandler } = require('./helpers/lift-ipc')
const videoKeep = require('../src/video-keep')

const CACHE_FILE = '/tmp/papa-stream-cache/Show.S01E03.1080p.mkv'
const KEEP_ROOT = '/tmp/papa-keep-root'

// A world the handler can walk all the way through: one complete file on disk,
// a writable destination, no quota. Records the copy rather than doing it.
function world(over = {}) {
  const copies = []
  const written = []
  const files = over.files || [{
    index: 0, name: 'Show.S01E03.1080p.mkv', path: CACHE_FILE,
    total: 4_000_000_000, downloaded: 4_000_000_000,
  }]
  let stored = over.kept || []
  return {
    copies, written,
    get kept() { return stored },
    globals: {
      DRY_RUN: false,
      path, crypto, videoKeep,
      _videoSession: {
        debrid: over.debrid || null,
        streamer: over.noStreamer ? null : {
          fileInfo(i) { return files.find(f => f.index === Number(i)) || null },
        },
      },
      _videoSettings: () => ({ videoKeepQuotaGB: over.quotaGB || 0 }),
      _keepVideosRoot: () => KEEP_ROOT,
      freeSpaceAt: () => 1e13,
      dlCapacity: { check: () => ({ ok: true }) },
      fs: {
        existsSync: p => p === CACHE_FILE,
        mkdirSync(p) { written.push(p) },
        statSync: () => ({ size: 4_000_000_000 }),
        rmSync() {},
        promises: {
          async copyFile(from, to) { copies.push({ from, to }) },
        },
      },
      sideStores: {
        videoKeepIndex: {
          get: () => stored,
          set(v) { stored = v },
          update(fn) { stored = fn(stored) },
        },
      },
    },
  }
}

test('video-keep-file copies the episode the caller asked for and answers with its path', async () => {
  const w = world()
  const { result, error } = await runHandler('video-keep-file', {
    args: { index: 0, show: 'The Bear' }, globals: w.globals,
  })
  assert.strictEqual(error, null, 'the handler must not throw')
  assert.ok(result && result.ok === true, 'expected ok, got ' + JSON.stringify(result))
  // The destination is derived from the show title and the file name.
  assert.strictEqual(result.path, KEEP_ROOT + '/The Bear/Show.S01E03.1080p.mkv')
  // And the copy really was asked for, out of the stream cache.
  assert.deepStrictEqual(w.copies, [{ from: CACHE_FILE, to: result.path }])
  // The kept-file index gained exactly one entry, for that path.
  assert.strictEqual(w.kept.length, 1)
  assert.strictEqual(w.kept[0].path, result.path)
  assert.strictEqual(w.kept[0].title, 'The Bear')
})

test('video-keep-file reads the FILE index it was handed, not the kept-file list', async () => {
  // Two files in the pack. Asking for index 1 must reach file 1 — the bug made
  // any read of the argument throw, and a naive "just rename it" fix could as
  // easily have wired the recomputed kept-file list into fileInfo().
  const w = world({
    files: [
      { index: 0, name: 'E01.mkv', path: CACHE_FILE, total: 10, downloaded: 10 },
      { index: 1, name: 'E02.mkv', path: CACHE_FILE, total: 10, downloaded: 10 },
    ],
  })
  const { result, error } = await runHandler('video-keep-file', {
    args: { index: 1, show: 'The Bear' }, globals: w.globals,
  })
  assert.strictEqual(error, null)
  assert.ok(result && result.ok === true, JSON.stringify(result))
  assert.strictEqual(result.path, KEEP_ROOT + '/The Bear/E02.mkv')
})

test('video-keep-file still counts an existing keep against the quota', async () => {
  // The kept-file list is the thing the quota gate reads, so the rename must
  // have left THAT use pointing at the list — not at the file index.
  const w = world({
    quotaGB: 5,
    kept: [{ id: 'a', title: 'Old', path: KEEP_ROOT + '/Old/old.mkv', sizeBytes: 4_000_000_000 }],
  })
  const { result, error } = await runHandler('video-keep-file', {
    args: { index: 0, show: 'The Bear' }, globals: w.globals,
  })
  assert.strictEqual(error, null)
  assert.ok(result && result.ok === false)
  assert.strictEqual(result.error, 'quota')
  assert.strictEqual(result.usedBytes, 4_000_000_000)
  assert.strictEqual(result.limitBytes, 5_000_000_000)
  assert.strictEqual(w.copies.length, 0, 'a refused keep must not copy anything')
})

test('video-keep-file refuses a half-downloaded episode without copying', async () => {
  const w = world({
    files: [{ index: 0, name: 'E01.mkv', path: CACHE_FILE, total: 100, downloaded: 40 }],
  })
  const { result, error } = await runHandler('video-keep-file', {
    args: { index: 0, show: 'The Bear' }, globals: w.globals,
  })
  assert.strictEqual(error, null)
  assert.ok(result && result.ok === false)
  assert.match(result.error, /not finished downloading/)
  assert.strictEqual(w.copies.length, 0)
})
