'use strict'
// B1: an unreadable video-store.json must not read back as "first run".
//
// The chain this exercises is the real one, end to end, with no stubs in the
// middle: a truncated file on disk -> the real SideStore._load (which renames
// it aside and adopts its `null` fallback) -> the real main.js bridge-shape
// helpers and IPC handler bodies, sliced out of main.js -> the real
// createVideoStore bridge hydration. The failure being guarded is that the
// renderer could not tell main's "I could not read it" null from a genuine
// first run, called the history empty, and then wrote that emptiness through
// -- destroying the rolling backup on the launch after that.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { SideStore } = require('../side-store')
const { createVideoStore, _memoryBridge } = require('../src/video-store')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function extract(name, fromMarker, toMarker) {
  const start = MAIN.indexOf(fromMarker)
  const end = MAIN.indexOf(toMarker, start + fromMarker.length)
  assert.ok(start > -1 && end > start, `could not slice ${name}`)
  return MAIN.slice(start, end)
}

// The two bridge shape helpers exactly as main.js defines them.
function loadShapeHelpers() {
  const readText = extract('read helper',
    'function _videoStoreReadText(value) {',
    'function _videoStoreWriteValue(text) {')
  const writeValue = extract('write helper',
    'function _videoStoreWriteValue(text) {',
    'ipcMain.handle(\'video-store-read\'')
  // eslint-disable-next-line no-new-func
  return new Function(readText + '\n' + writeValue +
    '\nreturn { _videoStoreReadText, _videoStoreWriteValue }')()
}

// The four IPC handler bodies from main.js, lifted verbatim into a bridge
// object of the shape preload.js exposes to the renderer. This is the seam the
// renderer actually talks to; the bodies are the handlers' own source.
function loadBridgeHandlers(sideStores) {
  const block = extract('handlers',
    'ipcMain.handle(\'video-store-read\'',
    '// ── Liked albums')
  const bodies = {}
  const ipcMain = {
    handle(channel, fn) { bodies[channel] = fn },
  }
  const { _videoStoreReadText, _videoStoreWriteValue } = loadShapeHelpers()
  // eslint-disable-next-line no-new-func
  new Function('ipcMain', 'sideStores', '_videoStoreReadText', '_videoStoreWriteValue', block)(
    ipcMain, sideStores, _videoStoreReadText, _videoStoreWriteValue)
  return {
    read: async () => bodies['video-store-read'](),
    write: async text => bodies['video-store-write'](null, text),
    readBackup: async () => bodies['video-store-read-backup'](),
    writeBackup: async text => bodies['video-store-write-backup'](null, text),
  }
}

// A PapaLocal-shaped localStorage fake. Post-migration the live key is gone --
// which is why the bridge's null is the only thing the renderer has to go on.
function fakeLocal(data) {
  const m = new Map(Object.entries(data || {}))
  return {
    readRaw: k => (m.has(k) ? m.get(k) : null),
    writeRaw: (k, t) => { m.set(k, String(t)); return true },
    write: (k, v) => { m.set(k, JSON.stringify(v)); return true },
    remove: k => { m.delete(k); return true },
    _map: m,
  }
}

// One launch of the app: fresh SideStores over the same directory, fresh
// handler bodies, fresh store. Mirrors main.js's own construction (same names,
// same `fallback: null`).
function launch(dir) {
  const sideStores = {
    videoStore: new SideStore({ dir, name: 'video-store', fallback: null, debounceMs: 1 }),
    videoStoreBak: new SideStore({ dir, name: 'video-store-bak', fallback: null, debounceMs: 1 }),
  }
  const bridge = loadBridgeHandlers(sideStores)
  const store = createVideoStore({ bridge, legacy: fakeLocal(), debounceMs: 1 })
  return { sideStores, bridge, store }
}

async function settle(sideStores) {
  await new Promise(r => setTimeout(r, 20))
  await sideStores.videoStore.flush()
  await sideStores.videoStoreBak.flush()
}

const HISTORY = {
  items: {
    'tv:1396:s1e2': {
      type: 'tv', id: '1396', title: 'Breaking Bad', season: 1, episode: 2,
      position: 900, duration: 2700, watched: false, updatedAt: 5,
    },
  },
  watchlist: [{ type: 'movie', id: '27205', title: 'Inception', poster: null, addedAt: 5 }],
  skip: {}, prefs: {},
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'papa-b1-'))
}

test('an unreadable video-store.json does not read back as an empty first run', async () => {
  const dir = tempDir()
  // Last session's good rolling backup is on disk...
  fs.writeFileSync(path.join(dir, 'video-store-bak.json'), JSON.stringify(HISTORY), 'utf8')
  // ...and the main file was truncated by a crash mid-write.
  fs.writeFileSync(path.join(dir, 'video-store.json'), '{"items":{"tv:1396:s1e2":{"pos', 'utf8')

  const { sideStores, store } = launch(dir)
  await store.init()

  // The SideStore did its half of the job: the bytes were kept, not overwritten.
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('video-store.json.corrupt-')),
    'the unreadable file is renamed aside, not lost')

  // The renderer must NOT present this as an empty history.
  assert.strictEqual(store.inWatchlist('movie', '27205'), true,
    'the watchlist survives an unreadable store file')
  assert.strictEqual(store.get('tv:1396:s1e2').position, 900,
    'the episode position survives an unreadable store file')
  await settle(sideStores)
})

