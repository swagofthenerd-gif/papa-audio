const { app, BrowserWindow, BrowserView, ipcMain, dialog, globalShortcut, Notification, shell, Menu, MenuItem, powerSaveBlocker, powerMonitor } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
// Required at the top: album ids are derived during scanning, long before the
// handler section, and `const` is not hoisted.
const tagEdit = require('./src/tag-edit')
const crypto = require('crypto')
const https = require('https')
const { spawn, execSync, execFileSync, execFile } = require('child_process')
const { MpvEngine } = require('./mpv-engine')
const { formatDiagnostic } = require('./engine-diagnostics')
const { defaultSettings: eqDefaults, BANDS: EQ_BANDS, GAIN_LIMIT: EQ_GAIN_LIMIT, PRESETS: EQ_PRESETS, presetSettings } = require('./eq')
const { MpvCrossfade } = require('./mpv-crossfade')
const { linearToMpv } = require('./volume-map')
const ytSearch = require('./youtube-search')
const ytDownloader = require('./youtube-download')
const lyrics = require('./lyrics')

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
  try { await fetch(LASTFM_API_URL, { method: 'POST', body: params }) } catch (_) {}
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
const _ytUrlCache = new Map() // videoId -> { url: string, expiresAt: number }
const YT_URL_TTL = 60 * 60 * 1000 // 1 hour

function resolveYtUrl(videoId) {
  const cached = _ytUrlCache.get(videoId)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.url)
  return new Promise((resolve, reject) => {
    var proc, out = '', err = ''
    var timer = setTimeout(() => { try { proc.kill() } catch (_) {} reject(new Error('yt-dlp timed out')) }, 15000)
    try {
      proc = spawn('yt-dlp', ['-f', 'bestaudio', '-g', '--no-playlist', '--', videoId], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { clearTimeout(timer); reject(e); return }
    proc.stdout.on('data', d => out += d.toString())
    proc.stderr.on('data', d => err = (err + d.toString()).slice(-500))
    proc.on('error', e => { clearTimeout(timer); reject(e) })
    proc.on('close', code => {
      clearTimeout(timer)
      var url = out.trim().split('\n')[0]
      if (code === 0 && url && url.startsWith('http')) {
        _ytUrlCache.set(videoId, { url, expiresAt: Date.now() + YT_URL_TTL })
        if (_ytUrlCache.size > 200) {
          var now = Date.now()
          for (var [k, v] of _ytUrlCache) if (now > v.expiresAt) _ytUrlCache.delete(k)
        }
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
  throw lastErr
}

let natUpnp; try { natUpnp = require('nat-upnp') } catch (_) {}

// Under Node 18+ an unhandled rejection TERMINATES the process by default, and
// this file is full of un-awaited async IPC handlers and network calls
// (youtubei.js, slskd, webtorrent). One rejected promise from a background
// YouTube request would kill the app -- and the music with it -- with nothing
// written down about why. Log it and keep running: a music player dying mid-song
// because a metadata fetch 404'd is never the right trade.
process.on('unhandledRejection', (reason) => {
  console.error('[papa] unhandled rejection:', (reason && reason.stack) || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[papa] uncaught exception:', (err && err.stack) || err)
})

// Strip the automation flag so Cloudflare/bot-checks don't see navigator.webdriver = true
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

// GPU memory optimisations
app.commandLine.appendSwitch('disable-gpu-rasterization')         // CPU rasterise tiles — less VRAM
app.commandLine.appendSwitch('disable-zero-copy')                  // don't DMA textures directly to GPU
app.commandLine.appendSwitch('num-raster-threads', '2')            // was 4 — fewer raster threads
app.commandLine.appendSwitch('renderer-process-limit', '1')        // only one renderer process
app.commandLine.appendSwitch('max-gum-fps', '60')                  // cap getUserMedia fps

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

// ── Stable identity ──────────────────────────────────────────────────────────
app.setName('Papa Audio')
const USER_DATA = path.join(app.getPath('home'), '.config', 'papa-audio')
app.setPath('userData', USER_DATA)

// ── Migrate from old flac-player config ─────────────────────────────────────
const OLD_DATA = path.join(app.getPath('home'), '.config', 'flac-player')
;(function migrate() {
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
    _torrentClient = new WebTorrent()
    _torrentClient.on('error', err => console.error('[WebTorrent]', err.message))
  }
  return _torrentClient
}
function _torrentAdd(uri) {
  const dlDir = store.get('downloadDir', '/mnt/data/MUSIC/Downloads')
  const client = getTorrentClient()
  if (client.get(uri)) return
  client.add(uri, { path: dlDir }, torrent => {
    _activeTorrents.set(torrent.infoHash, { infoHash: torrent.infoHash, name: torrent.name, progress: 0, speed: 0, downloaded: 0, total: torrent.length, eta: 0 })
    mainWindow?.webContents.send('torrent-progress', { infoHash: torrent.infoHash, name: torrent.name, progress: 0, speed: 0, eta: 0 })
    torrent.on('download', () => {
      const snap = { infoHash: torrent.infoHash, name: torrent.name, progress: torrent.progress, speed: torrent.downloadSpeed, downloaded: torrent.downloaded, total: torrent.length, eta: torrent.timeRemaining }
      _activeTorrents.set(torrent.infoHash, snap)
      mainWindow?.webContents.send('torrent-progress', snap)
    })
    torrent.on('done', () => {
      _activeTorrents.delete(torrent.infoHash)
      mainWindow?.webContents.send('torrent-done', { infoHash: torrent.infoHash, name: torrent.name })
      if (Notification.isSupported()) new Notification({ title: 'Torrent complete', body: torrent.name, silent: false }).show()
      for (const delay of [8000, 25000, 60000]) setTimeout(() => mainWindow?.webContents.send('do-lib-rescan'), delay)
    })
  })
}

const store = new Store()

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

function writeSlskdConfig({ username = '', password = '', downloadDir = '/mnt/data/MUSIC/Downloads' } = {}) {
  fs.mkdirSync(SLSKD_DIR, { recursive: true })
  fs.mkdirSync(path.join(SLSKD_DIR, 'incomplete'), { recursive: true })
  fs.mkdirSync(downloadDir, { recursive: true })
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
      body: JSON.stringify(store.get('slskdApiCreds', { username: 'slskd', password: 'slskd' })),
    })
    if (!res.ok) return false
    const data = await res.json()
    slskdToken = data.token
    // expires is Unix epoch seconds; refresh 5 minutes early
    slskdTokenExpiry = (data.expires * 1000) - 5 * 60 * 1000
    return true
  } catch (_) { return false }
}

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
  if (!res.ok && res.status !== 204) throw new Error(`slskd ${res.status}`)
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
    const musicFolders = store.get('musicFolders', [])
    const cfg = store.get('slskConfig', {})
    writeSlskdConfig({ ...cfg, downloadDir: musicFolders[0] || path.join(app.getPath('home'), 'Music') })
  }
  slskdProc = spawn(SLSKD_BIN, ['--config', SLSKD_CFG, '--no-logo'], { stdio: 'ignore' })
  slskdProc.on('exit', () => { slskdProc = null; slskdReady = false; slskdToken = null })
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
  execSync(`unzip -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(SLSKD_DIR)}`)
  fs.unlinkSync(zipPath)
  execSync(`chmod +x ${JSON.stringify(SLSKD_BIN)}`)
}

let mainWindow  = null
let browserView = null
let artworkDir  = ''
let dlHandlerReady = false

const LAYOUT = { TITLEBAR: 52, SIDEBAR: 230, BROWSER_NAV: 56, PLAYER: 112 }
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png')

// ── Extension IPC (state file + command polling) ─────────────────────────────
const NOW_PLAYING_PATH = path.join(USER_DATA, 'now-playing.json')
const CMD_PATH         = path.join(USER_DATA, 'cmd')

function writeNowPlaying(data) {
  try { fs.writeFileSync(NOW_PLAYING_PATH, JSON.stringify(data)) } catch (e) { console.error('[papa] write-now-playing:', e.message || e) }
}

let _lastCmd = ''
function pollCmd() {
  try {
    const cmd = fs.readFileSync(CMD_PATH, 'utf8').trim()
    if (!cmd || cmd === _lastCmd) return
    _lastCmd = cmd
    fs.writeFileSync(CMD_PATH, '')
    mainWindow?.webContents.send('ext-cmd', cmd)
  } catch (e) { console.error('[papa] poll-cmd:', e.message || e) }
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
  reapOrphanedMpv()
  setTimeout(reapOrphanedMpv, 5000).unref?.()
  setTimeout(reapOrphanedMpv, 30000).unref?.()
  const hidden = process.argv.includes('--hidden')
  artworkDir = path.join(USER_DATA, 'artwork')
  fs.mkdirSync(artworkDir, { recursive: true })
  cleanupOldFiles()

  const LOG_DIR = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(LOG_DIR, { recursive: true })
  function logToFile(level, ...args) {
    const ts = new Date().toISOString()
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    const line = `[${ts}] [${level}] ${msg}\n`
    const today = new Date().toISOString().slice(0, 10)
    const f = path.join(LOG_DIR, `papa-${today}.log`)
    try { fs.appendFileSync(f, line) } catch (_) {}
  }
  const _origError = console.error
  console.error = (...args) => { _origError(...args); logToFile('ERROR', ...args) }
  const _origLog = console.log
  console.log = (...args) => { _origLog(...args); logToFile('INFO', ...args) }
  try { fs.writeFileSync(CMD_PATH, '') } catch (_) {}
  setInterval(pollCmd, 200)
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
    if (!(await validateYtCookie())) refreshYtCookie()
  }, 8000)
  setInterval(refreshYtCookie, 12 * 60 * 60 * 1000)

  // Crash recovery: detect if previous session ended ungracefully
  const wasCleanShutdown = store.get('cleanShutdown', true)
  store.set('cleanShutdown', false)

  createWindow(hidden)
  if (!wasCleanShutdown) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('app-recovered-from-crash')
    })
  }
  initMpris()          // MPRIS D-Bus first; media-key grab only as fallback
  initPlayer()
  createTray()
  setupLibraryWatcher()
  if (fs.existsSync(SLSKD_BIN)) startSlskd().catch(() => {})
  // Auto-restart monitoring: ping slskd every 60s; restart after 3 consecutive failures
  setInterval(async () => {
    try {
      await slskdFetch('GET', '/session')
      _slskdFailures = 0
      mainWindow?.webContents.send('slskd-status-change', { connected: true, restarting: false })
    } catch {
      _slskdFailures++
      if (_slskdFailures >= 3) {
        mainWindow?.webContents.send('slskd-status-change', { connected: false, restarting: true })
        try { await startSlskd(); _slskdFailures = 0 } catch {}
      } else {
        mainWindow?.webContents.send('slskd-status-change', { connected: false, restarting: false })
      }
    }
  }, 60000)
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json')
    if (fs.existsSync(configPath)) fs.chmodSync(configPath, 0o600)
  } catch (_) {}

  async function processWishlist() {
    const wishlist = store.get('downloadWishlist', [])
    if (!wishlist.length) return
    console.log('[papa] wishlist: checking', wishlist.length, 'items')
    for (const item of wishlist) {
      try {
        const search = await slskdFetch('POST', '/searches', {
          searchText: item.query,
          searchTimeout: 15000,
          responseLimit: 50,
          fileLimit: 10000,
        })
        const id = search?.id
        if (!id) continue

        const start = Date.now()
        let responses = []
        for (let i = 0; i < 25; i++) {
          await new Promise(r => setTimeout(r, 1000))
          const st = await slskdFetch('GET', `/searches/${id}`)
          responses = await slskdFetch('GET', `/searches/${id}/responses`) || []
          if (st?.state?.includes('Completed') || responses.length > 0 || Date.now() - start > 20000) break
        }

        try { await slskdFetch('DELETE', `/searches/${id}`) } catch (_) {}

        if (!responses.length) continue

        const best = responses.find(f => /\.(flac|wav)$/i.test(f.filename)) || responses[0]
        await slskdFetch('POST', `/transfers/downloads/${encodeURIComponent(best.username)}`,
          [{ filename: best.filename, size: best.size }])

        const updated = store.get('downloadWishlist', []).filter(w => w.query !== item.query)
        store.set('downloadWishlist', updated)
        console.log('[papa] wishlist: downloaded and removed', item.query)
      } catch (e) {
        console.error('[papa] wishlist error:', e.message || e)
      }
    }
  }

  setInterval(processWishlist, 30 * 60 * 1000)
  setTimeout(processWishlist, 30000)
})

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

