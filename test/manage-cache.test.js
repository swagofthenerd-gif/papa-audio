'use strict'
const test = require('node:test')
const assert = require('node:assert')
const C = require('../src/manage-cache')

test('a matching signature within max-age is fresh', () => {
  const e = C.makeEntry({ x: 1 }, 'sig-1', 1000)
  assert.equal(C.isFresh(e, 'sig-1', 1000, 10000), true)
  assert.equal(C.isFresh(e, 'sig-1', 6000, 10000), true)
})

test('a changed signature is stale regardless of age', () => {
  const e = C.makeEntry({ x: 1 }, 'sig-1', 1000)
  assert.equal(C.isFresh(e, 'sig-2', 1001, 10000), false)
})

test('an entry past max-age is stale even with a matching signature', () => {
  const e = C.makeEntry({ x: 1 }, 'sig-1', 1000)
  assert.equal(C.isFresh(e, 'sig-1', 1000 + 20000, 10000), false)
})

test('a missing or malformed entry is stale', () => {
  assert.equal(C.isFresh(null, 's', 0, 1), false)
  assert.equal(C.isFresh({}, 's', 0, 1), false)
  assert.equal(C.isFresh(5, 's', 0, 1), false)
})

test('readFresh returns the value only when fresh', () => {
  const map = { storage: C.makeEntry({ total: 9 }, 'sig-1', 100) }
  assert.deepEqual(C.readFresh(map, 'storage', 'sig-1', 200, 10000), { total: 9 })
  assert.equal(C.readFresh(map, 'storage', 'sig-2', 200, 10000), null)
  assert.equal(C.readFresh(map, 'duplicates', 'sig-1', 200, 10000), null)
})

test('withValue is pure and never mutates the input map', () => {
  const before = { storage: C.makeEntry({ a: 1 }, 's', 1) }
  const after = C.withValue(before, 'duplicates', { b: 2 }, 's', 2)
  assert.ok(before.duplicates === undefined, 'input untouched')
  assert.ok(after.storage && after.duplicates, 'output has both keys')
  assert.equal(after.duplicates.value.b, 2)
})

// ── store wrapper with injected fakes (no window, no IPC) ─────────────────────
function fakeStore() {
  let disk = {}
  const api = {
    manageCacheGet: async () => disk,
    manageCacheSet: (v) => { disk = v },
  }
  const local = {
    _s: {},
    readObject(k) { return this._s[k] || {} },
    write(k, v) { this._s[k] = v; return true },
  }
  return C.createStore({ api, local })
}

test('store round-trips a value keyed by signature', async () => {
  const s = fakeStore()
  await s.load()
  assert.equal(s.get('storage', 'sigA', 1000), null, 'nothing cached yet')
  s.put('storage', { total: 42 }, 'sigA', 1000)
  assert.deepEqual(s.get('storage', 'sigA', 1100), { total: 42 })
})

test('store returns null when the library signature changed', async () => {
  const s = fakeStore()
  await s.load()
  s.put('duplicates', { n: 3 }, 'sigA', 1000)
  assert.equal(s.get('duplicates', 'sigB', 1000), null)
})

test('store falls back to local when the IPC is absent', () => {
  const local = { _s: {}, readObject(k) { return this._s[k] || {} }, write(k, v) { this._s[k] = v; return true } }
  const s = C.createStore({ api: null, local })
  s.put('genres', { g: 1 }, 'sig', 1000)
  assert.deepEqual(s.get('genres', 'sig', 1000), { g: 1 })
  assert.ok(local._s['papa.manageCache'], 'wrote through to localStorage fallback')
})