test('an unreadable store file never writes an empty blob through the bridge', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'video-store-bak.json'), JSON.stringify(HISTORY), 'utf8')
  fs.writeFileSync(path.join(dir, 'video-store.json'), 'not json at all', 'utf8')

  const first = launch(dir)
  await first.store.init()
  // The user plays something -- the save that used to stamp the emptiness in.
  first.store.setPosition('movie:603', { type: 'movie', id: '603', title: 'The Matrix' }, 60, 8000)
  await first.store.flush()
  await settle(first.sideStores)

  // Next launch: whatever is on disk now is all there is.
  const second = launch(dir)
  await second.store.init()
  assert.strictEqual(second.store.inWatchlist('movie', '27205'), true,
    'the watchlist is still there one launch later')
  assert.strictEqual(second.store.get('tv:1396:s1e2').position, 900,
    'the episode position is still there one launch later')
  assert.strictEqual(second.store.get('movie:603').position, 60,
    'and the new play was kept too')
  await settle(second.sideStores)

  // The rolling backup must still hold the history, not an empty blob.
  const bak = JSON.parse(fs.readFileSync(path.join(dir, 'video-store-bak.json'), 'utf8'))
  const parsed = typeof bak === 'string' ? JSON.parse(bak) : bak
  assert.ok(parsed.items['tv:1396:s1e2'], 'the rolling backup is not wiped on the next launch')
})

test('a genuine first run is still a first run, and still migrates localStorage', async () => {
  const dir = tempDir()
  const old = JSON.stringify({
    items: {}, skip: {}, prefs: {},
    watchlist: [{ type: 'movie', id: '77', title: 'Legacy', poster: null, addedAt: 1 }],
  })
  const sideStores = {
    videoStore: new SideStore({ dir, name: 'video-store', fallback: null, debounceMs: 1 }),
    videoStoreBak: new SideStore({ dir, name: 'video-store-bak', fallback: null, debounceMs: 1 }),
  }
  const bridge = loadBridgeHandlers(sideStores)
  const legacy = fakeLocal({ 'papa-video-store': old })
  const store = createVideoStore({ bridge, legacy, debounceMs: 1 })
  await store.init()
  assert.strictEqual(store.inWatchlist('movie', '77'), true, 'the localStorage blob is adopted')
  assert.strictEqual(legacy._map.has('papa-video-store.migrated'), true)
  assert.strictEqual(store.storageHealthy(), true, 'a first run is healthy, not parked')
  await settle(sideStores)
})

test('a truly empty first run starts empty without inventing a recovery', async () => {
  const dir = tempDir()
  const sideStores = {
    videoStore: new SideStore({ dir, name: 'video-store', fallback: null, debounceMs: 1 }),
    videoStoreBak: new SideStore({ dir, name: 'video-store-bak', fallback: null, debounceMs: 1 }),
  }
  const bridge = loadBridgeHandlers(sideStores)
  const store = createVideoStore({ bridge, legacy: fakeLocal(), debounceMs: 1 })
  await store.init()
  assert.deepStrictEqual(store.watchlist(), [])
  assert.deepStrictEqual(store.continueWatching(), [])
  store.setPosition('movie:1', { type: 'movie', id: '1', title: 'X' }, 10, 1000)
  await store.flush()
  await settle(sideStores)
  // A first run writes through the bridge normally -- it is not parked.
  assert.ok(fs.existsSync(path.join(dir, 'video-store.json')), 'a first run still persists')
})

// ── The explicit signal main sends when its own load failed ──────────────────
//
// The disk-level tests above lean on the inference (an empty main store next to
// a backup that has content). These cover the direct signal, which is what
// main.js should send once SideStore exposes that its load hit a read error: a
// read() that resolves to something which is neither a string nor null.

test('an explicit unreadable signal recovers from the backup and restores it', async () => {
  const bridge = _memoryBridge(JSON.stringify(HISTORY))
  const store = createVideoStore({ bridge, legacy: fakeLocal(), debounceMs: 1 })
  // Seed the rolling backup the way a healthy previous session would have.
  await bridge.writeBackup(JSON.stringify(HISTORY))
  bridge._unreadable(true)

  await store.init()
  assert.strictEqual(store.inWatchlist('movie', '27205'), true, 'the history is recovered')
  assert.strictEqual(store.get('tv:1396:s1e2').position, 900)

  await store.flush()
  // The recovery is written back so the next launch reads a real blob...
  assert.match(bridge._text(), /27205/, 'the recovered history is restored to the store')
  // ...and the backup is not overwritten by this session.
  assert.match(bridge._bak(), /27205/)
})

test('unreadable with no usable backup parks rather than writing an empty store', async () => {
  const bridge = _memoryBridge(JSON.stringify(HISTORY))
  bridge._unreadable(true)
  const store = createVideoStore({ bridge, legacy: fakeLocal(), debounceMs: 1 })
  await store.init()

  const before = bridge._writes()
  store.setPosition('movie:603', { type: 'movie', id: '603', title: 'The Matrix' }, 60, 8000)
  await store.flush()
  assert.strictEqual(bridge._writes(), before,
    'nothing crosses the bridge: an empty store is never written over the real one')
})

test('an empty backup is not mistaken for a recovery', async () => {
  const bridge = _memoryBridge()
  await bridge.writeBackup(JSON.stringify({ items: {}, watchlist: [], skip: {}, prefs: {} }))
  const store = createVideoStore({ bridge, legacy: fakeLocal(), debounceMs: 1 })
  await store.init()
  // An empty bridge store next to an empty backup is a first run, not a loss.
  store.setPosition('movie:1', { type: 'movie', id: '1', title: 'X' }, 10, 1000)
  await store.flush()
  assert.match(bridge._text(), /"movie:1"/, 'a first run still writes through normally')
})
