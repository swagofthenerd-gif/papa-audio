'use strict'
// dlTick fetched a megabyte every four seconds with nothing to download.
//
// GET /transfers/downloads measured 1,020,307 bytes on the reported install, and
// the tick runs every four seconds for the life of the process. With nothing
// pending, nothing in flight and no album group waiting to be verified, the
// reconcile loop, the dispatch plan and the stall check all iterate empty
// collections — there is nothing in that answer the tick would act on.
//
// The real dlNeedsSnapshot is used. Nothing here reaches slskd.

const test = require('node:test')
const assert = require('node:assert')

const { liftFns } = require('./helpers/lift-main-fn.js')

// ── M4: not fetching a megabyte every four seconds for nothing ──────────────

const { fns } = liftFns(['dlNeedsSnapshot'], {}, ['DL_IDLE_SNAPSHOT_MS'])
const dlNeedsSnapshot = fns.dlNeedsSnapshot

test('an idle scheduler fetches the transfer list once in fifteen ticks', () => {
  // Fifteen four-second ticks is one minute, which is the heartbeat.
  const idle = { pending: [], inflight: {} }
  const groups = new Map()
  let lastAt = 0
  let fetches = 0
  let now = 1_700_000_000_000
  for (let i = 0; i < 15; i++) {
    if (dlNeedsSnapshot(idle, groups, now, lastAt)) { fetches++; lastAt = now }
    now += 4000
  }
  assert.strictEqual(fetches, 1,
    'one heartbeat fetch, fourteen ticks that cost nothing')
})

test('the heartbeat really does come round', () => {
  const idle = { pending: [], inflight: {} }
  const groups = new Map()
  let lastAt = 0
  let fetches = 0
  let now = 1_700_000_000_000
  for (let i = 0; i < 31; i++) {
    if (dlNeedsSnapshot(idle, groups, now, lastAt)) { fetches++; lastAt = now }
    now += 4000
  }
  assert.strictEqual(fetches, 3, 'two minutes of ticks, three fetches')
})

test('anything actually happening fetches on every tick', () => {
  const now = 1_700_000_000_000
  assert.ok(dlNeedsSnapshot({ pending: [{ key: 'k' }], inflight: {} }, new Map(), now, now),
    'a pending file needs dispatching')
  assert.ok(dlNeedsSnapshot({ pending: [], inflight: { k: {} } }, new Map(), now, now),
    'an in-flight file needs reconciling')
  assert.ok(dlNeedsSnapshot({ pending: [], inflight: {} }, new Map([['g', {}]]), now, now),
    'a group awaiting verification needs its completions seen')
})
