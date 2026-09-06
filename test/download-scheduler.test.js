const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/download-scheduler')

function src(username, opts = {}) {
  return Object.assign({ username }, opts)
}

function seed(files, sources, t0 = 1000) {
  const st = S.createState()
  files.forEach((f, i) => S.addItem(st, { filename: f, size: 100, sources, addedAt: t0 + i }))
  return st
}

test('a peer never gets more than the per-peer cap queued at once', () => {
  const st = seed(['a', 'b', 'c', 'd', 'e', 'f'], [src('solo')])
  const plan = S.planDispatch(st, { maxPerPeer: 2, maxGlobalInflight: 50 }, 5000)
  assert.equal(plan.length, 2)
  assert.ok(plan.every(p => p.username === 'solo'))
})

test('work spreads across peers instead of piling on one', () => {
  const st = seed(['a', 'b', 'c', 'd'], [src('x'), src('y')])
  const plan = S.planDispatch(st, { maxPerPeer: 2, maxGlobalInflight: 50 }, 5000)
  const byPeer = plan.reduce((m, p) => (m[p.username] = (m[p.username] || 0) + 1, m), {})
  assert.deepEqual(byPeer, { x: 2, y: 2 })
})

test('global cap bounds total in-flight regardless of peer count', () => {
  const st = seed(['a', 'b', 'c', 'd', 'e'], [src('x'), src('y'), src('z')])
  const plan = S.planDispatch(st, { maxPerPeer: 4, maxGlobalInflight: 3 }, 5000)
  assert.equal(plan.length, 3)
})

test('a peer with a free slot outranks a peer with a shorter queue', () => {
  const ranked = S.rankSources([
    src('slow', { queueLength: 0, uploadSpeed: 10 }),
    src('open', { hasFreeUploadSlot: true, queueLength: 50, uploadSpeed: 1 }),
  ])
  assert.equal(ranked[0].username, 'open')
})

test('failure re-points the file at a different peer, not the same one', () => {
  const st = seed(['a'], [src('bad'), src('good')])
  const first = S.planDispatch(st, {}, 5000)
  assert.equal(first[0].username, 'bad')
  S.markDispatched(st, 'a', 'bad', 5000)
  S.recordFailure(st, 'a', 'bad', {}, 6000)
  const second = S.planDispatch(st, {}, 6000)
  assert.equal(second.length, 1)
  assert.equal(second[0].username, 'good')
})

test('a file is dropped only after exhausting its attempt budget', () => {
  const st = seed(['a'], [src('p1'), src('p2')])
  S.markDispatched(st, 'a', 'p1', 1)
  S.recordFailure(st, 'a', 'p1', { maxAttempts: 2 }, 2)
  S.markDispatched(st, 'a', 'p2', 3)
  S.recordFailure(st, 'a', 'p2', { maxAttempts: 2 }, 4)
  assert.equal(st.done['a'], 'exhausted')
  assert.equal(st.pending.length, 0)
})

test('a repeatedly failing peer gets benched and stops receiving work', () => {
  const st = S.createState()
  const cfg = { peerFailureLimit: 3, peerFailureCooldownMs: 1000, retryPeerAfterMs: 500 }
  for (let i = 0; i < 3; i++) {
    S.addItem(st, { filename: 'f' + i, size: 1, sources: [src('kdeaner')], addedAt: i })
    S.markDispatched(st, 'f' + i, 'kdeaner', 10)
    S.recordFailure(st, 'f' + i, 'kdeaner', cfg, 20)
  }
  assert.ok(S.peerBenched(st, 'kdeaner', 100))
  assert.equal(S.planDispatch(st, cfg, 100).length, 0)
  // ...and comes back once the cooldown expires.
  assert.ok(!S.peerBenched(st, 'kdeaner', 5000))
  assert.ok(S.planDispatch(st, cfg, 5000).length > 0)
})

test('success clears a peer\'s failure streak', () => {
  const st = seed(['a', 'b'], [src('flaky')])
  S.markDispatched(st, 'a', 'flaky', 1)
  S.recordFailure(st, 'a', 'flaky', { peerFailureLimit: 2 }, 2)
  assert.equal(st.peerFailures['flaky'].consecutive, 1)
  S.markDispatched(st, 'b', 'flaky', 3)
  S.recordSuccess(st, 'b', 'flaky')
  assert.equal(st.peerFailures['flaky'].consecutive, 0)
})

