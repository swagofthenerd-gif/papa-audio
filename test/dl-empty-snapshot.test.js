'use strict'
// An empty answer from slskd is not the same as "everything was cancelled".
//
// dlSnapshot returns null only when the fetch THROWS. A 204 or an empty body
// iterates nothing and hands back an empty Map — which is truthy, so it sailed
// past `if (!snap) return`. Every in-flight file then looked removed, and 30
// seconds later the loop called recordAbandoned on all of them.
//
// recordAbandoned is terminal AND persisted, and it writes a band-independent
// song key, so the same song was blocked from every peer and in every format,
// forever, across restarts. slskd answers this way while restarting — which is
// exactly what changing the download folder, the share mode or the Soulseek
// password does, and what our own health monitor does when it decides the
// daemon is unhealthy.
//
// WHAT THIS FILE USED TO PIN, AND WHY IT WAS WRONG
//
// The old version tested only the two-tick WAIT, and its third case asserted
// that a second consecutive empty snapshot was "believed" — meaning the tick
// fell through to the abandon loop. That was the bug itself, pinned as if it
// were the fix. The wait bought eight seconds; a restarting daemon takes longer
// than eight seconds, so the queue was destroyed on the second tick instead of
// the first. Waiting longer is not the answer either: an empty list is not
// evidence about any individual transfer at all.
//
// So the wait stands (it is still right not to act on one odd answer), and
// after it the missing entries are RE-QUEUED, not abandoned. Abandonment is
// kept for the only case that really is a user cancel: slskd listing other
// transfers but not this one.
//
// The real scheduler and the real dlReconcileMissing are used here, not
// stand-ins: the point is what actually happens to the state.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const dlSched = require('../src/download-scheduler.js')
const { liftFns } = require('./helpers/lift-main-fn.js')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

// The guard as it is shipped, lifted out of dlTick and run for real.
function liftGuard() {
  const at = MAIN.indexOf('let snapshotLostTrack = false')
  assert.ok(at > -1, 'the empty-snapshot guard must still exist in dlTick')
  const end = MAIN.indexOf('\n    }', MAIN.indexOf('} else {', at)) + '\n    }'.length
  return MAIN.slice(at, end)
}
const GUARD = liftGuard()

