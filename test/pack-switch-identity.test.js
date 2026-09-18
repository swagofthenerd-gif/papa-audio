'use strict'
// "Only the first episode of a pack ever caches."
//
// A play stamps the session with the identity of the episode it started on
// (cacheKey / cacheMeta). Switching episode inside the pack never touched
// either, so after moving from episode 5 to 6 the session still said "I am
// episode 5": episode 6's bytes were written under episode 5's name, or — once
// 5 had already been saved (cacheSaved) — nothing after it entered the cache
// at all.
//
// Two behaviours are pinned here, both by running the REAL code:
//   1. video-pack-select adopts the identity the renderer sends, on the
//      torrent branch and the RealDebrid branch alike.
//   2. a copy that started before a switch and lands after it indexes itself
//      under its OWN key, and does not claim the new episode is saved.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const { runHandler } = require('./helpers/lift-ipc')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

const META6 = { type: 'tv', id: 1396, title: 'Breaking Bad', season: 1, episode: 6 }

// ── 1. the handler adopts what the renderer sends ───────────────────────────

test('switching inside a streaming pack moves the cache identity to the new episode', async () => {
  const session = {
    token: 1, cacheKey: 'tv:1396:s1e5', cacheMeta: { episode: 5 },
    cacheSaved: true, cacheSaving: true,
    streamer: { selectFile: () => 'http://127.0.0.1:1/6.mkv', files: () => [] },
  }
  await runHandler('video-pack-select', {
    args: { index: 6, cacheKey: 'tv:1396:s1e6', cacheMeta: META6 },
    globals: { _videoSession: session, _loadIntoActivePlayer: async () => true, safeSend() {} },
  })
  assert.strictEqual(session.cacheKey, 'tv:1396:s1e6')
  assert.deepStrictEqual(session.cacheMeta, META6)
  assert.strictEqual(session.cacheSaved, false, 'the new episode has saved nothing yet')
  assert.strictEqual(session.cacheSaving, false)
})

test('a RealDebrid pack switch moves the identity too', async () => {
  const session = {
    token: 1, cacheKey: 'tv:1396:s1e5', cacheMeta: { episode: 5 },
    cacheSaved: true, cacheSaving: false,
    streamer: null, debrid: { magnet: 'magnet:?xt=urn:btih:1', want: { season: 1, episode: 5 } },
  }
  await runHandler('video-pack-select', {
    args: { index: 6, cacheKey: 'tv:1396:s1e6', cacheMeta: META6 },
    globals: { _videoSession: session, _loadIntoActivePlayer: async () => true, safeSend() {} },
  })
  assert.strictEqual(session.cacheKey, 'tv:1396:s1e6')
  assert.deepStrictEqual(session.cacheMeta, META6)
  assert.strictEqual(session.cacheSaved, false)
})

test('a dry run refuses the debrid switch before touching the identity', async () => {
  const session = {
    token: 1, cacheKey: 'tv:1396:s1e5', cacheMeta: { episode: 5 },
    cacheSaved: true, cacheSaving: false,
    streamer: null, debrid: { magnet: 'magnet:?xt=urn:btih:1', want: null },
  }
  const { result } = await runHandler('video-pack-select', {
    dryRun: true,
    args: { index: 6, cacheKey: 'tv:1396:s1e6', cacheMeta: META6 },
    globals: { _videoSession: session, _loadIntoActivePlayer: async () => true, safeSend() {} },
  })
  assert.strictEqual(result && result.dryRun, true)
  assert.strictEqual(session.cacheKey, 'tv:1396:s1e5', 'a refused switch changes nothing')
})

test('a switch with no identity (an unidentified play) leaves the session alone', async () => {
  const session = {
    token: 1, cacheKey: 'tv:1396:s1e5', cacheMeta: { episode: 5 },
    cacheSaved: true, cacheSaving: false,
    streamer: { selectFile: () => 'http://127.0.0.1:1/6.mkv', files: () => [] },
  }
  await runHandler('video-pack-select', {
    args: { index: 6 },
    globals: { _videoSession: session, _loadIntoActivePlayer: async () => true, safeSend() {} },
  })
  assert.strictEqual(session.cacheKey, 'tv:1396:s1e5')
})

// ── 2. a copy that lands after a switch must not claim the new episode ──────

