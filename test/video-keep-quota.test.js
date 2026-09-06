'use strict'
const test = require('node:test')
const assert = require('node:assert')
const vk = require('../src/video-keep')

const GB = 1e9

test('usageBytes sums sizeBytes and ignores junk entries', () => {
  assert.strictEqual(vk.usageBytes([{ sizeBytes: 2 * GB }, { sizeBytes: 3 * GB }]), 5 * GB)
  // A stale entry with no size, or a NaN, contributes zero rather than poisoning
  // the total.
  assert.strictEqual(vk.usageBytes([{ sizeBytes: 2 * GB }, { sizeBytes: 'x' }, {}]), 2 * GB)
  assert.strictEqual(vk.usageBytes(null), 0)
})

test('quotaBytes converts GB to decimal bytes; 0 and junk mean no ceiling', () => {
  assert.strictEqual(vk.quotaBytes(20), 20 * GB)
  assert.strictEqual(vk.quotaBytes(0), 0)
  assert.strictEqual(vk.quotaBytes(-5), 0)
  assert.strictEqual(vk.quotaBytes('nope'), 0)
})

test('quotaCheck allows a keep that fits under the ceiling', () => {
  const entries = [{ sizeBytes: 10 * GB }]
  const v = vk.quotaCheck(entries, 20, 5 * GB)
  assert.strictEqual(v.ok, true)
  assert.strictEqual(v.used, 10 * GB)
  assert.strictEqual(v.limit, 20 * GB)
  assert.strictEqual(v.after, 15 * GB)
})

test('quotaCheck refuses a keep that would cross the ceiling', () => {
  const entries = [{ sizeBytes: 18 * GB }]
  const v = vk.quotaCheck(entries, 20, 5 * GB)
  assert.strictEqual(v.ok, false)
  assert.strictEqual(v.after, 23 * GB)
})

test('a keep landing exactly on the ceiling is allowed', () => {
  const v = vk.quotaCheck([{ sizeBytes: 15 * GB }], 20, 5 * GB)
  assert.strictEqual(v.ok, true)
  assert.strictEqual(v.after, 20 * GB)
})

test('a quota of 0 (unset) never blocks — the feature is opt-in on a real number', () => {
  const v = vk.quotaCheck([{ sizeBytes: 500 * GB }], 0, 100 * GB)
  assert.strictEqual(v.ok, true)
  assert.strictEqual(v.limit, 0)
})