test('the same file requested twice is one want, with merged sources', () => {
  const st = S.createState()
  S.addItem(st, { filename: 'a', size: 1, sources: [src('x')], addedAt: 1 })
  S.addItem(st, { filename: 'a', size: 1, sources: [src('y')], addedAt: 2 })
  assert.equal(st.pending.length, 1)
  assert.deepEqual(st.pending[0].sources.map(s => s.username), ['x', 'y'])
})

test('a file with no untried source is reported as starved, not lost', () => {
  const st = seed(['a'], [src('only')])
  S.markDispatched(st, 'a', 'only', 1)
  S.recordFailure(st, 'a', 'only', {}, 2)
  assert.equal(S.planDispatch(st, {}, 3).length, 0)
  const starved = S.starvedItems(st, {}, 3)
  assert.equal(starved.length, 1)
  assert.equal(starved[0].key, 'a')
  // A fresh source found by a later search revives it.
  S.addSources(st, 'a', [src('rescuer')])
  assert.equal(S.planDispatch(st, {}, 4)[0].username, 'rescuer')
})

test('oldest request goes first so a big album is not starved by later ones', () => {
  const st = S.createState()
  S.addItem(st, { filename: 'late', size: 1, sources: [src('x')], addedAt: 900 })
  S.addItem(st, { filename: 'early', size: 1, sources: [src('x')], addedAt: 100 })
  const plan = S.planDispatch(st, { maxPerPeer: 1 }, 1000)
  assert.equal(plan[0].key, 'early')
})

test('completed files are not re-queued, and the refusal is reported', () => {
  const st = seed(['a'], [src('x')])
  S.markDispatched(st, 'a', 'x', 1)
  S.recordSuccess(st, 'a', 'x')
  // The behaviour is unchanged: nothing is queued and nothing is dispatched.
  // What changed is that the refusal says WHY instead of returning a bare null,
  // so the caller can tell "already downloaded" from "you cancelled this" and
  // show something. A silent null was the whole reason a refused re-add looked
  // like a button that did nothing.
  const r = S.addItem(st, { filename: 'a', size: 1, sources: [src('x')] })
  assert.equal(r.refused, 'succeeded')
  assert.equal(st.pending.length, 0)
  assert.equal(S.planDispatch(st, {}, 2).length, 0)
})

test('an explicit re-add overrides a terminal state, but only when asked', () => {
  // The scheduler must never revive a cancelled file on its own — that is what
  // made cancel look broken. The user asking again is new information.
  const st = seed(['a'], [src('x')])
  S.markDispatched(st, 'a', 'x', 1)
  S.recordAbandoned(st, 'a')
  assert.equal(S.addItem(st, { filename: 'a', size: 1, sources: [src('x')] }).refused, 'abandoned')
  assert.equal(st.pending.length, 0, 'not without force')
  const forced = S.addItem(st, { filename: 'a', size: 1, sources: [src('x')] }, { force: true })
  assert.equal(forced.key, 'a')
  assert.equal(st.pending.length, 1)
  assert.equal(st.done['a'], undefined, 'the terminal mark is cleared')
})

test('a genuinely new source revives an exhausted file', () => {
  // The one case the alternate-source search exists for was the one case that
  // could not benefit: the file was in `done`, so nothing would take a source.
  const st = seed(['a'], [src('x')])
  S.markDispatched(st, 'a', 'x', 1)
  S.recordFailure(st, 'a', 'x', { maxAttempts: 1 }, 2)
  assert.equal(st.done['a'], 'exhausted')
  assert.equal(S.addSources(st, 'a', [src('z')]), 1)
  assert.equal(st.done['a'], undefined)
  assert.equal(st.pending.length, 1)
  assert.equal(st.pending[0].attempts, 0, 'a new peer earns a fresh attempt count')
})

test('a stall at the attempt limit is exhausted, not re-queued forever', () => {
  // Re-queueing made a zombie: planDispatch skips it on attempts, starvedItems
  // skips it so no fresh-source search runs, it is never written to done, and it
  // is persisted — a download waiting forever, across restarts.
  const st = seed(['a'], [src('x')])
  S.markDispatched(st, 'a', 'x', 1)
  st.inflight['a'].attempts = 4
  assert.equal(S.recordStall(st, 'a', 'x', { maxAttempts: 4 }, 99999), null)
  assert.equal(st.pending.length, 0)
  assert.equal(st.done['a'], 'exhausted')
})

