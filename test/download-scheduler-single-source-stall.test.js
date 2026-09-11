'use strict'
// THE 108-FILE FIELD STALL (2026-09-11).
//
// The user's queue held 108 downloads that never moved, while every one of
// their peers was online and browsable. Root cause: `maxAttempts` is
// documented as "distinct sources tried per file before giving up", but the
// dispatch gate compared it against `attempts`, which counts EVERY dispatch —
// including repeat tries at the same peer. A file with ONE known source spent
// all four on that single peer and was then skipped forever. Worse,
// starvedItems used the same wrong gate, so no alternate-source search ever
// ran for exactly the files that needed one most, and nothing ever wrote them
// to `done` — so they persisted across every restart as permanent zombies.
//
// The restart path is what accumulated the attempts: dlPersist writes
// in-flight entries back as pending WITH their attempt count, dlRestore
// replays it, and each session's dispatch added one more.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/download-scheduler')

function src(username, opts = {}) { return Object.assign({ username }, opts) }

// One file, one source, four attempts already spent on that source — the exact
// shape of all 108 field entries.
function fieldEntry(name, attempts, lastTriedAt) {
  const st = S.createState()
  S.addItem(st, { filename: name, size: 100, sources: [src('solo')], addedAt: 1 })
  const e = st.pending[0]
  e.attempts = attempts
  e.tried = ['solo']
  e.triedAt = { solo: lastTriedAt }
  return st
}

test('a one-source file still dispatches after burning four tries on that source', () => {
  const st = fieldEntry('stuck.flac', 4, 1000)
  // Days later, peer healthy, not benched.
  const plan = S.planDispatch(st, {}, 1000 + 14 * 24 * 3600 * 1000)
  assert.equal(plan.length, 1, 'the file must be offered again, not stranded')
  assert.equal(plan[0].username, 'solo')
})

test('the distinct-source cap still stops a file that really has tried them all', () => {
  const st = S.createState()
  S.addItem(st, { filename: 'x.flac', size: 100, sources: [src('a'), src('b'), src('c'), src('d')], addedAt: 1 })
  const e = st.pending[0]
  e.attempts = 4
  e.tried = ['a', 'b', 'c', 'd']
  e.triedAt = { a: 1, b: 1, c: 1, d: 1 }
  const plan = S.planDispatch(st, {}, 10 * 24 * 3600 * 1000)
  assert.equal(plan.length, 0, 'four DISTINCT sources tried is a real exhaustion')
})

test('the total-attempt ceiling still ends a hopeless one-source file', () => {
  const st = fieldEntry('hopeless.flac', 24, 1000)
  const plan = S.planDispatch(st, {}, 1000 + 30 * 24 * 3600 * 1000)
  assert.equal(plan.length, 0, 'maxTotalAttempts is the real give-up line')
})

test('retrying the same peer backs off exponentially, capped', () => {
  const cfg = { retryPeerAfterMs: 60000, maxRetryBackoffMs: 30 * 60 * 1000 }
  assert.equal(S.retryGapMs({ attempts: 1 }, cfg), 60000)
  assert.equal(S.retryGapMs({ attempts: 2 }, cfg), 120000)
  assert.equal(S.retryGapMs({ attempts: 4 }, cfg), 480000)
  assert.equal(S.retryGapMs({ attempts: 99 }, cfg), 30 * 60 * 1000, 'capped, never unbounded')
})

test('a one-source file is NOT re-asked before its backoff expires', () => {
  const st = fieldEntry('fresh.flac', 4, 1000)
  // attempts=4 → gap 8 min. Two minutes later is far too soon.
  const plan = S.planDispatch(st, {}, 1000 + 2 * 60 * 1000)
  assert.equal(plan.length, 0, 'backoff must still hold the peer off')
})

test('starvedItems reports a one-source file so an alternate search can run', () => {
  const st = fieldEntry('needs-alt.flac', 4, 1000)
  st.peerFailures.solo = { consecutive: 5, benchedUntil: 9e15 }  // its only peer is benched
  const starved = S.starvedItems(st, {}, 2000)
  assert.equal(starved.length, 1, 'exactly the file that needs a fresh source')
})

test('a failure on a one-source file re-queues it instead of killing it', () => {
  const st = fieldEntry('retryable.flac', 2, 1000)
  const plan = S.planDispatch(st, {}, 1000 + 3600 * 1000)
  S.markDispatched(st, plan[0].key, 'solo', 1000 + 3600 * 1000, plan[0].filename)
  const back = S.recordFailure(st, plan[0].key, 'solo', {}, 1000 + 3601 * 1000)
  assert.ok(back, 'the file returns to pending')
  assert.equal(st.done[plan[0].key], undefined, 'and is NOT marked exhausted')
})

test('four distinct failed sources DO mark the file exhausted', () => {
  const st = S.createState()
  S.addItem(st, { filename: 'y.flac', size: 100, sources: [src('a'), src('b'), src('c'), src('d')], addedAt: 1 })
  const key = st.pending[0].key
  let t = 1000
  for (const u of ['a', 'b', 'c', 'd']) {
    const plan = S.planDispatch(st, {}, t)
    if (!plan.length) break
    S.markDispatched(st, key, plan[0].username, t, plan[0].filename)
    S.recordFailure(st, key, plan[0].username, {}, t + 1)
    t += 3600 * 1000
    void u
  }
  assert.equal(st.done[key], 'exhausted')
})