function reapOrphanedMpv() {
  if (process.platform === 'win32') return
  const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir()
  let entries = []
  try { entries = fs.readdirSync(runtimeDir) } catch (_) { return }
  const socks = entries.filter(f => /^papa-mpv-\d+-\d+\.sock$/.test(f))
  if (!socks.length) return

  let running = ''
  try { running = require('child_process').execSync('ps -eo pid,args', { encoding: 'utf8' }) } catch (_) {}

  for (const f of socks) {
    const owner = Number((f.match(/^papa-mpv-(\d+)-/) || [])[1])
    if (!owner || owner === process.pid || pidAlive(owner)) continue   // still someone's
    const full = path.join(runtimeDir, f)
    for (const line of running.split('\n')) {
      if (line.includes(full) && /\bmpv\b/.test(line)) {
        const pid = Number(line.trim().split(/\s+/)[0])
        if (pid) { try { process.kill(pid, 'SIGKILL') } catch (_) {} }
      }
    }
    try { fs.unlinkSync(full) } catch (_) {}
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
  try { stopSlskd() } catch (_) {}
  try { store.set('cleanShutdown', true) } catch (_) {}
  try { if (fs.existsSync(NOW_PLAYING_PATH)) fs.unlinkSync(NOW_PLAYING_PATH) } catch (_) {}
  try { globalShortcut.unregisterAll() } catch (_) {}
  try { app.exit(0) } catch (_) {}
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
  stopSlskd()
  try { if (fs.existsSync(NOW_PLAYING_PATH)) fs.unlinkSync(NOW_PLAYING_PATH) } catch (_) {}
  globalShortcut.unregisterAll()
})

