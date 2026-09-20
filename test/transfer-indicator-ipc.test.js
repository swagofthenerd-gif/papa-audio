'use strict'
// The upload half of the sidebar transfer indicator, over IPC. main.js cannot be
// required outside Electron, so this pins the source shape: the existing upload
// poll now remembers a slimmed copy of the current upload rows, and the
// slsk-upload-stats handler hands them to the renderer alongside the counters
// it already returned. No new poller, no new channel.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function handlerBody() {
  const start = MAIN.indexOf("ipcMain.handle('slsk-upload-stats'")
  assert.ok(start > 0, 'the slsk-upload-stats handler still exists')
  const end = MAIN.indexOf('ipcMain.handle(', start + 10)
  return MAIN.slice(start, end > 0 ? end : start + 2000)
}

test('the upload poll remembers the current rows in a module-level cache', () => {
  assert.match(MAIN, /let _lastUploadRows = \[\]/,
    'the cache is declared once, beside the poll')
  const start = MAIN.indexOf('async function slskUploadPollOnce')
  const body = MAIN.slice(start, MAIN.indexOf('function slskUploadPollStart'))
  assert.match(body, /_lastUploadRows = slimUploadRows\(uploads\)/,
    'the poll slims the snapshot it already fetched')
})

test('the slimmer keeps only the five fields the panel needs', () => {
  const start = MAIN.indexOf('function slimUploadRows')
  assert.ok(start > 0, 'slimUploadRows exists')
  const body = MAIN.slice(start, start + 1600)
  for (const field of ['filename', 'username', 'state', 'percentComplete', 'averageSpeed']) {
    assert.match(body, new RegExp('\\b' + field + ':'), field + ' is kept')
  }
  // Nothing else rides along: a peer-controlled row must not carry unknown keys
  // across the bridge.
  const kept = body.match(/^\s{6}\w+:/gm) || []
  assert.equal(kept.length, 5, 'exactly five fields, got: ' + kept.join(' '))
  assert.ok(!/bytesTransferred:/.test(body), 'the byte counter stays in upload-stats')
})

test('the slimmer walks the same three shapes slskd answers with', () => {
  const start = MAIN.indexOf('function slimUploadRows')
  const body = MAIN.slice(start, start + 1600)
  assert.match(body, /u\.directories/, 'grouped user -> directories -> files')
  assert.match(body, /u\.files/, 'flat-per-user')
})

test('the handler returns the rows with the counters', () => {
  const body = handlerBody()
  assert.match(body, /rows: _lastUploadRows/,
    'the success path carries the current rows')
})

test('an unreachable daemon still answers, with no rows', () => {
  const body = handlerBody()
  const tail = body.slice(body.indexOf('rolled'))
  assert.match(tail, /ok: true/, 'the failure path keeps the ok shape')
  assert.match(tail, /rows: \[\]/, 'no rows rather than stale ones')
  assert.match(tail, /totalUploadedToday: rolled\.totalUploadedToday/)
})

test('no second upload poller was added for the rows', () => {
  const timers = MAIN.match(/setInterval\(\(\) => \{ slskUploadPollOnce\(\) \}/g) || []
  assert.ok(timers.length <= 2, 'still only the existing poll/retune pair, got ' + timers.length)
})

// ── The counters the sidebar reads ───────────────────────────────────────────

test('the handler returns the day\'s delivered-file count on both paths', () => {
  const body = handlerBody()
  assert.match(body, /filesUploadedToday: result\.filesUploadedToday/,
    'the live path carries the count the idle Sharing pill shows')
  assert.match(body, /filesUploadedToday: rolled\.filesUploadedToday/,
    'and so does the unreachable-daemon path')
})

test('a repainting caller can be served from the last poll', () => {
  const body = handlerBody()
  assert.match(body, /opts && opts\.cachedOk/,
    'the handler takes a cachedOk opt-in')
  assert.match(body, /_lastUploadPollAt\) < UPLOAD_CACHE_FRESH_MS/,
    'and only honours it while the cached poll is still fresh')
  assert.match(MAIN, /const UPLOAD_CACHE_FRESH_MS = 70 \* 1000/,
    'fresh means under 70 s — one tick longer than the 60 s active poll')
  // The cached answer must come BEFORE the poll call, or it saves nothing.
  assert.ok(body.indexOf('cachedOk') < body.indexOf('await slskUploadPollOnce'),
    'the cache is checked before slskd is asked again')
})

