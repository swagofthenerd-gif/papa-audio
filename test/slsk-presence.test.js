const test = require('node:test')
const assert = require('node:assert')
const P = require('../src/slsk-presence')

test('presence labels map slskd values, unknown for anything else', () => {
  assert.equal(P.presenceLabel('Online'), 'online')
  assert.equal(P.presenceLabel('away'), 'away')
  assert.equal(P.presenceLabel('Offline'), 'offline')
  assert.equal(P.presenceLabel('Unknown'), 'unknown')
  assert.equal(P.presenceLabel(null), 'unknown')
  assert.equal(P.presenceLabel(''), 'unknown')
})

test('a peer with no status yet is unknown, never offline', () => {
  const rows = P.mergeStatuses([{ username: 'doperst13', savedAt: 1 }], [])
  assert.equal(rows[0].presence, 'unknown')
  assert.equal(rows[0].presenceText, 'Checking…')
})

test('status lookup is case-insensitive on the username', () => {
  const rows = P.mergeStatuses(
    [{ username: 'DopeRst13', savedAt: 1 }],
    [{ username: 'doperst13', presence: 'Online', isPrivileged: true, checkedAt: 5 }])
  assert.equal(rows[0].presence, 'online')
  assert.equal(rows[0].isPrivileged, true)
  assert.equal(rows[0].checkedAt, 5)
})

test('reachable peers sort above unreachable ones', () => {
  const rows = P.sortFriends(P.mergeStatuses(
    [
      { username: 'cold', savedAt: 9 },
      { username: 'gone', savedAt: 8 },
      { username: 'here', savedAt: 1 },
      { username: 'idle', savedAt: 2 },
    ],
    [
      { username: 'gone', presence: 'Offline' },
      { username: 'here', presence: 'Online' },
      { username: 'idle', presence: 'Away' },
    ]))
  assert.deepEqual(rows.map(r => r.username), ['here', 'idle', 'gone', 'cold'])
})

test('within one presence bucket, most recently browsed wins', () => {
  const rows = P.sortFriends(P.mergeStatuses(
    [
      { username: 'old', savedAt: 1, lastBrowsedAt: 10 },
      { username: 'new', savedAt: 1, lastBrowsedAt: 99 },
    ],
    [
      { username: 'old', presence: 'Online' },
      { username: 'new', presence: 'Online' },
    ]))
  assert.deepEqual(rows.map(r => r.username), ['new', 'old'])
})

test('online count includes away but not offline or unknown', () => {
  const rows = P.mergeStatuses(
    [{ username: 'a' }, { username: 'b' }, { username: 'c' }, { username: 'd' }],
    [
      { username: 'a', presence: 'Online' },
      { username: 'b', presence: 'Away' },
      { username: 'c', presence: 'Offline' },
    ])
  assert.equal(P.countOnline(rows), 2)
})

test('indexStatuses tolerates junk entries', () => {
  const idx = P.indexStatuses([null, {}, { username: 'x', presence: 'Online' }])
  assert.deepEqual(Object.keys(idx), ['x'])
})