function createWindow(hidden = false) {
  const winState = store.get('windowState', {})
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
  mainWindow.loadFile('src/index.html')

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
    mainWindow.webContents.send('window-focus', on)
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
        store.set('windowState', next)
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
      store.set('windowState', next)
    } catch (_) {}
  }
  // renderer-process-limit is 1, so if the renderer dies the user is left with a
  // blank frameless window, no controls and no explanation. Say what happened
  // and offer the reload rather than requiring a force-quit.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[papa] renderer gone:', details && details.reason)
    if (details && details.reason === 'clean-exit') return
    const win = mainWindow
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'Papa Audio stopped responding',
      message: 'The window crashed (' + ((details && details.reason) || 'unknown') + ').',
      detail: 'Playback is handled by mpv and may still be running. Reload to get the window back.',
      buttons: ['Reload', 'Close'],
      defaultId: 0,
    }).then((r) => {
      if (r.response === 0 && win && !win.isDestroyed()) win.reload()
      else if (win && !win.isDestroyed()) win.close()
    }).catch(() => {})
  })

  mainWindow.on('resize', () => { updateBrowserBounds(); saveWinState() })
  mainWindow.on('move', saveWinState)
  mainWindow.on('close', async (e) => {
    saveWinStateNow()
    if (!app.isQuitting && store.get('closeToTray', true) && tray) {
      e.preventDefault()
      mainWindow.hide()
      return
    }
    if (app.isQuitting) { player?.stop(); return }
    try {
      const isPlaying = await mainWindow.webContents.executeJavaScript('state.isPlaying')
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
    if (browserView) { try { browserView.webContents.destroy() } catch (_) {} browserView = null }
    mainWindow = null
  })
}

function registerMediaKeys() {
  globalShortcut.register('MediaPlayPause',     () => mainWindow?.webContents.send('media-key', 'play-pause'))
  globalShortcut.register('MediaNextTrack',     () => mainWindow?.webContents.send('media-key', 'next'))
  globalShortcut.register('MediaPreviousTrack', () => mainWindow?.webContents.send('media-key', 'prev'))
}

// ── mpv player engine ─────────────────────────────────────────────────────────
let player = null
let mpvAvailable = false

function getPlayerSettings() {
  return {
    outputMode: 'default', alsaDevice: null,
    mode: 'gapless', crossfadeSecs: 4, replaygain: 'no',
    channels: 'auto', boost: false,
    eq: eqDefaults(),
    ...store.get('playerSettings', {}),
  }
}

