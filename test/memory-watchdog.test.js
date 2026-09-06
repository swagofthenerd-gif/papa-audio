'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createRing, createWatchdog, DEFAULT_THRESHOLD_BYTES } = require('../src/memory-watchdog')

const GB = 1024 * 1024 * 1024

test('the ring keeps only the most recent N, oldest-first', () => {
  const ring = createRing(3)
  ring.push(1); ring.push(2); ring.push(3)
  assert.deepStrictEqual(ring.toArray(), [1, 2, 3])
  const after = ring.push(4)
  assert.deepStrictEqual(after, [2, 3, 4])
  assert.deepStrictEqual(ring.toArray(), [2, 3, 4])
  assert.strictEqual(ring.size, 3)
  assert.strictEqual(ring.capacity, 3)
})

test('the default ceiling is 1.5 GB', () => {
  assert.strictEqual(DEFAULT_THRESHOLD_BYTES, 1.5 * GB)
  const w = createWatchdog({})
  assert.strictEqual(w.thresholdBytes, 1.5 * GB)
})

test('one over-ceiling sample does not fire — a spike is not a leak', () => {
  const w = createWatchdog({ thresholdBytes: GB, consecutive: 2 })
  const r = w.observe({ rendererRss: 2 * GB })
  assert.strictEqual(r.pressure, false)
  assert.strictEqual(r.run, 1)
})

test('two consecutive over-ceiling samples fire exactly once', () => {
  const w = createWatchdog({ thresholdBytes: GB, consecutive: 2 })
  assert.strictEqual(w.observe({ rendererRss: 2 * GB }).pressure, false)
  assert.strictEqual(w.observe({ rendererRss: 2 * GB }).pressure, true)
  // Still over on the third sample, but latched — it must not fire again.
  assert.strictEqual(w.observe({ rendererRss: 2 * GB }).pressure, false)
})

test('a sample under the ceiling breaks the run and clears the latch', () => {
  const w = createWatchdog({ thresholdBytes: GB, consecutive: 2 })
  w.observe({ rendererRss: 2 * GB })
  assert.strictEqual(w.observe({ rendererRss: 2 * GB }).pressure, true) // fires, latches
  // Drop back under — run resets, latch clears.
  const back = w.observe({ rendererRss: 0.5 * GB })
  assert.strictEqual(back.run, 0)
  assert.strictEqual(w._latched(), false)
  // A fresh relapse can warn again.
  assert.strictEqual(w.observe({ rendererRss: 2 * GB }).pressure, false)
  assert.strictEqual(w.observe({ rendererRss: 2 * GB }).pressure, true)
})

test('a renderer sampling as 0 (gone/unreachable) never trips the ceiling', () => {
  const w = createWatchdog({ thresholdBytes: GB, consecutive: 2 })
  assert.strictEqual(w.observe({ rendererRss: 0 }).pressure, false)
  assert.strictEqual(w.observe({}).pressure, false)
  assert.strictEqual(w.observe({ rendererRss: 0 }).pressure, false)
})

test('samples() reports the ring history for a diagnostics surface', () => {
  const w = createWatchdog({ ringSize: 2, thresholdBytes: GB })
  w.observe({ rendererRss: 1, at: 1 })
  w.observe({ rendererRss: 2, at: 2 })
  w.observe({ rendererRss: 3, at: 3 })
  assert.deepStrictEqual(w.samples().map(s => s.at), [2, 3])
})
