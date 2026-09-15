'use strict'
const test = require('node:test')
const assert = require('node:assert')
const R = require('../src/relink')

// Roadmap 083/085: a moved tree relinks by the longest matching path tail.
test('a moved library relinks every file by its path tail, most specific first', () => {
  const dead = ['/old/Music/Camel/Snow Goose/01.flac', '/old/Music/Camel/Snow Goose/02.flac', '/old/Music/Yes/Fragile/01.flac']
  const found = ['/new/Music/Camel/Snow Goose/01.flac', '/new/Music/Camel/Snow Goose/02.flac', '/new/Music/Yes/Fragile/01.flac', '/new/Music/Other/01.flac']
  const p = R.plan(dead, found)
  assert.deepEqual(p.remaps, [
    { from: dead[0], to: found[0] }, { from: dead[1], to: found[1] }, { from: dead[2], to: found[2] },
  ], 'two 01.flac files are told apart by their album folder')
  assert.deepEqual(p.unresolved, []); assert.deepEqual(p.ambiguous, [])
  assert.equal(R.describe(p), '3 files matched')
})

test('a file with no counterpart is unresolved; two equally good candidates are ambiguous, not guessed', () => {
  const p = R.plan(['/old/A/x.flac', '/old/B/y.flac'], ['/new/C/y.flac', '/new/D/y.flac'])
  assert.deepEqual(p.unresolved, ['/old/A/x.flac'])
  assert.equal(p.ambiguous.length, 1); assert.equal(p.ambiguous[0].from, '/old/B/y.flac')
  assert.equal(p.remaps.length, 0)
  assert.equal(R.describe(p), '0 files matched · 1 ambiguous (left alone) · 1 not found')
})

test('matching is case-insensitive on the tail and never reuses a found file twice', () => {
  const p = R.plan(['/old/Album/Track.FLAC', '/old2/Album/track.flac'], ['/new/album/track.flac'])
  assert.equal(p.remaps.length, 1); assert.equal(p.remaps[0].to, '/new/album/track.flac')
  assert.equal(p.unresolved.length + p.ambiguous.length, 1)
})