function detectMpv() {
  try { execFileSync('mpv', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

function sendPlayerEvent(type, data) {
  mainWindow?.webContents.send('player-event', { type, data })
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
  p.on('paused',       d => sendPlayerEvent('paused', d))
  p.on('audioParams',  d => sendPlayerEvent('audioParams', d))
  p.on('autoAdvanced', d => sendPlayerEvent('autoAdvanced', d))
  p.on('trackChanged', d => sendPlayerEvent('trackChanged', d))
  p.on('ended',        () => sendPlayerEvent('ended'))
  p.on('loadError',    d => sendPlayerEvent('loadError', d))
  // These four carry a payload now. engineDown says whether recovery is coming,
  // stopped names the end-file reason, engineRecovered says where it resumed,
  // and engineFailed says what actually failed instead of blaming a missing mpv.
  p.on('engineDown',      d => sendPlayerEvent('engineDown', d))
  p.on('stopped',         d => sendPlayerEvent('stopped', d))
  p.on('engineRecovered', d => sendPlayerEvent('engineRecovered', d))
  // Position stopped advancing while mpv says it is not paused. mpv itself is
  // asked what it thinks before this fires, so it is a finding, not a guess.
  p.on('stalled',         d => sendPlayerEvent('stalled', d))
  // The output device, specifically, as opposed to any other mpv complaint.
  p.on('audioDeviceLost', d => sendPlayerEvent('audioDeviceLost', d))
  p.on('audioDeviceFallback', d => sendPlayerEvent('audioDeviceFallback', d))
  p.on('engineFailed',    d => { sendPlayerEvent('engineFailed', d); onEngineFailed(d) })
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
  mpvAvailable = detectMpv()
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
  if (!player) return { ok: false, error: 'engine unavailable' }
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

ipcMain.handle('player-load',       async (_, { path: p, play }) => {
  var resolved = await _resolvePlayerPath(p)
  return wrap(() => player.load(resolved, { play }))()
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
  return wrap(() => player.load(resolved, { play: true }))()
})
ipcMain.handle('player-seek',       (_, s) => wrap(() => player.seek(s))())
// Renderer sends linear 0–100 (HTMLAudioElement semantics); mpv softvol is
// cubic, so convert or everything below max plays several dB too quiet.
let lastLinearVolume = null
ipcMain.handle('player-set-volume', (_, v) => wrap(() => {
  lastLinearVolume = v / 100
  return player.setVolume(linearToMpv(lastLinearVolume, getPlayerSettings().boost))
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
// Whether a queued track is genuinely gone, asked of the filesystem rather than
// inferred from one load error. A transient demuxer or cache error on a large
// FLAC used to be enough to delete a present file from the queue for good.
ipcMain.handle('track-exists', async (_, filePath) => {
  const p = String(filePath || '')
  if (!p) return { checked: false, exists: false, reason: 'no path' }
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
      player.stop()
      player = buildPlayer(cfg)
      await player.start()
      if (resume.path) {
        await player.load(resume.path, { play: false })
        if (resume.position > 1) await player.seek(resume.position)
        await player.setVolume(resume.volume)
        if (!resume.paused) await player.play()
      }
    } else {
      if ('replaygain' in partial) await player.setReplaygain(cfg.replaygain)
      if ('channels' in partial) await player.setChannels(cfg.channels)
      if ('eq' in partial) await player.setEq(cfg.eq)
      if ('boost' in partial && lastLinearVolume != null) {
        await player.setVolume(linearToMpv(lastLinearVolume, cfg.boost))
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
    const send = (cmd) => mainWindow?.webContents.send('media-key', cmd)
    mprisPlayer.on('playpause', () => send('play-pause'))
    mprisPlayer.on('play',      () => send('play'))
    mprisPlayer.on('pause',     () => send('pause'))
    mprisPlayer.on('next',      () => send('next'))
    mprisPlayer.on('previous',  () => send('prev'))
    mprisPlayer.on('stop',      () => send('pause'))
    mprisPlayer.on('quit',      () => { app.isQuitting = true; app.quit() })
    mprisPlayer.on('raise',     () => { mainWindow?.show(); mainWindow?.focus() })
    mprisPlayer.on('position',  (e) => mainWindow?.webContents.send('media-seek', { position: e.position / 1e6 }))
    mprisPlayer.on('seek',      (offsetUs) => mainWindow?.webContents.send('media-seek', { offset: offsetUs / 1e6 }))
    mprisPlayer.on('volume',    (v) => mainWindow?.webContents.send('media-volume', Math.max(0, Math.min(1, v))))
    mprisPlayer.on('shuffle',   (enabled) => mainWindow?.webContents.send('media-shuffle', !!enabled))
    mprisPlayer.on('loopStatus',(status) => mainWindow?.webContents.send('media-loop-status', status))
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

function updateMpris(data) {
  if (!mprisPlayer) return
  try {
    if (data.title !== undefined) {
      mprisPlayer.metadata = {
        'mpris:trackid': mprisPlayer.objectPath('track/' + (data.queueIndex ?? 0)),
        'mpris:length': Math.round((data.duration || 0) * 1e6),
        'mpris:artUrl': data.artPath ? 'file://' + encodeURI(data.artPath).replace(/#/g, '%23') : '',
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
    { label: isPlaying ? 'Pause' : 'Play', click: () => mainWindow?.webContents.send('media-playpause') },
    { label: 'Next', click: () => mainWindow?.webContents.send('media-next') },
    { label: 'Previous', click: () => mainWindow?.webContents.send('media-previous') },
    { type: 'separator' },
    { label: 'Show', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } } },
    { label: 'Quit', click: () => app.quit() },
  ]))
}

ipcMain.on('update-tray-tooltip', (_, track) => {
  if (!tray) return
  var tip = 'Papa Audio'
  if (track && track.title) tip = track.title + (track.artist ? ' — ' + track.artist : '')
  tray.setToolTip(tip)
})

function updateBrowserBounds() {
  if (!browserView || !mainWindow) return
  const [w, h] = mainWindow.getContentSize()
  browserView.setBounds({
    x: LAYOUT.SIDEBAR,
    y: LAYOUT.TITLEBAR + LAYOUT.BROWSER_NAV,
    width:  w - LAYOUT.SIDEBAR,
    height: h - LAYOUT.TITLEBAR - LAYOUT.BROWSER_NAV - LAYOUT.PLAYER
  })
}

// ── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize())
ipcMain.on('win-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize())
ipcMain.on('win-close',    () => {
  if (store.get('closeToTray', true) && tray) mainWindow?.hide()
  else { player?.stop(); app.isQuitting = true; mainWindow?.close() }
})
ipcMain.handle('get-general-settings', () => ({
  closeToTray: store.get('closeToTray', true),
  theme: store.get('theme', 'dark'),
}))
ipcMain.on('save-general-settings', (_, s) => {
  if (typeof s.closeToTray === 'boolean') store.set('closeToTray', s.closeToTray)
  if (s.theme) store.set('theme', s.theme)
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
  if (mainWindow) mainWindow.webContents.send('system-suspend')
})

powerMonitor.on('resume', () => {
  if (mainWindow) mainWindow.webContents.send('system-resume')
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

ipcMain.on('show-notification', (_, { title, body }) => {
  if (!Notification.isSupported()) return
  new Notification({ title, body, silent: true }).show()
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
  recentlyPlayed: store.get('recentlyPlayed', []),
  volume:         store.get('volume', 0.8),
  wishlist:       store.get('downloadWishlist', []),
}))

// ── Library cache ────────────────────────────────────────────────────────────
ipcMain.handle('get-library-cache', () => store.get('libraryCache', null))
ipcMain.on('save-library-cache', (_, albums) => store.set('libraryCache', albums))

// ── Playback state persistence ───────────────────────────────────────────────
ipcMain.handle('get-playback-state', () => store.get('playbackState', null))
ipcMain.on('save-playback-state', (_, s) => store.set('playbackState', s))

ipcMain.handle('get-session-state', () => store.get('sessionState', null))
ipcMain.on('save-session-state', (_, s) => store.set('sessionState', s))

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
ipcMain.handle('get-play-history', () => store.get('playHistory', []))
ipcMain.on('add-play-history', (_, entry) => {
  const h = store.get('playHistory', [])
  h.unshift(entry)
  if (h.length > 2000) h.splice(2000)
  store.set('playHistory', h)
})

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

function ffprobeAudio(filePath) {
  try {
    const out = require('child_process').execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,channels,sample_rate,profile',
      '-of', 'json', filePath
    ], { encoding: 'utf8', timeout: 10000, maxBuffer: 1 << 20 })
    const st = (JSON.parse(out).streams || [])[0] || {}
    return {
      codec: st.codec_name || null,
      channels: Number(st.channels) || 0,
      sampleRate: Number(st.sample_rate) || 0,
      // Both E-AC-3 JOC and TrueHD Atmos announce it in the profile string.
      atmos: /atmos/i.test(st.profile || '')
    }
  } catch {
    return { codec: null, channels: 0, sampleRate: 0, atmos: false }
  }
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
    ? ffprobeAudio(filePath)
    : { codec: null, channels: 0, sampleRate: 0, atmos: false }
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
async function performScan(onProgress) {
  const folders = store.get('musicFolders', [])
  if (!folders.length) return { albums: [] }
  if (_scanRunning) return { albums: store.get('libraryCache', []) || [], busy: true }
  _scanRunning = true
  try {
    const found = { audio: [], cues: [] }
    for (const f of folders) await scanDirAsync(f, found)

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
    store.set('libraryCache', albums)
    onProgress?.({ done: total, total, parsed, phase: 'done', albums: albums.length })
    return { albums }
  } catch (e) {
    console.error('[papa] scan-error:', e?.code || e.message || e, '|', (e?.stack || '').split('\n')[0] || '')
    return { albums: [] }
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
    playHistory:   store.get('playHistory', []),
    playlists:     store.get('playlists', []),
    savedQueues:   store.get('savedQueues', []),
    playbackState: store.get('playbackState', null),
  }
  const { next, summary } = libPrune.pruneAll(snapshot, map)
  if (!summary.touched && !summary.renamed) return { ok: true, summary, snapshot: null }

  store.set('likedTracks',   next.likedTracks)
  store.set('playCounts',    next.playCounts)
  store.set('playHistory',   next.playHistory)
  store.set('playlists',     next.playlists)
  store.set('savedQueues',   next.savedQueues)
  if (next.playbackState) store.set('playbackState', next.playbackState)
  else store.delete('playbackState')

  // The pre-prune snapshot IS the undo. Handed back so the renderer can offer
  // it without main having to hold per-operation state.
  return { ok: true, summary, snapshot }
})

ipcMain.handle('library-restore-state', (_, { snapshot }) => {
  if (!snapshot) return { ok: false, error: 'Nothing to restore' }
  if (snapshot.likedTracks)   store.set('likedTracks', snapshot.likedTracks)
  if (snapshot.playCounts)    store.set('playCounts', snapshot.playCounts)
  if (snapshot.playHistory)   store.set('playHistory', snapshot.playHistory)
  if (snapshot.playlists)     store.set('playlists', snapshot.playlists)
  if (snapshot.savedQueues)   store.set('savedQueues', snapshot.savedQueues)
  if (snapshot.playbackState) store.set('playbackState', snapshot.playbackState)
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

function dirSize(target) {
  let total = 0
  const walk = (d) => {
    let names
    try { names = fs.readdirSync(d, { withFileTypes: true }) } catch (_) { return }
    for (const n of names) {
      const full = path.join(d, n.name)
      if (n.isDirectory()) { walk(full); continue }
      try { total += fs.statSync(full).size } catch (_) {}
    }
  }
  try {
    const st = fs.statSync(target)
    if (st.isDirectory()) walk(target)
    else total = st.size
  } catch (_) {}
  return total
}

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
    out.roots.push({ path: r, bytes: dirSize(r) })
  }
  out.artworkBytes = dirSize(artworkDir)
  for (const t of trashRootsAll()) out.trashBytes += dirSize(path.join(t, 'files'))
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

ipcMain.handle('library-trash-list', () => {
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
      const bytes = dirSize(payload)
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
      const bytes = dirSize(payload)
      try {
        fs.rmSync(payload, { recursive: true, force: true })
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
  const needed = dirSize(path.resolve(from))
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

function imageDimensions(file) {
  // ffprobe is already a hard dependency here and reads every format we accept.
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { timeout: 10000 }).toString().trim().split('\n')
    return { codec: out[0] || null, width: parseInt(out[1], 10) || 0, height: parseInt(out[2], 10) || 0 }
  } catch (_) { return null }
}

ipcMain.handle('library-set-artwork', async (_, { albumId, sourcePath, embed, filePaths }) => {
  if (!albumId) return { ok: false, error: 'No album given' }
  if (!sourcePath || !fs.existsSync(sourcePath)) return { ok: false, error: 'That image is gone' }

  const info = imageDimensions(sourcePath)
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
  const recent = store.get('recentlyPlayed', [])
  if (recent.indexOf(oldId) !== -1) {
    store.set('recentlyPlayed', recent.map(x => (x === oldId ? newId : x)).filter((x, i, a) => a.indexOf(x) === i))
  }
  const session = store.get('sessionState', null)
  if (session && session.navId === oldId) store.set('sessionState', { ...session, navId: newId })

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
    results.push(Object.assign({ filePath: fp }, await writeTagsOne(fp, item.tags || {})))
  }
  const ok = results.filter(r => r.ok).length
  if (ok) _scheduleLibraryRescan()
  return { results, written: ok, failed: results.length - ok }
})

let _libRescanTimer = null
function _scheduleLibraryRescan() {
  clearTimeout(_libRescanTimer)
  _libRescanTimer = setTimeout(async () => {
    const { albums } = await performScan(null)
    mainWindow?.webContents.send('library-updated', { albums, reason: 'manage' })
    writeLibraryExt(albums)
  }, 1200)
}

ipcMain.handle('scan-library', async () => {
  return performScan(p => mainWindow?.webContents.send('scan-progress', p))
})

// ── Realtime folder watching ─────────────────────────────────────────────────
let chokidar; try { chokidar = require('chokidar') } catch (_) {}
let _libWatcher = null
let _watchDebounce = null

function setupLibraryWatcher() {
  if (!chokidar) return
  if (_libWatcher) { try { _libWatcher.close() } catch (_) {} _libWatcher = null }
  const folders = store.get('musicFolders', [])
  if (!folders.length) return
  _libWatcher = chokidar.watch(folders, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2500, pollInterval: 400 },
    ignorePermissionErrors: true,
    depth: 30,
  })
  const onFsEvent = (fsPath) => {
    if (!AUDIO_EXT.test(fsPath) && !/\.cue$/i.test(fsPath)) return
    clearTimeout(_watchDebounce)
    _watchDebounce = setTimeout(async () => {
      const { albums } = await performScan(null)
      mainWindow?.webContents.send('library-updated', { albums, reason: 'watcher' })
      writeLibraryExt(albums)
    }, 4000)
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
  if (_trayNow.title !== nowTitle || _trayNow.playing !== !!data.playing) {
    _trayNow = { title: nowTitle, playing: !!data.playing }
    updateTrayMenu(!!data.playing)
    if (tray) tray.setToolTip(nowTitle ? `Papa Audio — ${nowTitle}` : 'Papa Audio')
  }
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
  let r = store.get('recentlyPlayed', []).filter(x => x !== id)
  r.unshift(id); store.set('recentlyPlayed', r.slice(0, 20))
})
ipcMain.on('save-volume', (_, v) => store.set('volume', v))

// ── Sites ────────────────────────────────────────────────────────────────────
ipcMain.handle('save-site', (_, site) => {
  const sites = store.get('savedSites', [])
  if (!sites.find(s => s.url === site.url)) sites.push(site)
  store.set('savedSites', sites); return sites
})
ipcMain.handle('remove-site', (_, url) => {
  const sites = store.get('savedSites', []).filter(s => s.url !== url)
  store.set('savedSites', sites); return sites
})

// ── Browser view ─────────────────────────────────────────────────────────────
const activeDownloads = new Map()
const MUSIC_EXT = /\.(flac|mp3|wav|aiff?|m4a|ogg|opus|ape|wv|wma|dsf|dff|aac|m4b)$/i

// ── Download handler (session-level, catches all BrowserViews) ───────────────
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
        if (state === 'completed') { _torrentAdd(tmp); mainWindow?.webContents.send('torrent-started', { uri: tmp }) }
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
    mainWindow?.webContents.send('dl-started', { id: dlId, filename, dest, total: item.getTotalBytes(), isMusic })
    item.on('updated', (__, state) => {
      if (state === 'progressing')
        mainWindow?.webContents.send('dl-progress', { id: dlId, filename, received: item.getReceivedBytes(), total: item.getTotalBytes() })
    })
    item.once('done', (__, state) => {
      activeDownloads.delete(dlId)
      if (state === 'completed') {
        if (isArchive) { try { new AdmZip(dest).extractAllTo(path.dirname(dest), true) } catch (e) { console.error('[papa] zip-extract:', e.message || e) } }
        mainWindow?.webContents.send('dl-complete', { id: dlId, filename, dest, isMusic })
      } else if (state === 'cancelled') {
        mainWindow?.webContents.send('dl-cancelled', { id: dlId, filename })
      } else {
        mainWindow?.webContents.send('dl-failed', { id: dlId, filename })
      }
    })
  })
}

function createBrowserView () {
  if (browserView) return
  ensureDlHandler()
  browserView = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true } })

  // Open _blank / window.open() links inside the same BrowserView instead of failing silently
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    const safe = url.startsWith('http') ? url : `https://${url}`
    browserView.webContents.loadURL(safe)
    mainWindow?.webContents.send('browser-url', safe)
    return { action: 'deny' }
  })

  // Loading state events
  browserView.webContents.on('did-start-loading', () =>
    mainWindow?.webContents.send('browser-loading', true))
  browserView.webContents.on('did-stop-loading',  () =>
    mainWindow?.webContents.send('browser-loading', false))
  browserView.webContents.on('did-fail-load', (_, code, desc, url) => {
    if (code !== -3) mainWindow?.webContents.send('browser-load-error', { code, desc, url })
    mainWindow?.webContents.send('browser-loading', false)
  })

  // Navigation events
  browserView.webContents.on('did-navigate',         (_, u) => mainWindow?.webContents.send('browser-url',   u))
  browserView.webContents.on('did-navigate-in-page', (_, u) => mainWindow?.webContents.send('browser-url',   u))
  browserView.webContents.on('page-title-updated',   (_, t) => mainWindow?.webContents.send('browser-title', t))

  // Intercept magnet links — handle via WebTorrent instead of navigating
  browserView.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('magnet:')) {
      e.preventDefault()
      _torrentAdd(url)
      mainWindow?.webContents.send('torrent-started', { uri: url })
    }
  })
}