test('no entry in pending may sit at or above the attempt limit', () => {
  // The invariant behind the zombie bug. Drive every terminal path and check it.
  const cfg = { maxAttempts: 2 }
  const st = seed(['a'], [src('x'), src('y'), src('z')])
  for (let i = 0; i < 6; i++) {
    const plan = S.planDispatch(st, cfg, i * 10)
    if (plan.length) S.markDispatched(st, plan[0].key, plan[0].username, i * 10, plan[0].filename)
    if (st.inflight['a']) {
      if (i % 2) S.recordFailure(st, 'a', st.inflight['a'].username, cfg, i * 10 + 1)
      else S.recordStall(st, 'a', st.inflight['a'].username, cfg, i * 10 + 1)
    }
    for (const e of st.pending) {
      assert.ok(e.attempts < cfg.maxAttempts,
        `pending entry has attempts=${e.attempts} of ${cfg.maxAttempts}`)
    }
  }
})

test('stats report the live spread across peers', () => {
  const st = seed(['a', 'b', 'c'], [src('x'), src('y')])
  S.planDispatch(st, { maxPerPeer: 2 }, 1).forEach(p => S.markDispatched(st, p.key, p.username, 1))
  const s = S.stats(st)
  assert.equal(s.inflight, 3)
  assert.equal(s.peers, 2)
})

test('a peer that failed is retried later, but not immediately', () => {
  const st = S.createState()
  const cfg = { retryPeerAfterMs: 1000, maxAttempts: 5 }
  S.addItem(st, { filename: 'a', size: 1, sources: [src('only')], addedAt: 0 })
  S.markDispatched(st, 'a', 'only', 0)
  S.recordFailure(st, 'a', 'only', cfg, 10)
  // Inside the backoff window: held, not hammered.
  assert.equal(S.planDispatch(st, cfg, 500).length, 0)
  // Past it: the one source we know is worth another shot.
  assert.equal(S.planDispatch(st, cfg, 2000)[0].username, 'only')
})

test('cancelling a held file is possible without slskd knowing about it', () => {
  // The UI addresses held files by a synthetic id; the key must round-trip.
  const st = seed(['deep/path/song.flac'], [src('x')])
  assert.equal(st.pending[0].key, 'deep/path/song.flac')
  const id = 'sched:' + st.pending[0].key
  assert.equal(id.slice(6), st.pending[0].key)
})

test('defaults keep meaningful queue depth per peer', () => {
  // A shallow cap costs your earned place in a working peer's queue.
  assert.ok(S.DEFAULTS.maxPerPeer >= 10)
  assert.ok(S.DEFAULTS.maxGlobalInflight >= S.DEFAULTS.maxPerPeer * 4)
})

test('a peer that queues you forever is detected as stalled', () => {
  const st = seed(['a'], [src('sitter'), src('server', { hasFreeUploadSlot: true })])
  const cfg = { stallAfterMs: 1000 }
  S.markDispatched(st, 'a', 'sitter', 0)
  assert.equal(S.stalledItems(st, cfg, 500).length, 0)   // still within patience
  const stalled = S.stalledItems(st, cfg, 5000)
  assert.equal(stalled.length, 1)
  assert.equal(stalled[0].from, 'sitter')
  assert.equal(stalled[0].to, 'server')
})

test('a stall is NOT reported when there is nowhere better to go', () => {
  // Giving up an earned queue position with no alternative is strictly worse
  // than waiting — this is the rule that keeps downloads from "vanishing".
  const st = seed(['a'], [src('sitter')])
  S.markDispatched(st, 'a', 'sitter', 0)
  assert.equal(S.stalledItems(st, { stallAfterMs: 1000 }, 999999).length, 0)
})

test('re-pointing a stalled file does not blame the peer', () => {
  const st = seed(['a'], [src('sitter'), src('server')])
  S.markDispatched(st, 'a', 'sitter', 0)
  S.recordStall(st, 'a', 'sitter', { stallAfterMs: 1000 }, 5000)
  assert.equal(st.peerFailures['sitter'], undefined)   // not a failure
  assert.equal(st.pending.length, 1)
  assert.deepEqual(st.pending[0].tried, ['sitter'])
})

test('single-source files stuck too long are flagged for a source hunt', () => {
  const st = seed(['a', 'b'], [src('only')])
  S.markDispatched(st, 'a', 'only', 0)
  S.markDispatched(st, 'b', 'only', 0)
  S.addSources(st, 'b', [src('backup')])
  const hunt = S.stalledWithoutAlternate(st, { stallAfterMs: 1000 }, 5000)
  assert.deepEqual(hunt.map(h => h.key), ['a'])   // 'b' already has an alternate
})

// ── Regressions: duplicate downloads and cancel not sticking ────────────────

