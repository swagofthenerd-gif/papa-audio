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
