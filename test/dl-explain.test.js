'use strict'
// Why a stalled download is not moving, and when the auto-nudge may fire — the
// pure logic behind the Downloads Active tab's honest waiting line. A frozen file
// with an online peer used to say only "Waiting", which reads as "given up"; the
// data to say something true (position in line / not responding / retrying) was
// discarded. These tests pin the reason strings, the placeInQueue extraction
// (slskd omits the list field intermittently — verified live returning 303 while
// the list said undefined), and the nudge throttle.
const test = require('node:test')
const assert = require('node:assert')
const E = require('../src/dl-explain')

// ── placeInQueue extraction ──────────────────────────────────────────────────
// slskd's list field is populated only while queued, and 0 means "not known yet"
// — reading it as position 0 would show "position 0", which is a lie.
test('placeInQueue reads a real position and rejects the unknown sentinels', () => {
  assert.strictEqual(E.placeInQueue({ placeInQueue: 303 }), 303, 'the live value seen on the daemon')
  assert.strictEqual(E.placeInQueue({ placeInQueue: 1 }), 1)
  assert.strictEqual(E.placeInQueue({ placeInQueue: 0 }), null, '0 is slskd for not-yet-known')
  assert.strictEqual(E.placeInQueue({ placeInQueue: -1 }), null)
  assert.strictEqual(E.placeInQueue({}), null, 'the list omits it intermittently')
  assert.strictEqual(E.placeInQueue(null), null)
})

// ── waitingReason precedence ─────────────────────────────────────────────────
test('an actively-downloading row has nothing to explain', () => {
  assert.strictEqual(
    E.waitingReason({ state: 'InProgress', bytesTransferred: 1024, username: 'bob' }, null, 1000),
    '', 'moving bytes need no excuse')
})

test('a known queue position says where in line, and at whom', () => {
  assert.strictEqual(
    E.waitingReason({ state: 'Queued, Remotely', username: 'sibylline', placeInQueue: 303 }, null, 1000),
    'In line at sibylline (position 303)')
  // Position but no peer name still says the number.
  assert.strictEqual(
    E.waitingReason({ state: 'Queued', username: '', placeInQueue: 4 }, null, 1000),
    'In line (position 4)')
})

test('a failed/errored/timed-out transfer reads as the peer not responding', () => {
  assert.strictEqual(E.waitingReason({ state: 'Completed, Errored', username: 'bob' }, null, 1000), 'Peer not responding')
  assert.strictEqual(E.waitingReason({ state: 'Completed, TimedOut', username: 'bob' }, null, 1000), 'Peer not responding')
  assert.strictEqual(E.waitingReason({ state: 'Completed, Rejected', username: 'bob' }, null, 1000), 'Peer not responding')
})

test('a scheduler retry countdown wins over a bare queued state', () => {
  // attempts is the count already made; the NEXT attempt is attempts+1.
  assert.strictEqual(
    E.waitingReason({ state: 'Queued', username: 'bob' },
      { attempts: 1, maxAttempts: 4, nextRetryInMs: 12000 }, 1000),
    'Retrying via another source in 12s (attempt 2/4)')
  // Sub-second rounds up to at least 1s — never "in 0s".
  assert.match(
    E.waitingReason({ state: 'Queued', username: 'bob' },
      { attempts: 0, maxAttempts: 4, nextRetryInMs: 400 }, 1000),
    /in 1s \(attempt 1\/4\)/)
  // The shown attempt never exceeds the max.
  assert.match(
    E.waitingReason({ state: 'Queued', username: 'bob' },
      { attempts: 4, maxAttempts: 4, nextRetryInMs: 5000 }, 1000),
    /attempt 4\/4/)
})

test('a queued row with no position and no retry still says "In line", honestly', () => {
  assert.strictEqual(E.waitingReason({ state: 'Queued', username: 'bob' }, null, 1000), 'In line at bob')
  // The scheduler's "searching…" placeholder is not a peer to be in line at.
  assert.strictEqual(E.waitingReason({ state: 'Queued', username: 'searching…' }, null, 1000), 'In line')
})

// ── the auto-nudge gate ──────────────────────────────────────────────────────
// Only re-source an inflight file that is genuinely wedged: zero bytes, minutes
// in, peer online, and not nudged recently. Getting any of these wrong either
// disturbs a healthy slow transfer or storms slskd re-searching every tick.
const now = 1_000_000_000
const fiveMinAgo = now - 5 * 60 * 1000 - 1
const twoMinAgo = now - 2 * 60 * 1000

test('a wedged file (0 bytes, 5+ min, peer online, not throttled) is nudged', () => {
  assert.strictEqual(
    E.shouldNudge({ since: fiveMinAgo, bytesTransferred: 0 },
      { now, peerOnline: true, lastNudgeAt: 0 }), true)
})

test('any real progress means it is not wedged — never nudged', () => {
  assert.strictEqual(
    E.shouldNudge({ since: fiveMinAgo, bytesTransferred: 1 },
      { now, peerOnline: true, lastNudgeAt: 0 }), false)
})

test('a file inflight less than 5 minutes is left alone', () => {
  assert.strictEqual(
    E.shouldNudge({ since: twoMinAgo, bytesTransferred: 0 },
      { now, peerOnline: true, lastNudgeAt: 0 }), false)
})

test('an offline peer is not nudged — the peer, not the app, is the problem', () => {
  assert.strictEqual(
    E.shouldNudge({ since: fiveMinAgo, bytesTransferred: 0 },
      { now, peerOnline: false, lastNudgeAt: 0 }), false)
})

test('the throttle holds: no second nudge within 30 minutes of the last', () => {
  const nudgedTenMinAgo = now - 10 * 60 * 1000
  assert.strictEqual(
    E.shouldNudge({ since: fiveMinAgo, bytesTransferred: 0 },
      { now, peerOnline: true, lastNudgeAt: nudgedTenMinAgo }), false,
    '10 min < 30 min throttle')
  // Past the window it is allowed again.
  const nudgedLongAgo = now - 31 * 60 * 1000
  assert.strictEqual(
    E.shouldNudge({ since: fiveMinAgo, bytesTransferred: 0 },
      { now, peerOnline: true, lastNudgeAt: nudgedLongAgo }), true,
    '31 min > 30 min throttle')
})

test('the throttle window is 30 minutes and the wait is 5 minutes', () => {
  assert.strictEqual(E.NUDGE_THROTTLE_MS, 30 * 60 * 1000)
  assert.strictEqual(E.NUDGE_AFTER_MS, 5 * 60 * 1000)
})
