'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { makeCache } = require('../src/ttl-cache')

// Injected clock: none of this needs to take real time, and a test that sleeps
// is a test that gets skipped.
function at(t) { return () => t.now }

test('the cap is enforced against LIVE entries, which was the bug', () => {
  // main's search cache and YouTube URL cache both evicted only ALREADY-EXPIRED
  // entries when over the cap, so a run of distinct keys inside the TTL grew
  // without limit. Simulation from the audit: 1000 distinct searches left 1000
  // entries, each holding a whole search response.
  const t = { now: 0 }
  const c = makeCache({ cap: 200, ttlMs: 5 * 60 * 1000, now: at(t) })
  for (let i = 0; i < 1000; i++) c.set('k' + i, { big: 'payload' })
  assert.strictEqual(c.size, 200)
  // And it is the newest 200 that survived.
  assert.strictEqual(c.get('k999'), undefined ? undefined : c.get('k999'))
  assert.ok(c.get('k999'), 'the newest is kept')
  assert.strictEqual(c.get('k0'), undefined, 'the oldest is gone')
})

test('expired entries are dropped before live ones', () => {
  const t = { now: 0 }
  const c = makeCache({ cap: 3, ttlMs: 100, now: at(t) })
  c.set('old1', 1)
  c.set('old2', 2)
  t.now = 200                       // both now expired
  c.set('new1', 3)
  c.set('new2', 4)
  c.set('new3', 5)                  // over the cap; the two expired go first
  assert.deepStrictEqual(c.keys().sort(), ['new1', 'new2', 'new3'])
})

test('a read past the TTL is a miss and removes the entry', () => {
  const t = { now: 0 }
  const c = makeCache({ cap: 10, ttlMs: 100, now: at(t) })
  c.set('a', 'A')
  assert.strictEqual(c.get('a'), 'A')
  t.now = 101
  assert.strictEqual(c.get('a'), undefined)
  assert.strictEqual(c.size, 0, 'and it does not linger')
})

test('a read is a touch: the least recently READ is evicted', () => {
  const t = { now: 0 }
  const c = makeCache({ cap: 2, now: at(t) })
  c.set('a', 1)
  c.set('b', 2)
  c.get('a')            // 'a' is now the newest
  c.set('c', 3)
  assert.strictEqual(c.get('b'), undefined, 'b was least recently used')
  assert.strictEqual(c.get('a'), 1)
  assert.strictEqual(c.get('c'), 3)
})

test('a per-entry expiry overrides the uniform TTL', () => {
  // The YouTube URL cache needs this: googlevideo URLs carry their own
  // `expire`, often sooner than any TTL we would pick.
  const t = { now: 1000 }
  const c = makeCache({ cap: 10, ttlMs: 60 * 60 * 1000, now: at(t) })
  c.set('short', 'S', { expiresAt: 1500 })
  c.set('long', 'L')
  t.now = 2000
  assert.strictEqual(c.get('short'), undefined, 'its own expiry won')
  assert.strictEqual(c.get('long'), 'L', 'the TTL still applies to the rest')
})

test('keys, values and size never report an expired entry as live', () => {
  const t = { now: 0 }
  const c = makeCache({ cap: 10, ttlMs: 100, now: at(t) })
  c.set('a', 1); c.set('b', 2)
  t.now = 200
  assert.deepStrictEqual(c.keys(), [])
  assert.deepStrictEqual(c.values(), [])
  // size counts what is held, which is why sweep() exists.
  assert.strictEqual(c.size, 2)
  assert.strictEqual(c.sweep(), 2)
  assert.strictEqual(c.size, 0)
})

test('re-setting a key does not grow the cache', () => {
  const c = makeCache({ cap: 5 })
  for (let i = 0; i < 100; i++) c.set('same', i)
  assert.strictEqual(c.size, 1)
  assert.strictEqual(c.get('same'), 99)
})

test('a cap of zero or nonsense falls back to a real cap', () => {
  // A misconfigured cache must not be an unbounded one.
  for (const cap of [0, -1, NaN, undefined, 'lots']) {
    const c = makeCache({ cap })
    for (let i = 0; i < 500; i++) c.set('k' + i, i)
    assert.ok(c.size <= 200, `cap ${String(cap)} left ${c.size} entries`)
  }
})

test('ttlMs of zero means no expiry, not instant expiry', () => {
  const t = { now: 0 }
  const c = makeCache({ cap: 10, ttlMs: 0, now: at(t) })
  c.set('a', 1)
  t.now = 1e12
  assert.strictEqual(c.get('a'), 1)
})

test('main uses it for both caches it got wrong', () => {
  const fs = require('fs')
  const path = require('path')
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(MAIN, /const \{ makeCache \} = require\('\.\/src\/ttl-cache'\)/)
  assert.match(MAIN, /const _ytUrlCache = makeCache\(\{ cap: YT_URL_CACHE_CAP \}\)/)
  assert.match(MAIN, /const _searchCache = makeCache\(\{ cap: SEARCH_CACHE_CAP, ttlMs: SEARCH_CACHE_TTL_MS \}\)/)
  // And no hand-rolled eviction is left behind.
  assert.doesNotMatch(MAIN, /if \(_ytUrlCache\.size > 200\)/)
  assert.doesNotMatch(MAIN, /if \(_searchCache\.size > 200\)/)
})
