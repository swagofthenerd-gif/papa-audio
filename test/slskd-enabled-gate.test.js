'use strict'
// "Turn Soulseek off" has to mean off.
//
// Eight places in main.js start or revive the daemon, and before this work not
// one of them asked whether the user wanted it running. Switch Soulseek off and
// the 60-second health supervisor brings it back inside three minutes, the
// weekly updater starts it, saving an account starts it, and the search box's
// own self-heal quietly re-authenticates — so the switch would have been a
// button that looked like it did something.
//
// Every test here RUNS the gate. None of them greps main.js for the text of a
// guard: a string search stays green through any change that keeps the string,
// and the whole failure this file exists to prevent is a guard that is present
// and not reached.
//
// Nothing here touches the real daemon, the real port or the user's account.

const test = require('node:test')
const assert = require('node:assert')
const vm = require('vm')

const { liftFns, MAIN } = require('./helpers/lift-main-fn.js')
const { runHandler } = require('./helpers/lift-ipc.js')

// Did anything in this run try to start the daemon?
function started(calls) {
  return calls.some(c => String(c.name || c).startsWith('startSlskd'))
}

// ── 1. Launch ───────────────────────────────────────────────────────────────
// Off must survive a relaunch, or "off" lasts until he next opens the app.

function runLaunchGate(enabled) {
  const at = MAIN.indexOf('  // Restart path 1 of 7.')
  assert.ok(at > -1, 'the launch gate must still be there to run')
  const end = MAIN.indexOf("  // Auto-restart monitoring:", at)
  assert.ok(end > at)
  const src = MAIN.slice(at, end)

  const calls = []
  const sandbox = {
    _slskEnabled: () => enabled,
    fs: { existsSync: () => true },
    SLSKD_BIN: '/tmp/slskd',
    startSlskd: () => { calls.push('startSlskd'); return { catch() {} } },
    console: { log() {}, error() {} },
  }
  vm.runInContext(src, vm.createContext(sandbox), { filename: 'main.js:launch' })
  return calls
}

test('a launch with Soulseek switched off starts no daemon at all', () => {
  assert.deepStrictEqual(runLaunchGate(false), [])
})

test('a launch with Soulseek on still starts it', () => {
  assert.deepStrictEqual(runLaunchGate(true), ['startSlskd'])
})

// ── 2. The health supervisor ────────────────────────────────────────────────
// Covered in full by test/slskd-health-restart.test.js, which runs four cycles
// and checks the failure counter directly. Pinned here so the set of eight
// paths is readable in one place.

test('the health supervisor answers "off" without touching anything', async () => {
  const { fns, globals } = liftFns(['slskdHealthCheck'], {
    _slskEnabled: () => false,
    _slskdFailures: 0,
    slskdProc: null,
    slskdFetch: async () => { throw new Error('must not be called') },
    safeSend() { assert.fail('a deliberate off is not an outage and pushes no status') },
  })
  assert.strictEqual(await fns.slskdHealthCheck(), 'off')
  assert.strictEqual(globals._slskdFailures, 0)
})

// ── 3. The weekly slskd auto-updater ────────────────────────────────────────

function runUpdaterStartFn(enabled) {
  const at = MAIN.indexOf('const slskdUpdater = new SlskdUpdater({')
  assert.ok(at > -1)
  const end = MAIN.indexOf('\n})', at) + 3
  const calls = []
  let opts = null
  const sandbox = {
    SlskdUpdater: function (o) { opts = o },
    _slskEnabled: () => enabled,
    startSlskd: async () => { calls.push('startSlskd') },
    stopSlskd() {},
    SLSKD_BIN: '/tmp/slskd', SLSKD_DIR: '/tmp',
    _downloadsAreActive: () => false,
    slskdFetch: async () => null,
    console: { log() {}, error() {} },
  }
  vm.runInContext(MAIN.slice(at, end), vm.createContext(sandbox),
    { filename: 'main.js:slskdUpdater' })
  assert.ok(opts && typeof opts.startFn === 'function', 'the updater still has a startFn')
  return { startFn: opts.startFn, calls }
}

test('an update that lands while Soulseek is off leaves the daemon stopped', async () => {
  const u = runUpdaterStartFn(false)
  await u.startFn()
  assert.deepStrictEqual(u.calls, [])
})

test('an update while Soulseek is on starts the new binary', async () => {
  const u = runUpdaterStartFn(true)
  await u.startFn()
  assert.deepStrictEqual(u.calls, ['startSlskd'])
})