test('preload hands the whole handler result back, opts and all', () => {
  const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
  const line = (PRELOAD.match(/^.*slskUploadStats:.*$/m) || [''])[0]
  assert.match(line, /ipcRenderer\.invoke\('slsk-upload-stats', opts \|\| \{\}\)/,
    'the options reach main')
  // No .then that picks fields off the result: rows and counters pass through.
  assert.ok(!/slskUploadStats:[^\n]*\.then/.test(line),
    'preload does not reshape the result')
})

// ── The sidebar wiring ───────────────────────────────────────────────────────

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8')

test('the sidebar carries a downloads pill and a hidden Sharing row', () => {
  assert.match(HTML, /id="nav-dl-pill"[^>]*hidden/, 'the downloads pill starts hidden')
  assert.match(HTML, /<li class="nav-item" data-page="sharing" id="nav-sharing" hidden/,
    'the Sharing row exists and starts hidden')
  assert.match(HTML, /id="nav-sharing-pill"/, 'with its own pill')
  assert.match(HTML, /<script src="transfer-indicator\.js"><\/script>/,
    'the pure model is loaded as a page script')
})

test('the downloads pill is painted from the existing poll, not a new one', () => {
  const start = RENDERER.indexOf('async function _pollAndRenderDownloadsInner')
  const body = RENDERER.slice(start, start + 4000)
  assert.match(body, /_paintDownloadPill\(files\)/,
    'the poll callback paints the pill from the snapshot it already has')
  assert.ok(!/setInterval\([^)]*_paintDownloadPill/.test(RENDERER),
    'the download pill has no timer of its own')
})

