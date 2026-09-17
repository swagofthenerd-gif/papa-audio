'use strict'
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/download-scheduler')

const A = 'Artist/Album/01 - Song.flac'

// slsk-retry-transfer does exactly this: DELETE the stuck transfer at the
// daemon, then addItems([oneItem], {force:true}). The file is still marked
// inflight in our own state at that moment — that is what "stuck" means — and
// the inflight refusal ran before force was ever considered. So the re-enqueue
// was refused, the handler still returned ok, and the UI still said "Retrying…"
// while nothing had been re-queued. Seconds later the reconcile loop noticed the
// transfer had vanished from slskd and recorded it as abandoned, blacklisting
// the track for good.
//
// Every existing test of this path called recordAbandoned first, which clears
// inflight as a side effect — so none of them exercised the production
// sequence, and the gap went unseen.
test('retrying a stuck, still-inflight download actually re-queues it', () => {
  const st = S.createState()
  S.addItem(st, { filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] })
  S.markDispatched(st, S.itemKey(A), 'alice', 1000, A)
  assert.ok(st.inflight[S.itemKey(A)], 'precondition: the file is inflight, i.e. stuck')

  const res = S.addItems(st, [{ filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] }],
    { force: true })

  assert.strictEqual(res.added, 1, 'the forced retry must take, not be refused as inflight')
  assert.ok(st.pending.some(e => e.filename === A), 'and the file is queued again')
  assert.ok(!st.inflight[S.itemKey(A)],
    'the stuck attempt is released — the daemon-side transfer was already deleted by the caller')
})

// Without force, an inflight file must still be refused: that guard is what
// stops the scheduler queueing the same file twice while it is downloading.
test('an unforced add of an inflight file is still refused', () => {
  const st = S.createState()
  S.addItem(st, { filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] })
  S.markDispatched(st, S.itemKey(A), 'alice', 1000, A)
  const res = S.addItems(st, [{ filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] }],
    { force: false })
  assert.strictEqual(res.added, 0)
  assert.strictEqual(res.refused[0].reason, 'inflight')
  assert.ok(st.inflight[S.itemKey(A)], 'and the live transfer is left alone')
})

// The force must stay scoped to the identity being retried.
test('a forced retry of one inflight file does not disturb another', () => {
  const B = 'Artist/Album/02 - Other.flac'
  const st = S.createState()
  S.addItem(st, { filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] })
  S.addItem(st, { filename: B, size: 200, sources: [{ username: 'carol', filename: B, size: 200 }] })
  S.markDispatched(st, S.itemKey(A), 'alice', 1000, A)
  S.markDispatched(st, S.itemKey(B), 'carol', 1000, B)
  S.addItems(st, [{ filename: A, size: 100, sources: [{ username: 'alice', filename: A, size: 100 }] }],
    { force: true })
  assert.ok(!st.inflight[S.itemKey(A)], 'the retried one is released')
  assert.ok(st.inflight[S.itemKey(B)], "the other file's live transfer is untouched")
})
