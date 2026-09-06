'use strict'
const test = require('node:test')
const assert = require('node:assert')
const tm = require('../src/track-memory')

test('get returns null for an unknown show', () => {
  assert.strictEqual(tm.get({}, 'tv:1'), null)
  assert.strictEqual(tm.get({}, ''), null)
  assert.strictEqual(tm.get(null, 'tv:1'), null)
})

test('set then get round-trips the remembered choices', () => {
  const map = tm.set({}, 'tv:1', { audioLang: 'jpn', subLang: 'eng', dubPref: 'sub' }, 100)
  assert.deepStrictEqual(tm.get(map, 'tv:1'), { audioLang: 'jpn', subLang: 'eng', dubPref: 'sub' })
})

test('a patch merges without clobbering fields it does not carry', () => {
  let map = tm.set({}, 'tv:1', { audioLang: 'jpn', subLang: 'eng' }, 100)
  // A later pick of just the dub preference must not wipe the audio/sub choice.
  map = tm.set(map, 'tv:1', { dubPref: 'dub' }, 200)
  assert.deepStrictEqual(tm.get(map, 'tv:1'), { audioLang: 'jpn', subLang: 'eng', dubPref: 'dub' })
})

test('an explicit null clears a field, distinct from omitting it', () => {
  let map = tm.set({}, 'tv:1', { subLang: 'eng' }, 100)
  map = tm.set(map, 'tv:1', { subLang: null }, 200)
  assert.strictEqual(tm.get(map, 'tv:1').subLang, null)
})

test('set never mutates its input map', () => {
  const before = {}
  const after = tm.set(before, 'tv:1', { audioLang: 'jpn' }, 100)
  assert.deepStrictEqual(before, {})
  assert.notStrictEqual(before, after)
})

test('the map is capped, dropping the least-recently-touched shows', () => {
  let map = {}
  // Fill to the cap, each with a rising timestamp so recency is unambiguous.
  for (let i = 0; i < 3; i++) map = tm.set(map, 'tv:' + i, { audioLang: 'x' }, i + 1, 3)
  assert.strictEqual(Object.keys(map).length, 3)
  // One more over the cap evicts tv:0 (oldest `at`).
  map = tm.set(map, 'tv:new', { audioLang: 'x' }, 100, 3)
  assert.strictEqual(Object.keys(map).length, 3)
  assert.strictEqual(map['tv:0'], undefined)
  assert.ok(map['tv:new'])
})

test('re-touching a show refreshes its recency so it survives the trim', () => {
  let map = {}
  for (let i = 0; i < 3; i++) map = tm.set(map, 'tv:' + i, { audioLang: 'x' }, i + 1, 3)
  // Touch the oldest (tv:0) so it is now the newest.
  map = tm.set(map, 'tv:0', { subLang: 'eng' }, 50, 3)
  // Add a new show, forcing one eviction — tv:1 is now the oldest, not tv:0.
  map = tm.set(map, 'tv:new', { audioLang: 'x' }, 100, 3)
  assert.ok(map['tv:0'], 'the re-touched show must survive')
  assert.strictEqual(map['tv:1'], undefined)
})

test('the default cap is 200 shows', () => {
  assert.strictEqual(tm.DEFAULT_CAP, 200)
})

test('blank strings collapse to null so cleared and never-set read alike', () => {
  const map = tm.set({}, 'tv:1', { audioLang: '   ', subLang: '' }, 100)
  const got = tm.get(map, 'tv:1')
  assert.strictEqual(got.audioLang, null)
  assert.strictEqual(got.subLang, null)
})