test('the weekly check does not even look for an update while Soulseek is off', async () => {
  const { fns } = liftFns(['_slskdAutoCheck'], {
    _slskEnabled: () => false,
    store: { get: (_k, d) => d, set() {} },
    fs: { existsSync: () => true },
    _slskdRunUpdate: async () => assert.fail('no update run while it is off'),
    require: () => ({ shouldAutoCheck: () => true }),
    console: { log() {}, error() {} },
  })
  const res = await fns._slskdAutoCheck({})
  // Skipped, not failed. A deliberate off must never be reported as an outage.
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.skipped, 'soulseek-off')
})

// ── 4-7. The four handlers that restart the daemon ──────────────────────────

const OFF = { _slskEnabled: () => false }
const ON = { _slskEnabled: () => true, slskdReady: true }

test('saving a Soulseek account while it is off saves the account and starts nothing', async () => {
  const off = await runHandler('slsk-configure', { args: { username: 'u', password: 'p' }, globals: OFF })
  assert.ok(off.calls.some(c => c.startsWith('writeSlskdConfig')), 'the account is still saved')
  assert.ok(!started(off.calls), 'and nothing is started')

  const on = await runHandler('slsk-configure', { args: { username: 'u', password: 'p' }, globals: ON })
  assert.ok(started(on.calls), 'with Soulseek on, the same handler does restart it')
})

test('installing the daemon while Soulseek is off installs it and leaves it stopped', async () => {
  const off = await runHandler('slsk-setup', { args: {}, globals: OFF })
  assert.ok(off.calls.some(c => c.startsWith('downloadSlskd')), 'it is still downloaded')
  assert.ok(!started(off.calls))

  const on = await runHandler('slsk-setup', { args: {}, globals: ON })
  assert.ok(started(on.calls))
})

test('changing the download folder while Soulseek is off writes the config and starts nothing', async () => {
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: ['/mnt/data/MUSIC/Downloads'] }) }
  // The handler now moves the download folder's tick with the folder, so it
  // needs a store it can actually read and the real path helpers. A recording
  // stub there would answer "yes, that path is ticked" to everything.
  const shareEnv = () => {
    const data = { slskShareFolders: [], slskConfig: { downloadDir: '/mnt/old/Downloads' } }
    return {
      dialog,
      slskShare: require('../src/slsk-share.js'),
      store: {
        data,
        get: (k, d) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : d),
        set: (k, v) => { data[k] = v },
      },
      _downloadDir: () => data.slskConfig.downloadDir,
      // The handler now judges the folder the dialog returned, because that
      // folder can become a ticked share row. The real predicate, so this
      // exercises the same gate the app does.
      _slskShareRefusal: (dir) => require('../src/slsk-share.js').pickRefusal(dir, {
        home: '/home/tester', slskdDir: '/home/tester/.config/papa-audio/slskd',
      }),
    }
  }
  const off = await runHandler('slsk-set-download-dir', {
    args: {}, globals: Object.assign(shareEnv(), OFF),
    alsoLift: ['_slskShareSelection'],
  })
  assert.ok(off.calls.some(c => c.startsWith('writeSlskdConfig')))
  assert.ok(!started(off.calls))
  assert.strictEqual(off.result.restarted, false)

  const on = await runHandler('slsk-set-download-dir', {
    args: {}, globals: Object.assign(shareEnv(), ON),
    alsoLift: ['_slskShareSelection'],
  })
  assert.ok(started(on.calls))
})

test('changing what is shared while Soulseek is off saves the choice and starts nothing', async () => {
  const off = await runHandler('slsk-share-folders-set', {
    args: { folders: ['/mnt/data/MUSIC/Downloads'] }, globals: OFF,
  })
  assert.ok(off.calls.some(c => c.startsWith('writeSlskdConfig')), 'the choice is written to slskd.yml')
  assert.ok(!started(off.calls), 'but the daemon is not bounced')
  assert.strictEqual(off.result.ok, true, 'saving is not a failure')
  assert.strictEqual(off.result.restarted, false)
  assert.strictEqual(off.result.enabled, false,
    'and the answer says why, so Apply can say "it takes effect when you turn Soulseek back on"')

  const on = await runHandler('slsk-share-folders-set', {
    args: { folders: ['/mnt/data/MUSIC/Downloads'] }, globals: ON,
  })
  assert.ok(started(on.calls), 'with Soulseek on, Apply does bounce the daemon')
})

// ── 8. The search box's self-heal ───────────────────────────────────────────
// Not a restart, but it undoes an off just as effectively: it re-probes
// /application and re-authenticates whenever slskdReady is false, which is
// exactly the state a deliberate off leaves behind.