ipcMain.on('show-browser', (_, url) => {
  if (!mainWindow) return
  createBrowserView()
  const views = mainWindow.getBrowserViews()
  if (!views.includes(browserView)) mainWindow.addBrowserView(browserView)
  updateBrowserBounds()
  if (url) {
    const full = url.startsWith('http') ? url : `https://${url}`
    browserView.webContents.loadURL(full)
  }
})

ipcMain.on('hide-browser',          ()       => { if (browserView && mainWindow) mainWindow.removeBrowserView(browserView) })
ipcMain.on('browser-navigate',      (_, url) => { if (browserView) browserView.webContents.loadURL(url.startsWith('http') ? url : `https://${url}`) })
ipcMain.on('browser-back',          ()       => browserView?.webContents.canGoBack()    && browserView.webContents.goBack())
ipcMain.on('browser-forward',       ()       => browserView?.webContents.canGoForward() && browserView.webContents.goForward())
ipcMain.on('browser-refresh',       ()       => browserView?.webContents.reload())
ipcMain.on('browser-stop',          ()       => browserView?.webContents.stop())
ipcMain.on('browser-zoom-in',       ()       => { if (!browserView) return; const z = Math.min(3.0, browserView.webContents.getZoomFactor() + 0.1); browserView.webContents.setZoomFactor(z); mainWindow?.webContents.send('browser-zoom', Math.round(z * 100)) })
ipcMain.on('browser-zoom-out',      ()       => { if (!browserView) return; const z = Math.max(0.25, browserView.webContents.getZoomFactor() - 0.1); browserView.webContents.setZoomFactor(z); mainWindow?.webContents.send('browser-zoom', Math.round(z * 100)) })
ipcMain.on('browser-zoom-reset',    ()       => { if (!browserView) return; browserView.webContents.setZoomFactor(1); mainWindow?.webContents.send('browser-zoom', 100) })
ipcMain.on('cancel-download',       (_, id)  => { const item = activeDownloads.get(id); if (item) { item.cancel(); activeDownloads.delete(id) } })
ipcMain.on('open-browser-devtools', ()       => browserView?.webContents.openDevTools())