test('an alternate source is tracked under the path actually sent', () => {
  // The original bug: we POST the alternate peer's path but record the
  // original key, so reconcile never matches and re-dispatches a duplicate.
  const st = S.createState()
  S.addItem(st, { filename: 'peerA/Song.flac', size: 1, addedAt: 1, sources: [
    { username: 'A', filename: 'peerA/Song.flac' },
    { username: 'B', filename: 'peerB/other/Song.flac' },
  ]})
  const plan = S.planDispatch(st, {}, 10)
  S.markDispatched(st, plan[0].key, plan[0].username, 10, plan[0].filename)
  const live = st.inflight[plan[0].key]
  assert.equal(live.sentFilename, plan[0].filename)
})

test('the same music is never fetched from two peers at once', () => {
  const st = S.createState()
  // Two separate requests that are really the same track under different paths.
  // Same byte count is what says "same release" — see fileIdentity.
  S.addItem(st, { filename: 'peerA/Change.flac', size: 1, sources: [src('A')], addedAt: 1 })
  S.addItem(st, { filename: 'peerB/deep/Change.flac', size: 1, sources: [src('B')], addedAt: 2 })
  const plan = S.planDispatch(st, {}, 10)
  assert.equal(plan.length, 1, 'only one copy of a given track may be dispatched')
})

test('two different tracks that share a filename do not block each other', () => {
  // "01 - Intro.flac" is a name dozens of albums share. Basename-only identity
  // meant one album in flight blocked every other album's first track for good.
  const st = S.createState()
  S.addItem(st, { filename: '/AlbumA/01 - Intro.flac', size: 100, sources: [src('A')], addedAt: 1 })
  S.addItem(st, { filename: '/AlbumB/01 - Intro.flac', size: 200, sources: [src('B')], addedAt: 2 })
  assert.equal(S.planDispatch(st, {}, 10).length, 2)
  const first = S.planDispatch(st, {}, 10)[0]
  S.markDispatched(st, first.key, first.username, 10, first.filename)
  assert.equal(S.planDispatch(st, {}, 11).length, 1, 'the other album is still dispatchable')
})

test('a dispatched track blocks a second copy on the next pass too', () => {
  const st = S.createState()
  S.addItem(st, { filename: 'x/Change.flac', size: 1, sources: [src('A')], addedAt: 1 })
  const first = S.planDispatch(st, {}, 10)
  S.markDispatched(st, first[0].key, 'A', 10, first[0].filename)
  S.addItem(st, { filename: 'y/Change.flac', size: 1, sources: [src('B')], addedAt: 2 })
  assert.equal(S.planDispatch(st, {}, 11).length, 0)
})

test('an abandoned file never comes back', () => {
  // Cancel must kill the intent, not just the transfer.
  const st = seed(['a'], [src('x'), src('y')])
  S.markDispatched(st, 'a', 'x', 1, 'a')
  S.recordAbandoned(st, 'a')
  assert.equal(st.done['a'], 'abandoned')
  assert.equal(st.pending.length, 0)
  assert.equal(S.planDispatch(st, {}, 99999).length, 0)
  // ...and re-adding it does not resurrect it either, unless the user forces it.
  assert.equal(S.addItem(st, { filename: 'a', size: 1, sources: [src('y')] }).refused, 'abandoned')
  assert.equal(st.pending.length, 0)
})

test('abandoning clears a file that is only pending, not in flight', () => {
  const st = seed(['a', 'b'], [src('x')])
  S.recordAbandoned(st, 'b')
  assert.deepEqual(st.pending.map(e => e.key), ['a'])
})

// ── Dispatch priority (roadmap #52) ──────────────────────────────────────────
// The queue lives on our side, so ordering is ours to control. The W5 UI pinned
// rows client-side; this is the real-dispatch half: planDispatch orders by
// (priority DESC, addedAt ASC), a group can be restamped whole, and the stamp
// survives persistence. Default 0 keeps every pre-existing state file ordering by
// addedAt exactly as before.

test('planDispatch orders by priority first, then addedAt within a band', () => {
  const st = S.createState()
  // Added oldest-to-newest; a single peer with one slot so only the head plans.
  S.addItem(st, { filename: 'old-low',  size: 1, sources: [src('solo')], addedAt: 100 })
  S.addItem(st, { filename: 'new-high', size: 1, sources: [src('solo')], addedAt: 300 }, { priority: 5 })
  S.addItem(st, { filename: 'mid-low',  size: 1, sources: [src('solo')], addedAt: 200 })
  const plan = S.planDispatch(st, { maxPerPeer: 3, maxGlobalInflight: 50 }, 5000)
  // The high-priority newcomer jumps ahead of both older-but-lower items; the two
  // low items keep addedAt order behind it.
  assert.deepEqual(plan.map(p => p.key), ['new-high', 'old-low', 'mid-low'])
})