function runGuard({ snap, dlState, empties }) {
  // Returns { returned, empties, lostTrack }. `returned` true means the tick
  // bailed out before the reconcile loop.
  const fn = new Function('snap', 'dlState', '_state', 'console', `
    let _dlEmptySnapshots = _state.empties
    let _returned = false
    let _lost = false
    ;(function () {
      ${GUARD}
      _lost = snapshotLostTrack
    })()
    return { returned: _returned, empties: _dlEmptySnapshots, lostTrack: _lost }
  `.replace(/\breturn\b(?![^\n]*\{)/g, '_returned = true; return'))
  return fn(snap, dlState, { empties: empties }, { warn() {} })
}

const { fns } = liftFns(['dlReconcileMissing'], { dlSched })
const dlReconcileMissing = fns.dlReconcileMissing

const CFG = Object.assign({}, dlSched.DEFAULTS)
const T0 = 1_700_000_000_000

function inflightEntry(n) {
  return {
    username: 'peer' + n,
    filename: 'Artist/Album/0' + n + ' - Track.flac',
    sentFilename: 'Artist/Album/0' + n + ' - Track.flac',
    size: 30e6 + n,
    sources: [{ username: 'peer' + n, filename: 'Artist/Album/0' + n + ' - Track.flac', size: 30e6 + n }],
    tried: ['peer' + n],
    triedAt: { ['peer' + n]: T0 },
    attempts: 1,
    addedAt: T0,
    since: T0,
  }
}

function stateWithInflight(count = 1) {
  const inflight = {}
  for (let n = 1; n <= count; n++) inflight['k' + n] = inflightEntry(n)
  return { inflight, pending: [], done: {}, abandonedIds: {}, peerFailures: {}, subLog: [] }
}

test('recordAbandoned really is terminal and really does block the song everywhere', () => {
  // The premise. If this ever stops being true the whole file matters less, and
  // it should be revisited rather than quietly kept.
  const st = stateWithInflight(1)
  dlSched.recordAbandoned(st, 'k1')
  assert.strictEqual(st.done.k1, 'abandoned')
  assert.strictEqual(Object.keys(st.inflight).length, 0)
  assert.ok(Object.keys(st.abandonedIds).length >= 1,
    'the identity is written down, which is what makes it survive a restart')
})

test('one empty snapshot does not even reach the reconcile loop', () => {
  const dlState = stateWithInflight(1)
  const r = runGuard({ snap: new Map(), dlState, empties: 0 })
  assert.strictEqual(r.returned, true, 'the tick must bail out')
  assert.strictEqual(r.empties, 1, 'and remember that it saw one')
  assert.deepStrictEqual(dlState.done, {}, 'nothing abandoned')
  assert.strictEqual(Object.keys(dlState.inflight).length, 1, 'the file is still in flight')
})

test('a second consecutive empty snapshot falls through, flagged as lost track', () => {
  const dlState = stateWithInflight(1)
  const r = runGuard({ snap: new Map(), dlState, empties: 1 })
  assert.strictEqual(r.returned, false, 'the tick proceeds')
  assert.strictEqual(r.lostTrack, true,
    'and carries the fact that slskd listed NOTHING into the reconcile loop, ' +
    'which is what stops it reading silence as a cancellation')
})

test('an empty snapshot with nothing in flight is ordinary, and resets the streak', () => {
  const dlState = { inflight: {}, pending: [], done: {}, abandonedIds: {} }
  const r = runGuard({ snap: new Map(), dlState, empties: 1 })
  assert.strictEqual(r.returned, false)
  assert.strictEqual(r.empties, 0, 'the streak only counts contradictions')
  assert.strictEqual(r.lostTrack, false)
})

test('a normal non-empty snapshot resets the streak and is not lost track', () => {
  const dlState = stateWithInflight(1)
  const snap = new Map([['Artist/Album/01 - Track.flac', { state: 'InProgress' }]])
  const r = runGuard({ snap, dlState, empties: 1 })
  assert.strictEqual(r.returned, false)
  assert.strictEqual(r.empties, 0)
  assert.strictEqual(r.lostTrack, false)
})

// ── What happens to the files themselves ────────────────────────────────────

test('two empty answers re-queue every in-flight file and abandon none of them', () => {
  const dlState = stateWithInflight(3)
  const now = T0 + 60000 // past the 30 s grace
  for (const key of Object.keys(dlState.inflight)) {
    const live = dlState.inflight[key]
    const verdict = dlReconcileMissing(dlState, key, live, CFG, now, true)
    assert.strictEqual(verdict, 'requeued', key + ' must be re-queued, not abandoned')
  }
  assert.strictEqual(dlState.pending.length, 3,
    'all three files are back in the queue and will be dispatched again')
  assert.strictEqual(Object.keys(dlState.inflight).length, 0)
  assert.deepStrictEqual(Object.keys(dlState.abandonedIds), [],
    'not one identity is blacklisted — this is the part that used to be forever')
  assert.deepStrictEqual(Object.values(dlState.done), [],
    'and nothing is terminal')
  for (const e of dlState.pending) {
    assert.strictEqual(e.attempts, 1, 'the attempt history is kept, not reset and not burned')
    assert.match(String(e.reason), /lost track/i, 'and the reason says what happened')
  }
})

test('nobody is blamed for a daemon that lost its list', () => {
  // recordFailure would re-queue these too, so re-queueing alone does not prove
  // the right call was made. The peer ledger is what separates them: a peer that
  // was quietly uploading when its daemon restarted must not collect a strike,
  // and five strikes bench it for ten minutes.
  const dlState = stateWithInflight(2)
  const now = T0 + 60000
  for (const key of Object.keys(dlState.inflight)) {
    dlReconcileMissing(dlState, key, dlState.inflight[key], CFG, now, true)
  }
  assert.strictEqual(dlState.pending.length, 2, 'the files did come back')
  assert.deepStrictEqual(dlState.peerFailures, {},
    'and not one peer was charged for it')
})

test('a transfer missing from a list that holds others IS a cancellation', () => {
  // The case abandonment is actually for: slskd is answering normally, it just
  // does not have this one any more. Someone removed it.
  const dlState = stateWithInflight(2)
  const now = T0 + 60000
  const verdict = dlReconcileMissing(dlState, 'k1', dlState.inflight.k1, CFG, now, false)
  assert.strictEqual(verdict, 'abandoned')
  assert.strictEqual(dlState.done.k1, 'abandoned')
  assert.ok(Object.keys(dlState.abandonedIds).length >= 1,
    'a real cancel still sticks across every peer and format')
  assert.strictEqual(dlState.pending.length, 0, 'and is not re-queued')
})

test('the 30-second grace still applies on both paths', () => {
  const dlState = stateWithInflight(1)
  const soon = T0 + 10000
  assert.strictEqual(dlReconcileMissing(dlState, 'k1', dlState.inflight.k1, CFG, soon, true), 'wait')
  assert.strictEqual(dlReconcileMissing(dlState, 'k1', dlState.inflight.k1, CFG, soon, false), 'wait')
  assert.strictEqual(Object.keys(dlState.inflight).length, 1)
  assert.strictEqual(dlState.pending.length, 0)
})

test('dlTick routes the missing case through dlReconcileMissing, not straight to recordAbandoned', () => {
  const at = MAIN.indexOf('      if (!seen) {')
  assert.ok(at > -1, 'the reconcile loop must still have a missing-transfer branch')
  const branch = MAIN.slice(at, MAIN.indexOf('\n      }', at))
  assert.ok(branch.includes('dlReconcileMissing'),
    'the branch must delegate the decision, so the lost-track case is reachable')
  assert.ok(!branch.includes('recordAbandoned'),
    'and must not abandon on its own behind the helper\'s back')
  assert.ok(/dlReconcileMissing\([^)]*snapshotLostTrack\)/.test(branch),
    'the lost-track flag must actually be passed in')
})
