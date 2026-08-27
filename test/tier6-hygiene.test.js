'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const strip = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

const MAIN = strip(root('main.js'))
const RENDERER = strip(root('src/renderer.js'))

// ── Item 38: ENOENT fires 'error', not 'exit' ───────────────────────────────

test('the slskd child has an error handler that clears the restart guard', () => {
  // Without one, ENOENT left slskdProc truthy forever and `if (slskdProc) return`
  // blocked every future restart, while the 60 s monitor retried against a guard
  // that could never open.
  const at = MAIN.indexOf("slskdProc = spawn(SLSKD_BIN")
  assert.ok(at > 0)
  const block = MAIN.slice(at, at + 900)
  assert.match(block, /slskdProc\.on\('error'/, 'ENOENT fires error, not exit')
  const errHandler = block.slice(block.indexOf("slskdProc.on('error'"))
  assert.match(errHandler, /slskdProc = null/, 'the guard has to be cleared or restart is dead')
})

// ── Item 39: a batch that reported success and ran nothing ──────────────────

test('batch-transcode calls the real transcode, not ipcMain.emit', () => {
  // ipcMain.handle registers on Electron's private invoke channel, so
  // ipcMain.emit reached nothing. emit() returns a boolean, so the batch
  // reported [false, false, ...] as its results and ffmpeg never ran.
  assert.doesNotMatch(MAIN, /ipcMain\.emit\(/, 'emit does not reach a handle()')
  assert.match(MAIN, /function transcodeFile\(\{ filePath, format, outDir \}\)/)
  assert.match(MAIN, /ipcMain\.handle\('transcode-file', \(_, args\) => transcodeFile/)
  const batch = MAIN.slice(MAIN.indexOf("ipcMain.handle('batch-transcode'"))
  assert.match(batch.slice(0, 600), /await transcodeFile\(/)
})

// ── Items 46, 226: throttling is not ill health ─────────────────────────────

test('a 429 backs off and retries instead of failing', () => {
  const fn = MAIN.slice(MAIN.indexOf('async function slskdFetch('), MAIN.indexOf('function verifyAudioFile'))
  assert.match(fn, /res\.status === 429/)
  assert.match(fn, /retry-after/i, 'slskd knows better than a fixed schedule does')
  assert.match(fn, /SLSKD_THROTTLED/, 'the caller has to be able to tell this apart')
})

test('the health monitor does not restart the daemon for rate-limiting us', () => {
  // Restarting loses every in-flight transfer and then hammers slskd again from
  // a cold start — the opposite of what a 429 is asking for.
  const at = MAIN.indexOf("await slskdFetch('GET', '/session')")
  const block = MAIN.slice(at, at + 1400)
  assert.match(block, /SLSKD_THROTTLED/)
  const throttleBranch = block.slice(block.indexOf('SLSKD_THROTTLED'))
  assert.match(throttleBranch.slice(0, 400), /return/, 'a throttle must not reach the failure counter')
})

test('slskd errors say which request failed', () => {
  const fn = MAIN.slice(MAIN.indexOf('async function slskdFetch('), MAIN.indexOf('function verifyAudioFile'))
  assert.doesNotMatch(fn, /new Error\(`slskd \$\{res\.status\}`\)/, 'a bare status code is not a diagnosis')
  assert.match(fn, /on \$\{method\} \$\{endpoint\}/)
})

// ── Item 232: the megabyte poll payload ────────────────────────────────────

test('completed transfers are purged, after reconciliation and never before', () => {
  // dlTick treats a transfer that has vanished from slskd as ABANDONED, so
  // purging one before it is reconciled is indistinguishable from the user
  // cancelling it.
  assert.match(MAIN, /async function dlPurgeSucceeded\(now\)/)
  const fn = MAIN.slice(MAIN.indexOf('async function dlPurgeSucceeded('), MAIN.indexOf('async function dlTick'))
  assert.match(fn, /dlState\.inflight\[key\]/, 'unreconciled transfers must be skipped')
  assert.match(fn, /DL_PURGE_MAX_PER_PASS/, 'firing 1451 DELETEs at once earns the 429')
  assert.match(fn, /SLSKD_THROTTLED/, 'a throttle must stop the pass, not be pushed through')
  // And the call has to come after the reconcile loop, not before it.
  const tick = MAIN.slice(MAIN.indexOf('async function dlTick'))
  const reconcileAt = tick.indexOf('recordSuccess')
  const purgeAt = tick.indexOf('dlPurgeSucceeded(now)')
  assert.ok(reconcileAt > 0 && purgeAt > reconcileAt, 'purge must run after reconciliation')
})

// ── Item 233: a poll that ran for the life of the process ─────────────────

test('the downloads poll rate is decided in one place, and can stop', () => {
  assert.match(RENDERER, /function retuneDownloadsPolling\(\)/)
  const fn = RENDERER.slice(RENDERER.indexOf('function retuneDownloadsPolling()'),
                            RENDERER.indexOf('function retuneDownloadsPolling()') + 700)
  assert.match(fn, /stopDownloadsPolling\(\)/, 'stopDownloadsPolling was never called at all')
  assert.match(fn, /_dlHasActive\(\)/, 'the poll is only worth its cost while something is moving')
  // No call site should be picking its own interval any more.
  const literals = [...RENDERER.matchAll(/startDownloadsPolling\((\d+)\)/g)].map(m => m[1])
  assert.deepStrictEqual(literals, [], `intervals must come from retuneDownloadsPolling, found ${literals}`)
})

// ── Item 112: reloading into the same crash ───────────────────────────────

test('a crash loop stops offering the reload as the default', () => {
  const at = MAIN.indexOf("on('render-process-gone'")
  const block = MAIN.slice(at, at + 2200)
  assert.match(block, /_rendererCrashes/)
  assert.match(block, /MAX_RENDERER_CRASHES/)
  assert.match(block, /looping \? \['Close', 'Reload anyway'\] : \['Reload', 'Close'\]/,
    'past the threshold, Close has to be the default')
})

// ── Item 113: levels ─────────────────────────────────────────────────────

test('the log has levels behind a gate', () => {
  assert.match(MAIN, /const LOG_LEVELS = \{ debug: 10, info: 20, warn: 30, error: 40 \}/)
  assert.match(MAIN, /process\.env\.PAPA_LOG_LEVEL/)
  assert.match(MAIN, /if \(\(LOG_LEVELS\[level\.toLowerCase\(\)\] \|\| LOG_LEVELS\.info\) < LOG_MIN_LEVEL\) return/)
  // console.warn and console.debug have to exist, or code cannot use them.
  assert.match(MAIN, /console\.warn = /)
  assert.match(MAIN, /console\.debug = /)
})

// ── Items 148, 226 on the renderer side ──────────────────────────────────

test('a throttled search retries once, visibly, rather than reading as empty', () => {
  assert.match(RENDERER, /function _slskIsThrottleError\(e\)/)
  const fn = RENDERER.slice(RENDERER.indexOf('function _slskScheduleThrottleRetry('),
                            RENDERER.indexOf('function _slskResetThrottleRetry('))
  assert.match(fn, /_slskThrottleRetriedFor === query/, 'one retry per search, not per variant')
  assert.match(fn, /throttling searches/, 'the user has to be told why results stopped')
  assert.match(fn, /slsk\.lastQuery !== query/, 'do not retry a search nobody is looking at')
})

test('a new query gets its own retry allowance', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function runSlskSearch(query)'),
                            RENDERER.indexOf('async function runSlskSearch(query)') + 500)
  assert.match(fn, /_slskResetThrottleRetry\(\)/)
})
