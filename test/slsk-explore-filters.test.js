'use strict'
// The explorer's filter bar model. Every chip is a pure predicate; contextual
// ones (new since last visit, better than mine) read a ctx and never guess.
const test = require('node:test')
const assert = require('node:assert')
const F = require('../src/slsk-filters.js')

const A = (o) => ({ artist: 'A', album: 'B', folderPath: 'x', lossless: true, topExt: 'flac', maxBitDepth: 16, maxSampleRate: 44100, totalSize: 4e8, trackCount: 10, inLibrary: false, ...o })
const lib = [
  A({ folderPath: 'p1', album: 'Animals', artist: 'Pink Floyd' }),
  A({ folderPath: 'p2', album: 'Mirage', artist: 'Camel', maxBitDepth: 24, maxSampleRate: 96000, totalSize: 1.4e9, inLibrary: true }),
  A({ folderPath: 'p3', album: 'Load', artist: 'Metallica', lossless: false, topExt: 'mp3', maxBitDepth: 0, maxSampleRate: 44100, totalSize: 1.2e8 }),
]
const run = (filters, extra = {}) => F.applyShelfFilterSort(lib, { filters: new Set(filters), sort: 'az', ...extra }).map(a => a.folderPath)

test('format, depth, rate and size chips select what they say', () => {
  assert.deepStrictEqual(run(['mp3']), ['p3'])
  assert.deepStrictEqual(run(['bd24']), ['p2'])
  assert.deepStrictEqual(run(['sr88']), ['p2'])
  assert.deepStrictEqual(run(['large']), ['p2'])
  assert.deepStrictEqual(run(['small']), ['p3'])
})

test('mine chips: in/not in library, better-than-mine and new read the context', () => {
  assert.deepStrictEqual(run(['inlib']), ['p2'])
  assert.deepStrictEqual(run(['notinlib']).sort(), ['p1', 'p3'])
  assert.deepStrictEqual(run(['better'], { ctx: { upgradePaths: new Set(['p2']) } }), ['p2'])
  assert.deepStrictEqual(run(['better']), [], 'no context, no claim')
  assert.deepStrictEqual(run(['new'], { ctx: { newPaths: new Set(['p3']) } }), ['p3'])
})

test('search within the library needs every token, across artist and album', () => {
  assert.deepStrictEqual(run([], { query: 'floyd anim' }), ['p1'])
  assert.deepStrictEqual(run([], { query: 'camel load' }), [])
})

test('artist and tracks sorts exist', () => {
  assert.deepStrictEqual(run([], { sort: 'artist' }), ['p2', 'p3', 'p1'])
  assert.strictEqual(F.applyShelfFilterSort(lib, { sort: 'tracks' })[0].trackCount, 10)
})

test('every chip key has a label and belongs to one group; legacy keys keep working', () => {
  for (const g of F.SHELF_FILTER_GROUPS) for (const k of g.keys) {
    assert.ok(F.SHELF_FILTERS[k], k + ' has a predicate'); assert.ok(F.SHELF_FILTER_LABELS[k], k + ' has a label')
  }
  assert.deepStrictEqual(run(['lossless']).sort(), ['p1', 'p2'])
})
