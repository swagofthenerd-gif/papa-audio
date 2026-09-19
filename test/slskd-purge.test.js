const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')

test('stale searches are purged when slskd becomes ready', () => {
  assert.ok(main.includes('async function purgeStaleSearches'), 'purge function must exist')
  // Both paths reach a ready daemon: one we spawned, and one already running.
  const calls = (main.match(/await purgeStaleSearches\(\)/g) || []).length
  assert.ok(calls >= 2, `expected a purge on both startup paths, found ${calls}`)
})

test('the purge only deletes finished searches, never a running one', () => {
  const fn = main.slice(main.indexOf('async function purgeStaleSearches'))
    .slice(0, main.slice(main.indexOf('async function purgeStaleSearches')).indexOf('\n}\n') + 3)
  assert.ok(/Completed|Errored|TimedOut/.test(fn), 'must filter by finished states')
  assert.ok(!/filter\(\s*\(?s\)?\s*=>\s*true/.test(fn), 'must not delete indiscriminately')
  // A failed delete must not abort the loop and leave the rest leaked.
  assert.ok(fn.includes('catch'), 'individual deletes must be guarded')
})

// slskd rebuilds its database on every start and can take minutes to answer —
// measured at about three on this machine. waitForSlskd waits thirty seconds,
// and the token acquire and the stale-search purge used to run regardless of
// whether it had actually come up. Both failed against a daemon that was not
// there, nothing retried, and the purge is what keeps searching working at all:
// so a slow start left Soulseek logged in and unable to search until the app
// was restarted, which started the same race again. Ten sessions in one day.
test('a slow-starting daemon is waited for, not given up on', () => {
  const fn = main.slice(main.indexOf('async function startSlskd'),
    main.indexOf('function stopSlskd'))
  assert.match(fn, /if \(await waitForSlskd\(\)\)/,
    'the startup work must be gated on the daemon actually being ready')
  assert.match(fn, /_settleSlskdWhenReady\(\)/,
    'a daemon that has not answered yet must be watched, not abandoned')
  assert.match(fn, /starting: true/,
    'the UI must be told it is starting rather than left reading "offline"')
})

test('the background watch finishes the startup work when the daemon lands', () => {
  const fn = main.slice(main.indexOf('function _settleSlskdWhenReady'),
    main.indexOf('function slskdIsStarting'))
  assert.match(fn, /slskdAcquireToken\(\)/, 'it must take a token once ready')
  assert.match(fn, /purgeStaleSearches\(\)/,
    'and run the purge that was skipped — this is the part that restores searching')
  assert.match(fn, /connected: true/, 'and say so, so a pending search can re-run')
  assert.match(fn, /if \(_slskdSettleTimer\) return/, 'only one watcher at a time')
  assert.match(fn, /Date\.now\(\) > deadline/, 'it must give up eventually rather than poll forever')
})

test('stopping slskd cancels the watch', () => {
  const fn = main.slice(main.indexOf('function stopSlskd'), main.indexOf('const SLSKD_STOP_TIMEOUT_MS'))
  assert.match(fn, /_clearSlskdSettle\(\)/,
    'a watcher polling for a daemon we are stopping would run the startup work under the next one')
})

test('slsk-status distinguishes "starting" from "offline"', () => {
  const at = main.indexOf("ipcMain.handle('slsk-status'")
  const fn = main.slice(at, main.indexOf('})', main.indexOf('catch', at)))
  assert.match(fn, /starting: slskdIsStarting\(\)/,
    'not answering yet reads as broken unless it is named')
})
