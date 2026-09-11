'use strict'
// R5: one reconciled model behind every number on the Downloads page. One
// test per displayed figure, plus the invariant that the cards add up.
const test = require('node:test')
const assert = require('node:assert')
const N = require('../src/dl-numbers')

const tr = (o) => Object.assign({ id: 't' + Math.random().toString(36).slice(2), username: 'peer1', filename: '@@a\\Camel\\Mirage\\01.flac', size: 100, bytesRemaining: 0, averageSpeed: 0 }, o)
const held = (o) => Object.assign({ id: 'sched:k1', scheduled: true, state: 'Queued, Scheduled', username: 'searching…', filename: '@@h\\X\\Y\\01.flac', percentComplete: 0, averageSpeed: 0 }, o)

// ── Buckets ──────────────────────────────────────────────────────────────────

test('every transfer lands in exactly one bucket, and the buckets read as the page labels them', () => {
  assert.equal(N.bucket(tr({ state: 'InProgress' })), 'downloading')
  assert.equal(N.bucket(tr({ state: 'Requested' })), 'connecting')
  assert.equal(N.bucket(tr({ state: 'Initializing' })), 'connecting')
  assert.equal(N.bucket(tr({ state: 'Queued, Remotely' })), 'queuedAtPeer')
  assert.equal(N.bucket(held()), 'waitingForSource', 'a scheduler-held row is waiting for a source, never "queued"')
  assert.equal(N.bucket(tr({ id: 'sched:z', state: 'Queued, Scheduled' })), 'waitingForSource')
  assert.equal(N.bucket(tr({ state: 'Completed, Succeeded' })), 'completed')
  assert.equal(N.bucket(tr({ state: 'Completed, Errored' })), 'failed')
  assert.equal(N.bucket(tr({ state: 'Completed, Cancelled' })), 'cancelled')
  assert.equal(N.bucket(null), 'failed')
})

// ── Merging the two lists ────────────────────────────────────────────────────

test('mergeHeld adds unknown held files and replaces a FAILED earlier attempt of the same file', () => {
  const failed = tr({ state: 'Completed, Errored', filename: 'same.flac' })
  const other = tr({ state: 'InProgress', filename: 'other.flac' })
  const out = N.mergeHeld([failed, other], [held({ filename: 'same.flac' }), held({ id: 'sched:k2', filename: 'new.flac' })])
  const names = out.map(f => f.filename + ':' + N.bucket(f)).sort()
  assert.deepEqual(names, ['new.flac:waitingForSource', 'other.flac:downloading', 'same.flac:waitingForSource'])
})

test('mergeHeld never doubles a file slskd is already moving or has delivered', () => {
  const live = tr({ state: 'InProgress', filename: 'same.flac' })
  const done = tr({ state: 'Completed, Succeeded', filename: 'done.flac' })
  const out = N.mergeHeld([live, done], [held({ filename: 'same.flac' }), held({ id: 'sched:k2', filename: 'done.flac' })])
  assert.equal(out.length, 2)
  assert.ok(out.every(f => !N.isHeld(f)))
})

test('mergeHeld is safe on empty and malformed input', () => {
  assert.deepEqual(N.mergeHeld(null, null), [])
  assert.equal(N.mergeHeld([tr({ state: 'InProgress' })], [null]).length, 1)
})

// ── The model ────────────────────────────────────────────────────────────────

function sample() {
  return N.mergeHeld([
    tr({ state: 'InProgress', averageSpeed: 1000, bytesRemaining: 50, remainingTime: '00:01:40', filename: 'a\\A\\1.flac' }),
    tr({ state: 'InProgress', averageSpeed: 500, bytesRemaining: 10, remainingTime: '00:00:20', filename: 'a\\A\\2.flac' }),
    tr({ state: 'Queued, Remotely', bytesRemaining: 100, filename: 'a\\B\\1.flac', username: 'peer2' }),
    tr({ state: 'Requested', bytesRemaining: 100, filename: 'a\\B\\2.flac', username: 'peer2' }),
    tr({ state: 'Completed, Succeeded', filename: 'a\\C\\1.flac' }),
    tr({ state: 'Completed, Succeeded', filename: 'a\\C\\2.flac' }),
    tr({ state: 'Completed, Errored', filename: 'a\\D\\1.flac' }),
    tr({ state: 'Completed, Errored', filename: 'a\\E\\1.flac' }),   // retried below → waiting
    tr({ state: 'Completed, Cancelled', filename: 'a\\F\\1.flac' }),
  ], [held({ filename: 'a\\E\\1.flac' }), held({ id: 'sched:k2', filename: 'a\\G\\1.flac' })])
}

test('reconcile files every transfer once and the buckets add up to the total', () => {
  const m = N.reconcile(sample(), { pending: 2, inflight: 4, peers: 2, benched: ['slowpeer'] })
  assert.deepEqual(m.files, {
    downloading: 2, connecting: 1, queuedAtPeer: 1, waitingForSource: 2,
    completed: 2, failed: 1, cancelled: 1,
    inQueue: 6, waiting: 4, total: 10,
  })
  assert.ok(m.consistent)
  assert.equal(m.speed, 1500)
  assert.equal(m.remaining, 50 + 10 + 100 + 100, 'bytes still to come for the queue only')
  assert.equal(m.etaSecs, 100)
  assert.deepEqual(m.albums, { inQueue: 4, completed: 1, failed: 1 })
  assert.deepEqual(m.scheduler, { known: true, waiting: 2, sending: 4, peers: 2, benched: 1 })
})

