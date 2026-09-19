'use strict'
// _personIdCache (name -> TMDB person id) and _directorNames (id -> name) were
// bare Maps, written on shelf renders and never evicted. A long session of
// browsing kept one entry per distinct name it had ever seen, for the life of
// the process.
//
// This runs the real _resolvePersonId lifted from main.js against a fake TMDB.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const { makeCache } = require('../src/ttl-cache')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function lift() {
  const start = MAIN.indexOf('const PERSON_CACHE_CAP')
  assert.ok(start > 0, 'main.js must cap the person caches')
  const end = MAIN.indexOf('\n}\n', MAIN.indexOf('async function _resolvePersonId', start))
  const searches = []
  const ctx = {
    makeCache, Promise, Array, String, Number, Date,
    console: { log() {}, error() {}, warn() {} },
    tmdb: () => ({
      async searchPeople(name) {
        searches.push(name)
        if (name === 'Nobody At All') return []
        return [{ id: name.length * 100, name }]
      },
    }),
  }
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(start, end + 2), ctx)
  return {
    searches,
    resolve: vm.runInContext('_resolvePersonId', ctx),
    cap: vm.runInContext('PERSON_CACHE_CAP', ctx),
    size: () => vm.runInContext('_personIdCache.size', ctx),
    names: () => vm.runInContext('_directorNames', ctx),
  }
}

test('the person cache does not grow without limit', async () => {
  const l = lift()
  for (let i = 0; i < l.cap + 250; i++) await l.resolve('Director Number ' + i)
  assert.ok(l.size() <= l.cap,
    'the cache held ' + l.size() + ' entries against a cap of ' + l.cap)
})

test('a resolved name is still answered from memory, not re-searched', async () => {
  const l = lift()
  const a = await l.resolve('Agnes Varda')
  const b = await l.resolve('Agnes Varda')
  assert.strictEqual(a, b)
  assert.strictEqual(l.searches.length, 1, 'the whole point of the cache is intact')
})

test('a name TMDB does not know is still remembered as unknown', async () => {
  const l = lift()
  assert.strictEqual(await l.resolve('Nobody At All'), null)
  assert.strictEqual(await l.resolve('Nobody At All'), null)
  assert.strictEqual(l.searches.length, 1,
    'a cached null must not be mistaken for a cache miss and re-searched every render')
})

test('the director-name cache is capped as well', () => {
  const l = lift()
  const names = l.names()
  assert.strictEqual(typeof names.cap, 'number', 'it is a capped cache, not a bare Map')
  for (let i = 0; i < names.cap + 100; i++) names.set(String(i), 'Name ' + i)
  assert.ok(names.size <= names.cap, 'it held ' + names.size)
})

test('the most recently used entries are the ones kept', async () => {
  const l = lift()
  await l.resolve('Kept Around')
  for (let i = 0; i < l.cap - 1; i++) await l.resolve('Filler ' + i)
  // Touch it so it is the newest again, then overflow the cap.
  await l.resolve('Kept Around')
  for (let i = 0; i < 50; i++) await l.resolve('More Filler ' + i)
  const before = l.searches.length
  await l.resolve('Kept Around')
  assert.strictEqual(l.searches.length, before,
    'a name still in use must not be the one evicted')
})
