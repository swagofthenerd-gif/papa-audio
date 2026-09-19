'use strict'
// A stall is a transfer that is not moving. It was measured as a transfer that
// was not FINISHED.
//
// stalledItems only asked "has this been in flight for twenty minutes, and is
// there another peer?". It never looked at slskd. dlTick then DELETEd the
// transfer and re-requested the file somewhere else — and Soulseek has no
// resume, so a large FLAC coming down slowly but perfectly well was thrown away
// at the twenty-minute mark and restarted from zero, forever. The wedged case
// the check exists for is the opposite one: "Queued, Remotely", zero bytes, for
// twenty minutes.
//
// The real scheduler is used here. The whole point is what it decides.

const test = require('node:test')
const assert = require('node:assert')

const dlSched = require('../src/download-scheduler.js')

const MIN = 60 * 1000
const T0 = 1_700_000_000_000

// Two sources so an alternate always exists — otherwise stalledItems returns
// nothing for reasons that have nothing to do with progress, and the test would
// pass while measuring nothing.
function stateWithInflight(extra) {
  const live = Object.assign({
    username: 'peerA',
    filename: 'Artist/Album/01 - Long One.flac',
    sentFilename: 'Artist/Album/01 - Long One.flac',
    size: 300e6,
    sources: [
      { username: 'peerA', filename: 'Artist/Album/01 - Long One.flac', size: 300e6, queueLength: 0 },
      { username: 'peerB', filename: 'Other/01 - Long One.flac', size: 300e6, queueLength: 0 },
    ],
    tried: ['peerA'],
    triedAt: { peerA: T0 },
    attempts: 1,
    addedAt: T0,
    since: T0,
  }, extra || {})
  return {
    pending: [], inflight: { k1: live }, done: {},
    abandonedIds: {}, peerFailures: {}, subLog: [],
  }
}

const cfg = { stallAfterMs: 20 * MIN }

test('the premise: with no progress map, twenty-one minutes is reported as a stall', () => {
  const st = stateWithInflight()
  const out = dlSched.stalledItems(st, cfg, T0 + 21 * MIN)
  assert.strictEqual(out.length, 1, 'the wall-clock rule still holds when there is nothing better to go on')
  assert.strictEqual(out[0].from, 'peerA')
  assert.strictEqual(out[0].to, 'peerB')
})

test('a transfer slskd calls InProgress is never a stall, however long it has run', () => {
  const st = stateWithInflight()
  const out = dlSched.stalledItems(st, cfg, T0 + 21 * MIN, {
    k1: { state: 'InProgress', bytesTransferred: 5e6 },
  })
  assert.deepStrictEqual(out, [],
    'cancelling this restarts a running download from zero — Soulseek has no resume')
})

test('Queued, Remotely at zero bytes for twenty-one minutes IS a stall', () => {
  const st = stateWithInflight()
  const out = dlSched.stalledItems(st, cfg, T0 + 21 * MIN, {
    k1: { state: 'Queued, Remotely', bytesTransferred: 0 },
  })
  assert.strictEqual(out.length, 1, 'this is the case the stall check exists for')
  assert.strictEqual(out[0].key, 'k1')
  assert.strictEqual(out[0].to, 'peerB')
})

test('a byte count that crawls forward a kilobyte a tick is not a stall', () => {
  const st = stateWithInflight()
  let bytes = 0
  let now = T0
  // Twenty-five minutes of four-second ticks, 1 KB each. Slow enough that the
  // wall-clock rule alone would have cancelled it five minutes ago.
  for (let i = 0; i < 375; i++) {
    now += 4000
    bytes += 1024
    const out = dlSched.stalledItems(st, cfg, now, {
      // Deliberately NOT InProgress: the byte movement alone must carry this,
      // so the test cannot pass on the state string.
      k1: { state: 'Queued, Locally', bytesTransferred: bytes },
    })
    assert.deepStrictEqual(out, [], `tick ${i} at ${now - T0}ms called a moving transfer stalled`)
  }
  assert.ok(now - T0 > 24 * MIN, 'the run really did pass the twenty-minute mark')
})

test('a transfer that moved and then froze is a stall once the clock runs out again', () => {
  const st = stateWithInflight()
  // Ten minutes of real progress…
  dlSched.stalledItems(st, cfg, T0 + 10 * MIN, { k1: { state: 'InProgress', bytesTransferred: 40e6 } })
  // …then nothing more, ever.
  const at25 = dlSched.stalledItems(st, cfg, T0 + 25 * MIN, {
    k1: { state: 'Queued, Remotely', bytesTransferred: 40e6 },
  })
  assert.deepStrictEqual(at25, [],
    'only fifteen minutes since the last byte moved — not yet')
  const at31 = dlSched.stalledItems(st, cfg, T0 + 31 * MIN, {
    k1: { state: 'Queued, Remotely', bytesTransferred: 40e6 },
  })
  assert.strictEqual(at31.length, 1, 'twenty-one minutes with no byte moving is a stall')
})

test('a key slskd has nothing to say about falls back to the wall clock', () => {
  const st = stateWithInflight()
  const out = dlSched.stalledItems(st, cfg, T0 + 21 * MIN, { someOtherKey: { state: 'InProgress' } })
  assert.strictEqual(out.length, 1,
    'an absent record is not evidence of progress')
})

test('dlTick hands the snapshot state and bytes to stalledItems', () => {
  // The module can be as careful as it likes; if main.js never passes the
  // progress map, none of it runs in the app.
  const fs = require('fs')
  const path = require('path')
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const at = MAIN.indexOf('const stalled = dlSched.stalledItems(')
  assert.ok(at > -1, 'dlTick must still call stalledItems')
  const call = MAIN.slice(at, MAIN.indexOf('\n', at))
  assert.ok(/stalledItems\(dlState, cfg, now, \w+\)/.test(call),
    'stalledItems must be called with a progress map, got: ' + call)
  const built = MAIN.slice(MAIN.lastIndexOf('const dlProgress = {}', at), at)
  assert.ok(built.includes('bytesTransferred') && built.includes('state:'),
    'the progress map must carry both the slskd state and the byte count')
})
