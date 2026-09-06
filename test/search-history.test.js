'use strict'
const test = require('node:test')
const assert = require('node:assert')
const sh = require('../src/search-history')

function res(n) {
  return Array.from({ length: n }, (_, i) => ({ username: 'u' + i, filename: 'f' + i, size: 1 }))
}

test('put then get round-trips the raw results', () => {
  const state = sh.put([], 'Miles Davis', res(3), 1000)
  const got = sh.get(state, 'miles davis')
  assert.strictEqual(got.length, 3)
  assert.strictEqual(got[0].username, 'u0')
})

test('the lookup key is normalized (case + trim)', () => {
  const state = sh.put([], '  Radiohead  ', res(2), 1)
  assert.ok(sh.get(state, 'radiohead'), 'trimmed + lower-cased matches')
  assert.ok(sh.get(state, 'RADIOHEAD'))
})

test('get returns null for an unknown or empty query', () => {
  assert.strictEqual(sh.get([], 'nope'), null)
  assert.strictEqual(sh.get(sh.put([], 'a', res(1), 1), ''), null)
})

test('put moves a repeated query to the front and replaces its results', () => {
  let state = sh.put([], 'a', res(1), 1)
  state = sh.put(state, 'b', res(1), 2)
  state = sh.put(state, 'a', res(5), 3) // a again, with more results
  assert.strictEqual(state[0].key, 'a', 'the re-searched query is newest')
  assert.strictEqual(state[0].results.length, 5, 'results replaced, not appended')
  assert.strictEqual(state.length, 2, 'no duplicate entry for a')
})

test('empty results are not remembered', () => {
  const state = sh.put([], 'a', [], 1)
  assert.deepStrictEqual(state, [])
  assert.strictEqual(sh.get(state, 'a'), null)
})

test('the entry count is capped at MAX_ENTRIES, newest kept', () => {
  let state = []
  for (let i = 0; i < sh.MAX_ENTRIES + 5; i++) {
    state = sh.put(state, 'q' + i, res(1), i)
  }
  assert.strictEqual(state.length, sh.MAX_ENTRIES)
  assert.strictEqual(state[0].key, 'q' + (sh.MAX_ENTRIES + 4), 'the very newest is at the front')
  // The oldest ones were evicted.
  assert.strictEqual(sh.get(state, 'q0'), null)
})

test('the total serialized size stays under the byte cap', () => {
  // Each entry is large enough that many together exceed ~2 MB; the oldest are
  // trimmed until the whole array fits.
  let state = []
  const big = () => Array.from({ length: 2000 }, (_, i) => ({
    username: 'user-with-a-longish-name-' + i,
    filename: 'some/deep/path/to/a/file-' + i + '.flac',
    size: 123456789,
  }))
  for (let i = 0; i < 15; i++) state = sh.put(state, 'q' + i, big(), i)
  const bytes = JSON.stringify(state).length
  assert.ok(bytes <= sh.MAX_BYTES, `serialized ${bytes} must be within ${sh.MAX_BYTES}`)
  assert.ok(state.length >= 1, 'at least the newest search is kept')
  assert.ok(state.length < 15, 'the oldest were trimmed to fit the byte budget')
  assert.strictEqual(state[0].key, 'q14', 'the newest survives the trim')
})

test('getEntry exposes the timestamp for staleness display', () => {
  const state = sh.put([], 'a', res(1), 42)
  const entry = sh.getEntry(state, 'a')
  assert.strictEqual(entry.at, 42)
  assert.strictEqual(entry.query, 'a')
})

test('put tolerates a corrupt prior state', () => {
  assert.deepStrictEqual(sh.get(null, 'a'), null)
  const state = sh.put(null, 'a', res(1), 1)
  assert.strictEqual(state.length, 1)
})
