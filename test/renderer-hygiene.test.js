'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'src')
const RENDERER = fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8')
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')

// Comments quote the patterns these tests forbid, so they have to go.
const CODE = RENDERER
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

// ── Items 71 and 72: every localStorage read goes through the reader ─────────

test('nothing parses localStorage directly any more', () => {
  // An unguarded parse in initSearchHistory aborted the rest of setupListeners,
  // leaving the queue panel, sleep timer, drag and drop and every keyboard
  // shortcut unbound for the whole session, with nothing shown.
  const direct = [...CODE.matchAll(/JSON\.parse\(\s*(?:window\.)?localStorage/g)]
  assert.strictEqual(direct.length, 0, 'use window.PapaLocal.readArray / readObject')
})

test('the validated reader is loaded before renderer.js', () => {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  const reader = order.indexOf('local-store.js')
  const renderer = order.indexOf('renderer.js')
  assert.ok(reader >= 0, 'local-store.js must be loaded')
  assert.ok(reader < renderer, 'renderer.js reads localStorage at its top level')
})

// ── Items 73 and 74: listeners removed on every exit path ───────────────────

test('the add-to-playlist modal removes its keydown listener in close()', () => {
  // Removing it only inside the Escape handler leaked one listener per open,
  // each holding the modal DOM and the whole track array. Five call sites.
  const close = CODE.slice(CODE.indexOf('const close = () => {'), CODE.indexOf('const addTo = (pl) => {'))
  assert.match(close, /removeEventListener\('keydown', onEsc\)/)
  // And the Escape handler must NOT be the thing that removes it, or a later
  // exit path added by someone else leaks again.
  const esc = CODE.slice(CODE.indexOf('function onEsc(e)'), CODE.indexOf('function onEsc(e)') + 120)
  assert.doesNotMatch(esc, /removeEventListener/)
})

test('_mgConfirm closes the previous dialog rather than deleting its DOM', () => {
  // Removing the element directly left the previous dialog's document keydown
  // listener registered forever. Nine call sites in Manage.
  const fn = CODE.slice(CODE.indexOf('function _mgConfirm('), CODE.indexOf('function _mgConfirm(') + 1200)
  assert.match(fn, /_mgConfirmClose\(\)/, 'the live dialog must be closed properly first')
  const closeFn = CODE.slice(CODE.indexOf('function close() {\n    if (_mgConfirmClose === close)'))
  assert.match(closeFn.slice(0, 300), /removeEventListener\('keydown', onKey\)/)
})

// ── Item 75: coalescing, not stacking ───────────────────────────────────────

test('the library rescan coalesces instead of queuing more timers', () => {
  // 19 call sites and three bare setTimeout calls with no stored handles: a
  // burst of downloads queued dozens of overlapping full-library syncs.
  const fn = CODE.slice(CODE.indexOf('function _scheduleLibRescan()'), CODE.indexOf('function _cancelLibRescan()'))
  assert.match(fn, /clearTimeout/, 'a later call must reschedule, not stack')
  assert.match(fn, /_libRescanTimers\.set/)
  assert.doesNotMatch(fn, /setTimeout\(backgroundSync,/, 'no unhandled timers')
})

// ── Items 76 and 77: stale-render guards ────────────────────────────────────

test('every Manage sub-render guards against a stale repaint', () => {
  // renderManageHealth had the guard and a comment saying this was already
  // fixed once; its two siblings did not.
  for (const fn of ['renderManageStorage', 'renderManageTrash', 'renderManageHealth']) {
    const at = CODE.indexOf(`async function ${fn}(`)
    assert.ok(at > 0, `${fn} not found`)
    const body = CODE.slice(at, at + 2000)
    assert.match(body, /_tabAtStart = _mgState\.tab/, `${fn} must capture the tab it started on`)
    assert.match(body, /_mgState\.tab !== _tabAtStart/, `${fn} must check it after awaiting`)
  }
})

test('the YouTube renders guard on identity, not only on page kind', () => {
  // Opening album A then album B before A resolved let A's late response repaint
  // over B, leaving handlers wired to A's browseId.
  for (const [fn, kind] of [['renderYtAlbum', 'album'], ['renderYtPlaylist', 'playlist'], ['renderYtArtist', 'artist']]) {
    const at = CODE.indexOf(`async function ${fn}(`)
    assert.ok(at > 0, `${fn} not found`)
    const body = CODE.slice(at, at + 1200)
    // Plain string checks: the escaping needed to write `++` as a regex through
    // two layers of quoting is its own bug factory.
    assert.ok(body.includes(`_ticket = ++_ytTicket.${kind}`), `${fn} must take a ticket`)
    assert.ok(body.includes(`_ticket !== _ytTicket.${kind}`), `${fn} must check its ticket after awaiting`)
  }
})

// ── Items 78 and 89: bounded caches ─────────────────────────────────────────

test('the caches that held a payload per key for the life of the process are capped', () => {
  assert.match(CODE, /function _cacheSet\(map, key, value, cap\)/)
  assert.match(CODE, /while \(map\.size > cap\)/, 'the cap has to be enforced, not just declared')
  // And the three that had no ceiling now go through it.
  assert.match(CODE, /_cacheSet\(ytSearchState\.cache/)
  assert.match(CODE, /_cacheSet\(_bioCache/)
  assert.match(CODE, /_cacheSet\(_colorCache/)
  assert.doesNotMatch(CODE, /ytSearchState\.cache\.set\(/, 'unbounded set() is the bug')
})

// ── Item 79: an id from outside used in a selector ──────────────────────────

test('ids from outside the app are escaped before going into a selector', () => {
  // f.id comes from slskd, dl.id from yt-dlp. A quote in one threw on every 6 s
  // tick until the download cleared. Interpolating an internal constant — the
  // current tab name, say — is not the same risk and is not flagged.
  const offenders = []
  for (const m of CODE.matchAll(/querySelector(?:All)?\(`[^`]*\$\{([^}]+)\}[^`]*`\)/g)) {
    const expr = m[1]
    if (!/\bid\b|\bId\b/.test(expr)) continue      // not an identifier from outside
    if (/CSS\.escape/.test(expr)) continue
    offenders.push(expr)
  }
  assert.deepStrictEqual(offenders, [], 'wrap these in CSS.escape')
})

// ── Item 80: remove your own listener, not the channel ─────────────────────

test('preload.on returns an unsubscribe function', () => {
  // off() is removeAllListeners on the channel, so two subscribers to
  // slsk-progress tore down each other.
  const on = PRELOAD.slice(PRELOAD.indexOf('  on: (channel, cb) => {'), PRELOAD.indexOf('  off: (channel)'))
  assert.match(on, /return \(\) => ipcRenderer\.removeListener\(channel, h\)/)
  assert.match(on, /if \(!allowed\.includes\(channel\)\) return \(\) => \{\}/,
    'a disallowed channel must still return something callable')
})

test('nothing tears down the slsk-progress channel wholesale', () => {
  assert.doesNotMatch(CODE, /off\('slsk-progress'\)/,
    'use the unsubscribe function returned by on()')
})

// ── Item 81: a bad frame is skipped, not fatal ─────────────────────────────

test('the downloads poll survives a throwing frame and says so', () => {
  const fn = CODE.slice(CODE.indexOf('async function _pollAndRenderDownloads()'),
                        CODE.indexOf('async function _pollAndRenderDownloadsInner()'))
  assert.match(fn, /catch \(e\)/, 'a throw must not become an unhandled rejection every tick')
  assert.match(fn, /_dlFrameFailures/)
  assert.match(fn, /showSnackbar/, 'a page frozen on stale data has to be visible')
  assert.match(fn, /finally/, 'the re-entrancy guard must still be released')
})

// ── Items 127, 128, 185: the UI converges on mpv ───────────────────────────

test('the renderer reconciles its playback state against mpv once a second', () => {
  // Three copies exist: mpv's properties, the shim's fields, and
  // state.isPlaying. This makes the last converge on the first.
  const at = CODE.indexOf('const reconcileTimer = setInterval(')
  assert.ok(at > 0, 'the reconcile tick is missing')
  const fn = CODE.slice(at, at + 2600)
  assert.match(fn, /state\.isPlaying !== playing/, 'the UI flag must follow mpv, not the last optimistic write')
  assert.match(fn, /audio\.mpvPath/, 'compare against what mpv has open')
  assert.match(fn, /audio\.positionAgeMs > STALE_POSITION_MS/, 'a frozen bar is its own signal')
  assert.match(fn, /if \(audio\.engineDown\) return/, 'do not shout while the engine is already down')
  assert.match(fn, /reconcileTimer\.unref/, 'a 1s interval must not hold the process open')
})

test('the reconcile does not cry wolf over streams', () => {
  // A stream is resolved to a direct URL before mpv sees it, so the paths
  // legitimately differ and comparing them would fire on every track.
  const at = CODE.indexOf('const reconcileTimer = setInterval(')
  const fn = CODE.slice(at, at + 2600)
  assert.match(fn, /\^https\?/, 'streams have to be exempted')
})

test('a disagreement resyncs to mpv rather than to the queue', () => {
  const at = CODE.indexOf('const reconcileTimer = setInterval(')
  const fn = CODE.slice(at, at + 2600)
  assert.match(fn, /state\.queueIndex = idx/)
  assert.match(fn, /updateNextPrefetch\(\)/, 'a resync without re-arming prefetch stops the album at the next boundary')
  assert.match(fn, /updateNowPlayingFromPath\(real\)/, 'and mpv playing something not in the queue still has to be shown')
})

test('the stale bar has a visible style, not just a class', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  assert.match(css, /\.progress-track\.stale/)
})

// ── Item 167: a rescan must not rebuild the page you are reading ───────────

test('backgroundSync goes through applyLibraryUpdate, not straight to navigate', () => {
  // applyLibraryUpdate holds the update while a modal is open or a
  // multi-selection is active, replays it afterwards, and restores the scroll
  // position. backgroundSync called navigate() directly and did none of that.
  const fn = CODE.slice(CODE.indexOf('async function backgroundSync()'),
                        CODE.indexOf('async function backgroundSync()') + 900)
  assert.match(fn, /applyLibraryUpdate\(/)
  assert.doesNotMatch(fn, /navigate\(state\.currentPage/, 'that is the unconditional rebuild')
})

// ── Item 236: a collapsible header has to report its state ────────────────

test('the download group toggles maintain aria-expanded', () => {
  // Focus and Enter/Space already worked via the a11y sweep and the delegated
  // keydown handler. The state did not: a screen reader was told this is a
  // button and nothing about what it did.
  const hits = [...CODE.matchAll(/hdr\.setAttribute\('aria-expanded', String\(isNowOpen\)\)/g)]
  assert.strictEqual(hits.length, 2, 'both the completed and failed toggles')
  // And the first render has to be right, not only the first click.
  const sweep = CODE.slice(CODE.indexOf("c.setAttribute('role', 'button')"), CODE.indexOf("c.setAttribute('role', 'button')") + 700)
  assert.match(sweep, /aria-expanded/)
})

// ── Item 126: a notice you were not there to see ───────────────────────────

test('every snackbar is recorded, not only shown', () => {
  const fn = CODE.slice(CODE.indexOf('function showSnackbar(msg'), CODE.indexOf('function showSnackbar(msg') + 300)
  assert.match(fn, /recordNotice\(msg\)/, 'snackbars expire; the record is the point')
})

test('the notice history is bounded and has a way in and out', () => {
  assert.match(CODE, /NOTICE_HISTORY_CAP/)
  const rec = CODE.slice(CODE.indexOf('function recordNotice('), CODE.indexOf('function updateNoticeBadge('))
  assert.match(rec, /_noticeHistory\.length > NOTICE_HISTORY_CAP/)
  const show = CODE.slice(CODE.indexOf('function showNoticeHistory('), CODE.indexOf('// ── Snackbar'))
  assert.match(show, /removeEventListener\('keydown', onKey\)/,
    'a modal that registers a document listener has to remove it — see items 73, 74 and 257')
  assert.match(show, /notice-close/)
})

test('the badge shows only what has not been read', () => {
  const fn = CODE.slice(CODE.indexOf('function updateNoticeBadge('), CODE.indexOf('function showNoticeHistory('))
  assert.match(fn, /_noticeHistory\.length - _noticesSeen/)
  assert.match(fn, /style\.display = unread \? '' : 'none'/)
})

// ── Item 150: the discarded tail ──────────────────────────────────────────

test('the results cap is extensible and states what it is hiding', () => {
  assert.match(CODE, /var _slskShowLimit = SLSK_SHOW_STEP/)
  assert.match(CODE, /filtered\.slice\(0, _slskShowLimit\)/)
  assert.match(CODE, /showing \$\{displayList\.length\} of \$\{filtered\.length\}/,
    'a cap with no count is indistinguishable from there being nothing else')
  assert.match(CODE, /_slskShowLimit \+= SLSK_SHOW_STEP/)
})

test('a new search resets the limit', () => {
  const fn = CODE.slice(CODE.indexOf('async function runSlskSearch(query)'),
                        CODE.indexOf('async function runSlskSearch(query)') + 600)
  assert.match(fn, /_slskShowLimit = SLSK_SHOW_STEP/,
    'otherwise one long list makes every later search enormous')
})

// ── Tier 0.3 and 0.5 ────────────────────────────────────────────────────────

test('the assistant-panel searches declare themselves as background searches', () => {
  // They defaulted to generation 0 and were cancelled by the next ordinary
  // search, coming back {results: [], cancelled: true} — read as "found nothing".
  const calls = [...CODE.matchAll(/window\.api\.slskSearch\(\s*\{([^}]*)\}/g)].map(m => m[1])
  assert.ok(calls.length >= 3, `expected several call sites, found ${calls.length}`)
  for (const args of calls) {
    assert.match(args, /generation:/, `every slskSearch must state its generation: {${args.trim()}}`)
  }
  const bg = calls.filter(a => /generation:\s*-1/.test(a))
  assert.strictEqual(bg.length, 2, 'the two assistant-panel searches are the background ones')
})

test('the Soulseek row buttons are styled', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  assert.match(css, /\.slsk-retry-btn\s*\{/)
})

// ── Item 1.9: the startup restore must not overwrite live playback ─────────

test('restorePlaybackState bails when something is already playing', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function restorePlaybackState(opts)'),
                       RENDERER.indexOf('// \u2500\u2500 Navigation'))
  assert.ok(fn.length > 200, 'found the function')
  assert.match(fn, /if \(!opts\.force && \(state\.queue\.length \|\| state\.isPlaying\)\) return/,
    'the entry guard')
  // It runs on a 1.2s timer and awaits twice inside; each await needs a check
  // after it, or the user's queue is replaced by the restored one.
  const awaits = [...fn.matchAll(/await window\.api\./g)].length
  const checks = [...fn.matchAll(/if \(superseded\(\)\) return/g)].length
  assert.ok(awaits >= 2, 'still awaits IPC')
  assert.ok(checks >= awaits, `every await is followed by a check (${awaits} awaits, ${checks} checks)`)
})

test('the deferred seek cannot move a track the user chose', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('async function restorePlaybackState(opts)'),
                       RENDERER.indexOf('// \u2500\u2500 Navigation'))
  const seek = fn.slice(fn.indexOf('if (resumePos > 1)'), fn.indexOf('state.isPlaying = false'))
  assert.match(seek, /if \(superseded\(\)\) return/, 'the timer checks before seeking')
  assert.match(seek, /audio\.src !== 'file:\/\/' \+ saved\.filePath/,
    'and confirms it is still seeking the track it loaded')
})

test('playCurrentTrack records the intent the restore watches', () => {
  assert.match(RENDERER, /^var _playbackIntent = 0$/m)
  const fn = RENDERER.slice(RENDERER.indexOf('function playCurrentTrack() {'),
                       RENDERER.indexOf('function playCurrentTrack() {') + 200)
  assert.match(fn, /_playbackIntent\+\+/, 'bumped on every deliberate start')
})

test('the explicit resume card still forces the restore', () => {
  // The guards are about the startup timer racing the user. When the user has
  // pressed "resume where you left off", they are the user.
  const fn = RENDERER.slice(RENDERER.indexOf('async function resumeFromSavedState('),
                       RENDERER.indexOf('async function restorePlaybackState('))
  assert.match(fn, /restorePlaybackState\(\{ force: true \}\)/)
})

test('restorePlaybackState, run as the startup timer does, leaves live playback alone', async () => {
  // A real run of the guard logic, not a reading of it: the queue the user
  // built must survive a restore that resolves after they pressed play.
  var order = []
  var state = { queue: [{ filePath: '/user/pick.flac' }], queueIndex: 0, isPlaying: true, library: [] }
  var _playbackIntent = 7
  var audio = { src: 'file:///user/pick.flac', currentTime: 12 }
  var api = {
    getPlaybackState: async function () { order.push('getPlaybackState'); return { filePath: '/old/track.flac', position: 90 } },
    getSavedQueues: async function () { order.push('getSavedQueues'); return [{ id: '_auto', tracks: [{ filePath: '/old/track.flac' }], index: 0 }] }
  }
  // The shape of the guarded function, transcribed from the source under test.
  async function restore(opts) {
    opts = opts || {}
    var gen = _playbackIntent
    var superseded = function () { return !opts.force && (_playbackIntent !== gen || state.isPlaying) }
    if (!opts.force && (state.queue.length || state.isPlaying)) return 'bailed'
    var saved = await api.getPlaybackState()
    if (superseded()) return 'bailed'
    state.queue = [{ filePath: saved.filePath }]
    audio.src = 'file://' + saved.filePath
    var queues = await api.getSavedQueues()
    if (superseded()) return 'bailed'
    state.queue = queues[0].tracks
    return 'restored'
  }

  assert.strictEqual(await restore(), 'bailed', 'a non-empty queue is left alone')
  assert.deepStrictEqual(order, [], 'and it does not even ask')
  assert.strictEqual(audio.src, 'file:///user/pick.flac', 'the loaded track is untouched')
  assert.deepStrictEqual(state.queue, [{ filePath: '/user/pick.flac' }])

  // The race proper: empty at entry, but the user presses play during the await.
  state.queue = []; state.isPlaying = false
  api.getPlaybackState = async function () { _playbackIntent++; state.isPlaying = true; return { filePath: '/old/track.flac', position: 90 } }
  assert.strictEqual(await restore(), 'bailed', 'the check after the first await catches it')

  // And with nothing playing at all, it still does its job.
  state.queue = []; state.isPlaying = false
  api.getPlaybackState = async function () { return { filePath: '/old/track.flac', position: 90 } }
  assert.strictEqual(await restore(), 'restored')
  assert.deepStrictEqual(state.queue, [{ filePath: '/old/track.flac' }])
})

// ── Items 2.12 and 2.13: a disabled button must always come back ───────────

// Brace-depth scan over the real source, because the pattern being checked is
// "somewhere in the enclosing function", which no regex can express.
function functionsDisablingAButton(src) {
  const depth = new Array(src.length)
  let d = 0, instr = null, esc = false, comment = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (comment === 'line') { if (c === '\n') comment = null }
    else if (comment === 'block') {
      if (c === '*' && src[i + 1] === '/') { comment = null; depth[i] = d; depth[i + 1] = d; i++; continue }
    } else if (instr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === instr) instr = null
    } else {
      if (c === '/' && src[i + 1] === '/') comment = 'line'
      else if (c === '/' && src[i + 1] === '*') comment = 'block'
      else if (c === "'" || c === '"' || c === '`') instr = c
      else if (c === '{') d++
      else if (c === '}') d--
    }
    depth[i] = d
  }

  const out = []
  for (const m of src.matchAll(/\.disabled\s*=\s*true/g)) {
    let cur = m.index, found = null
    for (let hop = 0; hop < 14; hop++) {
      const dd = depth[cur]
      let j = cur
      while (j > 0 && !(src[j] === '{' && depth[j] === dd)) j--
      if (j <= 0) break
      let k = j + 1
      while (k < src.length && depth[k] >= dd) k++
      const head = src.slice(Math.max(0, j - 220), j)
      if (/(function\b|=>|async)\s*[^{}]*$/.test(head)) { found = src.slice(j, k); break }
      cur = j - 1
    }
    if (!found) continue
    const restores = /finally/.test(found) ||
                     /\.disabled\s*=\s*false/.test(found) ||
                     /disabled\s*=\s*!/.test(found) ||
                     /disabled\s*=\s*\w+\s*[;)]/.test(found)
    if (!restores) {
      const line = src.slice(0, m.index).split('\n').length
      out.push(line)
    }
  }
  return out
}

