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
  'video-play', 'video-stop',
  'video-control', 'video-tracks', 'video-chapters', 'video-skip-segments',
]

const PRELOAD_METHODS = [
  'videoSettingsGet', 'videoSettingsSet', 'videoCatalogGet',
  'videoSearch', 'videoDetail', 'videoStreams', 'videoProbe',
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
  assert.match(body, /within\.concat\(above, low\)/)
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

test('_videoScreenshotPath writes under USER_DATA and does not clobber', () => {
  const start = MAIN.indexOf('function _videoScreenshotPath()')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /path\.join\(USER_DATA, 'screenshots'\)/)
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

test('video-skip-segments exists now and returns an empty list until Phase 3', () => {
  const body = handlerBody('video-skip-segments')
  assert.match(body, /ok: true, segments: \[\]/)
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
