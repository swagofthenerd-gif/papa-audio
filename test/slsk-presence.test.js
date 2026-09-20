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

// ── L2: slskd not logged in is its own answer, not "Checking…" ──────────────
// When slskd is up but not connected to Soulseek, main records every saved
// peer as Unknown and the IPC RESOLVES — nothing rejected, so the renderer's
// statusFailed stayed false and presenceText printed "Checking…" next to
// "· 3d ago" forever. The L1 fix only covered the rejection path.

test('a peer unknown because Soulseek is offline says so, not "Checking…"', () => {
  const rows = P.mergeStatuses([{ username: 'doperst13' }],
    [{ username: 'doperst13', presence: 'Unknown' }], { serverOffline: true })
  assert.equal(rows[0].presenceText, 'Soulseek offline')
})

test('"Soulseek offline" beats "Couldn\'t check" when both are set', () => {
  // The connection being down is the more specific fact, and the honest one:
  // no lookup failed, none was made.
  const rows = P.mergeStatuses([{ username: 'a' }], [],
    { checkFailed: true, serverOffline: true })
  assert.equal(rows[0].presenceText, 'Soulseek offline')
})

test('the offline flag does not relabel peers whose presence we do know', () => {
  const rows = P.mergeStatuses(
    [{ username: 'here' }, { username: 'gone' }],
    [{ username: 'here', presence: 'Online' }, { username: 'gone', presence: 'Offline' }],
    { serverOffline: true })
  assert.equal(rows.find(r => r.username === 'here').presenceText, 'Online')
  assert.equal(rows.find(r => r.username === 'gone').presenceText, 'Offline')
})

test('presenceText takes the flag directly too', () => {
  assert.equal(P.presenceText('unknown', false, true), 'Soulseek offline')
  assert.equal(P.presenceText('unknown', true, false), "Couldn't check")
  assert.equal(P.presenceText('unknown', false, false), 'Checking…')
  assert.equal(P.presenceText('online', false, true), 'Online')
})

test('MUTATION: dropping the flag puts "Checking…" back under an offline daemon', () => {
  const fs = require('fs')
  const path = require('path')
  const vm = require('vm')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'slsk-presence.js'), 'utf8')
  const broken = src.replace("  if (serverOffline) return 'Soulseek offline'\n", '')
  assert.notEqual(broken, src, 'the mutation applied')
  const ctx = vm.createContext({ module: { exports: {} }, Object, Array, String, Boolean })
  vm.runInContext(broken, ctx)
  assert.equal(ctx.module.exports.mergeStatuses([{ username: 'a' }], [],
    { serverOffline: true })[0].presenceText, 'Checking…', 'this is the reported bug')
})

// ── L2, the renderer half ──────────────────────────────────────────────────

test('a reply carrying connected:false makes every unknown peer say so', async () => {
  const h = friendsHarness()
  h.setApi(() => Promise.resolve({
    statuses: [{ username: 'sherrybaaz', presence: 'Unknown' }], connected: false,
  }))
  await h.refresh()
  assert.equal(h.rows()[0].presenceText, 'Soulseek offline',
    'it used to sit on "Checking…" for the whole session')
  assert.ok(h.ctx.painted > 0)
})

test('the pushed broadcast spells it serverConnected, and that works too', () => {
  const h = friendsHarness()
  h.ctx._slskFriendsApplyStatuses({
    statuses: [{ username: 'sherrybaaz', presence: 'Unknown' }], serverConnected: false,
  })
  assert.equal(h.rows()[0].presenceText, 'Soulseek offline')
})

test('a reconnect clears it again', async () => {
  const h = friendsHarness()
  h.setApi(() => Promise.resolve({ statuses: [], connected: false }))
  await h.refresh()
  assert.equal(h.rows()[0].presenceText, 'Soulseek offline')
  h.setApi(() => Promise.resolve({
    statuses: [{ username: 'sherrybaaz', presence: 'Online' }], connected: true,
  }))
  await h.refresh()
  assert.equal(h.rows()[0].presenceText, 'Online')
})

test('connected:null (no saved peers, nothing asked) is not a verdict', () => {
  const h = friendsHarness()
  h.ctx._slskFriendsApplyStatuses({ statuses: [], connected: false })
  assert.equal(h.rows()[0].presenceText, 'Soulseek offline')
  h.ctx._slskFriendsApplyStatuses({ statuses: [], connected: null })
  assert.equal(h.rows()[0].presenceText, 'Soulseek offline',
    'null must leave the last real verdict standing')
})

test('MUTATION: ignoring connected in the apply path brings "Checking…" back', async () => {
  const fs = require('fs')
  const path = require('path')
  const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const broken = RENDERER.replace(
    '  if (conn !== null) _slskFriends.serverOffline = !conn\n', '')
  assert.notEqual(broken, RENDERER, 'the mutation applied')
  const h = friendsHarness(broken)
  h.setApi(() => Promise.resolve({
    statuses: [{ username: 'sherrybaaz', presence: 'Unknown' }], connected: false,
  }))
  await h.refresh()
  assert.equal(h.rows()[0].presenceText, 'Checking…', 'this is the reported bug')
})

