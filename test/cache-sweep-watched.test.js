'use strict'
// "Deleting the watched episodes still doesn't work at all" — because it had
// never been built. Eviction from the rewatch cache was pure least-recently-
// used against the size limit; nothing anywhere read whether an episode had
// been watched. So a season you had finished sat on the disk while the season
// you had not started was evicted to make room.
//
// video-cache-sweep-watched deletes finished episodes, with three things it
// must never touch: the file on screen, anything used in the last ten minutes
// (a rewatch in progress), and the keep library — files deliberately
// Downloaded for offline are the viewer's, not the cache's.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const { runHandler } = require('./helpers/lift-ipc')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const HOUR = 60 * 60 * 1000

function entry(key, over) {
  return Object.assign({
    key, path: '/cache/' + key.replace(/[^a-z0-9]+/gi, '_') + '.mkv',
    sizeBytes: 100, savedAt: Date.now() - HOUR, lastUsedAt: Date.now() - HOUR,
  }, over || {})
}

function sweepHarness({ entries, session, keepIndex }) {
  const unlinked = []
  let saved = null
  const sent = []
  const globals = {
    _videoSession: session || { cacheKey: null },
    _videoCacheEntries: () => entries,
    safeSend: (ch, payload) => sent.push([ch, payload]),
    fs: { unlinkSync: p => unlinked.push(p) },
    sideStores: {
      videoCacheIndex: { set: v => { saved = v }, get: () => entries },
      videoKeepIndex: {
        get: () => keepIndex || [],
        set: () => { throw new Error('the keep library must never be written by a cache sweep') },
      },
    },
  }
  return { globals, unlinked, sent, saved: () => saved }
}

test('a finished episode is deleted and dropped from the index', async () => {
  const entries = [entry('tv:1396:s1e5'), entry('tv:1396:s1e6')]
  const h = sweepHarness({ entries })
  const { result } = await runHandler('video-cache-sweep-watched', {
    args: { keys: ['tv:1396:s1e5'] }, globals: h.globals,
  })
  assert.deepEqual(result.deleted, ['tv:1396:s1e5'])
  assert.deepEqual(h.unlinked, ['/cache/tv_1396_s1e5.mkv'])
  assert.deepEqual(h.saved().map(e => e.key), ['tv:1396:s1e6'],
    'the episode you have not seen stays')
})

test('an episode nobody asked about is never touched', async () => {
  const entries = [entry('tv:1396:s1e5'), entry('tv:1396:s1e6')]
  const h = sweepHarness({ entries })
  await runHandler('video-cache-sweep-watched', { args: { keys: [] }, globals: h.globals })
  assert.deepStrictEqual(h.unlinked, [])
  assert.strictEqual(h.saved(), null, 'nothing was rewritten')
})

test('the file on screen right now is never deleted, watched or not', async () => {
  const entries = [entry('tv:1396:s1e5'), entry('tv:1396:s1e6')]
  const h = sweepHarness({ entries, session: { cacheKey: 'tv:1396:s1e5' } })
  const { result } = await runHandler('video-cache-sweep-watched', {
    args: { keys: ['tv:1396:s1e5', 'tv:1396:s1e6'] }, globals: h.globals,
  })
  assert.deepEqual(result.deleted, ['tv:1396:s1e6'])
  assert.deepEqual(h.unlinked, ['/cache/tv_1396_s1e6.mkv'],
    'the picture does not vanish from under the viewer')
})

test('an episode touched in the last ten minutes is left alone — a rewatch is in progress', async () => {
  const entries = [entry('tv:1396:s1e5', { lastUsedAt: Date.now() - 60 * 1000 })]
  const h = sweepHarness({ entries })
  const { result } = await runHandler('video-cache-sweep-watched', {
    args: { keys: ['tv:1396:s1e5'] }, globals: h.globals,
  })
  assert.deepEqual(result.deleted, [])
  assert.deepStrictEqual(h.unlinked, [])
})

test('the On Device page is told, so it repaints itself', async () => {
  const entries = [entry('anime:21:e3')]
  const h = sweepHarness({ entries })
  await runHandler('video-cache-sweep-watched', { args: { keys: ['anime:21:e3'] }, globals: h.globals })
  const ev = h.sent.find(x => x[0] === 'video-event' && x[1] && x[1].kind === 'cache-swept')
  assert.ok(ev, 'nothing announced the sweep: ' + JSON.stringify(h.sent))
  assert.deepEqual(ev[1].keys, ['anime:21:e3'])
})

test('a dry run refuses and unlinks nothing', async () => {
  const entries = [entry('tv:1396:s1e5')]
  const h = sweepHarness({ entries })
  const run = await runHandler('video-cache-sweep-watched', {
    dryRun: true, args: { keys: ['tv:1396:s1e5'] }, globals: h.globals,
  })
  assert.strictEqual(run.result.dryRun, true)
  assert.deepStrictEqual(h.unlinked, [])
  assert.deepStrictEqual(run.calls, [])
})

