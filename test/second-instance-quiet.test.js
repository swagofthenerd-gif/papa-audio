'use strict'
// A second launch of Papa Audio while the app is already running must touch
// nothing. It used to call app.quit() — which only ASKS to quit, is
// cancellable, and above all RETURNS — so the losing process ran the whole of
// main.js anyway: it opened its own electron-store, ran retireLegacyKeys,
// rewrote dead-magnets.json, and then its before-quit set cleanShutdown: true
// while the real session was still playing. The live session was thereby
// marked clean, so a later genuine crash was never offered a restore.
//
// These lift the real source of the lock block and of the two quit handlers
// and run them.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function slice(from, to) {
  const a = MAIN.indexOf(from)
  assert.ok(a > 0, 'not found in main.js: ' + from)
  const b = MAIN.indexOf(to, a)
  assert.ok(b > a, 'not found in main.js after it: ' + to)
  return MAIN.slice(a, b)
}

// The lock block, run with a fake Electron app that records what was called.
function runLockBlock(gotLock) {
  const calls = []
  const listeners = []
  const app = {
    requestSingleInstanceLock() { calls.push('requestSingleInstanceLock'); return gotLock },
    quit() { calls.push('quit') },
    exit(code) { calls.push('exit(' + code + ')') },
    on(event) { listeners.push(event) },
  }
  const ctx = { app, mainWindow: null, console: { log() {}, error() {} } }
  vm.createContext(ctx)
  vm.runInContext(slice('const gotLock = app.requestSingleInstanceLock()',
    '\n// ── Migrate from old flac-player config'), ctx)
  return { calls, listeners, gotLock: vm.runInContext('gotLock', ctx) }
}

test('a second instance exits at once instead of asking to quit', () => {
  const out = runLockBlock(false)
  assert.ok(out.calls.includes('exit(0)'),
    'the losing process must app.exit(0) — app.quit() returns and lets the rest of main.js run')
  assert.strictEqual(out.calls.includes('quit'), false,
    'app.quit() is cancellable and fires the quit handlers; it is the wrong call here')
  assert.deepStrictEqual(out.listeners, [],
    'a process that is exiting has no business registering listeners')
})

test('the winning instance keeps the lock and listens for the second one', () => {
  const out = runLockBlock(true)
  assert.strictEqual(out.calls.includes('exit(0)'), false)
  assert.strictEqual(out.calls.includes('quit'), false)
  assert.deepStrictEqual(out.listeners, ['second-instance'])
})

// The belt to that braces: even if something kept the losing process alive,
// its quit handlers must not write the live session's state.
function runQuitHandlers(gotLock) {
  const writes = []
  const handlers = {}
  const app = {
    on(event, fn) { handlers[event] = fn },
    exit() {},
  }
  const store = {
    set(k, v) { writes.push('store.set:' + k + '=' + v) },
    get(_k, d) { return d },
  }
  const ctx = {
    app, store, console: { log() {}, error() {}, warn() {} },
    gotLock,
    // Flips a module-level flag so the unhandledRejection/uncaughtException
    // handlers stand down while the environment is being freed. Deliberately
    // NOT recorded as a write: it touches nothing outside this process, so a
    // lockless instance calling it still "writes nothing on the way out".
    _beginTeardown() {},
    // The detached quit watchdog. Stubbed out: the harness is checking which
    // state a quit writes, and spawning a real killer for this pid is not it.
    _armQuitWatchdog() {},
    player: { stop() { writes.push('player.stop') } },
    _videoTeardown() { writes.push('_videoTeardown') },
    stopSlskd() { writes.push('stopSlskd') },
    flushSideStores() { writes.push('flushSideStores') },
    flushLibraryExtSync() { writes.push('flushLibraryExtSync') },
    _torrentTeardown() { writes.push('_torrentTeardown'); return Promise.resolve() },
    flushLogSync() { writes.push('flushLogSync') },
    stopNowPlayingWrites() { writes.push('stopNowPlayingWrites') },
    globalShortcut: { unregisterAll() { writes.push('unregisterAll') } },
    session: { defaultSession: { flushStorageData() { writes.push('flushStorageData') } } },
    fs: { existsSync: () => false, unlinkSync() { writes.push('unlink') } },
    NOW_PLAYING_PATH: '/tmp/papa-test-now-playing',
  }
  vm.createContext(ctx)
  vm.runInContext(slice("app.on('before-quit', () => {",
    '\n// Given a saved window rectangle'), ctx)
  handlers['before-quit']()
  handlers['will-quit']()
  return writes
}

test('a process without the lock writes nothing on the way out', () => {
  const writes = runQuitHandlers(false)
  assert.deepStrictEqual(writes, [],
    'the losing process must not touch the live session state — it wrote cleanShutdown: true')
})

test('the process holding the lock still shuts down properly', () => {
  const writes = runQuitHandlers(true)
  assert.ok(writes.includes('store.set:cleanShutdown=true'))
  assert.ok(writes.includes('flushSideStores'))
  assert.ok(writes.includes('flushStorageData'))
  assert.ok(writes.includes('_videoTeardown'))
})

test('the signal shutdown is gated on the lock too', () => {
  const body = slice('function shutdownFromSignal() {', '\nfor (const sig of')
  const at = body.indexOf('if (!gotLock)')
  assert.ok(at > 0, 'shutdownFromSignal must refuse to write without the lock')
  assert.ok(at < body.indexOf("store.set('cleanShutdown'"),
    'the guard has to come before the writes')
})

// Twice in one evening the main process was seen alive hours after its window
// was gone, spinning a core inside node::FreeEnvironment and never exiting —
// which also freed the single-instance lock and let a second copy start. The
// cause of that loop is still open (docs/quit-hang.md); this is the guarantee
// that it cannot outlive the quit either way.
test('the quit arms a watchdog that cannot be defeated by a wedged teardown', () => {
  const fn = slice('function _armQuitWatchdog(', '\napp.on(\'will-quit\'')
  // Outside the process on purpose: the hang is past the point where the event
  // loop still turns, so a JS timer armed in will-quit would never fire.
  assert.match(fn, /detached: true/, 'the watchdog must outlive the process it is watching')
  assert.match(fn, /child\.unref\(\)/, 'and must not hold the process open itself')
  assert.match(fn, /kill -9/, 'a wedged teardown does not answer anything gentler')
  // A pid is reused. Killing one blindly 8 seconds later could hit a stranger.
  assert.match(fn, /\/proc\/\$\{pid\}\/cmdline/, 'it must confirm the pid is still this app')
  assert.match(fn, /grep -qa flac-player/, 'cmdline is NUL-separated: grep needs -a')
  assert.match(fn, /catch/, 'a watchdog that cannot start must not stop the quit')
})

test('the watchdog is armed before the quit does any work', () => {
  const body = slice("app.on('will-quit', () => {", '\n// Given a saved window rectangle')
  const armed = body.indexOf('_armQuitWatchdog()')
  assert.ok(armed > -1, 'will-quit must arm it')
  // Before the flushes, not after: the point is to cover whatever follows.
  assert.ok(armed < body.indexOf('flushSideStores'),
    'arming it after the work would leave the work itself uncovered')
})
