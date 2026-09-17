'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { retireLegacyKeys } = require('../src/store-migration')
const { SideStore } = require('../side-store')

// A minimal stand-in for electron-store's synchronous whole-file API.
function fakeConfig(initial) {
  const data = { ...initial }
  return {
    data,
    has: k => Object.prototype.hasOwnProperty.call(data, k),
    get: k => data[k],
    set: (k, v) => { data[k] = v },
    delete: k => { delete data[k] },
  }
}

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-storemig-'))
  return d
}

test('the legacy config copy is retired even when this run did not adopt it', () => {
  const dir = tmpdir()
  // The side file is already on disk holding the real data -- exactly the state
  // the app is in on every run after the first. adoptIfEmpty declines here,
  // which is what used to strand the legacy key in config.json forever.
  fs.writeFileSync(path.join(dir, 'library-cache.json'), JSON.stringify([{ id: 'a1' }, { id: 'a2' }]))
  const side = new SideStore({ dir, name: 'library-cache', fallback: null, debounceMs: 0 })
  assert.ok(side.fileExists(), 'side file should exist for this scenario')

  const store = fakeConfig({ libraryCache: [{ id: 'stale' }], theme: 'dark' })
  const res = retireLegacyKeys({ sideStores: { libraryCache: side }, store })

  assert.deepStrictEqual(res.adopted, [], 'nothing to adopt; the side file was already there')
  assert.deepStrictEqual(res.retired, ['libraryCache'])
  assert.strictEqual(store.has('libraryCache'), false, 'the dead 907 KB key must be gone')
  assert.strictEqual(store.get('theme'), 'dark', 'unrelated keys are untouched')
  // And the real data is still readable afterwards.
  assert.strictEqual(side.get().length, 2)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a missing side file is adopted from config and then retired', () => {
  const dir = tmpdir()
  const side = new SideStore({ dir, name: 'playCounts', fallback: null, debounceMs: 0 })
  assert.strictEqual(side.fileExists(), false)

  const store = fakeConfig({ playCounts: { 'track-1': 12 } })
  const res = retireLegacyKeys({ sideStores: { playCounts: side }, store })

  assert.deepStrictEqual(res.adopted, ['playCounts'])
  assert.deepStrictEqual(res.retired, ['playCounts'])
  assert.strictEqual(store.has('playCounts'), false)
  assert.deepStrictEqual(side.get(), { 'track-1': 12 }, 'the value survived the move')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('the legacy copy is KEPT when the side store reads back empty', () => {
  const dir = tmpdir()
  const side = new SideStore({ dir, name: 'recently-played', fallback: [], debounceMs: 0 })
  // A file that exists but carries nothing -- a truncated write, a bad restore.
  fs.writeFileSync(path.join(dir, 'recently-played.json'), '[]')

  const store = fakeConfig({ recentlyPlayed: [{ id: 'the only copy' }] })
  const res = retireLegacyKeys({ sideStores: { recentlyPlayed: side }, store })

  assert.deepStrictEqual(res.retired, [], 'must not delete the only surviving copy')
  assert.deepStrictEqual(res.kept, ['recentlyPlayed'])
  assert.strictEqual(store.has('recentlyPlayed'), true)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a corrupt side file never costs the legacy copy', () => {
  const dir = tmpdir()
  const side = new SideStore({ dir, name: 'playlists', fallback: null, debounceMs: 0 })
  fs.writeFileSync(path.join(dir, 'playlists.json'), '{ this is not json')

  const store = fakeConfig({ playlists: [{ name: 'Late night' }] })
  const res = retireLegacyKeys({ sideStores: { playlists: side }, store })

  assert.deepStrictEqual(res.retired, [])
  assert.strictEqual(store.has('playlists'), true, 'the config copy is all he has left')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('keys absent from config are skipped without touching anything', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'sessionState.json'), JSON.stringify({ tab: 'library' }))
  const side = new SideStore({ dir, name: 'sessionState', fallback: null, debounceMs: 0 })

  const store = fakeConfig({ theme: 'dark' })
  const res = retireLegacyKeys({ sideStores: { sessionState: side }, store })

  assert.deepStrictEqual(res.retired, [])
  assert.deepStrictEqual(res.adopted, [])
  assert.deepStrictEqual(Object.keys(store.data), ['theme'])

  fs.rmSync(dir, { recursive: true, force: true })
})

test('one failing store does not stop the others being retired', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ ok: true }))
  const good = new SideStore({ dir, name: 'good', fallback: null, debounceMs: 0 })

  const exploding = {
    adoptIfEmpty() { throw new Error('disk on fire') },
    get() { throw new Error('disk on fire') },
    fileExists() { return true },
  }

  const store = fakeConfig({ bad: { x: 1 }, good: { ok: true } })
  const errors = []
  const res = retireLegacyKeys({
    sideStores: { bad: exploding, good },
    store,
    onError: e => errors.push(e.message),
  })

  assert.deepStrictEqual(res.retired, ['good'])
  assert.strictEqual(store.has('bad'), true, 'the store that threw keeps its config copy')
  assert.strictEqual(errors.length, 1)
  assert.match(errors[0], /disk on fire/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('adoption is on disk before the config copy is deleted', () => {
  const dir = tmpdir()
  // debounceMs deliberately long: if the migration relied on the normal
  // debounced write, the file would still not exist when the delete happens,
  // and a crash in that window would lose the data from both places.
  const side = new SideStore({ dir, name: 'play-counts', fallback: {}, debounceMs: 5000 })

  const store = fakeConfig({ playCounts: { 'a.flac': 41, 'b.flac': 7 } })
  const res = retireLegacyKeys({ sideStores: { playCounts: side }, store })

  assert.deepStrictEqual(res.adopted, ['playCounts'])
  assert.deepStrictEqual(res.retired, ['playCounts'])

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'play-counts.json'), 'utf8'))
  assert.deepStrictEqual(onDisk, { 'a.flac': 41, 'b.flac': 7 },
    'the side file must be durable BEFORE the only other copy is removed')
  assert.strictEqual(store.has('playCounts'), false)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a value held only in memory is not treated as a surviving copy', () => {
  const dir = tmpdir()
  const memoryOnly = {
    adoptIfEmpty() { return false },
    get() { return { 'a.flac': 41 } },
    fileExists() { return false },
  }
  const store = fakeConfig({ playCounts: { 'a.flac': 41 } })
  const res = retireLegacyKeys({ sideStores: { playCounts: memoryOnly }, store })

  assert.deepStrictEqual(res.retired, [])
  assert.deepStrictEqual(res.kept, ['playCounts'])
  assert.strictEqual(store.has('playCounts'), true)

  fs.rmSync(dir, { recursive: true, force: true })
})
