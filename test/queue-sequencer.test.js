'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { sequence } = require('../src/queue-sequencer')

function tr(i, artist, albumId) {
  return { filePath: `/t${i}.flac`, artist, albumId, title: `T${i}` }
}
function vec(energy) {
  return { energy, brightness: 0, dynamics: 0, density: 0, punch: 0 }
}

test('no two tracks by the same artist land within 3 of each other', () => {
  const cands = [
    tr(1, 'Pink Floyd', 'a'), tr(2, 'Pink Floyd', 'a'), tr(3, 'Pink Floyd', 'a'),
    tr(4, 'Yes', 'b'), tr(5, 'Yes', 'b'), tr(6, 'King Crimson', 'c'),
    tr(7, 'Rush', 'd'), tr(8, 'Camel', 'e'), tr(9, 'Genesis', 'f'),
  ]
  const vectors = new Map(cands.map((t, i) => [t.filePath, vec(i / 10)]))
  const out = sequence(cands, { vectors })
  const seen = new Map()
  out.forEach((t, i) => {
    const prev = seen.get(t.artist)
    if (prev !== undefined) assert.ok(i - prev >= 3, `${t.artist} repeated at ${prev} and ${i}`)
    seen.set(t.artist, i)
  })
})

test('every candidate appears exactly once', () => {
  const cands = [tr(1, 'A', 'a'), tr(2, 'B', 'b'), tr(3, 'C', 'c'), tr(4, 'D', 'd')]
  const vectors = new Map(cands.map(t => [t.filePath, vec(0.5)]))
  const out = sequence(cands, { vectors })
  assert.strictEqual(out.length, cands.length)
  assert.strictEqual(new Set(out.map(t => t.filePath)).size, cands.length)
})

test('adjacent energy jumps are smaller than a worst-case ordering', () => {
  const cands = [
    tr(1, 'A', 'a'), tr(2, 'B', 'b'), tr(3, 'C', 'c'),
    tr(4, 'D', 'd'), tr(5, 'E', 'e'), tr(6, 'F', 'f'),
  ]
  const energies = [0, 1, 0.1, 0.9, 0.2, 0.8]
  const vectors = new Map(cands.map((t, i) => [t.filePath, vec(energies[i])]))
  const out = sequence(cands, { vectors })
  const jump = arr => arr.slice(1).reduce(
    (s, t, i) => s + Math.abs(vectors.get(t.filePath).energy - vectors.get(arr[i].filePath).energy), 0)
  assert.ok(jump(out) < jump(cands), 'sequencing did not smooth the transitions')
})

test('spacing relaxes rather than dropping tracks when the pool is all one artist', () => {
  const cands = [tr(1, 'Solo', 'a'), tr(2, 'Solo', 'a'), tr(3, 'Solo', 'a')]
  const vectors = new Map(cands.map(t => [t.filePath, vec(0.5)]))
  const out = sequence(cands, { vectors })
  assert.strictEqual(out.length, 3, 'tracks were dropped instead of relaxing the rule')
})

test('a track with no vector is still placed, never dropped', () => {
  const cands = [tr(1, 'A', 'a'), tr(2, 'B', 'b')]
  const vectors = new Map([['/t1.flac', vec(0.5)]])
  const out = sequence(cands, { vectors })
  assert.strictEqual(out.length, 2)
})

test('an empty candidate list returns empty', () => {
  assert.deepStrictEqual(sequence([], { vectors: new Map() }), [])
})

test('a gap of exactly artistGap is allowed, not rejected', () => {
  // Three A tracks among nine slots can only satisfy gap>=3 at 0,3,6 -- so if
  // the lookback is off by one and demands gap>=4, this is unsatisfiable and
  // the relax path fires, producing a violation.
  const cands = [
    tr(1, 'A', 'a'), tr(2, 'A', 'a'), tr(3, 'A', 'a'),
    tr(4, 'B', 'b'), tr(5, 'C', 'c'), tr(6, 'D', 'd'),
    tr(7, 'E', 'e'), tr(8, 'F', 'f'), tr(9, 'G', 'g'),
  ]
  const vectors = new Map(cands.map((t, i) => [t.filePath, vec(i / 10)]))
  const out = sequence(cands, { vectors })
  const seen = new Map()
  out.forEach((t, i) => {
    const prev = seen.get(t.artist)
    if (prev !== undefined) assert.ok(i - prev >= 3, `${t.artist} at ${prev} and ${i}`)
    seen.set(t.artist, i)
  })
  assert.strictEqual(out.length, 9)
})