// ══════════════════════════════════════════════════════════════════════════════
// LOCAL AGENT — Ollama-powered autonomous web navigator
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
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

ipcMain.handle('fetch-album-art', async (_, { albumId, artist, album }) => {
  try {
    const cached = path.join(artworkDir, `${albumId}.jpg`)
    if (fs.existsSync(cached)) return { artPath: cached }
    const query = encodeURIComponent(`${artist} ${album}`)
    const raw = await httpsGet(`https://itunes.apple.com/search?term=${query}&entity=album&limit=8&media=music`)
    const data = JSON.parse(raw.toString())
    if (!data.results?.length) return null
    const al = album.toLowerCase(), ar = artist.toLowerCase().split(/\s+/)[0]
    const best = data.results.find(r =>
      r.collectionName?.toLowerCase().includes(al) && r.artistName?.toLowerCase().includes(ar)
    ) || data.results.find(r => r.collectionName?.toLowerCase().includes(al)) || data.results[0]
    if (!best?.artworkUrl100) return null
    const imgBuf = await httpsGet(best.artworkUrl100.replace('100x100bb', '600x600bb'))
    fs.writeFileSync(cached, imgBuf)
    return { artPath: cached }
  } catch (_) { return null }
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
  store.set('slskConfig', { username, password })
  const musicFolders = store.get('musicFolders', [])
  const downloadDir = musicFolders[0] || path.join(app.getPath('home'), 'Music')
  writeSlskdConfig({ username, password, downloadDir })
  stopSlskd()
  await startSlskd()
  return { ok: true }
})

