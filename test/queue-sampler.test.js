'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { softmaxSample } = require('../src/queue-sampler')
const { seeded } = require('./helpers/seeded-rng')

test('returns the requested count, all distinct', () => {
  const items = ['a', 'b', 'c', 'd', 'e']
  const out = softmaxSample(items, [1, 2, 3, 4, 5], { count: 3, temperature: 1, rng: seeded(1) })
  assert.strictEqual(out.length, 3)
  assert.strictEqual(new Set(out).size, 3)
})

test('never returns more than it was given', () => {
  const out = softmaxSample(['a', 'b'], [1, 1], { count: 10, temperature: 1, rng: seeded(2) })
  assert.strictEqual(out.length, 2)
})

test('low temperature concentrates on the top scorer', () => {
  const items = ['low', 'high']
  let highCount = 0
  for (let i = 0; i < 200; i++) {
    const out = softmaxSample(items, [0, 5], { count: 1, temperature: 0.2, rng: seeded(i) })
    if (out[0] === 'high') highCount++
  }
  assert.ok(highCount > 180, `expected near-always high, got ${highCount}/200`)
})

test('high temperature spreads the picks', () => {
  const items = ['low', 'high']
  let highCount = 0
  for (let i = 0; i < 200; i++) {
    const out = softmaxSample(items, [0, 5], { count: 1, temperature: 8, rng: seeded(i) })
    if (out[0] === 'high') highCount++
  }
  assert.ok(highCount > 60 && highCount < 180, `expected a spread, got ${highCount}/200`)
})

test('the same seed gives the same result, different seeds differ', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const scores = items.map((_, i) => i)
  const a = softmaxSample(items, scores, { count: 4, temperature: 2, rng: seeded(7) })
  const b = softmaxSample(items, scores, { count: 4, temperature: 2, rng: seeded(7) })
  const c = softmaxSample(items, scores, { count: 4, temperature: 2, rng: seeded(99) })
  assert.deepStrictEqual(a, b)
  assert.notDeepStrictEqual(a, c)
})

test('an empty pool returns an empty array rather than throwing', () => {
  assert.deepStrictEqual(softmaxSample([], [], { count: 3, temperature: 1, rng: seeded(1) }), [])
})

test('a huge score does not produce NaN', () => {
  const out = softmaxSample(['a', 'b'], [1e6, 0], { count: 1, temperature: 1, rng: seeded(1) })
  assert.strictEqual(out[0], 'a')
})