test('default priority is 0 and orders purely by addedAt', () => {
  const st = seed(['a', 'b', 'c'], [src('solo')], 100)
  assert.ok(st.pending.every(e => e.priority === 0), 'no opts means priority 0')
  const plan = S.planDispatch(st, { maxPerPeer: 3, maxGlobalInflight: 50 }, 5000)
  assert.deepEqual(plan.map(p => p.key), ['a', 'b', 'c'])
})

test('prioritizeGroup restamps every queued file of one album group', () => {
  const st = S.createState()
  // Two albums from user u1 plus an unrelated album from u2.
  S.addItem(st, { filename: 'Music/DSOTM/01 Speak.flac', size: 1, sources: [src('u1')], addedAt: 1 })
  S.addItem(st, { filename: 'Music/DSOTM/02 Time.flac',  size: 1, sources: [src('u1')], addedAt: 2 })
  S.addItem(st, { filename: 'Music/Wall/01 In The Flesh.flac', size: 1, sources: [src('u1')], addedAt: 3 })
  S.addItem(st, { filename: 'Shared/DSOTM/03 Money.flac', size: 1, sources: [src('u2')], addedAt: 4 })
  const changed = S.prioritizeGroup(st, { username: 'u1', folderName: 'DSOTM' }, 10)
  assert.equal(changed, 2, 'only u1s two DSOTM tracks match')
  const byKey = {}
  st.pending.forEach(e => { byKey[e.key] = e.priority })
  assert.equal(byKey['Music/DSOTM/01 Speak.flac'], 10)
  assert.equal(byKey['Music/DSOTM/02 Time.flac'], 10)
  assert.equal(byKey['Music/Wall/01 In The Flesh.flac'], 0, 'different album untouched')
  assert.equal(byKey['Shared/DSOTM/03 Money.flac'], 0, 'different peer untouched')
})

test('prioritizeGroup lifts the whole album ahead of everything else', () => {
  const st = S.createState()
  S.addItem(st, { filename: 'Music/Other/x.flac', size: 1, sources: [src('solo')], addedAt: 1 })
  S.addItem(st, { filename: 'Music/DSOTM/01.flac', size: 1, sources: [src('solo')], addedAt: 2 })
  S.addItem(st, { filename: 'Music/DSOTM/02.flac', size: 1, sources: [src('solo')], addedAt: 3 })
  S.prioritizeGroup(st, { username: 'solo', folderName: 'DSOTM' }, 100)
  const plan = S.planDispatch(st, { maxPerPeer: 3, maxGlobalInflight: 50 }, 5000)
  assert.deepEqual(plan.map(p => p.key),
    ['Music/DSOTM/01.flac', 'Music/DSOTM/02.flac', 'Music/Other/x.flac'])
})

test('prioritizeGroup restamps an in-flight file so its re-queue keeps the band', () => {
  const st = S.createState()
  S.addItem(st, { filename: 'Music/DSOTM/01.flac', size: 1, sources: [src('u1'), src('u2')], addedAt: 1 })
  S.markDispatched(st, 'Music/DSOTM/01.flac', 'u1', 10, 'Music/DSOTM/01.flac')
  const changed = S.prioritizeGroup(st, { username: 'u1', folderName: 'DSOTM' }, 7)
  assert.equal(changed, 1)
  assert.equal(st.inflight['Music/DSOTM/01.flac'].priority, 7)
  // A failure re-queues it; the restamped priority must ride through.
  S.recordFailure(st, 'Music/DSOTM/01.flac', 'u1', {}, 20)
  assert.equal(st.pending[0].priority, 7, 'priority survives the failure round-trip')
})

test('a restored state without priority defaults to 0 (back-compat)', () => {
  const st = S.createState()
  // Simulate an old state file: an entry built with no priority field at all.
  st.pending.push({ key: 'a', filename: 'a', size: 1, sources: [src('solo')],
    tried: [], triedAt: {}, attempts: 0, addedAt: 1 })
  st.pending.push({ key: 'b', filename: 'b', size: 1, sources: [src('solo')],
    tried: [], triedAt: {}, attempts: 0, addedAt: 2 })
  // planDispatch must not throw on the missing field and orders by addedAt.
  const plan = S.planDispatch(st, { maxPerPeer: 3, maxGlobalInflight: 50 }, 5000)
  assert.deepEqual(plan.map(p => p.key), ['a', 'b'])
})
