'use strict'
// "You're offline" has to be hard to say and easy to take back.
//
// It was the other way round. The probe hits one host once a minute and needed
// two agreeing samples to change state IN EITHER DIRECTION, so a single blip
// latched the banner for at least two minutes — and the banner appeared while
// navigator.onLine was true, music.youtube.com returned 200, and the app's own
// YouTube widget said "connected". The message it painted ("You are offline —
// YouTube is unavailable") drew no button at all, because its action was
// 'connection' and only retry/wait/settings got one. So the one claim most
// likely to be wrong was the only one the user could not argue with.
//
// The rule is now asymmetric, which is what the evidence actually supports: a
// success PROVES the network is up, so one is enough to come back; a failure
// proves only that one host did not answer at one moment, so it still takes
// two. Any successful HTTP response anywhere in the app clears it immediately,
// and Retry re-probes rather than trusting a cached answer.
//
// _checkConnectivity and _noteOnlineSignal are lifted out of main.js and run
// against a scripted probe, so the assertions are on the messages the renderer
// would actually receive.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const failure = require('../src/source-failure.js')

// The connectivity block: _noteOnlineSignal, _checkConnectivity and the monitor
// that schedules them.
function liftMonitor(results) {
  const start = MAIN.indexOf('function _noteOnlineSignal()')
  assert.ok(start > -1, '_noteOnlineSignal must still exist in main.js')
  const end = MAIN.indexOf('\n// ── Auto-backups', start)
  assert.ok(end > start, 'the connectivity section must still end where it did')
  const body = MAIN.slice(start, end)
  assert.match(body, /async function _checkConnectivity\(\)/, 'and must still contain the check')

  const sent = []
  const queue = results.slice()
  const ctx = vm.createContext({
    console: { log() {} },
    Promise, setTimeout, setInterval,
    safeSend: (ch, payload) => sent.push({ ch, payload }),
    // The scripted probe. Runs out -> keeps answering with the last scripted
    // value, so a test only has to spell out the interesting part.
    _probeOnce: () => Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]),
    ipcMain: { handle() {} },
    CONNECTIVITY_PROBE_INTERVAL_MS: 60000,
  })
  vm.runInContext('let _onlineState = null; let _lastProbe = null;\n' + body, ctx)
  return {
    sent,
    check: () => vm.runInContext('_checkConnectivity()', ctx),
    note: () => vm.runInContext('_noteOnlineSignal()', ctx),
    state: () => vm.runInContext('_onlineState', ctx),
    // Every online/offline the renderer would have been told, in order.
    told: () => sent.filter(s => s.ch === 'app-online-state').map(s => s.payload.online),
  }
}

test('one failed probe is not enough to claim offline', async () => {
  // A blip on an otherwise-fine connection. This is the case that put the
  // banner up for two minutes at a time.
  const m = liftMonitor([true, false, true, true])
  await m.check()               // up
  await m.check()               // one blip
  assert.deepStrictEqual(m.told(), [true], 'nothing about being offline was said')
  assert.strictEqual(m.state(), true)
})

test('two in a row is', async () => {
  const m = liftMonitor([true, false, false])
  await m.check(); await m.check(); await m.check()
  assert.deepStrictEqual(m.told(), [true, false])
  assert.strictEqual(m.state(), false)
})

test('but ONE good probe is enough to come back', async () => {
  // The asymmetry, in one test. Offline took two samples; online takes one, so
  // a recovery is announced a minute earlier than the old rule allowed.
  const m = liftMonitor([false, false, true])
  await m.check(); await m.check()
  assert.strictEqual(m.state(), false, 'offline, honestly reached')
  await m.check()
  assert.deepStrictEqual(m.told(), [false, true])
  assert.strictEqual(m.state(), true, 'back at once, not after a second confirmation')
})

test('a successful request anywhere clears it without waiting for a probe', async () => {
  // The probe cadence is 60 s. A user watching the YouTube widget say
  // "connected" should not have to wait out a minute of a banner that is wrong.
  const m = liftMonitor([false, false])
  await m.check(); await m.check()
  assert.strictEqual(m.state(), false)
  m.note()
  assert.deepStrictEqual(m.told(), [false, true])
  assert.strictEqual(m.state(), true)
})

test('and saying so twice does not spam the renderer', async () => {
  const m = liftMonitor([true])
  await m.check()
  m.note(); m.note(); m.note()
  assert.deepStrictEqual(m.told(), [true], 'one message, not four')
})

test('a first reading of "down" still needs confirming', async () => {
  // Starting the app inside a dead network: the very first probe must not paint
  // the banner on its own.
  const m = liftMonitor([false, false])
  await m.check()
  assert.deepStrictEqual(m.told(), [], 'nothing claimed from a single sample')
  await m.check()
  assert.deepStrictEqual(m.told(), [false])
})

test('a first reading of "up" is adopted straight away', async () => {
  const m = liftMonitor([true])
  await m.check()
  assert.deepStrictEqual(m.told(), [true])
})

test('an HTTP response — any status — counts as proof the network is up', () => {
  // httpsGet is the app's shared fetch. A 404 still means something answered.
  const get = MAIN.slice(MAIN.indexOf('function httpsGet('))
  assert.match(get.slice(0, 1200), /_noteOnlineSignal\(\)/,
    'a successful response must feed the connectivity signal')
})

test('a Retry can jump the 60-second queue', () => {
  assert.match(MAIN, /ipcMain\.handle\('connectivity-recheck'/)
  assert.match(MAIN, /ipcMain\.handle\('connectivity-note-online'/)
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  assert.match(PRE, /connectivityRecheck:/)
  assert.match(PRE, /connectivityNoteOnline:/)
})

test('the "YouTube is unavailable" message now has a Retry on it', () => {
  // It is produced by the 'connection' action, which drew no button at all.
  const r = failure.explain('YouTube', null, { offline: true })
  assert.strictEqual(r.action, 'connection')
  assert.match(r.text, /offline/i)
  const painter = SRC.slice(SRC.indexOf('function _ytFailureHtml('))
		.slice(0, 1400)
  assert.match(painter, /r\.action === 'connection'/,
    'the offline message must get a button like every other failure')
  assert.match(painter, /id="yt-retry-btn"/)
})

test('Retry re-probes before believing the offline state again', () => {
  const retry = SRC.slice(SRC.indexOf('async function _retryYtSearch('))
		.slice(0, 900)
  assert.match(retry, /connectivityRecheck\(\)/,
    'the cached answer can be a minute old and can have latched on one blip')
  assert.match(retry, /_applyOnlineState\(true\)/, 'and a good answer clears the banner')
  assert.match(retry, /runYtSearch\(/, 'then the search actually runs again')
  // Both the direct listener and the delegated one go through it.
  assert.doesNotMatch(
    SRC.slice(SRC.indexOf("if (t.closest('#yt-retry-btn'))"), SRC.indexOf("if (t.closest('#yt-retry-btn'))") + 200),
    /runYtSearch\(ytSearchState\.lastQuery/,
    'the delegated Retry must not bypass the re-probe')
})

test('the browser coming back online forces a probe too', () => {
  const listener = SRC.slice(SRC.indexOf("window.addEventListener('online'"))
		.slice(0, 600)
  assert.match(listener, /_applyOnlineState\(true\)/)
  assert.match(listener, /connectivityRecheck/,
    "otherwise main's stale offline repaints the banner within the minute")
})
