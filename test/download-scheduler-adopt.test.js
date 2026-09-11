'use strict'
// R5 root cause: after a restart the scheduler wrote its in-flight files back
// to pending and re-requested them while slskd still had them queued; the
// daemon refused each duplicate and the refusal counted as a failed attempt.
// Adoption takes such a file as in flight again with no request and no
// attempt burned.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const S = require('../src/download-scheduler')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function stateWithPending() {
  const st = S.createState()
  const e = S.addItem(st, { filename: 'Sigur Ros - Atta\\01 - Glod.flac', size: 1e8, sources: [{ username: 'ou812isee', filename: 'Sigur Ros - Atta\\01 - Glod.flac', size: 1e8 }], addedAt: 1000 })
  e.attempts = 5
  e.tried = ['ou812isee']
  e.triedAt = { ou812isee: 900 }
  return { st, e }
}

test('adoptLive moves a pending entry to inflight without burning an attempt', () => {
  const { st, e } = stateWithPending()
  const live = S.adoptLive(st, e.key, 'ou812isee', 5000, e.filename)
  assert.ok(live && live.adopted, 'adopted')
  assert.equal(st.pending.length, 0)
  assert.equal(Object.keys(st.inflight).length, 1)
  assert.equal(live.attempts, 5, 'adoption is not an attempt')
  assert.deepEqual(live.tried, ['ou812isee'])
  assert.equal(live.triedAt.ou812isee, 900, 'an earlier try keeps its time')
  assert.equal(live.since, 5000)
  assert.equal(S.stats(st).pending, 0)
  assert.equal(S.stats(st).inflight, 1)
})

test('adoptLive records a peer it had never tried, so source accounting stays honest', () => {
  const { st, e } = stateWithPending()
  const live = S.adoptLive(st, e.key, 'otherpeer', 5000, 'Other\\01 - Glod.flac')
  assert.deepEqual(live.tried, ['ou812isee', 'otherpeer'])
  assert.equal(live.sentFilename, 'Other\\01 - Glod.flac')
  assert.equal(S.distinctTried(live), 2)
})

test('adoptLive on an unknown key is a no-op', () => {
  const { st } = stateWithPending()
  assert.equal(S.adoptLive(st, 'nope', 'x', 1), null)
  assert.equal(st.pending.length, 1)
})

test('an adopted entry is reconciled like any other and never re-dispatched', () => {
  const { st, e } = stateWithPending()
  S.adoptLive(st, e.key, 'ou812isee', 5000, e.filename)
  const plan = S.planDispatch(st, {}, 6000)
  assert.deepEqual(plan, [], 'in flight → not planned')
  S.recordSuccess(st, e.key, 'ou812isee')
  assert.equal(st.done[e.key], 'succeeded')
})

test('main: the tick adopts before it dispatches, only for live or delivered daemon copies', () => {
  const tick = MAIN.slice(MAIN.indexOf('async function dlTick'), MAIN.indexOf('let dlRestored = false'))
  const adoptAt = tick.indexOf('dlSched.adoptLive(dlState, entry.key, seen.username, now, seen.filename)')
  const dispatchAt = tick.indexOf('dlSched.planDispatch(dlState, cfg, now)')
  const reconcileAt = tick.indexOf('for (const key of Object.keys(dlState.inflight))')
  assert.ok(adoptAt !== -1, 'adopt pass exists')
  assert.ok(adoptAt < reconcileAt && reconcileAt < dispatchAt, 'adopt → reconcile → dispatch')
  const pass = tick.slice(tick.indexOf('for (const entry of dlState.pending.slice())'), adoptAt)
  assert.match(pass, /r\.kind === 'active' \|\| r\.kind === 'succeeded'/, 'a failed or cancelled daemon record must NOT be adopted (it is history; the entry legitimately retries)')
  assert.match(tick.slice(adoptAt, adoptAt + 300), /seen\.kind === 'succeeded'\) dlSched\.recordSuccess/)
  assert.doesNotMatch(MAIN, /a duplicate request is harmless/, 'the comment that excused the bug is gone')
})
