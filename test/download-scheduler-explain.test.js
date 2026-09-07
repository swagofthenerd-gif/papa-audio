'use strict'
// The scheduler's explain view and the retry force-scoping.
//
// explainState feeds the Downloads UI the per-file attempts/retry-countdown that
// turn "Waiting" into "Retrying via another source in Ns (attempt X/4)". The
// force-scoping tests are the safety property the retry button depends on: a user
// retrying ONE file must re-request only that file, and must NEVER revive some
// OTHER file the user had abandoned. Getting that wrong would resurrect cancelled
// downloads — the exact field failure the abandonment machinery exists to prevent.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/download-scheduler')

const A = 'Miles Davis - Kind of Blue\\01 - So What.flac'
const B = 'Bill Evans - Sunday at the Village Vanguard\\02 - Gloria.flac'

// ── explainState ─────────────────────────────────────────────────────────────
test('explainState reports attempts, cap and source count per pending file', () => {
  const st = S.createState()
  S.addItem(st, { filename: A, size: 100, sources: [
    { username: 'alice', filename: A, size: 100 },
    { username: 'bob', filename: A, size: 100 },
  ] })
  const ex = S.explainState(st, {}, 1000)
  assert.ok(ex[A], 'the pending file is described')
  assert.strictEqual(ex[A].attempts, 0)
  assert.strictEqual(ex[A].maxAttempts, S.DEFAULTS.maxAttempts)
  assert.strictEqual(ex[A].sourceCount, 2)
  assert.strictEqual(ex[A].inflight, false)
  // No retry countdown while an untried source is ready to dispatch next tick.
  assert.strictEqual(ex[A].nextRetryInMs, null)
})

test('explainState gives a retry countdown once every source has been tried', () => {
  const st = S.createState()
  const cfg = { retryPeerAfterMs: 60000 }
  S.addItem(st, { filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] })
  // Dispatch to alice at t=1000, then a failure at t=2000 puts it back pending
  // with alice tried.
  S.markDispatched(st, S.itemKey(A), 'alice', 1000, A)
  S.recordFailure(st, S.itemKey(A), 'alice', cfg, 2000)
  // 30s after the failure: 30s of the 60s backoff remain before alice is eligible
  // again, and there is no untried source — so the row is "retrying in 30s".
  const ex = S.explainState(st, cfg, 2000 + 30000)
  assert.ok(ex[A], 'still tracked while it waits out the backoff')
  assert.strictEqual(ex[A].attempts, 1, 'one attempt made')
  assert.ok(ex[A].nextRetryInMs > 0 && ex[A].nextRetryInMs <= 30000,
    `~30s remain (was ${ex[A].nextRetryInMs}ms)`)
})

test('explainState marks an inflight file and gives it no queued-retry countdown', () => {
  const st = S.createState()
  S.addItem(st, { filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] })
  S.markDispatched(st, S.itemKey(A), 'alice', 1000, A)
  const ex = S.explainState(st, {}, 5000)
  assert.ok(ex[A])
  assert.strictEqual(ex[A].inflight, true)
  assert.strictEqual(ex[A].nextRetryInMs, null, 'inflight is explained by slskd state, not a countdown')
})

// ── retry force-scoping: the safety property ─────────────────────────────────
// This mirrors exactly what slsk-retry-transfer does: addItems([oneItem],
// {force:true}). The force must unblock ONLY that item's identity.
test('a forced retry of one file does NOT revive a DIFFERENT abandoned file', () => {
  const st = S.createState()
  // Two files queued and dispatched.
  S.addItem(st, { filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] })
  S.addItem(st, { filename: B, size: 200, sources: [{ username: 'carol', filename: B, size: 200 }] })
  S.markDispatched(st, S.itemKey(A), 'alice', 1000, A)
  S.markDispatched(st, S.itemKey(B), 'carol', 1000, B)
  // The user ABANDONS both (cancels them).
  S.recordAbandoned(st, S.itemKey(A))
  S.recordAbandoned(st, S.itemKey(B))
  assert.strictEqual(S.isAbandoned(st, A), true)
  assert.strictEqual(S.isAbandoned(st, B), true)

  // Now the user retries ONLY file A — exactly the retry handler's call.
  const res = S.addItems(st, [{ filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] }],
    { force: true })
  assert.strictEqual(res.added, 1, 'A came back')

  // A is queued again; B stays abandoned and absent from the queue.
  assert.strictEqual(S.isAbandoned(st, A), false, 'the retried file was unblocked')
  assert.strictEqual(S.isAbandoned(st, B), true, 'the OTHER abandoned file must stay dead')
  const pendingNames = st.pending.map(e => e.filename)
  assert.ok(pendingNames.includes(A), 'A is re-queued')
  assert.ok(!pendingNames.includes(B), 'B was NOT resurrected by A\'s retry')
})

test('a forced retry re-requests the same file even after it was abandoned', () => {
  const st = S.createState()
  S.addItem(st, { filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] })
  S.markDispatched(st, S.itemKey(A), 'alice', 1000, A)
  S.recordAbandoned(st, S.itemKey(A))
  // Without force, an abandoned file is refused (this is the anti-zombie gate).
  const refused = S.addItems(st, [{ filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] }],
    { force: false })
  assert.strictEqual(refused.added, 0, 'the scheduler on its own must never revive an abandoned file')
  assert.strictEqual(refused.refused[0].reason, 'abandoned')
  // With force (the user's explicit re-ask), it comes back.
  const forced = S.addItems(st, [{ filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] }],
    { force: true })
  assert.strictEqual(forced.added, 1)
  assert.strictEqual(S.isAbandoned(st, A), false)
})
