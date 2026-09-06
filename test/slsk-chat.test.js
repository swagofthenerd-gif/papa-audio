'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  normalizeList, normalizeListRow, normalizeHistory, normalizeMessage,
  lastMessageAt, diffIncoming, _toMs, _dir,
} = require('../src/slsk-chat')

// ── timestamp + direction helpers ─────────────────────────────────────────────
test('_toMs parses slskd ISO stamps, degrades unknowns to 0 (never NaN)', () => {
  assert.strictEqual(_toMs('2026-07-16T21:52:19Z'), Date.parse('2026-07-16T21:52:19Z'))
  assert.strictEqual(_toMs(null), 0)
  assert.strictEqual(_toMs('not a date'), 0)
  assert.strictEqual(_toMs(1700000000000), 1700000000000)
})

test('_dir lowercases and treats anything but Out as incoming', () => {
  assert.strictEqual(_dir('In'), 'in')
  assert.strictEqual(_dir('Out'), 'out')
  assert.strictEqual(_dir(undefined), 'in')
  assert.strictEqual(_dir('weird'), 'in')
})

// ── conversation list ─────────────────────────────────────────────────────────
test('normalizeListRow maps unAcknowledgedMessageCount -> unreadCount', () => {
  assert.deepStrictEqual(
    normalizeListRow({ username: 'bob', unAcknowledgedMessageCount: 3 }),
    { username: 'bob', unreadCount: 3, lastMessageAt: 0 })
})

test('normalizeListRow clamps a bad unread count to 0', () => {
  assert.strictEqual(normalizeListRow({ username: 'a', unAcknowledgedMessageCount: -5 }).unreadCount, 0)
  assert.strictEqual(normalizeListRow({ username: 'a' }).unreadCount, 0)
})

test('normalizeList drops rows with no username and survives a non-array', () => {
  const rows = normalizeList([
    { username: 'a', unAcknowledgedMessageCount: 1 },
    { username: '', unAcknowledgedMessageCount: 9 },
  ])
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].username, 'a')
  assert.deepStrictEqual(normalizeList(null), [])
})

// ── per-user history ──────────────────────────────────────────────────────────
const convo = {
  username: 'chapinet_vm',
  messages: [
    { timestamp: '2026-07-16T21:52:19Z', id: 1, username: 'chapinet_vm', direction: 'In', message: 'hi' },
    { timestamp: '2026-07-16T21:53:00Z', id: 2, username: 'me', direction: 'Out', message: 'hello back' },
  ],
}

test('normalizeHistory maps to {direction,message,at}, oldest-first', () => {
  const h = normalizeHistory(convo)
  assert.strictEqual(h.length, 2)
  assert.deepStrictEqual(h[0], { direction: 'in', message: 'hi', at: Date.parse('2026-07-16T21:52:19Z') })
  assert.strictEqual(h[1].direction, 'out')
})

test('normalizeHistory degrades a payload with no messages to []', () => {
  assert.deepStrictEqual(normalizeHistory({ username: 'x' }), [])
  assert.deepStrictEqual(normalizeHistory(null), [])
})

test('normalizeMessage coerces a null message body to an empty string', () => {
  assert.strictEqual(normalizeMessage({ direction: 'In', message: null }).message, '')
})

test('lastMessageAt returns the newest timestamp, 0 when empty', () => {
  assert.strictEqual(lastMessageAt(convo), Date.parse('2026-07-16T21:53:00Z'))
  assert.strictEqual(lastMessageAt({ messages: [] }), 0)
})

// ── diffIncoming: the 30s poll's new-message detector ─────────────────────────
test('first sight of a user adopts the watermark and emits nothing', () => {
  const r = diffIncoming(convo.messages, null)
  assert.deepStrictEqual(r.fresh, [])
  assert.strictEqual(r.lastSeenId, 2, 'watermark is the highest id present')
})

test('a genuinely new incoming message is surfaced and advances the watermark', () => {
  const msgs = convo.messages.concat([
    { timestamp: '2026-07-16T22:00:00Z', id: 5, username: 'chapinet_vm', direction: 'In', message: 'new!' },
  ])
  const r = diffIncoming(msgs, 2)
  assert.strictEqual(r.fresh.length, 1)
  assert.strictEqual(r.fresh[0].message, 'new!')
  assert.strictEqual(r.fresh[0].username, 'chapinet_vm')
  assert.strictEqual(r.fresh[0].at, Date.parse('2026-07-16T22:00:00Z'))
  assert.strictEqual(r.lastSeenId, 5)
})

test('our own outgoing message never fires the incoming event', () => {
  const msgs = convo.messages.concat([
    { timestamp: '2026-07-16T22:05:00Z', id: 6, username: 'me', direction: 'Out', message: 'my reply' },
  ])
  const r = diffIncoming(msgs, 2)
  assert.deepStrictEqual(r.fresh, [])
  // ...but the watermark still advances past our own message, so an older
  // incoming one is not re-notified after we reply.
  assert.strictEqual(r.lastSeenId, 6)
})

test('nothing newer than the watermark yields no fresh messages', () => {
  const r = diffIncoming(convo.messages, 2)
  assert.deepStrictEqual(r.fresh, [])
  assert.strictEqual(r.lastSeenId, 2)
})

test('multiple new incoming messages come back oldest-first', () => {
  const msgs = [
    { id: 10, direction: 'In', username: 'u', message: 'a', timestamp: '2026-01-01T00:00:03Z' },
    { id: 8, direction: 'In', username: 'u', message: 'b', timestamp: '2026-01-01T00:00:01Z' },
    { id: 9, direction: 'In', username: 'u', message: 'c', timestamp: '2026-01-01T00:00:02Z' },
  ]
  const r = diffIncoming(msgs, 7)
  assert.deepStrictEqual(r.fresh.map(m => m.message), ['b', 'c', 'a'])
  assert.strictEqual(r.lastSeenId, 10)
})
