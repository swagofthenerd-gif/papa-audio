'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { linearToMpv, MPV_MAX } = require('../volume-map')

test('full slider is unity gain (mpv 100)', () => {
  assert.strictEqual(linearToMpv(1), 100)
})

test('zero is silence', () => {
  assert.strictEqual(linearToMpv(0), 0)
})

test('half slider matches linear -6 dB, not mpv cubic -18 dB', () => {
  // gain 0.5 needs mpv volume 100*cbrt(0.5) ≈ 79.4
  const v = linearToMpv(0.5)
  assert.ok(Math.abs(v - 79.4) < 0.1, `expected ~79.4, got ${v}`)
  // sanity: the mpv cubic curve turns that back into 0.5 linear gain
  assert.ok(Math.abs(Math.pow(v / 100, 3) - 0.5) < 0.01)
})

test('80% slider maps to ~92.8, restoring pre-migration loudness', () => {
  const v = linearToMpv(0.8)
  assert.ok(Math.abs(v - 92.8) < 0.1, `expected ~92.8, got ${v}`)
})

test('boost lifts full slider to mpv max (130)', () => {
  assert.strictEqual(linearToMpv(1, true), 130)
  assert.strictEqual(MPV_MAX, 130)
})

test('boost applies uniformly below max and never exceeds MPV_MAX', () => {
  const v = linearToMpv(0.5, true)
  assert.ok(Math.abs(v - 103.2) < 0.1, `expected ~103.2, got ${v}`)
  for (const x of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(linearToMpv(x, true) <= MPV_MAX)
  }
})

test('out-of-range input clamps', () => {
  assert.strictEqual(linearToMpv(1.5), 100)
  assert.strictEqual(linearToMpv(-0.2), 0)
})
