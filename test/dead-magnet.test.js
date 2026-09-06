'use strict'
const test = require('node:test')
const assert = require('node:assert')
const dm = require('../src/dead-magnet')
const { rankStreams } = require('../providers/index')

const DAY = 24 * 60 * 60 * 1000

test('a single failure does not reach the demotion bar', () => {
  const now = 1_000_000_000_000
  const map = dm.recordFailure({}, 'ABC123', now)
  assert.strictEqual(dm.recentFailures(map, 'abc123', now), 1)
  assert.strictEqual(dm.isDead(map, 'abc123', now), false)
})

test('two failures within the window demote', () => {
  let now = 1_000_000_000_000
  let map = dm.recordFailure({}, 'hash', now)
  now += DAY
  map = dm.recordFailure(map, 'hash', now)
  assert.strictEqual(dm.recentFailures(map, 'hash', now), 2)
  assert.strictEqual(dm.isDead(map, 'hash', now), true)
})

test('infohash is matched case-insensitively', () => {
  const now = 2_000_000_000_000
  const map = dm.recordFailure(dm.recordFailure({}, 'AbCdEf', now), 'ABCDEF', now)
  assert.strictEqual(dm.isDead(map, 'abcdef', now), true)
})

test('failures older than the decay window no longer count', () => {
  const t0 = 3_000_000_000_000
  let map = dm.recordFailure({}, 'h', t0)
  map = dm.recordFailure(map, 'h', t0 + DAY)
  // Both are recent here → dead.
  assert.strictEqual(dm.isDead(map, 'h', t0 + DAY), true)
  // 15 days after the last failure → decayed → not dead, zero recent.
  const later = t0 + DAY + 15 * DAY
  assert.strictEqual(dm.recentFailures(map, 'h', later), 0)
  assert.strictEqual(dm.isDead(map, 'h', later), false)
})

test('a failure after the window resets the count to one', () => {
  const t0 = 4_000_000_000_000
  let map = dm.recordFailure({}, 'h', t0)
  map = dm.recordFailure(map, 'h', t0 + DAY) // now 2, dead
  assert.strictEqual(dm.isDead(map, 'h', t0 + DAY), true)
  // A new failure long after the previous ones decayed starts fresh at 1.
  const far = t0 + 40 * DAY
  map = dm.recordFailure(map, 'h', far)
  assert.strictEqual(dm.recentFailures(map, 'h', far), 1)
  assert.strictEqual(dm.isDead(map, 'h', far), false)
})

test('recordFailure never mutates its input', () => {
  const now = 5_000_000_000_000
  const orig = {}
  const next = dm.recordFailure(orig, 'h', now)
  assert.deepStrictEqual(orig, {})
  assert.notStrictEqual(orig, next)
})

test('prune drops decayed entries and keeps recent ones', () => {
  const now = 6_000_000_000_000
  const map = {
    fresh: { failures: 2, lastFailAt: now - DAY },
    stale: { failures: 3, lastFailAt: now - 20 * DAY },
  }
  const pruned = dm.prune(map, now)
  assert.ok(pruned.fresh, 'a recent entry survives')
  assert.ok(!pruned.stale, 'a decayed entry is dropped')
})

test('empty / null infohash is ignored', () => {
  const now = 7_000_000_000_000
  assert.deepStrictEqual(dm.recordFailure({}, '', now), {})
  assert.deepStrictEqual(dm.recordFailure({}, null, now), {})
})

// ── The ranker demotion, end to end through providers/index.js ────────────────

test('rankStreams demotes a dead magnet beneath a live one and flags it', () => {
  const now = 8_000_000_000_000
  let map = dm.recordFailure({}, 'deadhash', now)
  map = dm.recordFailure(map, 'deadhash', now + DAY)
  const isDead = h => dm.isDead(map, h, now + DAY)

  const entries = [
    // The dead one is the higher-quality release; it must still sink.
    { kind: 'torrent', infoHash: 'DEADHASH', quality: '2160p', seeds: 500, source: 'YTS' },
    { kind: 'torrent', infoHash: 'livehash', quality: '1080p', seeds: 10, source: 'EZTV' },
  ]
  const ranked = rankStreams(entries, { isDead })
  assert.strictEqual(ranked[0].infoHash, 'livehash', 'the live source ranks first')
  assert.strictEqual(ranked[1].infoHash, 'DEADHASH', 'the dead one is last, not gone')
  assert.strictEqual(ranked[1].deadHint, true, 'the demoted entry is flagged for a badge')
  assert.strictEqual(ranked.length, 2, 'nothing is hidden')
})

test('rankStreams leaves entries untouched with no predicate', () => {
  const entries = [
    { kind: 'torrent', infoHash: 'a', quality: '1080p', seeds: 1, source: 'YTS' },
  ]
  const ranked = rankStreams(entries)
  assert.strictEqual(ranked[0].deadHint, undefined, 'no flag without a predicate')
})

test('rankStreams only demotes when two dead entries, keeping their relative order otherwise', () => {
  const now = 9_000_000_000_000
  let map = dm.recordFailure({}, 'd1', now)
  map = dm.recordFailure(map, 'd1', now + DAY)
  const isDead = h => dm.isDead(map, h, now + DAY)
  const entries = [
    { kind: 'torrent', infoHash: 'd1', quality: '2160p', seeds: 99, source: 'YTS' },
    { kind: 'torrent', infoHash: 'ok', quality: '480p', seeds: 1, source: 'EZTV' },
  ]
  const ranked = rankStreams(entries, { isDead })
  assert.strictEqual(ranked[0].infoHash, 'ok')
  assert.strictEqual(ranked[1].deadHint, true)
})