test('the keep library is never read or written by the sweep', () => {
  // A structural read, because "it did not happen" is the assertion and the
  // handler body is where it would have to happen.
  const start = MAIN.indexOf("ipcMain.handle('video-cache-sweep-watched'")
  const body = MAIN.slice(start, MAIN.indexOf('\n})', start))
  assert.ok(!/videoKeepIndex/.test(body),
    'a cache sweep must never go near the files the viewer chose to Download')
})

// ── the renderer half: which finishes count ─────────────────────────────────

const store = require('../src/video-store')

test('reaching the end of an episode asks for the sweep; pressing Next early does not', () => {
  const swept = []
  store.onWatchedSweep(k => swept.push(k))
  try {
    const s = store.createVideoStore({ storage: store._memoryStorage(), debounceMs: 0 })
    s.markWatched('tv:1396:s1e5', { reason: 'ended' })
    assert.deepStrictEqual(swept, ['tv:1396:s1e5'], 'a finished episode frees its space')

    s.markWatched('tv:1396:s1e6', { reason: 'advance' })
    assert.deepStrictEqual(swept, ['tv:1396:s1e5'],
      'skipping ahead is not finishing — the file stays')

    s.markWatched('tv:1396:s1e7', { reason: 'manual' })
    assert.deepStrictEqual(swept, ['tv:1396:s1e5'],
      'marking a season watched by hand deletes nobody’s files')
  } finally { store.onWatchedSweep(null) }
})

test('watching through to the end by position asks for the sweep too', () => {
  const swept = []
  store.onWatchedSweep(k => swept.push(k))
  try {
    const s = store.createVideoStore({ storage: store._memoryStorage(), debounceMs: 0 })
    s.setPosition('anime:21:e3', { type: 'anime', id: 21, episode: 3 }, 1400, 1440)
    assert.deepStrictEqual(swept, ['anime:21:e3'])
  } finally { store.onWatchedSweep(null) }
})

test('an episode that is only part-watched frees nothing', () => {
  const swept = []
  store.onWatchedSweep(k => swept.push(k))
  try {
    const s = store.createVideoStore({ storage: store._memoryStorage(), debounceMs: 0 })
    s.setPosition('anime:21:e4', { type: 'anime', id: 21, episode: 4 }, 300, 1440)
    assert.deepStrictEqual(swept, [])
  } finally { store.onWatchedSweep(null) }
})

test('the same episode never asks twice', () => {
  const swept = []
  store.onWatchedSweep(k => swept.push(k))
  try {
    const s = store.createVideoStore({ storage: store._memoryStorage(), debounceMs: 0 })
    s.markWatched('movie:550', { reason: 'ended' })
    s.markWatched('movie:550', { reason: 'ended' })
    assert.deepStrictEqual(swept, ['movie:550'])
  } finally { store.onWatchedSweep(null) }
})

// ── the renderer's own gate: the setting ────────────────────────────────────

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftSweep(on) {
  const asked = []
  const start = RENDERER.indexOf('function _sweepWatchedCache(keys) {')
  assert.ok(start > 0)
  const end = RENDERER.indexOf('\n}', start) + 2
  const ctx = {
    console: { warn() {} }, Array, Promise, String,
    _deleteWatchedCache: on,
    window: { api: { videoCacheSweepWatched: p => { asked.push(p); return Promise.resolve({ ok: true, deleted: p.keys }) } } },
  }
  vm.createContext(ctx)
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return { ctx, asked }
}

test('with the setting off nothing is ever deleted', async () => {
  const h = liftSweep(false)
  await h.ctx._sweepWatchedCache(['tv:1396:s1e5'])
  assert.deepStrictEqual(h.asked, [])
})

test('with the setting on the keys are handed over', async () => {
  const h = liftSweep(true)
  await h.ctx._sweepWatchedCache(['tv:1396:s1e5'])
  assert.deepEqual(h.asked, [{ keys: ['tv:1396:s1e5'] }])
})

test('the setting is a real, saved setting and ships on', () => {
  assert.ok(/'deleteWatchedCache'/.test(MAIN), 'the key must be on the save allowlist or writes are dropped')
  assert.ok(/deleteWatchedCache: true/.test(MAIN), 'it ships on')
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')
  assert.ok(/id="video-delete-watched"/.test(HTML), 'there is a checkbox to turn it off')
  assert.ok(/Files you chose to Download are never touched/.test(HTML),
    'and it says what it will not touch')
  assert.ok(/video-delete-watched/.test(RENDERER), 'the checkbox is wired to the save')
})