// _maybeCacheCurrentFile, lifted whole, with fs and the index as spies.
function liftCacheCurrent({ session, onIndexAdd }) {
  const added = []
  let resolveCopy = null
  const copied = new Promise(r => { resolveCopy = r })
  const ctx = {
    console: { warn() {}, error() {}, log() {} },
    Number, Promise, Date, String, Boolean, Math, JSON, Array, Object,
    _videoSession: session,
    _videoSettings: () => ({ videoCacheGB: 15 }),
    _currentFileInfo: () => ({ path: '/stream/ep5.mkv', name: 'ep5.mkv', total: 100, downloaded: 100 }),
    _videoCacheRoot: () => '/cache',
    _cacheEntryFor: (key, meta, info, dest, size) => ({ key, meta, path: dest, sizeBytes: size }),
    _videoCacheIndexAdd: e => { added.push(e); return onIndexAdd === undefined ? true : onIndexAdd },
    videoCache: { fileNameFor: key => String(key).replace(/[^A-Za-z0-9]+/g, '_') + '.mkv' },
    path: { join: (...a) => a.join('/') },
    fs: {
      unlinkSync() {},
      promises: {
        mkdir: async () => {},
        copyFile: async () => { resolveCopy(); await new Promise(r => setTimeout(r, 0)) },
        rename: async () => {},
      },
    },
  }
  vm.createContext(ctx)
  const start = MAIN.indexOf('function _maybeCacheCurrentFile(streamer) {')
  assert.ok(start > 0)
  const end = MAIN.indexOf('\n}', start) + 2
  vm.runInContext(MAIN.slice(start, end), ctx)
  return { ctx, added, copied }
}

test('a copy that lands after the viewer moved on indexes its own episode and claims nothing', async () => {
  const session = { cacheKey: 'tv:1396:s1e5', cacheMeta: { episode: 5 }, cacheSaved: false, cacheSaving: false }
  const { ctx, added, copied } = liftCacheCurrent({ session })
  ctx._maybeCacheCurrentFile({})
  await copied
  // The viewer clicks episode 6 while the copy of 5 is still in flight.
  session.cacheKey = 'tv:1396:s1e6'
  session.cacheMeta = META6
  session.cacheSaved = false
  await new Promise(r => setTimeout(r, 5))
  assert.strictEqual(added.length, 1)
  assert.strictEqual(added[0].key, 'tv:1396:s1e5', 'the bytes that landed ARE episode 5')
  assert.strictEqual(session.cacheSaved, false,
    'episode 6 is not on disk just because episode 5 finished copying')
})

test('a copy that lands while the viewer is still on that episode does mark it saved', async () => {
  const session = { cacheKey: 'tv:1396:s1e5', cacheMeta: { episode: 5 }, cacheSaved: false, cacheSaving: false }
  const { ctx, added, copied } = liftCacheCurrent({ session })
  ctx._maybeCacheCurrentFile({})
  await copied
  await new Promise(r => setTimeout(r, 5))
  assert.strictEqual(added.length, 1)
  assert.strictEqual(session.cacheSaved, true)
})

// ── 3. the renderer sends the identity at all ───────────────────────────────

test('the renderer works out the episode from the strip and sends it with the switch', async () => {
  const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const start = RENDERER.indexOf('async function _switchPackEpisode(index, opts) {')
  assert.ok(start > 0)
  const end = RENDERER.indexOf('\n}', start) + 2
  const sent = []
  const ctx = {
    console: { warn() {}, log() {} }, Array, Number, String, Object, Promise, setTimeout,
    _player: { setStageMessage() {}, setPack() {}, setSegments() {} },
    _packFiles: [{ index: 4, episode: 5 }, { index: 7, episode: 6 }],
    _videoDetail: { type: 'tv', d: { id: 1396, title: 'Breaking Bad', poster: 'p.jpg' } },
    _videoState: { season: 1, episode: 5 },
    _watch: {},
    _watchKey: require('../src/watch-key').watchKey,
    _setPackFiles() {},
    _keepPackEpisode() {},
    _loadSkipSegments() {},
    esc: s => s,
    _videoErrorText: s => s,
    window: { api: { videoPackSelect: p => { sent.push(p); return Promise.resolve({ ok: true, files: [] }) } } },
  }
  vm.createContext(ctx)
  vm.runInContext(RENDERER.slice(start, end), ctx)
  await ctx._switchPackEpisode(7, {})
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].index, 7)
  assert.strictEqual(sent[0].cacheKey, 'tv:1396:s1e6',
    'the key names the episode being switched TO, not the one that was playing')
  assert.strictEqual(sent[0].cacheMeta.episode, 6)
  assert.strictEqual(sent[0].cacheMeta.title, 'Breaking Bad')
})
