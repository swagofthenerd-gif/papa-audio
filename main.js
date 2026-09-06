const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Notification, shell, Menu, MenuItem, powerSaveBlocker, powerMonitor, session, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
// Required at the top: album ids are derived during scanning, long before the
// handler section, and `const` is not hoisted.
const tagEdit = require('./src/tag-edit')
const crypto = require('crypto')
const { makeCache } = require('./src/ttl-cache')
const { mergeSegments, creditsFallback } = require('./src/skip-model')
const { classifyChapters } = require('./skip/chapters')
const { createAniSkip } = require('./skip/aniskip')
const { detectIntro } = require('./skip/detect-intro')
const dlState_ = require('./src/dl-state')
const videoKeep = require('./src/video-keep')
const https = require('https')
// No sync child_process on the main thread: every shell-out goes through run().
const { spawn, execFile } = require('child_process')

// ── A deadline on every IPC endpoint ────────────────────────────────────────
// 130 handle() endpoints, none of which had one. A handler that never settles
// hangs that UI action forever with no feedback and no way to tell a slow
// operation from a dead one — and a renderer awaiting it simply stops.
//
// Deliberately generous: the default is 60 s, which nothing legitimate reaches.
// The endpoints below genuinely can take longer and are exempted by name rather
// than by guesswork, because killing a real library scan would be far worse than
// the bug being fixed. 0 means no deadline.
const IPC_DEFAULT_TIMEOUT_MS = 60000
const IPC_TIMEOUT_OVERRIDES = {
  // Both open a system dialog and wait on a person. A deadline on a dialog
  // does not protect against a wedged handler — it cancels the user.
  'papa-export-all': 0,
  'papa-import-all': 0,
  // Minutes on a large library, by design.
  'scan-library': 0,
  'library-scan-extras': 0,
  // Walks every music root, the artwork directory and every trash root.
  'library-storage-report': 300000,
  'library-trash-list': 300000,
  'library-empty-trash': 0,
  'library-move-path': 0,
  'library-inspect-paths': 300000,
  'library-trash-paths': 0,
  'library-restore-trashed': 0,
  'library-prune-state': 300000,
  // ffmpeg, once per file.
  'transcode-file': 0,
  'batch-transcode': 0,
  'library-write-tags': 0,
  // Rewrites FLAC files one by one on the calling thread; a large batch is
  // legitimately slow, so it is not deadlined (same reasoning as write-tags).
  'tag-write-batch': 0,
  'library-set-artwork': 300000,
  // Downloads a release from GitHub and unzips it.
  'slsk-setup': 600000,
  // 25 s per variant, six variants, plus slskd's own latency.
  'slsk-search': 240000,
  'slsk-enqueue-downloads': 180000,
  // A full wishlist sweep runs every entry as a sequential search with a 5 s gap
  // between them, so a long wishlist legitimately takes many minutes. Deadlined,
  // but generously, so a wedged sweep is still bounded.
  'slsk-wishlist-run': 1800000,
  // Pulls the whole /transfers/downloads list and re-issues DELETEs; minutes on
  // a large backlog.
  'slsk-respread-backlog': 300000,
  'yt-download': 0,
  'torrent-remove': 120000,
  // ffprobe over a remote URL: generous, but never unbounded.
  'video-probe': 30000,
  // torrent handoff + mpv spawn; a hung streamer must not wedge the handler.
  'video-play': 60000,
  // 20 s timeout with two retries and exponential backoff already inside.
  'yt-home': 120000,
  'yt-search': 120000,
  'yt-music-search': 120000,
  'yt-music-search-full': 120000,
  'yt-search-page': 120000,
  'yt-album': 120000,
  'yt-artist': 120000,
  'yt-playlist': 120000,
  'yt-radio': 120000,
  'fetch-album-art': 120000,
  'verify-surround': 120000,
  'verify-surround-folder': 300000,
  'slsk-verify-file': 120000,
  // Anything that waits on a person. A deadline here does not protect against a
  // wedged handler, it just cancels the user: a Google sign-in with 2FA takes
  // minutes, and add-music-folder commits the folder BEFORE it returns, so a
  // rejected invoke left main and the renderer disagreeing about the library.
  // test/main-guards.test.js asserts this list stays complete.
  'add-music-folder': 0,
  'library-pick-artwork': 0,
  'slsk-set-download-dir': 0,
  // Opens a file picker, so it waits on the user, not on the machine.
  'video-sub-open': 0,
  'save-lyrics': 0,
  'yt-auth-start': 0,
  // Runs ffmpeg over up to 20 tracks sequentially; minutes on a cold cache.
  'loudness-scan': 0,
  // MusicBrainz at a 1 req/s ceiling, plus network latency for two lookups.
  'musicbrainz-check-album': 120000,
}

// A tiny ring buffer of the last few IPC channels handled, so the crash
// reporter (below) can say what the app was doing when it fell over — "last it
// did was video-play" is far more useful to a user forwarding a crash log than a
// bare stack trace. Kept deliberately small and cheap: pushing a string on every
// invoke must cost nothing measurable.
const CRASH_TRAIL_MAX = 5
const _crashTrail = []
function _noteChannel(channel) {
  _crashTrail.push(channel)
  if (_crashTrail.length > CRASH_TRAIL_MAX) _crashTrail.shift()
}

// Patched here, before any handler registers, so every one is covered. The
// alternative was 130 identical edits and a way for the 131st to be forgotten.
const _ipcRawHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = function (channel, fn) {
  const budget = Object.prototype.hasOwnProperty.call(IPC_TIMEOUT_OVERRIDES, channel)
    ? IPC_TIMEOUT_OVERRIDES[channel]
    : IPC_DEFAULT_TIMEOUT_MS
  const traced = (...args) => { _noteChannel(channel); return fn(...args) }
  if (!budget) return _ipcRawHandle(channel, traced)
  return _ipcRawHandle(channel, async (...args) => {
    _noteChannel(channel)
    let timer
    try {
      return await Promise.race([
        fn(...args),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`${channel} did not answer within ${budget}ms`)
            err.code = 'IPC_TIMEOUT'
            // Loud on purpose: this is a handler that is wedged, and the whole
            // point is that it stops being invisible.
            console.error(`[papa][ipc] ${channel} timed out after ${budget}ms`)
            reject(err)
          }, budget)
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  })
}
const { MpvEngine } = require('./mpv-engine')
const { formatDiagnostic } = require('./engine-diagnostics')
const history = require('./history')
const { defaultSettings: eqDefaults, BANDS: EQ_BANDS, GAIN_LIMIT: EQ_GAIN_LIMIT, PRESETS: EQ_PRESETS, presetSettings } = require('./eq')
const { MpvCrossfade } = require('./mpv-crossfade')
const { linearToMpv, MPV_MAX } = require('./volume-map')
const loudness = require('./src/loudness')
const ytSearch = require('./youtube-search')
const ytDownloader = require('./youtube-download')
const lyrics = require('./lyrics')
// Papa Video — catalog, providers and engines are pure CommonJS factories.
// Nothing is constructed here: the factories run on first use, so no network
// or mpv spawn happens at import time.
const tmdbCatalog = require('./catalog/tmdb')
const { createTmdbCatalog } = tmdbCatalog
const shelves = require('./catalog/shelves')
const { createAnilistCatalog } = require('./catalog/anilist')
const { createOmdbCatalog } = require('./catalog/omdb')
const { createOpenSubtitles } = require('./subs/opensubtitles')
const { resolveStream } = require('./providers/index')
const { createYtsProvider } = require('./providers/yts')
const { createEztvProvider } = require('./providers/eztv')
const { createNyaaProvider } = require('./providers/nyaa')
const { createAnimetoshoProvider } = require('./providers/animetosho')
const { createApibayProvider } = require('./providers/apibay')
const { createKnabenProvider } = require('./providers/knaben')
const { createSolidTorrentsProvider } = require('./providers/solidtorrents')
const { createMovieTvProvider, createVidsrcResolver } = require('./providers/movie-tv')
const { createAnimeProvider } = require('./providers/anime')
const { TorrentStreamer, purgeOrphanStreams, setStreamRoot, streamRoot } = require('./torrent-stream')
const { VideoEngine, purgeOrphanPlayers } = require('./video-engine')
const { createThumbnailer } = require('./src/thumbnailer')
const { createYarrlistDirectory } = require('./yarrlist-directory')
const { classify } = require('./src/surround-verify')
const deadMagnet = require('./src/dead-magnet')
const watchDebounce = require('./src/watch-debounce')
const backupSchedule = require('./src/backup-schedule')
const searchHistory = require('./src/search-history')

const LASTFM_API_KEY = 'PLACEHOLDER'
const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/'

async function scrobbleTrack(track, timestamp) {
  const sk = store.get('lastfmConfig', {}).sessionKey
  if (!sk) return
  const params = new URLSearchParams({
    method: 'track.scrobble',
    api_key: LASTFM_API_KEY,
    sk: sk,
    'artist[0]': track.artist || '',
    'track[0]': track.title || '',
    'album[0]': track.album || '',
    'timestamp[0]': Math.floor(timestamp / 1000),
  })
  try {
    const res = await fetch(LASTFM_API_URL, { method: 'POST', body: params })
    // A non-2xx is a failure too: Last.fm answers 200 with an error body for
    // some cases, but an HTTP failure is unambiguous and was also swallowed.
    if (!res.ok) console.error(`[papa] scrobble rejected: ${res.status} ${res.statusText} for ${track.artist} - ${track.title}`)
  } catch (e) {
    // Silent scrobble loss means the user finds out weeks later by looking at
    // their Last.fm profile. Not worth interrupting playback over, but it has to
    // be in the log.
    console.error('[papa] scrobble failed:', String(e && e.message || e))
  }
}

function withTimeout(promise, ms, label) {
  var timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error((label || 'Request') + ' timed out')), ms) })
  ]).finally(() => clearTimeout(timer))
}

// ── YouTube URL resolution cache ──────────────────────────────────────────────
// mpv's built-in yt-dlp hook takes 2-10s per URL. Pre-resolve to googlevideo
// direct URLs so playback starts near-instantly (like Spotify / YT Music).
// Capped as well as expiring. It used to evict only ALREADY-EXPIRED entries
// when over 200, so 1000 unexpired resolutions left 1000 entries -- and
// pre-resolution runs five at a time off search results, so it fills fast.
const YT_URL_CACHE_CAP = 200
const _ytUrlCache = makeCache({ cap: YT_URL_CACHE_CAP })
const YT_URL_TTL = 60 * 60 * 1000 // 1 hour, the ceiling
// googlevideo URLs carry their own `expire` (Unix seconds), and it is often
// sooner than an hour. Caching for a flat hour meant a queued YouTube track
// could hold a URL that was already dead by the time it was reached.
const YT_URL_EXPIRY_MARGIN_MS = 5 * 60 * 1000

function ytUrlExpiresAt(url) {
  const ceiling = Date.now() + YT_URL_TTL
  const m = /[?&]expire=(\d+)/.exec(String(url || ''))
  if (!m) return ceiling
  const stated = Number(m[1]) * 1000
  if (!Number.isFinite(stated) || stated <= Date.now()) return ceiling
  // Re-resolve a few minutes early rather than at the moment it dies.
  return Math.min(ceiling, stated - YT_URL_EXPIRY_MARGIN_MS)
}

// `kind` picks the yt-dlp format. This function was written for music, where
// bestaudio is exactly right — but a trailer resolved that way plays with no
// picture at all. Video asks for a single muxed stream so mpv gets one URL
// rather than needing separate audio and video inputs.
const YT_FORMATS = {
  audio: 'bestaudio',
  video: 'best[height<=1080][ext=mp4]/best[ext=mp4]/best',
}

function resolveYtUrl(videoId, kind = 'audio') {
  const format = YT_FORMATS[kind] || YT_FORMATS.audio
  // Cached per format: the same id resolves to a different URL for audio and
  // for video, and serving one for the other is the bug this guards against.
  const cacheKey = kind === 'audio' ? videoId : `${kind}:${videoId}`
  // The cache applies the expiry itself now, so a hit is by definition live.
  const cached = _ytUrlCache.get(cacheKey)
  if (cached) return Promise.resolve(cached)
  return new Promise((resolve, reject) => {
    var proc, out = '', err = ''
    var timer = setTimeout(() => { try { proc.kill() } catch (_) {} reject(new Error('yt-dlp timed out')) }, 15000)
    try {
      proc = spawn('yt-dlp', ['-f', format, '-g', '--no-playlist', '--', videoId], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { clearTimeout(timer); reject(e); return }
    proc.stdout.on('data', d => out += d.toString())
    proc.stderr.on('data', d => err = (err + d.toString()).slice(-500))
    proc.on('error', e => { clearTimeout(timer); reject(e) })
    proc.on('close', code => {
      clearTimeout(timer)
      var url = out.trim().split('\n')[0]
      if (code === 0 && url && url.startsWith('http')) {
        _ytUrlCache.set(cacheKey, url, { expiresAt: ytUrlExpiresAt(url) })
        resolve(url)
      } else {
        reject(new Error(err.trim() || 'yt-dlp exited ' + code))
      }
    })
  })
}

function extractVideoId(path) {
  var m = /[?&]v=([a-zA-Z0-9_-]{11})/.exec(path)
  return m ? m[1] : null
}

// youtubei.js throws InnertubeError with the whole generated parser type in the
// message — pages of TypeScript, one line at a time, straight into the daily log
// (and through the old synchronous appendFileSync path). These are expected
// whenever YouTube changes its schema, so they belong on one line.
const YT_ERR_MAX = 240
function summariseYtError(e) {
  let msg = String((e && e.message) || e || 'unknown error')
  // The dump starts at the generated-type block; everything before it is the
  // part that says what actually went wrong.
  const cut = msg.search(/\n\s*(?:interface|type|export|class)\s/)
  if (cut > 0) msg = msg.slice(0, cut)
  msg = msg.replace(/\s+/g, ' ').trim()
  const name = (e && e.name) || 'Error'
  const short = msg.length > YT_ERR_MAX ? msg.slice(0, YT_ERR_MAX) + `… (${msg.length} chars, truncated)` : msg
  return `${name}: ${short}`
}

async function withRetry(fn, maxRetries, label) {
  var lastErr
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      var msg = String(e.message || e)
      if (msg.includes('401') || msg.includes('403') || msg.includes('400')) throw e
      if (attempt < maxRetries) {
        var delay = Math.min(1000 * Math.pow(2, attempt), 8000)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  // One line, summarised. This used to be the only record of a YouTube failure
  // and it was never written at all — the caller turned it into { ok: false }.
  console.error(`[papa][yt] ${label || 'request'} failed after ${maxRetries + 1} attempts:`,
    summariseYtError(lastErr))
  throw lastErr
}

// Optional. Without it, port mapping is unavailable — which is a degraded
// feature, not an error, but it has to be discoverable.
let natUpnp; try { natUpnp = require('nat-upnp') } catch (e) {
  console.error('[papa] nat-upnp unavailable; automatic port mapping is off:', e && e.message)
}

// A plain-English crash record the user can forward to the developer. It sits
// in the app's data folder as crash-log.txt and gets one appended entry per
// event: the date, what the app was last doing (the last IPC channel handled,
// which is cheap to know), the error itself, and a line telling the user the
// file is safe to send. Best-effort throughout — a failure to write the crash
// log must never itself throw, least of all from inside an uncaughtException
// handler. USER_DATA is resolved lazily because these handlers are installed
// above the line that sets it.
function _appendCrashLog(kind, err) {
  try {
    const dir = path.join(app.getPath('home'), '.config', 'papa-audio')
    const file = path.join(dir, 'crash-log.txt')
    const when = new Date().toISOString()
    const doing = _crashTrail.length
      ? `last things it did: ${_crashTrail.join(' → ')}`
      : 'nothing had been asked of it yet'
    const message = (err && (err.stack || err.message)) || String(err)
    const entry =
      `──────────────────────────────────────────\n` +
      `When: ${when}\n` +
      `What went wrong: ${kind}\n` +
      `What the app was doing: ${doing}\n` +
      `Details: ${message}\n` +
      `You can send this file to the developer — it holds no passwords or ` +
      `personal data, only what the app was doing when it stumbled.\n\n`
    try { fs.mkdirSync(dir, { recursive: true }) } catch (_) { /* already there, or read-only */ }
    fs.appendFileSync(file, entry, 'utf8')
  } catch (_) { /* a crash reporter that crashes is worse than a missing line */ }
}

// Under Node 18+ an unhandled rejection TERMINATES the process by default, and
// this file is full of un-awaited async IPC handlers and network calls
// (youtubei.js, slskd, webtorrent). One rejected promise from a background
// YouTube request would kill the app -- and the music with it -- with nothing
// written down about why. Log it and keep running: a music player dying mid-song
// because a metadata fetch 404'd is never the right trade.
process.on('unhandledRejection', (reason) => {
  console.error('[papa] unhandled rejection:', (reason && reason.stack) || reason)
  _appendCrashLog('a background task failed unexpectedly', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[papa] uncaught exception:', (err && err.stack) || err)
  _appendCrashLog('the app hit an unexpected error', err)
})

// The GPU and utility processes die out of sight of every JavaScript handler,
// so without this a GPU failure leaves nothing behind to look at — which is
// exactly the position an intermittent crash puts you in. Renderer crashes are
// already handled further down, with loop detection; this covers the ones that
// are not the renderer.
app.on('child-process-gone', (_event, details) => {
  console.error('[papa] child process gone:', JSON.stringify(details))
})

// Strip the automation flag so Cloudflare/bot-checks don't see navigator.webdriver = true
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

// A GPU process that fails to launch must not take the whole app down with it.
// Chromium's default is to retry a few times and then abort the process
// outright — "GPU process isn't usable. Goodbye." — which on this machine
// (RTX 3070, proprietary driver, Wayland session) happens intermittently: twice
// in about fifteen launches, with no pattern found under CPU load, concurrent
// launches or a cold profile. This switch makes Chromium keep going with
// software compositing instead of dying, which is a slower window rather than
// no window.
//
// It is a mitigation, not a diagnosis. The handler below is what will actually
// identify the cause, because it records the failure the next time it happens
// rather than losing it with the process.
app.commandLine.appendSwitch('disable-gpu-process-crash-limit')

// GPU memory optimisations
app.commandLine.appendSwitch('disable-gpu-rasterization')         // CPU rasterise tiles — less VRAM
app.commandLine.appendSwitch('disable-zero-copy')                  // don't DMA textures directly to GPU
app.commandLine.appendSwitch('num-raster-threads', '2')            // was 4 — fewer raster threads
app.commandLine.appendSwitch('renderer-process-limit', '1')        // only one renderer process
app.commandLine.appendSwitch('max-gum-fps', '60')                  // cap getUserMedia fps

// ── Stable identity ──────────────────────────────────────────────────────────
// Must run before requestSingleInstanceLock(): the lock is filed under
// whatever userData path is current at the time it's requested. Asking for
// it before setName/setPath meant every launch locked against Electron's
// generic default identity instead of papa-audio's own, which could let two
// full copies of the app run at once, silently racing over the same on-disk
// state (Continue Watching among it).
app.setName('Papa Audio')
// PAPA_USER_DATA env override — used only by the E2E smoke harness
// (tools/e2e-smoke.js) so it can launch a throwaway copy of the app in a fresh
// profile directory. Set it and the app writes all its state there instead of
// ~/.config/papa-audio. It must be applied BEFORE requestSingleInstanceLock()
// below, so the single-instance lock scopes to that fresh directory and the
// smoke test can run alongside the user's real, already-running instance
// without the two racing for the same lock. Unset (the normal case) → the real
// profile path, unchanged.
const USER_DATA = process.env.PAPA_USER_DATA
  ? path.resolve(process.env.PAPA_USER_DATA)
  : path.join(app.getPath('home'), '.config', 'papa-audio')
app.setPath('userData', USER_DATA)

// ── Single instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// ── Migrate from old flac-player config ─────────────────────────────────────
const OLD_DATA = path.join(app.getPath('home'), '.config', 'flac-player')
;(function migrate() {
  // A PAPA_USER_DATA override means a deliberately throwaway profile (the E2E
  // smoke harness). Migrating the user's real ~/.config/flac-player config into
  // it would defeat the point — it must start genuinely empty so the first-run
  // path is exercised. So skip the migration entirely under the override.
  if (process.env.PAPA_USER_DATA) return
  if (!fs.existsSync(OLD_DATA)) return
  if (fs.existsSync(path.join(USER_DATA, 'config.json'))) return
  try {
    fs.mkdirSync(USER_DATA, { recursive: true })
    const oldCfg = path.join(OLD_DATA, 'config.json')
    if (fs.existsSync(oldCfg)) fs.copyFileSync(oldCfg, path.join(USER_DATA, 'config.json'))
    const oldArt = path.join(OLD_DATA, 'artwork')
    const newArt = path.join(USER_DATA, 'artwork')
    if (fs.existsSync(oldArt)) {
      fs.mkdirSync(newArt, { recursive: true })
      for (const f of fs.readdirSync(oldArt))
        fs.copyFileSync(path.join(oldArt, f), path.join(newArt, f))
    }
  } catch (e) { console.error('Migration error:', e) }
})()

const Store = require('electron-store')
const mm = require('music-metadata')
const AdmZip = require('adm-zip')
const WebTorrent = require('webtorrent')

let _torrentClient = null
const _activeTorrents = new Map()
function getTorrentClient() {
  if (!_torrentClient) {
    // The default cap of 55 connections is tuned for background downloading.
    // Streaming is latency-sensitive: the head of the file has to arrive now,
    // not eventually, and more peers is the single biggest lever on that.
    _torrentClient = new WebTorrent({ maxConns: 150 })
    _torrentClient.on('error', err => {
      const message = (err && err.message) || String(err)
      console.error('[WebTorrent]', message)
      // A client-level error takes down every torrent on the shared client, so
      // an active viewer would otherwise just see the stream wedge with no
      // explanation. Surface it as a fatal video error, the same channel a
      // per-stream failure uses.
      safeSend('video-event', { kind: 'error', fatal: true, message })
    })
  }
  return _torrentClient
}
function _torrentAdd(uri) {
  // This read a top-level `downloadDir` key that nothing ever writes -- the
  // folder picker writes slskConfig.downloadDir -- so every torrent went to
  // the literal path below regardless of the setting, and on a machine with no
  // /mnt/data it went somewhere the user never chose. A default should be
  // derived, never a literal from one machine.
  const dlDir = _downloadDir()
  const client = getTorrentClient()
  if (client.get(uri)) return
  client.add(uri, { path: dlDir }, torrent => {
    _activeTorrents.set(torrent.infoHash, { infoHash: torrent.infoHash, name: torrent.name, progress: 0, speed: 0, downloaded: 0, total: torrent.length, eta: 0 })
    safeSend('torrent-progress', { infoHash: torrent.infoHash, name: torrent.name, progress: 0, speed: 0, eta: 0 })
    torrent.on('download', () => {
      const snap = { infoHash: torrent.infoHash, name: torrent.name, progress: torrent.progress, speed: torrent.downloadSpeed, downloaded: torrent.downloaded, total: torrent.length, eta: torrent.timeRemaining }
      _activeTorrents.set(torrent.infoHash, snap)
      safeSend('torrent-progress', snap)
    })
    torrent.on('done', () => {
      _activeTorrents.delete(torrent.infoHash)
      safeSend('torrent-done', { infoHash: torrent.infoHash, name: torrent.name })
      if (Notification.isSupported()) new Notification({ title: 'Torrent complete', body: torrent.name, silent: false }).show()
      // One policy, matching the renderer's _LIB_RESCAN_DELAYS and CLAUDE.md.
      // The torrent path used 8/25/60 while the Soulseek path used 15/45/120,
      // and the document only described the second one.
      for (const delay of LIB_RESCAN_DELAYS) {
        setTimeout(() => safeSend('do-lib-rescan'), delay).unref?.()
      }
    })
  })
}

// The one rescan cadence. Documented in CLAUDE.md and mirrored by the renderer's
// _LIB_RESCAN_DELAYS, which coalesces rather than stacking (item 75).
const LIB_RESCAN_DELAYS = [15000, 45000, 120000]

// ── File logging ────────────────────────────────────────────────────────────
// Every console line used to be a blocking appendFileSync on the main thread, so
// a burst — a failing loop, repeated 429s, a bad scan — became a burst of
// synchronous disk I/O competing with playback. Lines are now buffered and
// flushed on a timer, and the file has a size cap as well as an age cap.
//
// Installed from module scope rather than inside app.whenReady, because
// everything logged during early startup used to land before the patch existed
// and was therefore never written anywhere.
// Levels, so verbose diagnostics can exist in the code without shipping enabled
// and the log can be filtered. PAPA_LOG_LEVEL overrides at launch.
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const LOG_LEVEL_NAME = (process.env.PAPA_LOG_LEVEL || 'info').toLowerCase()
const LOG_MIN_LEVEL = LOG_LEVELS[LOG_LEVEL_NAME] || LOG_LEVELS.info
const LOG_FLUSH_MS = 1000
const LOG_MAX_BUFFER = 2000          // lines; past this the oldest are dropped
const LOG_MAX_BYTES = 8 * 1024 * 1024
// One id on both streams. The renderer's console and main's daily log were
// separate with nothing shared, so a report from one could not be lined up
// against the other.
const SESSION_ID = crypto.randomBytes(4).toString('hex')
let _logDir = null
let _logBuf = []
let _logTimer = null
let _logDropped = 0
let _logFlushing = false

// Local date parts, not toISOString(). The stats group by toDateString(),
// which is local, so under TZ=Australia/Sydney an incident at 22:30 was written
// to the NEXT day's file -- and docs/HANDOFF.md tells the next session to read
// papa-<incident date>.log, which would be the wrong file.
function localDayStamp(d) {
  const dt = d || new Date()
  const p = n => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

function _logFile() {
  return path.join(_logDir, `papa-${localDayStamp()}.log`)
}

function _flushLog() {
  _logTimer = null
  if (_logFlushing || !_logDir || !_logBuf.length) return
  const lines = _logBuf
  _logBuf = []
  if (_logDropped) {
    lines.unshift(`[${new Date().toISOString()}] [WARN] ${_logDropped} log lines dropped: the buffer filled faster than it could be written\n`)
    _logDropped = 0
  }
  _logFlushing = true
  const f = _logFile()
  fs.promises.appendFile(f, lines.join(''))
    .then(() => fs.promises.stat(f))
    .then(st => {
      // An age cap alone lets one bad day fill the disk.
      if (st.size > LOG_MAX_BYTES) return fs.promises.rename(f, f + '.1')
    })
    .catch(() => { /* a log that cannot be written must not become the fault */ })
    .finally(() => { _logFlushing = false })
}

function _queueLog(level, args) {
  if (!_logDir) return
  if ((LOG_LEVELS[level.toLowerCase()] || LOG_LEVELS.info) < LOG_MIN_LEVEL) return
  let msg
  try {
    msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  } catch (_) {
    msg = args.map(a => String(a)).join(' ')   // circular structures, etc.
  }
  if (_logBuf.length >= LOG_MAX_BUFFER) { _logDropped++; return }
  _logBuf.push(`[${new Date().toISOString()}] [${SESSION_ID}] [${level}] ${msg}\n`)
  if (!_logTimer) {
    _logTimer = setTimeout(_flushLog, LOG_FLUSH_MS)
    _logTimer.unref?.()
  }
}

function installFileLogging(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) { return }
  _logDir = dir
  _flushLog()   // anything buffered before the directory was known
}

// Patched here, at module load, so startup logging is not lost.
const _origError = console.error
console.error = (...args) => { _origError(...args); _queueLog('ERROR', args) }
const _origLog = console.log
console.log = (...args) => { _origLog(...args); _queueLog('INFO', args) }
const _origWarn = console.warn
console.warn = (...args) => { _origWarn(...args); _queueLog('WARN', args) }
// Off by default: this is the level that exists so diagnostics can be written
// now and switched on later, with PAPA_LOG_LEVEL=debug.
console.debug = (...args) => {
  if (LOG_MIN_LEVEL <= LOG_LEVELS.debug) _origLog(...args)
  _queueLog('DEBUG', args)
}

// Nothing buffered may be lost on the way out. Sync here for the same reason
// the side stores are: the process is exiting.
function flushLogSync() {
  if (!_logDir || !_logBuf.length) return
  const lines = _logBuf
  _logBuf = []
  try { fs.appendFileSync(_logFile(), lines.join('')) } catch (_) {}
}

const store = new Store()

// ── The five keys that were nearly all of the config, and nearly all of its
// writes ────────────────────────────────────────────────────────────────────
// electron-store rewrites and fsyncs the WHOLE file on every set. At 2.5 MB
// that made a 200-byte playback position cost 2.5 MB of synchronous disk I/O on
// the thread that drives mpv's IPC. Each of these now owns a small file, written
// asynchronously and coalesced. See side-store.js.
const { SideStore } = require('./side-store')
const { runAnalysis, analyseOne } = require('./analysis-runner')
const { buildQueue } = require('./src/queue-engine')
const { clusterLibrary } = require('./src/queue-clusters')
const { buildAffinity, buildColdSet } = require('./src/taste-model')
const _sideErr = e => { try { console.error('[papa][store]', e.message) } catch (_) {} }
const sideStores = {
  // Largest: 1.37 MB, rewritten on every scan, watcher event and mutation.
  libraryCache: new SideStore({ dir: USER_DATA, name: 'library-cache', fallback: null, debounceMs: 800, onError: _sideErr }),
  // Smallest and by far the most frequent: written repeatedly during playback.
  playbackState: new SideStore({ dir: USER_DATA, name: 'playback-state', fallback: null, debounceMs: 300, onError: _sideErr }),
  sessionState: new SideStore({ dir: USER_DATA, name: 'session-state', fallback: null, debounceMs: 500, onError: _sideErr }),
  recentlyPlayed: new SideStore({ dir: USER_DATA, name: 'recently-played', fallback: [], debounceMs: 500, onError: _sideErr }),
  // Changes more often than anything else that was in the config: every resize
  // and every move.
  windowState: new SideStore({ dir: USER_DATA, name: 'window-state', fallback: null, debounceMs: 400, onError: _sideErr }),
  // Written from dlTick every 4 s for the whole life of any download.
  slskSchedulerState: new SideStore({ dir: USER_DATA, name: 'download-scheduler', fallback: null, debounceMs: 1000, onError: _sideErr }),
  // 344 KB of the old config at ~294 bytes per play, rewritten in full on every
  // save — the same defect as the others, and it grows with use.
  playHistory: new SideStore({ dir: USER_DATA, name: 'play-history', fallback: [], debounceMs: 700, onError: _sideErr }),
  // The video watch history, migrated off the renderer's localStorage so it no
  // longer depends on Chromium's delayed commit timer at quit. The value is
  // the raw JSON string exactly as the renderer wrote it — main never parses
  // it, so a main-side bug can never mangle the blob.
  videoStore: new SideStore({ dir: USER_DATA, name: 'video-store', fallback: null, debounceMs: 300, onError: _sideErr }),
  videoStoreBak: new SideStore({ dir: USER_DATA, name: 'video-store-bak', fallback: null, debounceMs: 1000, onError: _sideErr }),
  // Non-destructive ReplayGain (App #59): { filePath: { lufs, gainDb, at } }. Set
  // in batches by the loudness scan, read on every track load to fold the gain
  // into mpv's volume. Never written to the files themselves.
  loudnessMap: new SideStore({ dir: USER_DATA, name: 'loudness-map', fallback: {}, debounceMs: 500, onError: _sideErr }),
  // Outage insurance for anime detail pages. AniList has gone globally dark
  // before (HTTP 403, "temporarily disabled due to severe stability issues"),
  // which turns every anime detail click into an error page. This is a
  // write-through, on-disk mirror of the anime detail objects: any show opened
  // at least once keeps opening across restarts and outages. Keyed
  // `anime:<id>` → { detail, cachedAt } and `chain:<id>` → { chain, cachedAt }
  // for the season-chain walk that anime pack playback depends on. Fresh-first:
  // a live byId always wins and rewrites the entry; the cache is only read when
  // the network fails. Capped (see _animeDetailCacheWrite) so it can't grow
  // without bound.
  animeDetailCache: new SideStore({ dir: USER_DATA, name: 'anime-detail-cache', fallback: {}, debounceMs: 1000, onError: _sideErr }),

  // Peer-library browse cache. Browsing a big library refetches ~10k directories
  // on every open — seconds, sometimes a timeout. Keyed `browse:<username>` ->
  // { directories, cachedAt }, capped (see _browseCacheWrite) so it can't grow
  // without bound. Serve-then-refresh: an open returns the cache immediately and
  // kicks a background refresh whose fresh tree arrives via slsk-browse-refreshed.
  browseCache: new SideStore({ dir: USER_DATA, name: 'browse-cache', fallback: {}, debounceMs: 1000, onError: _sideErr }),

  // Learned dead-magnet memory (App #41). infohash -> { failures, lastFailAt }.
  // Written on the video streamer's give-up/error paths, read (and decayed) when
  // video sources are ranked so a repeatedly-dead torrent is demoted, never
  // hidden. Small and infrequently written, so a lazy debounce is fine.
  deadMagnets: new SideStore({ dir: USER_DATA, name: 'dead-magnets', fallback: {}, debounceMs: 1000, onError: _sideErr }),

  // Soulseek search persistence (App #53). A capped list of recent searches —
  // { key, query, results, at } newest-first — so a restart can serve the last
  // results instantly (fromCache) while a live search revalidates in the
  // background. The RAW normalized response list is stored, never DOM. Capped by
  // total serialized size (see _searchPersistWrite) so it cannot grow without
  // bound.
  searchHistory: new SideStore({ dir: USER_DATA, name: 'search-history', fallback: [], debounceMs: 1000, onError: _sideErr }),

  // Air-date notifications (roadmap #35): the keys ('anime:ID#eN' / 'tv:ID#eN')
  // of episodes we have already notified about, capped at 200 (see
  // src/airing-notify.js), so a followed show's episode is announced once.
  airingNotified: new SideStore({ dir: USER_DATA, name: 'airing-notified', fallback: [], debounceMs: 1000, onError: _sideErr }),

  // Post-download verification verdicts (roadmap #49), keyed `username::folder` ->
  // { ok, problems:[], at, folder, username, dir }. The UI reads a verdict via
  // slskVerifyStatus; wiring comes next wave, this just makes the data exist.
  slskVerify: new SideStore({ dir: USER_DATA, name: 'slsk-verify', fallback: {}, debounceMs: 1000, onError: _sideErr }),

  // Auto-organize move log (roadmap #50): an append-only record of every file
  // move so an opt-in reorganise is inspectable and never silent. Capped on write.
  slskOrganizeLog: new SideStore({ dir: USER_DATA, name: 'slsk-organize-log', fallback: [], debounceMs: 1000, onError: _sideErr }),
}

// One-time move out of the shared config. adoptIfEmpty only takes the legacy
// value when the side file does not exist yet, so a stale config value can never
// resurrect over data the app has since written.
for (const [key, side] of Object.entries(sideStores)) {
  try {
    if (side.adoptIfEmpty(store.get(key))) {
      console.log(`[papa][store] moved ${key} out of the shared config`)
      store.delete(key)
    }
  } catch (e) { _sideErr(new Error(`${key}: migration failed (${e && e.message})`)) }
}

// Learned dead-magnet memory (App #41): drop entries whose last failure has
// decayed past the 14-day window, once at startup, so the file can never grow
// without bound with hashes nobody will ever retry. Best-effort.
try {
  sideStores.deadMagnets.update(prev => deadMagnet.prune(prev || {}, Date.now()))
} catch (_) { /* pruning is housekeeping; a failure just defers it */ }

// Single-encode the video store (App #45). video-store.json used to hold a JSON
// string INSIDE JSON — the renderer's blob, JSON.stringify'd, then the SideStore
// JSON.stringify'd that string again. It works but is fragile for recovery
// tooling. This migrates the stored value to a native object once: if the
// SideStore currently holds a STRING that parses to JSON, the parsed OBJECT is
// stored going forward and a one-time .pre-single-encode copy of the original
// file is kept beside it. Idempotent — a value that is already an object (or a
// string that is not JSON) is left untouched, so a second run does nothing.
function _migrateVideoStoreSingleEncode(side) {
  let value
  try { value = side.get() } catch (_) { return false }
  // Already single-encoded (object), empty, or an unparseable string: nothing
  // to do. Only a string that round-trips through JSON.parse is the double-
  // encoded shape this migration targets.
  if (typeof value !== 'string') return false
  let parsed
  try { parsed = JSON.parse(value) } catch (_) { return false }
  // A JSON string of a primitive (e.g. "null", a bare number) is not the blob;
  // the video store is always an object.
  if (!parsed || typeof parsed !== 'object') return false
  // Keep the original file verbatim before rewriting it, once. If a backup is
  // already there a prior migration ran — do not overwrite it.
  try {
    const bak = `${side.file}.pre-single-encode`
    if (side.fileExists() && !fs.existsSync(bak)) fs.copyFileSync(side.file, bak)
  } catch (_) { /* the copy is insurance; its absence must not block the migration */ }
  try { side.set(parsed) } catch (_) { return false }
  return true
}

try {
  if (_migrateVideoStoreSingleEncode(sideStores.videoStore)) {
    console.log('[papa][store] migrated video-store to single-encoded JSON')
  }
  // The rolling backup carries the same double-encoded shape; migrate it too so
  // a recovery from it lands a clean object rather than re-introducing the wrap.
  _migrateVideoStoreSingleEncode(sideStores.videoStoreBak)
} catch (_) { /* a failed migration leaves the working double-encoded blob */ }

// Nothing may be lost on the way out, and neither quit path can await.
// featureStore is declared later in the file (it needs USER_DATA already set
// up), but this function only ever runs at quit time, well after that
// declaration has executed — the closure sees it fine despite the textual
// order. It is deliberately not part of `sideStores`: that map exists before
// featureStore does, and is iterated elsewhere (migration) in ways that
// shouldn't pick up a smart-queues-only store.
function flushSideStores() {
  for (const side of Object.values(sideStores)) {
    try { side.flushSync() } catch (_) { /* exiting anyway */ }
  }
  try { featureStore.flushSync() } catch (_) { /* exiting anyway */ }
}

;(function migrateFolder() {
  const old = store.get('musicFolder')
  if (old && !store.get('musicFolders')) {
    store.set('musicFolders', [old])
    store.delete('musicFolder')
  }
})()

// ── Soulseek (slskd) ─────────────────────────────────────────────────────────
const SLSKD_DIR  = path.join(app.getPath('home'), '.config', 'papa-audio', 'slskd')
const SLSKD_BIN  = path.join(SLSKD_DIR, 'slskd')
const SLSKD_CFG  = path.join(SLSKD_DIR, 'slskd.yml')
const SLSKD_PORT = 5030
const SLSKD_BASE = `http://localhost:${SLSKD_PORT}/api/v0`

let slskdProc        = null
let slskdReady       = false
let slskdToken       = null
let slskdTokenExpiry = 0
let upnpClient       = null
let upnpRenewTimer   = null
let _slskdFailures   = 0

async function upnpMap(port) {
  if (!natUpnp) return false
  try {
    upnpClient = natUpnp.createClient()
    await new Promise((resolve, reject) => {
      upnpClient.portMapping(
        { public: port, private: port, ttl: 86400, description: 'Papa Audio Soulseek' },
        err => err ? reject(err) : resolve()
      )
    })
    clearTimeout(upnpRenewTimer)
    upnpRenewTimer = setTimeout(() => upnpMap(port), 4 * 60 * 60 * 1000)
    return true
  } catch (_) { return false }
}

function upnpUnmap(port) {
  clearTimeout(upnpRenewTimer); upnpRenewTimer = null
  if (upnpClient) {
    try { upnpClient.portUnmapping({ public: port }, () => {}) } catch (_) {}
    try { upnpClient.close?.() } catch (_) {}
    upnpClient = null
  }
}

// The API credentials slskd is configured with and the ones we authenticate
// with are now the same value. slskdApiCreds used to be read and never written,
// so the code read as though the credentials were configurable when the only
// possible value was slskd's literal default on a listening port.
function _slskdApiCreds() {
  const stored = store.get('slskdApiCreds', null)
  if (stored && stored.username && stored.password) return stored
  // Not generated here: an existing config on disk has no authentication block,
  // so slskd is using its own defaults and inventing a password would lock us
  // out of a daemon that is already running. New credentials are minted only
  // when we write a config, below.
  return { username: 'slskd', password: 'slskd' }
}

function _mintSlskdApiCreds() {
  const stored = store.get('slskdApiCreds', null)
  if (stored && stored.username && stored.password) return stored
  const creds = { username: 'papa', password: crypto.randomBytes(24).toString('base64url') }
  store.set('slskdApiCreds', creds)
  return creds
}

function writeSlskdConfig({ username = '', password = '', downloadDir = '' } = {}) {
  if (!downloadDir) downloadDir = _downloadDir()
  fs.mkdirSync(SLSKD_DIR, { recursive: true })
  fs.mkdirSync(path.join(SLSKD_DIR, 'incomplete'), { recursive: true })
  fs.mkdirSync(downloadDir, { recursive: true })
  const apiCreds = _mintSlskdApiCreds()
  // Share the parent of the download dir if it's a subfolder, so the whole library is shared
  const musicFolders = store.get('musicFolders', [])
  const shareDir = musicFolders[0] || path.dirname(downloadDir)
  const yml = [
    `soulseek:`,
    `  username: ${JSON.stringify(username)}`,
    `  password: ${JSON.stringify(password)}`,
    `  description: "Papa Audio"`,
    `  listen_port: 2234`,
    `  distributed_network:`,
    `    disabled: false`,
    `    disable_children: false`,
    `    child_limit: 100`,
    `  connection:`,
    `    timeout:`,
    `      connect: 10000`,
    `      inactivity: 25000`,
    `      transfer: 60000`,
    `    buffer:`,
    `      read: 16384`,
    `      write: 16384`,
    `      transfer: 262144`,
    `      write_queue: 250`,
    `directories:`,
    `  incomplete: ${JSON.stringify(path.join(SLSKD_DIR, 'incomplete'))}`,
    `  downloads: ${JSON.stringify(downloadDir)}`,
    `shares:`,
    `  directories:`,
    `    - ${JSON.stringify(shareDir)}`,
    `  filters:`,
    `    - \\.jpg$`,
    `    - \\.png$`,
    `    - \\.log$`,
    `    - \\.cue$`,
    `    - \\.txt$`,
    `rooms:`,
    `  - "Lossless Music"`,
    `  - "FLAC"`,
    `  - "Metal"`,
    `  - "Electronic"`,
    `  - "Jazz"`,
    `  - "Classical"`,
    `  - "Hip-Hop"`,
    `  - "Rock"`,
    `  - "Alternative"`,
    `  - "Indie"`,
    `  - "Ambient"`,
    `  - "Soundtrack"`,
    `  - "Pop"`,
    `  - "R&B"`,
    `throttling:`,
    `  search:`,
    `    incoming:`,
    `      concurrency: 25`,
    `      circuit_breaker: 1000`,
    `      response_file_limit: 5000`,
    `web:`,
    `  port: ${SLSKD_PORT}`,
    `  authentication:`,
    `    username: ${JSON.stringify(apiCreds.username)}`,
    `    password: ${JSON.stringify(apiCreds.password)}`,
    `logger:`,
    `  minimum: "Warning"`,
  ].join('\n')
  fs.writeFileSync(SLSKD_CFG, yml)
}

async function slskdAcquireToken() {
  try {
    const res = await fetch(`${SLSKD_BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_slskdApiCreds()),
    })
    if (!res.ok) return false
    const data = await res.json()
    slskdToken = data.token
    // expires is Unix epoch seconds; refresh 5 minutes early
    slskdTokenExpiry = (data.expires * 1000) - 5 * 60 * 1000
    return true
  } catch (_) { return false }
}

// A 429 is slskd asking us to slow down. It used to throw like any other
// non-2xx, and the 60 s health monitor counted that as slskd being unhealthy —
// so being rate-limited got the daemon RESTARTED, which loses every in-flight
// transfer and then hammers it again from a cold start.
const SLSKD_THROTTLE_BACKOFF_MS = [500, 1500, 4000]
let _slskdThrottledUntil = 0

function slskdIsThrottled() { return Date.now() < _slskdThrottledUntil }

async function slskdFetch(method, endpoint, body) {
  if (!slskdToken || Date.now() > slskdTokenExpiry) await slskdAcquireToken()
  const headers = { 'Content-Type': 'application/json' }
  if (slskdToken) headers['Authorization'] = `Bearer ${slskdToken}`
  const opts = { method, headers, signal: AbortSignal.timeout(15000), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }
  let res = await fetch(`${SLSKD_BASE}${endpoint}`, opts)
  if (res.status === 401) {
    slskdToken = null
    await slskdAcquireToken()
    if (slskdToken) headers['Authorization'] = `Bearer ${slskdToken}`
    const retryOpts = { ...opts, signal: AbortSignal.timeout(15000) }
    res = await fetch(`${SLSKD_BASE}${endpoint}`, retryOpts)
  }
  // Back off and retry rather than failing. Retry-After is honoured when slskd
  // sends one, since it knows better than a fixed schedule does.
  for (let attempt = 0; res.status === 429 && attempt < SLSKD_THROTTLE_BACKOFF_MS.length; attempt++) {
    const hinted = Number(res.headers.get('retry-after')) * 1000
    const wait = Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted, 10000) : SLSKD_THROTTLE_BACKOFF_MS[attempt]
    _slskdThrottledUntil = Date.now() + wait
    console.log(`[papa] slskd throttled us on ${method} ${endpoint}; waiting ${wait}ms (attempt ${attempt + 1})`)
    await new Promise(r => setTimeout(r, wait))
    res = await fetch(`${SLSKD_BASE}${endpoint}`, { ...opts, signal: AbortSignal.timeout(15000) })
  }
  if (res.status === 429) {
    _slskdThrottledUntil = Date.now() + 15000
    const err = new Error(`slskd is rate-limiting requests (429) on ${method} ${endpoint}`)
    // Tagged so the health monitor can tell throttling from the daemon being
    // unhealthy, which are opposite problems: one needs patience, the other a
    // restart.
    err.code = 'SLSKD_THROTTLED'
    err.throttled = true
    throw err
  }
  if (!res.ok && res.status !== 204) {
    const err = new Error(`slskd ${res.status} on ${method} ${endpoint}`)
    err.status = res.status
    throw err
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function verifyAudioFile(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { timeout: 10000 }, (err, stdout) => {
      if (err) { resolve({ ok: false, error: err.message }); return }
      const dur = parseFloat(stdout)
      if (dur && dur > 0) resolve({ ok: true, duration: dur })
      else resolve({ ok: false, error: 'Zero duration or invalid file' })
    })
  })
}

async function waitForSlskd(maxMs = 30000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1200))
    try {
      const res = await fetch(`${SLSKD_BASE}/application`, {
        headers: slskdToken ? { Authorization: `Bearer ${slskdToken}` } : {},
      })
      // 401 means the server is up but we haven't authenticated yet — still ready
      if (res.ok || res.status === 401) { slskdReady = true; return true }
    } catch (_) {}
  }
  return false
}

// slskd runs a limited number of searches at once. A search is only removed
// when the client deletes it, so every crash or kill -9 mid-search leaks one.
// Once enough have leaked, every new search sits in state=Queued forever and
// Soulseek looks broken while slskd reports itself perfectly connected - which
// is exactly how it presents: healthy daemon, zero results.
async function purgeStaleSearches() {
  try {
    const list = await slskdFetch('GET', '/searches')
    const stale = (list || []).filter(s => /Completed|Errored|TimedOut/i.test(s.state || ''))
    for (const s of stale) {
      try { await slskdFetch('DELETE', `/searches/${s.id}`) } catch (_) {}
    }
    if (stale.length) console.log(`[papa] slskd: cleared ${stale.length} stale search(es)`)
    return stale.length
  } catch (e) {
    console.error('[papa] slskd-purge:', e.message || e)
    return 0
  }
}

async function startSlskd() {
  if (!fs.existsSync(SLSKD_BIN)) return
  // If already running externally, just authenticate and mark ready
  if (!slskdProc) {
    try {
      const r = await fetch(`${SLSKD_BASE}/application`)
      if (r.ok || r.status === 401) {
        slskdReady = true
        await slskdAcquireToken()
        await purgeStaleSearches()
        return
      }
    } catch (e) { console.error('[papa] slskd-start:', e.message || e) }
  }
  if (slskdProc) return
  if (!fs.existsSync(SLSKD_CFG)) {
    const cfg = store.get('slskConfig', {})
    // _downloadDir() rather than folders[0]: peer-supplied folder names must not
    // land in the library root.
    writeSlskdConfig({ ...cfg, downloadDir: _downloadDir() })
  }
  slskdProc = spawn(SLSKD_BIN, ['--config', SLSKD_CFG, '--no-logo'], { stdio: 'ignore' })
  slskdProc.on('exit', (code, signal) => {
    if (code) console.error(`[papa] slskd exited with code ${code}${signal ? ' signal ' + signal : ''}`)
    slskdProc = null; slskdReady = false; slskdToken = null
  })
  // Without this, ENOENT fires 'error' and NOT 'exit', so slskdProc stayed
  // truthy forever and the `if (slskdProc) return` guard above blocked every
  // future restart — while the 60 s health monitor retried against a guard that
  // could never open again.
  slskdProc.on('error', (e) => {
    console.error('[papa] slskd could not be started:', String(e && e.message || e))
    slskdProc = null; slskdReady = false; slskdToken = null
    safeSend('slskd-status-change', {
      connected: false, restarting: false, error: String(e && e.message || e),
    })
  })
  await waitForSlskd()
  await slskdAcquireToken()
  await purgeStaleSearches()
  upnpMap(2234).catch(e => { console.error('[papa] upnp-map:', e.message || e) })
}

function stopSlskd() {
  upnpUnmap(2234)
  if (slskdProc) { try { slskdProc.kill() } catch (_) {} slskdProc = null }
  slskdReady = false
}

async function downloadSlskd(progressCb) {
  progressCb?.('Fetching latest release info…')
  const relRes = await fetch('https://api.github.com/repos/slskd/slskd/releases/latest',
    { headers: { 'User-Agent': 'papa-audio/1.0' } })
  if (!relRes.ok) throw new Error('Could not reach GitHub')
  const rel = await relRes.json()
  const asset = rel.assets.find(a => a.name.match(/linux-x64.*\.zip$/i))
  if (!asset) throw new Error('No linux-x64 zip found in latest release')
  progressCb?.(`Downloading ${asset.name} (${Math.round(asset.size / 1024 / 1024)}MB)…`)
  const zipPath = path.join(SLSKD_DIR, 'slskd.zip')
  fs.mkdirSync(SLSKD_DIR, { recursive: true })
  const dlRes = await fetch(asset.browser_download_url)
  if (!dlRes.ok) throw new Error('Download failed')
  const buf = Buffer.from(await dlRes.arrayBuffer())
  fs.writeFileSync(zipPath, buf)
  progressCb?.('Extracting…')
  // Was execSync through a shell with JSON.stringify standing in for quoting and
  // no timeout at all: a hung unzip froze the app with no way out. execFile
  // passes arguments as arguments, so there is no shell to quote for.
  await run('unzip', ['-o', zipPath, '-d', SLSKD_DIR], 120000)
  fs.unlinkSync(zipPath)
  await fs.promises.chmod(SLSKD_BIN, 0o755)
}

// execFile with a timeout, as a promise. Rejects with something that names the
// command, because "Command failed" on its own is not a diagnosis.
function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeout || 30000, maxBuffer: 1 << 22 }, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? `timed out after ${timeout || 30000}ms` : (err.message || 'failed')
        reject(new Error(`${cmd} ${why}: ${String(stderr || '').slice(0, 400)}`))
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

// Renderer crash-loop protection. Reloading into the same crash is worse than
// stopping, because each round looks to the user like the app is trying.
const RENDERER_CRASH_WINDOW_MS = 5 * 60 * 1000
const MAX_RENDERER_CRASHES = 3
let _rendererCrashes = []

let mainWindow  = null
let artworkDir  = ''
let dlHandlerReady = false

const LAYOUT = { TITLEBAR: 52, SIDEBAR: 230, PLAYER: 112 }
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png')

// ── Extension IPC (state file + command polling) ─────────────────────────────
const NOW_PLAYING_PATH = path.join(USER_DATA, 'now-playing.json')
const CMD_PATH         = path.join(USER_DATA, 'cmd')

// syncExtension() fires this once a second for the whole time anything is
// playing, and it was writeFileSync -- a blocking main-thread write per second,
// forever, competing with mpv's IPC. Coalesced and asynchronous now, the same
// shape the side stores use: the newest payload wins, one write in flight at a
// time, and a write that is still going does not stack up behind itself.
let _npPending = null
let _npWriting = false
let _npTimer = null
const NOW_PLAYING_COALESCE_MS = 250

function writeNowPlaying(data) {
  if (_npStopped) return
  _npPending = data
  if (_npTimer || _npWriting) return
  _npTimer = setTimeout(_flushNowPlaying, NOW_PLAYING_COALESCE_MS)
  // Not unref'd: it is a 250 ms timer, and it must run before quit so the last
  // state on disk is the last state that was playing.
}

function _flushNowPlaying() {
  _npTimer = null
  if (_npStopped || _npPending == null || _npWriting) return
  const payload = _npPending
  _npPending = null
  _npWriting = true
  let body
  try { body = JSON.stringify(payload) } catch (e) {
    _npWriting = false
    console.error('[papa] write-now-playing: unserialisable payload:', e.message || e)
    return
  }
  // Temp plus rename, so the extension never reads a half-written file.
  const tmp = NOW_PLAYING_PATH + '.tmp'
  fs.promises.writeFile(tmp, body)
    .then(() => fs.promises.rename(tmp, NOW_PLAYING_PATH))
    .catch(e => {
      console.error('[papa] write-now-playing:', e.message || e)
      return fs.promises.unlink(tmp).catch(() => {})
    })
    .then(() => {
      _npWriting = false
      // Something arrived while that was in flight: write the newest, once.
      if (!_npStopped && _npPending != null && !_npTimer) _npTimer = setTimeout(_flushNowPlaying, NOW_PLAYING_COALESCE_MS)
    })
}

// Called on quit, BEFORE the file is deleted. will-quit unlinks
// NOW_PLAYING_PATH, and an async write still in flight would land after the
// unlink and leave a stale now-playing file for the extension to read forever.
let _npStopped = false
function stopNowPlayingWrites() {
  _npStopped = true
  if (_npTimer) { clearTimeout(_npTimer); _npTimer = null }
  _npPending = null
}

// The command file is how the browser extension talks to the app. This used to
// be a synchronous read AND write every 200 ms for the life of the process —
// five main-thread filesystem operations per second, forever, competing with
// playback — to carry a message that arrives a few times a day.
function readCmd() {
  fs.promises.readFile(CMD_PATH, 'utf8').then(raw => {
    const cmd = raw.trim()
    if (!cmd) return
    // The dedup check used to come BEFORE the clear, so a repeated command --
    // "next" twice -- returned early with the file still full, and every later
    // poll re-read the same value and ignored it again. The command stayed
    // stuck until a DIFFERENT one arrived: pressing next twice from the
    // extension advanced one track. Clear first, always.
    return fs.promises.writeFile(CMD_PATH, '').then(() => {
      // Dedup on the payload can only ever mean "the same key pressed twice",
      // which is a thing users do. What must not happen is one write being
      // delivered twice, and clearing the file above is what prevents that --
      // the watcher and the poll can both fire for one write, and the second
      // reader finds it empty.
      safeSend('ext-cmd', cmd)
    })
  }).catch(e => {
    if (e && e.code === 'ENOENT') return   // not written yet; nothing to report
    console.error('[papa] read-cmd:', e.message || e)
  })
}

let _cmdWatcher = null
function watchCmd() {
  // fs.watch is not reliable on every filesystem — network mounts and some
  // overlays never fire — so a slow poll stays as a backstop. 5 s instead of
  // 200 ms is a 25x reduction even where the watcher does nothing at all.
  try {
    _cmdWatcher = fs.watch(CMD_PATH, { persistent: false }, () => readCmd())
    _cmdWatcher.on('error', e => {
      console.error('[papa] cmd watcher failed, falling back to polling:', e.message || e)
      try { _cmdWatcher.close() } catch (_) {}
      _cmdWatcher = null
    })
  } catch (e) {
    console.error('[papa] could not watch the command file:', e.message || e)
  }
  const backstop = setInterval(readCmd, 5000)
  backstop.unref?.()
  readCmd()
}

function cleanupOldFiles() {
  var logsDir = path.join(app.getPath('userData'), 'logs')
  var cacheDir = path.join(app.getPath('userData'), 'yt-cache')

  try {
    if (fs.existsSync(logsDir)) {
      var cutoff = Date.now() - 30 * 86400000
      fs.readdirSync(logsDir).forEach(function(f) {
        var p = path.join(logsDir, f)
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p)
      })
    }
  } catch (_) {}

  try {
    if (fs.existsSync(cacheDir)) {
      var cutoff = Date.now() - 7 * 86400000
      fs.readdirSync(cacheDir).forEach(function(f) {
        var p = path.join(cacheDir, f)
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p) } catch (_) {}
      })
    }
  } catch (_) {}

  try {
    var artDir = path.join(app.getPath('userData'), 'artwork')
    if (fs.existsSync(artDir)) {
      var files = fs.readdirSync(artDir).map(function(f) {
        var p = path.join(artDir, f)
        return { path: p, mtime: fs.statSync(p).mtimeMs }
      }).sort(function(a, b) { return a.mtime - b.mtime })
      if (files.length > 500) {
        files.slice(0, files.length - 500).forEach(function(f) { fs.unlinkSync(f.path) })
      }
    }
  } catch (_) {}
}

app.whenReady().then(() => {
  // Racy on its own: when the previous instance is still shutting down, its pid
  // is briefly still alive, pidAlive() says "still someone's", and the mpv it
  // already spawned is skipped -- so it keeps playing forever with no window.
  // That is exactly the orphan the user hit. Re-check a few seconds later, by
  // which point any dying predecessor is really gone. Also catches an mpv
  // orphaned by a SIGKILL, which no shutdown handler can ever clean up.
  // Fire and forget, as before: nothing waits on the reaper.
  reapOrphanedMpv().catch(e => console.error('[papa] reap failed:', e && e.message))
  setTimeout(() => reapOrphanedMpv().catch(() => {}), 5000).unref?.()

  // Streamed video is deleted when its stream stops, but a crash or a SIGKILL
  // leaves it behind — and on this machine the system temp directory is a
  // tmpfs, so orphaned streams consume RAM until the disk is full and nothing
  // can play at all. Sweep them at startup, skipping any still owned by a
  // running process.
  try {
    // Settle the cache location before sweeping, so the sweep covers the place
    // the cache is actually going as well as the one it used to.
    const wanted = _videoSettings().streamCacheDir || ''
    const active = setStreamRoot(wanted)
    if (wanted && active !== wanted) {
      console.warn(`[papa-video] stream cache ${wanted} is not writable; falling back to ${active}`)
    } else if (wanted) {
      console.log(`[papa-video] stream cache: ${active}`)
    }
    const swept = purgeOrphanStreams()
    if (swept.removed) {
      console.log(`[papa-video] removed ${swept.removed} orphaned stream cache(s), ` +
        `${(swept.bytes / 1073741824).toFixed(2)} GB reclaimed`)
    }
  // Same problem, other resource: an mpv from a killed instance keeps playing
  // and keeps an audio device, so the user hears one process while the app's
  // controls drive another.
  purgeOrphanPlayers()
    .then(r => {
      if (r.quit || r.stale) {
        console.log(`[papa-video] stopped ${r.quit} orphaned player(s), cleared ${r.stale} stale socket(s)`)
      }
    })
    .catch(e => console.error('[papa-video] player sweep failed:', e && e.message))
  } catch (e) {
    console.error('[papa-video] stream cache sweep failed:', e && e.message)
  }
  setTimeout(() => reapOrphanedMpv().catch(() => {}), 30000).unref?.()
  const hidden = process.argv.includes('--hidden')
  artworkDir = path.join(USER_DATA, 'artwork')
  fs.mkdirSync(artworkDir, { recursive: true })
  cleanupOldFiles()

  installFileLogging(path.join(app.getPath('userData'), 'logs'))
  try { fs.writeFileSync(CMD_PATH, '') } catch (_) {}
  watchCmd()
  // YT client: session-data cache + cookie-auth restore. Leftover OAuth
  // credentials from the abandoned device-flow must be purged — they 400
  // every YT Music request.
  ytSearch.setCacheDir(path.join(USER_DATA, 'yt-cache'))
  ytSearch.purgeStaleOauth()
  const ytCookie = store.get('ytCookie', null)
  if (ytCookie) ytSearch.setCookie(ytCookie)
  // Keep the Google session alive: silently touch music.youtube.com so cookies
  // rotate/extend like in a normal browser, then re-store the fresh set.
  setTimeout(async () => {
    try {
      if (await validateYtCookie()) return
      console.warn('[papa][yt] the stored cookie did not validate; refreshing')
      const ok = await refreshYtCookie()
      // A silent failure here is the reason YouTube features stop working, and
      // it was behind a bare setTimeout with no surfaced outcome at all.
      if (ok === false) {
        console.error('[papa][yt] cookie refresh failed — YouTube features will not work until you sign in again')
        safeSend('yt-auth-pending', { reason: 'cookie-refresh-failed' })
      }
    } catch (e) {
      console.error('[papa][yt] cookie validation threw:', summariseYtError(e))
    }
  }, 8000)
  setInterval(async () => {
    try {
      const ok = await refreshYtCookie()
      if (ok === false) console.error('[papa][yt] scheduled cookie refresh failed')
    } catch (e) {
      console.error('[papa][yt] scheduled cookie refresh threw:', summariseYtError(e))
    }
  }, 12 * 60 * 60 * 1000)

  // Album ids are md5(albumKeyOf(track)), and albumKeyOf now trims. Any album
  // whose tags carried padding gets a NEW id, so its artwork file and every
  // id-keyed piece of state has to follow it or the album loses its cover.
  try { migrateAlbumKeys() } catch (e) {
    console.error('[papa][albumkey] migration failed; ids left as they were:', e && e.message)
  }

  // Before the window opens: the statistics it draws are about to change.
  try { _historyReport = migratePlayHistory() } catch (e) {
    console.error('[papa][history] migration failed; history left exactly as it was:', e && e.message)
  }

  // Store schema versioning (App §96). A marker file records the schema version
  // this profile's on-disk stores were last written under. There are no
  // migrations yet — this is just the scaffolding. The one thing it does today
  // is detect a DOWNGRADE: if the marker holds a version NEWER than this build
  // knows, the user has run a newer Papa Audio against this data and then gone
  // back, and an older build silently mis-reading a newer store's shape is how
  // data gets quietly corrupted. We do not refuse to run — we log loudly so the
  // problem is on the record if something later looks wrong.
  try { checkStoreSchemaVersion() } catch (e) {
    console.error('[papa][schema] version check failed harmlessly:', e && e.message)
  }

  // Crash recovery: detect if previous session ended ungracefully
  const wasCleanShutdown = store.get('cleanShutdown', true)
  store.set('cleanShutdown', false)

  createWindow(hidden)
  if (!wasCleanShutdown) {
    mainWindow.webContents.on('did-finish-load', () => {
      safeSend('app-recovered-from-crash')
    })
  }
  initMpris()          // MPRIS D-Bus first; media-key grab only as fallback
  initPlayer()
  createTray()
  setupLibraryWatcher()
  // Item 56: a startup failure used to be discarded entirely, so a daemon that
  // never came up looked identical to one that was never installed.
  if (fs.existsSync(SLSKD_BIN)) {
    startSlskd().catch(e => console.error('[papa] slskd failed to start at launch:', String(e && e.message || e)))
  }
  // Auto-restart monitoring: ping slskd every 60s; restart after 3 consecutive failures
  setInterval(async () => {
    try {
      await slskdFetch('GET', '/session')
      _slskdFailures = 0
      safeSend('slskd-status-change', { connected: true, restarting: false })
    } catch (e) {
      // Being rate-limited is the opposite problem to being unhealthy: one needs
      // patience, the other a restart. Counting a 429 as a failure meant that
      // throttling got the daemon restarted, losing every in-flight transfer and
      // then hammering it again from a cold start.
      if (e && e.code === 'SLSKD_THROTTLED') {
        console.log('[papa] slskd health check skipped: it is rate-limiting us, which is not a fault')
        safeSend('slskd-status-change', { connected: true, restarting: false, throttled: true })
        return
      }
      _slskdFailures++
      if (_slskdFailures >= 3) {
        safeSend('slskd-status-change', { connected: false, restarting: true })
        try {
          await startSlskd()
          _slskdFailures = 0
          console.log('[papa] slskd restarted after 3 failed health checks')
        } catch (e) {
          // A restart that fails leaves downloads dead with the UI still saying
          // "restarting". Say so, and let the counter keep climbing so the next
          // cycle tries again rather than believing it succeeded.
          console.error('[papa] slskd restart failed:', String(e && e.message || e))
          safeSend('slskd-status-change', { connected: false, restarting: false })
        }
      } else {
        safeSend('slskd-status-change', { connected: false, restarting: false })
      }
    }
  }, 60000)
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json')
    if (fs.existsSync(configPath)) fs.chmodSync(configPath, 0o600)
  } catch (_) {}

  // The wishlist auto-download engine (slskWishlistSweep, defined at module
  // level alongside the scheduler) hunts each entry, scores the results the way
  // the grid does and enqueues a clear album on its own. First sweep waits out
  // the launch stampede AND slskd's own connect — a sweep against a daemon that
  // has not logged in yet finds nothing — then it repeats on a slow cadence.
  setTimeout(() => { slskWishlistSweep().catch(() => {}) }, WISHLIST_FIRST_SWEEP_MS)
  slskWishlistTimer = setInterval(() => { slskWishlistSweep().catch(() => {}) }, WISHLIST_SWEEP_EVERY_MS)
  if (slskWishlistTimer.unref) slskWishlistTimer.unref()

  startConnectivityMonitor()
  startAutoBackup()
  startScheduledBackup()

  // Air-date notifications (roadmap #35): first check after the launch stampede
  // and after slskd/network settle, then every 6h. Fire-and-forget; a failed
  // check just waits for the next tick.
  setTimeout(() => { checkAiringNotifications().catch(() => {}) }, 20000).unref?.()
  const airingTimer = setInterval(() => { checkAiringNotifications().catch(() => {}) }, AIRING_CHECK_EVERY_MS)
  if (airingTimer.unref) airingTimer.unref()
})

// ── Offline detection (App §11) ──────────────────────────────────────────────
// The main process cannot listen for the renderer's 'online'/'offline' events —
// those live on window/navigator, not here — so instead it probes a reliable
// endpoint on a slow cadence and tells the renderer when the answer changes.
// Two guards keep it from flapping: a 5 s timeout so a slow probe is treated as
// down, and a two-in-a-row rule so a single blip never flips the banner. The
// renderer draws the banner; main only reports the transition.
let _onlineState = null          // null until the first pair of probes settles it
let _lastProbe = null            // the previous single result, for the "two in a row" rule
const CONNECTIVITY_PROBE_HOST = 'www.gstatic.com'
const CONNECTIVITY_PROBE_PATH = '/generate_204'  // 204, tiny, no body — a classic reachability check
const CONNECTIVITY_PROBE_TIMEOUT_MS = 5000
const CONNECTIVITY_PROBE_INTERVAL_MS = 60000

function _probeOnce() {
  return new Promise((resolve) => {
    let settled = false
    const done = (up) => { if (!settled) { settled = true; resolve(up) } }
    try {
      const req = https.request({
        method: 'HEAD',
        host: CONNECTIVITY_PROBE_HOST,
        path: CONNECTIVITY_PROBE_PATH,
        timeout: CONNECTIVITY_PROBE_TIMEOUT_MS,
      }, (res) => {
        res.resume()  // drain, so the socket is not held open
        done(true)    // any response at all means the network answered
      })
      req.on('timeout', () => { req.destroy(); done(false) })
      req.on('error', () => done(false))
      req.end()
    } catch (_) { done(false) }
  })
}

async function _checkConnectivity() {
  const up = await _probeOnce()
  // Only a result that matches the previous one is allowed to flip the state,
  // so a lone failed probe on an otherwise-fine connection is ignored.
  if (_lastProbe === up && _onlineState !== up) {
    _onlineState = up
    safeSend('app-online-state', { online: up })
    console.log(`[papa] connectivity: now ${up ? 'online' : 'offline'}`)
  } else if (_onlineState === null && _lastProbe === up) {
    // First settled reading: adopt it silently so the renderer starts in the
    // right state without a spurious "transition".
    _onlineState = up
    safeSend('app-online-state', { online: up })
  }
  _lastProbe = up
}

function startConnectivityMonitor() {
  // Fire the first probe shortly after startup settles, not during the launch
  // stampede, then keep it on a slow interval.
  setTimeout(() => { _checkConnectivity().catch(() => {}) }, 10000).unref?.()
  setInterval(() => { _checkConnectivity().catch(() => {}) }, CONNECTIVITY_PROBE_INTERVAL_MS)
}

// ── Auto-backups (App §4) ────────────────────────────────────────────────────
// Once per app launch, after startup has settled, write a full rotating backup
// of every store to USER_DATA/backups/backup-<ISO date>/ and keep only the 7
// newest. Reuses the same bundling routine the manual export uses, so the two
// can never drift. Nothing here may throw or block startup: a failed backup
// logs one line and is otherwise invisible.
const AUTO_BACKUP_KEEP = 7
const AUTO_BACKUP_DELAY_MS = 30000

function _runAutoBackup() {
  const root = path.join(USER_DATA, 'backups')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(root, `backup-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })

  // One JSON blob with the whole bundle — same shape as a manual export, so it
  // can be handed straight to papa-import-all if it is ever needed. The
  // video-store blob is one of the sideStores, so it rides along in `stores`.
  const payload = _buildBackupPayload()
  fs.writeFileSync(path.join(dir, 'papa-backup.json'), JSON.stringify(payload), 'utf8')

  // Rotate: keep the newest AUTO_BACKUP_KEEP backup directories, delete older.
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('backup-'))
      .map(e => e.name)
      .sort()  // ISO stamps sort chronologically as strings
  } catch (_) { entries = [] }
  const stale = entries.slice(0, Math.max(0, entries.length - AUTO_BACKUP_KEEP))
  for (const name of stale) {
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }) } catch (_) { /* best effort */ }
  }
  return { dir, kept: Math.min(entries.length, AUTO_BACKUP_KEEP) }
}

function startAutoBackup() {
  setTimeout(() => {
    try {
      const r = _runAutoBackup()
      console.log(`[papa] auto-backup written to ${r.dir} (${r.kept} kept)`)
    } catch (e) {
      console.error('[papa] auto-backup failed:', (e && e.message) || String(e))
    }
  }, AUTO_BACKUP_DELAY_MS).unref?.()
}

// ── Scheduled backup to Documents (App #23) ──────────────────────────────────
// Distinct from the in-app auto-backup above (which lives under USER_DATA and is
// housekeeping the user never sees). This is the user-facing, opt-in schedule:
// a full export dropped into ~/Documents/PapaAudioBackups/ every N days, keeping
// the newest few, so a restore point exists outside the app profile. Off by
// default (backupIntervalDays = 0). papaBackupNow() runs one on demand;
// papaBackupStatus() reports the interval, the last run and what is on disk.
function _scheduledBackupDir() {
  return path.join(app.getPath('documents'), 'PapaAudioBackups')
}

// Write one dated backup file into the Documents folder and rotate to the newest
// backupSchedule.KEEP. Returns { path, kept }. Throws on a real write failure so
// callers can report it; the caller decides whether that is fatal.
function _runScheduledBackup() {
  const dir = _scheduledBackupDir()
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `papa-backup-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(_buildBackupPayload(), null, 2), 'utf8')

  // Rotate: keep the newest backupSchedule.KEEP files, delete the rest. The
  // stale set is decided by the pure policy (oldest-first, ISO-name sort).
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /^papa-backup-.*\.json$/.test(e.name))
      .map(e => e.name)
  } catch (_) { names = [] }
  for (const name of backupSchedule.staleBackups(names, backupSchedule.KEEP)) {
    try { fs.rmSync(path.join(dir, name), { force: true }) } catch (_) { /* best effort */ }
  }
  const kept = Math.min(names.length, backupSchedule.KEEP)
  return { path: file, kept }
}

// Run a scheduled backup only if one is due, recording lastBackupAt on success.
// Best-effort and silent on the not-due path. Returns a small status object.
function _maybeRunScheduledBackup() {
  const intervalDays = store.get('backupIntervalDays', 0)
  const lastBackupAt = store.get('lastBackupAt', 0)
  if (!backupSchedule.isBackupDue({ intervalDays, lastBackupAt, now: Date.now() })) {
    return { ran: false }
  }
  try {
    const r = _runScheduledBackup()
    store.set('lastBackupAt', Date.now())
    console.log(`[papa] scheduled backup written to ${r.path} (${r.kept} kept)`)
    return { ran: true, path: r.path, kept: r.kept }
  } catch (e) {
    console.error('[papa] scheduled backup failed:', (e && e.message) || String(e))
    return { ran: false, error: (e && e.message) || String(e) }
  }
}

function startScheduledBackup() {
  // On the same delayed startup tick as the auto-backup, so neither competes
  // with the launch stampede. Only runs if the interval says it is due.
  setTimeout(() => { _maybeRunScheduledBackup() }, AUTO_BACKUP_DELAY_MS).unref?.()
}

// mpv is spawned as a plain child, so it dies with a graceful quit (will-quit
// calls player.stop()). It does NOT die if this process is killed abruptly --
// a crash, an OOM, or kill -9 -- and mpv then keeps playing audio forever with
// no window left to stop it. Two guards:
//
//   1. Catch the signals that CAN be caught, and shut the player down properly.
//   2. On startup, reap any mpv left behind by a previous run. Our socket names
//      embed the owning Electron pid, so an orphan is identifiable: the pid in
//      the name is no longer alive.
//
// SIGKILL cannot be caught by anyone, so (2) is what actually covers it -- the
// stale player is stopped the next time the app starts.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// Must stay in step with the name mpv-engine.js generates. That used to be
// pid-then-counter; it is now pid-then-random-hex, and a reaper matching only
// digits would silently never reap anything again. test/mpv-socket-name.test.js
// asserts the two agree.
const MPV_SOCK_RE = /^papa-mpv-(\d+)-[0-9a-f]+\.sock$/

async function reapOrphanedMpv() {
  if (process.platform === 'win32') return
  const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir()
  let entries = []
  try { entries = await fs.promises.readdir(runtimeDir) } catch (_) { return }
  const socks = entries.filter(f => MPV_SOCK_RE.test(f))
  if (!socks.length) return

  let running = ''
  // `ps` on the main thread is only ~20 ms, but it is 20 ms of the thread that
  // drives mpv, three times per launch, for no reason.
  try { running = await run('ps', ['-eo', 'pid,args'], 10000) } catch (_) {}

  for (const f of socks) {
    const owner = Number((f.match(MPV_SOCK_RE) || [])[1])
    if (!owner || owner === process.pid || pidAlive(owner)) continue   // still someone's
    const full = path.join(runtimeDir, f)
    for (const line of running.split('\n')) {
      if (line.includes(full) && /\bmpv\b/.test(line)) {
        const pid = Number(line.trim().split(/\s+/)[0])
        if (pid) { try { process.kill(pid, 'SIGKILL') } catch (_) {} }
      }
    }
    try { await fs.promises.unlink(full) } catch (_) {}
  }
}

let _signalShutdown = false
function shutdownFromSignal() {
  if (_signalShutdown) return
  _signalShutdown = true
  // Do the will-quit work by hand: app.exit() skips those handlers, and
  // app.quit() is cancellable and can stall, which left the process alive
  // while mpv had already been stopped.
  try { player?.stop() } catch (_) {}
  // will-quit tears the video side down for the same reason: without this, a
  // signal shutdown mid-film left the video mpv playing on as an orphan and
  // the torrent stream running until the next launch reaped them.
  try { _videoTeardown() } catch (_) {}
  try { stopSlskd() } catch (_) {}
  try { store.set('cleanShutdown', true) } catch (_) {}
  flushSideStores()
  flushLogSync()
  try { if (fs.existsSync(NOW_PLAYING_PATH)) fs.unlinkSync(NOW_PLAYING_PATH) } catch (_) {}
  try { globalShortcut.unregisterAll() } catch (_) {}
  // Continue Watching (video-store.js) lives in the renderer's localStorage,
  // which Chromium commits to disk on its own delayed timer rather than
  // synchronously on write. app.exit() below kills the process before that
  // timer would normally fire, so force the flush and give it a moment.
  try { session.defaultSession.flushStorageData() } catch (_) {}
  setTimeout(() => { try { app.exit(0) } catch (_) {} }, 200)
  // Deliberately NOT unref'd: an unref'd timer will not fire if Electron's
  // main loop stops pumping Node timers, which is exactly the case here.
  setTimeout(() => process.exit(0), 500)
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, shutdownFromSignal)

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  app.isQuitting = true
  store.set('cleanShutdown', true)
})
app.on('will-quit', () => {
  player?.stop()
  // The video mpv is a separate child process from the music one, and a live
  // torrent stream keeps a socket server open. Neither is reached by
  // player.stop(), so quitting used to leave both behind.
  try { _videoTeardown() } catch (_) {}
  stopSlskd()
  // Continue Watching (video-store.js) lives in the renderer's localStorage,
  // which Chromium commits to disk on its own delayed timer rather than
  // synchronously on write; force that flush before the process goes away.
  try { session.defaultSession.flushStorageData() } catch (_) {}
  flushSideStores()
  flushLogSync()
  // Before the unlink, or a write still in flight recreates the file.
  stopNowPlayingWrites()
  try { if (fs.existsSync(NOW_PLAYING_PATH)) fs.unlinkSync(NOW_PLAYING_PATH) } catch (_) {}
  try { if (fs.existsSync(NOW_PLAYING_PATH + '.tmp')) fs.unlinkSync(NOW_PLAYING_PATH + '.tmp') } catch (_) {}
  globalShortcut.unregisterAll()
})

// Given a saved window rectangle and the list of display work areas, return a
// rectangle that is actually reachable on one of them. A monitor unplugged
// since last run leaves x/y pointing into a void; without this the window
// restores off-screen with no way to drag it back. Pure so it can be tested
// without Electron: pass the work areas in, get bounds out. Returns null when
// there is nothing worth restoring (no saved size), so the caller falls back
// to its defaults.
function _clampWindowState(saved, workAreas, defaults) {
  const def = defaults || { width: 1400, height: 900 }
  const minW = (defaults && defaults.minWidth)  || 950
  const minH = (defaults && defaults.minHeight) || 650
  if (!saved || !saved.width || !saved.height) return null
  const areas = Array.isArray(workAreas) ? workAreas.filter(Boolean) : []
  // Never restore a window bigger than the largest display it might land on;
  // and honour the app's own floor.
  const maxW = areas.reduce((m, a) => Math.max(m, a.width), 0) || def.width
  const maxH = areas.reduce((m, a) => Math.max(m, a.height), 0) || def.height
  const width  = Math.max(minW, Math.min(saved.width,  maxW))
  const height = Math.max(minH, Math.min(saved.height, maxH))
  const out = { width, height, maximized: !!saved.maximized }
  // No stored position (first run at a size, or size-only save): let the OS
  // centre it. A position only counts if we have both coordinates.
  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return out
  // A position is visible if any part of the title-bar band would sit inside a
  // display's work area. If none does, the display it was on is gone; drop the
  // position and let the OS place it.
  const BAND = 48   // enough of the top edge to grab with a cursor
  const visibleOn = areas.find(a =>
    saved.x + width  > a.x + 8 &&
    saved.x < a.x + a.width - 8 &&
    saved.y + BAND   > a.y &&
    saved.y < a.y + a.height - 8)
  if (!visibleOn) return out
  // On its display but partly past an edge (a smaller monitor now): pull it
  // fully back inside that display's work area.
  const x = Math.max(visibleOn.x, Math.min(saved.x, visibleOn.x + visibleOn.width  - width))
  const y = Math.max(visibleOn.y, Math.min(saved.y, visibleOn.y + visibleOn.height - height))
  out.x = x
  out.y = y
  return out
}

function createWindow(hidden = false) {
  const savedWin = sideStores.windowState.get() || {}
  const workAreas = (() => {
    try { return screen.getAllDisplays().map(d => d.workArea) }
    catch (_) { return [] }
  })()
  const winState = _clampWindowState(savedWin, workAreas,
    { width: 1400, height: 900, minWidth: 950, minHeight: 650 }) || {}
  mainWindow = new BrowserWindow({
    width:  winState.width  || 1400,
    height: winState.height || 900,
    x: winState.x,
    y: winState.y,
    minWidth: 950, minHeight: 650,
    backgroundColor: '#121212',
    frame: false,
    icon: ICON_PATH,
    show: !hidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,   // slow down timers/rAF when window is hidden/minimized
    }
  })
  if (winState.maximized) mainWindow.maximize()
  // Absolute, from this file. loadFile resolves a relative path against
  // app.getAppPath(), which is the directory of whatever script Electron was
  // launched with -- so running the soak harness (tools/video-soak.js) made
  // this look for tools/src/index.html, the renderer never loaded, and every
  // measurement the harness took was of a blank window.
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))
  // Keep the embedded video window glued to its stage rectangle when the app
  // is moved, resized or fullscreened.
  _rebindVideoFollow()

  // On this machine Electron gets no hardware acceleration, so Chromium
  // composites with SwiftShader on the CPU. Any perpetual CSS animation - the
  // spinning vinyl, the EQ bars, shimmer placeholders - then holds a core at
  // ~100% for as long as the app is open, even buried behind a fullscreen
  // game. Chromium's own background throttling does not help: KWin does not
  // always report the window occluded, so it keeps painting at full rate.
  //
  // Pausing animations whenever the window loses focus costs nothing visually
  // - nobody is looking at it - and hands the CPU back to whatever is.
  const setFocused = (on) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    safeSend('window-focus', on)
  }
  mainWindow.on('focus',   () => setFocused(true))
  mainWindow.on('blur',    () => setFocused(false))
  mainWindow.on('minimize',() => setFocused(false))
  mainWindow.on('restore', () => setFocused(true))

  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F12') mainWindow.webContents.openDevTools()
  })

  // electron-store .set() is a SYNCHRONOUS writeFileSync of the entire config,
  // and this config is ~2.5 MB (libraryCache alone is 1.4 MB). Electron emits
  // 'move' continuously while a window is dragged, so every frame of a drag was
  // serialising and fsync'ing 2.5 MB on the main process thread -- which also
  // owns the window message pump. That is the stutter when dragging, and it is
  // worst crossing between monitors, where the compositor emits a burst of
  // move+resize as it renegotiates the surface.
  //
  // Coalesce to one write after motion stops, and skip it when nothing moved.
  let _winSaveTimer = null
  let _lastWinJson = ''
  const saveWinState = () => {
    if (!mainWindow) return
    if (_winSaveTimer) clearTimeout(_winSaveTimer)
    _winSaveTimer = setTimeout(() => {
      _winSaveTimer = null
      if (!mainWindow || mainWindow.isDestroyed()) return
      try {
        const next = { ...mainWindow.getBounds(), maximized: mainWindow.isMaximized() }
        const json = JSON.stringify(next)
        if (json === _lastWinJson) return
        _lastWinJson = json
        sideStores.windowState.set(next)
      } catch (_) {}
    }, 400)
  }
  // Flush immediately when it actually matters -- a debounce that has not fired
  // must not lose the position on quit.
  const saveWinStateNow = () => {
    if (_winSaveTimer) { clearTimeout(_winSaveTimer); _winSaveTimer = null }
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      const next = { ...mainWindow.getBounds(), maximized: mainWindow.isMaximized() }
      _lastWinJson = JSON.stringify(next)
      sideStores.windowState.set(next)
    } catch (_) {}
  }
  // renderer-process-limit is 1, so if the renderer dies the user is left with a
  // blank frameless window, no controls and no explanation. Say what happened
  // and offer the reload rather than requiring a force-quit.
  // A new renderer has not missed anything; it simply was not there.
  mainWindow.webContents.on('did-start-loading', () => resetChannelSeq())

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    const reason = (details && details.reason) || 'unknown'
    console.error('[papa] renderer gone:', reason)
    if (reason === 'clean-exit') return
    // Same plain-English record the main-process crash handlers write, so a
    // renderer crash lands in the one file the user is told to send.
    _appendCrashLog(`the window crashed (${reason})`,
      new Error(`render-process-gone: ${reason}` +
        (details && details.exitCode != null ? ` (exit ${details.exitCode})` : '')))
    const win = mainWindow
    const now = Date.now()
    _rendererCrashes = _rendererCrashes.filter(t => now - t < RENDERER_CRASH_WINDOW_MS)
    _rendererCrashes.push(now)
    // A page that crashes ON LOAD can be reloaded straight back into the same
    // crash, forever, one dialog at a time. Past the third in five minutes,
    // stop offering the reload as the default and say what is actually wrong.
    const looping = _rendererCrashes.length > MAX_RENDERER_CRASHES
    if (looping) {
      console.error(`[papa] renderer has crashed ${_rendererCrashes.length} times in ` +
        `${Math.round(RENDERER_CRASH_WINDOW_MS / 60000)} minutes; not offering a reload loop`)
    }
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'Papa Audio stopped responding',
      message: looping
        ? `The window has crashed ${_rendererCrashes.length} times in a few minutes (${reason}).`
        : 'The window crashed (' + reason + ').',
      detail: looping
        ? 'Reloading is putting it straight back into the same crash. Playback is handled by mpv and ' +
          'may still be running. The daily log in ~/.config/papa-audio/logs has the reason.'
        : 'Playback is handled by mpv and may still be running. Reload to get the window back.',
      buttons: looping ? ['Close', 'Reload anyway'] : ['Reload', 'Close'],
      defaultId: 0,
    }).then((r) => {
      const wantsReload = looping ? r.response === 1 : r.response === 0
      if (wantsReload && win && !win.isDestroyed()) win.reload()
      else if (win && !win.isDestroyed()) win.close()
    }).catch(() => {})
  })

  mainWindow.on('resize', () => { saveWinState() })
  mainWindow.on('move', saveWinState)
  // Maximizing or restoring may not move or resize the frame in a way that
  // fires 'resize' first (some WMs snap without an intermediate bounds change),
  // so the maximized flag could otherwise never be recorded.
  mainWindow.on('maximize', saveWinState)
  mainWindow.on('unmaximize', saveWinState)
  mainWindow.on('close', async (e) => {
    saveWinStateNow()
    if (!app.isQuitting && store.get('closeToTray', true) && tray) {
      e.preventDefault()
      mainWindow.hide()
      return
    }
    if (app.isQuitting) { player?.stop(); return }
    try {
      // Was `executeJavaScript('state.isPlaying')`. If the renderer reloaded or
      // died in that window the call rejected into the catch below, which
      // silently closed the app — skipping this confirmation during active
      // playback. main already knows: the engine's own paused property arrives
      // here as a player event, and mpv is the authority on it anyway.
      const isPlaying = playerIsPlaying()
      if (isPlaying) {
        e.preventDefault()
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['Close anyway', 'Cancel'],
          defaultId: 1,
          title: 'Music is playing',
          message: 'Music is still playing. Close anyway?',
        })
        if (response === 0) {
          player?.stop()
          app.isQuitting = true
          mainWindow.removeAllListeners('close')
          mainWindow.close()
        }
      }
    } catch (_) { player?.stop() }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerMediaKeys() {
  globalShortcut.register('MediaPlayPause',     () => safeSend('media-key', 'play-pause'))
  globalShortcut.register('MediaNextTrack',     () => safeSend('media-key', 'next'))
  globalShortcut.register('MediaPreviousTrack', () => safeSend('media-key', 'prev'))
}

// ── mpv player engine ─────────────────────────────────────────────────────────
let player = null
let mpvAvailable = false

function getPlayerSettings() {
  return {
    outputMode: 'default', alsaDevice: null,
    mode: 'gapless', crossfadeSecs: 4, replaygain: 'no',
    // Non-destructive ReplayGain from the loudness map (App #59). OFF by default:
    // it only takes effect once the user has scanned their library and opted in.
    replaygainApply: false,
    channels: 'auto', boost: false,
    eq: eqDefaults(),
    ...store.get('playerSettings', {}),
  }
}

async function detectMpv() {
  try { await run('mpv', ['--version'], 5000); return true } catch { return false }
}

// One place that answers "is there a working engine, and is it playing?".
// Every entry point — the close confirmation, the media keys, the tray — used to
// answer this differently, and the truthy-player guard passed even when the
// client inside it was null.
// webContents.send throws if the window is gone, and during the close race that
// reached only the blanket uncaughtException handler. One of the four call sites
// was wrapped; the other three were not.
// A monotonic sequence per channel. A renderer that missed an event — because
// it was reloading, or because a send failed while the window was going away —
// had no way to know. With this it can see the gap and resync instead of quietly
// carrying stale state.
const _channelSeq = new Map()

function nextSeq(channel) {
  const n = (_channelSeq.get(channel) || 0) + 1
  _channelSeq.set(channel, n)
  return n
}

function safeSend(channel, payload) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    const wc = mainWindow.webContents
    if (!wc || wc.isDestroyed()) return false
    // The sequence rides alongside the payload rather than inside it, so no
    // existing consumer shape changes. preload strips it back off.
    wc.send(channel, payload, { seq: nextSeq(channel), session: SESSION_ID })
    return true
  } catch (e) {
    console.error(`[papa] could not send ${channel}:`, String(e && e.message || e))
    return false
  }
}

// A reload starts a fresh renderer with no idea what it missed, so the counters
// restart with it and the first event of each channel is seq 1 again.
function resetChannelSeq() { _channelSeq.clear() }

function playerReady() {
  return !!(player && mpvAvailable && player.alive !== false)
}

function playerIsPlaying() {
  if (!playerReady()) return false
  try {
    const st = player.getState()
    return !!(st && st.path && st.paused === false)
  } catch (_) { return false }
}

function sendPlayerEvent(type, data) {
  safeSend('player-event', { type, data })
}

function buildPlayer(cfg) {
  const engineConfig = {
    outputMode: cfg.outputMode, alsaDevice: cfg.alsaDevice,
    replaygain: cfg.replaygain, gapless: cfg.mode === 'gapless',
    audioChannels: cfg.channels,
    eq: cfg.eq,
  }
  const p = cfg.mode === 'crossfade'
    ? new MpvCrossfade({ crossfadeSecs: cfg.crossfadeSecs, engineOpts: { config: engineConfig } })
    : new MpvEngine({ config: engineConfig })
  p.on('position',     d => sendPlayerEvent('position', d))
  p.on('duration',     d => sendPlayerEvent('duration', d))
  p.on('paused',       d => { sendPlayerEvent('paused', d); refreshTrayTooltip() })
  p.on('audioParams',  d => sendPlayerEvent('audioParams', d))
  p.on('autoAdvanced', d => sendPlayerEvent('autoAdvanced', d))
  p.on('trackChanged', d => sendPlayerEvent('trackChanged', d))
  p.on('ended',        () => sendPlayerEvent('ended'))
  p.on('loadError',    d => sendPlayerEvent('loadError', d))
  // These four carry a payload now. engineDown says whether recovery is coming,
  // stopped names the end-file reason, engineRecovered says where it resumed,
  // and engineFailed says what actually failed instead of blaming a missing mpv.
  p.on('engineDown',      d => { sendPlayerEvent('engineDown', d); refreshTrayTooltip() })
  p.on('stopped',         d => sendPlayerEvent('stopped', d))
  p.on('engineRecovered', d => { sendPlayerEvent('engineRecovered', d); refreshTrayTooltip() })
  // Position stopped advancing while mpv says it is not paused. mpv itself is
  // asked what it thinks before this fires, so it is a finding, not a guess.
  p.on('stalled',         d => sendPlayerEvent('stalled', d))
  // The output device, specifically, as opposed to any other mpv complaint.
  p.on('audioDeviceLost', d => sendPlayerEvent('audioDeviceLost', d))
  p.on('audioDeviceFallback', d => sendPlayerEvent('audioDeviceFallback', d))
  p.on('engineFailed',    d => { sendPlayerEvent('engineFailed', d); refreshTrayTooltip(); onEngineFailed(d) })
  // The whole reason this exists: mpv's own diagnosis and the timeline around
  // it, on disk, at the moment it happens. console.error is already tee'd to
  // the daily log.
  p.on('diagnostic', d => {
    try { console.error(formatDiagnostic(d)) }
    catch (e) { console.error('[papa][engine] diagnostic format failed:', String(e && e.message || e)) }
  })
  return p
}

// The old player object stayed in place after engineFailed with alive=false and
// client=null, so every `if (!player)` guard passed — player was truthy — and
// then dereferenced a null client. Only a manual recheck ever recovered.
let _reinitTried = false

async function onEngineFailed(d) {
  const dead = player
  player = null
  try { dead?.stop() } catch (_) { /* it is already dead; this is hygiene */ }
  if (_reinitTried) {
    console.error('[papa] engine failed again after re-init; waiting for a manual recheck. reason:', d && d.reason)
    return
  }
  _reinitTried = true
  console.error('[papa] engine failed, attempting one supervised re-init. reason:', d && d.reason)
  await initPlayer()
  if (player) {
    console.log('[papa] engine re-initialised after failure')
    sendPlayerEvent('engineRestored', { after: (d && d.reason) || 'unknown' })
  }
}

async function initPlayer() {
  mpvAvailable = await detectMpv()
  if (!mpvAvailable) { sendPlayerEvent('mpvMissing'); return }
  player = buildPlayer(getPlayerSettings())
  try {
    await player.start()
    _reinitTried = false
  } catch (e) {
    console.error('mpv engine failed to start:', e)
    sendPlayerEvent('engineFailed', {
      reason: 'start-error',
      detail: String((e && e.message) || e),
      log: typeof player.getLogTail === 'function' ? player.getLogTail().slice(-20).map(l => l.text) : [],
    })
  }
}

const wrap = fn => async (...args) => {
  // `if (!player)` passed even when the client inside it was null, which is how
  // a media key or the tray could act on a dead engine and dereference it. The
  // engine's own commands raise a typed EngineGone for the same case; this
  // catches the entry points before they get that far.
  if (!playerReady()) return { ok: false, error: 'engine unavailable' }
  try { await fn(...args); return { ok: true } } catch (e) { return { ok: false, error: String(e.message || e) } }
}

// If the path is a YouTube watch URL, resolve to the direct audio stream first
// so mpv doesn't have to run yt-dlp itself — cuts playback startup from 2-10s to <1s.
async function _resolvePlayerPath(p) {
  var vid = extractVideoId(p)
  if (!vid) return p
  try {
    var url = await withTimeout(resolveYtUrl(vid), 12000, 'yt-url-resolve')
    if (url) { console.log('[papa] yt-resolved:', vid, '->', url.slice(0, 80)); return url }
  } catch (_) {
    console.log('[papa] yt-resolve-fail, falling back to raw URL:', vid)
  }
  return p // fallback: let mpv handle it
}

// ── Smart queues: audio feature analysis + queue building ────────────────────
// Its own side store, never the shared config — the library alone is 2.5 MB
// of playCounts/likedTracks and features would grow with every track analysed.
const featureStore = new SideStore({
  dir: USER_DATA, name: 'audio-features', fallback: { features: {} },
  onError: e => console.error('[features]', e.message),
})

let analysisRunning = false
// Guards against two overlapping resume timers ever existing at once — a run
// that halts twice in a row must not stack a second pending re-check on top
// of the first.
let analysisResumeTimer = null
const ANALYSIS_RESUME_DELAY_MS = 30000

function featureMap() {
  const raw = (featureStore.get() || {}).features || {}
  return new Map(Object.entries(raw))
}

// The library cache is an array of albums, each with a tracks array. Flatten
// it and carry the album's identity down onto each track. The cache records
// fileSize but no mtime, so change detection is by size plus FEATURE_VERSION
// (see analysis-runner's needsAnalysis). Supplying mtimeMs: 0 rather than
// undefined is load bearing: needsAnalysis compares Number(entry.mtimeMs) !==
// Number(track.mtimeMs), and undefined would compare as NaN !== NaN, which is
// always true — the whole library would look stale and re-analyse from
// scratch on every launch.
function allLibraryTracks() {
  const albums = sideStores.libraryCache.get() || []
  const out = []
  for (const album of albums) {
    for (const t of (album.tracks || [])) {
      out.push({
        ...t,
        artist: t.artist || album.artist || '',
        albumArtist: album.artist || '',
        albumName: album.name || '',
        albumId: album.id,
        artPath: album.artPath || null,
        channels: t.channels || 0,
        size: t.fileSize || 0,
        // The library cache records fileSize but no mtime. Change detection is by
        // size plus FEATURE_VERSION. Supplying 0 rather than undefined is load
        // bearing: needsAnalysis compares Number(mtimeMs), and NaN !== NaN would
        // make every track look stale and re-analyse the whole library every run.
        mtimeMs: 0,
      })
    }
  }
  return out
}

// The raw array from the play-history side store. buildAffinity and
// buildColdSet normalise it themselves — never read entry.ts directly here.
function readHistoryEntries() {
  return sideStores.playHistory.get() || []
}

ipcMain.handle('queue-analysis-status', async () => {
  const tracks = allLibraryTracks()
  return { analysed: featureMap().size, total: tracks.length, running: analysisRunning }
})

// Runs one analysis pass. If it halts because playback started (or the gate
// tripped for any other reason `runAnalysis` recognises), it is not done —
// it is paused. Schedule exactly one re-check to pick the pass back up once
// listening has stopped, rather than abandoning it silently. This is the
// only path allowed to (re)start a run, so `analysisRunning` stays accurate
// for the doubling-ffmpeg-load guard even across many pause/resume cycles.
function startAnalysisRun() {
  if (analysisRunning) return
  analysisRunning = true
  const tracks = allLibraryTracks()
  const trackByPath = new Map(tracks.map(t => [t.filePath, t]))
  // A 2,300-track library can take a long time end to end, and queue-analysis-
  // status reads straight off featureStore. Without persisting as each file
  // finishes, "analysed" would sit at 0 for the whole run (or the whole pause/
  // resume cycle) and only jump at the very end -- indistinguishable from the
  // gate being stuck. Write each result through immediately; SideStore
  // debounces the actual disk I/O, so this does not add write pressure.
  const persistOne = (filePath, r) => {
    const t = trackByPath.get(filePath)
    featureStore.update(v => {
      const features = { ...((v || {}).features || {}) }
      features[filePath] = {
        vector: r.vector, featureVersion: r.featureVersion,
        mtimeMs: t ? t.mtimeMs : 0, size: t ? t.size : 0,
      }
      return { features }
    })
  }
  runAnalysis({
    tracks,
    existing: featureMap(),
    isPlaying: () => Boolean(player && player.isActuallyPlaying && player.isActuallyPlaying()),
    analyseFn: async filePath => {
      const r = await analyseOne(filePath)
      if (r && r.ok) persistOne(filePath, r)
      return r
    },
    onProgress: p => safeSend('queue-analysis-progress', p),
  }).then(r => {
    featureStore.update(v => {
      const features = { ...((v || {}).features || {}) }
      for (const [fp, entry] of r.results) features[fp] = entry
      return { features }
    })
    analysisRunning = false
    safeSend('queue-analysis-progress', { done: r.analysed, total: tracks.length, finished: !r.halted, halted: r.halted })
    if (r.halted && !app.isQuitting && !analysisResumeTimer) {
      analysisResumeTimer = setTimeout(() => {
        analysisResumeTimer = null
        if (app.isQuitting) return
        startAnalysisRun()
      }, ANALYSIS_RESUME_DELAY_MS)
      analysisResumeTimer.unref?.()
    }
  }).catch(e => {
    analysisRunning = false
    console.error('[features] run failed:', e && e.message)
  })
}

ipcMain.handle('queue-analysis-start', async () => {
  if (analysisRunning) return { ok: true, alreadyRunning: true }
  startAnalysisRun()
  return { ok: true }
})

ipcMain.handle('queue-mixes', async () => {
  const tracks = allLibraryTracks()
  const vectors = new Map([...featureMap()].map(([fp, entry]) => [fp, entry.vector]))
  // Without features there are no clusters, so there are no mixes to name yet.
  // Returning an empty list lets the UI say so honestly rather than showing
  // cards that would all produce the same undifferentiated queue.
  if (!vectors.size) return { ok: true, featuresReady: false, mixes: [] }
  const c = clusterLibrary({ tracks, vectors, k: 5 })
  const sizes = new Map()
  for (const [, idx] of c.clusterOf) sizes.set(idx, (sizes.get(idx) || 0) + 1)
  const mixes = c.names
    .map((name, index) => ({ index, name, size: sizes.get(index) || 0 }))
    .filter(m => m.size > 0)
  return { ok: true, featuresReady: true, mixes }
})

ipcMain.handle('queue-build', async (_e, { mode = 'surprise', seedFilePath = null, mixIndex = null, length = 30 } = {}) => {
  const tracks = allLibraryTracks()
  const vectors = new Map([...featureMap()].map(([fp, entry]) => [fp, entry.vector]))
  const history = readHistoryEntries()
  const playCounts = store.get('playCounts', {})
  const affinity = buildAffinity({ history, playCounts, likedTracks: store.get('likedTracks', []) })
  const coldSet = mode === 'rediscover' ? buildColdSet({ history, playCounts }) : null
  let clusterOf = null, seedCluster = null
  if (mode === 'mix') {
    const c = clusterLibrary({ tracks, vectors, k: 5 })
    clusterOf = c.clusterOf
    seedCluster = Number.isInteger(mixIndex)
      ? mixIndex
      : (seedFilePath ? c.clusterOf.get(seedFilePath) ?? 0 : 0)
  }
  const seed = seedFilePath ? tracks.find(t => t.filePath === seedFilePath) : null
  const featuresReady = vectors.size > 0
  return { ok: true, featuresReady, tracks: buildQueue({ mode, seed, tracks, vectors, affinity, coldSet, clusterOf, seedCluster, length }) }
})


// ── Non-destructive ReplayGain (App #59) ──────────────────────────────────────
// The mpv volume the slider produces, before any per-track ReplayGain. mpv's
// softvol is cubic, so the linear 0–1 the renderer sends is mapped here the same
// way player-set-volume maps it. Defaults to full when the slider has not moved
// yet this session (linearToMpv(1) = 100, the neutral value).
function _baseMpvVolume() {
  var linear = (lastLinearVolume == null) ? 1 : lastLinearVolume
  return linearToMpv(linear, getPlayerSettings().boost)
}

// The file mpv currently has open, tracked so that when the slider moves we can
// re-apply that track's gain on top of the new base — otherwise moving the
// volume would wipe the ReplayGain until the next track change.
let _loudnessCurrentPath = null

// Fold a track's stored ReplayGain into mpv's volume. Off unless the user turned
// replaygainApply on. A track with no stored measurement (gainDb null) lands on
// the base volume unchanged, so an un-scanned library plays exactly as before.
function applyLoudnessGain(resolvedPath) {
  _loudnessCurrentPath = resolvedPath || null
  if (!player) return
  var base = _baseMpvVolume()
  var cfg = getPlayerSettings()
  if (!cfg.replaygainApply) {
    // Application is off: make sure the base volume (no gain) is what is in force,
    // in case a previous track left a gained value on mpv's volume property.
    return player.setVolume(base).catch(() => {})
  }
  var map = sideStores.loudnessMap.get() || {}
  var entry = resolvedPath ? map[resolvedPath] : null
  var gainDb = entry && typeof entry === 'object' ? entry.gainDb : null
  var vol = loudness.applyGainToMpvVolume(base, gainDb, MPV_MAX)
  return player.setVolume(vol).catch(() => {})
}

// Measure one file's integrated loudness with ffmpeg's ebur128 filter. Reads
// nothing, writes nothing to the file — the number goes to the loudness map.
// spawnFn is injectable for tests; the timeout stops one undecodable file from
// wedging a whole scan run.
function measureLoudness(filePath, { spawnFn = spawn, timeoutMs = 120000 } = {}) {
  return new Promise(resolve => {
    let done = false
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    let proc
    try {
      proc = spawnFn('ffmpeg', [
        '-hide_banner', '-nostats', '-nostdin',
        '-i', filePath,
        '-map', '0:a:0',
        '-af', 'ebur128=peak=true',
        '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      return finish({ ok: false, error: String(e && e.message || e) })
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: `timed out after ${timeoutMs}ms` })
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
    }, timeoutMs)
    let buf = ''
    proc.stderr.on('data', d => { buf += d.toString() })
    proc.on('error', e => finish({ ok: false, error: String(e && e.message || e) }))
    proc.on('close', code => {
      const lufs = loudness.parseIntegratedLufs(buf)
      if (lufs == null) return finish({ ok: false, error: code !== 0 ? `ffmpeg exit ${code}` : 'no loudness measured' })
      finish({ ok: true, lufs: lufs, gainDb: loudness.gainForLufs(lufs) })
    })
  })
}

// Scan a batch of files sequentially, storing each measurement in the loudness
// map. Bounded to `paths.length` files by the caller (20 per run). Emits nothing
// mid-run; the renderer polls the map after and shows progress from its own
// counter. Returns the per-file outcomes so the renderer can report scanned/total.
async function runLoudnessScan(paths) {
  var results = []
  for (var i = 0; i < paths.length; i++) {
    var fp = paths[i]
    var r = await measureLoudness(fp)
    if (r.ok) {
      sideStores.loudnessMap.update(function (m) {
        m = m || {}
        m[fp] = { lufs: r.lufs, gainDb: r.gainDb, at: Date.now() }
        return m
      })
    }
    results.push({ filePath: fp, ok: r.ok, lufs: r.ok ? r.lufs : null, gainDb: r.ok ? r.gainDb : null, error: r.ok ? null : r.error })
  }
  return results
}

// Scan up to 20 not-yet-measured local tracks from the library subset the
// renderer hands over. The renderer passes the file paths (it holds the library);
// main measures and stores. Returns { results, scanned } for a progress readout.
ipcMain.handle('loudness-scan', async (_, { paths } = {}) => {
  if (!Array.isArray(paths) || !paths.length) return { ok: true, results: [] }
  var batch = paths.slice(0, 20).filter(p => typeof p === 'string' && p && !/^https?:\/\//.test(p))
  var results = await runLoudnessScan(batch)
  return { ok: true, results: results }
})

// The stored loudness map, for the renderer to compute coverage and the album
// spread. Returned whole; it is small (a few numbers per track).
ipcMain.handle('loudness-get-map', () => ({ ok: true, map: sideStores.loudnessMap.get() || {} }))

ipcMain.handle('player-load',       async (_, { path: p, play }) => {
  var resolved = await _resolvePlayerPath(p)
  var r = await wrap(() => player.load(resolved, { play }))()
  // Non-destructive ReplayGain (App #59): after the file is open, fold its
  // stored gain into mpv's volume. mpv keeps its `volume` property across a
  // loadfile, so without this a per-track gain from a previous track would
  // linger; with it, each track lands at the target loudness. Off by default —
  // only runs when the user has turned replaygainApply on. A no-op for any track
  // not yet scanned (gainDb null → base volume unchanged).
  try { applyLoudnessGain(resolved) } catch (_) { /* cosmetic; never fails a load */ }
  return r
})
ipcMain.handle('player-set-next',   async (_, p) => {
  // Pre-warm the cache for the next track so it plays instantly
  var vid = extractVideoId(p)
  if (vid) resolveYtUrl(vid).catch(() => {})
  return wrap(() => player.setNext(p))()
})

// ── YouTube URL pre-resolution ────────────────────────────────────────────────
// Renderer can pre-resolve URLs in the background so they're cached when needed.
ipcMain.handle('pre-resolve-yt-urls', async (_, videoIds) => {
  if (!Array.isArray(videoIds)) return { ok: true }
  var promises = videoIds.slice(0, 5).map(vid => resolveYtUrl(vid).catch(() => null))
  await Promise.allSettled(promises)
  return { ok: true }
})
ipcMain.handle('player-play',       () => wrap(() => player.play())())
ipcMain.handle('player-pause',      () => wrap(() => player.pause())())
ipcMain.handle('player-switch',     async (_, path) => {
  // Swallowing the pause and loading anyway meant switching against a client
  // that had just been nulled: the load then failed too, and the renderer saw
  // one opaque failure instead of "the engine is gone".
  if (!player) return { ok: false, error: 'engine unavailable' }
  try {
    await player.pause()
  } catch (e) {
    console.error('[papa] switch aborted: pause failed:', String(e && e.message || e))
    return { ok: false, error: `could not pause before switching: ${String(e && e.message || e)}` }
  }
  var resolved = await _resolvePlayerPath(path)
  var r = await wrap(() => player.load(resolved, { play: true }))()
  try { applyLoudnessGain(resolved) } catch (_) { /* cosmetic; never fails a switch */ }
  return r
})
ipcMain.handle('player-seek',       (_, s) => wrap(() => player.seek(s))())
// Renderer sends linear 0–100 (HTMLAudioElement semantics); mpv softvol is
// cubic, so convert or everything below max plays several dB too quiet.
let lastLinearVolume = null
ipcMain.handle('player-set-volume', (_, v) => wrap(() => {
  lastLinearVolume = v / 100
  var cfg = getPlayerSettings()
  var base = linearToMpv(lastLinearVolume, cfg.boost)
  // With ReplayGain application on, the slider still means "how loud overall",
  // but the current track's gain rides on top so moving the slider does not lose
  // the per-track correction until the next track change.
  if (cfg.replaygainApply && _loudnessCurrentPath) {
    var map = sideStores.loudnessMap.get() || {}
    var entry = map[_loudnessCurrentPath]
    var gainDb = entry && typeof entry === 'object' ? entry.gainDb : null
    return player.setVolume(loudness.applyGainToMpvVolume(base, gainDb, MPV_MAX))
  }
  return player.setVolume(base)
})())
ipcMain.handle('player-set-speed',  (_, x) => wrap(() => player.setSpeed(x))())
ipcMain.handle('player-get-status', () => ({
  available: mpvAvailable && !!player,
  // Reported separately so the UI can tell "mpv is missing" apart from "mpv is
  // here and would not start" instead of showing install instructions for both.
  mpvAvailable,
  state: player ? player.getState() : null,
  config: getPlayerSettings(),
}))
ipcMain.handle('player-recheck', async () => {
  if (player) { player.stop(); player = null }
  // An explicit ask from the user re-arms the one automatic re-init attempt.
  _reinitTried = false
  await initPlayer()
  return { available: mpvAvailable && !!player }
})
ipcMain.handle('player-get-config', () => getPlayerSettings())

// W2-UI contract: mpvAbLoop({a,b}|null). A–B loop repeat (roadmap #5) on the
// MUSIC engine. null clears the loop; {a,b} in seconds sets it. mpv's native
// ab-loop-a/ab-loop-b properties do the work (see mpv-engine.setAbLoop).
ipcMain.handle('mpv-ab-loop', async (_, range) => {
  if (!playerReady()) return { ok: false, error: 'engine unavailable' }
  try { return await player.setAbLoop(range || null) }
  catch (e) { return { ok: false, error: String(e.message || e) } }
})

// W2-UI contract: mpvReplaygainMode('track'|'album'|'off'). Sets ReplayGain on
// the MUSIC engine at runtime AND persists it into playerSettings so the next
// spawn uses it (the engine folds config.replaygain into its spawn args). 'off'
// maps to mpv's 'no'.
ipcMain.handle('mpv-replaygain-mode', async (_, mode) => {
  const mpvMode = mode === 'track' ? 'track' : mode === 'album' ? 'album' : 'no'
  const cfg = { ...getPlayerSettings(), replaygain: mpvMode }
  store.set('playerSettings', cfg)
  if (!playerReady()) return { ok: false, error: 'engine unavailable', mode: mpvMode }
  try { await player.setReplaygain(mpvMode); return { ok: true, mode: mpvMode } }
  catch (e) { return { ok: false, error: String(e.message || e), mode: mpvMode } }
})
// Whether a queued track is genuinely gone, asked of the filesystem rather than
// inferred from one load error. A transient demuxer or cache error on a large
// FLAC used to be enough to delete a present file from the queue for good.
// Files the app is rewriting right now. A rewrite is the one case where the
// original genuinely is absent for a moment and the answer "it is gone" would be
// both true and completely wrong.
const _rewriting = new Set()

ipcMain.handle('track-exists', async (_, filePath) => {
  const p = String(filePath || '')
  if (!p) return { checked: false, exists: false, reason: 'no path' }
  // Deliberately `checked: false`: the load-error policy only ever removes a
  // track on a CONFIRMED absence, so this makes it retry instead.
  if (_rewriting.has(path.resolve(p))) {
    return { checked: false, exists: true, reason: 'the app is rewriting this file' }
  }
  if (/^https?:\/\//.test(p)) return { checked: false, exists: true, reason: 'stream' }
  if (!libPathInRoots(p)) return { checked: false, exists: true, reason: 'outside library roots' }
  try {
    const st = await fs.promises.stat(p)
    return { checked: true, exists: st.isFile(), size: st.size }
  } catch (e) {
    // ENOENT is the answer. Anything else — EACCES, EIO, a dead mount — is not
    // evidence the file is gone, and must not be treated as though it were.
    if (e && e.code === 'ENOENT') return { checked: true, exists: false }
    return { checked: false, exists: true, reason: (e && e.code) || 'stat failed' }
  }
})
// Ground truth for the QA harness: the full flight recorder and mpv's own log,
// straight off the engine, with no UI state anywhere in the answer.
ipcMain.handle('player-get-diagnostics', () => {
  if (!player || typeof player.getFlightRecorder !== 'function') {
    return { available: false, flight: [], log: [], state: null }
  }
  return {
    available: true,
    flight: player.getFlightRecorder(),
    log: player.getLogTail(),
    state: player.getState(),
  }
})
// The preload is sandboxed and cannot require eq.js directly, so the band and
// preset tables are served from here — one source of truth, no duplicated table.
ipcMain.handle('eq-info', () => ({ bands: EQ_BANDS, presets: EQ_PRESETS, limit: EQ_GAIN_LIMIT }))
ipcMain.handle('eq-preset', (_, name) => presetSettings(name))

ipcMain.handle('player-list-devices', async () => {
  if (!player) return []
  try { return await player.listAudioDevices() } catch { return [] }
})
var _deviceVolumes = store.get('deviceVolumes', {})

// These four used to call player.mpv, which exists on neither engine class, so
// every one of them threw on its first line and was swallowed: the device list
// was permanently empty, choosing a device did nothing, and per-device volumes
// never worked at all.
ipcMain.handle('get-device-volume', async () => {
  try {
    if (!player) return null
    var device = await player.getProperty('audio-device')
    var name = device || 'default'
    return _deviceVolumes[name] || store.get('volume', 0.8)
  } catch (e) {
    console.error('[papa] get-device-volume fell back to the global volume:', String(e && e.message || e))
    return store.get('volume', 0.8)
  }
})

ipcMain.handle('save-device-volume', async (_, vol) => {
  try {
    if (!player) { store.set('volume', vol); return }
    var device = await player.getProperty('audio-device')
    var name = device || 'default'
    _deviceVolumes[name] = vol
    store.set('deviceVolumes', _deviceVolumes)
    store.set('volume', vol)
  } catch (e) {
    console.error('[papa] save-device-volume could not read the device:', String(e && e.message || e))
    store.set('volume', vol)
  }
})

ipcMain.handle('get-audio-devices', async () => {
  if (!player) return []
  try {
    const list = await player.listAudioDevices()
    if (!Array.isArray(list)) return []
    return list.filter(d => d.name && d.name !== 'auto').map(d => ({ name: d.name, description: d.description || d.name }))
  } catch (e) {
    console.error('[papa] get-audio-devices failed:', String(e && e.message || e))
    return []
  }
})

ipcMain.handle('set-audio-device', async (_, deviceName) => {
  if (!player) return { ok: false, error: 'engine unavailable' }
  try {
    await player.setProperty('audio-device', deviceName)
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e && e.message || e) } }
})

ipcMain.handle('player-set-config', async (_, partial) => {
  const cfg = { ...getPlayerSettings(), ...partial }
  store.set('playerSettings', cfg)
  if (!player) return { ok: false, error: 'engine unavailable' }
  const needsRebuild = ['outputMode', 'alsaDevice', 'mode', 'crossfadeSecs']
    .some(k => k in partial)
  try {
    if (needsRebuild) {
      const resume = player.getState()
      // Tell the renderer before the audio stops, not after: changing the output
      // device or the crossfade mode tears the engine down mid-track, and that
      // used to happen with no warning at all.
      sendPlayerEvent('engineRebuilding', {
        because: Object.keys(partial).filter(k => ['outputMode', 'alsaDevice', 'mode', 'crossfadeSecs'].includes(k)),
        path: resume.path, position: resume.position,
      })
      player.stop()
      player = buildPlayer(cfg)
      await player.start()
      // The engine's own bounded resume, the same one the respawn path uses, so
      // a rebuild that cannot finish reports itself instead of leaving the engine
      // half-configured with no event.
      const outcome = await player.resumeState(resume)
      sendPlayerEvent('engineRecovered', {
        path: resume.path, position: resume.position,
        resumed: !!(outcome && outcome.resumed), wasPlaying: !resume.paused,
        rebuilt: true,
      })
      refreshTrayTooltip()
    } else {
      if ('replaygain' in partial) await player.setReplaygain(cfg.replaygain)
      if ('channels' in partial) await player.setChannels(cfg.channels)
      if ('eq' in partial) await player.setEq(cfg.eq)
      if ('boost' in partial && lastLinearVolume != null) {
        await player.setVolume(linearToMpv(lastLinearVolume, cfg.boost))
      }
      // Toggling ReplayGain application takes effect on the current track at once,
      // not only on the next load — folding in (or clearing) the stored gain.
      if ('replaygainApply' in partial) {
        try { await applyLoudnessGain(_loudnessCurrentPath) } catch (_) {}
      }
    }
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e.message || e) } }
})

// ── MPRIS (D-Bus) — proper desktop media integration ────────────────────────
// Gives GNOME/KDE media controls, lock screen, playerctl, and Bluetooth
// buttons. The global media-key grab is only registered as a fallback.
let mprisPlayer = null
let _mprisPos = { position: 0, at: Date.now(), playing: false }

function initMpris() {
  try {
    const MprisService = require('mpris-service')
    mprisPlayer = MprisService({
      name: 'papaaudio',
      identity: 'Papa Audio',
      supportedUriSchemes: ['file'],
      supportedMimeTypes: ['audio/flac', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/aac'],
      supportedInterfaces: ['player'],
    })
    mprisPlayer.canQuit = true
    mprisPlayer.canRaise = true
    mprisPlayer.canControl = true
    mprisPlayer.loopStatus = 'None'
    const send = (cmd) => safeSend('media-key', cmd)
    mprisPlayer.on('playpause', () => send('play-pause'))
    mprisPlayer.on('play',      () => send('play'))
    mprisPlayer.on('pause',     () => send('pause'))
    mprisPlayer.on('next',      () => send('next'))
    mprisPlayer.on('previous',  () => send('prev'))
    // 'stop' meant pause, so a desktop applet's Stop button paused. Stop
    // stops: the renderer clears the position too.
    mprisPlayer.on('stop',      () => send('stop'))
    mprisPlayer.on('quit',      () => { app.isQuitting = true; app.quit() })
    mprisPlayer.on('raise',     () => { mainWindow?.show(); mainWindow?.focus() })
    mprisPlayer.on('position',  (e) => safeSend('media-seek', { position: e.position / 1e6 }))
    mprisPlayer.on('seek',      (offsetUs) => safeSend('media-seek', { offset: offsetUs / 1e6 }))
    mprisPlayer.on('volume',    (v) => safeSend('media-volume', Math.max(0, Math.min(1, v))))
    mprisPlayer.on('shuffle',   (enabled) => safeSend('media-shuffle', !!enabled))
    mprisPlayer.on('loopStatus',(status) => safeSend('media-loop-status', status))
    mprisPlayer.getPosition = () => {
      const drift = _mprisPos.playing ? (Date.now() - _mprisPos.at) / 1000 : 0
      return Math.round((_mprisPos.position + drift) * 1e6)
    }
  } catch (e) {
    console.error('MPRIS unavailable, falling back to global media keys:', e.message)
    mprisPlayer = null
    registerMediaKeys()
  }
}

// A cover can be a local file path or, for streamed (YouTube) tracks, an http
// URL. Only a local path needs the file:// scheme + URI-encoding; an http URL is
// already a valid artUrl and prefixing it produced "file://https://…", which
// KDE's media widget could not load — so streamed tracks showed no artwork.
function _mprisArtUrl(artPath) {
  if (!artPath) return ''
  if (/^https?:\/\//.test(artPath)) return artPath
  return 'file://' + encodeURI(artPath).replace(/#/g, '%23')
}

function updateMpris(data) {
  if (!mprisPlayer) return
  try {
    if (data.title !== undefined) {
      mprisPlayer.metadata = {
        'mpris:trackid': mprisPlayer.objectPath('track/' + (data.queueIndex ?? 0)),
        'mpris:length': Math.round((data.duration || 0) * 1e6),
        'mpris:artUrl': _mprisArtUrl(data.artPath),
        'xesam:title': data.title || '',
        'xesam:album': data.album || '',
        'xesam:artist': [data.artist || ''],
      }
    }
    mprisPlayer.playbackStatus = data.playing ? 'Playing' : (data.title ? 'Paused' : 'Stopped')
    mprisPlayer.shuffle = !!data.shuffle
    mprisPlayer.loopStatus = data.repeat === 'one' ? 'Track' : data.repeat === 'all' ? 'Playlist' : 'None'
    if (typeof data.volume === 'number') mprisPlayer.volume = data.volume
    _mprisPos = { position: data.position || 0, at: Date.now(), playing: !!data.playing }
  } catch (e) { console.error('[papa] mpris-update:', e.message || e) }
}

// ── System tray ──────────────────────────────────────────────────────────────
const { Tray, nativeImage } = require('electron')
let tray = null
let _trayNow = { title: null, playing: false }

function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON_PATH).resize({ width: 22, height: 22 })
    tray = new Tray(img)
    tray.setToolTip('Papa Audio')
    updateTrayMenu(false)
    tray.on('click', () => {
      if (!mainWindow) return
      mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus())
    })
  } catch (e) { console.error('Tray unavailable:', e.message) }
}

function updateTrayMenu(isPlaying) {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: isPlaying ? 'Pause' : 'Play', click: () => safeSend('media-playpause') },
    { label: 'Next', click: () => safeSend('media-next') },
    { label: 'Previous', click: () => safeSend('media-previous') },
    { type: 'separator' },
    { label: 'Show', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } } },
    { label: 'Quit', click: () => app.quit() },
  ]))
}

// The renderer's idea of the track, kept only as the source of the NAME — main
// has no titles, only paths.
let _trayTrack = null

// The tooltip used to be whatever the renderer last sent, so after an engineDown
// it kept claiming a track was playing. The name still comes from the renderer;
// whether it is playing comes from the engine.
function refreshTrayTooltip() {
  if (!tray) return
  let tip = 'Papa Audio'
  if (_trayTrack && _trayTrack.title) {
    const name = _trayTrack.title + (_trayTrack.artist ? ' — ' + _trayTrack.artist : '')
    if (!playerReady()) tip = `${name} — playback engine unavailable`
    else if (playerIsPlaying()) tip = name
    else tip = `${name} — paused`
  } else if (!playerReady()) {
    tip = 'Papa Audio — playback engine unavailable'
  }
  try { tray.setToolTip(tip) } catch (_) { /* the tray can be gone mid-quit */ }
}

// ── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize())
ipcMain.on('win-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize())
ipcMain.on('win-close',    () => {
  if (store.get('closeToTray', true) && tray) mainWindow?.hide()
  else { player?.stop(); app.isQuitting = true; mainWindow?.close() }
})
// `theme` used to be here. It was stored and read by nothing -- the app is
// dark-only -- so it was a setting that could be changed and would never do
// anything. closeToTray is real: two places in main honour it.
ipcMain.handle('get-general-settings', () => ({
  closeToTray: store.get('closeToTray', true),
  uiScale: store.get('uiScale', 1),
  // Appearance for the music side + shared chrome (App #87). The cinema stays
  // dark regardless. 'dark' | 'light' | 'system'; defaults to dark, the app's
  // native identity.
  theme: store.get('theme', 'dark'),
  // Folder auto-watch (App #18), default ON. Off means the library only updates
  // on a manual Rescan.
  folderWatchEnabled: store.get('folderWatchEnabled', true),
  // Scheduled backup interval in days (App #23), 0 = off (the default).
  backupIntervalDays: store.get('backupIntervalDays', 0),
}))
ipcMain.on('save-general-settings', (_, s) => {
  if (s && typeof s.closeToTray === 'boolean') store.set('closeToTray', s.closeToTray)
  // The renderer sends one of the offered factors; guard the range so a stray
  // value can't be stored and then re-applied on every launch.
  if (s && typeof s.uiScale === 'number' && s.uiScale >= 0.5 && s.uiScale <= 2) {
    store.set('uiScale', s.uiScale)
  }
  // Only the three known appearance choices are stored; anything else is
  // dropped rather than persisted and re-applied on every launch.
  if (s && (s.theme === 'dark' || s.theme === 'light' || s.theme === 'system')) {
    store.set('theme', s.theme)
  }
  // Folder auto-watch off-switch (App #18). Persisted, then applied at once by
  // re-running the watcher setup — turning it off closes the watcher, turning it
  // on stands it back up — so the change takes effect without a restart.
  if (s && typeof s.folderWatchEnabled === 'boolean') {
    store.set('folderWatchEnabled', s.folderWatchEnabled)
    try { setupLibraryWatcher() } catch (_) { /* a failed re-setup leaves the prior watcher */ }
  }
  // Scheduled backup interval (App #23). A non-negative integer number of days;
  // 0 turns the schedule off. Anything else is ignored rather than stored.
  if (s && typeof s.backupIntervalDays === 'number' &&
      Number.isFinite(s.backupIntervalDays) && s.backupIntervalDays >= 0) {
    store.set('backupIntervalDays', Math.floor(s.backupIntervalDays))
  }
})

// Wave-2 feature toggles, all defaulting ON except auto-organize (roadmap #34,
// #35, #50). One store key `videoConfig` holds them so the renderer reads/writes
// them in one round-trip.
//   diaryAutoLog          — auto-log finished films/episodes to the diary (#34)
//   airingNotifications   — desktop notification when a followed show airs (#35)
//   autoOrganizeDownloads — normalise completed download folders (#50), OFF
function _videoConfig() {
  const saved = store.get('videoConfig', {})
  return {
    diaryAutoLog: saved.diaryAutoLog !== false,
    airingNotifications: saved.airingNotifications !== false,
    autoOrganizeDownloads: saved.autoOrganizeDownloads === true,
  }
}
ipcMain.handle('video-config-get', () => _videoConfig())
ipcMain.handle('video-config-set', (_, patch) => {
  const p = patch && typeof patch === 'object' ? patch : {}
  const next = { ...store.get('videoConfig', {}) }
  if (typeof p.diaryAutoLog === 'boolean') next.diaryAutoLog = p.diaryAutoLog
  if (typeof p.airingNotifications === 'boolean') next.airingNotifications = p.airingNotifications
  if (typeof p.autoOrganizeDownloads === 'boolean') next.autoOrganizeDownloads = p.autoOrganizeDownloads
  store.set('videoConfig', next)
  return _videoConfig()
})

ipcMain.handle('get-streaming-volume-offset', () => store.get('streamingVolumeOffset', 0))
ipcMain.on('set-streaming-volume-offset', (_, offset) => store.set('streamingVolumeOffset', offset))

ipcMain.handle('get-lastfm-config', () => store.get('lastfmConfig', {}))
ipcMain.handle('set-lastfm-config', (_, cfg) => { store.set('lastfmConfig', cfg) })
ipcMain.handle('scrobble-track', async (_, track) => {
  if (!track) return
  await scrobbleTrack(track, Date.now())
})

ipcMain.handle('get-start-on-boot', () => app.getLoginItemSettings().openAtLogin)
ipcMain.handle('set-start-on-boot', (_, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
})

// ── Track notifications ──────────────────────────────────────────────────────
ipcMain.on('notify-track', (_, { title, artist, artPath }) => {
  if (!Notification.isSupported()) return
  new Notification({ title, body: artist, icon: artPath || ICON_PATH, silent: true }).show()
})

let _powerSaveId = null
ipcMain.on('set-power-save', (_, playing) => {
  if (playing && _powerSaveId === null) {
    _powerSaveId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!playing && _powerSaveId !== null) {
    powerSaveBlocker.stop(_powerSaveId)
    _powerSaveId = null
  }
})

powerMonitor.on('suspend', () => {
  if (player) player.pause().catch(() => {})
  if (mainWindow) safeSend('system-suspend')
})

powerMonitor.on('resume', () => {
  if (mainWindow) safeSend('system-resume')
})

ipcMain.on('notify-download-complete', (_, { count, albumName }) => {
  if (!Notification.isSupported()) return
  new Notification({
    title: count === 1 ? 'Download complete' : `${count} downloads complete`,
    body: albumName,
    icon: ICON_PATH,
    silent: false
  }).show()
})

ipcMain.handle('torrent-add', async (_, { uri }) => {
  return new Promise(resolve => {
    try { _torrentAdd(uri); resolve({ ok: true }) } catch(e) { resolve({ ok: false, error: e.message }) }
  })
})
ipcMain.handle('torrent-list', () => [..._activeTorrents.values()])
ipcMain.handle('torrent-remove', async (_, infoHash) => {
  const client = getTorrentClient()
  const torrent = client.get(infoHash)
  return new Promise(resolve => {
    if (torrent) torrent.destroy({ destroyStore: false }, () => { _activeTorrents.delete(infoHash); resolve({ ok: true }) })
    else { _activeTorrents.delete(infoHash); resolve({ ok: true }) }
  })
})

// ── App info ─────────────────────────────────────────────────────────────────
ipcMain.handle('get-app-info', () => ({
  musicFolders:   store.get('musicFolders', []),
  recentlyPlayed: sideStores.recentlyPlayed.get() || [],
  volume:         store.get('volume', 0.8),
  wishlist:       store.get('downloadWishlist', []),
}))

// ── Library cache ────────────────────────────────────────────────────────────
ipcMain.handle('get-library-cache', () => sideStores.libraryCache.get())
ipcMain.on('save-library-cache', (_, albums) => sideStores.libraryCache.set(albums))

// ── Playback state persistence ───────────────────────────────────────────────
ipcMain.handle('get-playback-state', () => sideStores.playbackState.get())
ipcMain.on('save-playback-state', (_, s) => sideStores.playbackState.set(s))

ipcMain.handle('get-session-state', () => sideStores.sessionState.get())
ipcMain.on('save-session-state', (_, s) => sideStores.sessionState.set(s))

// The video-store bridge (src/video-store.js bridge mode).
//
// The bridge CONTRACT with the renderer is unchanged — read hands back a JSON
// string, write takes one — because the renderer's PapaVideoStore speaks raw
// text and must not need touching. What changed underneath (App #45) is that the
// SideStore now holds the store as a NATIVE OBJECT rather than a JSON string
// inside JSON. The file used to be double-encoded ("{\"items\":…}" as a quoted
// string), which works but is fragile for recovery tooling; single-encoding it
// makes video-store.json a plain, hand-editable object.
//
// So the two directions are mirror images:
//   read  — return JSON.stringify(theStoredObject) (or the stored string as-is
//           if a value predating the migration is still sitting there)
//   write — JSON.parse(text) and store the OBJECT; if the text will not parse,
//           store it verbatim rather than losing it.
// A write returning false tells the renderer to flip its health flag and retry.

// The bridge READ shape: whatever the SideStore holds, expressed as the JSON
// string the renderer expects. An object is stringified; a legacy string is
// already JSON and passed straight through; null stays null (no store yet).
function _videoStoreReadText(value) {
  if (value == null) return null
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch (_) { return null }
}

// The bridge WRITE shape: the object to persist natively. Parses the renderer's
// JSON text; unparseable text is stored verbatim so nothing is silently dropped.
function _videoStoreWriteValue(text) {
  const s = String(text)
  try { return JSON.parse(s) } catch (_) { return s }
}

ipcMain.handle('video-store-read', () => {
  try { return _videoStoreReadText(sideStores.videoStore.get()) } catch (_) { return null }
})
ipcMain.handle('video-store-write', (_, text) => {
  try { sideStores.videoStore.set(_videoStoreWriteValue(text)); return true } catch (_) { return false }
})
ipcMain.handle('video-store-read-backup', () => {
  try { return _videoStoreReadText(sideStores.videoStoreBak.get()) } catch (_) { return null }
})
ipcMain.handle('video-store-write-backup', (_, text) => {
  try { sideStores.videoStoreBak.set(_videoStoreWriteValue(text)); return true } catch (_) { return false }
})

// ── Liked albums ─────────────────────────────────────────────────────────────
ipcMain.handle('get-liked', () => store.get('likedAlbums', []))
ipcMain.on('save-liked', (_, ids) => store.set('likedAlbums', ids))

ipcMain.handle('get-liked-tracks', () => store.get('likedTracks', []))
ipcMain.on('save-liked-tracks', (_, paths) => store.set('likedTracks', paths))

ipcMain.handle('get-play-counts', () => store.get('playCounts', {}))
ipcMain.on('increment-play-count', (_, filePath) => {
  const counts = store.get('playCounts', {})
  counts[filePath] = (counts[filePath] || 0) + 1
  store.set('playCounts', counts)
})
ipcMain.handle('get-play-history', () => sideStores.playHistory.get() || [])

ipcMain.on('add-play-history', (_, entry) => {
  if (!entry || !entry.filePath) return
  // Stamped here, not in the renderer. main used to store whatever it was
  // given, so a clock change or a renderer bug wrote an entry no reader could
  // use — and the renderer's value is only ever "now" anyway.
  const stamped = { ...entry, ts: Date.now() }
  delete stamped.timestamp
  const kept = sideStores.playHistory.update(prev => {
    const list = Array.isArray(prev) ? prev : []
    list.unshift(stamped)
    const { keep, overflow } = history.splitForArchive(list, history.HISTORY_CAP)
    // The cap used to splice the oldest entries away with nothing keeping them.
    // Now that the migration has recovered the older ones, that would be
    // discarding real history.
    if (overflow.length) archiveHistoryOverflow(overflow)
    return keep
  })
  if (!Array.isArray(kept)) console.error('[papa][history] update returned no list')
})

// How far a track actually got. The entry is written at the 30 s mark, where
// the position is always ~30 s, so the two achievements that need "did you
// finish it" could never be answered from it. The renderer sends the real
// figure when the track is left.
const HISTORY_PATCH_WINDOW_MS = 60 * 60 * 1000
ipcMain.on('update-play-history-position', (_, { filePath, position } = {}) => {
  if (!filePath) return
  const pos = Number(position)
  if (!Number.isFinite(pos) || pos < 0) return
  sideStores.playHistory.update(prev => {
    const list = Array.isArray(prev) ? prev : []
    // Only the newest match, and only while it is fresh: a track played again
    // next week must not rewrite last week's entry.
    const i = list.findIndex(e => e && e.filePath === filePath)
    if (i < 0) return list
    const entry = list[i]
    if (!entry.ts || Date.now() - entry.ts > HISTORY_PATCH_WINDOW_MS) return list
    // Monotonic: a seek backwards before the track ends must not lower it.
    if (Number(entry.position) >= pos) return list
    const copy = list.slice()
    copy[i] = { ...entry, position: pos }
    return copy
  })
})

// Overflow goes to one file per month, appended, never overwritten.
const HISTORY_ARCHIVE_DIR = path.join(USER_DATA, 'history-archive')
function archiveHistoryOverflow(overflow) {
  const byMonth = history.groupForArchive(overflow)
  fs.promises.mkdir(HISTORY_ARCHIVE_DIR, { recursive: true }).then(async () => {
    for (const [month, entries] of byMonth) {
      const f = path.join(HISTORY_ARCHIVE_DIR, `${month}.json`)
      let existing = []
      try { existing = JSON.parse(await fs.promises.readFile(f, 'utf8')) } catch (_) { existing = [] }
      if (!Array.isArray(existing)) existing = []
      const merged = existing.concat(entries)
      const tmp = f + '.tmp'
      await fs.promises.writeFile(tmp, JSON.stringify(merged), 'utf8')
      await fs.promises.rename(tmp, f)
      console.log(`[papa][history] archived ${entries.length} entries to ${month}.json (${merged.length} total)`)
    }
  }).catch(e => console.error('[papa][history] archive failed, entries kept in memory only:', e && e.message))
}

// Runs once at startup. Reports what it found before changing anything, because
// the numbers in the app's statistics are about to move substantially and
// nothing else would explain why.
function migratePlayHistory() {
  const before = sideStores.playHistory.get() || []
  const r = history.normaliseHistory(before)
  console.log(`[papa][history] ${r.total} entries: ${r.alreadyOk} already keyed on ts, ` +
    `${r.renamed} recovered from the old timestamp key, ${r.quarantined.length} without a usable time`)
  if (r.oldest) {
    console.log(`[papa][history] range ${new Date(r.oldest).toISOString().slice(0, 10)} ` +
      `to ${new Date(r.newest).toISOString().slice(0, 10)}`)
  }
  if (r.quarantined.length) {
    // Set aside rather than deleted: an earlier report proposed dropping these
    // and it was wrong about them, so the call has to stay reversible.
    const f = path.join(USER_DATA, 'history-quarantine.json')
    fs.promises.writeFile(f, JSON.stringify(r.quarantined, null, 2), 'utf8')
      .then(() => console.error(`[papa][history] ${r.quarantined.length} entries had no usable time; kept in ${f}, not deleted`))
      .catch(e => console.error('[papa][history] could not write the quarantine file:', e && e.message))
  }
  if (r.changed) sideStores.playHistory.set(history.sortNewestFirst(r.entries))

  // Reported, never rewritten: which side is right is not this code's call.
  const rec = history.reconcile(r.entries, store.get('playCounts', {}))
  if (rec.disagreeing) {
    console.error(`[papa][history] play counts and history disagree on ${rec.disagreeing} tracks: ` +
      `${rec.countedTotal} counted vs ${rec.historyTotal} recorded ` +
      `(${rec.missingFromHistory} counted but never recorded, ${rec.extraInHistory} recorded but never counted). ` +
      `Nothing was rewritten. Gapless auto-advance used to count a play without recording it, which is the likely cause.`)
  }
  return { migration: r, reconciliation: rec }
}

// One-time move for the album-id change described at the call site. Derives the
// old and new key from the cached library rather than re-reading tags, renames
// the artwork, and records an alias so anything still holding an old id resolves.
function migrateAlbumKeys() {
  const albums = sideStores.libraryCache.get()
  if (!Array.isArray(albums) || !albums.length) return
  const aliases = store.get('albumIdAliases', {})
  const done = store.get('albumKeyTrimMigrated', false)
  if (done) return

  let renamedArt = 0, aliased = 0
  for (const a of albums) {
    for (const t of (a.tracks || [])) {
      const legacyKey = tagEdit.legacyAlbumKeyOf({
        albumArtist: a.artist, artist: t.artist, album: a.name,
      })
      if (!legacyKey) continue
      const oldId = crypto.createHash('md5').update(legacyKey).digest('hex')
      const newId = crypto.createHash('md5').update(
        tagEdit.albumKeyOf({ albumArtist: a.artist, artist: t.artist, album: a.name })).digest('hex')
      if (oldId === newId) break
      for (const ext of ['jpg', 'png']) {
        const from = path.join(artworkDir, `${oldId}.${ext}`)
        const to = path.join(artworkDir, `${newId}.${ext}`)
        try {
          if (fs.existsSync(from) && !fs.existsSync(to)) { fs.renameSync(from, to); renamedArt++ }
        } catch (e) { console.error('[papa][albumkey] could not move artwork:', e && e.message) }
      }
      if (!aliases[oldId]) { aliases[oldId] = newId; aliased++ }
      break   // one album, one key
    }
  }
  store.set('albumIdAliases', aliases)
  store.set('albumKeyTrimMigrated', true)
  if (renamedArt || aliased) {
    console.log(`[papa][albumkey] album ids now ignore tag padding: ${renamedArt} artwork file(s) moved, ` +
      `${aliased} alias(es) recorded. Ratings and notes live in the renderer and are remapped there.`)
  }
  // The renderer owns ratings and notes (localStorage), so it is told which ids
  // moved and remaps them itself.
  _albumIdRemap = aliases
}

let _albumIdRemap = null
ipcMain.handle('get-album-id-remap', () => _albumIdRemap || store.get('albumIdAliases', {}))

// So the renderer can show the numbers rather than only the log having them.
let _historyReport = null
ipcMain.handle('get-history-report', () => _historyReport)
// So the renderer can stamp the same id on its own console lines and on
// anything the user copies out of a failure card.
ipcMain.handle('get-session-id', () => ({
  sessionId: SESSION_ID,
  // Bundled with it because a stack is much less useful without knowing
  // which build produced it.
  appVersion: app.getVersion(),
  electron: process.versions.electron,
}))

ipcMain.handle('get-download-wishlist', () => store.get('downloadWishlist', []))
ipcMain.on('save-download-wishlist', (_, wl) => store.set('downloadWishlist', wl))

ipcMain.handle('get-followed-artists', () => store.get('followedArtists', []))
ipcMain.on('save-followed-artists', (_, artists) => store.set('followedArtists', artists))

// ── Saved queues ─────────────────────────────────────────────────────────────
ipcMain.handle('get-saved-queues', () => store.get('savedQueues', []))
ipcMain.on('save-queue', (_, q) => {
  const queues = store.get('savedQueues', []).filter(x => x.id !== q.id)
  queues.unshift(q)
  store.set('savedQueues', queues.slice(0, 30))
})
ipcMain.on('delete-saved-queue', (_, id) => {
  store.set('savedQueues', store.get('savedQueues', []).filter(q => q.id !== id))
})
ipcMain.on('rename-saved-queue', (_, { id, name }) => {
  store.set('savedQueues', store.get('savedQueues', []).map(q => q.id === id ? { ...q, name } : q))
})

// ── Playlists ────────────────────────────────────────────────────────────────
ipcMain.handle('get-playlists', () => store.get('playlists', []))
ipcMain.on('save-playlist', (_, pl) => {
  const pls = store.get('playlists', [])
  const idx = pls.findIndex(p => p.id === pl.id)
  if (idx >= 0) pls[idx] = pl; else pls.unshift(pl)
  store.set('playlists', pls)
})
ipcMain.on('delete-playlist', (_, id) => {
  store.set('playlists', store.get('playlists', []).filter(p => p.id !== id))
})

// ── YouTube saves (parallel stores — never merged into the library cache) ────
ipcMain.handle('get-yt-liked', () => store.get('ytLikedTracks', []))
ipcMain.on('save-yt-liked', (_, arr) => store.set('ytLikedTracks', arr))
ipcMain.handle('get-yt-followed', () => store.get('ytFollowedArtists', []))
ipcMain.on('save-yt-followed', (_, arr) => store.set('ytFollowedArtists', arr))
ipcMain.handle('get-yt-saved-albums', () => store.get('ytSavedAlbums', []))
ipcMain.on('save-yt-saved-albums', (_, arr) => store.set('ytSavedAlbums', arr))
ipcMain.handle('get-yt-recent', () => store.get('ytRecentAlbums', []))
ipcMain.on('save-yt-recent', (_, arr) => store.set('ytRecentAlbums', arr))

// ── Folder management ────────────────────────────────────────────────────────
ipcMain.handle('add-music-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: 'Add Music Folder'
  })
  if (!r.canceled && r.filePaths[0]) {
    const folders = store.get('musicFolders', [])
    if (!folders.includes(r.filePaths[0])) {
      folders.push(r.filePaths[0])
      store.set('musicFolders', folders)
      setupLibraryWatcher()
    }
    return folders
  }
  return null
})

// Add a folder by path (drag & drop support)
ipcMain.handle('add-music-folder-path', (_, folderPath) => {
  try {
    if (!fs.statSync(folderPath).isDirectory()) return store.get('musicFolders', [])
  } catch (_) { return store.get('musicFolders', []) }
  const folders = store.get('musicFolders', [])
  if (!folders.includes(folderPath)) {
    folders.push(folderPath)
    store.set('musicFolders', folders)
    setupLibraryWatcher()
  }
  return folders
})

ipcMain.handle('remove-music-folder', (_, folderPath) => {
  const folders = store.get('musicFolders', []).filter(f => f !== folderPath)
  store.set('musicFolders', folders)
  setupLibraryWatcher()
  return folders
})

// ── Library scan v2 ──────────────────────────────────────────────────────────
// Async + incremental (mtime/size cache) + CUE sheets + progress events + watcher.
const AUDIO_EXT = /\.(flac|mp3|wav|aiff?|m4a|aac|ogg|opus|ape|wv|wma|dsf|dff|mka|ec3|eac3)$/i
// Formats Chromium cannot decode natively — played via ffmpeg transcode cache
const TRANSCODE_EXT = /\.(ape|wv|wma|dsf|dff)$/i
const TRACK_CACHE_PATH = () => path.join(USER_DATA, 'track-cache.json')

function writeJsonAtomic(file, obj) {
  try {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj))
    fs.renameSync(tmp, file)
  } catch (e) { console.error('Atomic write failed:', file, e.message) }
}
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { console.error('[papa] corrupt-cache:', e.message || e); return fallback }
}

async function scanDirAsync(dir, out = { audio: [], cues: [] }) {
  let entries
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (_) { return out }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await scanDirAsync(full, out)
    else if (entry.isFile()) {
      if (AUDIO_EXT.test(entry.name)) out.audio.push(full)
      else if (/\.cue$/i.test(entry.name)) out.cues.push(full)
    }
  }
  return out
}

// Minimal CUE sheet parser → [{ audioFile, tracks: [{num,title,performer,startSec}] }]
function parseCueSheet(cuePath) {
  let text
  try { text = fs.readFileSync(cuePath, 'utf8') } catch (_) { return [] }
  const dir = path.dirname(cuePath)
  const sheets = []
  let current = null, curTrack = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    let m
    if ((m = line.match(/^FILE\s+"?([^"]+)"?\s+\w+$/i))) {
      const audioFile = path.join(dir, m[1])
      current = { audioFile, tracks: [] }
      sheets.push(current)
      curTrack = null
    } else if (current && (m = line.match(/^TRACK\s+(\d+)\s+AUDIO$/i))) {
      curTrack = { num: parseInt(m[1]), title: null, performer: null, startSec: null }
      current.tracks.push(curTrack)
    } else if (curTrack && (m = line.match(/^TITLE\s+"?([^"]*)"?$/i))) {
      curTrack.title = m[1]
    } else if (curTrack && (m = line.match(/^PERFORMER\s+"?([^"]*)"?$/i))) {
      curTrack.performer = m[1]
    } else if (curTrack && (m = line.match(/^INDEX\s+01\s+(\d+):(\d+):(\d+)$/i))) {
      curTrack.startSec = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3]) / 75
    }
  }
  return sheets.filter(s => s.tracks.some(t => t.startSec !== null) && fs.existsSync(s.audioFile))
}

// music-metadata misreports container formats that carry a foreign codec:
// an E-AC-3 Atmos track inside .m4a comes back as 2 channels with no codec at
// all. ffprobe is authoritative, so consult it for those cases only - running
// it on every FLAC in a large library would make scanning far slower for no
// gain.
const PROBE_EXT = /\.(m4a|mp4|mka|mkv|ec3|eac3|ac3|m4b)$/i

const NO_PROBE = { codec: null, channels: 0, sampleRate: 0, atmos: false }

// execFileSync here blocked the main thread once per probed file, inside scan
// loops — and the whole point of the process it blocks is pumping mpv's IPC.
// parseTrackFile is already async, so this costs nothing to await.
function ffprobeAudio(filePath) {
  return new Promise(resolve => {
    execFile('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,channels,sample_rate,profile',
      '-of', 'json', filePath
    ], { encoding: 'utf8', timeout: 10000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) { resolve({ ...NO_PROBE }); return }
      try {
        const st = (JSON.parse(stdout).streams || [])[0] || {}
        resolve({
          codec: st.codec_name || null,
          channels: Number(st.channels) || 0,
          sampleRate: Number(st.sample_rate) || 0,
          // Both E-AC-3 JOC and TrueHD Atmos announce it in the profile string.
          atmos: /atmos/i.test(st.profile || ''),
        })
      } catch (_) {
        resolve({ ...NO_PROBE })
      }
    })
  })
}

async function parseTrackFile(filePath, st) {
  const meta = await mm.parseFile(filePath, { duration: true })
  const c = meta.common, f = meta.format
  const pic = c.picture?.[0]
  let artPath = null
  if (pic) {
    const ext = pic.format.includes('png') ? 'png' : 'jpg'
    // Used to hash the raw concatenation with no separator and no lowercasing,
    // while buildAlbums hashed `artist_album` lowercased — two different values
    // for the same album, so art written here was never found by album id.
    const key = crypto.createHash('md5')
      .update(tagEdit.albumKeyOf({ albumArtist: c.albumartist, artist: c.artist, album: c.album }))
      .digest('hex')
    artPath = path.join(artworkDir, `${key}.${ext}`)
    if (!fs.existsSync(artPath)) fs.writeFileSync(artPath, pic.data)
  }
  const probe = PROBE_EXT.test(filePath)
    ? await ffprobeAudio(filePath)
    : { ...NO_PROBE }
  const codec = f.codec || probe.codec || null
  return {
    id: crypto.createHash('md5').update(filePath).digest('hex'),
    title: c.title || path.basename(filePath, path.extname(filePath)),
    artist: c.artist || c.albumartist || 'Unknown Artist',
    albumArtist: c.albumartist || c.artist || 'Unknown Artist',
    album: c.album || 'Unknown Album',
    trackNumber: c.track?.no || 0,
    discNumber: c.disk?.no || 1,
    year: c.year || null,
    genre: c.genre?.[0] || null,
    duration: f.duration || 0,
    sampleRate: f.sampleRate || probe.sampleRate || 0,
    bitsPerSample: f.bitsPerSample || 0,
    channels: probe.channels || f.numberOfChannels || 0,
    replayGainTrack: c.replaygain_track_gain?.dB ?? null,
    replayGainAlbum: c.replaygain_album_gain?.dB ?? null,
    replaygainTrackPeak: c.replaygain_track_peak ?? null,
    codec,
    bitDepth:     f.bitsPerSample|| null,
    bitrate:      f.bitrate      || null,
    fileSize:     st ? st.size : null,
    bpm:      c.bpm      ? Math.round(c.bpm) : null,
    explicit: c.explicit || false,
    composer:    (c.composer?.[0])     || null,
    lyricist:    (c.lyricist?.[0])     || null,
    label:       (c.label?.[0])        || null,
    catalogNumber: c.catalognumber     || null,
    isrc:        (c.isrc?.[0])         || null,
    comment:     (c.comment?.[0]?.text || c.comment?.[0]) || null,
    hasEmbeddedLyrics: !!(c.lyrics && c.lyrics.length),
    atmos: probe.atmos,
    needsTranscode: TRANSCODE_EXT.test(filePath) || /alac/i.test(codec || ''),
    addedAt: st ? st.mtimeMs : 0,
    filePath, artPath,
  }
}

let _scanRunning = false
// Item 62: later callers join the scan already running rather than being handed
// the previous cache and told nothing. Returning stale data with busy:true meant
// a user who pressed Scan got the old library back and no indication why.
let _scanInFlight = null

function performScan(onProgress) {
  if (_scanInFlight) return _scanInFlight
  _scanInFlight = _performScanOnce(onProgress).finally(() => { _scanInFlight = null })
  return _scanInFlight
}

// A scan on an unresponsive network mount has no natural end: readdir simply
// does not return. This is not a target — a real scan of a large library takes
// minutes — it is the point past which the scan is stuck rather than slow.
const SCAN_DEADLINE_MS = 30 * 60 * 1000

async function _performScanOnce(onProgress) {
  const folders = store.get('musicFolders', [])
  if (!folders.length) return { albums: [] }
  if (_scanRunning) return { albums: sideStores.libraryCache.get() || [], busy: true }
  _scanRunning = true
  const scanStarted = Date.now()
  const overDeadline = () => Date.now() - scanStarted > SCAN_DEADLINE_MS
  try {
    const found = { audio: [], cues: [] }
    for (const f of folders) {
      if (overDeadline()) {
        // Partial results with a clear report, rather than a stall with none.
        console.error(`[papa] scan deadline reached after ${Math.round((Date.now() - scanStarted) / 1000)}s; ` +
          `stopping before ${f}. A folder on an unresponsive mount is the usual cause.`)
        break
      }
      await scanDirAsync(f, found)
    }

    // CUE sheets: audio files fully described by a cue become virtual tracks
    const cueByAudio = new Map()
    for (const cuePath of found.cues) {
      for (const sheet of parseCueSheet(cuePath)) {
        if (!cueByAudio.has(sheet.audioFile)) cueByAudio.set(sheet.audioFile, sheet)
      }
    }

    // v3 added ffprobe-derived codec/channels/atmos. v2 records predate it and
    // would keep reporting a 6-channel Atmos file as 2-channel stereo, so they
    // must be discarded rather than reused.
    const cache = readJsonSafe(TRACK_CACHE_PATH(), { version: 3, files: {} })
    if (cache.version !== 3) cache.files = {}
    const newCache = { version: 3, files: {} }
    const tracks = []
    const total = found.audio.length
    let done = 0, parsed = 0

    const CONCURRENCY = 6
    const queue = [...found.audio]
    const worker = async () => {
      while (queue.length) {
        const filePath = queue.shift()
        let st = null
        try { st = await fs.promises.stat(filePath) } catch (_) { done++; continue }
        const cached = cache.files[filePath]
        let base
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          base = cached.track
        } else {
          try { base = await parseTrackFile(filePath, st); parsed++ } catch (_) { done++; continue }
        }
        newCache.files[filePath] = { mtimeMs: st.mtimeMs, size: st.size, track: base }
        const sheet = cueByAudio.get(filePath)
        if (sheet && sheet.tracks.length > 1) {
          // Expand into virtual tracks (skip the monolithic file entry)
          const fileDur = base.duration || 0
          sheet.tracks.forEach((ct, i) => {
            if (ct.startSec === null) return
            const end = sheet.tracks[i + 1]?.startSec ?? fileDur
            tracks.push({
              ...base,
              id: crypto.createHash('md5').update(filePath + '#' + ct.num).digest('hex'),
              title: ct.title || `${base.title} (Track ${ct.num})`,
              artist: ct.performer || base.artist,
              trackNumber: ct.num,
              duration: Math.max(0, end - ct.startSec),
              cueStart: ct.startSec,
              cueEnd: end || null,
            })
          })
        } else {
          tracks.push(base)
        }
        done++
        if (done % 25 === 0 || done === total) {
          onProgress?.({ done, total, parsed, phase: 'scanning' })
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))

    writeJsonAtomic(TRACK_CACHE_PATH(), newCache)
    const albums = buildAlbums(tracks)
    sideStores.libraryCache.set(albums)
    onProgress?.({ done: total, total, parsed, phase: 'done', albums: albums.length })
    return { albums }
  } catch (e) {
    console.error('[papa] scan-error:', e?.code || e.message || e, '|', (e?.stack || '').split('\n')[0] || '')
    // `failed` matters: an empty array is a legitimate result for an empty
    // folder, and the renderer's guard is `if (!albums) return` — so [] is
    // truthy and a failed scan used to BLANK the library in the UI. The cache on
    // disk was untouched, which made it look like the library had been lost.
    return { albums: [], failed: true, error: String(e?.code || e?.message || e) }
  } finally {
    _scanRunning = false
  }
}

// ── Library management (destructive operations) ─────────────────────────────
// Everything here can destroy the user's music, so every path is checked
// against the configured music folders first. A bug elsewhere in the app must
// not be able to turn into "deleted a directory outside the library".

function libRoots() {
  const folders = store.get('musicFolders', []) || []
  const dl = store.get('slskConfig', {}).downloadDir
  return folders.concat(dl ? [dl] : []).filter(Boolean).map(f => path.resolve(f))
}

// Deleting is allowed inside the library roots AND inside slskd's own
// incomplete-downloads dir. That dir is app-managed storage the Health tab
// explicitly offers to clean up, but it is not a library root -- it must never
// become a move DESTINATION, so it is added here rather than to libRoots().
function libDeletableRoots() {
  return libRoots().concat([path.join(USER_DATA, 'slskd', 'incomplete')])
}

// Every directory this app legitimately reads or writes: the music roots, the
// configured download folder, slskd's incomplete folder, and our own userData.
// Side-effect free on purpose — _downloadDir() creates directories and warns,
// which a guard must not do.
function papaRoots() {
  const cfg = store.get('slskConfig', {})
  const folders = store.get('musicFolders', [])
  const roots = folders.slice()
  if (cfg.downloadDir) roots.push(cfg.downloadDir)
  for (const base of folders) roots.push(path.join(base, DOWNLOAD_SUBDIR))
  roots.push(path.join(SLSKD_DIR, 'incomplete'))
  roots.push(USER_DATA)
  return roots.filter(Boolean)
}

// A path the app may touch. Lexical, like libPathInRoots, so it works for a file
// that does not exist yet and cannot be widened via a symlink.
function pathIsOurs(target) {
  const resolved = path.resolve(String(target || ''))
  if (!resolved || resolved === path.sep) return false
  for (const root of papaRoots()) {
    const r = path.resolve(root)
    if (resolved === r || resolved.startsWith(r + path.sep)) return true
  }
  return false
}

// Is this path lexically inside a library root? Unlike libPathAllowed this does
// not require the file to exist, because the question being asked is whether it
// still does. No realpath, so it cannot be used to probe outside the roots via
// a symlink either: the answer is about the path as written.
function libPathInRoots(target) {
  const resolved = path.resolve(String(target || ''))
  for (const root of libDeletableRoots()) {
    const r = path.resolve(root)
    if (resolved !== r && resolved.startsWith(r + path.sep)) return true
  }
  return false
}

function libPathAllowed(target) {
  let resolved
  try { resolved = fs.realpathSync(path.resolve(String(target))) } catch (_) { return false }
  const roots = libDeletableRoots()
  if (!roots.length) return false
  for (const root of roots) {
    let r
    try { r = fs.realpathSync(root) } catch (_) { r = root }
    // Must be strictly INSIDE a root, never the root itself.
    if (resolved !== r && resolved.startsWith(r + path.sep)) return true
  }
  return false
}

// What exactly would go, stated before anything is touched. The UI shows this
// verbatim so a delete is never a leap of faith.
// Deleting a whole artist can mean thousands of files. The walk used to be
// fully synchronous on the main process, which freezes the window — including
// playback controls — while it runs. It now yields between batches and stops
// counting individual files past a cap, since nobody reads a 5000-line
// confirmation anyway; the byte total keeps going.
const INSPECT_FILE_CAP = 2000
const INSPECT_YIELD_EVERY = 400

ipcMain.handle('library-inspect-paths', async (_, { paths }) => {
  const out = []
  let seen = 0

  const walk = async (dir, entry) => {
    let names
    try { names = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (_) { return }
    for (const d of names) {
      const full = path.join(dir, d.name)
      if (d.isDirectory()) { await walk(full, entry); continue }
      let st
      try { st = await fs.promises.stat(full) } catch (_) { continue }
      entry.bytes += st.size
      entry.fileCount++
      if (entry.files.length < INSPECT_FILE_CAP) entry.files.push(full)
      else entry.filesTruncated = true
      if (++seen % INSPECT_YIELD_EVERY === 0) await new Promise(r => setImmediate(r))
    }
  }

  for (const p of paths || []) {
    const entry = {
      path: p, allowed: libPathAllowed(p), exists: false, isDir: false,
      files: [], fileCount: 0, bytes: 0, filesTruncated: false,
    }
    try {
      const st = await fs.promises.stat(p)
      entry.exists = true
      entry.isDir = st.isDirectory()
      if (entry.isDir) {
        await walk(p, entry)
      } else {
        entry.files.push(p)
        entry.fileCount = 1
        entry.bytes = st.size
      }
    } catch (_) {}
    out.push(entry)
  }
  return { entries: out }
})

const libPrune = require('./src/library-prune')

// One handler, not seven. Pruning is a single logical transaction — the
// renderer must never be able to complete three of these and abandon the rest.
ipcMain.handle('library-prune-state', (_, { removed, renamed }) => {
  const map = libPrune.buildRemap(removed || [], renamed || [])
  if (!Object.keys(map).length) return { ok: true, summary: null, snapshot: null }

  const snapshot = {
    likedTracks:   store.get('likedTracks', []),
    playCounts:    store.get('playCounts', {}),
    playHistory:   sideStores.playHistory.get() || [],
    playlists:     store.get('playlists', []),
    savedQueues:   store.get('savedQueues', []),
    playbackState: sideStores.playbackState.get(),
  }
  const { next, summary } = libPrune.pruneAll(snapshot, map)
  if (!summary.touched && !summary.renamed) return { ok: true, summary, snapshot: null }

  store.set('likedTracks',   next.likedTracks)
  store.set('playCounts',    next.playCounts)
  sideStores.playHistory.set(next.playHistory)
  store.set('playlists',     next.playlists)
  store.set('savedQueues',   next.savedQueues)
  if (next.playbackState) sideStores.playbackState.set(next.playbackState)
  else sideStores.playbackState.set(null)

  // The pre-prune snapshot IS the undo. Handed back so the renderer can offer
  // it without main having to hold per-operation state.
  return { ok: true, summary, snapshot }
})

ipcMain.handle('library-restore-state', (_, { snapshot }) => {
  if (!snapshot) return { ok: false, error: 'Nothing to restore' }
  if (snapshot.likedTracks)   store.set('likedTracks', snapshot.likedTracks)
  if (snapshot.playCounts)    store.set('playCounts', snapshot.playCounts)
  if (snapshot.playHistory)   sideStores.playHistory.set(snapshot.playHistory)
  if (snapshot.playlists)     store.set('playlists', snapshot.playlists)
  if (snapshot.savedQueues)   store.set('savedQueues', snapshot.savedQueues)
  if (snapshot.playbackState) sideStores.playbackState.set(snapshot.playbackState)
  return { ok: true }
})

// Freedesktop trash layout: <volume>/.Trash-<uid>/{files,info}. shell.trashItem
// gives us no handle back, so restoring means finding what it wrote. The
// .trashinfo file records the original path, which is the only reliable link.
function trashRootsFor(originalPath) {
  const roots = []
  const home = path.join(app.getPath('home'), '.local', 'share', 'Trash')
  let dir = path.resolve(originalPath)
  // Walk up to the mount point that holds a .Trash-<uid>.
  for (let i = 0; i < 12 && dir && dir !== path.dirname(dir); i++) {
    dir = path.dirname(dir)
    const cand = path.join(dir, `.Trash-${process.getuid ? process.getuid() : 1000}`)
    if (fs.existsSync(cand)) { roots.push(cand); break }
  }
  if (fs.existsSync(home)) roots.push(home)
  return roots
}

function findTrashedEntry(originalPath) {
  const target = path.resolve(originalPath)
  for (const root of trashRootsFor(originalPath)) {
    const infoDir = path.join(root, 'info')
    const filesDir = path.join(root, 'files')
    let names
    try { names = fs.readdirSync(infoDir) } catch (_) { continue }
    // Newest first: the same path may have been trashed more than once.
    const entries = names
      .filter(n => n.endsWith('.trashinfo'))
      .map(n => {
        const full = path.join(infoDir, n)
        let mtime = 0
        try { mtime = fs.statSync(full).mtimeMs } catch (_) {}
        return { name: n, full, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)

    for (const e of entries) {
      let body
      try { body = fs.readFileSync(e.full, 'utf8') } catch (_) { continue }
      const m = /^Path=(.*)$/m.exec(body)
      if (!m) continue
      let recorded = decodeURIComponent(m[1].trim())
      // Paths are stored relative to the trash volume for non-home trashes.
      if (!path.isAbsolute(recorded)) recorded = path.join(path.dirname(root), recorded)
      if (path.resolve(recorded) !== target) continue
      const payload = path.join(filesDir, e.name.replace(/\.trashinfo$/, ''))
      if (fs.existsSync(payload)) return { payload, infoFile: e.full, original: target }
    }
  }
  return null
}

// The trash that matters here is the one on the music volume. Because it lives
// on the SAME drive as the library, moving files there reclaims nothing — the
// UI has to say so, and give a way to actually empty it.
function trashRootsAll() {
  const roots = []
  const uid = process.getuid ? process.getuid() : 1000
  for (const root of libRoots()) {
    let dir = path.resolve(root)
    for (let i = 0; i < 12 && dir && dir !== path.dirname(dir); i++) {
      const cand = path.join(dir, `.Trash-${uid}`)
      if (fs.existsSync(cand) && roots.indexOf(cand) === -1) { roots.push(cand); break }
      dir = path.dirname(dir)
    }
  }
  const home = path.join(app.getPath('home'), '.local', 'share', 'Trash')
  if (fs.existsSync(home) && roots.indexOf(home) === -1) roots.push(home)
  return roots
}

// Walking /mnt/data/MUSIC with readdirSync/statSync and no yielding froze the
// one process that also pumps mpv's IPC, the window and every other handler —
// from four separate call sites, one of them a pre-check before a move.
//
// Same numbers, same symlink behaviour (stat follows, and only real directories
// are descended into, so a symlinked directory cannot make a loop). What changed
// is that it yields, and that the result is cached briefly: a storage report
// asks for every music root, the artwork directory and every trash root at once.
const DIR_SIZE_TTL_MS = 15000
const DIR_SIZE_YIELD_EVERY = 300
const _dirSizeCache = new Map()

async function dirSizeAsync(target, opts = {}) {
  const key = path.resolve(String(target))
  const useCache = opts.useCache !== false
  if (useCache) {
    const hit = _dirSizeCache.get(key)
    if (hit && Date.now() - hit.at < DIR_SIZE_TTL_MS) return hit.bytes
  }
  let total = 0
  let seen = 0
  let st
  try { st = await fs.promises.stat(key) } catch (_) { return 0 }
  if (!st.isDirectory()) {
    _dirSizeCache.set(key, { bytes: st.size, at: Date.now() })
    return st.size
  }
  const stack = [key]
  while (stack.length) {
    const d = stack.pop()
    let names
    try { names = await fs.promises.readdir(d, { withFileTypes: true }) } catch (_) { continue }
    for (const n of names) {
      const full = path.join(d, n.name)
      if (n.isDirectory()) { stack.push(full); continue }
      try { total += (await fs.promises.stat(full)).size } catch (_) {}
      // Let the event loop breathe. Without this a large library still blocks
      // playback, just via promises instead of sync calls.
      if (++seen % DIR_SIZE_YIELD_EVERY === 0) await new Promise(r => setImmediate(r))
    }
  }
  _dirSizeCache.set(key, { bytes: total, at: Date.now() })
  return total
}

// The cache must not outlive a change the user just made.
function invalidateDirSizeCache() { _dirSizeCache.clear() }

const libHealth = require('./src/library-health')

// The library index only knows about audio it could parse. Everything else —
// installers, logs, leftovers, empty folders — is invisible to it, so it has
// to be found by walking the disk.
ipcMain.handle('library-scan-extras', async () => {
  const nonAudio = []
  const emptyDirs = []
  const roots = store.get('musicFolders', []) || []

  const walk = async (dir) => {
    let names
    try { names = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (_) { return false }
    let hasAudio = false
    for (const d of names) {
      if (d.name.startsWith('.')) continue          // .Trash-1000 and friends
      const full = path.join(dir, d.name)
      if (d.isDirectory()) {
        const childHasAudio = await walk(full)
        if (childHasAudio) hasAudio = true
        continue
      }
      if (libHealth.AUDIO_RE.test(d.name)) { hasAudio = true; continue }
      let st
      try { st = await fs.promises.stat(full) } catch (_) { continue }
      nonAudio.push({ path: full, bytes: st.size })
    }
    if (!hasAudio) emptyDirs.push(dir)
    return hasAudio
  }

  for (const root of roots) {
    // Never offer a configured music root itself for deletion.
    let names
    try { names = await fs.promises.readdir(root, { withFileTypes: true }) } catch (_) { continue }
    for (const d of names) {
      if (d.name.startsWith('.')) continue
      const full = path.join(root, d.name)
      if (d.isDirectory()) { await walk(full); continue }
      if (libHealth.AUDIO_RE.test(d.name)) continue
      let st
      try { st = await fs.promises.stat(full) } catch (_) { continue }
      nonAudio.push({ path: full, bytes: st.size })
    }
  }

  // Partial downloads with no matching active transfer.
  const partials = []
  const incomplete = path.join(USER_DATA, 'slskd', 'incomplete')
  let active = new Set()
  try {
    const data = await slskdFetch('GET', '/transfers/downloads')
    for (const u of data || []) {
      for (const dir of u.directories || []) {
        for (const f of dir.files || []) {
          if (!String(f.state || '').startsWith('Completed')) {
            active.add(path.basename(String(f.filename).replace(/\\/g, '/')))
          }
        }
      }
    }
  } catch (_) { active = null }   // slskd unreachable: do NOT guess, report none

  if (active) {
    const walkInc = async (dir) => {
      let names
      try { names = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (_) { return }
      for (const d of names) {
        const full = path.join(dir, d.name)
        if (d.isDirectory()) { await walkInc(full); continue }
        if (active.has(d.name)) continue
        let st
        try { st = await fs.promises.stat(full) } catch (_) { continue }
        partials.push({ path: full, bytes: st.size })
      }
    }
    await walkInc(incomplete)
  }

  return { nonAudio, emptyDirs, partials, partialsChecked: !!active }
})

ipcMain.handle('library-storage-report', async () => {
  const roots = store.get('musicFolders', []) || []
  const out = { roots: [], artworkBytes: 0, trashBytes: 0, free: null, total: null }
  for (const r of roots) {
    out.roots.push({ path: r, bytes: await dirSizeAsync(r) })
  }
  out.artworkBytes = await dirSizeAsync(artworkDir)
  for (const t of trashRootsAll()) out.trashBytes += await dirSizeAsync(path.join(t, 'files'))
  try {
    const st = fs.statfsSync(roots[0] || app.getPath('home'))
    out.free = st.bavail * st.bsize
    out.total = st.blocks * st.bsize
  } catch (_) {}
  return out
})

// There was no free-space check anywhere in this app. With 51 GB free on a
// 932 GB drive, a copy that runs the disk dry is a real outcome.
function freeSpaceAt(target) {
  try {
    const st = fs.statfsSync(path.dirname(path.resolve(target)))
    return st.bavail * st.bsize
  } catch (_) { return null }
}

ipcMain.handle('library-free-space', (_, { at }) => ({ free: freeSpaceAt(at || app.getPath('home')) }))

ipcMain.handle('library-trash-list', async () => {
  const roots = trashRootsAll()
  const items = []
  let totalBytes = 0
  for (const root of roots) {
    const filesDir = path.join(root, 'files')
    const infoDir = path.join(root, 'info')
    let names
    try { names = fs.readdirSync(filesDir) } catch (_) { continue }
    for (const name of names) {
      const payload = path.join(filesDir, name)
      let original = null
      let deletedAt = null
      try {
        const body = fs.readFileSync(path.join(infoDir, name + '.trashinfo'), 'utf8')
        const mp = /^Path=(.*)$/m.exec(body)
        const md = /^DeletionDate=(.*)$/m.exec(body)
        if (mp) {
          original = decodeURIComponent(mp[1].trim())
          if (!path.isAbsolute(original)) original = path.join(path.dirname(root), original)
        }
        if (md) deletedAt = md[1].trim()
      } catch (_) {}
      const bytes = await dirSizeAsync(payload)
      totalBytes += bytes
      let isDir = false
      try { isDir = fs.statSync(payload).isDirectory() } catch (_) {}
      items.push({ name, root, payload, original, deletedAt, bytes, isDir })
    }
  }
  items.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')))

  // Whether emptying actually frees usable space depends on the volume.
  const volumes = roots.map(r => {
    const mount = path.dirname(r)
    let free = null
    try { const st = fs.statfsSync(mount); free = st.bavail * st.bsize } catch (_) {}
    return { trashDir: r, mount, free }
  })
  return { items, totalBytes, roots, volumes }
})

ipcMain.handle('library-empty-trash', async (_, { names, payloads }) => {
  const wanted = Array.isArray(payloads) && payloads.length ? payloads.map(p => path.resolve(p)) : null
  // Only ever touches paths inside a recognised trash directory.
  const roots = trashRootsAll()
  const inTrash = (p) => roots.some(r => path.resolve(p).startsWith(path.join(r, 'files') + path.sep))
  const results = []
  let freed = 0
  const all = names && names.length ? names : null

  for (const root of roots) {
    const filesDir = path.join(root, 'files')
    const infoDir = path.join(root, 'info')
    let entries
    try { entries = fs.readdirSync(filesDir) } catch (_) { continue }
    for (const name of entries) {
      const payload = path.join(filesDir, name)
      // Prefer exact payload paths. Matching on the bare name meant that with
      // two music volumes, ticking one "Greatest Hits" permanently destroyed
      // the identically-named entry on the OTHER volume too.
      if (wanted) { if (wanted.indexOf(payload) === -1) continue }
      else if (all && all.indexOf(name) === -1) continue
      if (!inTrash(payload)) { results.push({ name, ok: false, error: 'Refused — not inside a trash folder' }); continue }
      const bytes = await dirSizeAsync(payload)
      try {
        fs.rmSync(payload, { recursive: true, force: true })
        invalidateDirSizeCache()
        try { fs.rmSync(path.join(infoDir, name + '.trashinfo'), { force: true }) } catch (_) {}
        freed += bytes
        results.push({ name, ok: true, bytes })
      } catch (e) {
        results.push({ name, ok: false, error: e.message })
      }
    }
  }
  const removed = results.filter(r => r.ok).length
  return { results, removed, failed: results.length - removed, freed }
})

ipcMain.handle('library-restore-trashed', async (_, { paths }) => {
  const results = []
  for (const p of paths || []) {
    const found = findTrashedEntry(p)
    if (!found) { results.push({ path: p, ok: false, error: 'Not found in Trash' }); continue }
    if (fs.existsSync(found.original)) {
      results.push({ path: p, ok: false, error: 'Something is already at that path' })
      continue
    }
    try {
      fs.mkdirSync(path.dirname(found.original), { recursive: true })
      fs.renameSync(found.payload, found.original)
      try { fs.unlinkSync(found.infoFile) } catch (_) {}
      results.push({ path: p, ok: true })
    } catch (e) {
      results.push({ path: p, ok: false, error: e.message })
    }
  }
  const restored = results.filter(r => r.ok).length
  if (restored) _scheduleLibraryRescan()
  return { results, restored, failed: results.length - restored }
})

ipcMain.handle('library-trash-paths', async (_, { paths }) => {
  const results = []
  for (const p of paths || []) {
    if (!libPathAllowed(p)) {
      results.push({ path: p, ok: false, error: 'Outside your music folders — refused' })
      continue
    }
    if (!fs.existsSync(p)) { results.push({ path: p, ok: false, error: 'No longer on disk' }); continue }
    try {
      // Trash, never unlink: a wrong call has to be recoverable.
      await shell.trashItem(path.resolve(p))
      results.push({ path: p, ok: true })
    } catch (e) {
      results.push({ path: p, ok: false, error: e.message || 'Could not move to Trash' })
    }
  }
  const moved = results.filter(r => r.ok).length
  if (moved) _scheduleLibraryRescan()
  return { results, moved, failed: results.length - moved }
})

ipcMain.handle('library-move-path', async (_, { from, to }) => {
  if (!libPathAllowed(from)) return { ok: false, error: 'Source is outside your music folders' }
  const dest = path.resolve(String(to))
  const roots = libRoots()
  const insideRoot = roots.some(r => dest === r || dest.startsWith(r + path.sep))
  if (!insideRoot) return { ok: false, error: 'Destination is outside your music folders' }
  if (fs.existsSync(dest)) return { ok: false, error: 'Something already exists at that name' }
  const needed = await dirSizeAsync(path.resolve(from), { useCache: false })
  const free = freeSpaceAt(dest)
  if (free != null && free < needed + 1e9) {
    return { ok: false, error: 'Not enough free space at the destination (' +
      Math.round(needed / 1e6) + ' MB needed, ' + Math.round(free / 1e6) + ' MB free)' }
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(path.resolve(from), dest)
  } catch (e) {
    // Cross-device rename fails; fall back to copy-then-remove.
    try {
      fs.cpSync(path.resolve(from), dest, { recursive: true })
      await shell.trashItem(path.resolve(from))
    } catch (e2) {
      return { ok: false, error: e2.message || e.message }
    }
  }
  _scheduleLibraryRescan()
  return { ok: true, path: dest }
})

const TAG_FIELDS = ['title', 'artist', 'album', 'albumartist', 'date', 'genre', 'track', 'disc', 'composer']

// ffmpeg's canonical key for album artist is `album_artist`. Writing
// `albumartist` instead ADDS a second tag next to the existing one, so the
// field ends up holding both the old and new value ("New;Old") rather than
// being replaced. Vorbis comments allow repeats, so nothing errors.
const FFMPEG_TAG_KEY = { albumartist: 'album_artist', disc: 'disc' }

// Alternate spellings the same field can already be stored under. Each one is
// cleared explicitly, otherwise a stale duplicate survives the rewrite.
const TAG_ALIASES = {
  albumartist: ['albumartist', 'album_artist', 'ALBUMARTIST', 'ALBUM_ARTIST'],
  date: ['date', 'year', 'DATE', 'YEAR'],
  track: ['track', 'tracknumber', 'TRACK', 'TRACKNUMBER'],
  disc: ['disc', 'discnumber', 'DISC', 'DISCNUMBER'],
}

// ffmpeg cannot edit tags in place, so this rewrites the stream losslessly to a
// temp file and only replaces the original once ffmpeg has exited cleanly. A
// failed write leaves the original untouched.
function writeTagsOne(filePath, tags) {
  return new Promise((resolve) => {
    const dir = path.dirname(filePath)
    const ext = path.extname(filePath)
    const tmp = path.join(dir, '.papa-tag-' + crypto.randomBytes(6).toString('hex') + ext)
    const args = ['-v', 'error', '-i', filePath, '-map', '0', '-c', 'copy']
    for (const k of TAG_FIELDS) {
      if (tags[k] === undefined) continue
      const value = tags[k] == null ? '' : String(tags[k])
      // Clear every spelling first so no stale duplicate survives...
      for (const alias of (TAG_ALIASES[k] || [k])) args.push('-metadata', `${alias}=`)
      // ...then write the one ffmpeg actually canonicalises.
      args.push('-metadata', `${FFMPEG_TAG_KEY[k] || k}=${value}`)
    }
    args.push('-y', tmp)
    const proc = spawn('ffmpeg', args)
    let err = ''
    proc.stderr.on('data', d => { err = (err + d.toString()).slice(-400) })
    proc.on('error', e => { try { fs.unlinkSync(tmp) } catch (_) {} resolve({ ok: false, error: e.message }) })
    proc.on('close', code => {
      if (code !== 0) {
        try { fs.unlinkSync(tmp) } catch (_) {}
        resolve({ ok: false, error: err.trim() || ('ffmpeg exited ' + code) })
        return
      }
      try {
        fs.renameSync(tmp, filePath)
        resolve({ ok: true })
      } catch (e) {
        try { fs.unlinkSync(tmp) } catch (_) {}
        resolve({ ok: false, error: e.message })
      }
    })
  })
}

// Correcting tags changes the album id, which is what everything album-scoped
// is keyed by. Carry those keys across, or a person tidying their library
// silently loses their likes, ratings, notes and cover art.
// Setting a cover from a file. The cache is keyed by album id, so writing
// there is enough for the app to show it. Embedding into the audio files is
// offered separately and OFF by default, because it rewrites every file on the
// album -- minutes of disk churn for a picture.
ipcMain.handle('library-pick-artwork', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose album artwork',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
  })
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
  return { ok: true, path: r.filePaths[0] }
})

async function imageDimensions(file) {
  // ffprobe is already a hard dependency here and reads every format we accept.
  // Not in a scan loop like item 49's, but still up to 10 s of blocked main
  // thread on the process that drives mpv, and the caller is already async.
  try {
    const out = (await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], 10000)).trim().split('\n')
    return { codec: out[0] || null, width: parseInt(out[1], 10) || 0, height: parseInt(out[2], 10) || 0 }
  } catch (_) { return null }
}

ipcMain.handle('library-set-artwork', async (_, { albumId, sourcePath, embed, filePaths }) => {
  if (!albumId) return { ok: false, error: 'No album given' }
  if (!sourcePath || !fs.existsSync(sourcePath)) return { ok: false, error: 'That image is gone' }

  const info = await imageDimensions(sourcePath)
  if (!info || !info.width) return { ok: false, error: 'That file is not a readable image' }

  const dest = path.join(artworkDir, `${albumId}.jpg`)
  await new Promise((resolve) => {
    // Normalise to JPEG at a sane size: the cache is displayed at a few hundred
    // pixels, and a 20 MB PNG helps nobody.
    const proc = spawn('ffmpeg', [
      '-v', 'error', '-i', sourcePath,
      '-vf', 'scale=min(1000\\,iw):-1', '-q:v', '3', '-y', dest,
    ])
    proc.on('error', resolve)
    proc.on('close', resolve)
  })
  if (!fs.existsSync(dest)) return { ok: false, error: 'Could not write the artwork' }

  // A stale PNG under the same id would win the lookup, so clear it.
  try { fs.rmSync(path.join(artworkDir, `${albumId}.png`), { force: true }) } catch (_) {}

  let embedded = 0
  let embedFailed = 0
  if (embed && Array.isArray(filePaths)) {
    for (const fp of filePaths) {
      if (!libPathAllowed(fp)) { embedFailed++; continue }
      const ok = await embedArtworkOne(fp, dest)
      if (ok) embedded++
      else embedFailed++
    }
  }

  _scheduleLibraryRescan()
  return { ok: true, artPath: dest, width: info.width, height: info.height, embedded, embedFailed }
})

// Same temp-file discipline as tag writing: the original is only replaced once
// ffmpeg has exited cleanly.
function embedArtworkOne(filePath, imagePath) {
  return new Promise((resolve) => {
    const ext = path.extname(filePath)
    const tmp = path.join(path.dirname(filePath), '.papa-art-' + crypto.randomBytes(6).toString('hex') + ext)
    const proc = spawn('ffmpeg', [
      '-v', 'error', '-i', filePath, '-i', imagePath,
      '-map', '0:a', '-map', '1:v', '-c', 'copy',
      '-disposition:v', 'attached_pic',
      '-metadata:s:v', 'title=Album cover',
      '-y', tmp,
    ])
    proc.on('error', () => { try { fs.unlinkSync(tmp) } catch (_) {} resolve(false) })
    proc.on('close', (code) => {
      if (code !== 0) { try { fs.unlinkSync(tmp) } catch (_) {} resolve(false); return }
      try { fs.renameSync(tmp, filePath); resolve(true) }
      catch (_) { try { fs.unlinkSync(tmp) } catch (_) {} resolve(false) }
    })
  })
}

ipcMain.handle('library-migrate-album-id', (_, { oldKey, newKey }) => {
  if (!oldKey || !newKey || oldKey === newKey) return { ok: true, migrated: false }
  const hash = (k) => crypto.createHash('md5').update(k).digest('hex')
  const oldId = hash(oldKey)
  const newId = hash(newKey)

  const liked = store.get('likedAlbums', [])
  if (liked.indexOf(oldId) !== -1) {
    store.set('likedAlbums', liked.map(x => (x === oldId ? newId : x)).filter((x, i, a) => a.indexOf(x) === i))
  }
  const recent = sideStores.recentlyPlayed.get() || []
  if (recent.indexOf(oldId) !== -1) {
    sideStores.recentlyPlayed.set(recent.map(x => (x === oldId ? newId : x)).filter((x, i, a) => a.indexOf(x) === i))
  }
  const session = sideStores.sessionState.get()
  if (session && session.navId === oldId) sideStores.sessionState.set({ ...session, navId: newId })

  // The cached cover is named by album id.
  for (const ext of ['jpg', 'png']) {
    const from = path.join(artworkDir, `${oldId}.${ext}`)
    const to = path.join(artworkDir, `${newId}.${ext}`)
    try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to) } catch (_) {}
  }

  const aliases = store.get('albumIdAliases', {})
  aliases[oldId] = newId
  store.set('albumIdAliases', aliases)

  // Returned so the renderer can migrate the keys IT owns (ratings and notes
  // live in localStorage, which main cannot reach).
  return { ok: true, migrated: true, oldId, newId }
})

ipcMain.handle('library-write-tags', async (_, { files }) => {
  const results = []
  for (const item of files || []) {
    const fp = item && item.filePath
    if (!fp || !libPathAllowed(fp)) {
      results.push({ filePath: fp, ok: false, error: 'Outside your music folders — refused' })
      continue
    }
    // ffmpeg cannot edit tags in place: it writes a temp file and replaces the
    // original. mpv is holding the same file open with 30 s of readahead, so a
    // load error during that window used to reach the missing-file path and
    // remove a track that was very much still there.
    _rewriting.add(path.resolve(fp))
    try {
      results.push(Object.assign({ filePath: fp }, await writeTagsOne(fp, item.tags || {})))
    } finally {
      _rewriting.delete(path.resolve(fp))
    }
  }
  const ok = results.filter(r => r.ok).length
  if (ok) _scheduleLibraryRescan()
  return { results, written: ok, failed: results.length - ok }
})

// W2-UI contract: tagWriteBatch. A pure-node FLAC Vorbis-comment writer (no
// ffmpeg spawn, no npm dependency — the library is 82% FLAC, and src/flac-tags.js
// implements a spec-correct writer with .bak temp-write-rename discipline).
// Each edit is { filePath, changes:{genre?,title?,artist?,album?,year?} }; FLAC
// files are written, everything else is skipped with reason 'unsupported'.
// Returns { written, skipped:[{filePath,reason}] } exactly as the contract
// specifies. Paths outside the music/download roots are skipped ('refused'), and
// mpv's open-file window is respected via _rewriting like library-write-tags.
const flacTags = require('./src/flac-tags')
ipcMain.handle('tag-write-batch', async (_, { edits } = {}) => {
  const list = Array.isArray(edits) ? edits : []
  const guarded = []
  for (const e of list) {
    const fp = e && e.filePath
    if (fp && flacTags.isFlacPath(fp)) _rewriting.add(path.resolve(fp))
    guarded.push(e)
  }
  try {
    // The guard folds the folder allow-list into the writer so a write can never
    // escape the music/download roots even if the renderer sends an odd path.
    const result = flacTags.writeBatch(guarded, fp => libPathAllowed(fp) || pathIsOurs(fp))
    if (result.written) _scheduleLibraryRescan()
    return result
  } finally {
    for (const e of list) {
      const fp = e && e.filePath
      if (fp && flacTags.isFlacPath(fp)) _rewriting.delete(path.resolve(fp))
    }
  }
})

let _libRescanTimer = null
function _scheduleLibraryRescan() {
  clearTimeout(_libRescanTimer)
  _libRescanTimer = setTimeout(async () => {
    const res = await performScan(null)
    if (res.failed) {
      console.error('[papa] rescan after a tag write failed; leaving the library as it was')
      return
    }
    safeSend('library-updated', { albums: res.albums, reason: 'manage' })
    writeLibraryExt(res.albums)
  }, 1200)
}

ipcMain.handle('scan-library', async () => {
  return performScan(p => safeSend('scan-progress', p))
})

// ── Realtime folder watching ─────────────────────────────────────────────────
// Optional. Without it the library never notices files changing on disk, which
// looks exactly like the scanner being broken.
let chokidar; try { chokidar = require('chokidar') } catch (e) {
  console.error('[papa] chokidar unavailable; the library folder watcher is off:', e && e.message)
}
let _libWatcher = null
let _watchDebounce = null

// Whether a Soulseek/torrent download is currently writing to disk — the case
// (App #18) that turns a download landing inside a watched root into an event
// storm. dlState.inflight is the scheduler's in-flight set; activeDownloads is
// the session-level torrent set. Either being non-empty counts.
function _downloadsAreActive() {
  try {
    if (dlState && dlState.inflight && Object.keys(dlState.inflight).length > 0) return true
  } catch (_) {}
  try { if (activeDownloads && activeDownloads.size > 0) return true } catch (_) {}
  return false
}

function setupLibraryWatcher() {
  if (!chokidar) return
  if (_libWatcher) { try { _libWatcher.close() } catch (_) {} _libWatcher = null }
  // Config off-switch (App #18), default ON. A user who finds the watcher too
  // aggressive on a network mount can turn it off; the manual Rescan still works.
  if (store.get('folderWatchEnabled', true) === false) {
    console.log('[papa] folder auto-watch is disabled in settings; skipping the watcher')
    return
  }
  const folders = store.get('musicFolders', [])
  if (!folders.length) return
  // The extension filter used to run in the handler, AFTER chokidar had already
  // opened a descriptor for every directory 30 levels deep. On a large library
  // that can exhaust the inotify limit — and ignorePermissionErrors:true masked
  // it, so parts of the library silently stopped being watched.
  const WATCH_DEPTH = 8
  const IGNORED_DIRS = /(?:^|[\\/])(?:\.|@eaDir$|__MACOSX$|node_modules$|\$RECYCLE\.BIN$|System Volume Information$)/i
  _libWatcher = chokidar.watch(folders, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 400 },
    ignorePermissionErrors: true,
    // 30 was arbitrary; a music library is artist/album/disc at worst. Each
    // extra level is a descriptor per directory at that level.
    depth: WATCH_DEPTH,
    ignored: (fsPath, stats) => {
      if (IGNORED_DIRS.test(fsPath)) return true
      // Only files are filtered by extension: a directory has to be watched to
      // learn about the files inside it.
      if (stats && stats.isFile()) return !AUDIO_EXT.test(fsPath) && !/\.cue$/i.test(fsPath)
      return false
    },
  })
  // Descriptor exhaustion is the failure this item is about, and it arrives here
  // rather than as an exception. Hiding it is what made it invisible.
  _libWatcher.on('error', (e) => {
    const msg = String((e && e.message) || e)
    if (/ENOSPC|EMFILE|ENFILE/.test(msg)) {
      console.error('[papa] the library watcher ran out of file descriptors, so changes on disk will ' +
        'no longer be noticed automatically. Raise fs.inotify.max_user_watches, or reduce the watched ' +
        'folders. Original error: ' + msg)
      safeSend('slskd-status-change', { watcherFailed: true })
    } else {
      console.error('[papa] library watcher error:', msg)
    }
  })
  // The debounce cleared and reset on every event, so copying an album in kept
  // deferring the scan indefinitely while burning CPU on debounce churn. The
  // ceiling (max-wait) is what stops that: once the first event in a burst is
  // that old, the scan runs regardless. Both windows now come from the pure
  // watch-debounce policy (App #18): a download landing inside a watched root
  // produces an event storm, so while a download is active AND its directory is
  // inside a watched root the windows widen hard (30 s / 120 s) rather than
  // scanning every few seconds through the whole download.
  const _downloadDirForWatch = (() => {
    try { return _downloadDir() } catch (_) { return null }
  })()
  const _downloadsInsideWatched = watchDebounce.downloadsInsideWatched(_downloadDirForWatch, folders)
  const _watchConditions = () => ({
    activeDownloads: _downloadsAreActive(),
    downloadsInsideWatchedRoot: _downloadsInsideWatched,
  })
  let _watchFirstEventAt = 0
  let _watchEvents = 0

  const runWatchScan = async () => {
    _watchDebounce = null
    const events = _watchEvents
    _watchFirstEventAt = 0
    _watchEvents = 0
    // Still a full-tree scan for one changed file — item 166, not fixed here:
    // an incremental merge needs a real library to verify against, and getting a
    // partial merge wrong silently drops albums. Logging what it cost at least
    // makes the case measurable rather than asserted.
    const started = Date.now()
    const res = await performScan(null)
    if (res.failed) {
      console.error('[papa] watcher-triggered scan failed; leaving the library as it was')
      return
    }
    console.log(`[papa] watcher: rescanned the whole library after ${events} file event(s) ` +
      `in ${Date.now() - started}ms (${res.albums.length} albums)`)
    safeSend('library-updated', { albums: res.albums, reason: 'watcher' })
    writeLibraryExt(res.albums)
  }

  const onFsEvent = (fsPath) => {
    if (!AUDIO_EXT.test(fsPath) && !/\.cue$/i.test(fsPath)) return
    _watchEvents++
    const now = Date.now()
    if (!_watchFirstEventAt) _watchFirstEventAt = now
    // The windows are recomputed per event: a download that starts mid-burst
    // should widen the debounce from here on rather than the next watcher setup.
    const cond = _watchConditions()
    const maxWaitMs = watchDebounce.chooseMaxWait(cond)
    if (watchDebounce.shouldRunNow({ firstEventAt: _watchFirstEventAt, now, maxWaitMs })) {
      // Past the ceiling: do not defer again, however many more events arrive.
      if (_watchDebounce) { clearTimeout(_watchDebounce); _watchDebounce = null }
      runWatchScan()
      return
    }
    clearTimeout(_watchDebounce)
    _watchDebounce = setTimeout(runWatchScan, watchDebounce.chooseDebounce(cond))
  }
  _libWatcher.on('add', onFsEvent).on('unlink', onFsEvent).on('change', onFsEvent)
}

function buildAlbums(tracks) {
  const map = new Map()
  for (const t of tracks) {
    const key = tagEdit.albumKeyOf(t)
    if (!map.has(key)) {
      map.set(key, {
        id: crypto.createHash('md5').update(key).digest('hex'),
        name: t.album, artist: t.albumArtist || t.artist,
        year: t.year, artPath: t.artPath, tracks: []
      })
    }
    const album = map.get(key)
    if (!album.artPath && t.artPath) album.artPath = t.artPath
    if (t.addedAt && t.addedAt > (album._maxAddedAt || 0)) album._maxAddedAt = t.addedAt
    album.tracks.push({ id: t.id, title: t.title, artist: t.artist, genre: t.genre || null,
      trackNumber: t.trackNumber, discNumber: t.discNumber,
      duration: t.duration, filePath: t.filePath,
      sampleRate: t.sampleRate || 0, bitsPerSample: t.bitsPerSample || 0, channels: t.channels || 0,
      replayGainTrack: t.replayGainTrack ?? null, replayGainAlbum: t.replayGainAlbum ?? null,
      year: t.year || null, composer: t.composer || null, codec: t.codec || null,
      bitrate: t.bitrate || null, fileSize: t.fileSize || null, addedAt: t.addedAt || 0,
      atmos: t.atmos || false, needsTranscode: t.needsTranscode || false, hasEmbeddedLyrics: t.hasEmbeddedLyrics || false,
      cueStart: t.cueStart ?? null, cueEnd: t.cueEnd ?? null })
  }
  for (const [, a] of map) {
    if (!a.artPath) {
      const cached = path.join(artworkDir, `${a.id}.jpg`)
      if (fs.existsSync(cached)) a.artPath = cached
    }
    a.tracks.sort((x, y) => x.discNumber - y.discNumber || x.trackNumber - y.trackNumber)
    a.maxBitsPerSample = Math.max(0, ...a.tracks.map(t => t.bitsPerSample || 0))
    a.maxSampleRate    = Math.max(0, ...a.tracks.map(t => t.sampleRate    || 0))
    // Highest channel count on the album, so multichannel releases can be
    // spotted while browsing rather than only inside the track list.
    a.maxChannels      = Math.max(0, ...a.tracks.map(t => t.channels      || 0))
    a.atmos            = a.tracks.some(t => t.atmos)
    a.maxSampleRate    = Math.max(0, ...a.tracks.map(t => t.sampleRate    || 0))
    a.maxBitsPerSample = Math.max(0, ...a.tracks.map(t => t.bitsPerSample || 0))
    a.codec            = (a.tracks.find(t => t.codec) || {}).codec || null
    a.isHiRes  = a.maxBitsPerSample >= 24 && a.maxSampleRate > 48000
    const genreCounts = {}
    for (const t of a.tracks) { if (t.genre) genreCounts[t.genre] = (genreCounts[t.genre]||0)+1 }
    a.genre = Object.entries(genreCounts).sort((x,y)=>y[1]-x[1])[0]?.[0] || null
    a.addedAt  = a._maxAddedAt || 0
    delete a._maxAddedAt
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ── Extension state sync ──────────────────────────────────────────────────────
const LIBRARY_EXT_PATH = path.join(USER_DATA, 'library.json')

function writeLibraryExt(albums) {
  try {
    const slim = (albums || []).map(a => ({
      id: a.id, name: a.name, artist: a.artist, artPath: a.artPath || null,
      isHiRes: a.isHiRes || false,
      maxBitsPerSample: a.maxBitsPerSample || 0,
      maxSampleRate: a.maxSampleRate || 0,
      tracks: (a.tracks || []).map(t => ({
        title: t.title || '',
        filePath: t.filePath || '',
        trackNumber: t.trackNumber || 0,
        duration: t.duration || 0,
        sampleRate: t.sampleRate || 0,
        bitsPerSample: t.bitsPerSample || 0,
      })),
    }))
    fs.writeFileSync(LIBRARY_EXT_PATH, JSON.stringify(slim))
  } catch (_) {}
}

let _lastNotifiedId = null

ipcMain.on('update-now-playing',  (_, data)   => {
  writeNowPlaying(data)
  updateMpris(data)
  const nowTitle = data.title ? `${data.title} — ${data.artist || ''}` : null
  // The tooltip has exactly one writer: refreshTrayTooltip. This used to set it
  // here too, and the engine-event refresh — reading a _trayTrack that nothing
  // ever fed — overwrote it with a bare "Papa Audio" on every play/pause.
  _trayTrack = data.title ? { title: data.title, artist: data.artist || '' } : null
  if (_trayNow.title !== nowTitle || _trayNow.playing !== !!data.playing) {
    _trayNow = { title: nowTitle, playing: !!data.playing }
    updateTrayMenu(!!data.playing)
  }
  refreshTrayTooltip()
  if (data.title && data.playing && `${data.title}|${data.artist}|${data.album}` !== _lastNotifiedId) {
    _lastNotifiedId = `${data.title}|${data.artist}|${data.album}`
    if (Notification.isSupported()) {
      const n = new Notification({
        title: data.title || 'Unknown',
        body: `${data.artist || ''}${data.album ? ' — ' + data.album : ''}`,
        icon: data.artPath && !data.artPath.startsWith('http') ? data.artPath : undefined,
        silent: true,
      })
      n.on('click', () => { if (mainWindow) mainWindow.show() })
      n.show()
    }
  }
})
ipcMain.on('update-library-ext',  (_, albums) => writeLibraryExt(albums))

// ── Misc state ───────────────────────────────────────────────────────────────
ipcMain.on('save-recently-played', (_, id) => {
  sideStores.recentlyPlayed.update(prev => {
    const r = (Array.isArray(prev) ? prev : []).filter(x => x !== id)
    r.unshift(id)
    return r.slice(0, 20)
  })
})
ipcMain.on('save-volume', (_, v) => store.set('volume', v))

// The "saved sites" pair lived here. They stored URLs for the embedded browser
// to open; with that browser gone there is nothing to open them in, and neither
// handler was ever reachable from the renderer in the first place.

// ── Downloads ────────────────────────────────────────────────────────────────
const activeDownloads = new Map()
const MUSIC_EXT = /\.(flac|mp3|wav|aiff?|m4a|ogg|opus|ape|wv|wma|dsf|dff|aac|m4b)$/i

// ── Download handler (session-level: the sign-in window, magnet/.torrent) ───
function ensureDlHandler() {
  if (dlHandlerReady) return
  dlHandlerReady = true
  const { session } = require('electron')
  session.defaultSession.on('will-download', (_, item) => {
    const filename  = item.getFilename()
    if (/\.torrent$/i.test(filename)) {
      const tmp = path.join(app.getPath('temp'), filename)
      item.setSavePath(tmp)
      item.once('done', (__, state) => {
        if (state === 'completed') { _torrentAdd(tmp); safeSend('torrent-started', { uri: tmp }) }
      })
      return
    }
    const dlId      = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const isMusic   = MUSIC_EXT.test(filename)
    const isArchive = /\.(zip|rar|7z)$/i.test(filename)
    const folders   = store.get('musicFolders', [])
    const dest = (isMusic || isArchive)
      ? path.join(folders[0] || app.getPath('downloads'), filename)
      : path.join(app.getPath('downloads'), filename)
    item.setSavePath(dest)
    activeDownloads.set(dlId, item)
    safeSend('dl-started', { id: dlId, filename, dest, total: item.getTotalBytes(), isMusic })
    item.on('updated', (__, state) => {
      if (state === 'progressing')
        safeSend('dl-progress', { id: dlId, filename, received: item.getReceivedBytes(), total: item.getTotalBytes() })
    })
    item.once('done', (__, state) => {
      activeDownloads.delete(dlId)
      if (state === 'completed') {
        if (isArchive) { try { new AdmZip(dest).extractAllTo(path.dirname(dest), true) } catch (e) { console.error('[papa] zip-extract:', e.message || e) } }
        safeSend('dl-complete', { id: dlId, filename, dest, isMusic })
      } else if (state === 'cancelled') {
        safeSend('dl-cancelled', { id: dlId, filename })
      } else {
        safeSend('dl-failed', { id: dlId, filename })
      }
    })
  })
}

// Electron-initiated downloads (a link clicked in the Google sign-in window, a
// .torrent) are cancellable from the downloads page.
ipcMain.on('cancel-download', (_, id) => {
  const item = activeDownloads.get(id)
  if (!item) return
  try { item.cancel() } catch (_) { /* already finished */ }
  activeDownloads.delete(id)
})

// ══════════════════════════════════════════════════════════════════════════════
// LOCAL AGENT — Ollama-powered assistant over the app's own pages
// ══════════════════════════════════════════════════════════════════════════════

const http = require('http')

// POST to Ollama's chat endpoint, stream the response, resolve with full text
function ollamaChat(model, messages, onToken) {
  const MS = 30000
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Ollama chat timed out')) }, MS)
    const body = JSON.stringify({ model, messages, stream: true })
    const req  = http.request(
      { hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let full = ''
        res.on('data', chunk => {
          for (const line of chunk.toString().split('\n')) {
            if (!line.trim()) continue
            try {
              const obj  = JSON.parse(line)
              const tok  = obj.message?.content || ''
              full += tok
              if (onToken && tok) onToken(tok)
            } catch (_) {}
          }
        })
        res.on('end', () => { clearTimeout(timer); resolve(full) })
      }
    )
    req.on('error', (err) => { clearTimeout(timer); reject(err) })
    req.write(body)
    req.end()
  })
}

function ollamaGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 11434, path }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch(e) { reject(e) } })
    }).on('error', reject)
  })
}

// ── Music Chat Agent (multi-provider: Claude / OpenAI / Ollama) ──────────────

function _buildAgentSystem() {
  const profile = store.get('agentProfile', null)
  let sys = `You are the AI agent inside Papa Audio, a personal hi-fi music player. You have COMPLETE control over the app.

## How to behave
- Act immediately with tools — NEVER explain what you're about to do, just do it.
- NEVER say things like "It looks like...", "Let me try...", "I'll attempt...", "The system seems to...". Just call the tool.
- After ALL tools are done, respond with ONE sentence max. No paragraphs, no lists, no explanations.
- If a tool returns "not found in library", try youtube_play (instant stream) next without asking or commenting; use auto_download when the user wants to keep the file.
- Prefer lossless (FLAC) sources always.

## Full capabilities
PLAYBACK: play_from_library, play_track, play_artist, play_liked, control_playback (play/pause/next/prev/stop), seek, set_speed, set_repeat, set_shuffle
VOLUME: set_volume (0–100)
QUEUE: add_to_queue, clear_queue, shuffle_queue, get_queue, save_queue
DOWNLOADS: auto_download (finds best FLAC and downloads automatically), search_and_download (shows options)
YOUTUBE: youtube_search (find on YouTube), youtube_play (stream instantly, nothing saved), youtube_download (save lossy audio file)
LIBRARY: search_library, get_library (full overview)
NAVIGATION: navigate (home/library/search/downloads/browse)
UTILITY: get_status, sleep_timer, like_album

## Decision rules
- "play X" → ALWAYS try play_from_library first. Pass ONLY the artist name, album name, or song title as the query — never pass the full user sentence. Example: user says "play some pink floyd songs" → query: "pink floyd". If play_from_library returns "not found", use youtube_play to stream it instantly, then auto_download in the background if the user wants to keep it.
- Fallback order for playing music: 1) local library, 2) youtube_play (instant stream), 3) auto_download from Soulseek (lossless, for keeps).
- "download X" → auto_download first (lossless). If Soulseek finds nothing, youtube_download as last resort.
- "play all songs by X" / "play artist X" → use play_artist with just the artist name as query.
- NEVER assume something isn't in the library without calling play_from_library or search_library first.
- "download X" → auto_download (no confirmation needed)
- "something similar" / "more like this" → get_status first, then play_artist or auto_download
- "shuffle my library" → play_artist with a broad query, then set_shuffle on
- "stop in X minutes" → sleep_timer
- If the user says the same song keeps playing, call get_status to check repeat mode — if repeat is "one", call set_repeat with mode "off".
- If play_from_library says not found AND you're about to download, say what you're doing in one sentence.`
  if (profile?.raw) sys += `\n\n## What you know about this user\n${profile.raw}`
  return sys
}

// ── Anthropic (Claude) ────────────────────────────────────────────────────────
async function claudeChat(apiKey, model, messages, tools, system) {
  const body = JSON.stringify({ model, max_tokens: 1024, system: system || _buildAgentSystem(), messages, tools: tools?.length ? tools : undefined })
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(`Claude API ${res.status}: ${t.slice(0,200)}`) }
  return res.json()
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function openaiChat(apiKey, model, messages, tools, system) {
  const oaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system || _buildAgentSystem() }, ...messages],
    ...(oaiTools.length ? { tools: oaiTools, tool_choice: 'auto' } : {}),
    max_tokens: 1024,
  })
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(`OpenAI API ${res.status}: ${t.slice(0,200)}`) }
  const data = await res.json()
  // Normalise to Anthropic-style response
  const choice = data.choices?.[0]
  const msg = choice?.message
  const content = []
  if (msg?.content) content.push({ type: 'text', text: msg.content })
  for (const tc of (msg?.tool_calls || [])) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') })
  }
  return { content, stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn' }
}

// ── Ollama (local) — expanded intent parser ───────────────────────────────────
async function ollamaAgentChat(model, messages, tasteProfile) {
  const profile = store.get('agentProfile', null)
  const SIMPLE_SYS = `You are Papa Audio's AI agent. You fully control a music player app. Parse EVERY user request into JSON — no plain text.
Reply ONLY with valid JSON, nothing else.

Available intents (pick the best match):
{"intent":"play","query":"<album or artist name from local library>","reply":"<one sentence>"}
{"intent":"play_track","query":"<specific track title>","reply":"<one sentence>"}
{"intent":"play_artist","query":"<artist name>","reply":"<one sentence>"}
{"intent":"download","query":"<music to find on Soulseek and download automatically>","reply":"<one sentence>"}
{"intent":"search","query":"<music to search on Soulseek, show options>","reply":"<one sentence>"}
{"intent":"control","action":"play|pause|next|prev|stop","reply":"<one sentence>"}
{"intent":"volume","level":<0-100>,"reply":"<one sentence>"}
{"intent":"queue_add","query":"<album or artist to add to queue>","reply":"<one sentence>"}
{"intent":"queue_clear","reply":"<one sentence>"}
{"intent":"queue_shuffle","reply":"<one sentence>"}
{"intent":"like","reply":"<one sentence>"}
{"intent":"navigate","page":"home|library|search|downloads|browse","reply":"<one sentence>"}
{"intent":"library","query":"<what to find in library>","reply":"<one sentence>"}
{"intent":"status","reply":"<one sentence>"}
{"intent":"chat","reply":"<your answer>"}

Rules:
- "play X" or "put on X" → intent:play if X sounds like local library content, intent:download if not found
- "download X" or "get me X" → intent:download
- "pause" / "stop" / "next" / "skip" / "back" → intent:control
- "louder" / "quieter" / "volume X%" → intent:volume
- "skip" = next, "back" = prev, "mute" = volume 0
- "like this" / "heart this" → intent:like` +
    (profile?.raw ? `\n\nUser profile: ${profile.raw}` : '') +
    (tasteProfile?.topArtists?.length ? `\nTop artists: ${tasteProfile.topArtists.slice(0,5).join(', ')}` : '')

  const msgs = [{ role: 'system', content: SIMPLE_SYS }, ...messages.slice(-8)]
  const raw = await ollamaChat(model, msgs, null)
  const m = raw.match(/\{[\s\S]*?\}/)
  if (m) { try { return JSON.parse(m[0]) } catch (_) {} }
  return { intent: 'download', query: messages[messages.length-1]?.content || '', reply: `Searching…` }
}

// ── Shared tool definitions for Claude / OpenAI ───────────────────────────────
const AGENT_TOOLS = [
  {
    name: 'play_from_library',
    description: 'Search the local library and play a match. Searches album names, artist names, AND individual track titles. Always call this before auto_download. IMPORTANT: pass ONLY the artist/album/song name as query, not the full sentence.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Artist name, album title, or song title ONLY — e.g. "Pink Floyd", "The Wall", "Comfortably Numb"' } }, required: ['query'] },
  },
  {
    name: 'play_track',
    description: 'Play a specific track by title from the local library',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Track title' } }, required: ['query'] },
  },
  {
    name: 'play_artist',
    description: 'Queue and play ALL tracks by an artist from the local library. Use this when user wants all songs by someone. Pass ONLY the artist name.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Artist name ONLY — e.g. "Pink Floyd"' } }, required: ['query'] },
  },
  {
    name: 'auto_download',
    description: 'Search Soulseek and automatically download the best lossless result — no confirmation needed',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Artist, album, or song to download' } }, required: ['query'] },
  },
  {
    name: 'search_and_download',
    description: 'Search Soulseek and show results for the user to choose from (use auto_download to skip confirmation)',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'search_library',
    description: 'Search the local music library and return matching albums/artists',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'control_playback',
    description: 'Control playback: play, pause, next track, previous track, or stop',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['play','pause','next','prev','stop'] } }, required: ['action'] },
  },
  {
    name: 'set_volume',
    description: 'Set playback volume. "louder"=+20, "quieter"=-20, "mute"=0',
    input_schema: { type: 'object', properties: { level: { type: 'number', description: '0–100' } }, required: ['level'] },
  },
  {
    name: 'add_to_queue',
    description: 'Add an album from the local library to the play queue',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'clear_queue',
    description: 'Clear the entire play queue',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'shuffle_queue',
    description: 'Shuffle the current play queue',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'like_album',
    description: 'Like or unlike the currently playing album, or an album by name',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Album name, or omit to use the currently playing album' } } },
  },
  {
    name: 'navigate',
    description: 'Navigate to a page: home, library, search, downloads, or browse',
    input_schema: { type: 'object', properties: { page: { type: 'string', enum: ['home','library','search','downloads','browse'] } }, required: ['page'] },
  },
  {
    name: 'get_status',
    description: 'Get current playing track, volume, library size, queue info, repeat/shuffle state',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_repeat',
    description: 'Set repeat mode: off, one (repeat current track), or all (repeat queue)',
    input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['off','one','all'] } }, required: ['mode'] },
  },
  {
    name: 'set_shuffle',
    description: 'Turn shuffle on or off',
    input_schema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
  },
  {
    name: 'set_speed',
    description: 'Set playback speed: 0.75, 1, 1.25, 1.5, or 2',
    input_schema: { type: 'object', properties: { speed: { type: 'number', enum: [0.75, 1, 1.25, 1.5, 2] } }, required: ['speed'] },
  },
  {
    name: 'seek',
    description: 'Seek to a position in the current track (seconds from start)',
    input_schema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
  },
  {
    name: 'sleep_timer',
    description: 'Set a sleep timer to stop playback after N minutes. Use 0 to cancel.',
    input_schema: { type: 'object', properties: { minutes: { type: 'number' } }, required: ['minutes'] },
  },
  {
    name: 'play_liked',
    description: 'Play all liked/favourited albums in the library',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_library',
    description: 'Get a full overview of the library: all artists, album counts, and genres',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_queue',
    description: 'Get the current play queue — what is playing and what is coming up',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'save_queue',
    description: 'Save the current queue as a named playlist',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Name for the saved queue' } }, required: ['name'] },
  },
  {
    name: 'youtube_search',
    description: 'Search YouTube for music. Returns top matches with videoId, title, artist, duration. scope "music" searches the YouTube Music catalog (clean song results); scope "all" searches all of YouTube (live sets, bootlegs, mixes). Pass ONLY the artist/song/album name as query.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Artist, song, or album name ONLY' }, scope: { type: 'string', enum: ['music', 'all'], description: 'Default "music"' } }, required: ['query'] },
  },
  {
    name: 'youtube_play',
    description: 'Search YouTube Music and instantly STREAM the best match — nothing is saved to disk. Use when a track is not in the local library and the user wants to hear it NOW. Pass ONLY the artist/song name.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Song and/or artist name ONLY' } }, required: ['query'] },
  },
  {
    name: 'youtube_download',
    description: 'Search YouTube Music and download the best match as an audio file into the music library (native quality, ~256kbps lossy). Prefer auto_download (Soulseek, lossless) for keeps; use this when Soulseek has nothing or the user explicitly asks for YouTube.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Song and/or artist name ONLY' } }, required: ['query'] },
  },
]

// ── Ollama tool-calling via OpenAI-compatible endpoint ────────────────────────
async function ollamaToolChat(model, messages, tools, system) {
  const oaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: system || _buildAgentSystem() }, ...messages],
    tools: oaiTools,
    tool_choice: 'auto',
    stream: false,
  })
  const res = await fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ollama' },
    body,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(`Ollama ${res.status}: ${t.slice(0,300)}`) }
  const data = await res.json()
  const choice = data.choices?.[0]
  const msg = choice?.message
  const content = []
  if (msg?.content) content.push({ type: 'text', text: msg.content })
  for (const tc of (msg?.tool_calls || [])) {
    let parsed = {}
    try { parsed = JSON.parse(tc.function?.arguments || '{}') } catch (_) {}
    content.push({ type: 'tool_use', id: tc.id || `call_${Date.now()}`, name: tc.function?.name, input: parsed })
  }
  return { content, stop_reason: (msg?.tool_calls?.length) ? 'tool_use' : 'end_turn' }
}

// Main IPC handler — called by renderer for each conversation turn
ipcMain.handle('agent-chat', async (_, { provider, messages, tasteProfile }) => {
  const keys = store.get('apiKeys', {})
  const sys  = _buildAgentSystem()

  if (provider === 'claude') {
    const apiKey = keys.claude
    if (!apiKey) return { error: 'No Claude API key. Add it in the Settings tab of the agent panel.' }
    const model = store.get('agentModel', 'claude-haiku-4-5-20251001')
    const response = await claudeChat(apiKey, model, messages, AGENT_TOOLS, sys)
    return { response }
  }

  if (provider === 'openai') {
    const apiKey = keys.openai
    if (!apiKey) return { error: 'No OpenAI API key. Add it in the Settings tab of the agent panel.' }
    const model = store.get('agentModel', 'gpt-4o-mini')
    const response = await openaiChat(apiKey, model, messages, AGENT_TOOLS, sys)
    return { response }
  }

  // Ollama — full tool-calling via OpenAI-compat endpoint
  const ollamaModel = store.get('agentModel', '')
  if (!ollamaModel) return { error: 'No Ollama model selected. Open Agent Settings and pick a model.' }
  try {
    const response = await ollamaToolChat(ollamaModel, messages, AGENT_TOOLS, sys)
    return { response }
  } catch (err) {
    // Fallback to simple intent parser if tool-calling fails (older Ollama / model doesn't support it)
    const result = await ollamaAgentChat(ollamaModel, messages, tasteProfile).catch(() =>
      ({ intent: 'download', query: messages[messages.length-1]?.content || '', reply: 'Searching…' })
    )
    return { ollamaFallback: result }
  }
})

// ── Agent memory IPC handlers ─────────────────────────────────────────────────

ipcMain.handle('agent-get-memory', () => {
  return {
    profile:    store.get('agentProfile', null),
    recentConvs: (store.get('agentConvHistory', [])).slice(-15),
  }
})

ipcMain.handle('agent-save-conv', (_, { title, summary, messageCount }) => {
  const history = store.get('agentConvHistory', [])
  history.push({ id: Date.now().toString(), startedAt: Date.now(), title, summary, messageCount })
  if (history.length > 50) history.splice(0, history.length - 50)
  store.set('agentConvHistory', history)
  return { ok: true }
})

ipcMain.handle('agent-update-profile', async (_, { messages }) => {
  const keys     = store.get('apiKeys', {})
  const provider = store.get('agentProvider', 'ollama')
  const existing = store.get('agentProfile', { insights: [], raw: '', updatedAt: null })

  const insightPrompt = `Analyze this conversation and extract or update insights about the user's music taste and habits.
Return ONLY valid JSON in exactly this format:
{
  "insights": [
    {"key": "taste",   "text": "Likes lossless FLAC; prefers jazz, metal, ambient"},
    {"key": "artists", "text": "Interested in Miles Davis, Opeth, Brian Eno"},
    {"key": "habits",  "text": "Downloads complete albums, listens late at night"},
    {"key": "style",   "text": "Prefers minimal vocals, complex instrumentation"}
  ],
  "summary": "One sentence describing what happened in this conversation"
}
Only include keys where you have clear evidence. Merge with existing insights — don't discard what was already known.
Existing insights: ${JSON.stringify(existing.insights || [])}`

  const profileMsg = [{ role: 'user', content: insightPrompt + '\n\nConversation:\n' +
    messages.slice(-20).map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n')
  }]

  let parsed = null
  const jsonSys = 'You extract structured JSON from text. Return only valid JSON, no markdown, no explanation.'
  try {
    if (provider === 'claude' && keys.claude) {
      const model = store.get('agentModel', 'claude-haiku-4-5-20251001')
      const res = await claudeChat(keys.claude, model, profileMsg, null, jsonSys)
      const text = (res.content || []).find(b => b.type === 'text')?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (m) parsed = JSON.parse(m[0])
    } else if (provider === 'openai' && keys.openai) {
      const model = store.get('agentModel', 'gpt-4o-mini')
      const res = await openaiChat(keys.openai, model, profileMsg, null, jsonSys)
      const text = (res.content || []).find(b => b.type === 'text')?.text || ''
      const m = text.match(/\{[\s\S]*\}/)
      if (m) parsed = JSON.parse(m[0])
    } else {
      // Ollama path — use streaming chat with a tight JSON-only prompt
      const ollamaModel = store.get('agentModel', '')
      if (ollamaModel) {
        const ollamaMsgs = [
          { role: 'system', content: jsonSys },
          ...profileMsg,
        ]
        const text = await ollamaChat(ollamaModel, ollamaMsgs)
        const m = text.match(/\{[\s\S]*\}/)
        if (m) parsed = JSON.parse(m[0])
      }
    }
  } catch (_) {}

  if (parsed?.insights?.length) {
    const merged = [...(existing.insights || [])]
    for (const ins of parsed.insights) {
      const ex = merged.find(e => e.key === ins.key)
      if (ex) { ex.text = ins.text; ex.updatedAt = Date.now() }
      else merged.push({ ...ins, updatedAt: Date.now() })
    }
    const raw = merged.map(i => `${i.key}: ${i.text}`).join('\n')
    store.set('agentProfile', { insights: merged, raw, updatedAt: Date.now() })
    return { ok: true, insights: merged, summary: parsed.summary }
  }
  return { ok: false }
})

ipcMain.handle('agent-clear-memory', () => {
  store.delete('agentProfile')
  store.delete('agentConvHistory')
  return { ok: true }
})

ipcMain.handle('get-api-keys', () => {
  const keys = store.get('apiKeys', {})
  return {
    claudeSet:  !!keys.claude,
    openaiSet:  !!keys.openai,
    claudeHint: keys.claude ? keys.claude.slice(0, 14) + '…' : null,
    openaiHint: keys.openai ? keys.openai.slice(0, 14) + '…' : null,
    provider:   store.get('agentProvider', 'ollama'),
  }
})

ipcMain.handle('save-api-keys', (_, { provider, claudeKey, openaiKey }) => {
  const keys = store.get('apiKeys', {})
  // Only overwrite if a non-empty value was actually provided
  if (claudeKey && claudeKey.trim()) keys.claude = claudeKey.trim()
  if (openaiKey && openaiKey.trim()) keys.openai = openaiKey.trim()
  store.set('apiKeys', keys)
  if (provider) store.set('agentProvider', provider)
  return { ok: true }
})

ipcMain.on('taste-record-play', (_, data) => {
  try {
    const profile = store.get('tasteProfile', { plays: [] })
    profile.plays.push({ artist: data.artist || '', album: data.album || '', title: data.title || '', ts: Date.now() })
    if (profile.plays.length > 2000) profile.plays = profile.plays.slice(-2000)
    store.set('tasteProfile', profile)
  } catch (_) {}
})

ipcMain.handle('taste-get-profile', () => {
  try {
    const profile = store.get('tasteProfile', { plays: [] })
    const counts = {}
    for (const p of profile.plays) {
      if (p.artist) counts[p.artist] = (counts[p.artist] || 0) + 1
    }
    const topArtists = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n]) => n)
    const recent = profile.plays.slice(-20).reverse()
    return { totalPlays: profile.plays.length, topArtists, recent }
  } catch (_) { return { totalPlays: 0, topArtists: [], recent: [] } }
})

ipcMain.handle('get-agent-model', () => store.get('agentModel', ''))
ipcMain.on('save-agent-model', (_, m) => store.set('agentModel', m))

ipcMain.handle('check-ollama', async () => {
  try {
    const data = await ollamaGet('/api/tags')
    const models = (data.models || []).map(m => m.name)
    return { running: true, models }
  } catch { return { running: false, models: [] } }
})

// ── iTunes artwork ────────────────────────────────────────────────────────────
function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'))
    const req = https.get(url, { headers: { 'User-Agent': 'PapaAudio/1.0' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
        return httpsGet(res.headers.location, redirects + 1).then(resolve).catch(reject)
      // A 404 or 403 body used to resolve as if it were the payload, and
      // fetch-album-art wrote it to disk as <albumId>.jpg — poisoning that
      // album's artwork permanently, because the next call short-circuits on
      // the file existing.
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        const err = new Error(`HTTP ${res.statusCode} for ${url}`)
        err.statusCode = res.statusCode
        return reject(err)
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

// An image, not just bytes. A 404 page written as <albumId>.jpg is worse than no
// artwork: the file exists, so every later attempt short-circuits and the album
// can never get a cover again.
function looksLikeImage(buf) {
  if (!buf || buf.length < 1024) return false          // no real cover is under 1 KB
  const b = buf
  const jpeg = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
  const webp = b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
  return jpeg || png || webp
}

// Remembers which albums have already been looked up and found nothing, so a
// miss costs one request a day rather than one per visit — and, unlike writing a
// broken file, it can expire.
const ART_MISS_TTL_MS = 24 * 60 * 60 * 1000
const _artMisses = new Map()

ipcMain.handle('fetch-album-art', async (_, { albumId, artist, album }) => {
  const cached = path.join(artworkDir, `${albumId}.jpg`)
  try {
    if (fs.existsSync(cached)) {
      // Trust the file only if it is actually an image. A previously poisoned
      // cache entry is repaired here rather than being believed forever.
      const existing = fs.readFileSync(cached)
      if (looksLikeImage(existing)) return { artPath: cached }
      console.warn(`[papa][art] ${albumId}.jpg is not an image (${existing.length} bytes); refetching`)
      try { fs.unlinkSync(cached) } catch (_) {}
    }
    const missAt = _artMisses.get(albumId)
    if (missAt && Date.now() - missAt < ART_MISS_TTL_MS) return null
    if (_artMisses.size > 500) _artMisses.clear()

    const query = encodeURIComponent(`${artist} ${album}`)
    const raw = await httpsGet(`https://itunes.apple.com/search?term=${query}&entity=album&limit=8&media=music`)
    const data = JSON.parse(raw.toString())
    if (!data.results?.length) { _artMisses.set(albumId, Date.now()); return null }
    const al = String(album || '').toLowerCase(), ar = String(artist || '').toLowerCase().split(/\s+/)[0]
    // No fallback to results[0]: with limit=8 on a free-text search the first
    // result for anything obscure is routinely a different release, and writing
    // it used to cache the wrong cover permanently. No match means no art.
    const best = data.results.find(r =>
      r.collectionName?.toLowerCase().includes(al) && r.artistName?.toLowerCase().includes(ar)
    ) || data.results.find(r => r.collectionName?.toLowerCase().includes(al))
    if (!best?.artworkUrl100) { _artMisses.set(albumId, Date.now()); return null }
    const imgBuf = await httpsGet(best.artworkUrl100.replace('100x100bb', '600x600bb'))
    if (!looksLikeImage(imgBuf)) {
      console.error(`[papa][art] ${artist} — ${album}: response was not an image, not caching`)
      _artMisses.set(albumId, Date.now())
      return null
    }
    // Temp file plus rename, so a partial write is never visible as a cover.
    const tmp = cached + '.part'
    fs.writeFileSync(tmp, imgBuf)
    fs.renameSync(tmp, cached)
    return { artPath: cached }
  } catch (e) {
    _artMisses.set(albumId, Date.now())
    console.error(`[papa][art] ${artist} — ${album}:`, String(e && e.message || e))
    try { if (fs.existsSync(cached + '.part')) fs.unlinkSync(cached + '.part') } catch (_) {}
    return null
  }
})

// ── Tag fixer: MusicBrainz lookup (App #60) ───────────────────────────────────
// Propose-only this wave. We query MusicBrainz for a release matching a local
// album's artist+album, fetch its track list, and hand it back for the renderer
// to diff against local tags. No files are written.
//
// MusicBrainz asks two things of every client: a descriptive User-Agent with a
// contact, and no more than one request per second. Both are enforced here — the
// UA is fixed, and _mbThrottle serialises calls behind a 1.1 s spacing so a burst
// of album checks cannot trip the rate limit and get us blocked.
const MB_BASE = 'https://musicbrainz.org/ws/2'
const MB_UA = `PapaAudio/${(() => { try { return require('./package.json').version || '1.0' } catch (_) { return '1.0' } })()} ( https://github.com/aaddrick/claude-desktop-debian )`
const MB_MIN_INTERVAL_MS = 1100
let _mbLastAt = 0
let _mbChain = Promise.resolve()

// Serialise every MusicBrainz request behind the 1 req/s ceiling: each call waits
// for the previous one to finish AND for at least MB_MIN_INTERVAL_MS to have
// elapsed since the last request actually went out.
function _mbThrottle(fn) {
  const run = _mbChain.then(async () => {
    const wait = MB_MIN_INTERVAL_MS - (Date.now() - _mbLastAt)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    _mbLastAt = Date.now()
    return fn()
  })
  // Keep the chain alive even if this call rejects, so one failure does not wedge
  // every later request.
  _mbChain = run.then(() => {}, () => {})
  return run
}

function _mbGetJson(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const url = `${MB_BASE}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}fmt=json`
    const req = https.get(url, { headers: { 'User-Agent': MB_UA, 'Accept': 'application/json' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        return reject(new Error(`unexpected redirect ${res.statusCode}`))
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        return reject(new Error(`MusicBrainz HTTP ${res.statusCode}`))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (e) { reject(new Error(`bad JSON from MusicBrainz: ${e.message}`)) }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('MusicBrainz timeout')) })
  })
}

// Look up a release by artist+album and return its track titles/numbers. Returns
// { ok, release, tracks } or { ok: false, error }. tracks is [{ title, position }]
// ready for PapaMusicTools.buildTagDiff. Two throttled requests: a search, then
// the chosen release's recordings.
ipcMain.handle('musicbrainz-check-album', async (_, { artist, album } = {}) => {
  const ar = String(artist || '').trim()
  const al = String(album || '').trim()
  if (!al) return { ok: false, error: 'no album name to look up' }
  try {
    // Lucene-escape the quotes-sensitive query. artist is optional — some
    // downloads have only an album folder name.
    const q = ar
      ? `release:"${al.replace(/"/g, '\\"')}" AND artist:"${ar.replace(/"/g, '\\"')}"`
      : `release:"${al.replace(/"/g, '\\"')}"`
    const search = await _mbThrottle(() =>
      _mbGetJson(`/release/?query=${encodeURIComponent(q)}&limit=5`))
    const releases = (search && search.releases) || []
    if (!releases.length) return { ok: true, release: null, tracks: [], reason: 'no-match' }
    // Prefer the highest-scored release that actually has recordings we can read.
    const chosen = releases[0]
    const detail = await _mbThrottle(() =>
      _mbGetJson(`/release/${encodeURIComponent(chosen.id)}?inc=recordings`))
    const tracks = []
    const media = (detail && detail.media) || []
    for (const m of media) {
      for (const tr of (m.tracks || [])) {
        tracks.push({ title: tr.title || (tr.recording && tr.recording.title) || '', position: Number(tr.position) || 0 })
      }
    }
    return {
      ok: true,
      release: {
        id: chosen.id,
        title: detail.title || chosen.title || al,
        artist: (chosen['artist-credit'] && chosen['artist-credit'][0] && chosen['artist-credit'][0].name) || ar,
        date: detail.date || chosen.date || '',
        score: chosen.score || 0,
      },
      tracks: tracks,
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  }
})

// ── Soulseek IPC ─────────────────────────────────────────────────────────────
ipcMain.handle('slsk-status', async () => {
  const installed = fs.existsSync(SLSKD_BIN)
  const cfg = store.get('slskConfig', {})
  if (!installed) return { installed: false, running: false, connected: false, configured: false }
  try {
    const data = await slskdFetch('GET', '/application')
    return {
      installed: true, running: true,
      connected: data?.server?.isLoggedIn ?? false,
      configured: !!(cfg.username && cfg.password),
      username: data?.user?.username || cfg.username || '',
    }
  } catch (_) {
    return { installed: true, running: !!(slskdProc || slskdReady), connected: false, configured: !!(cfg.username && cfg.password) }
  }
})

ipcMain.handle('slsk-get-config', () => {
  const cfg = store.get('slskConfig', {})
  return { username: cfg.username || '', configured: !!(cfg.username && cfg.password) }
})

ipcMain.handle('slsk-configure', async (_, { username, password }) => {
  // Merged, not replaced: this used to overwrite the whole slskConfig object,
  // so changing the Soulseek password silently forgot the download folder the
  // user had picked -- and the next config write sent downloads somewhere else.
  const prev = store.get('slskConfig', {})
  store.set('slskConfig', { ...prev, username, password })
  writeSlskdConfig({ username, password, downloadDir: _downloadDir() })
  stopSlskd()
  await startSlskd()
  return { ok: true }
})

ipcMain.handle('slsk-setup', async () => {
  try {
    await downloadSlskd(text => safeSend('slsk-progress', { text }))
    const cfg = store.get('slskConfig', {})
    writeSlskdConfig({ ...cfg, downloadDir: _downloadDir() })
    safeSend('slsk-progress', { text: 'Starting daemon…' })
    await startSlskd()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ── Search result cache (in-memory, 5-min TTL, cleared on restart) ────────────
// The cap of 200 used to be enforced by dropping only EXPIRED entries, so a run
// of distinct searches inside the five minutes grew the Map without limit --
// and each entry holds a whole search response, issued with responseLimit 5000.
const SEARCH_CACHE_CAP = 200
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000
const _searchCache = makeCache({ cap: SEARCH_CACHE_CAP, ttlMs: SEARCH_CACHE_TTL_MS })
function _searchCacheGet(key) {
  const v = _searchCache.get(key)
  return v === undefined ? null : v
}
function _searchCacheSet(key, results) {
  _searchCache.set(key, results)
}

// ── Search persistence across restarts (App #53) ─────────────────────────────
// The in-memory cache above dies with the process. This is its on-disk sibling:
// the last ~20 searches, capped at ~2 MB total, so a repeat search after a
// restart can serve its previous results instantly (fromCache) while a live one
// revalidates — the same stale-while-revalidate the browse cache uses. The RAW
// normalized response list is stored, never DOM. All reads/writes are best-
// effort: the memory of a past search must never be able to break a new one.
function _searchPersistGet(query) {
  try { return searchHistory.get(sideStores.searchHistory.get() || [], query) }
  catch (_) { return null }
}
function _searchPersistSet(query, results) {
  try {
    sideStores.searchHistory.update(prev =>
      searchHistory.put(prev || [], query, results, Date.now()))
  } catch (_) { /* a failed write just forgets this search */ }
}

// One background live search that revalidates a served-from-cache query and
// pushes its fresh results through the normal slsk-progress channel the renderer
// already consumes. Mirrors _browseRefresh: guarded so two overlapping serves of
// the same query do not run two live searches, and a failure leaves the cached
// copy in place silently.
const _searchRevalidating = new Set()
function _searchRevalidate(args) {
  const key = (args.query || '').toLowerCase().trim()
  if (!key || _searchRevalidating.has(key)) return
  _searchRevalidating.add(key)
  ;(async () => {
    // noCache forces a live run past the in-memory hit; the progressive and
    // final slsk-progress events inside slskRunSearch repaint the served list.
    try { await slskRunSearch({ ...args, noCache: true }) }
    catch (_) { /* the served cache stays; a failed refresh is invisible */ }
    finally { _searchRevalidating.delete(key) }
  })()
}

// Every search slskd is currently running for us, and why. Each search runs six
// variants for up to 30 s; starting a new one left all six of the old ones going,
// competing for the daemon's search slots and for the same peers' attention.
// Nothing could cancel them, and nothing even knew they existed.
const _liveSearches = new Map()      // slskd search id -> { generation, query }
const _cancelledSearches = new Set() // ids whose loop should stop at its next tick

// A generation below this is a background search that no UI search owns — the
// assistant panel's, for instance. Those must never be cancelled by someone
// typing in the search box, so they are excluded rather than compared.
const BACKGROUND_GENERATION = -1

// Called with the generation the renderer is now on; everything older goes.
async function cancelSearchesExcept(keepGeneration) {
  const doomed = []
  for (const [id, info] of _liveSearches) {
    if (info.generation === keepGeneration) continue
    if (info.generation <= BACKGROUND_GENERATION) continue
    doomed.push({ id, info })
  }
  for (const { id, info } of doomed) {
    _cancelledSearches.add(id)
    _liveSearches.delete(id)
    try {
      await slskdFetch('DELETE', `/searches/${id}`)
    } catch (e) {
      // Already gone is the common case and not worth reporting loudly.
      if (!/\b404\b/.test(String(e && e.message || e))) {
        console.error(`[papa] could not cancel the search for "${info.query}":`, String(e && e.message || e))
      }
    }
  }
  if (doomed.length) console.log(`[papa] cancelled ${doomed.length} superseded search(es) at the daemon`)
  return doomed.length
}

ipcMain.handle('slsk-cancel-searches', async (_, { keepGeneration } = {}) =>
  ({ cancelled: await cancelSearchesExcept(keepGeneration == null ? -1 : keepGeneration) }))

// slskd's search responses are trusted downstream — the renderer scores by
// hasFreeUploadSlot and queueLength, the scheduler ranks by them, the wishlist
// hunter thresholds on file format. But which field slskd populates has drifted
// between versions (freeUploadSlots vs hasFreeUploadSlot), so scoring "worked by
// chance" wherever the wrong name was read. Normalize the shape ONCE, main-side,
// so everything downstream can trust it. Existing field names the renderer
// already reads are left exactly as they are; this only adds and canonicalizes.
function normalizeSearchResponse(resp) {
  if (!resp || typeof resp !== 'object') return resp
  const out = { ...resp }
  // hasFreeUploadSlot: prefer the boolean slskd sends now, fall back to the old
  // numeric freeUploadSlots (> 0), so scoring is right whichever slskd set.
  out.hasFreeUploadSlot = !!(resp.hasFreeUploadSlot || Number(resp.freeUploadSlots) > 0)
  out.queueLength = Number(resp.queueLength) || 0
  out.uploadSpeed = Number(resp.uploadSpeed) || 0
  out.files = (resp.files || []).map(f => {
    const nf = { ...f }
    // Surface the audio quality fields slskd provides but that never made it to
    // the UI. Only set when present, so a file without them is not stamped with
    // zeros that would read as "0 kbps" / "0-bit".
    if (f.bitRate != null) nf.bitRate = Number(f.bitRate)
    if (f.bitDepth != null) nf.bitDepth = Number(f.bitDepth)
    if (f.sampleRate != null) nf.sampleRate = Number(f.sampleRate)
    return nf
  })
  return out
}

function normalizeSearchResponses(responses) {
  return (responses || []).map(normalizeSearchResponse)
}

// A thin wrapper over slskRunSearch (defined just below). The core is factored
// out so the wishlist hunter can run exactly the same search path — caching,
// throttle handling, live-search registration, partial-result pushes and
// cleanup — rather than a second, subtly-different copy.
ipcMain.handle('slsk-search', (_, args) => slskServeSearch(args || {}))

// The handler entry point: serve persisted results instantly when we have them,
// then revalidate live in the background (App #53, mirroring slsk-browse-user).
// Falls through to a synchronous live search when nothing is remembered — a
// first-ever search still returns a real answer. The in-memory hit inside
// slskRunSearch still short-circuits an immediate repeat; this adds the layer
// that survives a restart.
function slskServeSearch(args = {}) {
  const query = args.query
  const key = (query || '').toLowerCase().trim()
  if (key && !args.noCache) {
    // The in-memory cache is checked first inside slskRunSearch anyway; here we
    // only reach for the on-disk copy, which is what a fresh launch has.
    const persisted = _searchPersistGet(query)
    if (persisted && persisted.length) {
      // Kick the live revalidation whose progressive slsk-progress events repaint
      // the served list, exactly as a normal live search would.
      _searchRevalidate({ ...args })
      return Promise.resolve({ results: persisted, fromCache: true })
    }
  }
  return slskRunSearch(args)
}

async function slskRunSearch({ query, timeoutMs = 25000, noCache = false, generation = 0 } = {}) {
  // Reconnect if needed
  if (!slskdReady) {
    try {
      const r = await fetch(`${SLSKD_BASE}/application`)
      if (r.ok || r.status === 401) { slskdReady = true; await slskdAcquireToken() }
    } catch (_) {}
    if (!slskdReady) throw new Error('Soulseek not connected')
  }

  // Return cached results instantly if available
  const cacheKey = query.toLowerCase().trim()
  if (!noCache) {
    const cached = _searchCacheGet(cacheKey)
    if (cached) return { results: cached, cached: true }
  }

  const capMs = Math.min(timeoutMs, 30000)

  const search = await slskdFetch('POST', '/searches', {
    searchText: query,
    filterResponses: false,
    minimumResponseFileCount: 1,
    minimumPeerUploadSpeed: 0,
    fileLimit: 10000,
    responseLimit: 5000,
    searchTimeout: capMs,
  })
  const id = search?.id
  if (!id) throw new Error('Search failed to start')
  _liveSearches.set(id, { generation, query })
  // The cleanup lives in a finally because any slskdFetch below can throw — a
  // 429, a 500, a socket error — and it used to sit after the loop, so a thrown
  // search leaked its id and left _cancelledSearches growing for the life of the
  // process.
  try {
  const start = Date.now()
  let lastPushTime = 0
  let lastCount    = 0

  let cancelled = false
  while (true) {
    await new Promise(r => setTimeout(r, 800))
    // A newer search has superseded this one. Stop polling a search that has
    // already been deleted at the daemon, rather than 404ing on the next GET.
    if (_cancelledSearches.has(id)) { cancelled = true; break }
    const elapsed = Date.now() - start
    if (elapsed > capMs + 4000) break

    const st = await slskdFetch('GET', `/searches/${id}`)

    // Push partial results every 2.5 s so the renderer can show them immediately
    if (elapsed - lastPushTime >= 2500) {
      const partial = await slskdFetch('GET', `/searches/${id}/responses`)
      const count = (partial || []).length
      lastPushTime = elapsed
      if (count !== lastCount) {
        lastCount = count
        safeSend('slsk-progress', { query, results: normalizeSearchResponses(partial), done: false })
      }
    }

    if (st?.state?.includes('Completed')) break
    // Early-exit thresholds: enough results before full timeout
    if (elapsed >= 7000  && lastCount >= 60) break
    if (elapsed >= 12000 && lastCount >= 20) break
    if (elapsed >= 18000 && lastCount >=  5) break
  }

  if (cancelled) {
    // Superseded: the caller is not waiting for this any more, the search is
    // already deleted, and pushing its results would repaint over the new one.
    return { results: [], cancelled: true }
  }

  const responses = await slskdFetch('GET', `/searches/${id}/responses`)
  try { await slskdFetch('DELETE', `/searches/${id}`) } catch (e) { console.error('[papa] slsk-search-cleanup:', e.message || e) }

  // Normalized once here so the cache, the renderer and the wishlist hunter all
  // see the guaranteed shape (see normalizeSearchResponse).
  const results = normalizeSearchResponses(responses)
  if (results.length) {
    _searchCacheSet(cacheKey, results)
    // Persist across restarts too (App #53), so the next launch can serve this
    // search instantly while revalidating.
    _searchPersistSet(query, results)
  }
  safeSend('slsk-progress', { query, results, done: true })
  return { results }
  } finally {
    _liveSearches.delete(id)
    _cancelledSearches.delete(id)
  }
}

ipcMain.handle('slsk-download', async (_, { username, filename, size }) => {
  try {
    const res = await slskdFetch('POST', `/transfers/downloads/${encodeURIComponent(username)}`,
      [{ filename, size }])
    return { ok: true }
  } catch (e) {
    console.error('[slsk-download] FAILED:', e.message)
    throw e
  }
})

// ── Multi-source download scheduler ─────────────────────────────────────────
// Files are held here and metered out to peers a few at a time, rather than
// dumped wholesale into one peer's remote queue. Every tick reconciles our
// intent against what slskd actually reports, so a peer that stalls or dies
// costs one file's delay instead of the whole album.
const dlSched = require('./src/download-scheduler')
// The quality gate for alternate-source substitution. Nothing gets substituted
// unless its fingerprint is `compatible` with the original — surround layout
// first. See src/source-fingerprint.js for the contract and the field-failure
// history it exists to prevent.
const dlFingerprint = require('./src/source-fingerprint')

// Post-download verification (#49) and auto-organize (#50): folder grouping,
// verdict shapes and target-path building live in this pure module; main does
// the ffprobe and the fs move.
const dlOrganize = require('./src/download-organize')

const DL_TICK_MS = 4000
let dlState = dlSched.createState()
let dlTimer = null
let dlTicking = false

// Album-group ledger for verification/organize (#49/#50). Keyed
// `username::folderPath`. Populated on enqueue (the ONLY point we know the
// intended track count), consulted after each tick's successes to detect when a
// whole folder has finished. Groups that have been verified are marked so the
// pass runs exactly once per folder, after completion — not on a timer, which is
// the mistake the earlier _verifySurroundWhenDone made.
let dlGroups = new Map()
// The set of filenames the scheduler has recorded as succeeded, kept alongside
// the ledger so completion is a cheap membership test per group.
const dlSucceeded = new Set()
// Group keys whose verification pass has already run, so it never repeats.
const dlVerifiedGroups = new Set()

// Fold a batch of just-enqueued items into the group ledger. Only files with a
// real parent folder form a group; loose files are ignored (nothing to organize
// or count). Merges into existing groups so a second enqueue for the same album
// grows the expected count rather than replacing it.
function dlTrackGroups(items) {
  const fresh = dlOrganize.buildGroups(items)
  for (const [key, g] of fresh) {
    const existing = dlGroups.get(key)
    if (!existing) { dlGroups.set(key, g); continue }
    for (const f of g.files) {
      if (!existing.files.has(f)) { existing.files.add(f); existing.expected++ }
    }
    if (!existing.surroundLabel && g.surroundLabel) existing.surroundLabel = g.surroundLabel
  }
}

function dlConfig() {
  const saved = store.get('slskSchedulerConfig', {})
  const cfg = Object.assign({}, dlSched.DEFAULTS, saved)
  // The tuner's learned cap wins over the default once it has run, unless the
  // user has pinned maxGlobalInflight explicitly in the saved config.
  if (dlState && dlState.learnedGlobalInflight != null && saved.maxGlobalInflight == null) {
    cfg.maxGlobalInflight = dlState.learnedGlobalInflight
  }
  return cfg
}

// Finding "the same file" on another peer by basename alone is wrong: an
// 08. Change.flac from a 5.1 rip and one from a stereo rip are indistinguishable
// that way, so an album ends up half surround and half stereo. That is exactly
// the field failure that kept this off. It is on now because substitution is
// gated by src/source-fingerprint.js `compatible()`: a candidate is only
// accepted when its surround label matches EXACTLY (5.1 never accepts stereo),
// it matches on lossless, and its bit depth / sample rate are equal-or-better.
// The gate is unit-tested (test/source-fingerprint.test.js) including the exact
// 5.1-vs-stereo case, so discovery defaults on. The off-switch remains: set
// slskSchedulerConfig.discoverAlternates to false to disable it entirely.
function dlDiscoveryEnabled() {
  return store.get('slskSchedulerConfig', {}).discoverAlternates !== false
}

// The queue now lives on our side, so it must survive a quit — previously
// every request sat safely in slskd and a restart lost nothing.
function dlPersist() {
  try {
    sideStores.slskSchedulerState.set({
      pending: dlState.pending.map(e => ({
        key: e.key, filename: e.filename, size: e.size, sources: e.sources,
        tried: e.tried, triedAt: e.triedAt, attempts: e.attempts, addedAt: e.addedAt,
      })),
      // In-flight entries go back to pending: on restart slskd is the authority
      // on what is really queued, and a duplicate request is harmless.
      inflight: Object.keys(dlState.inflight).map(k => {
        const v = dlState.inflight[k]
        return { key: k, filename: v.filename, size: v.size, sources: v.sources,
                 tried: v.tried, triedAt: v.triedAt, attempts: v.attempts, addedAt: v.addedAt }
      }),
      peerFailures: dlState.peerFailures,
      // Cancelled/abandoned keys MUST survive a restart. Without this, quitting
      // the app resurrects everything the user cancelled.
      abandoned: Object.keys(dlState.done)   // capped below, and pruned on the tick
        .filter(k => dlState.done[k] === 'abandoned')
        .slice(-5000),
      // The identity-level abandonment set: a cancelled track's album+title, so
      // it cannot come back from a DIFFERENT user via discovery after a restart.
      // This is the persistence half of field failure (b)'s fix. Capped the same.
      abandonedIds: Object.keys(dlState.abandonedIds || {}).slice(-5000),
      // The tuner's learned global-inflight cap, so it does not relearn from
      // scratch every launch.
      learnedGlobalInflight: dlState.learnedGlobalInflight != null ? dlState.learnedGlobalInflight : null,
      savedAt: Date.now(),
    })
  } catch (_) {}
}

function dlRestore() {
  const saved = sideStores.slskSchedulerState.get()
  if (!saved) return 0
  const abandoned = new Set(saved.abandoned || [])
  const items = (saved.pending || []).concat(saved.inflight || [])
  for (const e of items) {
    if (!e || !e.filename) continue
    if (abandoned.has(e.key || dlSched.itemKey(e.filename))) continue
    const entry = dlSched.addItem(dlState, {
      filename: e.filename, size: e.size, sources: e.sources || [], addedAt: e.addedAt,
    })
    // addItem reports a refusal as {refused, key}, which is truthy but is not an
    // entry — writing the attempt history onto that would silently lose it.
    if (entry && !entry.refused) {
      entry.tried = e.tried || []
      entry.triedAt = e.triedAt || {}
      entry.attempts = e.attempts || 0
    }
  }
  for (const k of saved.abandoned || []) dlState.done[k] = 'abandoned'
  // Restore the identity-level abandonment set. Without this a cancelled track
  // could return from a different user's copy after a restart.
  dlState.abandonedIds = {}
  for (const id of saved.abandonedIds || []) dlState.abandonedIds[id] = true
  if (saved.learnedGlobalInflight != null) dlState.learnedGlobalInflight = saved.learnedGlobalInflight
  dlState.peerFailures = saved.peerFailures || {}
  return items.length
}

function dlBroadcast() {
  safeSend('slsk-scheduler-stats', dlSched.stats(dlState))
}

// slskd reports state as e.g. "Completed, Succeeded" / "Queued, Remotely".
// One classifier, shared with the renderer (src/dl-state.js). This one only
// checked whether the state STARTS WITH "Completed", so a bare 'Failed' or
// 'Aborted' looked like a running transfer: the scheduler never recorded the
// failure and the file was not re-sourced until the 20-minute stall timer.
// 'succeeded' is kept as this side's word for it.
function dlClassify(stateStr) {
  const kind = dlState_.classify(stateStr)
  return kind === 'completed' ? 'succeeded' : kind
}

// Every file in the last snapshot, flat. The Map above keys by filename and so
// keeps one entry per name; purging needs all of them, with their ids.
let _dlLastSnapshotFiles = []

async function dlSnapshot() {
  const out = new Map()
  const flat = []
  let data
  try { data = await slskdFetch('GET', '/transfers/downloads') } catch (_) { return null }
  for (const user of data || []) {
    for (const dir of user.directories || []) {
      for (const f of dir.files || []) {
        const rec = {
          username: user.username,
          id: f.id,
          state: f.state,
          kind: dlClassify(f.state),
          filename: String(f.filename),
          endedAt: f.endedAt || null,
          // Carried for the adaptive tuner's aggregate-throughput measure.
          averageSpeed: Number(f.averageSpeed) || 0,
        }
        out.set(rec.filename, rec)
        flat.push(rec)
      }
    }
  }
  _dlLastSnapshotFiles = flat
  return out
}

// Measured on the reported install: 1,490 records across 108 users, 1,451 of
// them already Completed/Succeeded, and GET /transfers/downloads returning
// 1,020,307 bytes. The renderer fetched that every 6 s and structured-cloned it
// across the IPC bridge in both directions, then flattened and hashed all 1,490
// files — with nothing downloading. purgeStaleSearches clears searches and the
// scheduler purges failures and cancellations; nothing ever purged successes.
const DL_PURGE_EVERY_MS = 10 * 60 * 1000
// A cap per pass, because firing 1,451 DELETEs at once is exactly what earns a
// 429 — and being rate-limited used to get the daemon restarted.
const DL_PURGE_MAX_PER_PASS = 60
// Succeeded transfers younger than this are left alone, so a completion the user
// can still see in the UI does not vanish out from under them.
const DL_PURGE_MIN_AGE_MS = 60 * 60 * 1000
let _dlLastPurgeAt = 0

async function dlPurgeSucceeded(now) {
  if (now - _dlLastPurgeAt < DL_PURGE_EVERY_MS) return 0
  _dlLastPurgeAt = now
  const candidates = _dlLastSnapshotFiles.filter(f => {
    if (f.kind !== 'succeeded') return false
    // Never purge something the scheduler has not reconciled yet: dlTick treats
    // a transfer that has disappeared from slskd as ABANDONED, so purging one
    // early would be indistinguishable from the user cancelling it.
    const key = dlSched.itemKey(f.filename)
    if (dlState.inflight[key]) return false
    // Where slskd tells us when it finished, respect the age floor. Where it
    // does not, the transfer is reconciled and done, so it is safe to remove.
    if (f.endedAt) {
      const ended = Date.parse(f.endedAt)
      if (Number.isFinite(ended) && now - ended < DL_PURGE_MIN_AGE_MS) return false
    }
    return true
  }).slice(0, DL_PURGE_MAX_PER_PASS)

  if (!candidates.length) return 0
  let purged = 0
  for (const f of candidates) {
    try {
      await slskdFetch('DELETE',
        `/transfers/downloads/${encodeURIComponent(f.username)}/${encodeURIComponent(f.id)}?remove=true`)
      purged++
    } catch (e) {
      // Throttling means stop for this pass and come back later, not keep going.
      if (e && e.code === 'SLSKD_THROTTLED') break
      console.error('[papa] could not purge a completed transfer:', String(e && e.message || e))
    }
  }
  if (purged) {
    const left = _dlLastSnapshotFiles.length - purged
    console.log(`[papa] purged ${purged} completed transfer(s) from slskd; ~${left} records left in the poll payload`)
  }
  return purged
}

// Ask the network who else has this file, so a dead source is not a dead end.
async function dlFindAlternates(filename) {
  const base = String(filename).split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
  const term = base.replace(/[_\-]+/g, ' ').trim()
  if (term.length < 4) return []
  let id
  try {
    const search = await slskdFetch('POST', '/searches', { searchText: term, fileLimit: 200 })
    id = search?.id
    if (!id) return []
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const st = await slskdFetch('GET', `/searches/${id}`)
      if (st?.state?.includes('Completed')) break
    }
    const responses = await slskdFetch('GET', `/searches/${id}/responses`) || []
    const wanted = String(filename).split(/[\\/]/).pop().toLowerCase()
    const out = []
    for (const r of responses) {
      for (const f of r.files || []) {
        const nm = String(f.filename).split(/[\\/]/).pop().toLowerCase()
        if (nm !== wanted) continue
        out.push({
          username: r.username,
          filename: f.filename,
          size: f.size,
          // Carried so the fingerprint gate can compare lossless / bit depth /
          // sample rate, not just the name. Without these an alternate is judged
          // on surround-from-text and extension alone.
          bitDepth: f.bitDepth,
          sampleRate: f.sampleRate,
          hasFreeUploadSlot: !!r.hasFreeUploadSlot,
          queueLength: r.queueLength || 0,
          uploadSpeed: r.uploadSpeed || 0,
        })
        break
      }
    }
    return out
  } catch (_) {
    return []
  } finally {
    if (id) { try { await slskdFetch('DELETE', `/searches/${id}`) } catch (_) {} }
  }
}

// One discovery search per album folder per 10 minutes. The disaster this
// guards is throughput (storming slskd into a 429), not correctness — the
// correctness gate is the fingerprint below. Keyed by the normalized album
// folder so every file in an album shares one search budget.
const DL_DISCOVERY_COOLDOWN_MS = 10 * 60 * 1000
const _dlDiscoveryLastSearch = new Map()   // albumFolder -> timestamp

function _dlAlbumFolderTerm(filename) {
  const folder = dlFolderOf(filename)
  if (!folder) return ''
  return folder.replace(/[_\-\[\]()]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// Search the network for the whole album folder, returning every file that
// matches one of the wanted basenames, each with its metadata for fingerprinting.
async function dlSearchAlbum(term, wantedBasenames) {
  if (term.length < 4) return []
  let id
  try {
    const search = await slskdFetch('POST', '/searches', { searchText: term, fileLimit: 400 })
    id = search?.id
    if (!id) return []
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const st = await slskdFetch('GET', `/searches/${id}`)
      if (st?.state?.includes('Completed')) break
    }
    const responses = await slskdFetch('GET', `/searches/${id}/responses`) || []
    const want = new Set(wantedBasenames)
    const out = []
    for (const r of responses) {
      for (const f of r.files || []) {
        const nm = dlBaseName(f.filename).toLowerCase()
        if (!want.has(nm)) continue
        out.push({
          username: r.username,
          filename: f.filename,
          size: f.size,
          bitDepth: f.bitDepth,
          sampleRate: f.sampleRate,
          hasFreeUploadSlot: !!r.hasFreeUploadSlot,
          queueLength: r.queueLength || 0,
          uploadSpeed: r.uploadSpeed || 0,
        })
      }
    }
    return out
  } catch (_) {
    return []
  } finally {
    if (id) { try { await slskdFetch('DELETE', `/searches/${id}`) } catch (_) {} }
  }
}

// The fingerprint gate around discovery. For one starved/stalled item:
//   - respect the per-album 10-minute rate limit,
//   - search the album folder once,
//   - and add ONLY those candidates whose fingerprint is `compatible` with the
//     ORIGINAL requested file's fingerprint — surround label exact, lossless
//     match, bit depth / sample rate equal-or-better.
// Every accept/reject is logged to the scheduler state (subLog) so the UI can
// show why an alternate was or was not taken. This is the code that makes it
// safe to substitute at all: it is the direct answer to the 5.1-replaced-with-
// stereo field failure.
async function dlDiscoverForItem(item, now) {
  if (!item || !item.filename) return
  const albumFolder = dlFolderOf(item.filename).toLowerCase()
  const last = _dlDiscoveryLastSearch.get(albumFolder) || 0
  if (albumFolder && now - last < DL_DISCOVERY_COOLDOWN_MS) return
  const term = _dlAlbumFolderTerm(item.filename)
  if (!term) return
  if (albumFolder) _dlDiscoveryLastSearch.set(albumFolder, now)
  // Keep the map from growing forever across a long session.
  if (_dlDiscoveryLastSearch.size > 500) {
    for (const [k, t] of _dlDiscoveryLastSearch) {
      if (now - t > DL_DISCOVERY_COOLDOWN_MS) _dlDiscoveryLastSearch.delete(k)
    }
  }

  const wanted = dlBaseName(item.filename).toLowerCase()
  const candidates = await dlSearchAlbum(term, [wanted])
  if (!candidates.length) return

  // The fingerprint of what the user actually asked for. Built from the item's
  // own path text (surround label) plus whatever quality metadata the current
  // source carries.
  const orig = (item.sources && item.sources[0]) || {}
  const originalFp = dlFingerprint.fingerprint({
    filename: item.filename,
    bitDepth: orig.bitDepth,
    sampleRate: orig.sampleRate,
  })
  const key = item.key || dlSched.itemKey(item.filename)
  const accepted = []
  for (const c of candidates) {
    const candFp = dlFingerprint.fingerprint(c)
    if (dlFingerprint.compatible(originalFp, candFp)) {
      accepted.push(c)
      dlSched.logSubstitution(dlState, {
        at: now, key, from: item.filename, to: c.filename, candidate: c.username,
        accepted: true,
        reason: `compatible (surround ${originalFp.surroundLabel || 'stereo'}, ` +
          `${originalFp.lossless ? 'lossless' : 'lossy'})`,
      })
    } else {
      dlSched.logSubstitution(dlState, {
        at: now, key, from: item.filename, to: c.filename, candidate: c.username,
        accepted: false,
        reason: `rejected: original ${originalFp.surroundLabel || 'stereo'}/` +
          `${originalFp.lossless ? 'lossless' : 'lossy'} vs candidate ` +
          `${candFp.surroundLabel || 'stereo'}/${candFp.lossless ? 'lossless' : 'lossy'}`,
      })
    }
  }
  if (accepted.length) dlSched.addSources(dlState, key, accepted)
}

// slskd addresses transfers by its own id, which we do not keep; look it up.
async function dlTransferId(username, filename) {
  try {
    const data = await slskdFetch('GET', '/transfers/downloads')
    for (const u of data || []) {
      if (u.username !== username) continue
      for (const dir of u.directories || []) {
        for (const f of dir.files || []) {
          if (String(f.filename) === String(filename)) return f.id
        }
      }
    }
  } catch (_) {}
  return ''
}

// dlTicking prevents re-entry, but a tick that hangs on a slow fetch blocked
// every later tick indefinitely — the scheduler simply stopped, silently.
const DL_TICK_DEADLINE_MS = 60000
let _dlTickStartedAt = 0

async function dlTick() {
  if (dlTicking) {
    const stuckFor = Date.now() - _dlTickStartedAt
    if (stuckFor > DL_TICK_DEADLINE_MS) {
      // Release the guard: the previous tick is not coming back, and every tick
      // it blocks is a download that is not being dispatched or reconciled. It
      // may still be in flight, which is why this only ever logs and re-arms —
      // the work itself is idempotent per tick.
      console.error(`[papa] the download scheduler tick has been running for ${Math.round(stuckFor / 1000)}s; ` +
        `releasing the overlap guard so the scheduler resumes`)
      dlTicking = false
    } else {
      return
    }
  }
  dlTicking = true
  _dlTickStartedAt = Date.now()
  try {
    const cfg = dlConfig()
    const now = Date.now()
    const snap = await dlSnapshot()
    // slskd unreachable — do nothing rather than double-request on recovery.
    if (!snap) return

    // Reconcile: anything we dispatched that slskd has finished with.
    for (const key of Object.keys(dlState.inflight)) {
      const live = dlState.inflight[key]
      // Look it up under the path we SENT. An alternate source names the same
      // music differently, and looking up the original key missed every time.
      const seen = snap.get(live.sentFilename || live.filename)
      if (!seen) {
        // A transfer only disappears from slskd because it was removed —
        // by the user cancelling, or by us. Re-requesting it is how "cancel"
        // turned into "download it again", so this is terminal, not a retry.
        if (now - live.since > 30000) dlSched.recordAbandoned(dlState, key)
        continue
      }
      // Transitions, at info, into the same daily log. When a download stalls
      // there was no record at all of what slskd had been reporting.
      if (live._lastState !== seen.state) {
        console.log(`[papa][dl] ${dlBaseName(live.filename)}: ${live._lastState || '(new)'} -> ${seen.state} (${seen.username})`)
        live._lastState = seen.state
      }
      if (seen.kind === 'succeeded') {
        dlSched.recordSuccess(dlState, key, seen.username)
        // Track completion for verification/organize (#49/#50): the remote path
        // we sent is the group's file identity.
        dlSucceeded.add(live.sentFilename || live.filename)
        dlSucceeded.add(live.filename)
      }
      else if (seen.kind === 'failed') { dlSched.recordFailure(dlState, key, seen.username, cfg, now); _dlTickFailures++ }
      else if (seen.kind === 'cancelled') dlSched.recordAbandoned(dlState, key)
    }

    // After reconciling, check whether any tracked album group has just fully
    // completed and, if so, run the verification pass once (#49) and, when it
    // passes and the setting is on, auto-organize (#50).
    await dlCheckCompletedGroups()

    const plan = dlSched.planDispatch(dlState, cfg, now)
    for (const item of plan) {
      try {
        await slskdFetch('POST', `/transfers/downloads/${encodeURIComponent(item.username)}`,
          [{ filename: item.filename, size: item.size || 0 }])
        dlSched.markDispatched(dlState, item.key, item.username, Date.now(), item.filename)
      } catch (e) {
        // Rejected at request time counts against that peer, same as a failure.
        dlSched.markDispatched(dlState, item.key, item.username, Date.now(), item.filename)
        dlSched.recordFailure(dlState, item.key, item.username, cfg, Date.now())
      }
    }

    // A peer sitting on us for hours never errors, so failure logic never sees
    // it. Move those files — but only where a better source already exists.
    const stalled = dlSched.stalledItems(dlState, cfg, now)
    for (const st of stalled) {
      const live = dlState.inflight[st.key]
      if (!live) continue
      // The cancel and the re-queue used to be independent: the DELETE was
      // wrapped in an empty catch and recordStall ran regardless. A failed
      // DELETE therefore left slskd still holding the transfer AND the scheduler
      // treating the file as pending — so the same file could be dispatched to a
      // second peer while the first was still sending it.
      let cancelled = false
      try {
        await slskdFetch('DELETE',
          `/transfers/downloads/${encodeURIComponent(st.from)}/${encodeURIComponent(await dlTransferId(st.from, live.sentFilename || live.filename))}?remove=true`)
        cancelled = true
      } catch (e) {
        console.error(`[papa] could not cancel the stalled transfer of ${live.filename} from ${st.from}; ` +
          `leaving it in flight rather than queuing a second copy:`, String(e && e.message || e))
      }
      // Only hand it back to the scheduler once slskd has actually let go of it.
      // If not, it stays in flight and the next tick tries again.
      if (cancelled) dlSched.recordStall(dlState, st.key, st.from, cfg, now)
    }

    // Files with no usable source, and files wedged in a single peer's queue,
    // both need the same thing: somewhere else to get them from. Discovery is
    // gated by the quality fingerprint (see dlDiscoverForItem) and rate-limited
    // to one search per album per 10 minutes.
    const hunt = dlSched.starvedItems(dlState, cfg, now)
      .concat(dlSched.stalledWithoutAlternate(dlState, cfg, now)
        .map(h => dlState.inflight[h.key])
        .filter(Boolean))
      .slice(0, 2)
    for (const item of dlDiscoveryEnabled() ? hunt : []) {
      // Sequential on purpose: one discovery search at a time, so slskd is never
      // stormed and the rate limit is honoured per album.
      await dlDiscoverForItem(item, now)
    }

    // The persisted `abandoned` subset was capped at 5000; the in-memory map had
    // no cap and no TTL, so it grew for the life of the process. Terminal entries
    // are the whole content of it, so pruning here is pruning all of it.
    pruneDlDone()

    // After reconciliation, never before: see the comment on dlPurgeSucceeded.
    try { await dlPurgeSucceeded(now) } catch (e) {
      console.error('[papa] transfer purge failed:', String(e && e.message || e))
    }

    // Nudge the global in-flight cap from measured behaviour. The trouble count
    // is this tick's stalls plus failures; the throughput trend is this tick's
    // aggregate speed against the last. Deliberately gentle — see the tuner.
    const trouble = stalled.length + _dlTickFailures
    dlAdaptiveTune(now, trouble)
    _dlTickFailures = 0

    dlPersist()
    dlBroadcast()
  } finally {
    dlTicking = false
  }
}

// ── Post-download verification (#49) + auto-organize (#50) ───────────────────

// Walk the group ledger; for any group that is now fully complete and not yet
// verified, run the verification pass exactly once. Sequential so ffprobe is not
// stormed. Runs AFTER completion (called from dlTick after reconcile), never on
// a timer.
async function dlCheckCompletedGroups() {
  for (const [key, group] of dlGroups) {
    if (dlVerifiedGroups.has(key)) continue
    if (!dlOrganize.isGroupComplete(group, dlSucceeded)) continue
    dlVerifiedGroups.add(key)
    try { await dlVerifyGroup(group) } catch (e) {
      console.error('[papa] post-download verify failed for', key, String(e && e.message || e))
    }
  }
}

// Verify one completed album group: resolve every enqueued file on disk, ffprobe
// each for corruption + channel count, check the track count against the
// enqueued count, and — if the folder was surround-labelled — check the real
// channel count. Persists the verdict keyed username::folder, emits
// 'slsk-verify-done', and, when the verdict is clean and auto-organize is on,
// moves the files into a normalised folder (#50).
async function dlVerifyGroup(group) {
  const downloadDir = _downloadDir()
  const probes = []
  const resolvedPaths = []
  for (const filename of group.files) {
    const resolved = slskCandidatePaths(filename, group.username, downloadDir)
      .find(c => fs.existsSync(c)) || null
    if (!resolved) {
      probes.push({ filename, filePath: null, ok: false, channels: 0 })
      continue
    }
    resolvedPaths.push(resolved)
    const probe = await verifyAudioFile(resolved)   // ffprobe: duration => readable
    let channels = 0
    if (probe.ok && group.surroundLabel) channels = await probeChannels(resolved)
    probes.push({ filename, filePath: resolved, ok: probe.ok !== false, channels })
  }

  const verdict = dlOrganize.verdict(probes, group.expected, group.surroundLabel)
  const record = {
    ok: verdict.ok,
    problems: verdict.problems,
    username: group.username,
    folder: group.folder,
    dir: resolvedPaths.length ? path.dirname(resolvedPaths[0]) : null,
    at: Date.now(),
  }
  try {
    sideStores.slskVerify.update(prev => {
      const next = prev && typeof prev === 'object' ? { ...prev } : {}
      next[group.key] = record
      return next
    })
  } catch (_) {}
  safeSend('slsk-verify-done', { key: group.key, ...record })

  // Auto-organize (#50): OPT-IN, and NEVER when verification failed. Only a
  // clean verdict with the setting on triggers a move.
  if (verdict.ok && _videoConfig().autoOrganizeDownloads && resolvedPaths.length) {
    try { await dlOrganizeGroup(group, resolvedPaths, downloadDir) } catch (e) {
      console.error('[papa] auto-organize failed for', group.key, String(e && e.message || e))
    }
  }
}

// Move a verified group's files into Downloads/Artist - Album/ (#50). Parses the
// artist/album from the remote folder name via the shelves parser (required),
// builds a collision-safe target, and moves each file — skipping any move whose
// target already exists, never deleting anything, and logging every move.
async function dlOrganizeGroup(group, filePaths, downloadDir) {
  const shelves = require('./src/slsk-shelves')
  const segs = String(group.folderPath || group.folder || '')
    .replace(/\\/g, '/').split('/').filter(Boolean)
  const parsed = shelves.parseAlbumFolder(segs.length ? segs : [group.folder || ''])
  const targetName = dlOrganize.targetFolderName(parsed, group.folder)
  if (!targetName) return
  const { targetDir, moves } = dlOrganize.planMoves({
    files: filePaths, downloadRoot: downloadDir, targetName,
  })
  if (!targetDir || !moves.length) return
  // Never move into the very folder the files already live in.
  if (moves.every(m => path.dirname(m.from) === targetDir)) return
  try { fs.mkdirSync(targetDir, { recursive: true }) } catch (_) { return }

  const logged = []
  for (const m of moves) {
    // Collision-safe: a target that already exists is skipped, never overwritten.
    if (fs.existsSync(m.to)) { logged.push({ from: m.from, to: m.to, moved: false, reason: 'exists' }); continue }
    try {
      fs.renameSync(m.from, m.to)
      logged.push({ from: m.from, to: m.to, moved: true })
    } catch (e) {
      // A cross-device rename (EXDEF) falls back to copy+unlink; but we NEVER
      // delete on failure, so on any error the source is left in place.
      if (e && e.code === 'EXDEV') {
        try {
          fs.copyFileSync(m.from, m.to)
          fs.unlinkSync(m.from)
          logged.push({ from: m.from, to: m.to, moved: true, crossDevice: true })
        } catch (e2) {
          try { if (fs.existsSync(m.to)) fs.unlinkSync(m.to) } catch (_) {}
          logged.push({ from: m.from, to: m.to, moved: false, reason: String(e2 && e2.message || e2) })
        }
      } else {
        logged.push({ from: m.from, to: m.to, moved: false, reason: String(e && e.message || e) })
      }
    }
  }
  const moved = logged.filter(l => l.moved).length
  if (moved) {
    try {
      sideStores.slskOrganizeLog.update(prev => {
        const list = Array.isArray(prev) ? prev.slice() : []
        list.push({ key: group.key, targetDir, at: Date.now(), moves: logged })
        return list.slice(-500)   // cap the log so it cannot grow without bound
      })
    } catch (_) {}
    // The watcher picks up the moves and rescans; a nudge makes it prompt.
    _scheduleLibraryRescan()
  }
}

// W2-UI contract: slskVerifyStatus({username, folder}) — the persisted verdict
// for one completed album group, or null if none exists yet.
ipcMain.handle('slsk-verify-status', (_, { username, folder } = {}) => {
  try {
    const verdicts = sideStores.slskVerify.get() || {}
    // The folder half of the key is the full folder PATH; a caller passing just a
    // leaf folder name still matches on the folder field.
    const direct = verdicts[dlOrganize.groupKey(username, (folder || '') + '/x')]
    if (direct) return direct
    for (const rec of Object.values(verdicts)) {
      if (rec && rec.username === username && rec.folder === folder) return rec
    }
    return null
  } catch (_) { return null }
})

// Aggregate throughput sampled once per tick, so the tuner can tell a rising
// trend from a falling one. Only the previous sample is kept.
let _dlLastThroughput = 0
// Failures observed in the current tick (reset each tick), fed to the tuner as
// part of the trouble signal alongside stalls.
let _dlTickFailures = 0

function _dlAggregateThroughput() {
  let sum = 0
  for (const f of _dlLastSnapshotFiles) {
    if (f.kind === 'succeeded' || f.kind === 'failed' || f.kind === 'cancelled') continue
    sum += Number(f.averageSpeed) || 0
  }
  return sum
}

// Adjust maxGlobalInflight one step, persist the learned value, and — because
// the tuner owns it once it has run — feed it back into the config the next tick
// reads. Pure decision lives in the scheduler (nextGlobalInflight); this is only
// the measurement and the plumbing.
function dlAdaptiveTune(now, troubleCount) {
  const cfg = dlConfig()
  const currentCap = dlState.learnedGlobalInflight != null
    ? dlState.learnedGlobalInflight
    : cfg.maxGlobalInflight
  const throughput = _dlAggregateThroughput()
  const inflight = Object.keys(dlState.inflight).length
  const next = dlSched.nextGlobalInflight(currentCap, {
    currentInflight: inflight,
    throughputRising: throughput > _dlLastThroughput,
    troubleCount: troubleCount || 0,
  })
  _dlLastThroughput = throughput
  if (next !== dlState.learnedGlobalInflight) {
    dlState.learnedGlobalInflight = next
    console.log(`[papa][dl] adaptive cap: maxGlobalInflight -> ${next} ` +
      `(inflight ${inflight}, throughput ${Math.round(throughput / 1024)} KB/s, trouble ${troubleCount || 0})`)
  }
}

// Generous: this is a set of keys, not payloads, and a re-download of something
// long abandoned is cheap. The point is that it is bounded at all.
const DL_DONE_CAP = 5000
function pruneDlDone() {
  const keys = Object.keys(dlState.done)
  if (keys.length <= DL_DONE_CAP) return
  // Object key order is insertion order for string keys, so the oldest go first.
  const drop = keys.length - DL_DONE_CAP
  for (let i = 0; i < drop; i++) delete dlState.done[keys[i]]
  console.log(`[papa] pruned ${drop} terminal download entries (kept ${DL_DONE_CAP})`)
}

let dlRestored = false
function dlStart() {
  if (!dlRestored) { dlRestored = true; dlRestore() }
  if (dlTimer) return
  dlTimer = setInterval(() => { dlTick() }, DL_TICK_MS)
  if (dlTimer.unref) dlTimer.unref()
}

// Downloading a folder out of one user's library gives the scheduler exactly
// one source per file, so it can never spread or recover — it is stuck with
// whoever you happened to be browsing. One search per folder buys it real
// choices, cheaply: match by basename across everyone who answers.
function dlBaseName(p) { return String(p).split(/[\\/]/).pop() }
function dlFolderOf(p) {
  const parts = String(p).split(/[\\/]/)
  return parts.length > 1 ? parts[parts.length - 2] : ''
}

async function dlSeedFolderSources(items) {
  const folders = new Map()
  for (const it of items) {
    const f = dlFolderOf(it.filename)
    if (!f) continue
    if (!folders.has(f)) folders.set(f, [])
    folders.get(f).push(it)
  }
  // Cheap by construction: slskd rate-limits searches, so never storm it.
  for (const [folder, group] of Array.from(folders).slice(0, 2)) {
    const term = folder.replace(/[_\-\[\]()]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (term.length < 4) continue
    let id
    try {
      const search = await slskdFetch('POST', '/searches', { searchText: term, fileLimit: 400 })
      id = search?.id
      if (!id) continue
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const st = await slskdFetch('GET', `/searches/${id}`)
        if (st?.state?.includes('Completed')) break
      }
      const responses = await slskdFetch('GET', `/searches/${id}/responses`) || []
      const want = new Map()
      // Precompute each wanted file's fingerprint once, from its own path text
      // and whatever quality its chosen source carries.
      for (const it of group) {
        const src0 = (it.sources && it.sources[0]) || {}
        want.set(dlBaseName(it.filename).toLowerCase(), {
          it,
          fp: dlFingerprint.fingerprint({
            filename: it.filename, bitDepth: src0.bitDepth, sampleRate: src0.sampleRate,
          }),
        })
      }
      let added = 0
      for (const r of responses) {
        for (const f of r.files || []) {
          const hit = want.get(dlBaseName(f.filename).toLowerCase())
          if (!hit) continue
          // Same gate as discovery: only add a source whose quality fingerprint
          // is compatible with the file the user actually chose. This closes the
          // seed-folder path against the 5.1-replaced-by-stereo failure, which
          // basename matching alone would walk straight into.
          const candFp = dlFingerprint.fingerprint({
            filename: f.filename, bitDepth: f.bitDepth, sampleRate: f.sampleRate,
          })
          if (!dlFingerprint.compatible(hit.fp, candFp)) {
            dlSched.logSubstitution(dlState, {
              at: Date.now(), key: dlSched.itemKey(hit.it.filename),
              from: hit.it.filename, to: f.filename, candidate: r.username,
              accepted: false,
              reason: `seed rejected: original ${hit.fp.surroundLabel || 'stereo'}/` +
                `${hit.fp.lossless ? 'lossless' : 'lossy'} vs candidate ` +
                `${candFp.surroundLabel || 'stereo'}/${candFp.lossless ? 'lossless' : 'lossy'}`,
            })
            continue
          }
          const n = dlSched.addSources(dlState, dlSched.itemKey(hit.it.filename), [{
            username: r.username, filename: f.filename, size: f.size,
            bitDepth: f.bitDepth, sampleRate: f.sampleRate,
            hasFreeUploadSlot: !!r.hasFreeUploadSlot,
            queueLength: r.queueLength || 0,
            uploadSpeed: r.uploadSpeed || 0,
          }])
          if (n) {
            dlSched.logSubstitution(dlState, {
              at: Date.now(), key: dlSched.itemKey(hit.it.filename),
              from: hit.it.filename, to: f.filename, candidate: r.username,
              accepted: true,
              reason: `seed compatible (surround ${hit.fp.surroundLabel || 'stereo'}, ` +
                `${hit.fp.lossless ? 'lossless' : 'lossy'})`,
            })
          }
          added += n
        }
      }
      if (added) { dlPersist(); dlBroadcast() }
    } catch (_) {
      // A failed hunt just means fewer choices, never a lost file.
    } finally {
      if (id) { try { await slskdFetch('DELETE', `/searches/${id}`) } catch (_) {} }
    }
  }
}

ipcMain.handle('slsk-enqueue-downloads', async (_, { items, force }) => {
  let added = 0
  const refused = []
  // Record the album-group membership for verification/organize (#49/#50). The
  // group username is the primary source's username (the one the folder came
  // from); a file's own filename gives the folder path.
  dlTrackGroups((items || [])
    .filter(it => it && it.filename)
    .map(it => ({
      username: it.username || (it.sources && it.sources[0] && it.sources[0].username) || '',
      filename: it.filename,
    })))
  for (const it of items || []) {
    if (!it || !it.filename) continue
    const sources = (it.sources && it.sources.length)
      ? it.sources
      : (it.username ? [{ username: it.username, filename: it.filename, size: it.size }] : [])
    if (!sources.length) continue
    const r = dlSched.addItem(dlState, { filename: it.filename, size: it.size || 0, sources },
      { force: !!force })
    // A refusal used to be a silent null the caller discarded, so asking again
    // for something you had cancelled looked like a button that did nothing.
    if (r && r.refused) refused.push({ filename: it.filename, reason: r.refused })
    else if (r) added++
  }
  dlStart()
  dlTick()
  // Runs behind the response: the files are already queued, this only widens
  // the set of peers they can come from.
  if (dlDiscoveryEnabled()) {
    const single = (items || []).filter(it => it && it.filename && !(it.sources && it.sources.length > 1))
    if (single.length) dlSeedFolderSources(single).catch(() => {})
  }
  return { ok: true, added, refused, stats: dlSched.stats(dlState) }
})

function dlQueueFiles() {
  const cfg = dlConfig()
  const now = Date.now()
  const byPeer = dlSched.inflightByPeer(dlState)
  const out = []
  for (const e of dlState.pending) {
    const ranked = dlSched.rankSources(e.sources)
    const next = ranked.find(src =>
      !dlSched.peerBenched(dlState, src.username, now) &&
      (byPeer[src.username] || 0) < cfg.maxPerPeer)
    out.push({
      id: 'sched:' + e.key,
      filename: e.filename,
      size: e.size || 0,
      // Reuses the "Queued" family so existing category logic counts it as
      // active; the extra token gives it its own label in the list.
      state: 'Queued, Scheduled',
      username: (next && next.username) || (e.sources[0] && e.sources[0].username) || 'searching…',
      scheduled: true,
      sourceCount: (e.sources || []).length,
      attempts: e.attempts || 0,
      percentComplete: 0,
      averageSpeed: 0,
    })
  }
  return out
}

ipcMain.handle('slsk-scheduler-queue', () => {
  dlStart()
  return { files: dlQueueFiles(), stats: dlSched.stats(dlState) }
})

ipcMain.handle('slsk-scheduler-stats', () => {
  dlStart()
  return dlSched.stats(dlState)
})

ipcMain.handle('slsk-scheduler-config', (_, patch) => {
  if (patch && typeof patch === 'object') {
    store.set('slskSchedulerConfig', Object.assign({}, store.get('slskSchedulerConfig', {}), patch))
  }
  return dlConfig()
})

// Pull deep per-peer queues back into the local scheduler so they can be
// re-pointed at peers that are actually moving.
ipcMain.handle('slsk-respread-backlog', async (_, opts) => {
  const perPeerKeep = (opts && opts.perPeerKeep != null) ? opts.perPeerKeep : dlConfig().maxPerPeer
  let data
  try { data = await slskdFetch('GET', '/transfers/downloads') } catch (e) { return { ok: false, error: e.message } }

  const queued = []
  const purge = []
  for (const user of data || []) {
    const mine = []
    for (const dir of user.directories || []) {
      for (const f of dir.files || []) {
        const kind = dlClassify(f.state)
        if (kind === 'failed' || kind === 'cancelled') { purge.push({ username: user.username, id: f.id }); continue }
        if (String(f.state).indexOf('Queued') === 0) mine.push(f)
      }
    }
    // Leave the head of each peer's queue in place — those keep their position.
    mine.slice(perPeerKeep).forEach(f => queued.push({ username: user.username, id: f.id, filename: f.filename, size: f.size }))
  }

  for (const p of purge) {
    try { await slskdFetch('DELETE', `/transfers/downloads/${encodeURIComponent(p.username)}/${encodeURIComponent(p.id)}?remove=true`) } catch (_) {}
  }
  for (const q of queued) {
    try { await slskdFetch('DELETE', `/transfers/downloads/${encodeURIComponent(q.username)}/${encodeURIComponent(q.id)}?remove=true`) } catch (_) {}
    // force: this path has just deleted the transfer at the daemon and means to
    // re-source it. Without it a file that had been cancelled once could never
    // be respread.
    dlSched.addItem(dlState, {
      filename: q.filename, size: q.size,
      sources: [{ username: q.username, filename: q.filename, size: q.size }],
    }, { force: true })
  }
  dlStart()
  dlTick()
  return { ok: true, purged: purge.length, respread: queued.length, stats: dlSched.stats(dlState) }
})

// Clear the scheduler's peer benches. A peer benched after five failures sits
// out a ten-minute cooldown and nothing in the UI could shorten it, so a peer
// that had a bad ten minutes stayed dead to us long after it recovered. This is
// the escape hatch: forget the failure history and let those peers back in on
// the next tick. Returns how many were actually on the bench.
ipcMain.handle('slsk-unbench-peers', () => {
  const now = Date.now()
  let cleared = 0
  for (const u of Object.keys(dlState.peerFailures)) {
    if (dlSched.peerBenched(dlState, u, now)) cleared++
  }
  // Wipe the whole failure map, not just the benched subset: a peer at four
  // failures is one away from the bench for no reason we can still see, so a
  // manual unbench is also a clean slate.
  dlState.peerFailures = {}
  dlPersist()
  dlStart()
  dlTick()
  dlBroadcast()
  return { ok: true, cleared }
})

// ── Wishlist auto-download engine ────────────────────────────────────────────
// The wishlist (store key downloadWishlist, [{query, addedAt}]) used to be a
// list you looked at. A sweep now runs every entry as one search, scores the
// results exactly the way the grid does (src/wishlist-hunter.js), and enqueues a
// clear album on its own — dropping the entry and recording the hit so the same
// query is never chased twice.
const wishlistHunter = require('./src/wishlist-hunter')

// 90s after start, not immediately: slskd needs to connect and log in first, and
// a sweep against a daemon that has not is wasted. Then every six hours.
const WISHLIST_FIRST_SWEEP_MS = 90 * 1000
const WISHLIST_SWEEP_EVERY_MS = 6 * 60 * 60 * 1000
// Between entries, so a wishlist of any size does not storm slskd into a 429.
const WISHLIST_ENTRY_GAP_MS = 5000
// On a 429 mid-sweep we abort and come back much later, rather than pushing into
// a daemon that has just asked us to stop.
const WISHLIST_THROTTLE_BACKOFF_MS = 30 * 60 * 1000
// The hit history, capped, and the dedupe source: a query in here is never
// hunted again. Kept small — it is a list of normalized queries plus a little
// context, not payloads.
const WISHLIST_HITS_CAP = 50

let slskWishlistTimer = null
let slskWishlistSweeping = false

function wishlistHits() { return store.get('wishlistHits', []) }

function recordWishlistHit(hit) {
  const hits = wishlistHits()
  // Newest first, deduped by normalized query, capped.
  const norm = hit.normalized || wishlistHunter.normalizeQuery(hit.query)
  const next = [{
    query: hit.query,
    normalized: norm,
    folderName: hit.folderName,
    username: hit.username,
    fileCount: hit.fileCount,
    at: hit.at || Date.now(),
  }].concat(hits.filter(h => (h.normalized || wishlistHunter.normalizeQuery(h.query)) !== norm))
  store.set('wishlistHits', next.slice(0, WISHLIST_HITS_CAP))
}

function wishlistAlreadyHunted(normQuery) {
  return wishlistHits().some(h => (h.normalized || wishlistHunter.normalizeQuery(h.query)) === normQuery)
}

// One sweep. Guarded against overlap — a slow sweep must never have a second
// started on top of it — and returns the per-entry outcome for the UI's manual
// "Search now" button. Enqueued entries are removed from the wishlist store as
// they land, so a crash mid-sweep loses no progress.
async function slskWishlistSweep() {
  if (slskWishlistSweeping) return { ok: false, error: 'A wishlist sweep is already running', results: [] }
  slskWishlistSweeping = true
  try {
    const entries = store.get('downloadWishlist', [])
    if (!entries.length) return { ok: true, results: [] }
    console.log('[papa] wishlist: sweeping', entries.length, 'item(s)')

    const sweep = await wishlistHunter.runSweep({
      entries,
      // noCache: the 5-min search cache must never serve the hunter a stale
      // result. An entry that was empty an hour ago may be downloadable now, and
      // a cached empty would keep it invisible until the cache expired on its own
      // schedule, not the sweep's.
      search: async (query) => {
        const r = await slskRunSearch({ query, timeoutMs: 20000, noCache: true, generation: BACKGROUND_GENERATION })
        return (r && r.results) || []
      },
      enqueue: async (items) => {
        for (const it of items) {
          dlSched.addItem(dlState, { filename: it.filename, size: it.size || 0, sources: it.sources })
        }
        dlStart()
        dlTick()
      },
      alreadyHunted: wishlistAlreadyHunted,
      onHit: (hit) => {
        recordWishlistHit(hit)
        // Drop the satisfied entry from the wishlist as it lands.
        const remaining = store.get('downloadWishlist', [])
          .filter(w => wishlistHunter.normalizeQuery(w.query) !== hit.normalized)
        store.set('downloadWishlist', remaining)
        safeSend('slsk-wishlist-hit', {
          query: hit.query, folderName: hit.folderName,
          username: hit.username, fileCount: hit.fileCount,
        })
        console.log('[papa] wishlist: enqueued', hit.fileCount, 'file(s) for', JSON.stringify(hit.query),
          'from', hit.username)
      },
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      gapMs: WISHLIST_ENTRY_GAP_MS,
      now: Date.now,
    })

    if (sweep.aborted && sweep.abortReason === 'throttled') {
      // slskd rate-limited us mid-sweep: back off well beyond the normal cadence
      // and try again then, rather than on the next six-hour tick.
      console.log('[papa] wishlist: slskd throttled the sweep; retrying in',
        Math.round(WISHLIST_THROTTLE_BACKOFF_MS / 60000), 'min')
      setTimeout(() => { slskWishlistSweep().catch(() => {}) }, WISHLIST_THROTTLE_BACKOFF_MS)
    }

    return { ok: true, results: sweep.results }
  } catch (e) {
    console.error('[papa] wishlist sweep failed:', String((e && e.message) || e))
    return { ok: false, error: String((e && e.message) || e), results: [] }
  } finally {
    slskWishlistSweeping = false
  }
}

// Manually trigger one sweep now, for the UI's "Search now" button.
ipcMain.handle('slsk-wishlist-run', () => slskWishlistSweep())

// ── Friend diffs ─────────────────────────────────────────────────────────────
// "New since last visit": each saved user carries fileCount from the last browse
// and prevFileCount from the one before. The diff is what appeared between them.
ipcMain.handle('slsk-friend-diffs', () => {
  const list = savedUsers.sortUsers(store.get('slskSavedUsers', []))
  return list.map(u => {
    const key = String(u.username).toLowerCase()
    const pres = presenceCache.get(key)
    const fileCount = (u.fileCount == null) ? null : Number(u.fileCount)
    const prevFileCount = (u.prevFileCount == null) ? null : Number(u.prevFileCount)
    // newFiles only when both counts are known and the library grew. A shrink
    // (files removed, or a partial browse) is not "new", so it reports null
    // rather than a negative.
    let newFiles = null
    if (fileCount != null && prevFileCount != null && fileCount - prevFileCount > 0) {
      newFiles = fileCount - prevFileCount
    }
    return {
      username: u.username,
      fileCount,
      prevFileCount,
      newFiles,
      lastBrowsedAt: u.lastBrowsedAt || null,
      presence: pres ? pres.presence : 'Unknown',
    }
  })
})

// Only the fields the renderer actually reads. slskd's transfer records carry a
// great deal more, and the whole list was structured-cloned across the bridge in
// both directions — the measured worst case was 1,020,307 bytes every 6 s. The
// purge (item 232) shrinks how many records there are; this shrinks each one.
const TRANSFER_FIELDS = [
  'id', 'filename', 'state', 'size', 'bytesTransferred', 'bytesRemaining',
  'percentComplete', 'averageSpeed', 'remainingTime', 'startedAt', 'endedAt',
  'requestedAt', 'enqueuedAt', 'direction', 'exception',
]

function slimTransfer(f) {
  const out = {}
  for (const k of TRANSFER_FIELDS) if (f[k] !== undefined) out[k] = f[k]
  return out
}

// A rough size for a payload about to cross the bridge. Only used to warn: the
// point is that a payload growing back to a megabyte becomes visible rather than
// being rediscovered by measuring it a year later.
const IPC_PAYLOAD_WARN_BYTES = 256 * 1024
function warnIfLarge(channel, payload) {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(payload))
    if (bytes > IPC_PAYLOAD_WARN_BYTES) {
      console.warn(`[papa][ipc] ${channel} returned ${Math.round(bytes / 1024)} KB ` +
        `across the bridge (warning above ${Math.round(IPC_PAYLOAD_WARN_BYTES / 1024)} KB)`)
    }
    return bytes
  } catch (_) { return 0 }
}

ipcMain.handle('slsk-get-transfers', async () => {
  // Was `catch (_) { return [] }`. The renderer detects an unreachable daemon by
  // this promise REJECTING, so swallowing made that impossible: a dead slskd
  // rendered as "No active downloads", the tab badges zeroed, the list blanked,
  // and the "Can't reach the Soulseek daemon" empty state was unreachable dead
  // code. It also fired a bogus "all downloads complete" notification, because
  // the active count dropped to zero.
  const data = await slskdFetch('GET', '/transfers/downloads')
  // Same shape as slskd's — users, each with directories, each with files — but
  // with every field the renderer never looks at removed.
  const slim = (data || []).map(user => ({
    username: user.username,
    directories: (user.directories || []).map(dir => ({
      directory: dir.directory,
      files: (dir.files || []).map(slimTransfer),
    })),
  }))
  warnIfLarge('slsk-get-transfers', slim)
  return slim
})

ipcMain.handle('slsk-cancel-transfer', async (_, { username, id, alreadyDone }) => {
  // Scheduler-held files are not known to slskd. Routing here means every
  // existing Cancel button works on them without knowing they are different.
  if (typeof id === 'string' && id.indexOf('sched:') === 0) {
    const key = id.slice(6)
    // A user cancel is ABANDONMENT, not exhaustion: it must register at the
    // identity level so the track cannot come back from another user via
    // discovery. Marking it 'exhausted' (the old behaviour) left discovery free
    // to re-add it — one of the two field failures this pass fixes.
    dlSched.recordAbandoned(dlState, key)
    dlPersist()
    dlBroadcast()
    return { ok: true }
  }
  // Cancelling must kill our INTENT to fetch the file, not just this transfer.
  // Removing it from slskd alone leaves the scheduler still wanting it, and the
  // next tick happily re-requests it from another peer.
  //
  // A finished transfer has no intent left to cancel, and this lookup costs a
  // FULL /transfers/downloads fetch (~1 MB here). Clearing a large completed
  // list used to pay that once per item.
  if (!alreadyDone) {
    try {
      const filename = await dlFilenameForTransfer(username, id)
      if (filename) dlAbandonByFilename(filename)
    } catch (_) {}
  }
  try {
    // ?remove=true removes completed/failed transfers from the list; harmless for active ones
    await slskdFetch('DELETE', `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}?remove=true`)
  } catch (_) {}
  dlPersist()
  dlBroadcast()
  return { ok: true }
})

async function dlFilenameForTransfer(username, id) {
  try {
    const data = await slskdFetch('GET', '/transfers/downloads')
    for (const u of data || []) {
      if (u.username !== username) continue
      for (const dir of u.directories || []) {
        for (const f of dir.files || []) {
          if (String(f.id) === String(id)) return f.filename
        }
      }
    }
  } catch (_) {}
  return null
}

// One piece of music can be known under several peers' paths, so match on the
// basename too — otherwise cancelling the copy you can see leaves its twin
// running under a different path.
// The remote folder a peer's path sits in. "01 - Intro.flac" is a name dozens of
// releases share; the folder is what makes it one release's track.
function dlRemoteDir(p) {
  const str = String(p == null ? '' : p)
  const cut = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'))
  return cut < 0 ? '' : str.slice(0, cut).toLowerCase()
}

// The twin-cancel behaviour is deliberate: a peer names the same music
// differently, so cancelling has to reach the entry under whichever path was
// actually sent. But an unscoped basename match reached OTHER releases entirely —
// cancel a generic track name and it abandoned transfers from unrelated albums.
function dlAbandonByFilename(filename) {
  const target = String(filename)
  const base = dlBaseName(target).toLowerCase()
  const dir = dlRemoteDir(target)
  const hit = (name) => {
    if (!name) return false
    if (String(name) === target) return true
    // Same basename is only the same file when it is in the same remote folder.
    return dlBaseName(name).toLowerCase() === base && dlRemoteDir(name) === dir
  }
  for (const key of Object.keys(dlState.inflight)) {
    const live = dlState.inflight[key]
    if (hit(key) || hit(live.filename) || hit(live.sentFilename)) dlSched.recordAbandoned(dlState, key)
  }
  for (const e of dlState.pending.slice()) {
    if (hit(e.key) || hit(e.filename)) dlSched.recordAbandoned(dlState, e.key)
  }
}

// Peer-supplied paths must never be written into the music library root. On a
// fresh install cfg.downloadDir is empty, and falling back to folders[0] meant
// whatever a stranger named their folders became directories inside the library.
// A dedicated subfolder is the difference between a download area and the
// library itself; it is created rather than assumed to exist.
const DOWNLOAD_SUBDIR = 'Papa Audio Downloads'
let _warnedAboutDownloadDir = false

function _downloadDir() {
  const cfg = store.get('slskConfig', {})
  if (cfg.downloadDir) return cfg.downloadDir
  const folders = store.get('musicFolders', [])
  const base = folders[0] || path.join(app.getPath('home'), 'Music')
  const dir = path.join(base, DOWNLOAD_SUBDIR)
  if (!_warnedAboutDownloadDir) {
    _warnedAboutDownloadDir = true
    console.warn(`[papa] no download folder is configured; using ${dir}. ` +
      `Set one in Settings — peer-supplied folder names should not land in the library root.`)
  }
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {
    console.error('[papa] could not create the fallback download folder:', String(e && e.message || e))
    return base
  }
  return dir
}

ipcMain.handle('slsk-get-download-dir', () => _downloadDir())

ipcMain.handle('slsk-set-download-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose Download Folder',
  })
  if (result.canceled || !result.filePaths.length) return { ok: false }
  const downloadDir = result.filePaths[0]
  const cfg = store.get('slskConfig', {})
  store.set('slskConfig', { ...cfg, downloadDir })
  writeSlskdConfig({ ...cfg, downloadDir })
  // slskd reads its download folder once, at startup. Writing the config and
  // stopping there meant the newly picked folder did nothing until the next
  // launch, while the UI reported the change as applied.
  if (slskdProc || slskdReady) {
    stopSlskd()
    try { await startSlskd() } catch (e) {
      console.error('[papa] slskd restart after folder change:', String(e && e.message || e))
      return { ok: true, downloadDir, restarted: false }
    }
    return { ok: true, downloadDir, restarted: true }
  }
  return { ok: true, downloadDir, restarted: false }
})

ipcMain.handle('slsk-show-in-folder', (_, filePath) => {
  // Every path-taking handler goes through the guard rather than each growing
  // its own. Reachable only from our own renderer today, but "only from our own
  // renderer" is a claim about the whole renderer, and that renderer embeds a
  // web browser.
  if (!pathIsOurs(filePath)) {
    console.error('[papa] refused to reveal a path outside the app folders:', filePath)
    return { ok: false, error: 'Outside your music and download folders — refused' }
  }
  shell.showItemInFolder(filePath)
  return { ok: true }
})

ipcMain.handle('open-external', (_, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url)
  return { ok: true }
})

// ── YouTube ──────────────────────────────────────────────────────────────────
ipcMain.handle('yt-music-search', async (_, { query }) => {
  try { return { ok: true, results: await withRetry(() => withTimeout(ytSearch.searchMusic(query), 20000, 'YouTube music search'), 2, 'yt-music-search') } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-search', async (_, { query }) => {
  try { return { ok: true, results: await withRetry(() => withTimeout(ytSearch.searchAll(query), 20000, 'YouTube search'), 2, 'yt-search') } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-music-search-full', async (_, { query }) => {
  try { return { ok: true, results: await withRetry(() => withTimeout(ytSearch.searchMusicFull(query), 20000, 'YouTube full search'), 2, 'yt-music-search-full') } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-album', async (_, { browseId }) => {
  try { return { ok: true, album: await withRetry(() => withTimeout(ytSearch.getAlbum(browseId), 20000, 'YouTube album'), 2, 'yt-album') } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-artist', async (_, { channelId }) => {
  try { return { ok: true, artist: await withRetry(() => withTimeout(ytSearch.getArtist(channelId), 20000, 'YouTube artist'), 2, 'yt-artist') } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-search-page', async (_, { kind, query, next }) => {
  try {
    const { items, hasMore } = await withRetry(() => withTimeout(ytSearch.searchPage(kind, query, !!next), 20000, 'YouTube search page'), 2, 'yt-search-page')
    return { ok: true, items, hasMore }
  } catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-playlist', async (_, { playlistId }) => {
  try { return { ok: true, playlist: await withRetry(() => withTimeout(ytSearch.getPlaylist(playlistId), 20000, 'YouTube playlist'), 2, 'yt-playlist') } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-home', async () => {
  try { return { ok: true, ...(await withRetry(() => withTimeout(ytSearch.getHomeFeed(), 20000, 'YouTube home feed'), 2, 'yt-home')) } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-radio', async (_, { videoId }) => {
  try { return { ok: true, tracks: await withRetry(() => withTimeout(ytSearch.getRadio(videoId), 20000, 'YouTube radio'), 2, 'yt-radio') } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-find-video', async (_, { artist, title }) => {
  try { return { ok: true, videoId: await withRetry(() => ytSearch.findVideoId(artist, title), 2, 'yt-find-video') } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('get-lyrics', async (_, params) => {
  try { return { ok: true, ...(await lyrics.fetchLyrics(params || {})) } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('save-lyrics', (_, params) => {
  try { return lyrics.saveLyrics(params || {}) }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

// ── YouTube account (cookie auth via a real Google sign-in window) ──────────
// OAuth device-flow tokens are rejected (HTTP 400) by every YT Music endpoint,
// so we sign in through an actual browser window and hand Innertube the cookies.
async function _collectYtCookieHeader(sess) {
  const cookies = await sess.cookies.get({ url: 'https://www.youtube.com' })
  if (!cookies.some(c => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID')) return null
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

// Silent cookie refresh — no-op unless signed in. A hidden window loads
// music.youtube.com on the auth partition so Google rotates/extends the
// session cookies, then the fresh header replaces the stored one.
async function validateYtCookie() {
  var cookie = store.get('ytCookie', null)
  if (!cookie) return false
  try {
    var res = await fetch('https://music.youtube.com/', {
      headers: { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    var loc = res.headers.get('location') || ''
    if (loc.includes('accounts.google.com')) {
      console.error('[papa] yt-cookie-stale')
      return false
    }
    return res.ok || res.status === 302
  } catch (_) {
    return false
  }
}

let _ytRefreshWin = null
// Returns whether a fresh cookie was actually collected. It used to return
// nothing and swallow every failure, which is why YouTube features could stop
// working with no indication of why — the refresh is the thing that keeps them
// alive, and nobody could tell whether it had run, let alone succeeded.
function refreshYtCookie() {
  if (!store.get('ytCookie', null)) return Promise.resolve(null)   // nothing to refresh
  if (_ytRefreshWin) return Promise.resolve(null)                  // already running
  const { session } = require('electron')
  const sess = session.fromPartition('persist:yt-auth')
  _ytRefreshWin = new BrowserWindow({
    show: false,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  })
  const win = _ytRefreshWin
  return new Promise((resolve) => {
    let settled = false
    const finish = (result, why) => {
      if (settled) return
      settled = true
      if (_ytRefreshWin === win) _ytRefreshWin = null
      if (!win.isDestroyed()) win.destroy()
      if (result === false) console.error('[papa][yt] cookie refresh did not produce a cookie:', why)
      resolve(result)
    }
    const timer = setTimeout(() => finish(false, 'timed out after 30s'), 30000)
    win.webContents.setUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      clearTimeout(timer)
      finish(false, `load failed (${code} ${desc})`)
    })
    win.webContents.on('did-finish-load', async () => {
      let ok = false
      let why = ''
      try {
        await new Promise(r => setTimeout(r, 3000)) // let redirects settle
        const header = await _collectYtCookieHeader(sess)
        if (header) {
          store.set('ytCookie', header)
          ytSearch.setCookie(header)
          ok = true
        } else {
          why = 'no cookie header in the session — the sign-in has probably expired'
        }
      } catch (e) {
        // The previous cookie is kept either way; that part was right.
        why = String(e && e.message || e)
      }
      clearTimeout(timer)
      finish(ok, why)
    })
    win.loadURL('https://music.youtube.com/')
  })
}

let _ytAuthWin = null
ipcMain.handle('yt-auth-start', async () => {
  if (_ytAuthWin) { _ytAuthWin.focus(); return { ok: false, error: 'Sign-in window already open' } }
  return new Promise(resolve => {
    const { session } = require('electron')
    const sess = session.fromPartition('persist:yt-auth')
    _ytAuthWin = new BrowserWindow({
      width: 520, height: 720, parent: mainWindow,
      title: 'Sign in to YouTube',
      autoHideMenuBar: true,
      webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
    })
    // Google refuses logins from obviously-embedded browsers; a plain Firefox
    // UA keeps the flow open.
    _ytAuthWin.webContents.setUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')
    _ytAuthWin.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F')

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      if (_ytAuthWin && !_ytAuthWin.isDestroyed()) _ytAuthWin.close()
      _ytAuthWin = null
      resolve(result)
    }

    // Nothing but the window closing used to stop this, so an abandoned
    // sign-in -- the window left open behind the main one, or a flow that never
    // completes -- polled the session store every 1.5 s for as long as the app
    // ran. A 2FA login with a password manager is slow, so the deadline is
    // generous rather than tight.
    const AUTH_POLL_MS = 1500
    const AUTH_DEADLINE_MS = 10 * 60 * 1000
    const startedAt = Date.now()

    const poll = setInterval(async () => {
      if (Date.now() - startedAt > AUTH_DEADLINE_MS) {
        safeSend('yt-auth-pending', { reason: 'sign-in-timed-out' })
        finish({ ok: false, error: 'Sign-in was not completed within ten minutes' })
        return
      }
      try {
        const header = await _collectYtCookieHeader(sess)
        if (header) {
          store.set('ytCookie', header)
          ytSearch.setCookie(header)
          safeSend('yt-auth-done', { signedIn: true })
          finish({ ok: true, signedIn: true })
        }
      } catch { /* keep polling until the deadline or the window closes */ }
    }, AUTH_POLL_MS)

    _ytAuthWin.on('closed', () => {
      _ytAuthWin = null
      if (!settled) { settled = true; clearInterval(poll); resolve({ ok: false, error: 'Sign-in window closed before login finished' }) }
    })
  })
})

ipcMain.handle('yt-auth-signout', async () => {
  try {
    store.delete('ytCookie')
    ytSearch.setCookie(null)
    const { session } = require('electron')
    await session.fromPartition('persist:yt-auth').clearStorageData().catch(() => {})
    return { ok: true }
  } catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('yt-auth-status', () => {
  try { return { ok: true, signedIn: ytSearch.isSignedIn() } }
  catch (e) { return { ok: false, error: summariseYtError(e) } }
})

ipcMain.handle('validate-yt-cookie', async () => {
  var valid = await validateYtCookie()
  if (!valid) {
    try { await refreshYtCookie() } catch (_) {}
    valid = await validateYtCookie()
  }
  return { ok: true, valid }
})

// Set on every download and never deleted or cleared, so both the map and the
// yt-get-downloads payload grew for the life of the process. Finished entries
// are worth keeping for a while -- the downloads page lists them -- so they
// expire rather than vanishing the moment they complete. Live ones are pinned:
// an in-progress download must not be evicted out from under its own callbacks.
const YT_DL_CAP = 200
const YT_DL_FINISHED_TTL_MS = 6 * 60 * 60 * 1000
const _ytDownloads = new Map()
let _ytQueue = Promise.resolve()

function _pruneYtDownloads() {
  const now = Date.now()
  for (const [id, dl] of _ytDownloads) {
    if (dl.state === 'downloading') continue
    if (!dl.finishedAt || now - dl.finishedAt > YT_DL_FINISHED_TTL_MS) _ytDownloads.delete(id)
  }
  // Insertion-ordered, so this drops the oldest finished entries first.
  if (_ytDownloads.size > YT_DL_CAP) {
    for (const [id, dl] of _ytDownloads) {
      if (_ytDownloads.size <= YT_DL_CAP) break
      if (dl.state !== 'downloading') _ytDownloads.delete(id)
    }
  }
}

function _ytEmit(dl) {
  safeSend('yt-dl-progress', { ...dl })
}

ipcMain.handle('yt-download', (_, { videoId, title, artist, subdir }) => {
  const id = `yt_${videoId}_${Date.now()}`
  const dl = { id, videoId, title, artist, percent: 0, state: 'downloading', error: null, finishedAt: null }
  _ytDownloads.set(id, dl)
  _pruneYtDownloads()
  _ytEmit(dl)
  // yt-dlp creates missing output directories, so an album subfolder is just a path join
  const outDir = subdir
    ? path.join(_downloadDir(), ytDownloader.sanitizeFilename(subdir))
    : _downloadDir()
  // Serialize downloads so "Download Album" doesn't spawn one yt-dlp per track at once
  _ytQueue = _ytQueue.then(() => ytDownloader.downloadAudio({
    videoId, title, artist,
    outDir,
    onProgress: pct => {
      if (pct - dl.percent >= 1 || pct === 100) { dl.percent = pct; _ytEmit(dl) }
    },
  })).then(res => {
    dl.percent = res.ok ? 100 : dl.percent
    dl.state = res.ok ? 'completed' : 'failed'
    dl.error = res.ok ? null : res.error
    dl.finishedAt = Date.now()
    _ytEmit(dl)
  }).catch(e => {
    console.error('[papa] yt-download-error:', e.message || e)
    // Without this the entry stayed 'downloading' forever: pinned against
    // eviction, and reported as in progress by yt-get-downloads.
    dl.state = 'failed'
    dl.error = String(e && e.message || e)
    dl.finishedAt = Date.now()
    _ytEmit(dl)
  })
  return { ok: true, id }
})

ipcMain.handle('yt-get-downloads', () => {
  _pruneYtDownloads()
  return [..._ytDownloads.values()]
})

ipcMain.handle('ctx-menu-show', (event, items, x, y) => {
  return Promise.race([
    new Promise(resolve => {
      const menu = new Menu()
      for (const item of (items || [])) {
        if (item === 'sep' || item?.type === 'separator') {
          menu.append(new MenuItem({ type: 'separator' }))
        } else if (item?.label) {
          menu.append(new MenuItem({ label: item.label, click: () => resolve(item.action) }))
        }
      }
      menu.popup({ window: BrowserWindow.fromWebContents(event.sender), x: x ?? undefined, y: y ?? undefined, callback: () => resolve(null) })
    }),
    new Promise(resolve => setTimeout(() => resolve(null), 10000))
  ])
})

const surroundVerify = require('./src/surround-verify')

// Read the real channel count off a file. Everything before this point is
// working from folder names and file sizes, which can lie; ffprobe cannot.
function probeChannels(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels', '-of', 'default=nw=1:nk=1', filePath],
      { timeout: 15000 }, (err, stdout) => {
        if (err) { resolve(0); return }
        resolve(parseInt(String(stdout).trim(), 10) || 0)
      })
  })
}

// Check a finished download against what it claimed to be.
ipcMain.handle('verify-surround', async (_, { filePath, expectedLabel }) => {
  if (!pathIsOurs(filePath)) return { ok: null, severity: 'unknown', message: 'Outside your music and download folders — refused.' }
  if (!filePath || !fs.existsSync(filePath)) return { ok: null, severity: 'unknown', message: 'File not found.' }
  const channels = await probeChannels(filePath)
  return { ...surroundVerify.verdict(expectedLabel || null, channels), channels }
})

// Audit a whole folder: an album is only surround if every track is, and one
// stereo track hiding in a 5.1 album is the failure most likely to go unnoticed.
ipcMain.handle('verify-surround-folder', async (_, { dir }) => {
  try {
    // Unguarded this was a directory listing of anything on the machine.
    if (!pathIsOurs(dir)) return { ok: null, total: 0, offenders: [], error: 'refused' }
    if (!dir || !fs.existsSync(dir)) return { ok: null, total: 0, offenders: [] }
    const names = fs.readdirSync(dir).filter(n => AUDIO_EXT.test(n)).slice(0, 60)
    const tracks = []
    for (const n of names) {
      tracks.push({ name: n, channels: await probeChannels(path.join(dir, n)) })
    }
    return surroundVerify.auditAlbum(tracks)
  } catch (e) {
    return { ok: null, total: 0, offenders: [], error: String(e.message || e) }
  }
})

// Where a Soulseek file may have landed on disk. slskd does not report the
// local path, so this walks the plausible layouts, most specific first.
//
// The bare-basename candidate is deliberately conditional. A remote file named
// "01.flac" or "Track 03.mp3" would otherwise match ANY such file sitting loose
// in the download root -- and the resolver's answer is handed straight to Play
// and to "Show in folder", so a hit there plays the wrong song and never
// downloads the right one. Generic names are exactly the collision-prone ones,
// so they do not get that last-resort match; distinctive names still do.
function slskGenericBaseName(name) {
  var base = String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim()
  if (base.length <= 3) return true
  return /^(?:cd|disc|disk|track|t)?[\s._-]*\d{1,3}(?:[\s._-]*(?:of|\/)[\s._-]*\d{1,3})?$/i.test(base)
}

function slskCandidatePaths(filename, username, downloadDir) {
  var parts = String(filename || '').replace(/\\/g, '/').split('/').filter(Boolean)
  if (!parts.length) return []
  var tail1 = parts.slice(1)
  var tail2 = parts.slice(2)
  var last2 = parts.slice(-2)
  var last1 = parts.slice(-1)
  var out = [
    tail1.length ? path.join(downloadDir, ...tail1) : null,
    path.join(downloadDir, ...parts),
    tail1.length ? path.join(downloadDir, username, ...tail1) : null,
    path.join(downloadDir, username, ...parts),
    tail2.length ? path.join(downloadDir, ...tail2) : null,
    tail2.length ? path.join(downloadDir, username, ...tail2) : null,
    last2.length === 2 ? path.join(downloadDir, ...last2) : null,
  ]
  if (!slskGenericBaseName(last1[0])) out.push(path.join(downloadDir, ...last1))
  return out.filter(Boolean)
}

ipcMain.handle('slsk-resolve-file', (_, { username, filename }) => {
  const cfg = store.get('slskConfig', {})
  const downloadDir = _downloadDir()
  for (const c of slskCandidatePaths(filename, username, downloadDir)) {
    if (fs.existsSync(c)) return { path: c, downloadDir }
  }
  return { path: null, downloadDir }
})

ipcMain.handle('slsk-verify-file', async (_, { username, filename }) => {
  const resolved = slskCandidatePaths(filename, username, _downloadDir())
    .find(c => fs.existsSync(c)) || null

  if (!resolved) {
    safeSend('slsk-verify', { ok: false, filename, error: 'File not found on disk' })
    return { ok: false, error: 'File not found on disk' }
  }

  const result = await verifyAudioFile(resolved)
  safeSend('slsk-verify', { ...result, filename, filePath: resolved })
  return { ok: true, filePath: resolved, ...result }
})

const savedUsers = require('./src/saved-users')

ipcMain.handle('slsk-saved-users', () => savedUsers.sortUsers(store.get('slskSavedUsers', [])))

ipcMain.handle('slsk-save-user', (_, { username, note, fileCount, dirCount }) => {
  const list = savedUsers.saveUser(store.get('slskSavedUsers', []), username, { note, fileCount, dirCount })
  store.set('slskSavedUsers', list)
  savedUsersChanged(list)
  return savedUsers.sortUsers(list)
})

ipcMain.handle('slsk-unsave-user', (_, { username }) => {
  const list = savedUsers.removeUser(store.get('slskSavedUsers', []), username)
  store.set('slskSavedUsers', list)
  savedUsersChanged(list)
  return savedUsers.sortUsers(list)
})

ipcMain.handle('slsk-touch-user', (_, { username, fileCount, dirCount }) => {
  const list = savedUsers.touchUser(store.get('slskSavedUsers', []), username, { fileCount, dirCount })
  store.set('slskSavedUsers', list)
  savedUsersChanged(list)
  return savedUsers.sortUsers(list)
})

// ── Saved-user presence ──────────────────────────────────────────────────────
// Soulseek has no push channel for peer presence, so the main process polls
// slskd on a fixed interval and pushes only to the renderer. Polling here (not
// in the renderer) keeps the list warm across tab switches and reloads.
const PRESENCE_POLL_MS = 20000
const PRESENCE_CONCURRENCY = 4
const presenceCache = new Map()
let presenceTimer = null
let presencePolling = false

function presenceSnapshot() { return Array.from(presenceCache.values()) }

function presenceBroadcast(changed, serverConnected) {
  try {
    safeSend('slsk-user-status', {
      statuses: presenceSnapshot(), changed, serverConnected,
    })
  } catch (_) {}
}

function savedUsersChanged(list) {
  safeSend('slsk-saved-users-changed', savedUsers.sortUsers(list))
  startPresenceWatch()
  pollPresenceOnce()
}

async function fetchUserPresence(username) {
  try {
    const d = await slskdFetch('GET', `/users/${encodeURIComponent(username)}/status`)
    return { presence: String(d?.presence || 'Offline'), isPrivileged: !!d?.isPrivileged }
  } catch (_) {
    // A failed lookup is unknown, not offline — painting it offline would lie.
    return { presence: 'Unknown', isPrivileged: false }
  }
}

function presenceRecord(username, presence, isPrivileged, changed) {
  const key = String(username).toLowerCase()
  const prev = presenceCache.get(key)
  const next = { username, presence, isPrivileged, checkedAt: Date.now() }
  presenceCache.set(key, next)
  if (!prev || prev.presence !== presence || prev.isPrivileged !== isPrivileged) changed.push(next)
}

async function pollPresenceOnce() {
  if (presencePolling) return presenceSnapshot()
  presencePolling = true
  try {
    const names = savedUsers.sortUsers(store.get('slskSavedUsers', [])).map(u => u.username)
    const live = new Set(names.map(n => String(n).toLowerCase()))
    for (const key of Array.from(presenceCache.keys())) if (!live.has(key)) presenceCache.delete(key)
    if (!names.length) { presenceBroadcast([], null); return presenceSnapshot() }

    let connected = false
    try {
      const srv = await slskdFetch('GET', '/server')
      connected = !!srv?.isLoggedIn
    } catch (_) { connected = false }

    const changed = []
    if (!connected) {
      for (const n of names) presenceRecord(n, 'Unknown', false, changed)
      presenceBroadcast(changed, false)
      return presenceSnapshot()
    }

    const queue = names.slice()
    const worker = async () => {
      while (queue.length) {
        const n = queue.shift()
        const r = await fetchUserPresence(n)
        presenceRecord(n, r.presence, r.isPrivileged, changed)
      }
    }
    const workers = []
    for (let i = 0; i < Math.min(PRESENCE_CONCURRENCY, queue.length); i++) workers.push(worker())
    await Promise.all(workers)
    presenceBroadcast(changed, true)
    return presenceSnapshot()
  } finally {
    presencePolling = false
  }
}

function startPresenceWatch() {
  if (presenceTimer) return
  presenceTimer = setInterval(() => { pollPresenceOnce() }, PRESENCE_POLL_MS)
  if (presenceTimer.unref) presenceTimer.unref()
}

ipcMain.handle('slsk-user-statuses', () => {
  startPresenceWatch()
  if (!presenceCache.size) pollPresenceOnce()
  return { statuses: presenceSnapshot() }
})

ipcMain.handle('slsk-refresh-user-statuses', async () => {
  startPresenceWatch()
  await pollPresenceOnce()
  return { statuses: presenceSnapshot() }
})

// One browse fetch with a deadline. Returns the filtered directory list, or
// throws. `timeoutMs` is a parameter so the no-cache retry can wait longer.
async function _browseFetch(username, timeoutMs) {
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('Browse timed out')), timeoutMs))
  const fetch = slskdFetch('GET', `/users/${encodeURIComponent(username)}/browse`)
  const data = await Promise.race([fetch, timeout])
  return (data?.directories || data || []).filter(d => (d.files || []).length > 0)
}

// A completed browse of a SAVED user updates the diff record: the previous
// fileCount rolls into prevFileCount, the fresh count and browse time land.
// "new since last visit" is read from that pair by slsk-friend-diffs. Only saved
// users are touched — recordBrowse is a no-op for the rest.
function _browseRecordDiff(username, dirs) {
  if (!savedUsers.isSaved(store.get('slskSavedUsers', []), username)) return
  const fileCount = dirs.reduce((n, d) => n + (d.files || []).length, 0)
  const list = savedUsers.recordBrowse(store.get('slskSavedUsers', []), username,
    { fileCount, dirCount: dirs.length })
  store.set('slskSavedUsers', list)
  savedUsersChanged(list)
}

// Users with a background refresh already running, so an open that lands while
// the refresh is in flight does not fire a second one.
const _browseRefreshing = new Set()

// Fetch fresh in the background, cache it, and tell the renderer to re-read.
function _browseRefresh(username) {
  if (_browseRefreshing.has(username)) return
  _browseRefreshing.add(username)
  ;(async () => {
    try {
      const dirs = await _browseFetch(username, 30000)
      _browseCacheWrite(username, dirs)
      _browseRecordDiff(username, dirs)
      // The renderer re-reads via the normal call, which now serves the fresh
      // cache. The UI agent subscribes to this via onSlskBrowseRefreshed.
      safeSend('slsk-browse-refreshed', { username })
    } catch (_) {
      // A failed refresh leaves the cache in place — cache wins silently.
    } finally {
      _browseRefreshing.delete(username)
    }
  })()
}

ipcMain.handle('slsk-browse-user', async (_, { username }) => {
  const cached = _browseCacheRead(username)

  // Cache present: serve it instantly and refresh in the background. The open is
  // immediate; the fresh tree arrives via slsk-browse-refreshed a moment later.
  if (cached) {
    _browseRefresh(username)
    return { ok: true, directories: cached.directories || [], fromCache: true, cachedAt: cached.cachedAt }
  }

  // No cache: fetch synchronously so the first-ever open still returns a tree.
  try {
    const dirs = await _browseFetch(username, 30000)
    _browseCacheWrite(username, dirs)
    _browseRecordDiff(username, dirs)
    return { ok: true, directories: dirs }
  } catch (e) {
    // A timeout on the first open, with nothing cached, gets ONE automatic retry
    // on a longer deadline before erroring — a big library often just needs more
    // time than the first attempt allowed.
    if (/timed out/i.test(String(e && e.message))) {
      try {
        const dirs = await _browseFetch(username, 60000)
        _browseCacheWrite(username, dirs)
        _browseRecordDiff(username, dirs)
        return { ok: true, directories: dirs }
      } catch (e2) {
        return { ok: false, error: e2.message }
      }
    }
    return { ok: false, error: e.message }
  }
})

// The body, as a plain function. batch-transcode used to call
// ipcMain.emit('transcode-file', …), which fires a plain EventEmitter event —
// but ipcMain.handle registers on Electron's private invoke channel, so nothing
// listened. emit() returns a boolean, so the batch reported [false, false, …]
// as its results and ffmpeg never ran once. Both entry points call this now.
function transcodeFile({ filePath, format, outDir }) {
  return new Promise((resolve) => {
    // This one writes. Unguarded it was an arbitrary file write with an
    // arbitrary input, which is the most consequential of the four.
    if (!pathIsOurs(filePath)) { resolve({ ok: false, error: 'Source is outside your music and download folders — refused' }); return }
    if (outDir && !pathIsOurs(outDir)) { resolve({ ok: false, error: 'Destination is outside your music and download folders — refused' }); return }
    var args = ['-i', filePath]
    if (format === 'opus') args.push('-c:a', 'libopus', '-b:a', '160k')
    else if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '320k')
    else if (format === 'aac') args.push('-c:a', 'aac', '-b:a', '256k')
    else { resolve({ ok: false, error: 'Unsupported format: ' + format }); return }
    
    var name = path.basename(filePath).replace(/\.[^.]+$/, '.' + format)
    var out = path.join(outDir || path.dirname(filePath), name)
    args.push(out, '-y')
    
    var proc = spawn('ffmpeg', args)
    var stderr = ''
    proc.stderr.on('data', d => stderr = (stderr + d.toString()).slice(-500))
    proc.on('error', e => resolve({ ok: false, error: e.message }))
    proc.on('close', code => {
      if (code === 0) resolve({ ok: true, output: out })
      else resolve({ ok: false, error: stderr.trim() || 'ffmpeg exited ' + code })
    })
  })
}

ipcMain.handle('transcode-file', (_, args) => transcodeFile(args || {}))

ipcMain.handle('batch-transcode', async (_, { filePaths, format, outDir }) => {
  var results = []
  for (var fp of (filePaths || [])) {
    // Sequential on purpose: ffmpeg is CPU-hungry and this runs alongside
    // playback. One at a time is slower and does not fight mpv for the machine.
    results.push(await transcodeFile({ filePath: fp, format, outDir }))
  }
  return results
})

// ── Papa Video: settings, catalogs, providers, streaming ─────────────────────

function _videoSettings() {
  return Object.assign(
    {
      tmdbApiKey: '',
      // The second opinion: IMDb, Rotten Tomatoes and Metacritic in one
      // request, plus the awards line and the certificate. Optional — every
      // path that reads it works without it.
      omdbApiKey: '',
      // OpenSubtitles.com key for the online subtitle search in the CC menu
      // (§player 21). Optional — no key means the search says "add a key in
      // Settings" instead of failing, and every other path works without it.
      openSubtitlesApiKey: '',
      preferSurround: true,
      preferredQuality: '1080p',
      torrentSources: true,
      // Bandwidth cap for streaming, in megabits per second, or null for no
      // cap (App #41). Applied to the WebTorrent client, which throttles
      // client-wide — one cap governs every stream and background download.
      // Stored in Mbps because that is what the settings slider speaks;
      // converted to bytes/s (×125000) at the streamer boundary.
      downloadLimitMbps: null,
      // Whether the app shares back to the swarm while watching (App #42).
      // Default on: seeding is neighbourly and keeps peers we still need to
      // download from. Off chokes uploads to nothing without dropping the
      // connections.
      seedWhileWatching: true,
      // Where a stream is cached while it plays. Empty means the temporary
      // directory, which on this machine is a tmpfs — the cache would sit in
      // RAM and a season pack can approach the memory limit. A path on a real
      // disk keeps it off memory entirely.
      streamCacheDir: '',
      // User-editable mirror lists per torrent provider (App #34). One key per
      // mirror-capable provider; an empty array means "use the built-in
      // defaults" — so a fresh install and a user who has cleared a field both
      // land on the same shipped mirrors. Only these four providers fall back
      // across a mirror list; the meta-indexers each have a single endpoint.
      sourceMirrors: { yts: [], eztv: [], nyaa: [], apibay: [] },
    },
    store.get('videoSettings')
  )
}

// A hung backend must never hang the app: every catalog/provider fetch goes
// through this so the request aborts on its own. 15 s is well beyond anything
// legitimate these APIs take.
function fetchWithTimeout(ms) {
  return (url, opts) => fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(ms) })
}

// Lazy singletons: built on first use so nothing runs at import time, and the
// TMDB key is read fresh when the catalog is first needed. `reset()` drops the
// memoised instance so the next call reconstructs it — used when a setting the
// factory reads at construction time (a provider's mirror list, App #34)
// changes and the singleton has to be rebuilt to pick it up.
function _lazy(factory) {
  let value
  const get = () => (value ??= factory())
  get.reset = () => { value = undefined }
  return get
}

const tmdb = _lazy(() => createTmdbCatalog({
  apiKey: () => _videoSettings().tmdbApiKey || process.env.TMDB_API_KEY,
  fetchFn: fetchWithTimeout(15000),
}))
const anilist = _lazy(() => createAnilistCatalog({ fetchFn: fetchWithTimeout(15000) }))
// A shelf of twenty cards would be twenty requests to a free service with a
// daily limit, and these values change about as often as a film's release date
// does. A day is generous and still nowhere near the limit.
const _omdbCache = makeCache({ cap: 800, ttlMs: 1000 * 60 * 60 * 24 })
const omdb = _lazy(() => createOmdbCatalog({
  apiKey: () => _videoSettings().omdbApiKey || process.env.OMDB_API_KEY,
  fetchFn: fetchWithTimeout(12000),
  cache: _omdbCache,
}))
// Online subtitle search for the CC menu (§player 21). The key is read fresh
// per call through the getter — same trick omdb uses — so the singleton never
// has to be rebuilt when the user pastes a key into Settings: no key means
// search() returns an empty list carrying `needsKey`, and the UI says so.
const opensubs = _lazy(() => createOpenSubtitles({
  apiKey: () => _videoSettings().openSubtitlesApiKey || process.env.OPENSUBTITLES_API_KEY,
  fetcher: fetchWithTimeout(15000),
}))
// The user-editable mirror list for a provider (App #34), or undefined when the
// setting is empty — which each provider factory reads as "use my defaults". An
// entry is only honoured when it is a non-empty array of strings; a blank field
// in the settings UI stores [] and so falls back to the built-in mirrors.
function _mirrorsFor(name) {
  const all = _videoSettings().sourceMirrors
  const list = all && typeof all === 'object' ? all[name] : null
  if (!Array.isArray(list)) return undefined
  const clean = list.filter(u => typeof u === 'string' && u.trim()).map(u => u.trim())
  return clean.length ? clean : undefined
}
const yts = _lazy(() => createYtsProvider({ fetchFn: fetchWithTimeout(15000), baseUrls: _mirrorsFor('yts') }))
// EZTV covers TV episodes (YTS is movies-only) and Nyaa covers anime. Both are
// keyless and magnet-based, so they ride the same torrent path as YTS.
const eztv = _lazy(() => createEztvProvider({ fetchFn: fetchWithTimeout(15000), baseUrls: _mirrorsFor('eztv') }))
const nyaa = _lazy(() => createNyaaProvider({ fetchFn: fetchWithTimeout(15000), baseUrls: _mirrorsFor('nyaa') }))
const animetosho = _lazy(() => createAnimetoshoProvider({ fetchFn: fetchWithTimeout(15000) }))
// The broad-coverage indexer. YTS only carries its own encodes, so any film it
// never released had no sources at all; apibay covers the whole public index
// for both movies and TV.
const apibay = _lazy(() => createApibayProvider({ fetchFn: fetchWithTimeout(15000), baseUrls: _mirrorsFor('apibay') }))
// The four providers whose mirror list is user-editable (App #34). When
// `sourceMirrors` changes, their memoised singletons are dropped so the next
// use rebuilds them against the new list — the factory reads the mirrors once,
// at construction, so nothing short of a rebuild picks up the change.
const _mirrorProviders = [yts, eztv, nyaa, apibay]
function _rebuildMirrorProviders() {
  for (const p of _mirrorProviders) p.reset()
}
// The two meta-indexers: one query fans out across dozens of upstream
// trackers, which is where most of the source count now comes from.
const knaben = _lazy(() => createKnabenProvider({ fetchFn: fetchWithTimeout(15000) }))
const solidtorrents = _lazy(() => createSolidTorrentsProvider({ fetchFn: fetchWithTimeout(15000) }))
// The HTTP adapters ship with no resolvers. The former vidsrc resolver was
// removed from the wiring because it returned an *embed page* URL: mpv runs
// with --ytdl=no, so every one of those entries failed the moment it was
// clicked, while still occupying the top of the source list. The adapters stay
// so a real direct-stream resolver can be dropped in without touching the
// router, the engine, or the UI.
const movieTv = _lazy(() => createMovieTvProvider({ fetchFn: fetchWithTimeout(15000), resolvers: [] }))
const anime = _lazy(() => createAnimeProvider({ fetchFn: fetchWithTimeout(15000), resolvers: [] }))
const videoEngine = _lazy(() => new VideoEngine())
const yarrlist = _lazy(() => createYarrlistDirectory({ fetchFn: fetchWithTimeout(15000) }))
const _videoSession = { streamer: null, thumbnailer: null, win: null, token: 0, bounds: null }

// In-app embedding of the mpv video surface. mpv's `--wid` is an X11 concept:
// on this XWayland session the native handle of a child BrowserWindow is the
// X11 window id mpv renders into. When a wid cannot be obtained (native-Wayland
// Electron, or the child window fails to open) we fall back to mpv opening its
// own window — playback still works, just not embedded.
function _videoWindow() {
  if (_videoSession.win && !_videoSession.win.isDestroyed()) return _videoSession.win
  _videoSession.win = new BrowserWindow({
    width: 1280, height: 720,
    show: false, frame: false,
    // Transparent, and this is load-bearing rather than cosmetic. With an
    // opaque background Chromium repaints the host window on every resize and
    // that paint lands on top of mpv's output: the picture goes black and
    // never comes back. Resizing the app did it, and so did going fullscreen,
    // which is a resize.
    //
    // Measured with everything else held identical — opaque: 34525 colours
    // before a resize, 1 after; transparent: 34567 before, 54863 after. It is
    // not the renderer: every mpv backend (gpu, gpu-next, x11, xv, EGL and
    // Vulkan alike) broke on an opaque host and none broke on a transparent
    // one.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    parent: mainWindow,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  _videoSession.win.loadURL('about:blank')
  _videoSession.win.on('closed', () => { if (_videoSession.win) _videoSession.win = null })
  return _videoSession.win
}

function _videoWid() {
  try {
    const handle = _videoWindow().getNativeWindowHandle()
    if (!handle || handle.length < 4) return null
    return handle.readUInt32LE(0) || null
  } catch (_) { return null }
}

// The renderer owns the layout, so it measures the stage and tells main where
// the video belongs. Converting from content-relative to screen coordinates is
// main's job because only main knows where the window sits on the desktop.
// The renderer measures in CSS pixels; setBounds takes device-independent
// pixels. Those are only the same number when the page zoom is exactly 1, and
// here it is 0.9128 — so an unconverted rectangle came out about 10% too big
// in every direction. A stage 2472 CSS px wide became 2472 DIP inside a window
// only 2256 DIP wide, and the video covered the entire app: no poster, no
// deck, no way back. Multiplying by the zoom factor is the conversion.
function _cssToDip(rect) {
  if (!rect) return null
  let z = 1
  try {
    if (mainWindow && !mainWindow.isDestroyed()) z = mainWindow.webContents.getZoomFactor() || 1
  } catch (_) { z = 1 }
  if (!Number.isFinite(z) || z <= 0) z = 1
  return {
    x: rect.x * z, y: rect.y * z,
    width: rect.width * z, height: rect.height * z,
  }
}

// Positions the surface from a rectangle already in DIP. Clamped to the
// content area so that however wrong an incoming rectangle is, the video can
// never grow past the app and swallow the controls with it.
function _positionVideoWindow(rect) {
  try {
    if (!rect || !mainWindow || mainWindow.isDestroyed()) return false
    const win = _videoWindow()
    if (!win || win.isDestroyed()) return false
    const content = mainWindow.getContentBounds()
    const x = Math.min(Math.max(0, rect.x), Math.max(0, content.width - 2))
    const y = Math.min(Math.max(0, rect.y), Math.max(0, content.height - 2))
    const width = Math.max(2, Math.min(Math.round(rect.width), content.width - x))
    const height = Math.max(2, Math.min(Math.round(rect.height), content.height - y))
    win.setBounds({
      x: Math.round(content.x + x),
      y: Math.round(content.y + y),
      width, height,
    })
    return true
  } catch (_) {
    return false
  }
}

// Hiding and showing the embedded surface. Minimising the theatre has to take
// the video with it: the surface is a native child window, so it does not
// disappear just because the HTML behind it was hidden — it would sit over the
// app while the user tried to browse. Audio keeps playing either way, which is
// what "browse while it plays" means here.
ipcMain.handle('video-surface-visible', (_, { visible } = {}) => {
  try {
    const win = _videoSession.win
    if (!win || win.isDestroyed()) return { ok: true }
    if (visible) {
      if (_videoSession.bounds) _positionVideoWindow(_videoSession.bounds)
      win.showInactive()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus()
    } else {
      win.hide()
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

ipcMain.handle('video-surface-bounds', (_, rect) => {
  // Converted on arrival, so everything downstream — the move/resize follower,
  // the fullscreen backstop, restoring after a minimise — works in one unit.
  _videoSession.bounds = _cssToDip(rect)
  return { ok: _positionVideoWindow(_videoSession.bounds) }
})

// Fullscreen means the video window alone goes fullscreen; the deck is not
// drawn over it in either state, so there is nothing to hide or re-show.
// Fullscreen expands the APP, not the mpv window. Fullscreening mpv would put
// the video on top of everything — including the deck, the skip offer and the
// Up Next card, all of which live in the main window — leaving the viewer with
// a picture they cannot pause, skip or advance. Expanding the app instead lets
// the stage grow to fill the screen while the controls stay reachable.
ipcMain.handle('video-fullscreen', (_, opts) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }
    const want = opts && typeof opts.value === 'boolean' ? opts.value : !mainWindow.isFullScreen()
    if (want !== mainWindow.isFullScreen()) mainWindow.setFullScreen(want)
    // The renderer re-measures on its own resize event and sends fresh bounds,
    // but a fullscreen transition can settle after that fires, so re-apply the
    // last known rectangle as a backstop.
    if (_videoSession.bounds) setTimeout(() => _positionVideoWindow(_videoSession.bounds), 120)
    return { ok: true, fullscreen: want }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// The mpv window is a child of the main window, so it does not move with it
// automatically — dragging the app to another monitor would leave the video
// behind. Re-applying the stage rectangle on every move and resize keeps them
// glued together.
function _rebindVideoFollow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const follow = () => {
    if (_videoSession.bounds && _videoSession.win && !_videoSession.win.isDestroyed()) {
      _positionVideoWindow(_videoSession.bounds)
    }
  }
  mainWindow.on('move', follow)
  mainWindow.on('resize', follow)
  mainWindow.on('enter-full-screen', () => setTimeout(follow, 120))
  mainWindow.on('leave-full-screen', () => setTimeout(follow, 120))
}

// If the renderer never reported a stage rectangle, derive one from the main
// window rather than letting the video window appear at its creation size,
// floating over the app as a separate window. The numbers mirror the theatre's
// layout: a top bar, and a deck plus action strip at the bottom.
function _fallbackStageBounds() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    const c = mainWindow.getContentBounds()
    const TOP = 62, BOTTOM = 128
    return { x: 0, y: TOP, width: c.width, height: Math.max(80, c.height - TOP - BOTTOM) }
  } catch (_) { return null }
}

function _showVideoWindow() {
  try {
    const win = _videoWindow()
    const rect = _videoSession.bounds || _fallbackStageBounds()
    if (rect) {
      _positionVideoWindow(rect)
      if (!_videoSession.bounds) console.warn('[papa-video] no stage bounds reported; using a derived rectangle')
    }
    win.showInactive()
    // Focus stays with the main window: the deck, the keyboard shortcuts and
    // the skip buttons all live there, and stealing focus into a blank mpv
    // window would make every one of them stop responding.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus()
  } catch (_) {}
}

function _closeVideoWindow() {
  try {
    if (_videoSession.win && !_videoSession.win.isDestroyed()) _videoSession.win.destroy()
  } catch (_) {}
  _videoSession.win = null
}

const _videoCatalogCache = makeCache({ cap: 50, ttlMs: 1000 * 60 * 60 * 24 })
const _videoStreamCache = makeCache({ cap: 200, ttlMs: 1000 * 60 * 15 })
// Season browsing re-asked for the same show detail on every season switch —
// two TMDB calls per click, forever, because nothing cached the detail. Shows
// change rarely; six hours is generous and still picks up new seasons the same
// day. Season payloads are cached separately so switching back to a season
// already viewed costs nothing.
const _videoDetailCache = makeCache({ cap: 120, ttlMs: 1000 * 60 * 60 * 6 })
const _videoSeasonCache = makeCache({ cap: 400, ttlMs: 1000 * 60 * 60 * 6 })
// The merged airing schedule for the shows the viewer follows (App #25/#26).
// Half an hour is short enough that a new episode's countdown stays roughly
// right and long enough that flipping between the home tabs and the calendar
// doesn't re-hit AniList and TMDB on every visit. Keyed by the sorted id sets
// so a changed follow list is a cache miss rather than a stale answer.
const _videoAiringCache = makeCache({ cap: 40, ttlMs: 1000 * 60 * 30 })

// How many anime detail/chain entries the persistent outage cache keeps. Each
// entry is a normalised detail object (a few KB), so 200 is generous and stays
// well under a MB. Detail and chain entries share the map and the cap.
const ANIME_DETAIL_CACHE_CAP = 200
// When over the cap, drop this many of the oldest entries in one pass rather
// than one-per-write, so eviction is amortised and the file isn't rewritten on
// every single insert once it's full.
const ANIME_DETAIL_CACHE_EVICT = 40

// Write a value through to the persistent outage cache under `key`
// (`anime:<id>` for a detail, `chain:<id>` for a season chain), stamped with the
// current time. When the map grows past the cap, the oldest ~40 entries (by
// cachedAt) are evicted in one pass — a simple LRU-ish trim, not a strict LRU,
// which is all an outage fallback needs. Never throws: a cache write failing
// must not take down the detail fetch that produced the value.
function _animeDetailCacheWrite(key, value) {
  try {
    sideStores.animeDetailCache.update(prev => {
      const map = prev && typeof prev === 'object' ? { ...prev } : {}
      map[key] = { ...value, cachedAt: Date.now() }
      const keys = Object.keys(map)
      if (keys.length > ANIME_DETAIL_CACHE_CAP) {
        // Oldest first, then delete the front slice.
        keys.sort((a, b) => (map[a].cachedAt || 0) - (map[b].cachedAt || 0))
        for (const k of keys.slice(0, ANIME_DETAIL_CACHE_EVICT)) delete map[k]
      }
      return map
    })
  } catch (e) {
    try { console.warn('[papa][video] anime detail cache write failed:', e && e.message) } catch (_) {}
  }
}

// Read an entry back out of the persistent outage cache. Returns the stored
// object ({ detail | chain, cachedAt }) or null. Never throws.
function _animeDetailCacheRead(key) {
  try {
    const map = sideStores.animeDetailCache.get()
    const entry = map && map[key]
    return entry || null
  } catch (_) { return null }
}

// The browse cache mirrors the anime-detail cache: a bounded, LRU-ish side store
// that lets an expensive fetch be served instantly from the last good result.
const BROWSE_CACHE_CAP = 20            // users kept before the oldest are evicted
const BROWSE_CACHE_EVICT = 4           // dropped per pass once at the cap

// Write a fresh browse tree through under `browse:<username>`, stamped with the
// time, evicting the oldest users when over the cap. Never throws — a cache
// write failing must not take down the browse it came from.
function _browseCacheWrite(username, directories) {
  try {
    const key = 'browse:' + String(username)
    sideStores.browseCache.update(prev => {
      const map = prev && typeof prev === 'object' ? { ...prev } : {}
      map[key] = { directories, cachedAt: Date.now() }
      const keys = Object.keys(map)
      if (keys.length > BROWSE_CACHE_CAP) {
        keys.sort((a, b) => (map[a].cachedAt || 0) - (map[b].cachedAt || 0))
        for (const k of keys.slice(0, BROWSE_CACHE_EVICT)) delete map[k]
      }
      return map
    })
  } catch (e) {
    try { console.warn('[papa] browse cache write failed:', e && e.message) } catch (_) {}
  }
}

// Read a cached browse tree back. Returns { directories, cachedAt } or null.
function _browseCacheRead(username) {
  try {
    const map = sideStores.browseCache.get()
    const entry = map && map['browse:' + String(username)]
    return entry || null
  } catch (_) { return null }
}

function _currentAnimeSeasonTag() {
  const now = new Date()
  const m = now.getMonth() + 1
  const season = m <= 3 ? 'WINTER' : m <= 6 ? 'SPRING' : m <= 9 ? 'SUMMER' : 'FALL'
  return `${season}-${now.getFullYear()}`
}

function _clearVideoCaches() {
  _videoCatalogCache.clear()
  _videoStreamCache.clear()
  _videoDetailCache.clear()
  _videoSeasonCache.clear()
}

ipcMain.handle('video-settings-get', () => {
  return { ok: true, settings: _videoSettings() }
})

// Only these keys may be written from the renderer. A patch is a merge, so
// without a whitelist any renderer bug or bad payload could plant arbitrary
// keys into the stored settings blob; every setting the UI actually owns is
// listed here and nothing else is copied through.
const VIDEO_SETTING_KEYS = new Set([
  'tmdbApiKey', 'omdbApiKey', 'openSubtitlesApiKey',
  'preferSurround', 'preferredQuality', 'torrentSources',
  'downloadLimitMbps', 'seedWhileWatching', 'streamCacheDir',
  'sourceMirrors',
])

ipcMain.handle('video-settings-set', (_, { patch }) => {
  try {
    const current = _videoSettings()
    const clean = {}
    for (const [k, v] of Object.entries(patch || {})) {
      if (VIDEO_SETTING_KEYS.has(k)) clean[k] = v
    }
    const next = { ...current, ...clean }
    store.set('videoSettings', next)
    // Clearing the key is as much a change as setting one, and the ranking and
    // source-filtering settings decide what a cached stream list contains, so
    // any of them going stale would serve results from the previous setting.
    if (next.tmdbApiKey !== current.tmdbApiKey) _clearVideoCaches()
    else if (next.preferSurround !== current.preferSurround ||
             next.torrentSources !== current.torrentSources ||
             next.preferredQuality !== current.preferredQuality) {
      _videoStreamCache.clear()
    }
    // A changed mirror list means the provider singletons are pointed at the
    // wrong hosts until they are rebuilt, and any stream list they produced is
    // stale. Rebuild the singletons (they read the mirrors once, at
    // construction) and drop the cached stream lists so the next lookup runs
    // against the new mirrors. Compared by value — the blob is small.
    if (JSON.stringify(next.sourceMirrors) !== JSON.stringify(current.sourceMirrors)) {
      _rebuildMirrorProviders()
      _videoStreamCache.clear()
    }
    // The bandwidth cap and the seed-back switch take effect immediately on the
    // stream that is playing right now, not just the next one — WebTorrent
    // throttles the live client, so there is nothing to wait for. Mbps→bytes/s
    // is ×125000 (1 Mbit = 125000 bytes); null lifts the cap.
    const streamer = _videoSession.streamer
    if (streamer) {
      if (next.downloadLimitMbps !== current.downloadLimitMbps) {
        const mbps = Number(next.downloadLimitMbps)
        const bps = (next.downloadLimitMbps == null || !isFinite(mbps) || mbps <= 0)
          ? null : Math.floor(mbps * 125000)
        try { streamer.setDownloadLimit(bps) } catch (_) {}
      }
      if (next.seedWhileWatching !== current.seedWhileWatching) {
        try { streamer.setSeedWhileWatching(next.seedWhileWatching !== false) } catch (_) {}
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// The curated shelves. Everything the home tab showed before was a variant of
// "what is popular right now", which is why nothing made before this year ever
// appeared on it. These ask different questions: what is the canon, what did
// the seventies leave us, what came out of the French New Wave, what is good
// and under-seen.
//
// Each shelf is a discover query built in catalog/shelves.js and fetched here,
// where the key lives. Results go through the same normaliser as everything
// else so a curated card is identical to a trending one.
// Name to TMDB person id, once per name per process. The rotation holds names
// precisely so no id has to be trusted, and this is where the trust is earned:
// a name that does not resolve produces no shelf rather than a shelf of the
// wrong person.
const _personIdCache = new Map()
// id -> name, so _shelfDefinition can label a shelf it is handed only an id for.
const _directorNames = new Map()
async function _resolvePersonId(name) {
  if (!name) return null
  if (_personIdCache.has(name)) return _personIdCache.get(name)
  let id = null
  try {
    const people = await tmdb().searchPeople(name)
    const list = Array.isArray(people) ? people : []
    // An exact name match, not merely the top hit: searching a director's name
    // can rank an actor of the same name first.
    const exact = list.find(p => p && String(p.name || '').toLowerCase() === name.toLowerCase())
    const pick = exact || list[0] || null
    id = pick && pick.id != null ? pick.id : null
  } catch (_) { id = null }
  // Cached either way, including the null: a name TMDB does not know will not
  // start knowing it within a session, and retrying on every render is a
  // request per shelf render for nothing.
  _personIdCache.set(name, id)
  return id
}

// A shelf built from what the diary says you like.
//
// The taste lives in the renderer's own store, so the renderer sends its
// conclusions rather than main reaching into them: one director, one decade and
// one country, each already ranked. That keeps the store in one place and means
// this handler works the same whether the taste came from a diary of nine
// entries or nine hundred.
//
// The films you have already seen are NOT filtered here. The renderer's
// hide-what-I-have-seen toggle owns that decision, and a recommendation shelf
// that silently dropped them would disagree with the toggle.
ipcMain.handle('video-taste-shelf', async (_, { director, decade, country, seenKeys } = {}) => {
  try {
    const apiKey = _videoSettings().tmdbApiKey || process.env.TMDB_API_KEY
    if (!apiKey) return { ok: false, error: 'TMDB API key missing or invalid — set it in Settings → Video.' }

    // Nothing to go on is not a failure: a diary of one film has no taste in it
    // yet, and saying so is better than an empty row with a confident label.
    if (!director && !decade && !country) {
      return { ok: true, results: [], reason: null, empty: 'not-enough-history' }
    }

    // One of the three, chosen by what is strongest, because three at once
    // intersects to almost nothing: a Kurosawa-and-1950s-and-Japan query is
    // Kurosawa's 1950s films, which the user has by definition already seen.
    let params = null
    let reason = null
    if (director) {
      const id = await _resolvePersonId(director)
      if (id) {
        params = { with_crew: String(id), sort_by: 'vote_average.desc', 'vote_count.gte': '150' }
        reason = 'You keep coming back to ' + director
      }
    }
    if (!params && decade) {
      const start = Number(decade)
      if (Number.isFinite(start)) {
        params = {
          'primary_release_date.gte': start + '-01-01',
          'primary_release_date.lte': (start + 9) + '-12-31',
          sort_by: 'vote_average.desc',
          'vote_count.gte': '300',
        }
        reason = 'More from the ' + start + 's'
      }
    }
    if (!params && country) {
      params = {
        with_original_language: String(country).toLowerCase(),
        sort_by: 'vote_average.desc',
        // The floor that lets a small national cinema in at all — the same
        // reasoning the world-cinema shelf is built on.
        'vote_average.gte': '7.2',
        'vote_count.gte': '80',
      }
      reason = 'More films in ' + String(country).toUpperCase()
    }
    if (!params) return { ok: true, results: [], reason: null, empty: 'unresolved' }

    // (baseUrl, apiKey, params) — the key goes through the builder rather than
    // being appended, so it is encoded the same way every other shelf's is.
    const url = shelves.buildDiscoverUrl(null, apiKey, params)
    const res = await fetchWithTimeout(15000)(url)
    if (!res || !res.ok) return { ok: false, error: 'Recommendations request failed (' + (res && res.status) + ')' }
    const json = await res.json()
    const raw = Array.isArray(json && json.results) ? json.results : []
    // The same normalise-then-filter order every other shelf uses: the quality
    // filter reads normalised genre ids, so filtering raw results would silently
    // pass everything.
    const results = raw
      .map(r => tmdbCatalog.normalizeMovie(r))
      .filter(Boolean)
      .filter(item => !shelves.isLowQualityForFilmShelf(item))
    return { ok: true, results: results, reason: reason }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

ipcMain.handle('video-shelf', async (_, { key, page = 1 } = {}) => {
  try {
    // Resolved before the definition, because the definition needs the id.
    if (String(key) === 'director-of-the-day') {
      const name = shelves.directorOfTheDay(Date.now())
      const id = await _resolvePersonId(name)
      // The plan's rule: a shelf that cannot be filled honestly is not shown.
      if (!id) return { ok: false, error: `Could not find ${name} on TMDB` }
      key = 'director-' + id
      _directorNames.set(String(id), name)
    }
    const def = _shelfDefinition(key)
    if (!def) return { ok: false, error: `Unknown shelf: ${key}` }
    const cacheKey = `shelf:${key}:${page}`
    const cached = _videoCatalogCache.get(cacheKey)
    if (cached) return { ok: true, shelf: def.meta, results: cached }

    const apiKey = _videoSettings().tmdbApiKey || process.env.TMDB_API_KEY
    if (!apiKey) return { ok: false, error: 'TMDB API key missing or invalid — set it in Settings → Video.' }
    const url = `${def.url}&page=${page}&api_key=${encodeURIComponent(apiKey)}`
    const res = await fetchWithTimeout(15000)(url)
    if (!res || !res.ok) return { ok: false, error: `Shelf request failed (${res && res.status})` }
    const json = await res.json()
    const raw = Array.isArray(json && json.results) ? json.results : []

    // A daily news bulletin airs forever and so ranks by popularity forever;
    // Tagesschau sat in Popular TV for exactly that reason. A film shelf is not
    // the place for it.
    const results = raw
      .map(r => tmdbCatalog.normalizeMovie(r))
      .filter(Boolean)
      .filter(item => !shelves.isLowQualityForFilmShelf(item))

    if (results.length) _videoCatalogCache.set(cacheKey, results)
    return { ok: true, shelf: def.meta, results }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Resolves a shelf key like "decade-1970" or "movement-french-new-wave" to its
// query. Parameterised shelves are expanded here rather than enumerated, so a
// new decade costs nothing.
function _shelfDefinition(key) {
  const k = String(key || '')
  const build = (fn, arg) => {
    try {
      const def = arg === undefined ? fn() : fn(arg)
      if (!def || !def.url) return null
      return { url: def.url, meta: { key: def.key, label: def.label, note: def.note } }
    } catch (_) { return null }
  }
  if (k === 'canon') return build(shelves.canon)
  if (k === 'hidden-gems') return build(shelves.hiddenGems)
  if (k === 'world-cinema') return build(shelves.worldCinema)
  if (k === 'runtime-under-90') return build(shelves.runtimeUnder, 90)
  if (k === 'runtime-over-180') return build(shelves.runtimeOver, 180)
  let m
  // The name came from the rotation and was stashed when the id was resolved;
  // without it the shelf would be headed "Director in Focus: undefined".
  if ((m = /^director-(\d+)$/.exec(k))) {
    const name = _directorNames.get(m[1])
    if (!name) return null
    return build(() => shelves.directorInFocus(Number(m[1]), name))
  }
  if ((m = /^decade-(\d{4})$/.exec(k))) return build(shelves.decade, Number(m[1]))
  if ((m = /^movement-(.+)$/.exec(k))) return build(shelves.movement, m[1])
  if ((m = /^theme-(.+)$/.exec(k))) return build(shelves.theme, m[1])
  if ((m = /^country-(.+)$/.exec(k))) return build(shelves.country, m[1])
  if ((m = /^studio-(\d+)$/.exec(k))) return build(shelves.studio, Number(m[1]))
  if ((m = /^anniversary-(\d+)$/.exec(k))) return build(shelves.anniversary, Number(m[1]))
  return null
}

ipcMain.handle('video-catalog-get', async (_, { section, page = 1 }) => {
  try {
    // The season-anime section resolves "current season" at call time, so its
    // cache key carries the season: without it a 24h entry written in March
    // would still be served in April under the same key.
    const key = section === 'season-anime'
      ? `${section}:${page}:${_currentAnimeSeasonTag()}`
      : `${section}:${page}`
    const cached = _videoCatalogCache.get(key)
    if (cached) return { ok: true, results: cached }
    let results
    switch (section) {
      case 'trending-movies': results = await tmdb().trending('movie', page); break
      case 'trending-tv': results = await tmdb().trending('tv', page); break
      case 'popular-tv': results = await tmdb().popular('tv', page); break
      case 'trending-anime': results = await anilist().trending(page); break
      case 'popular-anime': results = await anilist().popular(page); break
      case 'season-anime': results = await anilist().season(page); break
      default: return { ok: false, error: `Unknown catalog section: ${section}` }
    }
    // An empty list is almost always a transient upstream failure dressed up as
    // success. Caching it for a day would keep the row empty long after the API
    // recovered, so only real results are stored.
    if (Array.isArray(results) && results.length) _videoCatalogCache.set(key, results)
    return { ok: true, results }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Browse vocabularies change when an editor adds a genre — annually at most,
// so a week is conservative. The chain and franchise caches exist because a
// season list is walked one request per hop and must not be re-walked on every
// visit to a detail page.
const _videoVocabCache = makeCache({ cap: 8, ttlMs: 1000 * 60 * 60 * 24 * 7 })
const _videoChainCache = makeCache({ cap: 300, ttlMs: 1000 * 60 * 60 * 24 })
const _videoDiscoverCache = makeCache({ cap: 200, ttlMs: 1000 * 60 * 15 })

ipcMain.handle('video-genres', async (_, { catalog } = {}) => {
  try {
    const key = `genres:${catalog || 'movie'}`
    const cached = _videoVocabCache.get(key)
    if (cached) return { ok: true, genres: cached }
    let genres
    if (catalog === 'anime') {
      // AniList genres are plain strings; TMDB's are {id,name}. The shape is
      // unified here so the filter rail does not need to know which catalog
      // it is rendering.
      genres = (await anilist().genres()).map(name => ({ id: name, name }))
    } else {
      genres = await tmdb().genres(catalog === 'tv' ? 'tv' : 'movie')
    }
    if (genres.length) _videoVocabCache.set(key, genres)
    return { ok: true, genres }
  } catch (e) {
    return { ok: false, error: e.message, genres: [] }
  }
})

ipcMain.handle('video-tags', async () => {
  try {
    const cached = _videoVocabCache.get('tags')
    if (cached) return { ok: true, tags: cached }
    const tags = await anilist().tags()
    if (tags.length) _videoVocabCache.set('tags', tags)
    return { ok: true, tags }
  } catch (e) {
    return { ok: false, error: e.message, tags: [] }
  }
})

// The country list, so Browse can filter by where a film was made. Fetched
// rather than hardcoded because it is 251 entries and changes when the world
// does; cached for a week because it changes about that often.
const _countryCache = makeCache({ cap: 4, ttlMs: 1000 * 60 * 60 * 24 * 7 })
ipcMain.handle('video-countries', async () => {
  try {
    const hit = _countryCache.get('countries')
    if (hit) return { ok: true, countries: hit }
    const apiKey = _videoSettings().tmdbApiKey || process.env.TMDB_API_KEY
    if (!apiKey) return { ok: false, error: 'TMDB API key missing or invalid — set it in Settings → Video.', countries: [] }
    const res = await fetchWithTimeout(15000)(
      `https://api.themoviedb.org/3/configuration/countries?api_key=${encodeURIComponent(apiKey)}`)
    if (!res || !res.ok) return { ok: false, error: 'Could not load the country list', countries: [] }
    const raw = await res.json()
    const countries = (Array.isArray(raw) ? raw : [])
      .map(c => ({ code: c && c.iso_3166_1, name: (c && c.english_name) || (c && c.native_name) }))
      .filter(c => c.code && c.name)
      .sort((a, b) => a.name.localeCompare(b.name))
    if (countries.length) _countryCache.set('countries', countries)
    return { ok: true, countries }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), countries: [] }
  }
})

ipcMain.handle('video-discover', async (_, req) => {
  try {
    req = req || {}
    const catalog = req.catalog === 'tv' ? 'tv' : req.catalog === 'anime' ? 'anime' : 'movie'
    const key = JSON.stringify([catalog, req])
    const cached = _videoDiscoverCache.get(key)
    if (cached) return { ok: true, ...cached }
    const out = catalog === 'anime'
      ? await anilist().discover(req)
      : await tmdb().discover(catalog, req)
    // An empty page is usually a genuinely narrow filter rather than a
    // transient failure, so unlike the catalog rows this is worth caching —
    // paging to the end of a result set would otherwise re-query every time.
    _videoDiscoverCache.set(key, out)
    return { ok: true, ...out }
  } catch (e) {
    return { ok: false, error: e.message, results: [], totalResults: 0, totalPages: 0 }
  }
})

// The other entries in a series. Anime chains are walked from AniList
// relations; a film's equivalent is the franchise it belongs to.
ipcMain.handle('video-seasons', async (_, { type, id } = {}) => {
  try {
    if (type !== 'anime' || !id) return { ok: true, seasons: [], related: [] }
    const key = `anime:${id}`
    const cached = _videoChainCache.get(key)
    if (cached) return { ok: true, ...cached }
    let out
    try {
      out = await anilist().seasonChain(id)
    } catch (err) {
      // seasonChain normally degrades internally, but if it does throw during
      // an outage, treat it exactly like an empty walk so the persistent
      // fallback below has a chance to serve the last good chain.
      out = { seasons: [], related: [], truncated: true }
    }
    // A truncated chain is a partial answer — the walk hit a fork or a depth
    // limit and stopped short. Caching it would pin the incomplete list for the
    // whole TTL, so a later, complete walk never replaces it. Only cache a
    // chain that actually reached the end. A complete walk is also written
    // through to the persistent outage cache so `_animeAbsoluteEpisode` can
    // still resolve pack playback across restarts and while AniList is down.
    if (out.seasons.length && out.truncated !== true) {
      _videoChainCache.set(key, out)
      _animeDetailCacheWrite(`chain:${id}`, { chain: out })
      return { ok: true, ...out }
    }
    // The fresh walk came back empty or truncated. During an outage that is the
    // norm — fall back to the last complete chain persisted on disk (a stale
    // season list beats none, and pack playback needs it). Rehydrate the
    // in-memory cache so the same session stops re-walking a dead API.
    const persisted = _animeDetailCacheRead(`chain:${id}`)
    if (persisted && persisted.chain && persisted.chain.seasons &&
        persisted.chain.seasons.length) {
      _videoChainCache.set(key, persisted.chain)
      return { ok: true, ...persisted.chain }
    }
    return { ok: true, ...out }
  } catch (e) {
    return { ok: false, error: e.message, seasons: [], related: [] }
  }
})

ipcMain.handle('video-collection', async (_, { id } = {}) => {
  try {
    if (!id) return { ok: true, collection: null }
    const key = `collection:${id}`
    const cached = _videoChainCache.get(key)
    if (cached) return { ok: true, collection: cached }
    const collection = await tmdb().collection(id)
    if (collection) _videoChainCache.set(key, collection)
    return { ok: true, collection }
  } catch (e) {
    return { ok: false, error: e.message, collection: null }
  }
})

ipcMain.handle('video-person', async (_, { id, query } = {}) => {
  try {
    if (query) return { ok: true, people: await tmdb().searchPeople(query) }
    if (!id) return { ok: true, credits: [] }
    const key = `person:${id}`
    const cached = _videoChainCache.get(key)
    if (cached) return { ok: true, credits: cached }
    const credits = await tmdb().personCredits(id)
    if (credits.length) _videoChainCache.set(key, credits)
    return { ok: true, credits }
  } catch (e) {
    return { ok: false, error: e.message, credits: [], people: [] }
  }
})

// Searching every catalog at once, and collapsing the duplicate an anime
// title produces.
//
// TMDB has no concept of anime — it files it as ordinary television — so
// searching only TMDB returned a tv entry for an anime and no AniList entry at
// all. That entry carried TMDB's good detail but sent the source lookup to the
// TV indexer, which barely carries anime: measured on Frieren, 0 sources
// against nyaa's 22. AniList is now searched alongside, and where both
// describe the same show the AniList entry wins, because that is the one the
// Anime tab opens and its sources are the reason this was reported.
ipcMain.handle('video-search', async (_, { query, type }) => {
  try {
    if (type === 'anime') return { ok: true, results: await anilist().search(query) }

    if (type === 'movie' || type === 'tv') {
      const results = (await tmdb().search(query)).filter(r => r.type === type)
      return { ok: true, results }
    }

    // Both catalogs, in parallel. Neither is allowed to fail the search: a
    // dead AniList should still return films, and vice versa.
    const [tmdbRes, animeRes] = await Promise.all([
      tmdb().search(query).catch(() => []),
      anilist().search(query).catch(() => []),
    ])

    const merged = []
    for (const r of tmdbRes) {
      // A TMDB entry that is really anime and that AniList also has is the
      // same show twice. Keeping both is confusing, and the TMDB one is the
      // half with the worse sources. Films as well as series: an anime film
      // duplicated this way is the case that was reported.
      if (r.isAnime && animeRes.some(a => _sameShow(a, r))) continue
      merged.push(r)
    }
    return { ok: true, results: merged.concat(animeRes) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Whether an AniList entry and a TMDB entry describe the same show. Compared
// on every title each side knows, because the English, romaji and original
// names rarely agree across the two.
function _sameShow(anilistEntry, tmdbEntry) {
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const t = anilistEntry.titles || {}
  const left = [anilistEntry.title, t.romaji, t.english, t.native].map(norm).filter(Boolean)
  const right = [tmdbEntry.title, tmdbEntry.originalName].map(norm).filter(Boolean)
  if (!left.length || !right.length) return false
  return left.some(a => right.some(b => a === b || a.includes(b) || b.includes(a)))
}

// The show payload and each season payload are fetched and cached separately:
// switching season then costs one season request the first time and nothing
// afterwards, instead of re-fetching the entire show every click.
async function _videoShowDetail(type, id) {
  const key = `${type}:${id}`
  const cached = _videoDetailCache.get(key)
  if (cached) return cached
  let detail
  if (type === 'anime') {
    // AniList *does* have a by-id field (`Media(id:)`). This used to run a text
    // search for the id — searching for the string "21" — which routinely
    // opened a completely unrelated show.
    //
    // Fresh-first, cache-on-failure. A live byId always wins and is written
    // through to the persistent outage cache below. Only when byId THROWS (an
    // outage — e.g. AniList's global 403) do we fall back to the on-disk copy:
    // a stale detail page beats an error page during an outage. byId returning
    // null (a genuinely unknown id) is not an error and is left to surface as
    // "not found" — there is nothing to fall back to.
    try {
      detail = await anilist().byId(id)
      if (detail) _animeDetailCacheWrite(`anime:${id}`, { detail })
    } catch (err) {
      const cached = _animeDetailCacheRead(`anime:${id}`)
      if (cached && cached.detail) return cached.detail
      // No cached copy: let the honest error (AniList's own message) through to
      // the detail handler, which returns it to the renderer's error page.
      throw err
    }
  } else {
    detail = await tmdb().detail(type === 'tv' ? 'tv' : 'movie', id)
    // TMDB carries the better description, cast and artwork; AniList carries
    // the romaji title the release groups actually index under, and the MAL id
    // the skip service is keyed on. A show opened from a search lands on the
    // TMDB entry and used to get the TV indexer's sources, which barely carry
    // anime — the same show opened from the Anime tab got nyaa and a far
    // better list. Borrowing AniList's titles here means the entry point stops
    // mattering: TMDB's detail, nyaa's sources.
    if (detail && detail.isAnime) detail = await _enrichAnimeDetail(detail)
  }
  if (detail) detail = await _enrichExternalRatings(detail)
  if (detail) _videoDetailCache.set(key, detail)
  return detail
}

// One score averaged from one site's users is a thin basis for deciding what to
// watch. IMDb's two million votes, the Rotten Tomatoes critics' figure and
// Metacritic's weighted average disagree about the same film, and the
// disagreement is the useful part — as is the awards line, which says more than
// any of the three.
//
// Optional in every sense: no key, no IMDb id, or a failed request all leave
// the detail exactly as it was. The title fallback exists because TMDB has no
// IMDb id for a long tail of titles, and it is narrowed by year because remakes
// share a title far more often than they share a year.
async function _enrichExternalRatings(detail) {
  try {
    const client = omdb()
    const external = detail.imdbId
      ? await client.byImdbId(detail.imdbId)
      : await client.byTitle(detail.title, detail.year)
    if (!external) return detail
    return { ...detail, external }
  } catch (_) {
    return detail
  }
}

// Finds the AniList entry for a TMDB anime and copies across what the source
// router and the skip service need. Failure is not fatal: without it the show
// simply behaves as it did before.
async function _enrichAnimeDetail(detail) {
  try {
    // The original Japanese name matches AniList far more reliably than the
    // English one, which is often a licensor's retitling.
    const queries = [detail.originalName, detail.title].filter(Boolean)
    for (const q of queries) {
      const hits = await anilist().search(q, 1)
      if (!hits || !hits.length) continue
      // Trust a hit only when a title actually corresponds — AniList search is
      // fuzzy, and the wrong show's romaji title would send the source lookup
      // somewhere unrelated.
      const match = hits.find(h => _titlesOverlap(h, detail)) || null
      if (!match) continue
      return {
        ...detail,
        titles: match.titles || null,
        idMal: match.idMal || null,
        anilistId: match.id,
        episodeCount: detail.episodeCount || match.episodeCount || null,
      }
    }
  } catch (_) { /* enrichment is a bonus, never a requirement */ }
  return detail
}

function _titlesOverlap(a, b) {
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const aNames = [a.title, a.titles && a.titles.romaji, a.titles && a.titles.english,
                  a.titles && a.titles.native].map(norm).filter(Boolean)
  const bNames = [b.title, b.originalName].map(norm).filter(Boolean)
  return aNames.some(x => bNames.some(y => x === y || x.includes(y) || y.includes(x)))
}

async function _videoSeasonDetail(tvId, season) {
  const key = `tv:${tvId}:s${season}`
  const cached = _videoSeasonCache.get(key)
  if (cached) return cached
  const payload = await tmdb().season(tvId, season)
  if (payload && Array.isArray(payload.episodes) && payload.episodes.length) {
    _videoSeasonCache.set(key, payload)
  }
  return payload
}

ipcMain.handle('video-detail', async (_, { type, id, season }) => {
  try {
    const detail = await _videoShowDetail(type, id)
    if (!detail) return { ok: false, error: 'Not found' }
    if (type === 'tv' && typeof season === 'number' && Array.isArray(detail.seasons)) {
      const eps = await _videoSeasonDetail(id, season)
      const entry = detail.seasons.find(s => s.seasonNumber === season)
      // The cached show object is shared across calls, so the episode list is
      // attached to a shallow copy rather than mutated in place — otherwise a
      // second season's episodes would overwrite the first inside the cache.
      if (entry && eps) {
        const seasons = detail.seasons.map(sn =>
          sn.seasonNumber === season ? { ...sn, episodes: eps.episodes || [] } : sn
        )
        return { ok: true, detail: { ...detail, seasons } }
      }
    }
    return { ok: true, detail }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Merges the AniList airing rows and the TMDB next-episode rows into one flat,
// time-sorted schedule for the airing shelf and the calendar (App #25/#26).
// Pure so the merge and its date handling are testable without the network:
//   anilistRows: [{ id, title, episode, airingAt }]  (airingAt = epoch SECONDS)
//   tmdbRows:    [{ id, title, nextEpisode: { episodeNumber, airDate } }]
// Every row becomes { key, title, episode, airsAt, type } where airsAt is
// epoch MILLISECONDS. AniList's airingAt is a real timestamp; TMDB gives only a
// day string, so it is anchored to local midnight of that day — a "Thursday"
// with no clock time, which is exactly what the shelf and calendar show. Rows
// with no usable time are dropped, and the whole list is sorted soonest-first.
function _mergeAiring(anilistRows, tmdbRows) {
  const out = []
  for (const r of Array.isArray(anilistRows) ? anilistRows : []) {
    if (!r || r.id == null) continue
    const secs = Number(r.airingAt)
    if (!Number.isFinite(secs) || secs <= 0) continue
    out.push({
      key: 'anime:' + r.id,
      title: r.title || null,
      episode: r.episode ?? null,
      airsAt: secs * 1000,
      type: 'anime',
    })
  }
  for (const r of Array.isArray(tmdbRows) ? tmdbRows : []) {
    if (!r || r.id == null) continue
    const ne = r.nextEpisode
    if (!ne || !ne.airDate) continue
    // "YYYY-MM-DD" parsed as local midnight, not UTC: `new Date('2026-09-10')`
    // is UTC midnight and shifts the day west of Greenwich, which would land a
    // Thursday episode on Wednesday's calendar row for a US viewer.
    const airsAt = _dayStringToLocalMs(ne.airDate)
    if (airsAt == null) continue
    out.push({
      key: 'tv:' + r.id,
      title: r.title || null,
      episode: ne.episodeNumber ?? null,
      airsAt,
      type: 'tv',
    })
  }
  out.sort((a, b) => a.airsAt - b.airsAt)
  return out
}

// "YYYY-MM-DD" → epoch ms at LOCAL midnight of that day, or null if unparseable.
// Kept apart from _mergeAiring so the date rule has its own test.
function _dayStringToLocalMs(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const t = d.getTime()
  return Number.isFinite(t) ? t : null
}

ipcMain.handle('video-airing', async (_, { anilistIds, tmdbIds } = {}) => {
  try {
    const aIds = (Array.isArray(anilistIds) ? anilistIds : [])
      .map(Number).filter(n => Number.isFinite(n) && n > 0)
    const tIds = (Array.isArray(tmdbIds) ? tmdbIds : [])
      .map(Number).filter(n => Number.isFinite(n) && n > 0)
    if (!aIds.length && !tIds.length) return { ok: true, airing: [] }
    // The id sets, sorted and de-duplicated, are the cache identity: the same
    // follow list served the same schedule for the whole TTL regardless of the
    // order the renderer happened to send the ids in.
    const uniqSorted = list => [...new Set(list)].sort((a, b) => a - b)
    const aKey = uniqSorted(aIds)
    const tKey = uniqSorted(tIds)
    const cacheKey = `airing:${aKey.join(',')}|${tKey.join(',')}`
    const cached = _videoAiringCache.get(cacheKey)
    if (cached) return { ok: true, airing: cached }

    // Each source is optional: AniList and TMDB fail independently, and a dead
    // TMDB key must not blank out the anime half of the schedule. Anything that
    // throws contributes an empty list rather than failing the whole handler.
    const anilistRows = aKey.length
      ? await anilist().airingSchedule(aKey).catch(() => [])
      : []
    // TMDB has no batch next-episode endpoint, so each followed TV id is a
    // detail fetch — but _videoShowDetail caches, so a followed show already
    // opened this session costs nothing, and next_episode_to_air rides the
    // detail response with no extra request of its own.
    const tmdbRows = tKey.length
      ? (await Promise.all(tKey.map(id =>
          _videoShowDetail('tv', id)
            .then(d => (d ? { id: d.id ?? id, title: d.title, nextEpisode: d.nextEpisode } : null))
            .catch(() => null)
        ))).filter(Boolean)
      : []

    const airing = _mergeAiring(anilistRows, tmdbRows)
    // Only a non-empty schedule is cached: an empty result is almost always a
    // transient upstream failure, and a 30-minute empty cache would hide the
    // shelf long after the API recovered.
    if (airing.length) _videoAiringCache.set(cacheKey, airing)
    return { ok: true, airing }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// ── Air-date notifications (roadmap #35) ─────────────────────────────────────
// On app start, and every 6h, compute the airing schedule for the shows the
// user follows (their video-store watchlist) and fire a desktop Notification for
// any episode airing in the next 24h that has not been notified yet. Notified
// keys are persisted and capped at 200 (src/airing-notify.js). Respects the
// airingNotifications toggle (default ON).
const airingNotify = require('./src/airing-notify')
const AIRING_CHECK_EVERY_MS = 6 * 60 * 60 * 1000

// The followed anime (AniList) and TV (TMDB) ids from the video-store watchlist.
// main can read the same bridged blob the renderer writes — it holds
// watchlist: [{ type, id, ... }]. anime -> anilistIds, tv -> tmdbIds. Movies
// have no airing schedule and are ignored.
function _followedAiringIds() {
  const anilistIds = []
  const tmdbIds = []
  try {
    const raw = sideStores.videoStore.get()
    const blob = typeof raw === 'string' ? JSON.parse(raw) : raw
    const list = blob && Array.isArray(blob.watchlist) ? blob.watchlist : []
    for (const w of list) {
      if (!w || w.id == null) continue
      const id = Number(w.id)
      if (!Number.isFinite(id) || id <= 0) continue
      if (w.type === 'anime') anilistIds.push(id)
      else if (w.type === 'tv') tmdbIds.push(id)
    }
  } catch (_) { /* a missing or malformed blob just yields no follows */ }
  return { anilistIds, tmdbIds }
}

// Compute the merged airing schedule for the followed shows. Reuses the same
// AniList/TMDB fetch and _mergeAiring the airing shelf uses; each source fails
// independently to an empty list.
async function _followedAiringSchedule() {
  const { anilistIds, tmdbIds } = _followedAiringIds()
  const aIds = [...new Set(anilistIds)].sort((a, b) => a - b)
  const tIds = [...new Set(tmdbIds)].sort((a, b) => a - b)
  if (!aIds.length && !tIds.length) return []
  const anilistRows = aIds.length
    ? await anilist().airingSchedule(aIds).catch(() => [])
    : []
  const tmdbRows = tIds.length
    ? (await Promise.all(tIds.map(id =>
        _videoShowDetail('tv', id)
          .then(d => (d ? { id: d.id ?? id, title: d.title, nextEpisode: d.nextEpisode } : null))
          .catch(() => null)
      ))).filter(Boolean)
    : []
  return _mergeAiring(anilistRows, tmdbRows)
}

let _airingChecking = false
async function checkAiringNotifications() {
  if (_airingChecking) return
  if (!_videoConfig().airingNotifications) return
  if (!Notification.isSupported()) return
  _airingChecking = true
  try {
    const schedule = await _followedAiringSchedule()
    if (!schedule.length) return
    const notified = sideStores.airingNotified.get() || []
    const due = airingNotify.dueNotifications(schedule, notified)
    if (!due.length) return
    const firedKeys = []
    for (const row of due) {
      const epText = row.episode != null ? ` — Episode ${row.episode}` : ''
      try {
        new Notification({
          title: 'Airing soon',
          body: (row.title || 'A followed show') + epText,
          icon: ICON_PATH,
          silent: false,
        }).show()
        firedKeys.push(row.notifyKey)
      } catch (_) { /* a Notification that will not show must not lose the others */ }
    }
    if (firedKeys.length) {
      sideStores.airingNotified.set(airingNotify.recordNotified(notified, firedKeys))
    }
  } catch (e) {
    console.error('[papa] airing-notification check failed:', String(e && e.message || e))
  } finally {
    _airingChecking = false
  }
}

// Only the backends that can actually answer for this media type are asked.
// Previously every TV episode also queried YTS, which indexes movies only —
// one guaranteed-empty network round-trip per episode click.
function _videoBackends(type, settings) {
  const torrents = settings.torrentSources !== false
  // `type` here is the *source* type, which is not always the catalog the
  // entry came from: a TMDB tv show flagged as anime is routed to nyaa, so a
  // show found by search gets the same sources as one found in the Anime tab.
  if (type === 'anime') return torrents ? [nyaa(), animetosho(), apibay(), knaben(), solidtorrents(), anime()] : [anime()]
  // Every type gets the broad indexer alongside its specialist one. They run
  // in parallel and their results are merged and de-duplicated by info hash,
  // so the specialist's better metadata wins where both have the same torrent
  // and the broad one fills in everything the specialist never carried.
  if (type === 'tv') return torrents ? [eztv(), apibay(), knaben(), solidtorrents(), movieTv()] : [movieTv()]
  return torrents ? [yts(), apibay(), knaben(), solidtorrents(), movieTv()] : [movieTv()]
}

// The preferred-quality setting was stored and read by nothing. It is applied
// as a stable partition rather than a filter: sources at or below the preferred
// quality come first (best first), and anything higher is kept but pushed
// below, so the user still sees a 2160p option without it hijacking the top
// slot on a connection chosen for 1080p.
function _applyQualityPreference(streams, preferred) {
  const rank = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 }
  const want = rank[preferred]
  if (!want) return streams
  const within = []
  const above = []
  // Cam rips stay at the very bottom whatever the preference says. Without
  // this, preferring 1080p would push a real 2160p release below a telesync,
  // because the telesync's quality parses as "unknown" and lands in `within`.
  const low = []
  for (const s of streams) {
    if (s && s.lowQuality === true) { low.push(s); continue }
    const r = rank[s && s.quality] || 0
    ;(r > want ? above : within).push(s)
  }
  return within.concat(above, low)
}

// Fansub groups number continuing seasons absolutely — "Attack on Titan 64",
// not "Final Season 05" — while AniList files each season as its own entry
// starting from episode 1. Without the translation, later seasons either find
// nothing on the indexers or match the wrong season's episode. The absolute
// number is the sum of the episode counts of the TV entries that come before
// this one in the season chain. Only the already-cached chain is consulted
// (the detail page fetches it), so this never adds a network hop to a stream
// lookup; any doubt — a gap in the counts, a non-TV entry asked about, a cold
// cache — returns null and the seasonal query stands alone, where a wrong
// guess would have cost nothing but a harmless extra query anyway.
function _animeAbsoluteEpisode(anilistId, episode) {
  try {
    // In-memory first; fall back to the persistent outage cache so absolute
    // episode numbering for multi-season packs still resolves after a restart
    // or while AniList is down and the fresh walk returned nothing.
    let chain = _videoChainCache.get(`anime:${anilistId}`)
    if (!chain || !Array.isArray(chain.seasons) || !chain.seasons.length) {
      const persisted = _animeDetailCacheRead(`chain:${anilistId}`)
      if (persisted && persisted.chain) chain = persisted.chain
    }
    const seasons = chain && Array.isArray(chain.seasons) ? chain.seasons : []
    if (!seasons.length) return null
    const tv = seasons.filter(s => s && (s.format === 'TV' || s.format === 'TV_SHORT'))
    const idx = tv.findIndex(s => String(s.id) === String(anilistId))
    if (idx <= 0) return null   // first season's numbering is already absolute
    let prior = 0
    for (let i = 0; i < idx; i++) {
      const n = Number(tv[i].episodeCount)
      if (!n || n < 1) return null
      prior += n
    }
    return prior + (Number(episode) || 0)
  } catch (_) { return null }
}

ipcMain.handle('video-streams', async (_, req) => {
  const { type, tmdbId, anilistId, imdbId, title, titles, year, season, episode, sub, dub } = req || {}
  try {
    const settings = _videoSettings()
    // Anime that TMDB files as a series or a film is looked up as anime,
    // whichever entry the viewer opened. This has to change the request's own
    // type, not just the choice of backends: nyaa refuses anything that is not
    // type 'anime', so routing to it while still saying 'tv' would have
    // returned nothing at all. Films count too — restricting this to
    // television left Jujutsu Kaisen 0 on the film indexers, with no dub.
    const sourceType = (req.isAnime === true && type !== 'anime') ? 'anime' : type
    const absoluteEpisode = (sourceType === 'anime' && anilistId && episode)
      ? _animeAbsoluteEpisode(anilistId, episode)
      : null
    const request = {
      type: sourceType, tmdbId, anilistId, imdbId, title, titles, year, season, episode, sub, dub,
      absoluteEpisode,
    }
    // Key on the request plus the settings that change the answer, so a
    // settings change can never be masked by a cache hit.
    const key = JSON.stringify([request, settings.preferSurround, settings.preferredQuality, settings.torrentSources])
    const cached = _videoStreamCache.get(key)
    if (cached) return { ok: true, streams: cached }
    const backends = _videoBackends(sourceType, settings)
    const ranked = await resolveStream(request, backends, {
      preferSurround: settings.preferSurround,
      timeoutMs: 20000,
      // Learned dead-magnet memory (App #41): demote (never hide) torrents whose
      // infohash has failed to connect repeatedly and recently.
      isDead: _isDeadMagnet,
    })
    const streams = _applyQualityPreference(ranked, settings.preferredQuality)
    // An empty result is almost always a mirror being briefly unreachable.
    // Caching it pinned "No sources found" on that title for the full 15-minute
    // TTL even after the indexer came back.
    if (streams.length) _videoStreamCache.set(key, streams)
    return { ok: true, streams }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('video-probe', async (_, { url }) => {
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,channels,codec_name',
        '-of', 'json', url
      ], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 }, (err, out) => err ? reject(err) : resolve(out))
    })
    const streams = (JSON.parse(stdout).streams || [])
    const audio = streams.find(s => s.codec_type === 'audio')
    if (!audio) return { ok: true, audioLayout: 'unknown', channels: 0, codec: null }
    const channels = Number(audio.channels) || 0
    return { ok: true, audioLayout: classify(channels), channels, codec: audio.codec_name || null }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// A hover thumbnail for the seek bar (Player #5). The renderer asks for a
// position on the track; the answer is the jpg for that position's bucket, or
// null while (or if) it is being generated. null is not an error — the bubble
// simply shows the time alone, exactly as it did before this existed. Only
// torrent streams have a thumbnailer; a direct URL play never built one, so it
// returns null too. Never throws, so a hover can never surface an error dialog.
ipcMain.handle('video-thumb', async (_, { position } = {}) => {
  try {
    const thumbnailer = _videoSession.thumbnailer
    if (!thumbnailer || typeof thumbnailer.at !== 'function') return { ok: true, path: null }
    const p = thumbnailer.at(Number(position) || 0)
    return { ok: true, path: p || null }
  } catch (_) {
    return { ok: true, path: null }
  }
})

// Tear down whatever is currently playing before starting anything new.
// Without this every play stacked another mpv process and another live torrent
// on top of the last one: `video-play` overwrote `_videoSession.streamer` and
// `VideoEngine.start()` overwrote its own `proc`, so nothing ever stopped. A
// few plays into a session there were several mpv windows fighting for audio
// and several torrents still downloading and seeding in the background.
// After a jump, tell the torrent where the viewer actually went. The head is
// prioritised once when a stream starts and never again, so without this every
// seek away from the beginning waits behind bytes nobody is going to watch.
//
// Read after the seek rather than computed from the request, because a relative
// seek, a chapter jump and a click on the bar all arrive differently and mpv
// has already resolved all of them into one position.
function _prioritiseStreamAtPlayhead() {
  try {
    const streamer = _videoSession.streamer
    if (!streamer || typeof streamer.seekToFraction !== 'function') return
    const state = videoEngine().state
    const duration = Number(state && state.duration) || 0
    const position = Number(state && state.position) || 0
    if (duration <= 0) return
    streamer.seekToFraction(position / duration)
  } catch (_) { /* an optimisation, never a reason to fail the seek */ }
}

// Once the viewer is halfway through an episode, quietly start pulling the
// opening of the next one.
//
// Half way is chosen because by then the current episode's own lead is well
// established, and there is still a whole half-episode for a modest window to
// arrive in the background. Earlier would take bandwidth from a stream that has
// not settled; later would not finish in time to be worth anything.
//
// Only within a season pack. A separate torrent per episode would mean
// resolving and connecting a second swarm while one is already playing, which
// is a much bigger thing to get wrong -- and the pack is the case that actually
// comes up, because that is what the anime and television indexers return.
const PREFETCH_AFTER = 0.5

function _maybePrefetchNextEpisode() {
  try {
    const streamer = _videoSession.streamer
    if (!streamer || typeof streamer.prefetchFile !== 'function') return
    const state = videoEngine().state
    const duration = Number(state && state.duration) || 0
    const position = Number(state && state.position) || 0
    if (duration <= 0 || position / duration < PREFETCH_AFTER) return

    const files = typeof streamer.files === 'function' ? streamer.files() : []
    if (files.length < 2) return
    const at = files.findIndex(f => f.current)
    if (at < 0 || at + 1 >= files.length) return       // nothing after this one
    streamer.prefetchFile(files[at + 1].index)
  } catch (_) { /* an optimisation, never a reason to disturb playback */ }
}

// The hover-thumbnail cache (Player #5) belongs to one stream. It is torn down
// with the streamer everywhere the streamer is: its cleanup() removes its own
// directory, which is a no-op when the directory nested inside the stream's
// cache dir has already gone with the streamer's own sweep, and the real work
// when the thumbnailer made its own directory (a reused torrent).
function _thumbnailerTeardown() {
  if (_videoSession.thumbnailer) {
    try { _videoSession.thumbnailer.cleanup() } catch (_) {}
    _videoSession.thumbnailer = null
  }
}

function _videoTeardown() {
  if (_videoSession.streamer) {
    try { _videoSession.streamer.stop() } catch (_) {}
    _videoSession.streamer = null
  }
  _thumbnailerTeardown()
  try { videoEngine().stop() } catch (_) {}
}

// mpv dying mid-playback used to be invisible: VideoEngine emits 'engineDown'
// and nobody listened, so the UI sat on "Playing" forever. Subscribed once,
// on the lazily-built engine.
let _videoEngineWired = false
function _wireVideoEngine() {
  if (_videoEngineWired) return
  _videoEngineWired = true
  const engine = videoEngine()
  // Keys pressed while the video window has focus. The deck is in another
  // window and cannot see them, so mpv forwards the ones the app owns.
  engine.on('appKey', payload => {
    safeSend('video-event', { kind: 'key', action: payload && payload.action })
  })
  engine.on('engineDown', () => {
    if (_videoSession.streamer) {
      try { _videoSession.streamer.stop() } catch (_) {}
      _videoSession.streamer = null
    }
    _thumbnailerTeardown()
    _closeVideoWindow()
    safeSend('video-event', { kind: 'error', message: 'Playback stopped unexpectedly (mpv exited).' })
  })
  // The theatre's control deck is driven by the throttled state stream, not by
  // individual property updates — the UI merges nothing (§4.2), so every emit
  // is a complete object.
  engine.on('state', s => {
    safeSend('video-state', s)
    _maybePrefetchNextEpisode()
  })
  // Movement over the picture, which the page cannot see for itself: the video
  // window is native and takes the pointer events. Sent on the existing event
  // channel rather than a new one -- it carries nothing but the fact that it
  // happened, and the theatre only needs that to know the viewer is still there.
  engine.on('activity', () => safeSend('video-event', { kind: 'activity' }))
  // mpv finished with the file. An error end is a corrupt or unplayable
  // source; a natural end is the film being over. Both used to be silent —
  // black screen, live controls, nothing marked watched.
  // The engine notices a stall before the renderer's own watchdog can (it
  // rides the state ticks and a deadline timer). Paint it on the picture from
  // here — the OSD is the only surface the viewer can actually see — and
  // forward it so the page can offer a way out.
  engine.on('stalled', payload => {
    try { engine.osdMessage('Buffering… the source has stalled.', 5000) } catch (_) {}
    // stallCount rides along so the renderer's auto-switch (§player 27, capped
    // at 2/episode) can count repeated stalls without a watchdog of its own.
    safeSend('video-event', {
      kind: 'stalled',
      position: payload && payload.position,
      stallCount: payload && payload.stallCount,
    })
  })
  engine.on('unstalled', () => {
    try { engine.osdMessage('Resumed', 1200) } catch (_) {}
    safeSend('video-event', { kind: 'unstalled' })
  })
  engine.on('ended', payload => {
    safeSend('video-event', {
      kind: 'ended',
      // reason is 'eof' or 'error'; the error field is mpv's message when it
      // has one. A message-less error end is still an error end.
      error: !!(payload && payload.reason === 'error'),
      reason: (payload && (payload.error || payload.reason)) || null,
    })
  })
}

// The stream list only carries what the indexer claimed about the audio. Once
// mpv is actually playing we know the file's real layout, so probe it and tell
// the UI. This is what the video-probe handler was built for and nothing called.
function _probePlayingAudio(url, current) {
  // The token that was current when the probe was launched. A source switch
  // during the ~seconds ffprobe takes would otherwise report the OLD file's
  // audio layout against the NEW playback, so a stale callback is dropped.
  const stillCurrent = typeof current === 'function' ? current : () => true
  execFile('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,channels,codec_name',
    '-of', 'json', url
  ], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 }, (err, out) => {
    if (err) return
    if (!stillCurrent()) return
    try {
      const audio = (JSON.parse(out).streams || []).find(st => st.codec_type === 'audio')
      if (!audio) return
      const channels = Number(audio.channels) || 0
      safeSend('video-event', {
        kind: 'audio', audioLayout: classify(channels), channels, codec: audio.codec_name || null,
      })
    } catch (_) { /* probe is advisory only */ }
  })
}

// ── Learned dead-magnet memory (App #41) ─────────────────────────────────────
// The infohash out of a magnet URI (xt=urn:btih:<hash>), lower-cased. Entries
// from the providers already carry `infoHash`; this covers the fallback where
// only the magnet string is to hand. Returns '' when there is no hash to read.
function _infoHashFromMagnet(magnet) {
  if (typeof magnet !== 'string') return ''
  const m = magnet.match(/xt=urn:btih:([a-z0-9]+)/i)
  return m ? m[1].toLowerCase() : ''
}

// The infohash a stream result is really about: the explicit field first, the
// magnet second. Used both to record a failure and to test one for demotion.
function _resultInfoHash(result) {
  if (!result || typeof result !== 'object') return ''
  if (result.infoHash) return String(result.infoHash).toLowerCase()
  return _infoHashFromMagnet(result.magnet)
}

// Record that this torrent failed to connect / never started, folding it into
// the persistent map with the 14-day decay applied. Called from the streamer's
// give-up and error paths. Never throws — a bad write must not sink playback.
function _recordDeadMagnet(result) {
  const hash = _resultInfoHash(result)
  if (!hash) return
  try {
    sideStores.deadMagnets.update(prev => deadMagnet.recordFailure(prev || {}, hash, Date.now()))
  } catch (_) { /* the memory is best-effort; a failed write just forgets */ }
}

// The predicate handed to the ranker: is this infohash demoted right now? Reads
// the current map and applies the decay against the wall clock. Cheap enough to
// call per entry during a rank.
function _isDeadMagnet(hash) {
  try {
    return deadMagnet.isDead(sideStores.deadMagnets.get() || {}, hash, Date.now())
  } catch (_) { return false }
}

// The torrent half of starting a stream, extracted so video-play and
// video-switch-stream share exactly one copy of it: the streamer options, the
// error/progress wiring and the stamped-token guard were subtle enough the
// first time that a second, drifting copy in the switch handler would be a bug
// waiting to happen.
//
// `current()` is the caller's play-token guard; `onReady(url, streamer)` is the
// only thing that differs between the two — a fresh play spins mpv up with
// `start()`, a mid-play switch keeps the running mpv and only `load()`s the new
// URL. The streamer is stored on the session and its `start()` fired here; the
// caller does not await it, because `start()` resolves on 'ready' and awaiting
// it would hang the handler on a slow torrent.
function _startTorrentStream(result, { current, fail, onReady }) {
  const settings = _videoSettings()
  // The bandwidth cap (App #41) and seed-back switch (App #42) come from the
  // stored video settings. Mbps→bytes/s is ×125000; null/0 means uncapped.
  const mbps = Number(settings.downloadLimitMbps)
  const downloadLimitBps = (settings.downloadLimitMbps == null || !isFinite(mbps) || mbps <= 0)
    ? null : Math.floor(mbps * 125000)
  const streamer = new TorrentStreamer({
    client: getTorrentClient(),
    downloadLimitBps,
    seedWhileWatching: settings.seedWhileWatching !== false,
    // First contact only, and only when nothing at all has been found: once
    // peers are connected the streamer extends this itself rather than giving
    // up on a torrent that is working. Discovery under Electron routinely takes
    // ten seconds or more here before the first peer connects, so thirty was
    // cutting off torrents that were fine.
    timeoutMs: 45000,
    // No prebuffer gate: mpv starts the moment the local server is up and
    // buffers itself, which is how this behaved when it played well. Waiting on
    // 12 MB here was a misdiagnosis of the original stutter — that was mpv's
    // demuxer cache, now 256 MiB, which is the real fix.
    prebufferBytes: 0,
  })
  streamer.on('error', err => {
    // A stream that never connected or never started is exactly the signal the
    // dead-magnet memory (App #41) is for. Recorded before surfacing the error
    // so the next lookup can demote this infohash.
    _recordDeadMagnet(result)
    if (current()) fail(err)
  })
  streamer.on('progress', p => { if (current()) safeSend('video-event', { kind: 'buffering', ...p }) })
  streamer.on('ready', ({ url }) => {
    if (!current()) { try { streamer.stop() } catch (_) {} ; return }
    // Stand up the hover-thumbnail cache (Player #5) for this stream. ffmpeg
    // reads the same local URL mpv plays; the frames land inside the stream's
    // own cache directory when it has one (swept with the streamer), or a fresh
    // directory under the stream root otherwise (a reused torrent), which
    // _thumbnailerTeardown removes. Best-effort: a thumbnailer that cannot be
    // built just leaves the bubble time-only, never blocking playback.
    _thumbnailerTeardown()
    try {
      let base = null
      try { base = typeof streamer.storeDir === 'function' ? streamer.storeDir() : null } catch (_) {}
      const thumbDir = base
        ? path.join(base, 'thumbs')
        : path.join(streamRoot(), `thumbs-${process.pid}-${Date.now()}`)
      _videoSession.thumbnailer = createThumbnailer({ dir: thumbDir, source: url })
    } catch (_) { _videoSession.thumbnailer = null }
    onReady(url, streamer)
  })
  _videoSession.streamer = streamer
  // A season pack holds every episode, so the streamer is told which one is
  // wanted; without it the largest file wins, which is an arbitrary episode.
  streamer.start({
    magnet: result.magnet,
    fileIndex: result.fileIndex ?? 0,
    season: result.season ?? null,
    episode: result.episode ?? null,
  })
    .catch(e => { if (e && e.code === 'STOPPED') return; fail(e) })
  return streamer
}

ipcMain.handle('video-play', async (_, { result }) => {
  try {
    if (!result || typeof result !== 'object') return { ok: false, error: 'No source selected' }
    _videoTeardown()
    _wireVideoEngine()
    // The music engine must not keep talking over the video. The renderer's
    // media-handoff referee (#72) is the source of truth for this now — it
    // pauses music at the moment it starts the film and remembers to resume it
    // — but a play triggered outside that path (session restore, a direct IPC)
    // still needs the guard, so pause here too. Idempotent: pausing an already
    // paused engine is a no-op, and the renderer owns the resume decision.
    if (player) { try { player.pause().catch(() => {}) } catch (_) {} }
    // When the user wants the in-app panel, obtain the X11 wid now and show the
    // host window; on failure (wid null) mpv opens its own window instead.
    // mpv opens and manages its own window. Embedding it into a child
    // BrowserWindow put a native surface on top of the app, where it covered
    // the deck it was supposed to sit beside; the window manager handles
    // moving, resizing and fullscreening it far better than positioning it by
    // hand ever did. mpv carries its own on-screen controls, and the app's
    // own actions are bound inside it (see VideoEngine._bindAppKeys).
    // Embedded, so there is one window: mpv draws into a frameless child
    // surface positioned inside Papa Audio's own content area. A child window
    // carries no decorations and no taskbar or alt-tab entry, so it reads as
    // part of the app rather than a second window.
    //
    // The consequence, and the reason the deck sits beneath the picture rather
    // than over it: a native child surface is composited above the page, so
    // HTML cannot be drawn on top of it. Controls overlaying the video would
    // need a second, transparent window — which is the thing being avoided.
    //
    // If no window id can be obtained, mpv opens its own window instead. That
    // is a fallback, not a choice.
    const wid = _videoWid()
    if (wid) _showVideoWindow()
    else console.warn('[papa-video] no X11 window id — mpv will open its own window')
    // Every async callback below is stamped with the play that created it, so
    // a torrent that becomes ready after the user already started something
    // else cannot hijack the engine or overwrite the newer status.
    const token = ++_videoSession.token
    const current = () => _videoSession.token === token
    const fail = e => { if (current()) safeSend('video-event', { kind: 'error', message: (e && e.message) || String(e) }) }
    const started = url => {
      if (!current()) return
      safeSend('video-event', { kind: 'playing' })
      _probePlayingAudio(url, current)
    }

    if (result.kind === 'torrent') {
      if (!result.magnet) return { ok: false, error: 'This source has no magnet link' }
      // Spin mpv up NOW, in parallel with connecting the torrent, rather than
      // waiting for the first playable bytes to start the process. mpv spawns
      // idle (--idle=yes) with no file, so it can connect its IPC socket, open
      // its window into the wid and be ready to accept a loadfile while the
      // swarm is still finding peers — which under Electron is the slow part,
      // routinely ten seconds. When the stream is ready we only `load()` the
      // URL into the already-running mpv instead of paying the spawn cost then.
      //
      // The window has already been shown against a known rectangle above, so
      // this changes nothing about the bounds-before-show contract: it only
      // moves the process spawn earlier in the same handler.
      const spinUp = videoEngine().start(undefined, { wid }).catch(e => { fail(e); throw e })
      _startTorrentStream(result, {
        current, fail,
        onReady: (url, streamer) => {
          // Wait for the parallel spin-up to finish, then load into the running
          // mpv. If the spin-up raced ahead and already failed, fail() has
          // fired and there is nothing left to load into.
          spinUp.then(() => {
            // A rapid double-play can make a newer engine current while this
            // older ready is still queued behind the spin-up. Re-check the play
            // token immediately before load() so the old URL is never loaded
            // into the newer engine — mirrors video-switch-stream's post-load
            // guard.
            if (!current()) return
            return videoEngine().load(url)
          }).then(() => {
            if (!current()) return
            started(url)
            // A season pack already contains every episode. Telling the UI what
            // is in it turns episode switching into a file change on a torrent
            // that is already running — same peers, no new resolve, no wait.
            try {
              const files = streamer.files()
              if (files.length > 1) safeSend('video-event', { kind: 'pack', files })
            } catch (_) { /* the pack list is a convenience, never required */ }
          }).catch(fail)
        },
      })
    } else {
      if (!result.url) return { ok: false, error: 'This source has no playable URL' }
      videoEngine().start(result.url, { wid }).then(() => started(result.url)).catch(fail)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// Trailers reuse the YouTube resolver the music side already has: the id
// becomes a direct googlevideo URL, which mpv plays like any other stream. No
// embedded webview, no CSP exception, and it inherits the hardware decoding
// and audio configuration the main player uses.
//
// Deliberately a separate handler from video-play: a trailer must never touch
// watch state, be marked watched, or count as the thing you were watching.
ipcMain.handle('video-trailer', async (_, { youtubeId, title } = {}) => {
  try {
    if (!youtubeId) return { ok: false, error: 'No trailer available' }
    _videoTeardown()
    _wireVideoEngine()
    if (player) { try { player.pause().catch(() => {}) } catch (_) {} }
    const token = ++_videoSession.token
    const url = await resolveYtUrl(youtubeId, 'video')
    if (!url) return { ok: false, error: 'Could not load this trailer' }
    if (_videoSession.token !== token) return { ok: true, cancelled: true }
    await videoEngine().start(url, { wid: null })
    if (_videoSession.token === token) safeSend('video-event', { kind: 'playing', trailer: true })
    return { ok: true, title: title || null }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// The URL of a title's trailer, and nothing else.
//
// video-trailer above deliberately takes over the player: pressing Trailer on a
// detail page is a decision to watch it. A hover preview is not that decision,
// so this channel resolves and returns a URL and never touches the engine, the
// session token, or whatever is currently playing.
//
// Both halves are cached — _videoShowDetail by the detail cache, resolveYtUrl by
// the TTL cache — so a second hover over the same card costs nothing. The first
// one can take seconds, because yt-dlp does; the renderer treats a slow answer
// as "not yet" rather than waiting on it.
ipcMain.handle('video-trailer-url', async (_, { type, id } = {}) => {
  try {
    if (!type || id == null) return { ok: false, error: 'Nothing to preview' }
    // The trailer list comes from TMDB's own detail response, so a preview must
    // not go through _videoShowDetail: that also calls OMDb, and OMDb's free
    // tier is a thousand requests a day. Hovering across a rail of twenty cards
    // would have spent twenty of them on a number nobody asked to see.
    //
    // A warm detail cache is used when there is one — it is the same object and
    // costs nothing — and otherwise this asks TMDB directly and caches nothing,
    // so an unenriched detail can never end up in the cache the real detail
    // page reads.
    let detail = _videoDetailCache.get(`${type}:${id}`)
    if (!detail) {
      if (type === 'anime') return { ok: true, url: null }
      detail = await tmdb().detail(type === 'tv' ? 'tv' : 'movie', id)
    }
    if (!detail) return { ok: true, url: null }
    const list = Array.isArray(detail.trailers) ? detail.trailers : []
    let key = null
    for (const t of list) {
      if (t && t.key && (!t.site || t.site === 'YouTube')) { key = t.key; break }
    }
    if (!key && detail.trailer && detail.trailer.id &&
        String(detail.trailer.site || '').toLowerCase() === 'youtube') {
      key = detail.trailer.id
    }
    // No trailer is a real answer, not a failure — most older films have none.
    if (!key) return { ok: true, url: null }
    const url = await resolveYtUrl(key, 'video')
    return { ok: true, url: url || null }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Switch to another episode inside the pack already streaming.
ipcMain.handle('video-pack-select', async (_, { index } = {}) => {
  try {
    const streamer = _videoSession.streamer
    if (!streamer) return { ok: false, error: 'Nothing is streaming' }
    const url = streamer.selectFile(Number(index))
    if (!url) return { ok: false, error: 'That episode is not in this release' }
    await videoEngine().load(url)
    safeSend('video-event', { kind: 'playing' })
    return { ok: true, url, files: streamer.files() }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Swap the source under a playing title without losing the viewer's place —
// the mid-play "try a different source/quality" case (§player 26). The picture
// is the same film; only where the bytes come from changes. So mpv is kept
// alive across the swap and only the torrent streamer is replaced: the new
// stream is started, and once it produces a URL the running mpv is pointed at
// it and seeked straight back to where the viewer was.
//
// Position is read from the live engine state BEFORE the teardown, because the
// point of the swap is not to lose it. The seek is absolute for the same reason
// _prioritiseStreamAtPlayhead reads mpv's resolved position: it is the one true
// place, not a number computed from the request.
ipcMain.handle('video-switch-stream', async (_, { result } = {}) => {
  try {
    if (!result || typeof result !== 'object') return { ok: false, error: 'No source selected' }
    if (result.kind !== 'torrent') return { ok: false, error: 'Only torrent sources can be switched' }
    if (!result.magnet) return { ok: false, error: 'This source has no magnet link' }

    // Where the viewer is, captured before anything is torn down.
    const state = videoEngine().state
    const resumeAt = Number(state && state.position) || 0

    // Tear down ONLY the streamer — mpv stays alive so the window never blanks
    // and the swap reads as a hiccup, not a restart. Deliberately not
    // _videoTeardown(), which would also stop the engine.
    if (_videoSession.streamer) {
      try { _videoSession.streamer.stop() } catch (_) {}
      _videoSession.streamer = null
    }

    // A fresh play token: a late 'ready' from the OLD streamer must not load
    // itself over the new one, exactly as in video-play.
    const token = ++_videoSession.token
    const current = () => _videoSession.token === token
    const fail = e => { if (current()) safeSend('video-event', { kind: 'error', message: (e && e.message) || String(e) }) }

    _startTorrentStream(result, {
      current, fail,
      onReady: (url, streamer) => {
        // mpv is already running; point it at the new file and seek back.
        videoEngine().load(url).then(async () => {
          if (!current()) return
          // Absolute seek to the saved position. A source with a shorter file
          // (a different cut) would reject the seek; that must not fail the
          // swap, so it is caught.
          if (resumeAt > 0) {
            try { await videoEngine().seek(resumeAt, 'absolute') } catch (_) {}
          }
          // Tell the new swarm where the viewer actually is, so it fetches the
          // bytes around the playhead first instead of the file head.
          _prioritiseStreamAtPlayhead()
          safeSend('video-event', { kind: 'playing' })
          try {
            const files = streamer.files()
            if (files.length > 1) safeSend('video-event', { kind: 'pack', files })
          } catch (_) { /* the pack list is a convenience, never required */ }
        }).catch(fail)
      },
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

ipcMain.handle('video-stop', async () => {
  try {
    _videoSession.token++
    _videoTeardown()
    _closeVideoWindow()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// The HTML stage renders UNDER the native mpv surface, so once video is
// playing, mpv's own OSD is the only place a message is actually visible.
// The stall watchdog in the renderer uses this.
ipcMain.handle('video-osd', async (_, { text, durationMs } = {}) => {
  try {
    await videoEngine().osdMessage(String(text || ''), durationMs)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Live torrent numbers for the theatre's Stats panel. Shaped to the deck's
// contract ({down, peers, progress}), not the streamer's raw field names.
ipcMain.handle('video-stream-stats', async () => {
  try {
    const s = _videoSession.streamer && _videoSession.streamer.stats()
    if (!s) return { ok: false }
    return { ok: true, down: s.speedBps || 0, peers: s.peers || 0, progress: s.progress || 0 }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Pull a whole file down in the background while the current episode plays
// (App #40). The pieces arrive at the lowest priority, so this only ever uses
// bandwidth that was going spare; the episode being watched keeps every peer it
// wants. One file at a time — a second call for a different index supersedes
// the first inside the streamer.
ipcMain.handle('video-predownload', async (_, { index } = {}) => {
  try {
    const streamer = _videoSession.streamer
    if (!streamer) return { ok: false, error: 'Nothing is streaming' }
    const ok = streamer.predownloadFile(Number(index))
    return { ok: !!ok }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Withdraw the standing whole-file request. Pieces already on disk stay — they
// cost nothing to keep — only the request for the rest is dropped.
ipcMain.handle('video-predownload-cancel', async () => {
  try {
    const streamer = _videoSession.streamer
    if (!streamer) return { ok: false, error: 'Nothing is streaming' }
    const cancelled = streamer.cancelPredownload()
    return { ok: true, cancelled: !!cancelled }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// How far the whole-file predownload has got: { index, bytes, total }, or null
// when nothing is predownloading. For a progress bar on the offline-download UI.
ipcMain.handle('video-predownload-progress', async () => {
  try {
    const streamer = _videoSession.streamer
    const progress = streamer ? streamer.predownloadProgress() : null
    return { ok: true, progress: progress || null }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), progress: null }
  }
})

// Keep this episode (App #44). Copies a fully-downloaded file out of the
// throwaway stream cache into ~/Videos/Papa Audio/<Show>/<file>, where it
// survives the session and the cache cleanup. Dialog-free: the destination is
// derived from the show title and filename (both sanitized in video-keep.js so
// remote metadata can never climb out of the folder). Refuses an incomplete
// file with a plain message rather than saving a half-episode. No progress
// stream — a local copy of a few GB is fast and the renderer just waits on the
// promise, then toasts the path.
ipcMain.handle('video-keep-file', async (_, { index, show } = {}) => {
  try {
    const streamer = _videoSession.streamer
    if (!streamer || typeof streamer.fileInfo !== 'function') {
      return { ok: false, error: 'Nothing is streaming to keep' }
    }
    const info = streamer.fileInfo(Number(index))
    if (!info || !info.path) return { ok: false, error: 'That episode is not on disk yet' }
    if (!videoKeep.isComplete({ bytes: info.downloaded, total: info.total })) {
      return { ok: false, error: 'This episode has not finished downloading yet' }
    }
    if (!fs.existsSync(info.path)) {
      return { ok: false, error: 'The downloaded file could not be found' }
    }
    const dest = videoKeep.destPath(_keepVideosRoot(), show, info.name)
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }) } catch (e) {
      return { ok: false, error: 'Could not create the Videos folder: ' + ((e && e.message) || e) }
    }
    // copyFile replaces any earlier keep of the same episode rather than
    // erroring — re-keeping is a no-op the user should not have to think about.
    await fs.promises.copyFile(info.path, dest)
    return { ok: true, path: dest }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Where kept episodes live: ~/Videos/Papa Audio, mirroring the screenshot
// folder's shape (App #48). Falls back to USER_DATA/Videos when the OS videos
// path cannot be resolved, so a headless or locked-down box still has a home.
function _keepVideosRoot() {
  try {
    return path.join(app.getPath('videos'), 'Papa Audio')
  } catch (_) {
    return path.join(USER_DATA, 'Videos')
  }
}

// One health snapshot for the diagnostics page (App §2-12). Each probe is
// independent and self-contained: a failure in any one is caught and reported
// as `false` (or an empty list) rather than allowed to sink the whole call.
// This function never throws. Factored out into _collectDiagnostics so the bug
// reporter (App §97) can bundle the same snapshot without a renderer round-trip;
// the handler is a thin delegate to it (kept adjacent so both read as one unit).
ipcMain.handle('video-diagnostics', () => _collectDiagnostics())

async function _collectDiagnostics() {
  // slskd: the Soulseek daemon reports itself logged in. Reuses the same
  // /application probe slsk-status uses, so this agrees with that surface.
  const probeSlskd = (async () => {
    try {
      const data = await slskdFetch('GET', '/application')
      return data?.server?.isLoggedIn ?? false
    } catch (_) { return false }
  })()

  // tmdb: a key is set AND TMDB answers. A key that is present but rejected is
  // worse than none, so this actually reaches out — with a hard 5 s ceiling so
  // a hung network never wedges the diagnostics page.
  const probeTmdb = (async () => {
    try {
      const key = _videoSettings().tmdbApiKey || process.env.TMDB_API_KEY
      if (!key) return false
      const res = await fetch(
        `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(5000) })
      return !!(res && res.ok)
    } catch (_) { return false }
  })()

  // mpv: the binary is on PATH. `mpv --version` exits 0 when it is; anything
  // else (ENOENT, non-zero) reads as not installed.
  const probeMpv = new Promise(resolve => {
    try {
      execFile('mpv', ['--version'], { timeout: 5000 }, err => resolve(!err))
    } catch (_) { resolve(false) }
  })

  // storeBridge: the crash-proof video watch store is readable. get() returns
  // the raw blob (or the null fallback) without throwing; a throw here means
  // the side file is unreadable, which is the thing worth surfacing.
  const probeStoreBridge = (() => {
    try {
      sideStores.videoStore.get()
      return true
    } catch (_) { return false }
  })()

  // sources: the per-source health record, if providers/index.js exposes one.
  // It keeps a private streak map (checklist #39) but does not export a
  // {name, healthy} view, so this stays defensive: use an export if a future
  // version adds one, otherwise report an empty list rather than inventing data.
  const probeSources = (() => {
    try {
      const providers = require('./providers/index')
      const fn = providers.sourceHealth || providers.getSourceHealth
      if (typeof fn !== 'function') return []
      const list = fn()
      if (!Array.isArray(list)) return []
      return list
        .filter(s => s && s.name)
        .map(s => ({ name: String(s.name), healthy: s.healthy !== false }))
    } catch (_) { return [] }
  })()

  const [slskd, tmdb, mpv] = await Promise.all([probeSlskd, probeTmdb, probeMpv])
  return {
    ok: true,
    slskd,
    tmdb,
    mpv,
    storeBridge: probeStoreBridge,
    sources: probeSources,
  }
}

// ── Backup: export / import everything (App §2-12, the foundation page) ───────
// Anything with a value under a key whose NAME contains one of these is a
// secret the user should not be handing around in a plaintext backup. Redacted
// on export rather than dropped, so the shape survives and the user can see
// that a value was there without the value itself leaving the machine.
const _SECRET_KEY_RE = /password|token|key/i
const _REDACTED = '__redacted__'

function _redactSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = Array.isArray(obj) ? [] : {}
  for (const [k, v] of Object.entries(obj)) {
    if (_SECRET_KEY_RE.test(k)) out[k] = _REDACTED
    else if (v && typeof v === 'object') out[k] = _redactSecrets(v)
    else out[k] = v
  }
  return out
}

// The one bundling routine, shared by the manual export handler and the
// automatic startup backup below. It reads every SideStore by its own map key —
// so both paths stay in step with the map with no second list to keep aligned —
// and it never throws: a failed read of any one store leaves its slot null
// rather than sinking the whole bundle.
//
// STORE_SCHEMA_VERSION is the contract number for this bundle's shape. It rides
// on both the JSON payload and the on-disk marker file (see below). Bump it only
// when the SHAPE of a store's contents changes in a way a future build would
// need to migrate; adding or removing a store from the map does not count,
// because import already skips names it does not recognise. There are no
// migrations yet — this is the scaffolding so a future one has a number to key
// off, and so a bundle written by a newer build can be recognised as newer.
const STORE_SCHEMA_VERSION = 1

// The on-disk marker for App §96. Writes STORE_SCHEMA_VERSION to
// USER_DATA/store-schema-version if absent, and shouts if the file holds a
// FUTURE number (this data was written by a newer build — a downgrade). The
// contract: bump STORE_SCHEMA_VERSION when a store's contents SHAPE changes in a
// way a future build would migrate, add the migration keyed off the old number,
// then bump the marker. For now there are no migrations, only the number.
function checkStoreSchemaVersion() {
  const marker = path.join(USER_DATA, 'store-schema-version')
  let onDisk = null
  try {
    if (fs.existsSync(marker)) {
      onDisk = parseInt(fs.readFileSync(marker, 'utf8').trim(), 10)
      if (!Number.isFinite(onDisk)) onDisk = null
    }
  } catch (_) { onDisk = null }

  if (onDisk == null) {
    // No marker (a fresh profile, or one predating this feature): stamp the
    // current version so future launches have a baseline to compare against.
    try { fs.writeFileSync(marker, String(STORE_SCHEMA_VERSION), 'utf8') } catch (_) { /* read-only is not fatal */ }
    return
  }

  if (onDisk > STORE_SCHEMA_VERSION) {
    // Loud on purpose. A newer build wrote this profile; running an older one
    // against it risks quietly mis-reading a store whose shape has moved on.
    console.error(
      `[papa][schema] ⚠ this profile was last written by a NEWER build ` +
      `(store schema v${onDisk}), and this build only understands v${STORE_SCHEMA_VERSION}. ` +
      `No migrations run downward — if anything looks wrong, update Papa Audio to the newest version.`)
    return
  }

  if (onDisk < STORE_SCHEMA_VERSION) {
    // An upgrade. No migrations exist yet, so there is nothing to run; just move
    // the marker forward so the state is truthful.
    try { fs.writeFileSync(marker, String(STORE_SCHEMA_VERSION), 'utf8') } catch (_) { /* read-only is not fatal */ }
  }
}

function _collectBackupStores() {
  const stores = {}
  for (const [name, side] of Object.entries(sideStores)) {
    try { stores[name] = side.get() } catch (_) { stores[name] = null }
  }
  return stores
}

function _buildBackupPayload() {
  // electron-store's full settings object, secrets stripped.
  let settings = {}
  try { settings = _redactSecrets(store.store || {}) } catch (_) { settings = {} }
  return {
    papaBackup: 1,
    schemaVersion: STORE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    stores: _collectBackupStores(),
    settings,
  }
}

// The whole state of the app in one JSON file: every SideStore by its own name,
// plus the electron-store settings with secrets redacted. Written to a path the
// user picks.
ipcMain.handle('papa-export-all', async () => {
  try {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Papa Audio backup',
      defaultPath: `papa-audio-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true }

    fs.writeFileSync(r.filePath, JSON.stringify(_buildBackupPayload(), null, 2), 'utf8')
    return { ok: true, path: r.filePath }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Run a scheduled-style backup to ~/Documents/PapaAudioBackups/ right now, on
// demand (App #23). No dialog — it writes to the fixed folder, rotates, records
// lastBackupAt, and returns where it landed.
ipcMain.handle('papa-backup-now', async () => {
  try {
    const r = _runScheduledBackup()
    store.set('lastBackupAt', Date.now())
    return { ok: true, path: r.path, kept: r.kept }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// The scheduled-backup status for the Settings surface (App #23): the configured
// interval, when the last backup ran, whether one is currently due, the folder,
// and the dated files on disk (newest first).
ipcMain.handle('papa-backup-status', () => {
  const intervalDays = store.get('backupIntervalDays', 0)
  const lastBackupAt = store.get('lastBackupAt', 0)
  const dir = _scheduledBackupDir()
  let files = []
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /^papa-backup-.*\.json$/.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse() // newest first
  } catch (_) { files = [] }
  return {
    intervalDays,
    lastBackupAt: lastBackupAt || null,
    due: backupSchedule.isBackupDue({ intervalDays, lastBackupAt, now: Date.now() }),
    dir,
    files,
    keep: backupSchedule.KEEP,
  }
})

// ── Bug reporter (App §97) ──────────────────────────────────────────────────
// Everything a maintainer needs to diagnose a problem, gathered into one folder
// the user can zip and send: the tail of the newest log, the crash log if there
// is one, a health snapshot, version/platform info, and a redacted settings
// dump. Every gather step is best-effort — a missing log or an unreadable store
// leaves its own file with a "could not read" note rather than sinking the whole
// report. Reuses the redaction (_redactSecrets) and diagnostics
// (_collectDiagnostics) helpers so the report never diverges from what the
// export and the diagnostics page produce. No dialog is opened — this reveals
// the finished folder with shell.showItemInFolder, which is neither a dialog nor
// a BrowserWindow, so no IPC timeout override is needed.

// The last `n` lines of a text file, or null if it cannot be read. Reads the
// whole file (logs are day-scoped and size-capped elsewhere) then keeps the
// tail — simpler than a reverse-seek and the inputs here are small.
function _tailLines(file, n) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    return lines.slice(Math.max(0, lines.length - n)).join('\n')
  } catch (_) { return null }
}

// The newest papa-<date>.log in the logs directory, by mtime. The day-stamped
// name is local-day based (see localDayStamp), so "today's" file is normally
// newest, but mtime is what actually decides — a clock change or a rotated
// .1 never picks the wrong one.
function _newestLogFile() {
  try {
    const dir = path.join(USER_DATA, 'logs')
    const entries = fs.readdirSync(dir)
      .filter(f => /^papa-.*\.log$/.test(f))
      .map(f => {
        const p = path.join(dir, f)
        let mtime = 0
        try { mtime = fs.statSync(p).mtimeMs } catch (_) { mtime = 0 }
        return { p, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    return entries.length ? entries[0].p : null
  } catch (_) { return null }
}

ipcMain.handle('papa-bug-report', async () => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const root = path.join(USER_DATA, 'bug-reports', `report-${stamp}`)
    fs.mkdirSync(root, { recursive: true })

    // 1. The tail of the newest app log.
    const newestLog = _newestLogFile()
    const logTail = newestLog ? _tailLines(newestLog, 200) : null
    try {
      fs.writeFileSync(
        path.join(root, 'log-tail.txt'),
        logTail != null
          ? `Last 200 lines of ${path.basename(newestLog)}:\n\n${logTail}\n`
          : 'No app log was found to include.\n',
        'utf8')
    } catch (_) { /* best-effort */ }

    // 2. The crash log, if one exists.
    const crashLog = path.join(USER_DATA, 'crash-log.txt')
    try {
      if (fs.existsSync(crashLog)) {
        fs.copyFileSync(crashLog, path.join(root, 'crash-log.txt'))
      }
    } catch (_) { /* best-effort */ }

    // 3. The diagnostics snapshot — the same one the Diagnostics page shows.
    let diagnostics = null
    try { diagnostics = await _collectDiagnostics() } catch (_) { diagnostics = null }
    try {
      fs.writeFileSync(
        path.join(root, 'diagnostics.json'),
        JSON.stringify(diagnostics || { ok: false, error: 'diagnostics could not be gathered' }, null, 2),
        'utf8')
    } catch (_) { /* best-effort */ }

    // 4. App version + platform info.
    let version = ''
    try { version = require('./package.json').version || '' } catch (_) { version = '' }
    const about = {
      appVersion: version,
      electron: process.versions.electron || null,
      chrome: process.versions.chrome || null,
      node: process.versions.node || null,
      platform: process.platform,
      arch: process.arch,
      osRelease: (() => { try { return require('os').release() } catch (_) { return null } })(),
      generatedAt: new Date().toISOString(),
    }
    try {
      fs.writeFileSync(path.join(root, 'about.json'), JSON.stringify(about, null, 2), 'utf8')
    } catch (_) { /* best-effort */ }

    // 5. A redacted settings dump — the same redaction the backup export uses,
    // so no password, token or key leaves the machine.
    let settings = {}
    try { settings = _redactSecrets(store.store || {}) } catch (_) { settings = {} }
    try {
      fs.writeFileSync(path.join(root, 'settings-redacted.json'), JSON.stringify(settings, null, 2), 'utf8')
    } catch (_) { /* best-effort */ }

    // A plain-English README so the user knows what they are sending.
    const readme =
      `Papa Audio bug report\n` +
      `Generated: ${about.generatedAt}\n\n` +
      `This folder contains what a developer needs to look into a problem:\n\n` +
      `  log-tail.txt          The last 200 lines of the newest app log.\n` +
      `  crash-log.txt         Any crashes that were recorded (only if present).\n` +
      `  diagnostics.json      A quick health check (Soulseek, TMDB, mpv, storage).\n` +
      `  about.json            The app version and your platform details.\n` +
      `  settings-redacted.json  Your settings with all passwords and keys removed.\n\n` +
      `None of these files contain your passwords or API keys — those are removed\n` +
      `before anything is written. You can safely zip this folder and send it in.\n`
    try {
      fs.writeFileSync(path.join(root, 'README.txt'), readme, 'utf8')
    } catch (_) { /* best-effort */ }

    // Reveal the finished folder. Not a dialog and not a BrowserWindow, so this
    // handler needs no IPC timeout override.
    try { shell.showItemInFolder(root) } catch (_) { /* the path is returned regardless */ }

    return { ok: true, path: root }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// The user-facing changelog (App §7). The prose lives in docs/CHANGELOG-APP.md
// so it can be edited without touching code; this handler just reads it and
// stamps the app version alongside it. No dialog, so no timeout override needed.
ipcMain.handle('app-changelog', async () => {
  try {
    let version = ''
    try { version = require('./package.json').version || '' } catch (_) { version = '' }
    let markdown = ''
    try {
      markdown = fs.readFileSync(path.join(__dirname, 'docs', 'CHANGELOG-APP.md'), 'utf8')
    } catch (_) {
      return { ok: false, error: 'The changelog could not be read', version }
    }
    return { ok: true, markdown, version }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Restore a backup file. The user's current data is never overwritten blind:
// before writing any store back, its present value is snapshotted to a
// timestamped .bak beside it, so a bad import is always recoverable. Only the
// `stores` are written back — the redacted settings blob is deliberately not
// restored, since it would clobber real keys with the redaction marker.
ipcMain.handle('papa-import-all', async (_, { path: givenPath } = {}) => {
  try {
    let filePath = givenPath
    if (!filePath) {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: 'Import Papa Audio backup',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true }
      filePath = r.filePaths[0]
    }

    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (_) {
      return { ok: false, error: 'That file is not a readable Papa Audio backup' }
    }
    // Shape validation: a backup this handler wrote carries the marker and a
    // stores object. Anything else is refused rather than half-applied.
    if (!parsed || typeof parsed !== 'object' || parsed.papaBackup == null ||
        !parsed.stores || typeof parsed.stores !== 'object') {
      return { ok: false, error: 'That file is not a Papa Audio backup' }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const imported = []
    for (const [name, value] of Object.entries(parsed.stores)) {
      const side = sideStores[name]
      // A backup can name a store this build no longer has; skip it rather than
      // fail the whole restore.
      if (!side) continue
      // Snapshot the CURRENT value to a timestamped .bak before overwriting, so
      // a mistaken import is always undoable.
      try {
        const current = side.get()
        const bak = path.join(USER_DATA, `${name}.${stamp}.bak`)
        fs.writeFileSync(bak, JSON.stringify(current), 'utf8')
      } catch (_) { /* the backup of the backup is best-effort */ }
      try {
        side.set(value)
        imported.push(name)
      } catch (_) { /* one store failing must not fail the rest */ }
    }
    return { ok: true, imported }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Subtitle files travelling inside the torrent, which the video-only file
// list deliberately hides. Listed here, fetched on demand below.
ipcMain.handle('video-subs-in-torrent', async () => {
  try {
    const streamer = _videoSession.streamer
    const subs = streamer ? streamer.subtitleFiles() : []
    return { ok: true, subs: subs.map(f => ({ index: f.index, name: f.name })) }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), subs: [] }
  }
})

ipcMain.handle('video-sub-serve', async (_, { index } = {}) => {
  try {
    const streamer = _videoSession.streamer
    if (!streamer) return { ok: false, error: 'Nothing is streaming' }
    const path = await streamer.serveSubtitle(Number(index))
    return { ok: true, path }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// Online subtitle search for the CC menu (§player 21), for anything the release
// itself did not carry. The module does the normalising and never throws; the
// only thing to add here is the search parameters and the `needsKey` marker it
// hands back when no OpenSubtitles key is set, so the UI can say "add a key in
// Settings" rather than "no subtitles found".
ipcMain.handle('video-sub-search', async (_, params = {}) => {
  try {
    const results = await opensubs().search(params || {})
    // The empty list carries `needsKey` as an own property; forward it so the
    // renderer can tell "no key" apart from "genuinely nothing found".
    return { ok: true, results, needsKey: results.needsKey === true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), results: [] }
  }
})

// Mint the download URL for a chosen subtitle and pull it down to a temp file,
// ready to hand straight to videoControl('subAdd'). Downloaded under the stream
// cache dir — the same disk the torrent cache uses, chosen in Settings to keep
// this off a tmpfs — and swept with the rest of the stream cache, so nothing is
// left behind. The minted link counts against the key's daily quota, so this is
// only ever called for the one subtitle the viewer actually picked.
ipcMain.handle('video-sub-download', async (_, { fileId } = {}) => {
  try {
    if (fileId == null || fileId === '') return { ok: false, error: 'No subtitle selected' }
    const minted = await opensubs().download(fileId)
    if (minted.needsKey) {
      return { ok: false, error: 'Add an OpenSubtitles key in Settings → Video to download subtitles.', needsKey: true }
    }
    if (!minted.url) return { ok: false, error: 'Could not fetch that subtitle' }

    const dir = path.join(streamRoot(), 'external-subs')
    fs.mkdirSync(dir, { recursive: true })
    // A stable-ish name keyed on the file id, so re-picking the same subtitle
    // reuses the file rather than filling the cache with copies. The suffix is
    // .srt because OpenSubtitles serves SubRip; mpv sniffs the content anyway.
    const dest = path.join(dir, `opensubtitles-${String(fileId).replace(/[^\w.-]+/g, '_')}.srt`)

    const res = await fetchWithTimeout(20000)(minted.url)
    if (!res || !res.ok) return { ok: false, error: 'The subtitle download failed' }
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(dest, buf)
    return { ok: true, path: dest }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// The theatre control deck. One channel for every verb (§4.1), so the overlay
// does not need to know how a verb reaches mpv — only that it did.
ipcMain.handle('video-control', async (_, { verb, args } = {}) => {
  try {
    const engine = videoEngine()
    switch (verb) {
      case 'seek':
        await engine.seek(args?.seconds, args?.mode || 'relative')
        _prioritiseStreamAtPlayhead()
        break
      case 'pause': await engine.setPause(args?.paused !== false); break
      case 'play': await engine.setPause(false); break
      // These take a single argument, and the player sends it as `value` for
      // all of them. Reading a different name per verb meant every one of
      // these arrived as undefined: the volume slider, the mute button, the
      // speed menu, the zoom and the night-mode filter all did nothing at all,
      // while play, pause and seek — which happened to agree on their names —
      // worked. The older names are still accepted so nothing that predates
      // this breaks.
      case 'volume': await engine.setVolume(args?.value ?? args?.volume); break
      case 'mute': await engine.setMute(!!(args?.value ?? args?.muted)); break
      case 'speed': await engine.setSpeed(args?.value ?? args?.speed); break
      case 'track': await engine.setTrack(args?.type, args?.id); break
      case 'subAdd': await engine.addSubtitle(args?.path, args?.select !== false); break
      // Milliseconds. The player sent `seconds` while this read `ms`, so both
      // nudges resolved to NaN and did nothing at all.
      case 'subDelay': await engine.setSubDelay(args?.value ?? args?.ms); break
      case 'audioDelay': await engine.setAudioDelay(args?.value ?? args?.ms); break
      case 'subStyle': await engine.setSubStyle(args); break
      case 'aspect': await engine.setAspect(args?.value ?? args?.aspect); break
      case 'zoom': await engine.setZoom(args?.value ?? args?.zoom); break
      case 'audioFilter': await engine.setAudioFilter(args?.value ?? args?.af); break
      case 'screenshot': {
        const filePath = _videoScreenshotPath()
        await engine.screenshot(filePath)
        return { ok: true, value: { path: filePath } }
      }
      case 'frameStep': await engine.frameStep(args?.frames ?? args?.dir); break
      case 'stop':
        _videoSession.token++
        _videoTeardown()
        _closeVideoWindow()
        break
      default:
        return { ok: false, error: `Unknown video verb: ${verb}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

ipcMain.handle('video-tracks', async () => {
  try {
    const tracks = await videoEngine().getTracks()
    return { ok: true, tracks }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), tracks: [] }
  }
})

// Loading a subtitle file the release did not ship with. mpv can do this and
// the engine already exposed it; nothing ever offered it, so a torrent with no
// subtitles or the wrong language was a dead end.
ipcMain.handle('video-sub-open', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add a subtitle file',
      properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: ['srt', 'ass', 'ssa', 'sub', 'vtt', 'idx'] }],
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
    await videoEngine().addSubtitle(result.filePaths[0], true)
    return { ok: true, path: result.filePaths[0] }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

// What a card needs beyond what a shelf listing gives it. The catalogue's list
// endpoints return a title, a year, a poster and a score and nothing else, so
// director, runtime, certificate and the outside ratings each cost a request —
// which is why the renderer only asks for what is actually on screen.
//
// Deliberately narrow: a card does not need the overview, the cast, the
// keywords or the artwork, and sending them would make every one of these
// twenty times larger than it has to be.
ipcMain.handle('video-enrich', async (_, { type, id } = {}) => {
  try {
    if (!type || id == null) return { ok: false, error: 'type and id are required' }
    const detail = await _videoShowDetail(type, id)
    if (!detail) return { ok: false, error: 'Not found' }
    const ext = detail.external || {}
    return {
      ok: true,
      meta: {
        // Names, not credit records. The catalogue returns each director as an
        // object with an id, a job and a portrait; a card wants two words.
        directors: (Array.isArray(detail.directors) ? detail.directors : [])
          .map(d => (typeof d === 'string' ? d : d && d.name))
          .filter(Boolean)
          .slice(0, 2),
        runtime: detail.runtime || null,
        certification: detail.certification || ext.rated || null,
        // Genre names, for the chips a card grows in its credit area. The
        // renderer renders these only when present, so this is additive.
        genres: (Array.isArray(detail.genres) ? detail.genres : [])
          .map(g => (typeof g === 'string' ? g : g && g.name))
          .filter(Boolean)
          .slice(0, 3),
        imdb: ext.imdbRating != null ? ext.imdbRating : null,
        rottenTomatoes: ext.rottenTomatoes != null ? ext.rottenTomatoes : null,
        metacritic: ext.metascore != null ? ext.metascore : null,
        // The single strongest signal on a card, and it fits in a badge.
        oscars: ext.awards ? ext.awards.oscars : 0,
        wins: ext.awards ? ext.awards.wins : 0,
      },
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
})

ipcMain.handle('video-chapters', async () => {
  try {
    const chapters = await videoEngine().getChapters()
    return { ok: true, chapters }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), chapters: [] }
  }
})

const aniskip = _lazy(() => createAniSkip({ fetchFn: fetchWithTimeout(10000) }))
// AniSkip answers are crowd-sourced and effectively static for a given
// episode, so a week is a safe TTL. Cached per (malId, episode) — never per
// playback — so a rewatch costs nothing.
const _aniskipCache = makeCache({ cap: 500, ttlMs: 1000 * 60 * 60 * 24 * 7 })

// Skip segments (intro / recap / credits), merged across the layers in §9 of
// the plan. Higher-confidence sources win an overlap, so a chapter marker or a
// manual correction always beats the tail-of-file credits guess.
//
// Layers 1, 2 and 4 run here and are cheap. Layer 3 (cross-episode audio
// correlation) needs a second episode to compare against and is minutes of
// ffmpeg work, so it never runs inline — see video-detect-intro.
ipcMain.handle('video-skip-segments', async (_, req) => {
  try {
    req = req || {}
    const duration = Number(req.duration) || 0
    const sources = []

    // Layer 1 — chapters baked into the file. Free, instant, highest
    // confidence when the release ships named chapters.
    try {
      const chapters = await videoEngine().getChapters()
      sources.push(classifyChapters(chapters, { duration }))
    } catch (_) { /* no chapters is the common case, not an error */ }

    // Layer 2 — AniSkip, exact OP/ED intervals for anime.
    const malId = Number(req.malId) || 0
    const episode = Number(req.episode) || 0
    if (req.type === 'anime' && malId && episode) {
      const key = `${malId}:${episode}`
      let segs = _aniskipCache.get(key)
      if (!segs) {
        segs = await aniskip()({ malId, episode, episodeLength: Math.round(duration) })
        // Only a real answer is cached; an empty list is usually AniSkip being
        // briefly unreachable, and caching it would hide the segments for a week.
        if (segs.length) _aniskipCache.set(key, segs)
      }
      sources.push(segs)
    }

    // Layer 4 — the user's own corrections, and the tail-of-file credits guess.
    // Manual segments come from the renderer because the watch store lives
    // there; they carry the highest priority in the merge.
    if (Array.isArray(req.manual) && req.manual.length) sources.push(req.manual)
    const fallback = creditsFallback(duration)
    if (fallback) sources.push([fallback])

    return { ok: true, segments: mergeSegments(sources) }
  } catch (e) {
    // A skip service must never be able to stop playback.
    return { ok: false, error: (e && e.message) || String(e), segments: [] }
  }
})

// Layer 3 — cross-episode audio correlation, for series with neither chapters
// nor an AniSkip entry. Deliberately a separate call: it decodes five minutes
// of two episodes with ffmpeg, so it is background work the UI fires and
// forgets, never something playback waits on. One run at a time; a new request
// cancels the one in flight.
let _introDetectAbort = null
ipcMain.handle('video-detect-intro', async (_, req) => {
  try {
    req = req || {}
    if (!req.currentUrl || !req.referenceUrl) return { ok: true, segment: null }
    if (_introDetectAbort) { try { _introDetectAbort.abort() } catch (_) {} }
    const controller = new AbortController()
    _introDetectAbort = controller
    const segment = await detectIntro({
      currentUrl: req.currentUrl,
      referenceUrl: req.referenceUrl,
      execFn: execFile,
      signal: controller.signal,
    })
    if (_introDetectAbort === controller) _introDetectAbort = null
    return { ok: true, segment: segment || null }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), segment: null }
  }
})

// Screenshots land in a per-app folder rather than mpv's cwd, so the file is
// findable from the settings gear. The timestamp keeps one from clobbering the
// next on the same second.
function _videoScreenshotPath() {
  // Screenshots belong where a person looks for them, not buried in the config
  // directory (App #48): the pictures folder, in a "Papa Audio" subfolder so a
  // burst of them does not litter the top level. If the pictures path cannot be
  // resolved or made — a headless box, a locked-down home — fall back to
  // USER_DATA/screenshots, which always exists.
  let dir
  try {
    dir = path.join(app.getPath('pictures'), 'Papa Audio')
    fs.mkdirSync(dir, { recursive: true })
  } catch (_) {
    dir = path.join(USER_DATA, 'screenshots')
    try { fs.mkdirSync(dir, { recursive: true }) } catch (_) { /* read-only is not fatal */ }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(dir, `papa-video-${stamp}.png`)
}
