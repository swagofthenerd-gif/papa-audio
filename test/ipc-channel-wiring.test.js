'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const MAIN = root('main.js')
const PRELOAD = root('preload.js')
const RENDERER = root('src/renderer.js')

const strip = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

const MAIN_CODE = strip(MAIN)

// Every channel main pushes at the renderer. Sends go through the safeSend
// helper now — webContents.send throws if the window is gone, and during the
// close race that reached only the blanket uncaughtException handler — so both
// forms are scraped: the helper's own call, and any raw one that comes back.
const sentChannels = new Set([
  ...[...MAIN_CODE.matchAll(/webContents\.send\(\s*'([^']+)'/g)].map(m => m[1]),
  ...[...MAIN_CODE.matchAll(/\bsafeSend\(\s*'([^']+)'/g)].map(m => m[1]),
])
// The allowlist in preload's `on`. A channel missing from it is silently
// unsubscribable: ipcRenderer.on is never called, with no error anywhere.
const allowlist = (() => {
  const start = PRELOAD.indexOf('const allowed = [')
  const end = PRELOAD.indexOf(']', start)
  const generic = [...PRELOAD.slice(start, end).matchAll(/'([^']+)'/g)].map(m => m[1])
  // Some channels have a dedicated subscriber instead of going through the
  // generic `on` allowlist — window-focus is one — and those are just as
  // subscribable.
  const dedicated = [...PRELOAD.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)].map(m => m[1])
  return new Set(generic.concat(dedicated))
})()

// Channels sent to a target other than the main window's renderer, or consumed
// somewhere the renderer allowlist does not govern.
const NOT_FOR_THE_RENDERER = {
  'browser-url': 'the embedded BrowserView, not the app renderer',
  'browser-title': 'the embedded BrowserView',
  'browser-loading': 'the embedded BrowserView',
  'browser-load-error': 'the embedded BrowserView',
  'browser-zoom': 'the embedded BrowserView',
}

test('every channel main sends can actually be subscribed to', () => {
  // app-recovered-from-crash was sent on every unclean restart and was not in
  // the allowlist at all, so preload's `on` silently never registered it and the
  // renderer could not have heard it however hard it tried. A crash and a
  // deliberate pause looked identical on restart because of one missing string.
  const unreachable = [...sentChannels]
    .filter(c => !allowlist.has(c) && !(c in NOT_FOR_THE_RENDERER))
  assert.deepStrictEqual(unreachable, [],
    'main sends these and preload will not let anything listen')
})

test('nothing is allowlisted that main never sends', () => {
  // Not a fault, but a dead entry is a claim that something exists.
  const unused = [...allowlist].filter(c => !sentChannels.has(c))
  // These are sent from places other than a webContents.send literal.
  const KNOWN_DYNAMIC = new Set([
    'dl-started', 'dl-progress', 'dl-complete', 'dl-cancelled', 'dl-failed',
    'media-key', 'media-playpause', 'media-next', 'media-previous', 'media-seek',
    'slsk-progress', 'slsk-user-status', 'slsk-saved-users-changed',
    'slsk-scheduler-stats', 'slskd-status-change', 'update-tray-tooltip',
    'torrent-progress', 'torrent-done', 'torrent-started',
    'yt-dl-progress', 'yt-auth-pending', 'yt-auth-done', 'do-lib-rescan',
    'browser-url', 'browser-title', 'browser-loading', 'browser-load-error', 'browser-zoom',
    'ext-cmd', 'player-event', 'library-updated', 'scan-progress',
  ])
  const surprising = unused.filter(c => !KNOWN_DYNAMIC.has(c))
  assert.deepStrictEqual(surprising, [], 'allowlisted but never sent')
})

test('every channel main sends has something that actually listens', () => {
  // Being subscribable is not the same as being subscribed. The tray menu's
  // Play/Pause/Next/Previous were allowlisted-adjacent and reachable, and still
  // did nothing, because no listener existed.
  // Listeners can live in any of the renderer scripts, not only renderer.js.
  const ALL_RENDERER = fs.readdirSync(path.join(__dirname, '..', 'src'))
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'))
    .join('\n')
  const heard = new Set([
    ...[...ALL_RENDERER.matchAll(/window\.api\.on\(\s*'([^']+)'/g)].map(m => m[1]),
    // Dedicated preload subscribers are used by name, not by channel.
    ...(/onWindowFocus\(/.test(ALL_RENDERER) ? ['window-focus'] : []),
    ...(/onAppOnlineState\(/.test(ALL_RENDERER) ? ['app-online-state'] : []),
    ...(/onSlskdStatusChange\(/.test(ALL_RENDERER) ? ['slskd-status-change'] : []),
    ...(/onSlskSchedulerStats\(/.test(ALL_RENDERER) ? ['slsk-scheduler-stats'] : []),
    ...(/onSlskUserStatus\(/.test(ALL_RENDERER) ? ['slsk-user-status'] : []),
    ...(/onSlskSavedUsersChange\(/.test(ALL_RENDERER) ? ['slsk-saved-users-changed'] : []),
    ...(/onSlskUploadActivity\(/.test(ALL_RENDERER) ? ['slsk-upload-activity'] : []),
    ...(/onSlskVerifyDone\(/.test(ALL_RENDERER) ? ['slsk-verify-done'] : []),
    // Peer messaging (roadmap #55): the renderer subscribes by the dedicated
    // preload name onSlskChatMessage, not window.api.on, so it is matched by
    // name like the other dedicated Soulseek subscribers.
    ...(/onSlskChatMessage\(/.test(ALL_RENDERER) ? ['slsk-chat-message'] : []),
    // Download progress/done/error (2026-09-14): the On-device tab subscribes
    // by the dedicated preload name, like the Soulseek subscribers above.
    ...(/onVideoDownloadEvent\(/.test(ALL_RENDERER) ? ['video-download-event'] : []),
  ])
  // Channels main sends that nothing listens for, on purpose or by history.
  // Listed rather than ignored: the point of this test is that a NEW dead
  // channel fails the build, not that the existing ones are fine.
  const DELIBERATELY_UNHANDLED = {
    'update-tray-tooltip': 'main sends it to itself for the tray; the renderer has no part in it',
    // The renderer polls get-downloads instead — 2 s on the Downloads page,
    // 20 s elsewhere — so these pushes are redundant rather than broken. They
    // are still dead code on the sending side. See STABILITY-250 item 256.
    'dl-started': 'renderer polls get-downloads instead',
    'dl-progress': 'renderer polls get-downloads instead',
    'dl-complete': 'renderer polls get-downloads instead',
    'dl-cancelled': 'renderer polls get-downloads instead',
    'dl-failed': 'renderer polls get-downloads instead',
    'slsk-progress': 'renderer polls get-downloads instead',
    'scan-progress': 'no listener; scan feedback comes from the scan handler resolving',
    'slskd-status-change': 'no listener; slskStatus is fetched on demand',
    'yt-auth-pending': 'no listener',
    'yt-auth-done': 'no listener',
    'video-event': 'preload exposes onVideoEvent; no renderer script calls it yet (Papa Video UI is a later task)',
    'video-state': 'preload exposes onVideoState; no renderer script calls it yet (Papa Video UI is a later task)',
    // preload exposes onSlskWishlistHit; the Soulseek UX rework wires the
    // renderer listener in parallel, so main + the bridge land first.
    'slsk-wishlist-hit': 'preload exposes onSlskWishlistHit; renderer listener is landing in the parallel UI work',
    // preload exposes onSlskBrowseRefreshed; the Soulseek UX rework wires the
    // renderer listener in parallel, so main + the bridge land first.
    'slsk-browse-refreshed': 'preload exposes onSlskBrowseRefreshed; renderer listener is landing in the parallel UI work',
    // preload exposes onSlskVerifyDone (roadmap #49); the Soulseek UI wiring for
    // the "verified" badge lands in the parallel Wave-2 UI work, so main + the
    // bridge land first.
    // NOTE: slsk-chat-message (roadmap #55) is NOT listed here any more — the W7
    // peer-chat UI wired the renderer listener (onSlskChatMessage, added to the
    // `heard` set above), so the channel is genuinely handled end to end.
  }
  const unheard = [...sentChannels]
    .filter(c => !heard.has(c) && !(c in NOT_FOR_THE_RENDERER) && !(c in DELIBERATELY_UNHANDLED))
  assert.deepStrictEqual(unheard, [], 'main sends these and nothing in the renderer listens')
})

test('the channels this round wired are live end to end', () => {
  const WIRED = [
    'app-recovered-from-crash',
    'media-playpause', 'media-next', 'media-previous',
    'media-seek', 'media-volume', 'media-shuffle', 'media-loop-status',
    'system-suspend', 'system-resume',
  ]
  for (const c of WIRED) {
    assert.ok(sentChannels.has(c), `main must send ${c}`)
    assert.ok(allowlist.has(c), `preload must allow ${c}`)
    assert.match(RENDERER, new RegExp(`window\\.api\\.on\\('${c}'`), `nothing listens for ${c}`)
  }
})

test('the crash-recovery channel is wired the whole way through', () => {
  assert.ok(sentChannels.has('app-recovered-from-crash'), 'main must send it')
  assert.ok(allowlist.has('app-recovered-from-crash'), 'preload must allow it')
  assert.match(RENDERER, /window\.api\.on\('app-recovered-from-crash'/,
    'and something must actually listen')
})

test('the crash-recovery notice is a notice, not a blocking prompt', () => {
  // The decided rule for the engine applies here too: never a blocking prompt,
  // never silent.
  const handler = RENDERER.slice(
    RENDERER.indexOf("window.api.on('app-recovered-from-crash'"),
    RENDERER.indexOf("window.api.on('library-updated'")
  )
  // Since M5 (one crash-restore offer, not two) the handler delegates to
  // _offerCrashRestore; the notice itself lives there. Follow the delegation
  // so the rule is checked where the pixels are painted.
  assert.match(handler, /_offerCrashRestore\(/, 'the handler must hand off to the single restore offer')
  const offerStart = RENDERER.indexOf('async function _offerCrashRestore(')
  assert.ok(offerStart > -1, '_offerCrashRestore must exist')
  const offer = RENDERER.slice(offerStart, RENDERER.indexOf('\n}\n', offerStart))
  assert.match(offer, /showSnackbar/)
  assert.doesNotMatch(handler + offer, /confirm\(|alert\(|dialog\./)
})

// ── Item 107: a renderer that missed an event could not tell ───────────────

test('every push carries a monotonic sequence per channel', () => {
  assert.match(MAIN, /const _channelSeq = new Map\(\)/)
  assert.match(MAIN, /function nextSeq\(channel\)/)
  const send = MAIN.slice(MAIN.indexOf('function safeSend('), MAIN.indexOf('function resetChannelSeq('))
  assert.match(send, /wc\.send\(channel, payload, \{ seq: nextSeq\(channel\)/,
    'the sequence must ride alongside the payload, not inside it')
})

test('a reload resets the counters instead of looking like a huge gap', () => {
  assert.match(MAIN, /function resetChannelSeq\(\)/)
  assert.match(MAIN, /did-start-loading['"]?, \(\) => resetChannelSeq\(\)/,
    'a new renderer has not missed anything; it simply was not there')
})

test('preload checks the sequence and strips it before the callback', () => {
  assert.match(PRELOAD, /function reportSeq\(channel, meta\)/)
  const on = PRELOAD.slice(PRELOAD.indexOf('  on: (channel, cb) => {'), PRELOAD.indexOf('  off: (channel)'))
  assert.match(on, /reportSeq\(channel, meta\)/)
  assert.match(on, /cb\(data\)/, 'the payload shape must not change for any existing consumer')
})

test('a gap is reported and told apart from an out-of-order event', () => {
  const fn = PRELOAD.slice(PRELOAD.indexOf('function reportSeq('), PRELOAD.indexOf("contextBridge.exposeInMainWorld('api'"))
  assert.match(fn, /missed \$\{meta\.seq - prev - 1\} event/)
  assert.match(fn, /out-of-order/)
  assert.match(fn, /_seqGaps\.length > 50/, 'the record has to be bounded')
  // The first event on a channel has no predecessor and is not a gap.
  assert.match(fn, /if \(prev === undefined\) return/)
})
