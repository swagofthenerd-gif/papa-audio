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

const { liftFns, MAIN } = require('./helpers/lift-main-fn.js')

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

test('dlTick asks before fetching, and asks before the fetch', () => {
  // The predicate can be as careful as it likes; if the tick never consults it,
  // or consults it after the megabyte is already on the wire, none of it counts.
  const at = MAIN.indexOf('async function dlTick() {')
  assert.ok(at > -1)
  const body = MAIN.slice(at, MAIN.indexOf('\n  } finally {', at))
  const ask = body.indexOf('dlNeedsSnapshot(')
  const fetch = body.indexOf('await dlSnapshot()')
  assert.ok(ask > -1, 'dlTick must consult dlNeedsSnapshot')
  assert.ok(fetch > -1, 'and still fetch when it says yes')
  assert.ok(ask < fetch, 'the question comes before the megabyte, not after it')
  assert.ok(/if \(!dlNeedsSnapshot\([^)]*\)\) return/.test(body),
    'and a no must actually end the tick')
  assert.ok(body.includes('_dlLastSnapshotAt = now'),
    'a fetch must stamp the heartbeat, or every tick looks overdue')
})