test('a search while Soulseek is off refuses with the off error and re-authenticates nothing', async () => {
  const calls = []
  const { fns } = liftFns(['slskRunSearch'], {
    _slskEnabled: () => false,
    slskdReady: false,
    fetch: async () => { calls.push('fetch'); return { ok: true } },
    slskdAcquireToken: async () => { calls.push('slskdAcquireToken') },
    slskdFetch: async () => { calls.push('slskdFetch'); return {} },
    SLSKD_BASE: 'http://localhost:5030/api/v0',
    console: { log() {}, error() {} },
  })
  await assert.rejects(
    () => fns.slskRunSearch({ query: 'aerosmith' }),
    (e) => e.code === 'SLSK_OFF' && e.slskOff === true && /off/i.test(e.message))
  assert.deepStrictEqual(calls, [],
    'nothing may be probed or re-authenticated for a thing he switched off')
})

// ── The pollers ─────────────────────────────────────────────────────────────
// One shared gate rather than six edits. Without it the logs fill with failures
// for a thing the user deliberately switched off.

function pollerHarness(enabled) {
  const created = []
  return liftFns(
    ['dlStart', 'slskUploadPollStart', 'slskChatPollStart', 'startPresenceWatch'],
    {
      _slskEnabled: () => enabled,
      dlRestored: true,
      dlTimer: null, _uploadTimer: null, _chatTimer: null, presenceTimer: null,
      DL_TICK_MS: 1000, CHAT_POLL_MS: 30000, PRESENCE_POLL_MS: 60000,
      _uploadPollMs: 60000,
      setInterval: (fn) => { created.push(fn); return { unref() {} } },
      dlTick() {}, dlRestore() {},
      slskUploadPollOnce: async () => {},
      slskChatPollOnce: async () => {},
      pollPresenceOnce: async () => {},
      console: { log() {}, error() {} },
    })
}

test('nothing polls Soulseek while it is switched off', () => {
  const { fns, globals } = pollerHarness(false)
  fns.dlStart()
  fns.slskUploadPollStart()
  fns.slskChatPollStart()
  fns.startPresenceWatch()
  assert.strictEqual(globals.dlTimer, null, 'the download tick does not dispatch')
  assert.strictEqual(globals._uploadTimer, null, 'the upload-stats poll does not run')
  assert.strictEqual(globals._chatTimer, null, 'peer chat is not polled')
  assert.strictEqual(globals.presenceTimer, null, 'nobody is asked who is online')
})

test('the same four pollers do start when Soulseek is on', () => {
  const { fns, globals } = pollerHarness(true)
  fns.dlStart()
  fns.slskChatPollStart()
  fns.startPresenceWatch()
  assert.ok(globals.dlTimer, 'the control: the gate must not stop a wanted poller')
  assert.ok(globals._chatTimer)
  assert.ok(globals.presenceTimer)
})

test('the saved download queue is still restored while it is off, so he can see what is waiting', () => {
  // The gate sits AFTER the restore on purpose. An empty Downloads page would
  // be a second lie on top of the one this work is removing.
  let restored = 0
  const { fns } = liftFns(['dlStart'], {
    _slskEnabled: () => false,
    dlRestored: false,
    dlTimer: null,
    DL_TICK_MS: 1000,
    dlRestore() { restored++ },
    dlTick() {},
    setInterval: () => assert.fail('no tick while it is off'),
    console: { log() {}, error() {} },
  })
  fns.dlStart()
  assert.strictEqual(restored, 1)
})

// ── A deliberate off is not an outage ───────────────────────────────────────

test('nobody is asked who is online while Soulseek is off, and no peer is called offline', async () => {
  const { fns } = liftFns(['pollPresenceOnce', 'presenceResult', 'presenceSnapshot'], {
    _slskEnabled: () => false,
    presencePolling: false,
    presenceCache: new Map(),
    presenceConnected: false,
    slskdFetch: async () => assert.fail('a switched-off connection is not probed'),
    presenceBroadcast() { assert.fail('nothing is broadcast as an outage') },
    store: { get: (_k, d) => d },
    savedUsers: { sortUsers: (a) => a },
  })
  const res = await fns.pollPresenceOnce()
  // Not `false`. No verdict is the truth: nothing was asked, so nothing is known.
  assert.strictEqual(res.connected, null)
  assert.strictEqual(res.off, true, 'and the list is told which it is')
})

test('the wishlist sweep skips while Soulseek is off instead of failing', async () => {
  const { fns } = liftFns(['slskWishlistSweep'], {
    _slskEnabled: () => false,
    slskWishlistSweeping: false,
    store: { get: (_k, d) => d, set() {} },
    console: { log() {}, error() {} },
  })
  const res = await fns.slskWishlistSweep()
  assert.strictEqual(res.ok, true, 'skipped, not failed')
  assert.strictEqual(res.skipped, 'soulseek-off')
  // Length, not deepStrictEqual: the array is built inside the vm context, so
  // it is a different realm's Array and would never be reference-equal.
  assert.strictEqual(res.results.length, 0)
})
