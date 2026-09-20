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

test('a repainting caller is served from the last poll at any age', () => {
  const body = handlerBody()
  assert.match(body, /opts && opts\.cachedOk/,
    'the handler takes a cachedOk opt-in')
  assert.match(body, /if \(cachedOk && _lastUploadResult\) \{/,
    'having a snapshot is the whole condition')
  // The freshness window was the bug: main's idle upload cadence is 5 minutes,
  // so any window short enough to call "fresh" sent most of the sidebar's 60 s
  // ticks through to a real /transfers/uploads fetch — the extra daemon traffic
  // the design rules out. A sidebar count is allowed to be minutes old.
  assert.ok(!/UPLOAD_CACHE_FRESH_MS/.test(MAIN),
    'no freshness window survives anywhere in main')
  assert.ok(!/_lastUploadPollAt\)? *[<>]/.test(body),
    'the cached branch does not compare the cache age at all')
  // The cached answer must come BEFORE the poll call, or it saves nothing.
  assert.ok(body.indexOf('cachedOk') < body.indexOf('await slskUploadPollOnce'),
    'the cache is checked before slskd is asked again')
})

test('the handler says whether the daemon actually answered', () => {
  const body = handlerBody()
  assert.match(MAIN, /let _uploadDaemonOk = true/,
    'main remembers the last poll outcome')
  const poll = MAIN.slice(MAIN.indexOf('async function slskUploadPollOnce'),
    MAIN.indexOf('function slskUploadPollStart'))
  assert.match(poll, /_uploadDaemonOk = false/, 'a failed fetch records it')
  assert.match(poll, /_uploadDaemonOk = true/, 'a good one clears it')
  assert.match(body, /daemon: _uploadDaemonOk/, 'the cached path carries the flag')
  assert.match(body, /rows: _uploadDaemonOk \? _lastUploadRows : \[\]/,
    'and drops its cached rows once the daemon stops answering, so the panel is '
    + 'not left with progress bars nothing can move')
  assert.match(body, /daemon: true/, 'the live path carries it')
  const tail = body.slice(body.indexOf('rolled'))
  assert.match(tail, /daemon: false/,
    'and the unreachable path says so rather than passing empty rows off as calm')
})

