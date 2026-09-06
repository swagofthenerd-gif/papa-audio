'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { emptyState, flattenUploads, isActiveUpload, ingest, _dayKey } =
  require('../src/upload-stats')

const dayMs = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime()

// A slskd /transfers/uploads payload: grouped by user → directories → files.
const grouped = (files) => ([
  { username: 'alice', directories: [{ files: files.alice || [] }] },
  { username: 'bob', directories: [{ files: files.bob || [] }] },
])

test('flattenUploads reads the grouped user→directories→files shape', () => {
  const flat = flattenUploads([
    { username: 'alice', directories: [{ files: [
      { filename: 'a.flac', bytesTransferred: 100, state: 'InProgress' },
      { filename: 'b.flac', bytesTransferred: 200, state: 'Completed, Succeeded' },
    ] }] },
  ])
  assert.strictEqual(flat.length, 2)
  assert.strictEqual(flat[0].username, 'alice')
  assert.strictEqual(flat[0].transferred, 100)
})

test('flattenUploads also reads a flat-per-user files array', () => {
  const flat = flattenUploads([{ username: 'bob', files: [{ filename: 'x', bytesTransferred: 5 }] }])
  assert.strictEqual(flat.length, 1)
  assert.strictEqual(flat[0].transferred, 5)
})

test('isActiveUpload counts in-flight, not completed, states', () => {
  assert.strictEqual(isActiveUpload('InProgress'), true)
  assert.strictEqual(isActiveUpload('Queued, Remotely'), true)
  assert.strictEqual(isActiveUpload('Completed, Succeeded'), false)
  assert.strictEqual(isActiveUpload('Completed, Cancelled'), false)
})

test('ingest counts only the growth of a transfer across polls', () => {
  const now = dayMs(2026, 9, 10)
  const s0 = emptyState(_dayKey(now))
  const r1 = ingest(s0, grouped({ alice: [{ filename: 'a.flac', bytesTransferred: 100, state: 'InProgress' }] }), now)
  assert.strictEqual(r1.totalUploadedToday, 100)
  assert.strictEqual(r1.activeUploads, 1)
  assert.strictEqual(r1.distinctPeersToday, 1)
  // Next poll: the same transfer grew to 250 — only the +150 delta is added, not
  // the whole 250 again.
  const r2 = ingest(r1.state, grouped({ alice: [{ filename: 'a.flac', bytesTransferred: 250, state: 'Completed, Succeeded' }] }), now)
  assert.strictEqual(r2.totalUploadedToday, 250)
  assert.strictEqual(r2.activeUploads, 0)   // now completed
  assert.strictEqual(r2.distinctPeersToday, 1)
})

test('ingest tallies distinct peers served today', () => {
  const now = dayMs(2026, 9, 10)
  const r = ingest(emptyState(_dayKey(now)), grouped({
    alice: [{ filename: 'a.flac', bytesTransferred: 10, state: 'InProgress' }],
    bob: [{ filename: 'b.flac', bytesTransferred: 20, state: 'InProgress' }],
  }), now)
  assert.strictEqual(r.distinctPeersToday, 2)
  assert.strictEqual(r.totalUploadedToday, 30)
})

test('the counters roll over at the local calendar day boundary', () => {
  const day1 = dayMs(2026, 9, 10, 23)
  const r1 = ingest(emptyState(_dayKey(day1)),
    grouped({ alice: [{ filename: 'a.flac', bytesTransferred: 500, state: 'Completed, Succeeded' }] }), day1)
  assert.strictEqual(r1.totalUploadedToday, 500)
  assert.strictEqual(r1.distinctPeersToday, 1)
  // The next poll lands on the following day: yesterday's total must not carry
  // over, and yesterday's peer set is cleared.
  const day2 = dayMs(2026, 9, 11, 1)
  const r2 = ingest(r1.state,
    grouped({ bob: [{ filename: 'c.flac', bytesTransferred: 40, state: 'InProgress' }] }), day2)
  assert.strictEqual(r2.state.day, '2026-09-11')
  assert.strictEqual(r2.totalUploadedToday, 40)     // fresh, not 540
  assert.strictEqual(r2.distinctPeersToday, 1)       // bob only, alice cleared
})

test('ingest with no uploads just rolls the day and holds totals otherwise', () => {
  const now = dayMs(2026, 9, 10)
  const r1 = ingest(emptyState(_dayKey(now)),
    grouped({ alice: [{ filename: 'a.flac', bytesTransferred: 90, state: 'InProgress' }] }), now)
  // Same day, empty poll: total unchanged, nothing active.
  const r2 = ingest(r1.state, [], now)
  assert.strictEqual(r2.totalUploadedToday, 90)
  assert.strictEqual(r2.activeUploads, 0)
})

test('the seen map only retains transfers present in the latest poll', () => {
  const now = dayMs(2026, 9, 10)
  const r1 = ingest(emptyState(_dayKey(now)), grouped({
    alice: [{ filename: 'a.flac', bytesTransferred: 10, state: 'InProgress' }],
  }), now)
  assert.ok(Object.keys(r1.state.seen).length === 1)
  // 'a.flac' is gone next poll; only 'b.flac' remains in `seen`, so the map does
  // not grow without bound over a long session.
  const r2 = ingest(r1.state, grouped({
    bob: [{ filename: 'b.flac', bytesTransferred: 20, state: 'InProgress' }],
  }), now)
  assert.deepStrictEqual(Object.keys(r2.state.seen), ['bob b.flac'])
})
