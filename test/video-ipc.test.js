'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const MAIN = root('main.js')
const PRELOAD = root('preload.js')

const strip = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

const MAIN_CODE = strip(MAIN)
const PRELOAD_CODE = strip(PRELOAD)

const HANDLERS = [
  'video-settings-get', 'video-settings-set', 'video-catalog-get',
  'video-search', 'video-detail', 'video-streams', 'video-probe',
  'video-thumb',
  'video-play', 'video-stop',
  'video-control', 'video-tracks', 'video-chapters', 'video-skip-segments',
]

const PRELOAD_METHODS = [
  'videoSettingsGet', 'videoSettingsSet', 'videoCatalogGet',
  'videoSearch', 'videoDetail', 'videoStreams', 'videoProbe',
  'videoThumb',
  'videoPlay', 'videoStop', 'videoControl', 'videoTracks',
  'videoChapters', 'videoSkipSegments', 'onVideoEvent', 'onVideoState',
]

test('every Papa Video handler is registered in main', () => {
  const registered = new Set([...MAIN_CODE.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map(m => m[1]))
  const missing = HANDLERS.filter(h => !registered.has(h))
  assert.deepStrictEqual(missing, [], 'these video handlers are not registered')
})

test('the video IPC timeout map carries generous budgets', () => {
  const tbl = MAIN.slice(MAIN.indexOf('const IPC_TIMEOUT_OVERRIDES = {'), MAIN.indexOf('const _ipcRawHandle'))
  assert.match(tbl, /'video-probe': \d+/)
  assert.match(tbl, /'video-play': \d+/)
})

test('the preload surface exposes the video methods', () => {
  const exposed = new Set([...PRELOAD_CODE.matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map(m => m[1]))
  const missing = PRELOAD_METHODS.filter(m => !exposed.has(m))
  assert.deepStrictEqual(missing, [], 'these video methods are not exposed on window.api')
})

test('tmdb apiKey is wired as a per-request getter', () => {
  assert.match(MAIN, /apiKey:\s*\(\)\s*=>\s*_videoSettings\(\)\.tmdbApiKey/)
})

test('video-thumb returns a null path rather than throwing when nothing is playing', () => {
  const start = MAIN.indexOf("ipcMain.handle('video-thumb'")
  assert.ok(start > 0, 'video-thumb handler present')
  const end = MAIN.indexOf('ipcMain.handle', start + 1)
  const handler = MAIN.slice(start, end)
  // Guarded on there being a thumbnailer at all, and it hands back { ok, path }.
  assert.match(handler, /_videoSession\.thumbnailer/)
  assert.match(handler, /path:\s*null/)
})

test('the hover thumbnailer is stood up on the stream ready path and torn down with the stream', () => {
  // Built when the streamer signals ready, using the served URL as the source.
  const readyStart = MAIN.indexOf("streamer.on('ready'")
  assert.ok(readyStart > 0)
  const readyEnd = MAIN.indexOf('onReady(url, streamer)', readyStart)
  const readyBlock = MAIN.slice(readyStart, readyEnd)
  assert.match(readyBlock, /createThumbnailer\(\{[^}]*source:\s*url/)
  // Torn down in the same teardown the streamer is, and on an engine crash.
  assert.match(MAIN, /_thumbnailerTeardown\(\)/)
  const td = MAIN.slice(MAIN.indexOf('function _thumbnailerTeardown'),
    MAIN.indexOf('function _videoTeardown'))
  assert.match(td, /_videoSession\.thumbnailer\.cleanup\(\)/)
})

test('video-settings-set invalidates video caches when the key changes', () => {
  const start = MAIN.indexOf("ipcMain.handle('video-settings-set'")
  const end = MAIN.indexOf('ipcMain.handle', start + 1)
  const handler = MAIN.slice(start, end)
  // Compared against the previous value, so CLEARING the key invalidates too.
  // The old check only fired on a truthy new key, which left every cached
  // result in place when the user removed their key.
  assert.match(handler, /next\.tmdbApiKey !== current\.tmdbApiKey/)
  assert.match(handler, /_clearVideoCaches\(\)/)
  // The ranking/filtering settings change what a cached stream list contains.
  assert.match(handler, /preferSurround !== current\.preferSurround/)
  assert.match(handler, /torrentSources !== current\.torrentSources/)
  assert.match(handler, /preferredQuality !== current\.preferredQuality/)
  assert.match(handler, /_videoStreamCache\.clear\(\)/)
})

test('_clearVideoCaches empties every video cache, including the detail caches', () => {
  const start = MAIN.indexOf('function _clearVideoCaches()')
  const body = MAIN.slice(start, MAIN.indexOf('}', start))
  for (const cache of ['_videoCatalogCache', '_videoStreamCache', '_videoDetailCache', '_videoSeasonCache']) {
    assert.match(body, new RegExp(cache + '\\.clear\\(\\)'), cache + ' is not cleared')
  }
})

test('video-event is in the preload channel allowlist', () => {
  const start = PRELOAD.indexOf('const allowed = [')
  const end = PRELOAD.indexOf(']', start)
  const allowed = PRELOAD.slice(start, end)
  assert.match(allowed, /'video-event'/, 'main sends video-event; preload must allow it')
})

// ── Wiring the previously-untested behaviours ───────────────────────────────
// These are source-shape assertions: main.js cannot be required outside
// Electron, so the guarantees are pinned against the text, the same way the
// rest of this file works.

function handlerBody(name) {
  const start = MAIN.indexOf(`ipcMain.handle('${name}'`)
  assert.ok(start > -1, `${name} handler not found`)
  const end = MAIN.indexOf('ipcMain.handle', start + 1)
  return MAIN.slice(start, end === -1 ? MAIN.length : end)
}

test('video-play tears down the previous session before starting a new one', () => {
  const body = handlerBody('video-play')
  assert.match(body, /_videoTeardown\(\)/)
  // The teardown must come before anything is spawned, or the old mpv and the
  // old torrent survive alongside the new ones.
  assert.ok(body.indexOf('_videoTeardown()') < body.indexOf('videoEngine().start'),
    'teardown must precede the new start')
})

test('_videoTeardown stops both the torrent streamer and the engine', () => {
  const start = MAIN.indexOf('function _videoTeardown()')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /_videoSession\.streamer/)
  assert.match(body, /\.stop\(\)/)
  assert.match(body, /videoEngine\(\)\.stop\(\)/)
})

test('mpv dying is reported to the renderer instead of leaving it on "Playing"', () => {
  const start = MAIN.indexOf('function _wireVideoEngine()')
  assert.ok(start > -1, 'engineDown must be wired')
  const body = MAIN.slice(start, MAIN.indexOf('\n}\n', start))
  assert.match(body, /engine\.on\('engineDown'/)
  assert.match(body, /safeSend\('video-event'/)
})

test('quitting tears the video session down', () => {
  const start = MAIN.indexOf("app.on('will-quit'")
  const body = MAIN.slice(start, MAIN.indexOf('\n})', start))
  assert.match(body, /_videoTeardown\(\)/)
})

test('play callbacks are stamped so a late torrent cannot hijack a newer play', () => {
  const body = handlerBody('video-play')
  assert.match(body, /_videoSession\.token/)
  assert.match(body, /const current = \(\) => _videoSession\.token === token/)
})

test('an empty stream list is never cached', () => {
  const body = handlerBody('video-streams')
  assert.match(body, /if \(streams\.length\) _videoStreamCache\.set/)
})

test('an empty catalog list is never cached', () => {
  const body = handlerBody('video-catalog-get')
  assert.match(body, /results\.length\) _videoCatalogCache\.set/)
})

test('the stream cache key carries the settings that change the answer', () => {
  const body = handlerBody('video-streams')
  assert.match(body, /preferSurround/)
  assert.match(body, /preferredQuality/)
  assert.match(body, /torrentSources/)
})

// YTS indexes movies only, so asking it for a TV episode was one guaranteed
// empty round-trip per click.
test('backends are chosen per media type', () => {
  const start = MAIN.indexOf('function _videoBackends(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /type === 'anime'.*nyaa\(\)/s)
  assert.match(body, /type === 'tv'.*eztv\(\)/s)
  assert.match(body, /yts\(\)/)
  assert.ok(!/type === 'tv'[^\n]*yts\(\)/.test(body), 'YTS must not be asked for TV')
})

test('the torrent-sources setting actually gates the torrent backends', () => {
  const start = MAIN.indexOf('function _videoBackends(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /settings\.torrentSources !== false/)
})

test('the preferred-quality setting is applied instead of being ignored', () => {
  assert.ok(MAIN.includes('function _applyQualityPreference('), 'quality preference must be applied')
  const body = handlerBody('video-streams')
  assert.match(body, /_applyQualityPreference\(/)
})

// The vidsrc resolver returned an embed *page* URL. mpv runs with --ytdl=no, so
// every one of those entries failed on click while sitting at the top of the list.
test('the unplayable vidsrc resolver is no longer wired into the router', () => {
  assert.ok(!/resolvers: \[createVidsrcResolver\(\)\]/.test(MAIN),
    'vidsrc must not be wired: mpv cannot play an embed page')
})

test('anime detail uses the AniList by-id field, not a text search for the id', () => {
  const start = MAIN.indexOf('async function _videoShowDetail(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /anilist\(\)\.byId\(id\)/)
  assert.ok(!/anilist\(\)\.search\(String\(id\)/.test(body),
    'searching for the numeric id opened unrelated shows')
})

// A card from the third rung is keyed `kitsu-<id>` and is neither an AniList nor
// a MAL id — the detail router must route it to Kitsu's byId, exactly parallel to
// the mal- branch, and write it through to the same outage cache.
test('a kitsu- card detail routes to Kitsu byId, parallel to the mal- branch', () => {
  const start = MAIN.indexOf('async function _videoShowDetail(')
  const body = MAIN.slice(start, MAIN.indexOf('\n  if (detail) detail = await _enrichExternalRatings', start))
  // Both fallback branches are gated on their own id shape.
  assert.match(body, /type === 'anime' && \/\^mal-\\d\+\$\/\.test\(String\(id\)\)/)
  assert.match(body, /type === 'anime' && \/\^kitsu-\\d\+\$\/\.test\(String\(id\)\)/)
  // The kitsu- branch calls Kitsu's byId and caches the result like the mal- one.
  assert.match(body, /detail = await kitsu\(\)\.byId\(id\)/)
  assert.match(body, /if \(detail\) _animeDetailCacheWrite\(`anime:\$\{id\}`, \{ detail \}\)/)
})

test('season payloads are cached separately from the show', () => {
  assert.ok(MAIN.includes('async function _videoSeasonDetail('), 'season fetches must be cached')
  const start = MAIN.indexOf('async function _videoSeasonDetail(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /_videoSeasonCache\.get/)
  assert.match(body, /_videoSeasonCache\.set/)
})

// The cached show object is shared between calls; mutating it in place meant a
// second season's episodes overwrote the first inside the cache.
test('attaching episodes copies the season list rather than mutating the cache', () => {
  const body = handlerBody('video-detail')
  assert.match(body, /detail\.seasons\.map\(/)
  assert.match(body, /\{ \.\.\.detail, seasons \}/)
})

// "Current season" is resolved at call time but the entry lives for a day, so
// the key has to carry the season or a March entry is served in April.
test('the anime season row is cached under a season-stamped key', () => {
  const body = handlerBody('video-catalog-get')
  assert.match(body, /_currentAnimeSeasonTag\(\)/)
})

test('video-streams forwards the anime title variants to the providers', () => {
  const body = handlerBody('video-streams')
  assert.match(body, /titles,/, 'the romaji title must reach the indexer')
})

// YTS only carries its own encodes, so any film it never released had no
// sources at all. The broad indexer runs alongside the specialist for every
// media type and their results are merged.
test('the broad indexer backs up the specialist for every media type', () => {
  const start = MAIN.indexOf('function _videoBackends(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  const lines = body.split('\n').filter(l => l.includes('return'))
  for (const l of lines.filter(l => l.includes('torrents ?'))) {
    assert.match(l, /apibay\(\)/, `this backend list has no broad indexer: ${l.trim()}`)
  }
})

// Preferring 1080p must not push a real 2160p release below a telesync,
// whose quality parses as "unknown".
test('cam rips stay last even through the quality preference', () => {
  const start = MAIN.indexOf('function _applyQualityPreference(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /lowQuality === true/)
  assert.match(body, /w\.fine\.concat\(a\.fine, w\.thin, a\.thin, low\)/)
})

// Reliability outranks resolution at the top (2026-09-14): a thin swarm never
// holds the top slot, whatever the preferred quality says. Behavioural — the
// function is extracted and run, not just grepped.
test('a starving 4K swarm loses the top slot to a healthy source; nothing is hidden', () => {
  const vm = require('node:vm')
  const start = MAIN.indexOf('const HEALTHY_SEEDS')
  const end = MAIN.indexOf('\n}', MAIN.indexOf('function _applyQualityPreference(')) + 2
  const ctx = { rankingSeeds: e => Number(e && e.seeds) || 0 }
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(start, end), ctx)
  const t = (q, seeds, extra) => Object.assign({ kind: 'torrent', quality: q, seeds }, extra)
  const thin4k = t('2160p', 3)
  const healthy1080 = t('1080p', 150)
  const healthy4k = t('2160p', 80)
  const dead1080 = t('1080p', 500, { deadHint: true })
  const cam = t('2160p', 999, { lowQuality: true })
  // Preference 2160p (his setting): everything is within, health decides the top.
  const out = ctx._applyQualityPreference([thin4k, healthy4k, dead1080, healthy1080, cam], '2160p')
  assert.deepStrictEqual([...out], [healthy4k, healthy1080, thin4k, dead1080, cam])
  // Preference 1080p: a healthy 4K still beats a thin 1080p, and cams stay last.
  const thin1080 = t('1080p', 2)
  const out2 = ctx._applyQualityPreference([thin1080, healthy4k, cam, healthy1080], '1080p')
  assert.deepStrictEqual([...out2], [healthy1080, healthy4k, thin1080, cam])
  // No preference set: health still leads, nothing dropped.
  const out3 = ctx._applyQualityPreference([thin4k, healthy1080], null)
  assert.deepStrictEqual([...out3], [healthy1080, thin4k])
  // Direct HTTP sources have no swarm to starve and count as healthy.
  const http = { kind: 'http', quality: '1080p', url: 'x' }
  assert.deepStrictEqual([...ctx._applyQualityPreference([thin4k, http], '2160p')], [http, thin4k])
})

// ── Phase 1: the theatre control surface ────────────────────────────────────

test('video-control dispatches the §4.1 verbs onto the engine', () => {
  const body = handlerBody('video-control')
  for (const verb of ['seek', 'pause', 'play', 'volume', 'mute', 'speed', 'track',
                      'subAdd', 'subDelay', 'audioDelay', 'subStyle', 'aspect',
                      'zoom', 'audioFilter', 'screenshot', 'frameStep', 'stop']) {
    assert.match(body, new RegExp(`case '${verb}'`), `missing the ${verb} verb`)
  }
  assert.match(body, /Unknown video verb/, 'an unknown verb must be reported, not ignored')
  assert.match(body, /videoEngine\(\)/, 'the verbs must land on the video engine')
})

test('the screenshot verb returns a path in the value field', () => {
  const body = handlerBody('video-control')
  assert.match(body, /case 'screenshot'/)
  assert.match(body, /_videoScreenshotPath\(\)/)
  assert.match(body, /value: \{ path: filePath \}/)
})

test('_videoScreenshotPath writes to the pictures folder and does not clobber', () => {
  const start = MAIN.indexOf('function _videoScreenshotPath()')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  // Somewhere a person will actually find them (App #48), with USER_DATA as the
  // headless / locked-down fallback so the verb never fails for want of a dir.
  assert.match(body, /app\.getPath\('pictures'\), 'Papa Audio'/)
  assert.match(body, /path\.join\(USER_DATA, 'screenshots'\)/, 'the fallback must still exist')
  assert.match(body, /toISOString\(\)/, 'a timestamp keeps one screenshot from clobbering the next')
})

test('video-tracks and video-chapters return their payloads and degrade on failure', () => {
  const tracks = handlerBody('video-tracks')
  assert.match(tracks, /getTracks\(\)/)
  assert.match(tracks, /ok: true, tracks/)
  assert.match(tracks, /ok: false[^\n]*tracks: \[\]/, 'a failed read still returns an empty list, not an exception')
  const chapters = handlerBody('video-chapters')
  assert.match(chapters, /getChapters\(\)/)
  assert.match(chapters, /ok: true, chapters/)
})

test('video-skip-segments merges every cheap layer', () => {
  const body = handlerBody('video-skip-segments')
  assert.match(body, /classifyChapters\(chapters/, 'layer 1: chapters in the file')
  assert.match(body, /aniskip\(\)\(/, 'layer 2: AniSkip for anime')
  assert.match(body, /req\.manual/, 'layer 4: the user\u2019s own corrections')
  assert.match(body, /creditsFallback\(duration\)/, 'layer 4: tail-of-file credits guess')
  // V045: every layer is checked against the file's length before the merge.
  assert.match(body, /const checked = sources\.map\(src => validateSegments\(src, duration\)\)/)
  assert.match(body, /mergeSegments\(checked\)/)
})

// A skip service must never be able to stop playback.
test('every skip layer fails soft', () => {
  const body = handlerBody('video-skip-segments')
  assert.match(body, /catch \(_\)/, 'a file with no chapters is the common case, not an error')
  assert.match(body, /return \{ ok: false[^}]*segments: \[\] \}/s)
})

// An empty AniSkip answer usually means the service was briefly unreachable;
// caching it would hide real segments for the whole TTL.
test('only a real AniSkip answer is cached', () => {
  const body = handlerBody('video-skip-segments')
  assert.match(body, /if \(segs\.length\) _aniskipCache\.set/)
})

// Layer 3 decodes five minutes of two episodes with ffmpeg. It must never be
// something playback waits on.
test('cross-episode intro detection is a separate, cancellable call', () => {
  const body = handlerBody('video-detect-intro')
  assert.match(body, /_introDetectAbort/)
  assert.match(body, /abort\(\)/, 'a new request must cancel the run in flight')
  assert.match(body, /signal: controller\.signal/)
  assert.ok(!/detectIntro/.test(handlerBody('video-skip-segments')),
    'layer 3 must not run inline with the cheap layers')
})

test('detect-intro is reachable from the renderer', () => {
  assert.match(PRELOAD, /videoDetectIntro:/)
})

// skip/, subtitles/ and trakt/ are required at startup; without them in the
// build globs a packaged app crashes before it opens a window.
test('the new module directories are in the packaged build', () => {
  const pkg = require('../package.json')
  for (const glob of ['skip/**', 'subtitles/**', 'trakt/**']) {
    assert.ok(pkg.build.files.includes(glob), `${glob} is missing from build.files`)
  }
})

test('the throttled state stream is pushed on video-state', () => {
  const start = MAIN.indexOf('function _wireVideoEngine()')
  const body = MAIN.slice(start, MAIN.indexOf('\n}\n', start))
  assert.match(body, /engine\.on\('state'/)
  assert.match(body, /safeSend\('video-state'/)
})

test('video-state is in the preload channel allowlist', () => {
  const start = PRELOAD.indexOf('const allowed = [')
  const end = PRELOAD.indexOf(']', start)
  const allowed = PRELOAD.slice(start, end)
  assert.match(allowed, /'video-state'/, 'main sends video-state; preload must allow it')
})

test('the preload surface exposes onVideoState and returns an unsubscribe fn', () => {
  assert.match(PRELOAD, /onVideoState: \(cb\) =>/)
  const at = PRELOAD.indexOf('onVideoState:')
  const line = PRELOAD.slice(at, PRELOAD.indexOf('\n', at))
  assert.match(line, /removeListener\('video-state', h\)/, 'the unsubscribe must remove only its own listener')
})

// The old `embed: 'window'` setting predates the theatre. With a separate mpv
// window the deck, the skip offer and the Up Next card all sit behind the
// video attached to nothing — which is exactly the bug this removes. A stored
// value must not be able to bring that back.
// One window. mpv draws into a frameless child surface inside Papa Audio's own
// content area, which carries no decorations and no taskbar or alt-tab entry.
test('the video is embedded in the app window', () => {
  const body = handlerBody('video-play')
  assert.match(body, /const wid = _videoWid\(\)/)
  assert.match(body, /if \(wid\) _showVideoWindow\(\)/)
  const code = body.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  assert.ok(!/_videoSettings\(\)\.embed/.test(code), 'no setting may gate this')
})

// Where no window id can be obtained mpv opens its own window. That is a
// fallback, not a choice, and it must say so rather than degrade silently.
test('a failed embed is reported', () => {
  assert.match(handlerBody('video-play'), /no X11 window id/)
})

// The surface is a native child window: hiding the HTML behind it does not
// hide it, so minimising would leave the video sitting over the app.
test('the surface can be hidden without stopping playback', () => {
  const body = handlerBody('video-surface-visible')
  assert.match(body, /win\.hide\(\)/)
  assert.match(body, /win\.showInactive\(\)/)
  assert.match(body, /_positionVideoWindow\(_videoSession\.bounds\)/)
  assert.ok(!/videoEngine\(\)\.stop|streamer/.test(body), 'hiding must not touch playback')
})

test('minimising hides the surface and restoring brings it back', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
  const min = src.slice(src.indexOf('function minimise()'), src.indexOf('function restore()'))
  assert.match(min, /setSurfaceVisible\(false\)/)
  const res = src.slice(src.indexOf('function restore()'), src.indexOf('function setSurfaceVisible'))
  assert.match(res, /setSurfaceVisible\(true\)/)
  // The stage has to have its size back before the surface is placed on it.
  assert.match(res, /ready\(\)\.then/)
})

// The deck is in another window and cannot see keys pressed over the video.
test('app actions pressed in the video window are relayed back', () => {
  const start = MAIN.indexOf('function _wireVideoEngine()')
  const body = MAIN.slice(start, MAIN.indexOf('\n}\n', start))
  assert.match(body, /engine\.on\('appKey'/)
  assert.match(body, /kind: 'key'/)
})

// Fullscreening mpv would cover the deck and leave the viewer with a picture
// they cannot pause, skip or advance.
test('fullscreen expands the app, never the video window', () => {
  const body = handlerBody('video-fullscreen')
  assert.match(body, /mainWindow\.setFullScreen\(want\)/)
  assert.ok(!/_videoWindow\(\)\.setFullScreen|win\.setFullScreen/.test(body),
    'the mpv window must never be fullscreened on its own')
})

// The mpv window is a child of the main window but does not move with it, so
// dragging the app to another monitor would otherwise leave the video behind.
test('the video window follows the app when it moves, resizes or fullscreens', () => {
  const start = MAIN.indexOf('function _rebindVideoFollow()')
  assert.ok(start > -1, 'the follow handlers must exist')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  for (const ev of ['move', 'resize', 'enter-full-screen', 'leave-full-screen']) {
    assert.match(body, new RegExp("on\\('" + ev + "'"), 'not following ' + ev)
  }
  assert.match(MAIN, /_rebindVideoFollow\(\)/)
})

// Without a reported rectangle the window would be shown at its creation size,
// floating over the app — which is the separate-window bug.
test('a missing stage rectangle falls back to a derived one', () => {
  const start = MAIN.indexOf('function _fallbackStageBounds()')
  assert.ok(start > -1, 'there must be a fallback rectangle')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /getContentBounds\(\)/)
  const showStart = MAIN.indexOf('function _showVideoWindow()')
  const show = MAIN.slice(showStart, showStart + 700)
  assert.match(show, /_videoSession\.bounds \|\| _fallbackStageBounds\(\)/)
  assert.match(show, /_positionVideoWindow\(rect\)/)
})

test('playback waits for the stage rectangle before starting', () => {
  const RENDERER = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const at = RENDERER.indexOf('function _videoPlayResult(')
  assert.ok(at > -1)
  // The window is generous: the open() payload has grown prefs and callbacks,
  // the Wave-4 per-show track-memory feature-detect (#31/#32), and now the
  // watch identity + hedge alternates + rewatch-cache probe (2026-09-14). The
  // point is the ORDER of ready vs play, not the function's size.
  const body = RENDERER.slice(at, at + 16000)
  const ready = body.indexOf('_player.ready')
  const play = body.indexOf('api.videoPlay')
  assert.ok(ready > -1, 'the stage rectangle must be reported before playback')
  assert.ok(play > -1)
  assert.ok(ready < play, 'showing the video window before its rectangle is known makes it float over the app')
})

// ── Trailers ────────────────────────────────────────────────────────────────
// resolveYtUrl was written for music, where bestaudio is exactly right. A
// trailer resolved that way plays with no picture at all.
test('trailers resolve as video, not audio', () => {
  assert.match(MAIN, /const YT_FORMATS = \{/)
  const start = MAIN.indexOf('const YT_FORMATS = {')
  const table = MAIN.slice(start, MAIN.indexOf('}', start))
  assert.match(table, /audio: 'bestaudio'/)
  assert.match(table, /video: 'best\[height<=1080\]/)
  assert.match(handlerBody('video-trailer'), /resolveTrailerStream\(youtubeId\)/)
  assert.match(MAIN.slice(MAIN.indexOf('async function resolveTrailerStream('), MAIN.indexOf('function extractVideoId(')), /resolveYtUrl\(videoId, 'video'\)/, 'the muxed file is still tried first')
})

// The same id resolves to a different URL for audio and for video; serving one
// for the other is exactly what the key must prevent.
test('the YouTube URL cache is keyed per format', () => {
  const start = MAIN.indexOf('function resolveYtUrl(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /const cacheKey = kind === 'audio' \? videoId : `\$\{kind\}:\$\{videoId\}`/)
  assert.match(body, /_ytUrlCache\.get\(cacheKey\)/)
  assert.match(body, /_ytUrlCache\.set\(cacheKey/)
})

// A trailer is not the thing you were watching.
test('playing a trailer is a separate path from playing a title', () => {
  const body = handlerBody('video-trailer')
  assert.match(body, /_videoTeardown\(\)/, 'whatever was playing must stop')
  assert.ok(!/setPosition|markWatched/.test(body), 'a trailer must not touch watch state')
  assert.match(body, /_videoSession\.token/, 'a late resolve must not hijack a newer play')
})

test('a title with no trailer is refused rather than played as nothing', () => {
  assert.match(handlerBody('video-trailer'), /if \(!youtubeId\) return \{ ok: false/)
})

test('the trailer channel is reachable from the renderer', () => {
  assert.match(PRELOAD, /videoTrailer:/)
})

// ── Season pack episode switching ───────────────────────────────────────────
// The pack already holds every episode, so switching is a file change on a
// torrent that is already running rather than a fresh search.
test('the pack contents are announced once playback starts', () => {
  const body = handlerBody('video-play')
  assert.match(body, /streamer\.files\(\)/)
  assert.match(body, /kind: 'pack', files/)
  // One file is not a pack, and a strip of one is noise.
  assert.match(body, /files\.length > 1/)
})

test('switching episode reuses the running torrent', () => {
  const body = handlerBody('video-pack-select')
  assert.match(body, /streamer\.selectFile\(Number\(index\)\)/)
  assert.match(body, /videoEngine\(\)\.load\(url\)/, 'the player is pointed at the new file')
  assert.ok(!/streamer\.start|new TorrentStreamer/.test(body),
    'a switch must not start a second torrent')
})

test('switching with nothing streaming is refused', () => {
  const body = handlerBody('video-pack-select')
  assert.match(body, /if \(!streamer\) return \{ ok: false/)
})

test('the pack channel is reachable from the renderer', () => {
  assert.match(PRELOAD, /videoPackSelect:/)
})

// ── Anime opened from search ────────────────────────────────────────────────
// TMDB files anime as tv, so a searched anime landed on the tv entry and got
// the TV indexer's sources — nearly none. The entry point must not decide the
// quality of the source list.
test('a TMDB anime is enriched with AniList titles', () => {
  assert.match(MAIN, /async function _enrichAnimeDetail\(detail\)/)
  const start = MAIN.indexOf('async function _enrichAnimeDetail(')
  const body = MAIN.slice(start, MAIN.indexOf('\nfunction _titlesOverlap', start))
  // The original Japanese name matches AniList more reliably than the English.
  assert.match(body, /detail\.originalName, detail\.title/)
  assert.match(body, /titles: match\.titles/)
  assert.match(body, /idMal: match\.idMal/, 'the skip service is keyed on the MAL id')
  assert.match(body, /catch \(_\)/, 'enrichment must never be fatal')
})

// AniList search is fuzzy; the wrong show's romaji title would send the source
// lookup somewhere unrelated.
test('an AniList match is only trusted when a title corresponds', () => {
  assert.match(MAIN, /function _titlesOverlap\(a, b\)/)
  const start = MAIN.indexOf('function _titlesOverlap(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /romaji/)
  assert.match(body, /native/)
})

test('sources are routed by what the show is, not where it was opened', () => {
  const body = handlerBody('video-streams')
  assert.match(body, /const sourceType = \(req\.isAnime === true && type !== 'anime'\) \? 'anime' : type/)
  assert.match(body, /_videoBackends\(sourceType, settings\)/)
})

test('the renderer tells main when a tv entry is anime', () => {
  const RENDERER = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const at = RENDERER.indexOf('function _videoStreamRequest(')
  const body = RENDERER.slice(at, at + 1400)
  assert.match(body, /isAnime: d\.isAnime === true/)
  assert.match(body, /titles: d\.titles \|\| null/)
})

// ── Merged search ───────────────────────────────────────────────────────────
// Searching only TMDB returned a tv entry for an anime and no AniList entry at
// all, so there was never a good result to click: that entry sent the source
// lookup to the TV indexer, which found nothing for Frieren against nyaa's 22.
test('an unfiltered search asks both catalogs', () => {
  const body = handlerBody('video-search')
  assert.match(body, /Promise\.all\(\[/)
  assert.match(body, /tmdb\(\)\.search\(query\)/)
  assert.match(body, /_animeSearch\(query\)/)
})

// A dead catalog should still return the other one's results.
test('neither catalog can fail the whole search', () => {
  const body = handlerBody('video-search')
  assert.match(body, /tmdb\(\)\.search\(query\)\.catch\(\(\) => \[\]\)/)
  assert.match(body, /_animeSearch\(query\)\.catch\(\(\) => \[\]\)/)
})

// ── AniList outage fallback (2026-09) ───────────────────────────────────────
// The shelves fell through to Jikan during the outage but search never did, so
// "tokyo revengers" found nothing while AniList was dark. The fallback is
// outage-gated: a healthy empty answer from AniList must not spend a
// rate-limited Jikan request.
test('anime search falls through to Jikan only when AniList flags an outage', () => {
  const start = MAIN.indexOf('async function _animeSearch(')
  assert.ok(start > -1)
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /if \(viaAnilist\.length \|\| !anilist\(\)\.lastFailure\(\)\) return viaAnilist/)
  assert.match(body, /const viaJikan = await jikan\(\)\.search\(query\)/)
})

// The third rung: Jikan also coming back empty AND flagging an outage falls
// through to Kitsu. Same outage-gating principle — a healthy empty answer at the
// Jikan rung stops the chain rather than spending a Kitsu request.
test('anime search falls through to Kitsu only when Jikan also flags an outage', () => {
  const start = MAIN.indexOf('async function _animeSearch(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /if \(viaJikan\.length \|\| !jikan\(\)\.lastFailure\(\)\) return viaJikan/)
  assert.match(body, /return kitsu\(\)\.search\(query\)/)
})

// Nothing found while ALL THREE databases are flagged down is an outage, not a
// miss — the renderer's error panel must say so instead of "no results".
test('an anime search with all three databases down reports the outage', () => {
  const body = handlerBody('video-search')
  assert.match(body, /anilist\(\)\.lastFailure\(\) && jikan\(\)\.lastFailure\(\) && kitsu\(\)\.lastFailure\(\)/)
  assert.match(body, /return \{ ok: false, error: 'The anime databases are unreachable right now/)
  assert.match(body, /AniList, MyAnimeList and Kitsu all failed to answer/)
})

test('a tv entry that is really anime is dropped when AniList has it too', () => {
  const body = handlerBody('video-search')
  assert.match(body, /if \(r\.isAnime && animeRes\.some\(a => _sameShow\(a, r\)\)\) continue/)
})

// The English, romaji and original names rarely agree across the two
// catalogs, so every title each side knows has to be compared.
test('the duplicate test compares every title both catalogs know', () => {
  const start = MAIN.indexOf('function _sameShow(')
  assert.ok(start > -1)
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /t\.romaji, t\.english, t\.native/)
  assert.match(body, /tmdbEntry\.title, tmdbEntry\.originalName/)
  // An entry with no usable title must not match everything.
  assert.match(body, /if \(!left\.length \|\| !right\.length\) return false/)
})

// A single-catalog search must stay single-catalog.
test('a filtered search does not merge', () => {
  const body = handlerBody('video-search')
  assert.match(body, /if \(type === 'anime'\) \{\s*\n\s*const results = await _animeSearch\(query\)/)
  assert.match(body, /if \(type === 'movie' \|\| type === 'tv'\)/)
})

// nyaa refuses anything whose type is not 'anime', so routing to it while the
// request still said 'tv' or 'movie' would have returned nothing at all — the
// backend choice alone was not enough.
test('anime routing rewrites the request type, not just the backends', () => {
  const body = handlerBody('video-streams')
  assert.match(body, /const sourceType = \(req\.isAnime === true && type !== 'anime'\) \? 'anime' : type/)
  assert.match(body, /const request = \{\s*\n?\s*type: sourceType/)
  assert.match(body, /_videoBackends\(sourceType, settings\)/)
})

// Films as well as series: this was the reported case.
test('an anime film is routed to the anime indexer', () => {
  const body = handlerBody('video-streams')
  assert.ok(!/type === 'tv' && req\.isAnime/.test(body),
    'restricting the check to television left anime films on the film indexers')
})

test('the renderer flags anime films as well as series', () => {
  const RENDERER = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const at = RENDERER.indexOf('function _videoStreamRequest(')
  const body = RENDERER.slice(at, at + 1800)
  // Both branches must send it.
  assert.strictEqual((body.match(/isAnime: d\.isAnime === true/g) || []).length, 2)
})

// ── Stage geometry ─────────────────────────────────────────────────────────
// The renderer measures the stage in CSS pixels; setBounds takes DIP. They are
// equal only at zoom 1, and this app runs at 0.9128 — so unconverted, a stage
// 2472 CSS px wide became 2472 DIP inside a 2256 DIP window and the video
// covered the whole app, controls included, with no way back. These numbers
// are the ones measured from the running app.
function geometry({ zoom = 1, content = { x: 1916, y: 0, width: 2256, height: 1224 } } = {}) {
  const vm = require('vm')
  const src = [_fn('_cssToDip'), _fn('_positionVideoWindow')].join('\n')
  const applied = []
  const ctx = {
    mainWindow: {
      isDestroyed: () => false,
      getContentBounds: () => content,
      webContents: { getZoomFactor: () => zoom },
    },
    _videoWindow: () => ({ isDestroyed: () => false, setBounds: b => applied.push(b) }),
    Number, Math,
  }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  return {
    place: rect => { ctx._positionVideoWindow(ctx._cssToDip(rect)); return applied[applied.length - 1] },
    toDip: rect => ctx._cssToDip(rect),
  }
}
function _fn(name) {
  const at = MAIN.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`${name} not found in main.js`)
  let depth = 0, i = MAIN.indexOf('{', at)
  for (let k = i; ; k++) {
    if (MAIN[k] === '{') depth++
    else if (MAIN[k] === '}') { depth--; if (depth === 0) return MAIN.slice(at, k + 1) }
  }
}

test('a CSS-pixel stage is converted to DIP by the zoom factor', () => {
  const g = geometry({ zoom: 0.9128709291752769 })
  const r = g.toDip({ x: 0, y: 75, width: 2472, height: 1179 })
  assert.ok(Math.abs(r.width - 2256.6) < 1, 'width should land on the window width, got ' + r.width)
  assert.ok(Math.abs(r.y - 68.5) < 1, 'y should scale too, got ' + r.y)
})

test('at zoom 1 the rectangle is unchanged', () => {
  const r = geometry({ zoom: 1 }).toDip({ x: 10, y: 20, width: 300, height: 200 })
  assert.deepStrictEqual(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    { x: 10, y: 20, width: 300, height: 200 })
})

test('the real measured stage no longer covers the whole app', () => {
  const b = geometry({ zoom: 0.9128709291752769 }).place({ x: 0, y: 75, width: 2472, height: 1179 })
  assert.ok(b.height < 1224, 'the video must not fill the window height, got ' + b.height)
  assert.ok(b.y + b.height <= 1224, 'it must leave the deck on screen')
  assert.ok(b.width <= 2256, 'it must not be wider than the app, got ' + b.width)
})

// However wrong an incoming rectangle is, the video must never grow past the
// app and swallow the controls with it.
test('an oversized rectangle is clamped to the content area', () => {
  const b = geometry({ zoom: 1 }).place({ x: 0, y: 0, width: 99999, height: 99999 })
  assert.strictEqual(b.width, 2256)
  assert.strictEqual(b.height, 1224)
})

test('a negative offset cannot push the surface off the window', () => {
  const b = geometry({ zoom: 1 }).place({ x: -500, y: -500, width: 400, height: 300 })
  assert.strictEqual(b.x, 1916)
  assert.strictEqual(b.y, 0)
})

// ── Control arguments ──────────────────────────────────────────────────────
// The player sends every single-argument verb as `value`. main used to read a
// different name for each one — args.volume, args.muted, args.speed — so they
// all arrived undefined and did nothing: the volume slider, the mute button,
// the speed menu, the zoom and the night filter were all dead, while play,
// pause and seek worked because they happened to agree. Nothing surfaced it,
// because a control that silently does nothing throws no error.
//
// This walks every send() in the player and checks main reads a name the
// player actually sends, so the whole class cannot come back.
test('main reads the argument names the player actually sends', () => {
  const player = root('src/video-player.js')
  const handler = MAIN.slice(MAIN.indexOf("ipcMain.handle('video-control'"), MAIN.indexOf("ipcMain.handle('video-control'") + 2600)

  const sends = new Map()
  for (const m of player.matchAll(/send\('([a-zA-Z]+)'(?:,\s*\{([^}]*)\})?\)/g)) {
    const keys = (m[2] || '').split(',').map(s => s.split(':')[0].trim()).filter(Boolean)
    const prev = sends.get(m[1]) || new Set()
    for (const k of keys) prev.add(k)
    sends.set(m[1], prev)
  }
  assert.ok(sends.size > 8, 'the player should send many verbs, found ' + sends.size)

  const broken = []
  for (const [verb, keys] of sends) {
    if (!keys.size) continue
    const line = new RegExp(`case '${verb}':([\\s\\S]*?)break`).exec(handler)
    if (!line) continue
    const reads = [...line[1].matchAll(/args\?\.([a-zA-Z]+)/g)].map(m => m[1])
    if (!reads.length) continue
    if (!reads.some(r => keys.has(r))) {
      broken.push(`${verb}: player sends {${[...keys]}}, main reads {${reads}}`)
    }
  }
  assert.deepStrictEqual(broken, [], 'these controls silently do nothing')
})

// With an opaque background Chromium repaints the host window on every resize,
// and that paint lands on top of mpv's output: the picture goes black and never
// returns. Resizing the app did it; so did going fullscreen, which is a resize.
// Measured with everything else identical — opaque: 34525 colours before the
// resize and 1 after; transparent: 34567 before and 54863 after. Not a renderer
// problem: every mpv backend broke on an opaque host and none broke on a
// transparent one.
test('the video host window is transparent so a resize cannot black it out', () => {
  const fn = MAIN.slice(MAIN.indexOf('function _videoWindow()'), MAIN.indexOf('function _videoWid()'))
  assert.match(fn, /transparent:\s*true/)
  assert.match(fn, /backgroundColor:\s*'#00000000'/)
  assert.ok(!/backgroundColor:\s*'#000000'/.test(fn), 'an opaque background is the bug')
})

// ── The second opinion ─────────────────────────────────────────────────────
// One score averaged from one site's users is a thin basis for choosing what to
// watch; IMDb, Rotten Tomatoes and Metacritic disagree about the same film and
// the disagreement is the useful part.
test('the detail is enriched with outside ratings', () => {
  assert.match(MAIN, /async function _enrichExternalRatings\(detail\)/)
  const fn = MAIN.slice(MAIN.indexOf('async function _enrichExternalRatings'),
    MAIN.indexOf('async function _enrichExternalRatings') + 900)
  // TMDB has no IMDb id for a long tail of titles, so a title fallback is the
  // difference between "most films" and "the ones everyone has heard of".
  assert.match(fn, /byImdbId\(detail\.imdbId\)/)
  // The title fallback now carries OMDb's type and is gated by year (R10):
  // a junk entry with no year used to wear the real show's rating.
  assert.match(fn, /byTitle\(detail\.title, detail\.year, omdbTypeFor\(detail\.type\)\)/)
  // A missing key, a missing id or a failed request must leave the detail
  // exactly as it was — this is extra information, never a dependency.
  assert.match(fn, /if \(!external\) return detail/)
  assert.match(fn, /catch \(_\) \{\s*return detail/)
})

test('the enrichment runs inside the cached detail path, not per request', () => {
  const fn = MAIN.slice(MAIN.indexOf('async function _videoShowDetail'),
    MAIN.indexOf('async function _enrichExternalRatings'))
  const enrichAt = fn.indexOf('_enrichExternalRatings(detail)')
  const cacheAt = fn.indexOf('_videoDetailCache.set(key, detail)')
  assert.ok(enrichAt > 0 && cacheAt > enrichAt, 'enrich before caching, or every open re-fetches it')
})

// A free service with a daily limit, read once per card on a shelf of twenty.
test('outside ratings are cached for a long time', () => {
  assert.match(MAIN, /_omdbCache = makeCache\(\{ cap: \d+, ttlMs: [^}]*24 \}\)/)
  assert.match(MAIN, /cache: _omdbCache/)
})

// The key belongs to the user and must never be committed.
test('the second-opinion key is a setting, never a literal', () => {
  assert.match(MAIN, /omdbApiKey: ''/)
  assert.match(MAIN, /_videoSettings\(\)\.omdbApiKey \|\| process\.env\.OMDB_API_KEY/)
  assert.ok(!/c2ec71cf/.test(MAIN), 'no key may appear in the source')
})

// ── Card enrichment ────────────────────────────────────────────────────────
// A shelf listing gives a title, a year, a poster and a score. Director,
// runtime, certificate and the outside ratings each cost a request, so this
// exists to be called only for what is actually on screen.
test('the card enrichment handler returns a narrow payload', () => {
  const body = handlerBody('video-enrich')
  // A card does not need the overview, the cast, the keywords or the artwork,
  // and sending them would make every one of twenty responses far larger than
  // it has to be.
  for (const field of ['overview', 'cast', 'keywords', 'backdrop', 'similar']) {
    assert.ok(!new RegExp('\\b' + field + ':').test(body), field + ' has no business on a card')
  }
  for (const field of ['directors', 'runtime', 'certification', 'imdb', 'rottenTomatoes', 'metacritic']) {
    assert.ok(new RegExp('\\b' + field + ':').test(body), field + ' is what the card is for')
  }
})

// The catalogue returns each director as a credit record with an id, a job and
// a portrait. A card wants two words, and sending the object renders as
// "[object Object]" — which is exactly what the first probe of this printed.
test('directors reach the card as names', () => {
  const body = handlerBody('video-enrich')
  assert.match(body, /typeof d === 'string' \? d : d && d\.name/)
  assert.match(body, /\.slice\(0, 2\)/, 'a card has room for two, not for an ensemble')
})

// It shares the detail cache, so a card that has already been opened costs
// nothing, and opening a card the shelf enriched costs nothing either.
test('enrichment goes through the cached detail path', () => {
  assert.match(handlerBody('video-enrich'), /_videoShowDetail\(type, id\)/)
})

// A jump is only useful to the swarm if something tells it. The head is
// prioritised once when a stream starts and never again.
test('seeking tells the torrent where the viewer went', () => {
  const body = handlerBody('video-control')
  assert.match(body, /_prioritiseStreamAtPlayhead\(\)/)
  const fn = MAIN.slice(MAIN.indexOf('function _prioritiseStreamAtPlayhead'),
    MAIN.indexOf('function _videoTeardown'))
  // Read after the seek, not computed from the request: a relative seek, a
  // chapter jump and a click on the bar all arrive differently, and mpv has
  // already resolved every one of them into a single position.
  assert.match(fn, /state\.position/)
  assert.match(fn, /state\.duration/)
  assert.match(fn, /seekToFraction\(position \/ duration\)/)
  assert.match(fn, /if \(duration <= 0\) return/, 'a fraction of nothing is not a position')
  assert.match(fn, /catch \(_\)/, 'a failed optimisation must not fail the seek')
})

// ── Wave 5: shared stream start, mid-play source switch ─────────────────────
// The torrent-streamer setup was copied into a second handler once and drifted;
// it now lives in one helper both video-play and video-switch-stream call, so
// the streamer options and the token guard cannot fall out of step.
test('the torrent-streamer setup lives in one shared helper', () => {
  assert.ok(MAIN.includes('function _startTorrentStream('), 'the shared helper must exist')
  // A destructured param list defeats the brace-matcher, so slice by text: from
  // the helper up to the video-play handler that follows it.
  const at = MAIN.indexOf('function _startTorrentStream(')
  const body = MAIN.slice(at, MAIN.indexOf("ipcMain.handle('video-play'", at))
  assert.match(body, /new TorrentStreamer\(/)
  assert.match(body, /streamer\.on\('ready'/)
  assert.match(body, /onReady\(url, streamer\)/, 'the caller decides what happens on ready')
  assert.match(body, /_videoSession\.streamer = streamer/)
  assert.match(body, /streamer\.start\(/)
})

// video-play no longer builds its own TorrentStreamer — it goes through the
// helper — so the second copy that used to drift cannot come back.
test('video-play starts its torrent through the hedged race, smooth and purist alike', () => {
  const body = handlerBody('video-play')
  assert.strictEqual((body.match(/_startTorrentRace\(result, result\.alternates, \{/g) || []).length, 2)
  assert.ok(!/new TorrentStreamer\(/.test(body), 'video-play must not build a streamer directly')
})

// The hedge (2026-09-14): a silent lead swarm gets a challenger after ten
// seconds; the first servable stream wins, losers are stopped, only the lead
// lane reports buffering, and only the winner takes the session slot.
test('the torrent race hedges silence, promotes one winner, and fails only when every lane died', () => {
  const start = MAIN.indexOf('const HEDGE_AFTER_MS')
  const body = MAIN.slice(start, MAIN.indexOf('\nfunction _startTorrentStream', start))
  assert.match(body, /HEDGE_AFTER_MS = 10000/)
  assert.match(body, /\.slice\(0, 2\)/)
  assert.match(body, /setTimeout\(\(\) => \{ if \(!winner && current\(\)\) startNext\(\) \}, HEDGE_AFTER_MS\)/)
  assert.match(body, /if \(started < contenders\.length\) startNext\(\)\n        else if \(failed >= started && current\(\)\) fail\(err \|\| lastErr\)/)
  assert.match(body, /winner = s\n        _videoSession\.streamer = s\n        stopLosers\(\)/)
  assert.match(body, /quiet: i > 0/)
  // The quiet flag really gates the buffering reports and the session slot.
  assert.ok(/if \(current\(\) && !quiet\) safeSend\('video-event', \{ kind: 'buffering'/.test(MAIN))
  assert.ok(/if \(!quiet\) _videoSession\.streamer = streamer/.test(MAIN))
  // The renderer sends the two next-ranked torrent sources as hedge lanes.
  const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.ok(/result = Object\.assign\(\{\}, result, \{ alternates: alts \}\)/.test(R))
  assert.ok(/_sourceKey\(s\) !== pickedKey/.test(R))
})

// §player 30: mpv is spun up in parallel with the torrent connecting, not after
// the first playable bytes arrive. The idle mpv is loaded (not re-started) when
// the stream is ready, or the parallel spin-up would be killed by a second
// start().
test('mpv spin-up overlaps the torrent stream start', () => {
  const body = handlerBody('video-play')
  assert.match(body, /videoEngine\(\)\.start\(undefined, \{ wid \}\)/,
    'mpv must spawn idle, in parallel, before the URL exists')
  // The ready stream is loaded into the running mpv (not started afresh), after
  // the parallel spin-up settles. A stale-token re-check sits between spinUp and
  // load so a rapid double-play cannot load the old URL into a newer engine.
  assert.match(body, /spinUp\.then\(\(\) => \{/,
    'the load waits on the parallel spin-up')
  assert.match(body, /if \(!current\(\)\) return\s*\n\s*return videoEngine\(\)\.load\(url\)/,
    'the ready stream is loaded into the running mpv only while still current')
})

// §player 26: switch the source under a playing title without losing the place.
test('video-switch-stream keeps mpv alive and reuses only the streamer', () => {
  const body = handlerBody('video-switch-stream')
  // Position captured before the teardown, or the whole point is lost.
  assert.match(body, /const resumeAt = Number\(state && state\.position\)/)
  const teardownAt = body.indexOf('_videoSession.streamer.stop()')
  const readAt = body.indexOf('resumeAt')
  assert.ok(readAt > -1 && teardownAt > -1 && readAt < teardownAt,
    'the position must be read before the streamer is stopped')
  // Only the streamer is torn down — the engine is NOT stopped. Checked against
  // the code with comments stripped, since the comment explains what it avoids.
  const code = body.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  assert.ok(!/_videoTeardown\(\)/.test(code), 'switching must not stop mpv')
  assert.ok(!/videoEngine\(\)\.stop\(\)/.test(code), 'switching must not stop mpv')
  // The new stream is started through the shared helper, loaded into the
  // running mpv, and seeked absolutely back to the saved position.
  assert.match(body, /_startTorrentStream\(result, \{/)
  assert.match(body, /videoEngine\(\)\.load\(url\)/)
  assert.match(body, /videoEngine\(\)\.seek\(resumeAt, 'absolute'\)/)
  assert.match(body, /_prioritiseStreamAtPlayhead\(\)/)
})

test('video-switch-stream stamps a fresh token so a stale ready cannot hijack it', () => {
  const body = handlerBody('video-switch-stream')
  assert.match(body, /const token = \+\+_videoSession\.token/)
  assert.match(body, /const current = \(\) => _videoSession\.token === token/)
})

test('the switch-stream channel is reachable from the renderer', () => {
  assert.match(PRELOAD, /videoSwitchStream:/)
})

// ── Wave 5: online subtitle search (§player 21) ─────────────────────────────
test('video-sub-search forwards the needsKey marker', () => {
  const body = handlerBody('video-sub-search')
  assert.match(body, /opensubs\(\)\.search\(params/)
  assert.match(body, /needsKey: results\.needsKey === true/,
    'the UI must tell "no key" apart from "nothing found"')
  assert.match(body, /ok: false[^\n]*results: \[\]/, 'a failed search still returns a list, not an exception')
})

test('video-sub-download mints a link and writes it under the stream cache', () => {
  const body = handlerBody('video-sub-download')
  assert.match(body, /opensubs\(\)\.download\(fileId\)/)
  // The empty fileId is refused before spending quota.
  assert.match(body, /if \(fileId == null \|\| fileId === ''\) return \{ ok: false/)
  // No key is reported as such, not as a generic failure.
  assert.match(body, /if \(minted\.needsKey\)/)
  assert.match(body, /needsKey: true/)
  // Written under the stream cache root, ready for subAdd.
  assert.match(body, /streamRoot\(\)/)
  assert.match(body, /fs\.writeFileSync\(dest/)
  assert.match(body, /ok: true, path: dest/)
})

test('the OpenSubtitles instance reads its key fresh through a getter', () => {
  assert.match(MAIN, /const opensubs = _lazy\(\(\) => createOpenSubtitles\(\{/)
  assert.match(MAIN, /apiKey: \(\) => _videoSettings\(\)\.openSubtitlesApiKey/)
})

test('openSubtitlesApiKey is a video setting with an empty default', () => {
  const start = MAIN.indexOf('function _videoSettings()')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /openSubtitlesApiKey: ''/)
})

test('the subtitle-search channels are reachable from the renderer', () => {
  assert.match(PRELOAD, /videoSubSearch:/)
  assert.match(PRELOAD, /videoSubDownload:/)
})

// ── Wave 5: App §14/§19 — providers & recommendations already ride video-detail
// tmdb's normalised movie/TV detail already carries `providers` and
// `recommendations` as fields (catalog/tmdb.js _extras), and video-detail
// returns the detail object untouched, so no passthrough handler is needed —
// the fields survive IPC as they are. This pins that they are not stripped.
test('video-detail passes the detail through without dropping fields', () => {
  const body = handlerBody('video-detail')
  // The whole detail object is returned, either bare or with a copied seasons
  // list — never a hand-picked subset that could drop providers/recommendations.
  assert.match(body, /return \{ ok: true, detail \}/)
  assert.match(body, /detail: \{ \.\.\.detail, seasons \}/)
  // And there is no separate passthrough calling methods tmdb does not export.
  const registered = new Set([...MAIN_CODE.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map(m => m[1]))
  assert.ok(!registered.has('video-recommendations'),
    'recommendations ride video-detail; tmdb exports no recommendations() method')
  assert.ok(!registered.has('video-watch-providers'),
    'providers ride video-detail; tmdb exports no watchProviders() method')
})

// ── Wave 5: App §38 — do not cache a truncated season chain ─────────────────
test('a truncated anime season chain is not cached', () => {
  const body = handlerBody('video-seasons')
  assert.match(body, /out\.truncated !== true/,
    'a partial chain would pin the incomplete list for the whole TTL')
  assert.match(body, /out\.seasons\.length && out\.truncated !== true/)
})

// ── Wave 6: bandwidth cap (App #41) & seed-back (App #42) settings ────────────
test('the new bandwidth and seed settings are in the defaults', () => {
  const start = MAIN.indexOf('function _videoSettings()')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /downloadLimitMbps: null/)
  assert.match(body, /seedWhileWatching: true/)
  // The subtitle key was supposed to be here already; verify it still is.
  assert.match(body, /openSubtitlesApiKey: ''/)
})

test('video-settings-set only writes whitelisted keys', () => {
  assert.match(MAIN, /const VIDEO_SETTING_KEYS = new Set\(\[/)
  const start = MAIN.indexOf('const VIDEO_SETTING_KEYS = new Set([')
  const set = MAIN.slice(start, MAIN.indexOf('])', start))
  for (const key of ['tmdbApiKey', 'omdbApiKey', 'openSubtitlesApiKey',
                     'preferSurround', 'preferredQuality', 'torrentSources',
                     'downloadLimitMbps', 'seedWhileWatching', 'streamCacheDir']) {
    assert.match(set, new RegExp("'" + key + "'"), key + ' must be writable')
  }
  const body = handlerBody('video-settings-set')
  assert.match(body, /VIDEO_SETTING_KEYS\.has\(k\)/, 'the whitelist must actually gate the merge')
})

test('a new streamer is built with the stored cap and seed setting', () => {
  const at = MAIN.indexOf('function _startTorrentStream(')
  const body = MAIN.slice(at, MAIN.indexOf("ipcMain.handle('video-play'", at))
  // Mbps → bytes/s is ×125000, and null/0 leaves it uncapped.
  assert.match(body, /\* 125000/)
  assert.match(body, /downloadLimitBps,/)
  assert.match(body, /seedWhileWatching: settings\.seedWhileWatching !== false/)
})

test('changing the cap or the seed switch applies to the live streamer', () => {
  const body = handlerBody('video-settings-set')
  assert.match(body, /streamer\.setDownloadLimit\(/, 'the live cap must be re-applied')
  assert.match(body, /streamer\.setSeedWhileWatching\(/, 'the live seed switch must be re-applied')
  // Only when the value actually changed, and against the running streamer.
  assert.match(body, /next\.downloadLimitMbps !== current\.downloadLimitMbps/)
  assert.match(body, /next\.seedWhileWatching !== current\.seedWhileWatching/)
  assert.match(body, /const streamer = _videoSession\.streamer/)
})

// ── Wave 6: predownload IPC (App #40 UI) ─────────────────────────────────────
test('video-predownload drives the streamer predownloadFile', () => {
  const body = handlerBody('video-predownload')
  assert.match(body, /if \(!streamer\) return \{ ok: false/, 'nothing streaming is refused')
  assert.match(body, /streamer\.predownloadFile\(Number\(index\)\)/)
})

test('video-predownload-cancel withdraws the standing request', () => {
  const body = handlerBody('video-predownload-cancel')
  assert.match(body, /streamer\.cancelPredownload\(\)/)
})

test('video-predownload-progress returns the progress payload', () => {
  const body = handlerBody('video-predownload-progress')
  assert.match(body, /streamer\.predownloadProgress\(\)/)
  assert.match(body, /ok: true, progress/)
  // A read with nothing streaming is a null progress, not an exception.
  assert.match(body, /progress: progress \|\| null/)
})

test('the predownload channels are reachable from the renderer', () => {
  assert.match(PRELOAD, /videoPredownload:/)
  assert.match(PRELOAD, /videoPredownloadCancel:/)
  assert.match(PRELOAD, /videoPredownloadProgress:/)
})

// ── Next-episode prefetch trigger (App §40) ──────────────────────────────────
// The auto-prefetch that quietly pulls the next episode's opening while the
// current one plays. It rides the state stream and arms once past the halfway
// mark, only within a pack. This is what makes an Up Next / in-pack advance
// near-instant, so its wiring is pinned here.
test('the prefetch trigger arms at the halfway mark', () => {
  assert.match(MAIN, /const PREFETCH_AFTER = 0\.5/)
  const start = MAIN.indexOf('function _maybePrefetchNextEpisode()')
  assert.ok(start > 0, '_maybePrefetchNextEpisode present')
  const end = MAIN.indexOf('\nfunction ', start + 1)
  const body = MAIN.slice(start, end)
  // Below the threshold it does nothing.
  assert.match(body, /position \/ duration < PREFETCH_AFTER\) return/)
  // Only within a pack (more than one file), and it grabs the file AFTER the
  // one playing.
  assert.match(body, /if \(files\.length < 2\) return/)
  assert.match(body, /const at = files\.findIndex\(f => f\.current\)/)
  assert.match(body, /streamer\.prefetchFile\(files\[at \+ 1\]\.index\)/)
  // The finale has nothing after it — armed only when there is a next file.
  assert.match(body, /at \+ 1 >= files\.length\) return/)
})

test('the prefetch trigger rides the engine state stream', () => {
  // It must be called from the throttled state handler, or it never fires.
  assert.match(MAIN, /engine\.on\('state', s => \{[\s\S]*?_maybePrefetchNextEpisode\(\)/)
})

// ── Wave 6: the stalled event carries stallCount ─────────────────────────────
// §player 27's auto-switch counts repeated stalls; the count must survive the
// hop to the renderer or the cap can never be enforced.
test('the forwarded stalled event includes stallCount', () => {
  const start = MAIN.indexOf('function _wireVideoEngine()')
  const body = MAIN.slice(start, MAIN.indexOf('\n}\n', start))
  const at = body.indexOf("engine.on('stalled'")
  assert.ok(at > -1, 'the stalled handler must exist')
  const handler = body.slice(at, body.indexOf("engine.on('unstalled'", at))
  assert.match(handler, /kind: 'stalled'/)
  assert.match(handler, /stallCount: payload && payload\.stallCount/)
})

// ── Wave 6: diagnostics page (App §2-12) ─────────────────────────────────────
test('video-diagnostics probes each subsystem independently and never throws', () => {
  const body = handlerBody('video-diagnostics')
  // Each probe is wrapped so one failure cannot sink the whole call.
  assert.match(body, /catch \(_\) \{ return false \}/)
  // slskd reuses the /application login probe.
  assert.match(body, /slskdFetch\('GET', '\/application'\)/)
  assert.match(body, /isLoggedIn/)
  // tmdb: a key must be set AND the service must answer, under a 5 s ceiling.
  assert.match(body, /_videoSettings\(\)\.tmdbApiKey/)
  assert.match(body, /AbortSignal\.timeout\(5000\)/)
  // mpv: the binary is probed on PATH.
  assert.match(body, /execFile\('mpv', \['--version'\]/)
  // storeBridge: the crash-proof video store is readable.
  assert.match(body, /sideStores\.videoStore\.get\(\)/)
  // sources: defensive — an empty list when providers exports no health view.
  assert.match(body, /require\('\.\/providers\/index'\)/)
  assert.match(body, /return \[\]/)
  // The shape the diagnostics page reads.
  assert.match(body, /slskd,\s*\n\s*tmdb,\s*\n\s*mpv,\s*\n\s*storeBridge:/)
  assert.match(body, /sources: probeSources/)
})

test('the diagnostics channel is reachable from the renderer', () => {
  assert.match(PRELOAD, /videoDiagnostics:/)
})

// ── Wave 6: export / import everything (App §2-12) ────────────────────────────
test('papa-export-all bundles every store and redacts secrets', () => {
  const body = handlerBody('papa-export-all')
  assert.match(body, /dialog\.showSaveDialog\(/, 'the path is chosen through a save dialog')
  assert.match(body, /if \(r\.canceled \|\| !r\.filePath\) return \{ ok: false/)
  // The bundling itself now lives in one shared routine, so the export handler
  // and the auto-backup can never drift.
  assert.match(body, /_buildBackupPayload\(\)/)
  assert.match(body, /fs\.writeFileSync\(r\.filePath/)
})

test('the backup payload is built once, by the shared helper', () => {
  const collect = MAIN.slice(MAIN.indexOf('function _collectBackupStores('),
                             MAIN.indexOf('function _buildBackupPayload('))
  // Every store in the map, read by its own name — the one place it happens.
  assert.match(collect, /for \(const \[name, side\] of Object\.entries\(sideStores\)\)/)
  assert.match(collect, /stores\[name\] = side\.get\(\)/)
  const build = MAIN.slice(MAIN.indexOf('function _buildBackupPayload('),
                           MAIN.indexOf("ipcMain.handle('papa-export-all'"))
  assert.match(build, /_redactSecrets\(store\.store/, 'settings are stripped of secrets')
  assert.match(build, /_collectBackupStores\(\)/)
  assert.match(build, /schemaVersion: STORE_SCHEMA_VERSION/, 'the bundle carries its schema version (App §96)')
})

test('secrets are redacted by key name, not exported in the clear', () => {
  // Roadmap 136: the rule moved to src/redact.js so the logger, the bundle and
  // the export agree; behaviour is tested in test/redact.test.js.
  assert.match(MAIN, /const _SECRET_KEY_RE = _redact\.SECRET_KEY/)
  assert.match(MAIN, /function _redactSecrets\(obj\) \{ return _redact\.redactObject\(obj\) \}/)
  const R = require('../src/redact')
  const out = R.redactObject({ a: { password: 'x', token: 'y', apiKey: 'z', name: 'n' } })
  assert.deepStrictEqual(out, { a: { password: R.MARK, token: R.MARK, apiKey: R.MARK, name: 'n' } }, 'nested objects are redacted too')
})

test('papa-import-all validates the shape and never overwrites blind', () => {
  const body = handlerBody('papa-import-all')
  // Takes an optional path, falls back to a dialog.
  assert.match(body, /if \(!filePath\)/)
  assert.match(body, /dialog\.showOpenDialog\(/)
  // Shape check: the marker and a stores object are both required.
  assert.match(body, /parsed\.papaBackup == null/)
  assert.match(body, /!parsed\.stores/)
  // A timestamped .bak of the CURRENT value is written before each store is
  // overwritten.
  assert.match(body, /const bak = path\.join\(USER_DATA, `\$\{name\}\.\$\{stamp\}\.bak`\)/)
  const bakAt = body.indexOf('.bak`)')
  const setAt = body.indexOf('side.set(value)')
  assert.ok(bakAt > -1 && setAt > -1 && bakAt < setAt,
    'the backup must be written before the store is overwritten')
  // Returns the names it actually wrote.
  assert.match(body, /imported\.push\(name\)/)
  assert.match(body, /return \{ ok: true, imported \}/)
})

test('the export/import channels are reachable from the renderer', () => {
  assert.match(PRELOAD, /papaExportAll:/)
  assert.match(PRELOAD, /papaImportAll:/)
})

// ── Wave 7: user-facing changelog (App §7) ────────────────────────────────────
test('app-changelog returns the markdown and the app version', () => {
  const body = handlerBody('app-changelog')
  assert.match(body, /require\('\.\/package\.json'\)\.version/, 'version comes from package.json')
  assert.match(body, /CHANGELOG-APP\.md/, 'the prose is read from the docs file')
  assert.match(body, /return \{ ok: true, markdown, version \}/)
})

test('the changelog doc exists and is grouped as promised', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CHANGELOG-APP.md'), 'utf8')
  for (const heading of ['Movies & Anime', 'Player', 'Sources', 'Music', 'Under the hood']) {
    assert.ok(md.includes(`## ${heading}`), `missing section: ${heading}`)
  }
  const bullets = (md.match(/^- /gm) || []).length
  assert.ok(bullets >= 15 && bullets <= 60, `expected a healthy set of bullets, found ${bullets}`)
})

test('the changelog channel is reachable from the renderer', () => {
  assert.match(PRELOAD, /appChangelog:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app-changelog'\)/)
})

// ── Wave 7: offline detection (App §11) ───────────────────────────────────────
test('the online-state channel is reachable from the renderer as a subscription', () => {
  assert.match(PRELOAD, /onAppOnlineState:/)
  const line = PRELOAD.slice(PRELOAD.indexOf('onAppOnlineState:'),
                             PRELOAD.indexOf('onAppOnlineState:') + 200)
  assert.match(line, /ipcRenderer\.on\('app-online-state'/)
  assert.match(line, /removeListener\('app-online-state'/, 'it returns an unsubscribe')
})

// ── Wave 9: MPRIS polish (App #68) ────────────────────────────────────────────
// KDE's media widget is the consumer. These pin that the metadata the widget
// reads is actually populated and every transport control forwards to the
// renderer — the wiring is source-shape asserted the same way the video handlers
// are, since main.js cannot be required outside Electron.
// The metadata shape now lives in the pure src/mpris-metadata module (buildMetadata),
// which updateMpris calls. The wiring test pins that main delegates to it; the
// shape itself is asserted against the module in test/mpris-metadata.test.js.
test('MPRIS metadata is built by the pure module with the applet objectPath', () => {
  const start = MAIN.indexOf('function updateMpris(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}\n', start))
  assert.match(body, /mprisPlayer\.metadata = mprisMeta\.buildMetadata\(data, \{/, 'metadata comes from the pure builder')
  assert.match(body, /objectPath: \(p\) => mprisPlayer\.objectPath\(p\)/, 'the live D-Bus object-path helper is injected')
})

const meta = require('../src/mpris-metadata')

// A streamed track's cover is an http URL; prefixing file:// produced
// "file://https://…" which KDE could not load. Local paths still get file://.
test('a streamed http cover is sent as-is, a local path gets file://', () => {
  assert.strictEqual(meta.artUrl(''), '', 'no cover is an empty artUrl, not "file://"')
  assert.strictEqual(meta.artUrl('https://img.example/a.jpg'), 'https://img.example/a.jpg',
    'an http cover passes through unchanged')
  assert.strictEqual(meta.artUrl('/mnt/data/MUSIC/a b.jpg'), 'file:///mnt/data/MUSIC/a%20b.jpg',
    'a local path still gets the file scheme and is URI-encoded')
})

test('position and duration are reported to MPRIS with drift interpolation', () => {
  // getPosition interpolates elapsed time since the last update so a widget
  // scrubber advances smoothly between the once-a-second syncs.
  const init = MAIN.slice(MAIN.indexOf('function initMpris('), MAIN.indexOf('function updateMpris('))
  assert.match(init, /mprisPlayer\.getPosition = \(\) =>/, 'the position getter must exist')
  assert.match(init, /_mprisPos\.playing \? \(Date\.now\(\) - _mprisPos\.at\) \/ 1000 : 0/, 'drift only while playing')
  const upd = MAIN.slice(MAIN.indexOf('function updateMpris('), MAIN.indexOf('\n}\n', MAIN.indexOf('function updateMpris(')))
  assert.match(upd, /const next = \{ position: data\.position \|\| 0, at: Date\.now\(\), playing: !!data\.playing \}/)
  assert.match(upd, /_mprisPos = next/)
})

// roadmap #20 (b): a real seek raises the Seeked D-Bus signal so the applet
// scrubber jumps; a normal position tick does not.
test('MPRIS raises Seeked on a genuine seek, delegating the discontinuity test', () => {
  const upd = MAIN.slice(MAIN.indexOf('function updateMpris('), MAIN.indexOf('\n}\n', MAIN.indexOf('function updateMpris(')))
  assert.match(upd, /mprisMeta\.isSeek\(_mprisPos, next\)/, 'a jump is told apart from playback drift')
  assert.match(upd, /mprisPlayer\.seeked\(Math\.round\(next\.position \* 1e6\)\)/, 'the signal carries the new position in microseconds')
})

// roadmap #20 (c): capability flags are set from the queue/track, not left true.
test('MPRIS capability flags are derived per track, not left always-true', () => {
  const upd = MAIN.slice(MAIN.indexOf('function updateMpris('), MAIN.indexOf('\n}\n', MAIN.indexOf('function updateMpris(')))
  assert.match(upd, /const caps = mprisMeta\.capabilities\(data\)/)
  assert.match(upd, /mprisPlayer\.canSeek = caps\.canSeek/)
  assert.match(upd, /mprisPlayer\.canGoNext = caps\.canGoNext/)
  assert.match(upd, /mprisPlayer\.canGoPrevious = caps\.canGoPrevious/)
})

test('every MPRIS transport control forwards to the renderer', () => {
  const init = MAIN.slice(MAIN.indexOf('function initMpris('), MAIN.indexOf('function updateMpris('))
  for (const [ev, cmd] of [['playpause', 'play-pause'], ['play', 'play'], ['pause', 'pause'],
                           ['next', 'next'], ['previous', 'prev'], ['stop', 'stop']]) {
    assert.match(init, new RegExp(`on\\('${ev}',\\s*\\(\\) => send\\('${cmd}'\\)`), `${ev} is not wired`)
  }
  // Seek and volume are wired too, not just the buttons.
  assert.match(init, /on\('seek',\s*\(offsetUs\) =>/)
  assert.match(init, /on\('position',\s*\(e\) =>/)
  assert.match(init, /on\('volume',\s*\(v\) =>/)
  // The service declares itself controllable so the widget enables its buttons.
  assert.match(init, /mprisPlayer\.canControl = true/)
})

// V125: insufficient disk space during a keep stops safely and says what to do.
test('video-keep-file checks space first and cleans up a half-written copy on ENOSPC', () => {
  const body = handlerBody('video-keep-file')
  assert.match(body, /dlCapacity\.check\(\{ needBytes: info\.total/, 'space is checked before the copy')
  assert.ok(body.indexOf('dlCapacity.check(') < body.indexOf('fs.promises.copyFile(info.path, dest)'))
  assert.match(body, /try \{ fs\.rmSync\(dest, \{ force: true \}\) \} catch \(_\) \{\}\n\s+if \(e && e\.code === 'ENOSPC'\)/, 'a partial keep never survives')
  const R = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.ok(R.includes("else if (res && res.error === 'space') showToast(res.text"))
})

// V055: a pack that did not name the wanted episode says so.
test('the pack event carries the pick verdict and the renderer says when it did not match', () => {
  const fs = require('node:fs'), path = require('node:path')
  const M = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const T = fs.readFileSync(path.join(__dirname, '..', 'torrent-stream.js'), 'utf8')
  const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  assert.ok((M.match(/kind: 'pack', files, pick: \(typeof streamer\.pickInfo === 'function' \? streamer\.pickInfo\(\) : null\)/g) || []).length === 3, 'every pack event carries the pick')
  assert.ok(T.includes('matched: this._want && this._want.episode != null ? matchesWantedEpisode(file.name'))
  assert.ok(R.includes("if (pk && pk.wanted != null && pk.matched === false)"))
})
