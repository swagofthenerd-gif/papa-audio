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
  // Its OWN listener, by handle -- never removeAllListeners on the channel.
  assert.match(on, /ipcRenderer\.removeListener\(channel, h\)/)
  assert.ok(!/removeAllListeners/.test(on), 'the per-subscriber unsubscribe must not tear down the channel')
  // And the unsubscribe is what `on` hands back.
  assert.match(on, /return \(\) => \{[\s\S]*ipcRenderer\.removeListener\(channel, h\)/)
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

// The path comparison moved OUT of the timer and into reconcileWhatIsPlaying(),
// so that the 'trackchanged' event can call it the instant mpv changes file
// rather than the bar waiting out a poll (measured: 953 ms before, 11 ms after).
// These slice the right place now; what they assert is unchanged.
const reconcileFn = () => {
  const at = CODE.indexOf('function reconcileWhatIsPlaying() {')
  assert.ok(at > 0, 'the reconciler is missing')
  return CODE.slice(at, CODE.indexOf("audio.addEventListener('trackchanged'", at))
}
const reconcileTick = () => {
  const at = CODE.indexOf('const reconcileTimer = setInterval(')
  assert.ok(at > 0, 'the reconcile tick is missing')
  return CODE.slice(at, at + 3400)
}

test('the renderer reconciles its playback state against mpv once a second', () => {
  // Three copies exist: mpv's properties, the shim's fields, and
  // state.isPlaying. This makes the last converge on the first.
  const tick = reconcileTick()
  assert.match(tick, /state\.isPlaying !== playing/, 'the UI flag must follow mpv, not the last optimistic write')
  assert.match(tick, /Number\.isFinite\(ageMs\) && ageMs > limitMs/,
    'a frozen bar is its own signal, and only a real duration may declare one')
  // The limit is two numbers, not one: mpv's FIRST position report for a file
  // lands several seconds after the load, so waiting for it is not a stall.
  assert.match(tick, /audio\.hasReportedPosition === false \? STALE_AFTER_LOAD_MS : STALE_POSITION_MS/,
    'a cold start and a frozen track get different patience')
  assert.match(tick, /if \(audio\.engineDown\) return/, 'do not shout while the engine is already down')
  assert.match(tick, /reconcileTimer\.unref/, 'a 1s interval must not hold the process open')
  assert.match(tick, /reconcileWhatIsPlaying\(\)/, 'the poll still runs the reconcile')
  assert.match(reconcileFn(), /audio\.mpvPath/, 'compare against what mpv has open')
})

test('the reconcile is also driven by mpv, not only by the clock', () => {
  // The shim emits 'trackchanged' for exactly this, and nothing listened — so
  // every track change showed the previous song for about a second.
  assert.match(CODE, /audio\.addEventListener\('trackchanged', function \(\) \{ reconcileWhatIsPlaying\(\) \}\)/)
})

test('the reconcile does not cry wolf over streams', () => {
  // A stream is resolved to a direct URL before mpv sees it, so the paths
  // legitimately differ and comparing them would fire on every track.
  assert.match(reconcileFn(), /\^https\?/, 'streams have to be exempted')
})

test('a disagreement resyncs to mpv rather than to the queue', () => {
  const fn = reconcileFn()
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
  // unitList is the rendered unit list — merged albums by default, or folder-
  // groups in group-by-uploader mode. Same extensible cap, just named for the
  // fact that a display unit is no longer always a single folder-group.
  assert.match(CODE, /unitList\.slice\(0, _slskShowLimit\)/)
  // The count now travels through the one named-unit summary line (R5):
  // "showing 60 of 3779 albums".
  assert.match(CODE, /shown: displayList\.length,\s*total: unitList\.length,/,
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

test('the explicit resume card still forces the restore', () => {
  // The guards are about the startup timer racing the user. When the user has
  // pressed "resume where you left off", they are the user.
  const fn = RENDERER.slice(RENDERER.indexOf('async function resumeFromSavedState('),
                       RENDERER.indexOf('async function restorePlaybackState('))
  assert.match(fn, /restorePlaybackState\(\{ force: true \}\)/)
})

// The restore is run for real here, not transcribed. The version this
// replaced kept a hand-written `restore()` in the test body described as "the
// shape of the guarded function, transcribed from the source under test" — a
// copy passes forever, whatever the shipped function later does.
function liftRestore(deps) {
  const a = RENDERER.indexOf('async function restorePlaybackState(opts)')
  assert.ok(a > -1, 'restorePlaybackState must still exist')
  const b = RENDERER.indexOf('\n// \u2500\u2500 Navigation', a)
  assert.ok(b > a)
  // The one statement in playCurrentTrack that stamps the counter the restore
  // watches, taken from the real source and EXECUTED below — so bumping some
  // other variable, or not bumping at all, is caught by behaviour here rather
  // than by the spelling of a line.
  const head = RENDERER.slice(RENDERER.indexOf('function playCurrentTrack() {'))
  const bump = /^[ \t]*(?:(?:const|let|var)\s+\w+\s*=\s*\+\+\s*_playbackIntent|_playbackIntent\s*\+\+)[ \t]*$/m
    .exec(head.slice(0, 3000))
  assert.ok(bump, 'playCurrentTrack must still stamp _playbackIntent on every deliberate start')

  const names = ['state', 'window', 'audio', 'setTimeout', 'showSnackbar', 'updatePlayBtn',
    'updateNowPlaying', 'updateTrackHighlight', 'updateLikeBtn', 'syncExtension', 'renderQueuePanel']
  return new Function(...names, `
    var _playbackIntent = 0
    ${RENDERER.slice(a, b)}
    return {
      restore: restorePlaybackState,
      // What playCurrentTrack does when the listener starts something.
      startTrack: function () { ${bump[0].trim()} },
    }
  `)(...names.map(n => deps[n]))
}

// A library of one album, and a saved session pointing into it.
function restoreHarness(over = {}) {
  const tracks = [{ filePath: '/m/a1.flac' }, { filePath: '/m/a2.flac' }, { filePath: '/m/a3.flac' }]
  const album = { artist: 'Boards of Canada', artPath: '/art.jpg', name: 'Geogaddi', tracks }
  const state = Object.assign({
    queue: [], queueIndex: -1, isPlaying: false, library: [album],
    queuePanelOpen: false, shuffle: false, repeat: 'off', playbackSpeed: 1,
  }, over.state)
  const audio = { src: '', currentTime: 0 }
  const snacks = []
  const timers = []
  const asked = []
  const api = Object.assign({
    getPlaybackState: async () => { asked.push('playbackState'); return { filePath: '/m/a2.flac', position: 90 } },
    getSavedQueues: async () => { asked.push('savedQueues'); return [{ id: '_auto', tracks, index: 1 }] },
  }, over.api)
  const lifted = liftRestore({
    state, audio, window: { api },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref () {} } },
    showSnackbar: (msg) => snacks.push(msg),
    updatePlayBtn: () => {}, updateNowPlaying: () => {}, updateTrackHighlight: () => {},
    updateLikeBtn: () => {}, syncExtension: () => {}, renderQueuePanel: () => {},
  })
  return { ...lifted, state, audio, snacks, timers, asked, tracks }
}

test('a queue the listener built is never restored over', async () => {
  const h = restoreHarness({ state: { queue: [{ filePath: '/user/pick.flac' }], isPlaying: true } })
  await h.restore()
  assert.deepStrictEqual(h.asked, [], 'it does not even ask')
  assert.deepStrictEqual(h.state.queue, [{ filePath: '/user/pick.flac' }])
  assert.strictEqual(h.audio.src, '', 'the loaded track is untouched')
})

test('pressing play during the first await abandons the restore', async () => {
  // The whole point: it is a 1.2s startup timer, and the listener is faster.
  const h = restoreHarness({
    api: {
      getPlaybackState: async function () {
        h.asked.push('playbackState')
        h.startTrack()
        h.state.isPlaying = true
        h.state.queue = [{ filePath: '/user/pick.flac' }]
        return { filePath: '/m/a2.flac', position: 90 }
      },
    },
  })
  await h.restore()
  assert.deepStrictEqual(h.state.queue, [{ filePath: '/user/pick.flac' }],
    'half-restoring over a queue the listener built is worse than not restoring')
  assert.deepStrictEqual(h.asked, ['playbackState'], 'and it never went on to the saved queue')
})

test('pressing play during the second await abandons it too', async () => {
  const h = restoreHarness({
    api: {
      getSavedQueues: async function () {
        h.startTrack()
        h.state.isPlaying = true
        return [{ id: '_auto', tracks: [{ filePath: '/old/x.flac' }], index: 0 }]
      },
    },
  })
  await h.restore()
  assert.ok(!h.state._restoredFromQueue, 'the saved queue was not applied')
  assert.deepStrictEqual(h.snacks, [], 'and nothing was announced')
})

test('the deferred seek cannot move a track the listener has since chosen', async () => {
  const h = restoreHarness()
  await h.restore()
  const seek = h.timers.find(t => t.ms === 500)
  assert.ok(seek, 'the resume seek is still deferred')

  h.startTrack()
  h.state.isPlaying = true
  h.audio.currentTime = 0
  seek.fn()
  assert.strictEqual(h.audio.currentTime, 0,
    'it used to seek whatever was loaded by the time it fired')
})

test('the deferred seek will not move a different track that is now loaded', async () => {
  const h = restoreHarness()
  await h.restore()
  const seek = h.timers.find(t => t.ms === 500)
  h.audio.src = 'file:///user/something-else.flac'
  h.audio.currentTime = 0
  seek.fn()
  assert.strictEqual(h.audio.currentTime, 0)
})

test('with nothing playing, the session really is restored', async () => {
  const h = restoreHarness()
  await h.restore()
  assert.strictEqual(h.audio.src, 'file:///m/a2.flac', 'the track that was playing is loaded')
  assert.strictEqual(h.state.isPlaying, false, 'loaded, not started — the listener presses play')
  assert.strictEqual(h.state._restoredFromQueue, true)
  assert.strictEqual(h.state.queueIndex, 1)
  const seek = h.timers.find(t => t.ms === 500)
  seek.fn()
  assert.strictEqual(h.audio.currentTime, 90, 'and it picks up where it left off')
  assert.match(h.snacks[0] || '', /Previous queue restored/)
})

test('a windowed queue says which stretch of the real queue it is', async () => {
  const h = restoreHarness({
    api: { getSavedQueues: async () => [{ id: '_auto', tracks: [{ filePath: '/m/a1.flac' }, { filePath: '/m/a2.flac' }], index: 0, truncatedFrom: 400, windowFrom: 119 }] },
  })
  await h.restore()
  assert.match(h.snacks[0], /tracks 120–121 of 400/,
    'reporting the truncated count as the whole thing is a lie about what was kept')
})

test('an index saved past the end of what was kept is clamped', async () => {
  const h = restoreHarness({
    api: { getSavedQueues: async () => [{ id: '_auto', tracks: [{ filePath: '/m/a1.flac' }], index: 500 }] },
  })
  await h.restore()
  assert.strictEqual(h.state.queueIndex, 0, 'an old unclamped save must not land out of bounds')
})

test('the play modes come back with the queue they belong to', async () => {
  const h = restoreHarness({
    api: { getSavedQueues: async () => [{ id: '_auto', tracks: [{ filePath: '/m/a1.flac' }], index: 0, shuffle: true, repeat: 'one', speed: 1.5 }] },
  })
  await h.restore()
  assert.strictEqual(h.state.shuffle, true)
  assert.strictEqual(h.state.repeat, 'one')
  assert.strictEqual(h.state.playbackSpeed, 1.5)
})

test('force overrides every guard, because that is the listener asking', async () => {
  const h = restoreHarness({ state: { queue: [{ filePath: '/user/pick.flac' }], isPlaying: true } })
  await h.restore({ force: true })
  assert.strictEqual(h.state._restoredFromQueue, true, 'the resume card must actually resume')
})

test('a saved track that has left the library restores nothing', async () => {
  const h = restoreHarness({ api: { getPlaybackState: async () => ({ filePath: '/gone/deleted.flac', position: 10 }) } })
  await h.restore()
  assert.deepStrictEqual(h.state.queue, [], 'no queue invented around a file that is not there')
  assert.strictEqual(h.audio.src, '')
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
      // A ' or " string cannot contain a raw newline, so reaching one means we
      // were never in a string: a quote inside a REGEX literal opened it. That
      // really happens here — /\bartist:"([^"]+)"|…/ in _parseSearchOperators —
      // and without this the scanner stayed "inside a string" for thousands of
      // lines, stopped counting braces, and reported whichever unrelated
      // function happened to line up. Template literals may span lines, so they
      // are left alone.
      else if (c === '\n' && instr !== '`') instr = null
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

// ── Item 3.1: no native dialog may stop the renderer ───────────────────────

test('nothing calls the global alert, confirm or prompt', () => {
  // A native dialog stops the renderer's event loop dead: the progress bar
  // freezes, the 1s reconcile tick stops, the extension sync stops, the
  // downloads poll stops and player events queue up. Walk away with one open
  // and the UI is frozen until it is answered. One had been replaced with a
  // comment saying exactly this; sixteen were left.
  const lines = RENDERER.split('\n')
  const offenders = []
  // Local shadows are fine, and there are three: small dialog helpers that
  // define their own confirm() for the OK button.
  const shadows = []
  lines.forEach((line, i) => {
    if (/(?:function|var|const|let)\s+(?:confirm|alert|prompt)\b/.test(line)) shadows.push(i)
  })
  const shadowedFrom = shadows.length ? Math.min(...shadows) : Infinity
  lines.forEach((line, i) => {
    if (/^\s*(?:\/\/|\*)/.test(line)) return           // a comment about one
    if (!/(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(line)) return
    // A shadow is only credible if one was declared earlier in the file.
    if (i > shadowedFrom && /(^|[^.\w])confirm\s*\(\)/.test(line)) return
    offenders.push(`${i + 1}: ${line.trim().slice(0, 90)}`)
  })
  assert.deepStrictEqual(offenders, [],
    'use _mgConfirm, _mgPrompt, or a snackbar with an Undo')
})

test('the app has its own prompt, and it is non-blocking', () => {
  assert.match(RENDERER, /function _mgPrompt\(title, opts\)/)
  const fn = RENDERER.slice(RENDERER.indexOf('function _mgPrompt(title, opts)'),
                            RENDERER.indexOf('// Bulk delete from the Manage'))
  assert.match(fn, /onConfirm\(value\)/, 'the value comes back through a callback')
  assert.match(fn, /input\.value = initial/, 'the initial value is assigned, never interpolated')
  assert.doesNotMatch(fn, /value="\$\{/, 'user text must not be parsed as markup')
  assert.match(fn, /e\.key === 'Escape'/, 'Escape cancels, as everywhere else')
  assert.match(fn, /multiline && !\(e\.ctrlKey/, 'Enter is a newline in a textarea')
})

// ── Items 3.6 and 3.7: things that grow for the life of the session ────────

test('the scroll memory is capped', () => {
  assert.match(RENDERER, /const SCROLL_MEMORY_CAP = \d+/)
  const w = RENDERER.slice(RENDERER.indexOf('const _sk = `${state.currentPage}'),
                           RENDERER.indexOf('const _sk = `${state.currentPage}') + 500)
  assert.match(w, /_scrollMemory\.delete\(_sk\)/, 're-inserted so the key is newest')
  assert.match(w, /while \(_scrollMemory\.size > SCROLL_MEMORY_CAP\)/)
})

test('an undo expires, is capped, and says what it undid', () => {
  const push = RENDERER.slice(RENDERER.indexOf('const UNDO_WINDOW_MS'),
                              RENDERER.indexOf('// \u2500\u2500 Visibility & power management'))
  assert.match(push, /const UNDO_WINDOW_MS = \d+/)
  assert.match(push, /const UNDO_STACK_CAP = \d+/)
  assert.match(push, /now - e\.at > UNDO_WINDOW_MS/, 'entries expire with their snackbar')
  assert.match(push, /_pruneUndoStack\(\)/)
  // The reason this matters: Ctrl+Z used to revert something from an hour ago
  // without saying what.
  assert.match(push, /'Undone: ' \+ item\.label/)
  assert.match(push, /Nothing recent to undo/, 'and says so when there is nothing')
})

// ── Item 3.12: every drag must work by touch and pen, not mouse only ───────

test('no drag is built on mouse events', () => {
  // The app registered no touchstart, touchmove, touchend, pointerdown or
  // pointerup anywhere: the progress bar, volume slider, queue reorder, both
  // resizers and the Discover swipe were mouse-only, even though plain clicks
  // worked. One Pointer Events API covers mouse, touch and pen.
  //
  // A drag needs an END and a MOVE. That is the definition, so it is what gets
  // checked -- rather than a list of mousedowns judged one at a time, which
  // needs an exemption for every legitimate one and rots on the next edit.
  // A lone mousedown cannot be a drag: it is either a click alternative chosen
  // to fire before blur (browsers synthesise mousedown on tap, so those work)
  // or a non-primary-button handler, which touch does not have at all.
  const lines = RENDERER.split('\n')
  const ends = []
  const moves = []
  lines.forEach((line, i) => {
    if (/addEventListener\('mouseup'/.test(line)) ends.push(i + 1)
    // An element-level mousemove is a hover effect, which is a mouse concept
    // and correctly stays. A DOCUMENT-level one is tracking a drag.
    if (/document\.addEventListener\('mousemove'/.test(line)) moves.push(i + 1)
  })
  assert.deepStrictEqual(ends, [],
    'a mouseup listener exists only to end a drag or complete a press, and ' +
    'neither fires for touch: line(s) ' + ends.join(', '))
  assert.deepStrictEqual(moves, [],
    'a document-level mousemove tracks a drag, and also leaks a listener for ' +
    'the life of the page: line(s) ' + moves.join(', '))
})

test('the six drags all start on pointerdown', () => {
  // Named individually, because "no mouse events" would also pass if a drag
  // were deleted rather than converted.
  const anchors = [
    ['makeDraggable', "trackEl.addEventListener('pointerdown'"],
    ['the Discover swipe', "swipeEl.addEventListener('pointerdown'"],
    ['the queue reorder', "handle.addEventListener('pointerdown', e => {"],
    ['the sidebar resizer', "sidebarResizer.addEventListener('pointerdown'"],
  ]
  for (const [what, needle] of anchors) {
    assert.ok(RENDERER.includes(needle), what + ' must start on pointerdown')
  }
  // The queue-panel resizer left renderer.js: every side panel now shares
  // src/panel-resize.js, so that drag is anchored there instead.
  const PANEL = fs.readFileSync(path.join(SRC, 'panel-resize.js'), 'utf8')
  assert.match(PANEL, /grip\.addEventListener\('pointerdown'/,
    'the shared panel resizer must start on pointerdown')
  assert.match(PANEL, /setPointerCapture/)
  assert.match(PANEL, /addEventListener\('pointercancel'/)
  assert.match(PANEL, /e\.button !== 0/)
  assert.doesNotMatch(PANEL, /document\.addEventListener/)
  // makeDraggable serves both the player progress bar and the volume slider,
  // which is why five anchors cover six drags.
  const uses = [...RENDERER.matchAll(/makeDraggable\(/g)].length
  assert.ok(uses >= 4, `makeDraggable is used ${uses} times (declaration + 3 bars)`)
})

test('makeDraggable uses pointer capture, not document listeners', () => {
  const fn = RENDERER.slice(RENDERER.indexOf('function makeDraggable('),
                            RENDERER.indexOf('// \u2500\u2500 Helpers \u2500'))
  assert.match(fn, /addEventListener\('pointerdown'/)
  assert.match(fn, /setPointerCapture/, 'so a drag that ends off-screen still ends')
  assert.match(fn, /addEventListener\('pointercancel'/,
    'the OS can take a touch gesture away; without this the bar stays latched')
  assert.doesNotMatch(fn, /document\.addEventListener/)
  assert.match(fn, /e\.button !== 0/, 'right-click still opens the context menu')
})

test('every element a drag starts on disables browser touch handling', () => {
  // Without touch-action:none the browser scrolls and the pointermove events
  // the handler needs never arrive at all — so the gesture silently does
  // nothing on exactly the input method this was added for.
  const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  for (const sel of ['.progress-track', '.vol-track', '.queue-drag-handle',
                     '.sidebar-resizer', '.discovery-swipe', '.papa-pr-grip']) {
    const at = CSS.indexOf(sel + ' {')
    assert.ok(at > 0, `found ${sel}`)
    const rule = CSS.slice(at, CSS.indexOf('}', at))
    assert.match(rule, /touch-action:\s*none/, sel)
  }
  // The queue resizer used to be built in renderer.js with an inline style.
  // It is now one of the panels attached to the shared resizer, whose grab
  // strip is .papa-pr-grip above — and the Folders columns have their own
  // strip in the room's stylesheet, which needs the same property.
  const ROOM = fs.readFileSync(path.join(SRC, 'slsk-room.css'), 'utf8')
  const grip = ROOM.slice(ROOM.indexOf('.slr-col-grip{'), ROOM.indexOf('}', ROOM.indexOf('.slr-col-grip{')))
  assert.ok(grip.startsWith('.slr-col-grip{'), 'found .slr-col-grip')
  assert.match(grip, /touch-action:\s*none/, '.slr-col-grip')
})

test('the drag handle is visible where there is no hover', () => {
  // By touch there is no hover, so an opacity:0-until-hover handle is the one
  // control that starts a reorder being invisible on the only input method
  // that needs it.
  const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  assert.match(CSS, /@media \(hover: none\) \{\s*\.queue-drag-handle \{ opacity:\.6/)
})

test('the queue reorder is one implementation, called by both paths', () => {
  assert.match(RENDERER, /function reorderQueue\(srcIdx, destIdx, insertBefore\)/)
  const fn = RENDERER.slice(RENDERER.indexOf('function reorderQueue('),
                            RENDERER.indexOf('function makeDraggable('))
  // The parts that would drift if there were two copies.
  assert.match(fn, /state\.queueIndex = adjustedInsert/)
  assert.match(fn, /_pendingShuffle = null/)
  assert.match(fn, /destIdx >= state\.queue\.length/, 'both indices are range-checked')
  // Called from the native drop handler and from the touch path.
  const calls = [...RENDERER.matchAll(/reorderQueue\(/g)].length
  assert.ok(calls >= 3, `declaration plus two call sites expected, found ${calls}`)
})

test('the touch reorder finds its target by position, not by event target', () => {
  // Pointer capture means every move and the up event target the handle, so
  // the row under the finger has to be found geometrically.
  assert.match(RENDERER, /function _queueRowAt\(list, x, y\)/)
  const fn = RENDERER.slice(RENDERER.indexOf('let _touchDrag = null'),
                            RENDERER.indexOf('const playingEl = list.querySelector'))
  assert.match(fn, /_queueRowAt\(list, e\.clientX, e\.clientY\)/)
  assert.match(fn, /e\.pointerType === 'mouse'/, 'mouse keeps the native drag image')
  assert.match(fn, /pointercancel', e => endTouchDrag\(e, false\)/,
    'a cancelled gesture must change nothing')
})
