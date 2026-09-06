'use strict'
const test = require('node:test')
const assert = require('node:assert')
const M = require('../src/slsk-chat-model')

const msg = (username, message, at, direction) => ({ username, message, at, direction })

// ── threads: folding + ordering ───────────────────────────────────────────────
test('threads groups by peer, newest-activity first, chronological within', () => {
  const list = [
    msg('bob', 'hi', 100, 'in'),
    msg('alice', 'yo', 300, 'in'),
    msg('bob', 'you there?', 200, 'in'),
  ]
  const ts = M.threads(list, {})
  assert.deepStrictEqual(ts.map(t => t.username), ['alice', 'bob']) // alice's last (300) beats bob's (200)
  const bob = ts.find(t => t.username === 'bob')
  assert.deepStrictEqual(bob.messages.map(m => m.message), ['hi', 'you there?'])
  assert.strictEqual(bob.last.message, 'you there?')
})

test('threads is case-insensitive on username and keeps a display name', () => {
  const ts = M.threads([msg('Bob', 'a', 1, 'in'), msg('bob', 'b', 2, 'in')], {})
  assert.strictEqual(ts.length, 1)
  assert.strictEqual(ts[0].messages.length, 2)
})

test('threads tolerates a non-array and drops rows with no username', () => {
  assert.deepStrictEqual(M.threads(null, {}), [])
  assert.deepStrictEqual(M.threads([{ message: 'x', at: 1 }], {}), [])
})

// ── unread badge logic ────────────────────────────────────────────────────────
test('unread counts incoming messages newer than the read mark, never outgoing', () => {
  const list = [
    msg('bob', 'seen', 100, 'in'),
    msg('bob', 'new1', 200, 'in'),
    msg('bob', 'my reply', 250, 'out'),
    msg('bob', 'new2', 300, 'in'),
  ]
  // Read up to at=100: two incoming ones after it are unread; the outgoing is not.
  const readAt = { bob: 100 }
  const bob = M.threads(list, readAt).find(t => t.username === 'bob')
  assert.strictEqual(bob.unread, 2)
  assert.strictEqual(M.totalUnread(list, readAt), 2)
})

test('a thread fully read shows zero unread', () => {
  const list = [msg('bob', 'a', 100, 'in'), msg('bob', 'b', 200, 'in')]
  assert.strictEqual(M.totalUnread(list, { bob: 200 }), 0)
})

test('with no read marks every incoming message is unread', () => {
  const list = [msg('a', '1', 1, 'in'), msg('a', '2', 2, 'in'), msg('a', '3', 3, 'out')]
  assert.strictEqual(M.totalUnread(list, {}), 2)
})

test('totalUnread sums across every conversation', () => {
  const list = [
    msg('a', 'x', 10, 'in'),
    msg('b', 'y', 20, 'in'),
    msg('b', 'z', 30, 'in'),
  ]
  assert.strictEqual(M.totalUnread(list, {}), 3)
})

// ── readMarkFor ───────────────────────────────────────────────────────────────
test('readMarkFor returns the newest at in the thread', () => {
  const thread = { messages: [msg('a', '1', 100, 'in'), msg('a', '2', 300, 'out'), msg('a', '3', 200, 'in')] }
  assert.strictEqual(M.readMarkFor(thread, 0), 300)
})

test('readMarkFor never rewinds a prior mark and handles an empty thread', () => {
  assert.strictEqual(M.readMarkFor({ messages: [] }, 500), 500)
  assert.strictEqual(M.readMarkFor(null, 500), 500)
  // An older thread must not lower a higher existing mark.
  assert.strictEqual(M.readMarkFor({ messages: [msg('a', '1', 100, 'in')] }, 500), 500)
})

// ── ingest: local-echo de-duplication ─────────────────────────────────────────
test('ingest appends a new message and de-dupes an exact echo', () => {
  let list = []
  const out = msg('bob', 'hi', 1000, 'out')
  list = M.ingest(list, out)
  assert.strictEqual(list.length, 1)
  // The daemon echoes the same line back (same user/text/at) — not shown twice.
  list = M.ingest(list, msg('bob', 'hi', 1000, 'in'))
  assert.strictEqual(list.length, 1)
  // A genuinely different message at another time is kept.
  list = M.ingest(list, msg('bob', 'hi', 2000, 'in'))
  assert.strictEqual(list.length, 2)
})

test('ingest returns a new array and ignores a bad message', () => {
  const before = [msg('a', 'x', 1, 'in')]
  const after = M.ingest(before, null)
  assert.notStrictEqual(after, before)
  assert.strictEqual(after.length, 1)
  assert.strictEqual(M.ingest(before, { message: 'no user' }).length, 1)
})

// ── toast text ────────────────────────────────────────────────────────────────
test('toastFor names the sender and is click-to-open worded', () => {
  assert.strictEqual(M.toastFor(msg('bob', 'hi', 1, 'in')), 'Message from bob — click to open')
  assert.strictEqual(M.toastFor(null), 'Message from someone — click to open')
})
