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

test('video-skip-segments merges every cheap layer', () => {
  const body = handlerBody('video-skip-segments')
  assert.match(body, /classifyChapters\(chapters/, 'layer 1: chapters in the file')
  assert.match(body, /aniskip\(\)\(/, 'layer 2: AniSkip for anime')
  assert.match(body, /req\.manual/, 'layer 4: the user\u2019s own corrections')
  assert.match(body, /creditsFallback\(duration\)/, 'layer 4: tail-of-file credits guess')
  assert.match(body, /mergeSegments\(sources\)/)
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
// mpv opens and manages its own window. Embedding it into a child
// BrowserWindow put a native surface on top of the app, covering the deck it
// was meant to sit beside, and the window manager handles moving, resizing and
// fullscreening it far better than positioning it by hand ever did.
test('mpv owns its window; nothing is embedded', () => {
  const body = handlerBody('video-play')
  assert.match(body, /const wid = null/)
  const code = body.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  assert.ok(!/_videoSettings\(\)\.embed/.test(code), 'no setting may gate this')
  assert.ok(!/_showVideoWindow\(\)/.test(code), 'there is no window of ours to show')
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
  const body = RENDERER.slice(at, at + 2600)
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
  assert.match(handlerBody('video-trailer'), /resolveYtUrl\(youtubeId, 'video'\)/)
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
  assert.match(body, /anilist\(\)\.search\(query\)/)
})

// A dead catalog should still return the other one's results.
test('neither catalog can fail the whole search', () => {
  const body = handlerBody('video-search')
  assert.match(body, /tmdb\(\)\.search\(query\)\.catch\(\(\) => \[\]\)/)
  assert.match(body, /anilist\(\)\.search\(query\)\.catch\(\(\) => \[\]\)/)
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
  assert.match(body, /if \(type === 'anime'\) return \{ ok: true, results: await anilist\(\)\.search\(query\) \}/)
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