test('the cached path zeroes activeUploads once the daemon stops answering, but keeps the daily tally', () => {
  // Rows are already blanked on this path once the daemon is down (the test
  // above pins that); activeUploads must go the same way — a transfer cannot
  // be verified as active through a connection nothing can reach. Scoped to
  // the cached branch only, so this cannot pass by matching the unrelated
  // zero on the separate live-poll-failed path further down the handler.
  const body = handlerBody()
  const cached = body.slice(0, body.indexOf('await slskUploadPollOnce'))
  assert.match(cached, /activeUploads: _uploadDaemonOk \? _lastUploadResult\.activeUploads : 0,/,
    'zero, not the frozen figure, once _uploadDaemonOk is false')
  // The daily counters are history, not a live claim, so they are untouched.
  assert.match(cached, /filesUploadedToday: _lastUploadResult\.filesUploadedToday,/,
    'the day\'s delivered-file count survives the same outage')
  assert.match(cached, /totalUploadedToday: _lastUploadResult\.totalUploadedToday,/,
    'and the byte tally beside it')
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
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
const vm = require('node:vm')
const TI = require('../src/transfer-indicator.js')

// Pulls one function's exact source out of renderer.js by brace counting, so
// it can actually be run (not just pattern-matched) against a stubbed DOM —
// the same functions the real page loads, with a fake document instead of one.
function extractFn(name) {
  const marker = 'function ' + name + '('
  const start = RENDERER.indexOf(marker)
  assert.ok(start !== -1, name + ' must exist')
  const braceStart = RENDERER.indexOf('{', start)
  let depth = 0
  let i = braceStart
  for (; i < RENDERER.length; i++) {
    if (RENDERER[i] === '{') depth++
    else if (RENDERER[i] === '}') { depth--; if (depth === 0) { i++; break } }
  }
  return RENDERER.slice(start, i)
}

// Same idea for a single `const NAME = ...` / `var NAME = ...` line, so a test
// can inject the module's own default-title text rather than a copy of it.
// Rewritten to `var`: a bare `const`/`let` at the top of a vm.runInContext
// script binds lexically and never lands on the context object, so the test
// could not read it back to compare against — `var` does.
function extractConst(name) {
  const m = RENDERER.match(new RegExp('(?:const|var) ' + name + ' = .*'))
  assert.ok(m, name + ' must exist')
  return m[0].replace(/^(?:const|let)\b/, 'var')
}

test('a hidden nav row is actually hidden', () => {
  // .nav-item sets display:flex, which beats the browser's own [hidden] rule,
  // so a nav row given `hidden` would sit in the sidebar anyway. No row ships
  // hidden today — the Sharing row stopped, because it is a destination now —
  // but the rule stays: the next row that hides itself must actually go, and
  // the repo already hit this exact trap one rung down with .nav-pill[hidden].
  assert.match(CSS, /\.nav-item\[hidden\]\s*\{\s*display:\s*none\s*\}/,
    '.nav-item[hidden] { display:none } must exist in styles.css')
  assert.match(CSS, /\.nav-pill\[hidden\]\s*\{\s*display:\s*none\s*\}/,
    'and the pill rule it sits beside')
  // The class rule that makes it necessary is still there; if it ever goes,
  // this guard stops being load-bearing and should be revisited.
  assert.match(CSS, /\.nav-item \{\n\s*display:flex;/,
    '.nav-item still sets display:flex')
})

test('the sidebar carries a downloads pill and a Sharing row that is always there', () => {
  // The rule changed: the Sharing row used to be an alert, hidden until a peer
  // was taking something or had taken something today. It is now the one place
  // the Soulseek switch, the shared folders and the upload caps live, so it has
  // to be reachable on a day when nothing at all is happening. Only the pill
  // still comes and goes.
  assert.match(HTML, /id="nav-dl-pill"[^>]*hidden/, 'the downloads pill starts hidden')
  const row = /<li class="nav-item" data-page="sharing" id="nav-sharing"[^>]*>/.exec(HTML)
  assert.ok(row, 'the Sharing row exists')
  assert.ok(!/\bhidden\b/.test(row[0]),
    'and it does not ship hidden: ' + row[0])
  assert.match(HTML, /id="nav-sharing-pill"[^>]*hidden/, 'its pill still starts hidden')
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

test('the open panel still gets a real poll, unlike the sidebar', () => {
  // The sidebar passes cachedOk and is answered from the cache whatever its
  // age; the panel deliberately does not, so its 10 s tick keeps the progress
  // bars moving.
  assert.match(RENDERER, /\? window\.api\.slskUploadStats\(\{\}\)/,
    'the fresh path sends no cachedOk')
  const at = RENDERER.indexOf('function _openSharingPanel')
  assert.match(RENDERER.slice(at, at + 1400), /_refreshSharingStats\(true\)/,
    'and the panel asks for it on open')
})

test('the sharing refresh stops while the window is hidden', () => {
  const start = RENDERER.indexOf('function retuneSharingPoll')
  const body = RENDERER.slice(start, start + 500)
  assert.match(body, /if \(!_appVisible\) \{\s*\n\s*if \(_sharingPollTimer\) \{ clearInterval\(_sharingPollTimer\)/,
    'a hidden window clears the timer, the same rule the downloads poll follows')
  assert.match(RENDERER, /retuneDownloadsPolling\(\)\n\s*retuneSharingPoll\(\)/,
    'and the visibility handler retunes it alongside the downloads poll')
})

test('only the Sharing pill appears and disappears — the row stays put', () => {
  const start = RENDERER.indexOf('function _paintSharingPill')
  const body = RENDERER.slice(start, RENDERER.indexOf('async function _refreshSharingStats'))
  assert.match(body, /PapaTransferIndicator\.sharingPill/, 'the model decides the pill')
  assert.ok(!/row\.hidden = true/.test(body),
    'nothing may hide the row: it is the way in to the sharing controls')
  assert.match(body, /if \(!pill\) \{[\s\S]*el\.hidden = true/,
    'no pill still empties and hides the pill itself')
  assert.match(body, /el\.textContent = pill\.text/, 'text, never innerHTML')
})

// ── The daemon-down pill (behavioral, not just text-level) ──────────────────
// _paintSharingPill and _paintHubSharing run for real here, against a stubbed
// document, so a regression that lets a frozen activeUploads slip through to
// the model is caught even if the surrounding text still looks right.

function sharingPillCtx(stats) {
  // Starts hidden on purpose, so "the row is visible" is something the paint
  // had to do rather than something the fixture handed it.
  const rowEl = { hidden: true, title: '' }
  const pillEl = { hidden: false, textContent: '', classList: { toggle() {} }, setAttribute() {} }
  const ctx = {
    document: {
      getElementById: (id) => (id === 'nav-sharing' ? rowEl : id === 'nav-sharing-pill' ? pillEl : null),
    },
    window: { PapaTransferIndicator: TI },
    _sharingStats: stats,
  }
  vm.createContext(ctx)
  vm.runInContext(
    extractConst('SHARING_ROW_DEFAULT_TITLE') + '\n' +
    extractFn('_paintSharingPill') + '\n_paintSharingPill()',
    ctx)
  return { rowEl, pillEl, ctx }
}

test('the sidebar pill hides rather than showing a frozen live count once the daemon is down', () => {
  // Nothing given away today, but the last snapshot before the outage still
  // says 7 active — without the fix this reads as "↑ 7" forever.
  const { rowEl, pillEl } = sharingPillCtx({ daemon: false, activeUploads: 7, filesUploadedToday: 0 })
  assert.equal(pillEl.hidden, true, 'the frozen count never reaches the pill')
  assert.equal(rowEl.hidden, false,
    'and the row stays in the sidebar: the sharing controls have to stay reachable')
  assert.match(rowEl.title, /Can.t reach the Soulseek daemon/, 'the row explains why in a tooltip')
})

test('the sidebar pill falls back to the idle "N today" form, never the frozen live count', () => {
  const { pillEl, rowEl } = sharingPillCtx({ daemon: false, activeUploads: 7, filesUploadedToday: 5 })
  assert.equal(pillEl.hidden, false)
  assert.equal(pillEl.textContent, '5 today', 'the frozen 7-active snapshot never reaches the pill text')
  assert.match(rowEl.title, /Can.t reach the Soulseek daemon/)
})

test('the sidebar pill still shows live activity normally, and the default tooltip, while the daemon answers', () => {
  const { pillEl, rowEl, ctx } = sharingPillCtx({ daemon: true, activeUploads: 7, filesUploadedToday: 5 })
  assert.equal(pillEl.textContent, '↑ 7')
  assert.equal(rowEl.title, ctx.SHARING_ROW_DEFAULT_TITLE, 'restored, not left on the daemon-down message')
})

function hubSharingCtx(stats) {
  const el = { textContent: '', title: '' }
  const ctx = {
    document: { getElementById: (id) => (id === 'slsk-hub-sharing' ? el : null) },
    _fmtBytes: (n) => n + 'B',
    _slskUploadStats: stats,
  }
  vm.createContext(ctx)
  vm.runInContext(
    extractConst('HUB_SHARING_DEFAULT_TITLE') + '\n' +
    extractFn('_paintHubSharing') + '\n_paintHubSharing()',
    ctx)
  return { el, ctx }
}

test('the hub sharing line does not show a frozen live count once the daemon is down', () => {
  const { el } = hubSharingCtx({ daemon: false, activeUploads: 4, totalUploadedToday: 0, distinctPeersToday: 2 })
  assert.match(el.textContent, /^Sharing: 0 active/, 'the frozen active-upload count is suppressed')
  assert.match(el.title, /Can.t reach the Soulseek daemon/i)
})

test('the hub sharing line shows the live count normally, and the default tooltip, while the daemon answers', () => {
  const { el, ctx } = hubSharingCtx({ daemon: true, activeUploads: 4, totalUploadedToday: 0, distinctPeersToday: 2 })
  assert.match(el.textContent, /^Sharing: 4 active/)
  assert.equal(el.title, ctx.HUB_SHARING_DEFAULT_TITLE)
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

test('the panel says it cannot reach the daemon instead of reporting calm', () => {
  const start = RENDERER.indexOf('function _renderSharingPanel')
  const body = RENDERER.slice(start, RENDERER.indexOf('function _onSharingPanelKey'))
  assert.match(body, /s\.daemon === false/,
    'the empty state reads the flag main sets on the unreachable path')
  assert.match(body, /Can’t reach the Soulseek daemon/,
    'and says so in words')
  assert.ok(body.indexOf('s.daemon === false') < body.indexOf('Nobody is taking anything'),
    'the daemon check comes first, so "nobody is taking anything" is only said when that is known')
})

test('opening the sharing panel closes the queue panel', () => {
  // Both are fixed to the same right-hand slot: two open panels overlay exactly.
  assert.match(RENDERER, /function closeQueuePanel\(\) \{[\s\S]*?queue-panel'\)\?\.classList\.remove\('open'\)/,
    'there is one function that shuts the queue panel')
  const at = RENDERER.indexOf('function _openSharingPanel')
  const open = RENDERER.slice(at, at + 1400)
  assert.match(open, /closeQueuePanel\(\)/, 'and opening the sharing panel calls it')
  assert.ok(open.indexOf('closeQueuePanel()') < open.indexOf("classList.add('open')"),
    'before this one opens')
  assert.match(RENDERER, /'queue-close-btn'\)\?\.addEventListener\('click', closeQueuePanel\)/,
    'the queue close button uses the same function')
})

test('the downloads badge stands down while the pill is showing', () => {
  // Both live on the Downloads row and both appear when there is a queue; the
  // badge is absolutely positioned, so the two counts overlap.
  const at = RENDERER.indexOf("const badge = document.getElementById('nav-dl-badge')")
  assert.ok(at > 0, 'the badge paint still exists')
  const body = RENDERER.slice(at, at + 1200)
  assert.match(body, /const pillShowing = !!\(pillEl && !pillEl\.hidden\)/,
    'it reads the pill the poll just painted')
  assert.match(body, /badge\.style\.display = \(nb\.show && !pillShowing\) \? 'flex' : 'none'/,
    'and the pill wins')
  // The badge still does the job only it does: the day's finished count, which
  // the pill never shows.
  assert.ok(RENDERER.indexOf('_paintDownloadPill(files)') < at,
    'the pill is painted earlier in the same poll frame, so its flag is current')
})

test('an activity push cannot blank a counter it does not carry', () => {
  const at = RENDERER.indexOf('function _mergeUploadStats')
  assert.ok(at > 0, 'the merge is its own function')
  const body = RENDERER.slice(at, at + 400)
  assert.match(body, /if \(next\[k\] === undefined\) continue/,
    'an absent or undefined field keeps the previous value')
  const bind = RENDERER.slice(RENDERER.indexOf('function _slskBindUploadActivity'),
    RENDERER.indexOf('function _slskBindUploadActivity') + 800)
  assert.match(bind, /_sharingStats = _mergeUploadStats\(_sharingStats, s\)/,
    'the sidebar stats go through it')
  assert.ok(!/_sharingStats = Object\.assign/.test(RENDERER),
    'and not through a bare Object.assign any more')
  // main sends the day's file count along, so the first push of a session does
  // not leave the pill with no count at all.
  const sendAt = MAIN.indexOf("safeSend('slsk-upload-activity'")
  assert.ok(sendAt > 0, 'the activity event still exists')
  const payload = MAIN.slice(sendAt, MAIN.indexOf('})', sendAt))
  assert.match(payload, /filesUploadedToday: result\.filesUploadedToday/,
    'the activity event carries filesUploadedToday')
})
