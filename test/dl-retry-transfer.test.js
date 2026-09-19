'use strict'
// Pressing Retry was a way to lose a song for good.
//
// slsk-retry-transfer DELETEs the stuck transfer at slskd and re-enqueues the
// file under the name slskd knows it by — which is often not the key the
// original was filed under, because an alternate source names the same music
// differently. So the scheduler's in-flight record of the original survived,
// and it did two kinds of damage:
//
//   - planDispatch refuses to race a second copy of an identity that is already
//     in flight, so the retry was never actually dispatched;
//   - the next tick's reconcile looked the original up, found the transfer we
//     had just deleted, and thirty seconds later abandoned the identity — which
//     is terminal and blocks the song from every peer in every format.
//
// The second failure: a row still showing "searching…" has no peer behind it.
// Retrying one re-enqueued an item with nowhere to send it and answered
// `added: 1` — a reported success for a download that cannot start.
//
// The real handler is lifted out of main.js and run; nothing here touches slskd.

const test = require('node:test')
const assert = require('node:assert')

const dlSched = require('../src/download-scheduler.js')
const { runHandler } = require('./helpers/lift-ipc.js')

const SENT = 'peerB shares/Miles Davis/Kind of Blue/03 - Blue in Green.flac'
const ORIGINAL = 'peerA music/Miles Davis/Kind of Blue/03 - Blue in Green.flac'
const SIZE = 42_000_000

// A scheduler state where the file is in flight under the ORIGINAL key but was
// actually sent to peerB under its own path — the alternate-source case, which
// is where the key and the sent name come apart.
function stateInflight() {
  const st = dlSched.createState()
  st.inflight[ORIGINAL] = {
    username: 'peerB',
    filename: ORIGINAL,
    sentFilename: SENT,
    size: SIZE,
    sources: [{ username: 'peerB', filename: SENT, size: SIZE }],
    tried: ['peerB'],
    triedAt: { peerB: 1 },
    attempts: 1,
    addedAt: 1,
    since: 1,
  }
  return st
}

function run(args, dlState) {
  return runHandler('slsk-retry-transfer', {
    dryRun: false,
    args,
    globals: {
      dlState,
      dlSched,
      dlStart() {},
      dlPersist() {},
      dlBroadcast() {},
      dlTick() {},
      dlDiscoveryEnabled() { return false },
      async slskdFetch() { return null },
      async dlFilenameForTransfer() { return SENT },
    },
  })
}

test('retrying clears the stale in-flight record so the retry can be dispatched', async () => {
  const dlState = stateInflight()
  const { result } = await run({ username: 'peerB', id: 'tr-1', filename: SENT, size: SIZE }, dlState)

  assert.ok(result && result.ok, JSON.stringify(result))
  assert.strictEqual(Object.keys(dlState.inflight).length, 0,
    'the record of the transfer we just deleted must not survive')
  assert.strictEqual(dlState.pending.length, 1, 'and the file is queued again')

  // The proof that it matters: planDispatch must now have something to send.
  const plan = dlSched.planDispatch(dlState, dlSched.DEFAULTS, Date.now() + 10 * 60 * 1000)
  assert.strictEqual(plan.length, 1, 'the retry is actually dispatchable')
  assert.strictEqual(plan[0].username, 'peerB')
})

test('the next reconcile has nothing left to abandon', async () => {
  // The killing blow: with the stale entry still there, a tick whose snapshot no
  // longer lists the deleted transfer abandoned the identity for good.
  const dlState = stateInflight()
  await run({ username: 'peerB', id: 'tr-1', filename: SENT, size: SIZE }, dlState)
  assert.deepStrictEqual(Object.keys(dlState.inflight), [],
    'nothing for reconcile to find missing')
  assert.deepStrictEqual(Object.keys(dlState.abandonedIds || {}), [],
    'and no identity blacklisted')
})

test('an unrelated in-flight file is left alone', async () => {
  const dlState = stateInflight()
  dlState.inflight['Other/Album/01 - Untouched.flac'] = {
    username: 'peerC', filename: 'Other/Album/01 - Untouched.flac',
    sentFilename: 'Other/Album/01 - Untouched.flac', size: 10e6,
    sources: [], tried: [], triedAt: {}, attempts: 1, addedAt: 1, since: 1,
  }
  await run({ username: 'peerB', id: 'tr-1', filename: SENT, size: SIZE }, dlState)
  assert.deepStrictEqual(Object.keys(dlState.inflight), ['Other/Album/01 - Untouched.flac'],
    'a retry must only clear its own file')
})

test('retrying a searching row says so instead of claiming it queued something', async () => {
  const dlState = dlSched.createState()
  const { result } = await run(
    { username: 'searching…', id: 'sched:' + ORIGINAL, filename: ORIGINAL, size: SIZE }, dlState)

  assert.ok(result && result.ok, JSON.stringify(result))
  assert.strictEqual(result.added, 0, 'nothing was queued, so do not report one')
  assert.strictEqual(result.searching, true)
  assert.ok(typeof result.message === 'string' && result.message.length > 0,
    'and there is something honest to show')
  assert.strictEqual(dlState.pending.length, 0,
    'no sourceless item parked in the queue either')
})

test('a missing username is treated the same as a searching row', async () => {
  const dlState = dlSched.createState()
  const { result } = await run({ id: 'sched:' + ORIGINAL, filename: ORIGINAL, size: SIZE }, dlState)
  assert.strictEqual(result.added, 0)
  assert.strictEqual(result.searching, true)
})

test('a real peer still queues a real retry', async () => {
  // The honest-answer change must not make the working case answer zero.
  const dlState = dlSched.createState()
  const { result } = await run(
    { username: 'peerB', id: 'sched:' + SENT, filename: SENT, size: SIZE }, dlState)
  assert.strictEqual(result.added, 1)
  assert.ok(!result.searching)
  assert.strictEqual(dlState.pending.length, 1)
  assert.strictEqual(dlState.pending[0].sources.length, 1)
})
