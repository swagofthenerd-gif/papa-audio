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

// ── L1: "Checking…" that never ends ─────────────────────────────────────────
// refreshSlskFriendStatuses swallowed a failed lookup (.catch(function(){})),
// so a peer whose status never arrived read "Checking… · 4h ago" for the rest
// of the session — a request that looks in flight and never was.

test('a peer we have not asked about yet still says Checking…', () => {
  const rows = P.mergeStatuses([{ username: 'sherrybaaz' }], [])
  assert.equal(rows[0].presence, P.PRESENCE_UNKNOWN)
  assert.equal(rows[0].presenceText, 'Checking…')
})

test('after a failed lookup it says so instead', () => {
  const rows = P.mergeStatuses([{ username: 'sherrybaaz' }], [], { checkFailed: true })
  assert.equal(rows[0].presenceText, "Couldn't check")
})

test('a failed refresh does not relabel peers we DO know about', () => {
  const rows = P.mergeStatuses(
    [{ username: 'a' }, { username: 'b' }, { username: 'c' }],
    [
      { username: 'a', presence: 'Online' },
      { username: 'b', presence: 'Offline' },
    ],
    { checkFailed: true })
  const by = Object.fromEntries(rows.map(r => [r.username, r.presenceText]))
  assert.equal(by.a, 'Online')
  assert.equal(by.b, 'Offline')
  assert.equal(by.c, "Couldn't check")
})

test('the failure flag does not change sorting or the online count', () => {
  const users = [{ username: 'a' }, { username: 'b' }]
  const st = [{ username: 'a', presence: 'Online' }]
  const ok = P.sortFriends(P.mergeStatuses(users, st))
  const bad = P.sortFriends(P.mergeStatuses(users, st, { checkFailed: true }))
  assert.deepEqual(ok.map(r => r.username), bad.map(r => r.username))
  assert.equal(P.countOnline(bad), P.countOnline(ok))
})

test('MUTATION: ignoring the flag puts "Checking…" back on a failed lookup', () => {
  const fs = require('fs')
  const path = require('path')
  const vm = require('vm')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-presence.js'), 'utf8')
  const broken = src.replace(
    "  return checkFailed ? \"Couldn't check\" : 'Checking…'",
    "  return 'Checking…'")
  assert.notEqual(broken, src, 'the mutation applied')
  const ctx = vm.createContext({ module: { exports: {} }, Object, Array, String, Boolean })
  vm.runInContext(broken, ctx)
  const B = ctx.module.exports
  assert.equal(B.mergeStatuses([{ username: 'a' }], [], { checkFailed: true })[0].presenceText,
    'Checking…', 'this is the reported bug')
})

// ── L1, the renderer half ───────────────────────────────────────────────────
// The pure module can only say "Couldn't check" if something sets the flag.
// These drive the real refresh function.

function friendsHarness (source) {
  const fs = require('fs')
  const path = require('path')
  const vm = require('vm')
  const RENDERER = source || fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const lift = (name) => {
    const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(RENDERER)
    assert.ok(m, name + ' not found')
    const start = m.index + 1
    const end = RENDERER.indexOf('\n}\n', start)
    return RENDERER.slice(start, end + 2)
  }
  const block = RENDERER.slice(RENDERER.indexOf('var _slskFriends = {'),
    RENDERER.indexOf('\n}\n', RENDERER.indexOf('var _slskFriends = {')) + 3)
  const ctx = {
    console, Promise, Array, Object, String, Boolean,
    window: { PapaSlskPresence: P, api: {} },
    document: { getElementById: () => null },
    state: { currentPage: 'home' },
    renderSlskFriends() { ctx.painted = (ctx.painted || 0) + 1 },
    _renderHubFriends() {},
    painted: 0,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext([block, lift('_slskFriendRows'), lift('_slskFriendsApplyStatuses'),
    lift('_slskFriendsSetRefreshing'), lift('refreshSlskFriendStatuses')].join('\n'), ctx)
  vm.runInContext("_slskFriends.users = [{ username: 'sherrybaaz' }]", ctx)
  return {
    ctx,
    setApi: (fn) => { ctx.window.api.slskRefreshUserStatuses = fn },
    refresh: () => vm.runInContext('refreshSlskFriendStatuses()', ctx),
    rows: () => vm.runInContext('_slskFriendRows()', ctx),
  }
}

test('a failed status refresh makes the row say so, and repaints', async () => {
  const h = friendsHarness()
  h.setApi(() => Promise.reject(new Error('slskd 503')))
  assert.equal(h.rows()[0].presenceText, 'Checking…', 'before the attempt')
  await h.refresh()
  assert.equal(h.rows()[0].presenceText, "Couldn't check")
  assert.ok(h.ctx.painted > 0, 'the failure must reach the screen, not just the flag')
})

test('and a later successful refresh clears it again', async () => {
  const h = friendsHarness()
  h.setApi(() => Promise.reject(new Error('slskd 503')))
  await h.refresh()
  h.setApi(() => Promise.resolve({ statuses: [{ username: 'sherrybaaz', presence: 'Online' }] }))
  await h.refresh()
  assert.equal(h.rows()[0].presenceText, 'Online')
})

test('MUTATION: swallowing the failure again leaves it on "Checking…" forever', async () => {
  const fs = require('fs')
  const path = require('path')
  const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const broken = RENDERER.replace(
    /\.catch\(function\(\) \{\n      \/\/ Swallowing this left[\s\S]*?\n    \}\)/,
    '.catch(function() {})')
  assert.notEqual(broken, RENDERER, 'the mutation applied')
  const h = friendsHarness(broken)
  h.setApi(() => Promise.reject(new Error('slskd 503')))
  await h.refresh()
  assert.equal(h.rows()[0].presenceText, 'Checking…', 'this is the reported bug')
})
