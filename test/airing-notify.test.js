'use strict'
// Air-date notification logic (roadmap #35): the due-window computation and the
// notified-key ledger with its cap. Pure — no Electron, no network.
const test = require('node:test')
const assert = require('node:assert')

const an = require('../src/airing-notify')

const HOUR = 60 * 60 * 1000
const now = 1_000_000_000_000

test('notifyKey is type+id+episode so each episode is announced once', () => {
  assert.strictEqual(an.notifyKey({ key: 'tv:1396', episode: 2 }), 'tv:1396#e2')
  assert.strictEqual(an.notifyKey({ key: 'anime:5', episode: null }), 'anime:5#e')
  assert.strictEqual(an.notifyKey({ episode: 2 }), null)
})

test('dueNotifications returns shows airing within the next 24h', () => {
  const schedule = [
    { key: 'tv:1', title: 'Soon', episode: 3, airsAt: now + 2 * HOUR },
    { key: 'tv:2', title: 'Later', episode: 1, airsAt: now + 48 * HOUR },   // outside window
    { key: 'tv:3', title: 'Past', episode: 9, airsAt: now - HOUR },          // already aired
  ]
  const due = an.dueNotifications(schedule, [], { now })
  assert.strictEqual(due.length, 1)
  assert.strictEqual(due[0].key, 'tv:1')
  assert.strictEqual(due[0].notifyKey, 'tv:1#e3')
})

test('an already-notified episode is not returned again', () => {
  const schedule = [{ key: 'tv:1', episode: 3, airsAt: now + 2 * HOUR }]
  const due = an.dueNotifications(schedule, ['tv:1#e3'], { now })
  assert.deepStrictEqual(due, [])
})

test('an episode airing exactly now counts; a moment past does not', () => {
  const schedule = [
    { key: 'tv:a', episode: 1, airsAt: now },
    { key: 'tv:b', episode: 1, airsAt: now - 1 },
  ]
  const due = an.dueNotifications(schedule, [], { now })
  assert.deepStrictEqual(due.map(d => d.key), ['tv:a'])
})

test('due results are sorted soonest-first', () => {
  const schedule = [
    { key: 'tv:late', episode: 1, airsAt: now + 10 * HOUR },
    { key: 'tv:early', episode: 1, airsAt: now + 1 * HOUR },
  ]
  const due = an.dueNotifications(schedule, [], { now })
  assert.deepStrictEqual(due.map(d => d.key), ['tv:early', 'tv:late'])
})

test('recordNotified merges, de-dupes newest-wins, and caps', () => {
  const merged = an.recordNotified(['a', 'b'], ['b', 'c'])
  assert.deepStrictEqual(merged, ['a', 'b', 'c'])   // 'b' de-duped, moved to end
})

test('recordNotified enforces the cap, dropping the oldest', () => {
  const existing = ['k0', 'k1', 'k2']
  const capped = an.recordNotified(existing, ['k3', 'k4'], { cap: 3 })
  assert.deepStrictEqual(capped, ['k2', 'k3', 'k4'])
})

test('the real cap is 200 and the window is 24h', () => {
  assert.strictEqual(an.NOTIFIED_CAP, 200)
  assert.strictEqual(an.DUE_WINDOW_MS, 24 * HOUR)
})
