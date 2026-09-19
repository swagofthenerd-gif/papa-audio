'use strict'
// A dispatch POST that failed for transport reasons was blamed on the peer.
//
// slskd unreachable, the request timed out, the daemon rate-limiting us — every
// throw from the POST got markDispatched plus recordFailure, which burns one of
// the file's four attempts and puts a strike on the peer. Five strikes benches a
// good source for ten minutes. So a daemon hiccup could bench every peer we had
// and exhaust a whole album's budget on its own, with nothing wrong anywhere.
//
// Only an answer FROM slskd — an HTTP status — is evidence about the request.
//
// The real dispatchOutcome is used. Nothing here reaches slskd.

const test = require('node:test')
const assert = require('node:assert')

const dlSched = require('../src/download-scheduler.js')
const { MAIN } = require('./helpers/lift-main-fn.js')

test('a transport failure is deferred, not blamed on the peer', () => {
  assert.strictEqual(dlSched.dispatchOutcome(new Error('ECONNREFUSED')), 'defer')
  assert.strictEqual(dlSched.dispatchOutcome(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 'defer')
  const throttled = Object.assign(new Error('429'), { code: 'SLSKD_THROTTLED', throttled: true })
  assert.strictEqual(dlSched.dispatchOutcome(throttled), 'defer')
})

test('a dry-run refusal is skipped', () => {
  assert.strictEqual(dlSched.dispatchOutcome(Object.assign(new Error('dry'), { dryRun: true })), 'skip')
})

test('an answer from slskd IS evidence about the request, and counts', () => {
  for (const status of [400, 403, 404, 500, 503]) {
    assert.strictEqual(dlSched.dispatchOutcome(Object.assign(new Error(String(status)), { status })),
      'blame', 'HTTP ' + status + ' came from slskd, so it means something')
  }
})

test('the deferred path costs the file no attempt and the peer no strike', () => {
  // What the classification is actually protecting. Twelve ticks of an
  // unreachable daemon must leave the queue exactly as it was.
  const st = dlSched.createState()
  dlSched.addItem(st, {
    filename: 'shares/Nina Simone/Pastel Blues/02 - Be My Husband.flac',
    size: 20e6,
    sources: [{ username: 'peerA', filename: 'x.flac', size: 20e6 }],
  })
  const before = JSON.stringify(st.pending[0])
  for (let i = 0; i < 12; i++) {
    const outcome = dlSched.dispatchOutcome(new Error('ECONNREFUSED'))
    assert.strictEqual(outcome, 'defer')
    // 'defer' means the tick does nothing at all — no markDispatched, no
    // recordFailure. If it ever called either, the state would move.
  }
  assert.strictEqual(JSON.stringify(st.pending[0]), before, 'nothing moved')
  assert.deepStrictEqual(st.peerFailures, {}, 'and nobody was benched')
})

test('dlTick routes the dispatch catch through dispatchOutcome and breaks on defer', () => {
  const at = MAIN.indexOf('const outcome = dlSched.dispatchOutcome(e)')
  assert.ok(at > -1, 'the dispatch catch must classify the error')
  const block = MAIN.slice(at, MAIN.indexOf('\n      }\n    }', at))
  assert.ok(/if \(outcome === 'defer'\)/.test(block), 'it must have a defer branch')
  assert.ok(/break/.test(block.slice(block.indexOf("outcome === 'defer'"))),
    'and stop dispatching for this tick — the rest of the plan hits the same wall')
  assert.ok(block.indexOf('recordFailure') > block.indexOf("outcome === 'defer'"),
    'recordFailure must sit after the defer branch, not before it')
})