test('the sharing refresh is one 60 s timer that asks main for its cache', () => {
  assert.match(RENDERER, /const SHARING_POLL_MS = 60000/)
  const timers = RENDERER.match(/setInterval\([^\n]*_refreshSharingStats/g) || []
  assert.equal(timers.length, 1, 'exactly one sharing timer, got ' + timers.length)
  assert.match(RENDERER, /slskUploadStats\(\{ cachedOk: true \}\)/,
    'the refresh never forces a fresh slskd fetch')
})

test('the sharing refresh stops while the window is hidden', () => {
  const start = RENDERER.indexOf('function retuneSharingPoll')
  const body = RENDERER.slice(start, start + 500)
  assert.match(body, /if \(!_appVisible\) \{\s*\n\s*if \(_sharingPollTimer\) \{ clearInterval\(_sharingPollTimer\)/,
    'a hidden window clears the timer, the same rule the downloads poll follows')
  assert.match(RENDERER, /retuneDownloadsPolling\(\)\n\s*retuneSharingPoll\(\)/,
    'and the visibility handler retunes it alongside the downloads poll')
})

test('the Sharing row only appears when the pill model says so', () => {
  const start = RENDERER.indexOf('function _paintSharingPill')
  const body = RENDERER.slice(start, RENDERER.indexOf('async function _refreshSharingStats'))
  assert.match(body, /PapaTransferIndicator\.sharingPill/, 'the model decides')
  assert.match(body, /if \(!pill\) \{[\s\S]*row\.hidden = true/,
    'no pill means the whole row is hidden')
  assert.match(body, /row\.hidden = false/, 'and a pill unhides it')
  assert.match(body, /el\.textContent = pill\.text/, 'text, never innerHTML')
})

test('clicking Sharing opens the panel instead of navigating', () => {
  const start = RENDERER.indexOf("if (el.dataset.action === 'settings')")
  const body = RENDERER.slice(start, start + 600)
  assert.match(body, /el\.dataset\.page === 'sharing'/, 'the click handler knows it')
  const branch = body.slice(body.indexOf("=== 'sharing'"))
  assert.match(branch.slice(0, 200), /_openSharingPanel\(\)/, 'it opens the panel')
  assert.ok(branch.indexOf('return') < branch.indexOf("navigate(el.dataset.page)"),
    'and returns before the navigate fallback')
})

// ── The sharing panel ────────────────────────────────────────────────────────

test('the panel is a slide-over beside the queue panel', () => {
  assert.match(HTML, /<div class="queue-panel sharing-panel" id="sharing-panel"/,
    'it reuses the queue panel shell')
  assert.match(HTML, /id="sharing-list"/, 'a list of rows')
  assert.match(HTML, /id="sharing-today"/, 'and the day line under it')
  assert.ok(HTML.indexOf('id="sharing-panel"') > HTML.indexOf('id="queue-panel"'),
    'it lives next to the queue panel')
})

test('the rows come from the pure model and the day line from todayLine', () => {
  const start = RENDERER.indexOf('function _renderSharingPanel')
  const body = RENDERER.slice(start, RENDERER.indexOf('function _onSharingPanelKey'))
  assert.match(body, /PapaTransferIndicator\.sharingRows\(s\.rows \|\| \[\]\)/)
  assert.match(body, /today\.textContent = window\.PapaTransferIndicator\.todayLine\(stats\)/,
    'the day line is text, and it is the model\'s sentence')
  assert.match(body, /Nobody is taking anything right now/, 'the empty state is never blank')
})

test('every peer-controlled string in a row is escaped', () => {
  const start = RENDERER.indexOf('function _sharingRowHtml')
  const body = RENDERER.slice(start, RENDERER.indexOf('function _renderSharingPanel'))
  for (const field of ['r.username', 'r.file', 'r.folder']) {
    assert.ok(body.includes('esc(' + field + ')'), field + ' goes through esc')
  }
  // The only unescaped interpolation is the clamped percentage, a number.
  const raw = body.match(/\+ (?!esc\()(?!'|\()[\w.]+ \+/g) || []
  assert.deepStrictEqual(raw.filter(x => !/pct|moving|speed/.test(x)), [],
    'nothing but numbers reaches the markup unescaped: ' + raw.join(' '))
})

test('a peer name opens their library', () => {
  const start = RENDERER.indexOf('function _renderSharingPanel')
  const body = RENDERER.slice(start, RENDERER.indexOf('function _onSharingPanelKey'))
  assert.match(body, /showSlskUserExplorer\(b\.dataset\.peer\)/,
    'the peer button routes to the explorer')
})

test('the open-panel refresh is one 10 s timer, cleared on close', () => {
  assert.match(RENDERER, /const SHARING_PANEL_REFRESH_MS = 10000/)
  const timers = RENDERER.match(/, SHARING_PANEL_REFRESH_MS\)/g) || []
  assert.equal(timers.length, 1, 'exactly one panel timer, got ' + timers.length)
  const close = RENDERER.slice(RENDERER.indexOf('function _closeSharingPanel'),
    RENDERER.indexOf('function _openSharingPanel'))
  assert.match(close, /clearInterval\(_sharingPanelTimer\); _sharingPanelTimer = null/,
    'closing stops it')
  assert.match(close, /removeEventListener\('keydown', _onSharingPanelKey\)/,
    'and takes its key handler with it')
})

test('Escape closes the panel', () => {
  const start = RENDERER.indexOf('function _onSharingPanelKey')
  const body = RENDERER.slice(start, start + 200)
  assert.match(body, /e\.key === 'Escape'[\s\S]*_closeSharingPanel\(\)/)
  assert.match(RENDERER, /addEventListener\('keydown', _onSharingPanelKey\)/,
    'and the handler is only bound while it is open')
})