test('reconcile with no scheduler stats says so instead of pretending zero', () => {
  const m = N.reconcile([], null)
  assert.equal(m.scheduler.known, false)
  assert.equal(N.schedulerLine(m), 'Scheduler status unavailable')
  assert.equal(m.files.total, 0)
  assert.ok(m.consistent)
})

// ── One test per displayed number ────────────────────────────────────────────

test('dashboard cards: files, adding up to Total, with a Cancelled card only when needed', () => {
  const m = N.reconcile(sample(), null)
  const cards = N.dashboardCards(m)
  const byKey = Object.fromEntries(cards.map(c => [c.key, c]))
  assert.equal(byKey.downloading.value, 2)
  assert.equal(byKey.waiting.value, 4)
  assert.equal(byKey.waiting.sub, '1 at peers · 1 connecting · 2 for a source')
  assert.equal(byKey.completed.value, 2)
  assert.equal(byKey.completed.sub, '1 album')
  assert.equal(byKey.failed.value, 1)
  assert.equal(byKey.cancelled.value, 1)
  assert.equal(byKey.total.value, 10)
  const sum = cards.filter(c => c.key !== 'total').reduce((s, c) => s + c.value, 0)
  assert.equal(sum, byKey.total.value, 'the cards must add up to Total')
  const none = N.dashboardCards(N.reconcile([tr({ state: 'InProgress' })], null))
  assert.ok(!none.some(c => c.key === 'cancelled'), 'no Cancelled card when nothing was cancelled')
  assert.equal(none.find(c => c.key === 'waiting').sub, 'files')
})

test('queue strip: downloading always, each waiting state only when non-zero, in queue order', () => {
  const m = N.reconcile(sample(), null)
  assert.deepEqual(N.queueStrip(m), [
    { key: 'downloading', value: 2, label: 'downloading' },
    { key: 'queuedAtPeer', value: 1, label: 'queued at peers' },
    { key: 'connecting', value: 1, label: 'connecting' },
    { key: 'waitingForSource', value: 2, label: 'waiting for a source' },
  ])
  assert.deepEqual(N.queueStrip(N.reconcile([], null)), [{ key: 'downloading', value: 0, label: 'downloading' }])
})

test('tab badges: the Downloading tab counts the whole queue, the others their own outcome', () => {
  const m = N.reconcile(sample(), null)
  assert.deepEqual(N.tabCounts(m), { active: 6, completed: 2, failed: 1 })
})

test('scheduler line: scheduler units, worded so they cannot be confused with the file counts', () => {
  const m = N.reconcile(sample(), { pending: 108, inflight: 12, peers: 4, benched: ['a', 'b'] })
  assert.equal(N.schedulerLine(m), '12 being sent across 4 peers · 108 waiting for a source · 2 sources benched')
  assert.equal(N.schedulerLine(N.reconcile([], { pending: 0, inflight: 0, peers: 0, benched: [] })), 'Scheduler idle')
  assert.equal(N.schedulerLine(N.reconcile([], { pending: 1, inflight: 1, peers: 1, benched: [] })), '1 being sent across 1 peer · 1 waiting for a source')
})

test('nav badge: the queue while there is one, today\'s finishes otherwise, title says which', () => {
  const m = N.reconcile(sample(), null)
  assert.deepEqual(N.navBadge(m, 5), { show: true, text: '6', title: '6 files in the download queue (2 downloading now)' })
  const idle = N.reconcile([tr({ state: 'Completed, Succeeded' })], null)
  assert.deepEqual(N.navBadge(idle, 3), { show: true, text: '3', title: '3 completed today' })
  assert.deepEqual(N.navBadge(idle, 0), { show: false, text: '0', title: '0 completed today' })
})

test('the three stories now agree: card Waiting + Downloading == tab badge == nav badge', () => {
  const m = N.reconcile(sample(), { pending: 2, inflight: 4, peers: 2, benched: [] })
  const cards = Object.fromEntries(N.dashboardCards(m).map(c => [c.key, c.value]))
  assert.equal(cards.downloading + cards.waiting, N.tabCounts(m).active)
  assert.equal(String(N.tabCounts(m).active), N.navBadge(m, 0).text)
  const strip = N.queueStrip(m).reduce((s, x) => s + x.value, 0)
  assert.equal(strip, N.tabCounts(m).active)
})

test('hmsToSecs reads slskd\'s remaining-time strings', () => {
  assert.equal(N.hmsToSecs('01:02:03'), 3723)
  assert.equal(N.hmsToSecs('02:03'), 123)
  assert.equal(N.hmsToSecs('7'), 7)
  assert.equal(N.hmsToSecs('nope'), 0)
  assert.equal(N.folderOf('a\\b\\c.flac'), 'a\\b')
  assert.equal(N.folderOf('x/y/z.flac'), 'x/y')
  assert.equal(N.folderOf('bare.flac'), '')
})
