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

// ── Item 192: a parser error should be one line, not pages ─────────────────

test('YouTube parser errors are summarised to one line', () => {
  // youtubei.js puts the whole generated parser type in the message — pages of
  // TypeScript, one log line at a time, through the old synchronous append path.
  assert.match(MAIN, /function summariseYtError\(e\)/)
  const fn = MAIN.slice(MAIN.indexOf('function summariseYtError(e)'), MAIN.indexOf('async function withRetry'))
  assert.match(fn, /interface\|type\|export\|class/, 'cut at the generated-type block')
  assert.match(fn, /YT_ERR_MAX/, 'and cap what is left')
  assert.doesNotMatch(MAIN, /error: String\(e\?\.message \|\| e\) \}/, 'handlers must return the summary')
})

// ── Item 165: a file the app is rewriting is not a missing file ────────────

test('a file being rewritten is never reported as confirmed missing', () => {
  // ffmpeg cannot edit tags in place: it writes a temp file and replaces the
  // original, while mpv holds the same file open with 30 s of readahead. A load
  // error in that window used to reach the missing-file path.
  const fn = MAIN.slice(MAIN.indexOf("ipcMain.handle('track-exists'"), MAIN.indexOf("ipcMain.handle('track-exists'") + 900)
  assert.match(fn, /_rewriting\.has\(path\.resolve\(p\)\)/)
  // checked:false matters specifically: the load-error policy only removes a
  // track on a CONFIRMED absence, so this makes it retry instead.
  const branch = fn.slice(fn.indexOf('_rewriting.has'))
  assert.match(branch.slice(0, 200), /checked: false/)
  // And the write path has to register and deregister, even if it throws.
  const write = MAIN.slice(MAIN.indexOf("ipcMain.handle('library-write-tags'"), MAIN.indexOf("ipcMain.handle('library-write-tags'") + 1200)
  assert.match(write, /_rewriting\.add/)
  assert.match(write, /finally \{[\s\S]*_rewriting\.delete/)
})

// ── Item 234: do not queue a second copy of a transfer you failed to cancel ─

test('a stalled transfer is only re-queued once slskd has let go of it', () => {
  const tick = MAIN.slice(MAIN.indexOf('const stalled = dlSched.stalledItems'))
  const block = tick.slice(0, 1400)
  assert.match(block, /let cancelled = false/)
  assert.match(block, /if \(cancelled\) dlSched\.recordStall/,
    'recordStall used to run regardless, so a failed DELETE left slskd holding the transfer AND the scheduler re-queueing it')
})

// ── Items 51 and 62, and a failed scan that read as an empty library ───────

test('the watcher debounce cannot be postponed forever', () => {
  const fn = MAIN.slice(MAIN.indexOf('function setupLibraryWatcher'), MAIN.indexOf('function buildAlbums'))
  assert.match(fn, /WATCH_MAX_WAIT_MS/)
  assert.match(fn, /now - _watchFirstEventAt >= WATCH_MAX_WAIT_MS/,
    'copying an album in kept deferring the scan while burning CPU on debounce churn')
})

test('concurrent scans join the one in flight', () => {
  assert.match(MAIN, /let _scanInFlight = null/)
  const fn = MAIN.slice(MAIN.indexOf('function performScan(onProgress)'), MAIN.indexOf('async function _performScanOnce'))
  assert.match(fn, /if \(_scanInFlight\) return _scanInFlight/)
})

test('a failed scan is distinguishable from an empty library, everywhere', () => {
  // An empty array is a legitimate result for an empty folder, and every
  // consumer used `|| []` — so a scan error blanked the library on screen while
  // the cache on disk was untouched, which looks exactly like losing it.
  assert.match(MAIN, /return \{ albums: \[\], failed: true, error:/)
  // Every consumer has to check the flag.
  for (const fn of ['fullScan', 'backgroundSync', 'applyLibraryUpdate']) {
    const at = RENDERER.indexOf(`function ${fn}(`)
    assert.ok(at > 0, `${fn} not found`)
    const body = RENDERER.slice(at, at + 900)
    assert.match(body, /\.failed/, `${fn} must not treat a failed scan as an empty library`)
  }
  // And fullScan must not claim success.
  const full = RENDERER.slice(RENDERER.indexOf('async function fullScan()'), RENDERER.indexOf('async function fullScan()') + 900)
  const failBranch = full.slice(full.indexOf('data.failed'))
  assert.match(failBranch.slice(0, 400), /return/, 'it used to report "0 albums found" as the answer')
})
