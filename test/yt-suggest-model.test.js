'use strict'
const test = require('node:test')
const assert = require('node:assert')
const M = require('../src/yt-suggest-model')

// ── Debounce / cancel-on-newer ───────────────────────────────────────────────
test('debouncer: a newer request supersedes an older one', () => {
  const d = M.createDebouncer(250)
  const a = d.begin('rad')
  const b = d.begin('radi')
  assert.ok(a && b)
  assert.equal(d.isCurrent(a.token), false, 'the older request is stale')
  assert.equal(d.isCurrent(b.token), true, 'the newest request is current')
})

test('debouncer: an unchanged query is a no-op (no refetch)', () => {
  const d = M.createDebouncer(250)
  assert.ok(d.begin('radiohead'))
  assert.equal(d.begin('radiohead'), null, 'same query does not start a new request')
  assert.equal(d.begin('  radiohead  '), null, 'trimmed-equal is also a no-op')
})

test('debouncer: cancel() makes every in-flight token stale', () => {
  const d = M.createDebouncer(250)
  const a = d.begin('creep')
  d.cancel()
  assert.equal(d.isCurrent(a.token), false)
})

test('debouncer: carries the configured delay', () => {
  const d = M.createDebouncer(250)
  assert.equal(d.begin('x').delayMs, 250)
})

// ── Speculative prefetch single-flight ───────────────────────────────────────
test('prefetcher: only one query in flight; a new one supersedes', () => {
  const p = M.createPrefetcher()
  const r1 = p.request('radiohead creep')
  assert.ok(r1)
  assert.equal(p._inFlight(), 'radiohead creep')
  const r2 = p.request('radiohead karma police')
  assert.ok(r2)
  assert.equal(p._inFlight(), 'radiohead karma police')
  // The first result now arrives late — it must be dropped as stale.
  assert.equal(p.settle(r1.token, 'radiohead creep', { items: [1] }), false)
  // The second result is still wanted.
  assert.equal(p.settle(r2.token, 'radiohead karma police', { items: [2] }), true)
  assert.deepEqual(p.get('radiohead karma police'), { items: [2] })
  assert.equal(p.get('radiohead creep'), null)
})

test('prefetcher: does not restart an in-flight or already-cached query', () => {
  const p = M.createPrefetcher()
  const r1 = p.request('creep')
  assert.equal(p.request('creep'), null, 'same query in flight → no restart')
  p.settle(r1.token, 'creep', { items: [1] })
  assert.equal(p.request('creep'), null, 'already cached → no restart')
})

test('prefetcher: get() returns the warm result for Enter-paints-instantly', () => {
  const p = M.createPrefetcher()
  const r = p.request('bjork joga')
  p.settle(r.token, 'bjork joga', { items: ['x'] })
  assert.deepEqual(p.get('bjork joga'), { items: ['x'] })
  assert.equal(p.get('nothing'), null)
})

test('prefetcher: clear() drops warm results and in-flight state', () => {
  const p = M.createPrefetcher()
  const r = p.request('a')
  p.settle(r.token, 'a', { items: [] })
  p.clear()
  assert.equal(p.get('a'), null)
  assert.equal(p._inFlight(), null)
})

test('prefetcher: empty query is ignored', () => {
  const p = M.createPrefetcher()
  assert.equal(p.request(''), null)
  assert.equal(p.request('   '), null)
})

// ── Row model + keyboard nav ─────────────────────────────────────────────────
test('buildRows puts the typed text first and de-dupes suggestions', () => {
  const rows = M.buildRows('creep', ['creep', 'creep radiohead', 'creep live'])
  assert.equal(rows[0].text, 'creep')
  assert.equal(rows[0].typed, true)
  // "creep" is not repeated as a suggestion row.
  assert.deepEqual(rows.slice(1).map(r => r.text), ['creep radiohead', 'creep live'])
})

test('buildRows caps the suggestion rows', () => {
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
  const rows = M.buildRows('q', many, 3)
  // typed row + up to 3 suggestion rows
  assert.ok(rows.length <= 5)
})

test('nextIndex: ArrowDown stops at the last row, ArrowUp returns to -1', () => {
  assert.equal(M.nextIndex(-1, 'ArrowDown', 3), 0)
  assert.equal(M.nextIndex(2, 'ArrowDown', 3), 2, 'clamped at last')
  assert.equal(M.nextIndex(0, 'ArrowUp', 3), -1, 'back to typed text')
  assert.equal(M.nextIndex(-1, 'ArrowUp', 3), -1, 'cannot go above the input')
  assert.equal(M.nextIndex(1, 'Enter', 3), 1, 'non-arrow keys leave index alone')
})