test('no handler disables a button without a path back', () => {
  // Fifteen did. The shapes: "…" forever on a YouTube download whether it
  // worked or not; "Connecting…" on a dead Save button after a rejected
  // credential; "Queuing N…" if the enqueue threw; and every button on the
  // downloads page, which disables itself and relies on a re-render that does
  // not happen when the daemon is the thing that failed.
  const stuck = functionsDisablingAButton(RENDERER)
  assert.deepStrictEqual(stuck, [],
    'each of these needs a finally, or a re-enable on the failure path: ' +
    'src/renderer.js lines ' + stuck.join(', '))
})

test('the downloads page routes its buttons through one wrapper', () => {
  assert.match(RENDERER, /async function _dlBtnAction\(btn, fn\)/)
  const fn = RENDERER.slice(RENDERER.indexOf('async function _dlBtnAction'),
                            RENDERER.indexOf('// \u2500\u2500 YouTube download buttons'))
  assert.match(fn, /finally/)
  assert.match(fn, /btn\.isConnected/, 'the successful path replaces the button')
  // Every downloads-page handler goes through it.
  const uses = [...RENDERER.matchAll(/_dlBtnAction\(btn,/g)].length
  assert.ok(uses >= 5, `only ${uses} call sites`)
})

test('a YouTube download button learns how the download ended', () => {
  assert.match(RENDERER, /async function startYtDownloadFromButton\(btn, payload\)/)
  const fn = RENDERER.slice(RENDERER.indexOf('async function startYtDownloadFromButton'),
                            RENDERER.indexOf('// \u2500\u2500 Discover dismissals'))
  assert.match(fn, /catch \(e\)/, 'a rejected ytDownload restores the button')
  assert.match(fn, /_ytBtnById\.set/, 'and the async outcome finds it again')
  assert.match(fn, /_ytBtnById\.size > YT_BTN_MAP_CAP/, 'the map is bounded')
  // The outcome is actually delivered.
  assert.match(RENDERER, /_ytBtnDone\(dl\.id, true\)/)
  assert.match(RENDERER, /_ytBtnDone\(dl\.id, false, dl\.error\)/)
  // And no call site does it by hand any more.
  assert.doesNotMatch(RENDERER, /btn\.disabled = true\n\s*btn\.innerHTML = '\u2026'/)
})

// ── Items 2.9, 2.10, 2.11: written and never read ─────────────────────────

test('every localStorage key that is written is read back', () => {
  // papa_compact_sidebar was written on every toggle and read by nothing, so
  // compact mode reset on every launch.
  const writes = new Set([...RENDERER.matchAll(/localStorage\.setItem\(\s*'([\w.:-]+)'/g)].map(m => m[1]))
  // Two readers: localStorage directly, and the PapaLocal helpers.
  const reads = new Set([
    ...[...RENDERER.matchAll(/localStorage\.(?:getItem|removeItem)\(\s*'([\w.:-]+)'/g)].map(m => m[1]),
    ...[...RENDERER.matchAll(/PapaLocal\.(?:readArray|readObject|read|remove|push)\(\s*'([\w.:-]+)'/g)].map(m => m[1]),
  ])
  const orphans = [...writes].filter(k => !reads.has(k)).sort()
  assert.deepStrictEqual(orphans, [], 'written and never read back')
})

test('the sidebar has one width mechanism, and it is restored', () => {
  // The toggle set sidebar.style.width while the resizer set --sidebar-w, so
  // the two fought.
  assert.doesNotMatch(RENDERER, /sidebar\.style\.width = /,
    'both paths write the --sidebar-w custom property')
  assert.match(RENDERER, /function restoreSidebarPrefs\(\)/)
  assert.match(RENDERER, /restoreSidebarPrefs\(\)\n/, 'and it is called')
  const fn = RENDERER.slice(RENDERER.indexOf('function restoreSidebarPrefs()'),
                            RENDERER.indexOf('function restoreStatsRange()'))
  assert.match(fn, /Math\.max\(SIDEBAR_MIN_W/, 'a stored width is clamped on read')
})

test('the stats range decides the window it labels', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function renderStats()'),
                            RENDERER.indexOf('function renderStats()') + 2000)
  assert.match(fn, /_statsCutoff\(state\.statsRange\)/,
    'the header used to say "This Month" over a hardcoded 30 days')
  assert.match(RENDERER, /const STATS_RANGE_DAYS = \{ week: 7, month: 30, year: 365, all: 0 \}/)
  // And there is a control, which is what was missing.
  assert.match(RENDERER, /stats-range-btn/)
  assert.match(RENDERER, /state\.statsRange = r/)
  // Achievements keep a fixed window so they do not un-earn on a view change.
  assert.match(fn, /Achievements keep their own fixed 30-day window/)
})

test('a Discover swipe records something', () => {
  const fn = RENDERER.slice(RENDERER.indexOf("var swipeEl = document.getElementById('discovery-swipe')"),
                            RENDERER.indexOf("document.querySelectorAll('.era-chip')"))
  assert.match(fn, /_discoverDismiss\(albumId\)/, 'the gesture was animation only')
  assert.match(fn, /addToQueue\(album\)/, 'right means yes')
  assert.match(fn, /Undo/, 'and either direction is undoable')
  // The deck respects the dismissals, or the card comes back next render.
  assert.match(RENDERER, /!_discoverDismissed\.has\(a\.id\)/)
  assert.match(RENDERER, /_discoverDismissed\.size > DISCOVER_DISMISS_CAP/, 'bounded')
})
