'use strict'
// One episode, one name. The renderer keys the position store and the diary on
// _watchKey; the main process now keys the rewatch cache on the same string, so
// it can tell "I already hold episode 6" from "I hold episode 6 from a
// different release" — which is the whole of "don't cache the same episode
// twice from another source". If the two sides ever spell an episode
// differently the cache holds it twice and the skip check never fires, so this
// lifts the REAL renderer function and compares it to the module, value by
// value.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')

const K = require('../src/watch-key')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The renderer's own _watchKey, lifted out and run with the module ABSENT, so
// the fallback branch is what is compared — the branch that would drift.
function liftRendererWatchKey({ withModule }) {
  const start = RENDERER.indexOf('function _watchKey(type, id, season, episode) {')
  assert.ok(start > 0, 'renderer _watchKey not found')
  const end = RENDERER.indexOf('\n}', start) + 2
  const ctx = withModule ? { PapaWatchKey: K, window: { PapaWatchKey: K } } : { window: {} }
  vm.createContext(ctx)
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return ctx._watchKey
}

const CASES = [
  ['movie', 550, null, null],
  ['movie', 550, 1, 2],
  ['tv', 1396, 1, 5],
  ['tv', 1396, 5, 14],
  ['tv', 1396, null, 5],
  ['tv', 1396, undefined, 5],
  ['anime', 21, null, 3],
  ['anime', 21, undefined, 1130],
]

test('the renderer delegates to the module and gets the module string back', () => {
  const rendererKey = liftRendererWatchKey({ withModule: true })
  for (const c of CASES) {
    assert.strictEqual(rendererKey(...c), K.watchKey(...c),
      'delegating renderer disagrees for ' + JSON.stringify(c))
  }
})

test('the renderer fallback spells every case exactly as the module does', () => {
  const rendererKey = liftRendererWatchKey({ withModule: false })
  for (const c of CASES) {
    assert.strictEqual(rendererKey(...c), K.watchKey(...c),
      'renderer fallback disagrees for ' + JSON.stringify(c))
  }
})

test('a missing season has one spelling, whether it arrives as null or undefined', () => {
  assert.strictEqual(K.watchKey('tv', 1396, null, 5), K.watchKey('tv', 1396, undefined, 5))
  assert.strictEqual(K.watchKey('tv', 1396, null, 5), 'tv:1396:snulle5')
})

test('a key with a season keeps the form already on disk', () => {
  // Cache index entries written before this module exists carry this exact
  // string; changing it would orphan every file the user already has.
  assert.strictEqual(K.watchKey('tv', 1396, 1, 5), 'tv:1396:s1e5')
  assert.strictEqual(K.watchKey('anime', 21, null, 3), 'anime:21:e3')
  assert.strictEqual(K.watchKey('movie', 550, null, null), 'movie:550')
})

test('parseWatchKey reads back what watchKey wrote', () => {
  assert.deepStrictEqual(K.parseWatchKey('tv:1396:s1e5'),
    { type: 'tv', id: '1396', season: 1, episode: 5 })
  assert.deepStrictEqual(K.parseWatchKey('tv:1396:snulle5'),
    { type: 'tv', id: '1396', season: null, episode: 5 })
  assert.deepStrictEqual(K.parseWatchKey('anime:21:e3'),
    { type: 'anime', id: '21', season: null, episode: 3 })
  assert.deepStrictEqual(K.parseWatchKey('movie:550'),
    { type: 'movie', id: '550', season: null, episode: null })
  assert.strictEqual(K.parseWatchKey('nonsense'), null)
  assert.strictEqual(K.parseWatchKey(null), null)
})

test('a round trip through parse and back is the same key', () => {
  for (const c of CASES) {
    const key = K.watchKey(...c)
    const p = K.parseWatchKey(key)
    assert.ok(p, 'unparseable: ' + key)
    assert.strictEqual(K.watchKey(p.type, p.id, p.season, p.episode), key)
  }
})