// ── L2, the main half ──────────────────────────────────────────────────────
// pollPresenceOnce is what decides `connected`. Lifted whole and driven with a
// stubbed slskdFetch, so the verdict is read off the real function.

function pollHarness(source) {
  const fs = require('fs')
  const path = require('path')
  const vm = require('vm')
  const MAIN = source || fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const from = MAIN.indexOf('const PRESENCE_POLL_MS =')
  const to = MAIN.indexOf('function startPresenceWatch()')
  assert.ok(from > -1 && to > from, 'the presence block must still be findable')
  const sent = []
  const fetched = []
  const ctx = {
    console, Promise, Map, Set, Array, Object, String, Number, Boolean, Date, Math,
    setInterval: () => ({ unref() {} }), clearInterval() {},
    encodeURIComponent,
    ipcMain: { handle() {} },
    store: { get: (_k, d) => ctx._saved || d, set() {} },
    savedUsers: { sortUsers: a => a.slice() },
    safeSend: (ch, payload) => sent.push({ ch, payload }),
    slskdFetch: async (method, route) => {
      fetched.push(method + ' ' + route)
      if (route === '/server') return ctx._server
      return { presence: 'Online', isPrivileged: false }
    },
    _saved: [{ username: 'sherrybaaz' }, { username: 'doperst13' }],
    _server: { isLoggedIn: false },
    // Whether the user has Soulseek switched on. Every test below describes a
    // connection he wants used, so it starts on; the off case is its own test.
    _enabled: true,
    _slskEnabled: () => ctx._enabled,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(from, to), ctx, { filename: 'main.js:presence' })
  return { ctx, sent, fetched }
}

test('slskd not logged in: every peer is Unknown and the reply says connected:false',
  async () => {
    const h = pollHarness()
    const res = await h.ctx.pollPresenceOnce()
    assert.equal(res.connected, false,
      'the renderer cannot tell this from a cold cache without it')
    assert.deepEqual(res.statuses.map(s => s.presence), ['Unknown', 'Unknown'])
    // And no per-user lookup was even attempted.
    assert.deepEqual(h.fetched, ['GET /server'])
    assert.equal(h.sent[0].payload.serverConnected, false)
  })

test('logged in: the reply says connected:true and the peers get looked up', async () => {
  const h = pollHarness()
  h.ctx._server = { isLoggedIn: true }
  const res = await h.ctx.pollPresenceOnce()
  assert.equal(res.connected, true)
  assert.deepEqual(res.statuses.map(s => s.presence), ['Online', 'Online'])
})

test('a /server call that throws is not connected either', async () => {
  const h = pollHarness()
  h.ctx.slskdFetch = async () => { throw new Error('ECONNREFUSED') }
  const res = await h.ctx.pollPresenceOnce()
  assert.equal(res.connected, false)
})

test('with no saved users the connection gets no verdict', async () => {
  const h = pollHarness()
  h.ctx._saved = []
  const res = await h.ctx.pollPresenceOnce()
  assert.equal(res.connected, null, 'nothing was asked, so nothing is known')
  assert.deepEqual(res.statuses, [])
})

test('MUTATION: dropping connected from main leaves the renderer nothing to read',
  async () => {
    const fs = require('fs')
    const path = require('path')
    const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
    const broken = MAIN.replace(
      '  return { statuses: presenceSnapshot(), connected: presenceConnected, off: !_slskEnabled() }',
      '  return { statuses: presenceSnapshot(), off: !_slskEnabled() }')
    assert.notEqual(broken, MAIN, 'the mutation applied')
    const h = pollHarness(broken)
    const res = await h.ctx.pollPresenceOnce()
    assert.equal(res.connected, undefined, 'this is the reported bug')
    // And the renderer then has no boolean, so it stays on "Checking…".
    const f = friendsHarness()
    f.ctx._slskFriendsApplyStatuses(res)
    assert.equal(f.rows()[0].presenceText, 'Checking…')
  })

// A deliberate off is not an outage. `connected: false` is what paints every
// saved peer as unreachable and the footer red; over a connection the user
// switched off, nothing was asked, so nothing is known — and that is a third
// answer, not the failing one.
test('Soulseek switched off gets no verdict at all, and nobody is probed', async () => {
  const h = pollHarness()
  h.ctx._enabled = false
  const res = await h.ctx.pollPresenceOnce()
  assert.equal(res.connected, null, 'not false — false means it was asked and said no')
  assert.equal(res.off, true, 'and the list is told which of the two it is')
  assert.deepEqual(h.fetched, [], 'nothing is asked of a daemon he disconnected')
  assert.deepEqual(h.sent, [], 'and nothing is broadcast as an outage')
})
