'use strict'
// The IPC sequence check must not report the same event twice as a gap.
//
// main stamps a monotonic seq per channel; preload's reportSeq compares each
// arrival to the last one seen. But player-event has TWO listeners (renderer.js
// and player-shim.js), each wrapped by on(), each calling reportSeq against one
// shared counter. So every event was checked twice: once as fine, once as
// "out-of-order (expected N+1, got N)". Measured on a live twin: 147 console
// errors on one page load, all phantoms, burying anything real.
//
// The real reportSeq is lifted out of preload.js and executed.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

function build() {
  const start = SRC.indexOf('function reportSeq(')
  assert.ok(start > -1, 'reportSeq must still exist in preload.js')
  const end = SRC.indexOf('\n}', start) + 2
  const errors = []
  const fn = new Function('console', `
    const _seqSeen = new Map()
    const _seqGaps = []
    // reportSeq also consults the resubscribe re-baseline set (see
    // ipc-seq-resubscribe.test.js). Empty here: these cases are all about a
    // channel that has been subscribed throughout.
    const _seqResync = new Set()
    ${SRC.slice(start, end)}
    return { reportSeq, gaps: _seqGaps }
  `)
  const api = fn({ error: (...a) => errors.push(a.join(' ')) })
  return { ...api, errors }
}

test('a clean monotonic stream reports nothing', () => {
  const r = build()
  for (let i = 1; i <= 5; i++) r.reportSeq('player-event', { seq: i })
  assert.deepStrictEqual(r.errors, [])
  assert.deepStrictEqual(r.gaps, [])
})

test('the same event delivered to two listeners is NOT a gap — this is the bug', () => {
  const r = build()
  // Two listeners: each seq arrives twice, in order.
  for (let i = 1; i <= 5; i++) { r.reportSeq('player-event', { seq: i }); r.reportSeq('player-event', { seq: i }) }
  assert.deepStrictEqual(r.errors, [], 'a repeated seq is a second listener, not disorder')
  assert.deepStrictEqual(r.gaps, [])
})

test('a genuinely missed event is still reported', () => {
  const r = build()
  r.reportSeq('c', { seq: 1 }); r.reportSeq('c', { seq: 3 })
  assert.strictEqual(r.errors.length, 1)
  assert.match(r.errors[0], /missed 1 event/)
  assert.strictEqual(r.gaps.length, 1)
})

test('a genuinely out-of-order OLDER event is still reported', () => {
  const r = build()
  r.reportSeq('c', { seq: 3 }); r.reportSeq('c', { seq: 1 })
  assert.strictEqual(r.errors.length, 1)
  assert.match(r.errors[0], /out-of-order/)
})

test('channels are tracked independently', () => {
  const r = build()
  r.reportSeq('a', { seq: 1 }); r.reportSeq('b', { seq: 1 }); r.reportSeq('a', { seq: 2 }); r.reportSeq('b', { seq: 2 })
  assert.deepStrictEqual(r.errors, [])
})