ipcMain.handle('slsk-setup', async () => {
  try {
    await downloadSlskd(text => mainWindow?.webContents.send('slsk-progress', { text }))
    const cfg = store.get('slskConfig', {})
    const musicFolders = store.get('musicFolders', [])
    const downloadDir = musicFolders[0] || path.join(app.getPath('home'), 'Music')
    writeSlskdConfig({ ...cfg, downloadDir })
    mainWindow?.webContents.send('slsk-progress', { text: 'Starting daemon…' })
    await startSlskd()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ── Search result cache (in-memory, 5-min TTL, cleared on restart) ────────────
const _searchCache = new Map()
function _searchCacheGet(key) {
  const e = _searchCache.get(key)
  if (!e) return null
  if (Date.now() - e.ts > 5 * 60 * 1000) { _searchCache.delete(key); return null }
  return e.results
}
function _searchCacheSet(key, results) {
  _searchCache.set(key, { results, ts: Date.now() })
  if (_searchCache.size > 200) {
    const cutoff = Date.now() - 5 * 60 * 1000
    for (const [k, v] of _searchCache) if (v.ts < cutoff) _searchCache.delete(k)
  }
}

ipcMain.handle('slsk-search', async (_, { query, timeoutMs = 25000, noCache = false }) => {
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

  const start = Date.now()
  let lastPushTime = 0
  let lastCount    = 0

  while (true) {
    await new Promise(r => setTimeout(r, 800))
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
        mainWindow?.webContents.send('slsk-progress', { query, results: partial || [], done: false })
      }
    }

    if (st?.state?.includes('Completed')) break
    // Early-exit thresholds: enough results before full timeout
    if (elapsed >= 7000  && lastCount >= 60) break
    if (elapsed >= 12000 && lastCount >= 20) break
    if (elapsed >= 18000 && lastCount >=  5) break
  }

  const responses = await slskdFetch('GET', `/searches/${id}/responses`)
  try { await slskdFetch('DELETE', `/searches/${id}`) } catch (e) { console.error('[papa] slsk-search-cleanup:', e.message || e) }

  const results = responses || []
  if (results.length) _searchCacheSet(cacheKey, results)
  mainWindow?.webContents.send('slsk-progress', { query, results, done: true })
  return { results }
})

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

const DL_TICK_MS = 4000
let dlState = dlSched.createState()
let dlTimer = null
let dlTicking = false

function dlConfig() {
  const saved = store.get('slskSchedulerConfig', {})
  return Object.assign({}, dlSched.DEFAULTS, saved)
}

// Finding "the same file" on another peer by basename alone is wrong: an
// 08. Change.flac from a 5.1 rip and one from a stereo rip are indistinguishable
// that way, so an album ends up half surround and half stereo. Matching would
// have to compare channel count and size (see download-spread.js sizeCompatible)
// before this can be trusted, so it stays off until it does.
function dlDiscoveryEnabled() {
  return store.get('slskSchedulerConfig', {}).discoverAlternates === true
}

// The queue now lives on our side, so it must survive a quit — previously
// every request sat safely in slskd and a restart lost nothing.
function dlPersist() {
  try {
    store.set('slskSchedulerState', {
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
      abandoned: Object.keys(dlState.done)
        .filter(k => dlState.done[k] === 'abandoned')
        .slice(-5000),
      savedAt: Date.now(),
    })
  } catch (_) {}
}

function dlRestore() {
  const saved = store.get('slskSchedulerState', null)
  if (!saved) return 0
  const abandoned = new Set(saved.abandoned || [])
  const items = (saved.pending || []).concat(saved.inflight || [])
  for (const e of items) {
    if (!e || !e.filename) continue
    if (abandoned.has(e.key || dlSched.itemKey(e.filename))) continue
    const entry = dlSched.addItem(dlState, {
      filename: e.filename, size: e.size, sources: e.sources || [], addedAt: e.addedAt,
    })
    if (entry) {
      entry.tried = e.tried || []
      entry.triedAt = e.triedAt || {}
      entry.attempts = e.attempts || 0
    }
  }
  for (const k of saved.abandoned || []) dlState.done[k] = 'abandoned'
  dlState.peerFailures = saved.peerFailures || {}
  return items.length
}

function dlBroadcast() {
  try {
    mainWindow?.webContents.send('slsk-scheduler-stats', dlSched.stats(dlState))
  } catch (_) {}
}

// slskd reports state as e.g. "Completed, Succeeded" / "Queued, Remotely".
function dlClassify(stateStr) {
  const st = String(stateStr || '')
  if (st.indexOf('Completed') !== 0) return 'active'
  if (st.indexOf('Succeeded') !== -1) return 'succeeded'
  if (st.indexOf('Cancelled') !== -1) return 'cancelled'
  return 'failed'
}

async function dlSnapshot() {
  const out = new Map()
  let data
  try { data = await slskdFetch('GET', '/transfers/downloads') } catch (_) { return null }
  for (const user of data || []) {
    for (const dir of user.directories || []) {
      for (const f of dir.files || []) {
        out.set(String(f.filename), {
          username: user.username,
          id: f.id,
          state: f.state,
          kind: dlClassify(f.state),
        })
      }
    }
  }
  return out
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

async function dlTick() {
  if (dlTicking) return
  dlTicking = true
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
      if (seen.kind === 'succeeded') dlSched.recordSuccess(dlState, key, seen.username)
      else if (seen.kind === 'failed') dlSched.recordFailure(dlState, key, seen.username, cfg, now)
      else if (seen.kind === 'cancelled') dlSched.recordAbandoned(dlState, key)
    }

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
      try {
        await slskdFetch('DELETE',
          `/transfers/downloads/${encodeURIComponent(st.from)}/${encodeURIComponent(await dlTransferId(st.from, live.sentFilename || live.filename))}?remove=true`)
      } catch (_) {}
      dlSched.recordStall(dlState, st.key, st.from, cfg, now)
    }

    // Files with no usable source, and files wedged in a single peer's queue,
    // both need the same thing: somewhere else to get them from.
    const hunt = dlSched.starvedItems(dlState, cfg, now)
      .concat(dlSched.stalledWithoutAlternate(dlState, cfg, now)
        .map(h => dlState.inflight[h.key])
        .filter(Boolean))
      .slice(0, 2)
    for (const item of dlDiscoveryEnabled() ? hunt : []) {
      if (!item || !item.filename) continue
      if (item._searchedAt && now - item._searchedAt < 5 * 60 * 1000) continue
      item._searchedAt = now
      const alts = await dlFindAlternates(item.filename)
      const key = item.key || dlSched.itemKey(item.filename)
      if (alts.length) dlSched.addSources(dlState, key, alts)
    }

    dlPersist()
    dlBroadcast()
  } finally {
    dlTicking = false
  }
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
      for (const it of group) want.set(dlBaseName(it.filename).toLowerCase(), it)
      let added = 0
      for (const r of responses) {
        for (const f of r.files || []) {
          const hit = want.get(dlBaseName(f.filename).toLowerCase())
          if (!hit) continue
          added += dlSched.addSources(dlState, dlSched.itemKey(hit.filename), [{
            username: r.username, filename: f.filename, size: f.size,
            hasFreeUploadSlot: !!r.hasFreeUploadSlot,
            queueLength: r.queueLength || 0,
            uploadSpeed: r.uploadSpeed || 0,
          }])
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

ipcMain.handle('slsk-enqueue-downloads', async (_, { items }) => {
  let added = 0
  for (const it of items || []) {
    if (!it || !it.filename) continue
    const sources = (it.sources && it.sources.length)
      ? it.sources
      : (it.username ? [{ username: it.username, filename: it.filename, size: it.size }] : [])
    if (!sources.length) continue
    if (dlSched.addItem(dlState, { filename: it.filename, size: it.size || 0, sources })) added++
  }
  dlStart()
  dlTick()
  // Runs behind the response: the files are already queued, this only widens
  // the set of peers they can come from.
  if (dlDiscoveryEnabled()) {
    const single = (items || []).filter(it => it && it.filename && !(it.sources && it.sources.length > 1))
    if (single.length) dlSeedFolderSources(single).catch(() => {})
  }
  return { ok: true, added, stats: dlSched.stats(dlState) }
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
    dlSched.addItem(dlState, {
      filename: q.filename, size: q.size,
      sources: [{ username: q.username, filename: q.filename, size: q.size }],
    })
  }
  dlStart()
  dlTick()
  return { ok: true, purged: purge.length, respread: queued.length, stats: dlSched.stats(dlState) }
})

ipcMain.handle('slsk-get-transfers', async () => {
  // Was `catch (_) { return [] }`. The renderer detects an unreachable daemon by
  // this promise REJECTING, so swallowing made that impossible: a dead slskd
  // rendered as "No active downloads", the tab badges zeroed, the list blanked,
  // and the "Can't reach the Soulseek daemon" empty state was unreachable dead
  // code. It also fired a bogus "all downloads complete" notification, because
  // the active count dropped to zero.
  const data = await slskdFetch('GET', '/transfers/downloads')
  return data || []
})

ipcMain.handle('slsk-cancel-transfer', async (_, { username, id, alreadyDone }) => {
  // Scheduler-held files are not known to slskd. Routing here means every
  // existing Cancel button works on them without knowing they are different.
  if (typeof id === 'string' && id.indexOf('sched:') === 0) {
    const key = id.slice(6)
    dlState.pending = dlState.pending.filter(e => e.key !== key)
    delete dlState.inflight[key]
    dlState.done[key] = 'exhausted'
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
function dlAbandonByFilename(filename) {
  const target = String(filename)
  const base = dlBaseName(target).toLowerCase()
  const hit = (name) => {
    if (!name) return false
    return String(name) === target || dlBaseName(name).toLowerCase() === base
  }
  for (const key of Object.keys(dlState.inflight)) {
    const live = dlState.inflight[key]
    if (hit(key) || hit(live.filename) || hit(live.sentFilename)) dlSched.recordAbandoned(dlState, key)
  }
  for (const e of dlState.pending.slice()) {
    if (hit(e.key) || hit(e.filename)) dlSched.recordAbandoned(dlState, e.key)
  }
}

function _downloadDir() {
  const cfg = store.get('slskConfig', {})
  const folders = store.get('musicFolders', [])
  return cfg.downloadDir || folders[0] || path.join(app.getPath('home'), 'Music')
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
  return { ok: true, downloadDir }
})

ipcMain.handle('slsk-show-in-folder', (_, filePath) => {
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
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-search', async (_, { query }) => {
  try { return { ok: true, results: await withRetry(() => withTimeout(ytSearch.searchAll(query), 20000, 'YouTube search'), 2, 'yt-search') } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-music-search-full', async (_, { query }) => {
  try { return { ok: true, results: await withRetry(() => withTimeout(ytSearch.searchMusicFull(query), 20000, 'YouTube full search'), 2, 'yt-music-search-full') } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-album', async (_, { browseId }) => {
  try { return { ok: true, album: await withRetry(() => withTimeout(ytSearch.getAlbum(browseId), 20000, 'YouTube album'), 2, 'yt-album') } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-artist', async (_, { channelId }) => {
  try { return { ok: true, artist: await withRetry(() => withTimeout(ytSearch.getArtist(channelId), 20000, 'YouTube artist'), 2, 'yt-artist') } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-search-page', async (_, { kind, query, next }) => {
  try {
    const { items, hasMore } = await withRetry(() => withTimeout(ytSearch.searchPage(kind, query, !!next), 20000, 'YouTube search page'), 2, 'yt-search-page')
    return { ok: true, items, hasMore }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-playlist', async (_, { playlistId }) => {
  try { return { ok: true, playlist: await withRetry(() => withTimeout(ytSearch.getPlaylist(playlistId), 20000, 'YouTube playlist'), 2, 'yt-playlist') } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-home', async () => {
  try { return { ok: true, ...(await withRetry(() => withTimeout(ytSearch.getHomeFeed(), 20000, 'YouTube home feed'), 2, 'yt-home')) } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-radio', async (_, { videoId }) => {
  try { return { ok: true, tracks: await withRetry(() => withTimeout(ytSearch.getRadio(videoId), 20000, 'YouTube radio'), 2, 'yt-radio') } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-find-video', async (_, { artist, title }) => {
  try { return { ok: true, videoId: await withRetry(() => ytSearch.findVideoId(artist, title), 2, 'yt-find-video') } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('get-lyrics', async (_, params) => {
  try { return { ok: true, ...(await lyrics.fetchLyrics(params || {})) } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('save-lyrics', (_, params) => {
  try { return lyrics.saveLyrics(params || {}) }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
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
function refreshYtCookie() {
  if (!store.get('ytCookie', null) || _ytRefreshWin) return
  const { session } = require('electron')
  const sess = session.fromPartition('persist:yt-auth')
  _ytRefreshWin = new BrowserWindow({
    show: false,
    webPreferences: { session: sess, nodeIntegration: false, contextIsolation: true },
  })
  const win = _ytRefreshWin
  const done = () => {
    if (_ytRefreshWin === win) _ytRefreshWin = null
    if (!win.isDestroyed()) win.destroy()
  }
  const timer = setTimeout(done, 30000)
  win.webContents.setUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')
  win.webContents.on('did-finish-load', async () => {
    try {
      await new Promise(r => setTimeout(r, 3000)) // let redirects settle
      const header = await _collectYtCookieHeader(sess)
      if (header) {
        store.set('ytCookie', header)
        ytSearch.setCookie(header)
      }
    } catch { /* keep the previous cookie */ }
    clearTimeout(timer)
    done()
  })
  win.loadURL('https://music.youtube.com/')
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

    const poll = setInterval(async () => {
      try {
        const header = await _collectYtCookieHeader(sess)
        if (header) {
          store.set('ytCookie', header)
          ytSearch.setCookie(header)
          mainWindow?.webContents.send('yt-auth-done', { signedIn: true })
          finish({ ok: true, signedIn: true })
        }
      } catch { /* keep polling until the window closes */ }
    }, 1500)

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
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-auth-status', () => {
  try { return { ok: true, signedIn: ytSearch.isSignedIn() } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('validate-yt-cookie', async () => {
  var valid = await validateYtCookie()
  if (!valid) {
    try { await refreshYtCookie() } catch (_) {}
    valid = await validateYtCookie()
  }
  return { ok: true, valid }
})

const _ytDownloads = new Map()
let _ytQueue = Promise.resolve()

function _ytEmit(dl) {
  mainWindow?.webContents.send('yt-dl-progress', { ...dl })
}

ipcMain.handle('yt-download', (_, { videoId, title, artist, subdir }) => {
  const id = `yt_${videoId}_${Date.now()}`
  const dl = { id, videoId, title, artist, percent: 0, state: 'downloading', error: null }
  _ytDownloads.set(id, dl)
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
    _ytEmit(dl)
  }).catch(e => { console.error('[papa] yt-download-error:', e.message || e) })
  return { ok: true, id }
})

ipcMain.handle('yt-get-downloads', () => [..._ytDownloads.values()])

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
  if (!filePath || !fs.existsSync(filePath)) return { ok: null, severity: 'unknown', message: 'File not found.' }
  const channels = await probeChannels(filePath)
  return { ...surroundVerify.verdict(expectedLabel || null, channels), channels }
})

// Audit a whole folder: an album is only surround if every track is, and one
// stereo track hiding in a 5.1 album is the failure most likely to go unnoticed.
ipcMain.handle('verify-surround-folder', async (_, { dir }) => {
  try {
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
    mainWindow?.webContents.send('slsk-verify', { ok: false, filename, error: 'File not found on disk' })
    return { ok: false, error: 'File not found on disk' }
  }

  const result = await verifyAudioFile(resolved)
  mainWindow?.webContents.send('slsk-verify', { ...result, filename, filePath: resolved })
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
    mainWindow?.webContents.send('slsk-user-status', {
      statuses: presenceSnapshot(), changed, serverConnected,
    })
  } catch (_) {}
}

function savedUsersChanged(list) {
  try { mainWindow?.webContents.send('slsk-saved-users-changed', savedUsers.sortUsers(list)) } catch (_) {}
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

ipcMain.handle('slsk-browse-user', async (_, { username }) => {
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Browse timed out')), 30000))
    const fetch   = slskdFetch('GET', `/users/${encodeURIComponent(username)}/browse`)
    const data    = await Promise.race([fetch, timeout])
    const dirs    = (data?.directories || data || []).filter(d => (d.files || []).length > 0)
    return { ok: true, directories: dirs }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('transcode-file', async (_, { filePath, format, outDir }) => {
  return new Promise((resolve) => {
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
})

ipcMain.handle('batch-transcode', async (_, { filePaths, format, outDir }) => {
  var results = []
  for (var fp of filePaths) {
    results.push(await ipcMain.emit('transcode-file', null, { filePath: fp, format, outDir }))
  }
  return results
})
