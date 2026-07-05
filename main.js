const { app, BrowserWindow, BrowserView, ipcMain, dialog, globalShortcut, Notification, shell, Menu, MenuItem, powerSaveBlocker } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const https = require('https')
const { spawn, execSync, execFileSync } = require('child_process')
const { MpvEngine } = require('./mpv-engine')
const { MpvCrossfade } = require('./mpv-crossfade')
const { linearToMpv } = require('./volume-map')
const ytSearch = require('./youtube-search')
const ytDownloader = require('./youtube-download')
let natUpnp; try { natUpnp = require('nat-upnp') } catch (_) {}

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
  const opts = { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }
  let res = await fetch(`${SLSKD_BASE}${endpoint}`, opts)
  if (res.status === 401) {
    slskdToken = null
    await slskdAcquireToken()
    if (slskdToken) headers['Authorization'] = `Bearer ${slskdToken}`
    res = await fetch(`${SLSKD_BASE}${endpoint}`, opts)
  }
  if (!res.ok && res.status !== 204) throw new Error(`slskd ${res.status}`)
  if (res.status === 204 || res.headers.get('content-length') === '0') return null
  const text = await res.text()
  return text ? JSON.parse(text) : null
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

async function startSlskd() {
  if (!fs.existsSync(SLSKD_BIN)) return
  // If already running externally, just authenticate and mark ready
  if (!slskdProc) {
    try {
      const r = await fetch(`${SLSKD_BASE}/application`)
      if (r.ok || r.status === 401) { slskdReady = true; await slskdAcquireToken(); return }
    } catch (_) {}
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
  upnpMap(2234).catch(() => {})
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
let autoDlView  = null
let artworkDir  = ''
let dlHandlerReady = false

const LAYOUT = { TITLEBAR: 52, SIDEBAR: 230, BROWSER_NAV: 56, PLAYER: 112 }
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png')

// ── Extension IPC (state file + command polling) ─────────────────────────────
const NOW_PLAYING_PATH = path.join(USER_DATA, 'now-playing.json')
const CMD_PATH         = path.join(USER_DATA, 'cmd')

function writeNowPlaying(data) {
  try { fs.writeFileSync(NOW_PLAYING_PATH, JSON.stringify(data)) } catch (_) {}
}

let _lastCmd = ''
function pollCmd() {
  try {
    const cmd = fs.readFileSync(CMD_PATH, 'utf8').trim()
    if (!cmd || cmd === _lastCmd) return
    _lastCmd = cmd
    fs.writeFileSync(CMD_PATH, '')
    mainWindow?.webContents.send('ext-cmd', cmd)
  } catch (_) {}
}

app.whenReady().then(() => {
  artworkDir = path.join(USER_DATA, 'artwork')
  fs.mkdirSync(artworkDir, { recursive: true })
  try { fs.writeFileSync(CMD_PATH, '') } catch (_) {}
  setInterval(pollCmd, 200)
  // Seed Rutracker as a default saved site if not already present
  const sites = store.get('savedSites', [])
  if (!sites.some(s => s.url && s.url.includes('rutracker'))) {
    sites.push({ url: 'https://rutracker.org/forum/index.php', name: 'Rutracker' })
    store.set('savedSites', sites)
  }
  createWindow()
  initMpris()          // MPRIS D-Bus first; media-key grab only as fallback
  initPlayer()
  createTray()
  setupLibraryWatcher()
  if (fs.existsSync(SLSKD_BIN)) startSlskd().catch(() => {})
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => {
  player?.stop()
  stopSlskd()
  try { if (fs.existsSync(NOW_PLAYING_PATH)) fs.unlinkSync(NOW_PLAYING_PATH) } catch (_) {}
  globalShortcut.unregisterAll()
})

function createWindow() {
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,   // slow down timers/rAF when window is hidden/minimized
    }
  })
  if (winState.maximized) mainWindow.maximize()
  mainWindow.loadFile('src/index.html')

  mainWindow.webContents.on('before-input-event', (_, input) => {
    if (input.key === 'F12') mainWindow.webContents.openDevTools()
  })

  const saveWinState = () => {
    if (!mainWindow) return
    store.set('windowState', { ...mainWindow.getBounds(), maximized: mainWindow.isMaximized() })
  }
  mainWindow.on('resize', () => { updateBrowserBounds(); saveWinState() })
  mainWindow.on('move', saveWinState)
  mainWindow.on('close', saveWinState)
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
  p.on('engineDown',   () => sendPlayerEvent('engineDown'))
  p.on('engineFailed', () => sendPlayerEvent('engineFailed'))
  return p
}

async function initPlayer() {
  mpvAvailable = detectMpv()
  if (!mpvAvailable) { sendPlayerEvent('mpvMissing'); return }
  player = buildPlayer(getPlayerSettings())
  try { await player.start() } catch (e) {
    console.error('mpv engine failed to start:', e)
    sendPlayerEvent('engineFailed')
  }
}

const wrap = fn => async (...args) => {
  if (!player) return { ok: false, error: 'engine unavailable' }
  try { await fn(...args); return { ok: true } } catch (e) { return { ok: false, error: String(e.message || e) } }
}

ipcMain.handle('player-load',       (_, { path: p, play }) => wrap(() => player.load(p, { play }))())
ipcMain.handle('player-set-next',   (_, p) => wrap(() => player.setNext(p))())
ipcMain.handle('player-play',       () => wrap(() => player.play())())
ipcMain.handle('player-pause',      () => wrap(() => player.pause())())
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
  state: player ? player.getState() : null,
  config: getPlayerSettings(),
}))
ipcMain.handle('player-recheck', async () => {
  if (player) { player.stop(); player = null }
  await initPlayer()
  return { available: mpvAvailable && !!player }
})
ipcMain.handle('player-get-config', () => getPlayerSettings())
ipcMain.handle('player-list-devices', async () => {
  if (!player) return []
  try { return await player.listAudioDevices() } catch { return [] }
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
    if (typeof data.volume === 'number') mprisPlayer.volume = data.volume
    _mprisPos = { position: data.position || 0, at: Date.now(), playing: !!data.playing }
  } catch (_) {}
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
    rebuildTrayMenu()
    tray.on('click', () => {
      if (!mainWindow) return
      mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus())
    })
  } catch (e) { console.error('Tray unavailable:', e.message) }
}

function rebuildTrayMenu() {
  if (!tray) return
  const send = (cmd) => mainWindow?.webContents.send('media-key', cmd)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: _trayNow.title || 'Nothing playing', enabled: false },
    { type: 'separator' },
    { label: _trayNow.playing ? 'Pause' : 'Play', click: () => send('play-pause') },
    { label: 'Next',     click: () => send('next') },
    { label: 'Previous', click: () => send('prev') },
    { type: 'separator' },
    { label: 'Show Papa Audio', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit() } },
  ]))
}

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
  // Close-to-tray: keep music playing in background unless disabled in settings
  if (store.get('closeToTray', true) && tray) mainWindow?.hide()
  else { app.isQuitting = true; mainWindow?.close() }
})
ipcMain.handle('get-general-settings', () => ({
  closeToTray: store.get('closeToTray', true),
  theme: store.get('theme', 'dark'),
}))
ipcMain.on('save-general-settings', (_, s) => {
  if (typeof s.closeToTray === 'boolean') store.set('closeToTray', s.closeToTray)
  if (s.theme) store.set('theme', s.theme)
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
  savedSites:     store.get('savedSites', []),
  recentlyPlayed: store.get('recentlyPlayed', []),
  volume:         store.get('volume', 0.8),
}))

// ── Library cache ────────────────────────────────────────────────────────────
ipcMain.handle('get-library-cache', () => store.get('libraryCache', null))
ipcMain.on('save-library-cache', (_, albums) => store.set('libraryCache', albums))

// ── Playback state persistence ───────────────────────────────────────────────
ipcMain.handle('get-playback-state', () => store.get('playbackState', null))
ipcMain.on('save-playback-state', (_, s) => store.set('playbackState', s))

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
const AUDIO_EXT = /\.(flac|mp3|wav|aiff?|m4a|aac|ogg|opus|ape|wv|wma|dsf|dff)$/i
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
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return fallback }
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

async function parseTrackFile(filePath, st) {
  const meta = await mm.parseFile(filePath, { duration: true })
  const c = meta.common, f = meta.format
  const pic = c.picture?.[0]
  let artPath = null
  if (pic) {
    const ext = pic.format.includes('png') ? 'png' : 'jpg'
    const key = crypto.createHash('md5').update((c.albumartist||c.artist||'')+(c.album||'')).digest('hex')
    artPath = path.join(artworkDir, `${key}.${ext}`)
    if (!fs.existsSync(artPath)) fs.writeFileSync(artPath, pic.data)
  }
  const codec = f.codec || null
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
    sampleRate: f.sampleRate || 0,
    bitsPerSample: f.bitsPerSample || 0,
    channels: f.numberOfChannels || 0,
    replayGainTrack: c.replaygain_track_gain?.dB ?? null,
    replayGainAlbum: c.replaygain_album_gain?.dB ?? null,
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

    const cache = readJsonSafe(TRACK_CACHE_PATH(), { version: 2, files: {} })
    if (cache.version !== 2) cache.files = {}
    const newCache = { version: 2, files: {} }
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
    console.error('Scan error:', e)
    return { albums: [] }
  } finally {
    _scanRunning = false
  }
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
    const key = `${(t.albumArtist||t.artist).toLowerCase()}_${t.album.toLowerCase()}`
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
      needsTranscode: t.needsTranscode || false, hasEmbeddedLyrics: t.hasEmbeddedLyrics || false,
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

ipcMain.on('update-now-playing',  (_, data)   => {
  writeNowPlaying(data)
  updateMpris(data)
  const nowTitle = data.title ? `${data.title} — ${data.artist || ''}` : null
  if (_trayNow.title !== nowTitle || _trayNow.playing !== !!data.playing) {
    _trayNow = { title: nowTitle, playing: !!data.playing }
    rebuildTrayMenu()
    if (tray) tray.setToolTip(nowTitle ? `Papa Audio — ${nowTitle}` : 'Papa Audio')
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
        if (isArchive) { try { new AdmZip(dest).extractAllTo(path.dirname(dest), true) } catch (_) {} }
        mainWindow?.webContents.send('dl-complete', { id: dlId, filename, dest, isMusic })
      } else if (state === 'cancelled') {
        mainWindow?.webContents.send('dl-cancelled', { id: dlId, filename })
      } else {
        mainWindow?.webContents.send('dl-failed', { id: dlId, filename })
      }
    })
  })
}

// Site-specific JS injected into autoDlView to trigger the download automatically
const AUTO_DL_SCRIPTS = {
  '__default__': `(function(){
    // Generic: prefer FLAC/lossless links, fall back to any download link
    const all = Array.from(document.querySelectorAll('a[href], button'));
    const priority = [
      o => /\\bflac\\b/i.test(o.textContent + (o.href||'')),
      o => /lossless|24.?bit|hi.?res|wav/i.test(o.textContent + (o.href||'')),
      o => /download/i.test(o.textContent),
      o => /\\.flac(\\?|$)/i.test(o.href||''),
      o => /\\.mp3(\\?|$)/i.test(o.href||''),
    ];
    for (const test of priority) {
      const match = all.find(test);
      if (match) { match.click(); return; }
    }
  })()`,
}

function createAutoDlView() {
  if (autoDlView) return
  ensureDlHandler()
  autoDlView = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true } })

  // Spoof a real Chrome user-agent so Cloudflare and other bot-checks pass
  autoDlView.webContents.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  )

  // Override all headers that reveal Electron/automation
  autoDlView.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    headers['User-Agent']        = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    headers['sec-ch-ua']         = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"'
    headers['sec-ch-ua-mobile']  = '?0'
    headers['sec-ch-ua-platform'] = '"Linux"'
    callback({ requestHeaders: headers })
  })

  autoDlView.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) autoDlView.webContents.loadURL(url)
    return { action: 'deny' }
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
  return new Promise((resolve, reject) => {
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
        res.on('end', () => resolve(full))
      }
    )
    req.on('error', reject)
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

// ── Quality Sources ──────────────────────────────────────────────────────────
const DEFAULT_QUALITY_SOURCES = [
  {
    id: 'hdtracks', name: 'HDtracks', enabled: false,
    searchUrl: 'https://www.hdtracks.com/#/search?q={query}',
    agentHint: 'Hi-res music store. Search for the album, click it, then look for the highest-resolution FLAC option and add to cart or download.'
  },
  {
    id: 'qobuz', name: 'Qobuz', enabled: false,
    searchUrl: 'https://open.qobuz.com/search/{query}',
    agentHint: 'Qobuz streaming service. Search results appear automatically. Click a track or album, then click the download button (requires account).'
  },
  {
    id: 'beets', name: 'Beets Music', enabled: false,
    searchUrl: 'https://beets.io/search?q={query}',
    agentHint: 'Music search. Find the track in results and click the download link.'
  },
]

const REMOVED_SOURCE_IDS = new Set(['lucida', 'monochrome', 'lydia'])

ipcMain.handle('get-quality-sources', () => {
  const stored = store.get('qualitySources', null)
  // Merge stored enabled/disabled state with default hints (hints may have been added/updated)
  if (!stored) return DEFAULT_QUALITY_SOURCES
  return DEFAULT_QUALITY_SOURCES.map(def => {
    const s = stored.find(x => x.id === def.id)
    if (!s) return def
    // Keep user's enabled state; always use the built-in hint (it gets updated with fixes)
    return { ...def, enabled: s.enabled }
  }).concat(stored.filter(s => !DEFAULT_QUALITY_SOURCES.find(d => d.id === s.id) && !REMOVED_SOURCE_IDS.has(s.id)))
})

ipcMain.handle('save-quality-sources', (_, sources) => {
  store.set('qualitySources', sources)
  return sources
})

ipcMain.handle('search-online-source', async (_, { url }) => {
  try {
    const buf  = await httpsGet(url)
    const html = buf.toString('utf8').toLowerCase()
    const NO_RESULT_PATTERNS = [
      'no results', '0 results', 'no result found', 'nothing found',
      'no matches', 'your search returned no', 'could not be found',
    ]
    const noResult = NO_RESULT_PATTERNS.some(p => html.includes(p))
    return { found: buf.length > 5000 && !noResult, size: buf.length }
  } catch (e) {
    return { found: false, error: e.message }
  }
})

const KNOWN_SOURCES = [
  { id: 'jukehost',   name: 'JukeHost',    searchUrl: 'https://www.jukehost.co.uk/search/{query}' },
  { id: 'bandcamp',   name: 'Bandcamp',    searchUrl: 'https://bandcamp.com/search?q={query}'     },
  { id: 'free-mp3',   name: 'Free MP3',    searchUrl: 'https://freemp3cloud.com/?s={query}'        },
  { id: 'archive',    name: 'Archive.org', searchUrl: 'https://archive.org/search?query={query}&and[]=mediatype%3A%22audio%22' },
]

ipcMain.handle('probe-known-sources', async () => {
  const results = await Promise.all(KNOWN_SOURCES.map(async (src) => {
    try {
      await httpsGet(src.searchUrl.replace('{query}', 'test'))
      return { ...src, reachable: true }
    } catch { return { ...src, reachable: false } }
  }))
  return results.filter(r => r.reachable)
})

ipcMain.handle('auto-download-from-source', async (_, { url, sourceId }) => {
  createAutoDlView()
  return new Promise((resolve) => {
    const TIMEOUT_MS = 30000
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => settle({ ok: false, error: 'Timeout' }), TIMEOUT_MS)

    autoDlView.webContents.once('did-finish-load', async () => {
      // Allow JS-heavy SPAs to render
      await new Promise(r => setTimeout(r, 2500))
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, '')
        const scriptKey = Object.keys(AUTO_DL_SCRIPTS).find(k => hostname.includes(k)) || '__default__'
        await autoDlView.webContents.executeJavaScript(AUTO_DL_SCRIPTS[scriptKey])
        // Give download a moment to trigger before resolving
        setTimeout(() => settle({ ok: true }), 1500)
      } catch (e) {
        settle({ ok: false, error: e.message })
      }
    })
    autoDlView.webContents.once('did-fail-load', (__, code, desc) => {
      settle({ ok: false, error: `Load failed: ${desc}` })
    })

    const safe = url.startsWith('http') ? url : `https://${url}`
    autoDlView.webContents.loadURL(safe)
  })
})

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
  try { await slskdFetch('DELETE', `/searches/${id}`) } catch (_) {}

  const results = responses || []
  if (results.length) _searchCacheSet(cacheKey, results)
  mainWindow?.webContents.send('slsk-progress', { query, results, done: true })
  return { results }
})

ipcMain.handle('slsk-download', async (_, { username, filename, size }) => {
  console.log('[slsk-download] username:', username, '| filename:', filename, '| size:', size)
  try {
    const res = await slskdFetch('POST', `/transfers/downloads/${encodeURIComponent(username)}`,
      [{ filename, size }])
    console.log('[slsk-download] OK:', JSON.stringify(res)?.slice(0, 200))
    return { ok: true }
  } catch (e) {
    console.error('[slsk-download] FAILED:', e.message)
    throw e
  }
})

ipcMain.handle('slsk-get-transfers', async () => {
  try {
    const data = await slskdFetch('GET', '/transfers/downloads')
    return data || []
  } catch (_) { return [] }
})

ipcMain.handle('slsk-cancel-transfer', async (_, { username, id }) => {
  try {
    // ?remove=true removes completed/failed transfers from the list; harmless for active ones
    await slskdFetch('DELETE', `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}?remove=true`)
  } catch (_) {}
  return { ok: true }
})

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

// ── YouTube ──────────────────────────────────────────────────────────────────
ipcMain.handle('yt-music-search', async (_, { query }) => {
  try { return { ok: true, results: await ytSearch.searchMusic(query) } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

ipcMain.handle('yt-search', async (_, { query }) => {
  try { return { ok: true, results: await ytSearch.searchAll(query) } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
})

const _ytDownloads = new Map()

function _ytEmit(dl) {
  mainWindow?.webContents.send('yt-dl-progress', { ...dl })
}

ipcMain.handle('yt-download', (_, { videoId, title, artist }) => {
  const id = `yt_${videoId}_${Date.now()}`
  const dl = { id, videoId, title, artist, percent: 0, state: 'downloading', error: null }
  _ytDownloads.set(id, dl)
  _ytEmit(dl)
  ytDownloader.downloadAudio({
    videoId, title, artist,
    outDir: _downloadDir(),
    onProgress: pct => {
      if (pct - dl.percent >= 1 || pct === 100) { dl.percent = pct; _ytEmit(dl) }
    },
  }).then(res => {
    dl.percent = res.ok ? 100 : dl.percent
    dl.state = res.ok ? 'completed' : 'failed'
    dl.error = res.ok ? null : res.error
    _ytEmit(dl)
  })
  return { ok: true, id }
})

ipcMain.handle('yt-get-downloads', () => [..._ytDownloads.values()])

ipcMain.handle('save-lyrics', async (_, { filePath, lrcContent }) => {
  try {
    const path = require('path')
    const lrcPath = filePath.replace(/\.[^/.]+$/, '.lrc')
    fs.writeFileSync(lrcPath, lrcContent, 'utf8')
    return { success: true, lrcPath }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('ctx-menu-show', (event, items) => new Promise(resolve => {
  const menu = new Menu()
  for (const item of (items || [])) {
    if (item === 'sep' || item?.type === 'separator') {
      menu.append(new MenuItem({ type: 'separator' }))
    } else if (item?.label) {
      menu.append(new MenuItem({ label: item.label, click: () => resolve(item.action) }))
    }
  }
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender), callback: () => resolve(null) })
}))

ipcMain.handle('slsk-resolve-file', (_, { username, filename }) => {
  const cfg = store.get('slskConfig', {})
  const folders = store.get('musicFolders', [])
  const downloadDir = cfg.downloadDir || folders[0] || path.join(app.getPath('home'), 'Music')
  const parts = (filename || '').replace(/\\/g, '/').split('/').filter(Boolean)
  if (!parts.length) return { path: null, downloadDir }

  // Build candidates from most-specific to least-specific and pick the first that exists on disk
  const tail1 = parts.slice(1)   // strip remote share root (most common slskd layout)
  const tail2 = parts.slice(2)   // strip two leading components
  const last2 = parts.slice(-2)  // just folder/filename
  const last1 = parts.slice(-1)  // just filename (flat download)

  const candidates = [
    // Most common: slskd strips remote root, stores as album/track
    tail1.length ? path.join(downloadDir, ...tail1) : null,
    // Full remote path under downloadDir
    path.join(downloadDir, ...parts),
    // Under username subdir
    tail1.length ? path.join(downloadDir, username, ...tail1) : null,
    path.join(downloadDir, username, ...parts),
    // Strip two leading components (e.g. username + share root)
    tail2.length ? path.join(downloadDir, ...tail2) : null,
    tail2.length ? path.join(downloadDir, username, ...tail2) : null,
    // Just the last two path parts (folder/file) – handles deep remote paths
    last2.length === 2 ? path.join(downloadDir, ...last2) : null,
    // Flat: just the filename in downloadDir root
    path.join(downloadDir, ...last1),
  ]

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return { path: c, downloadDir }
  }
  return { path: null, downloadDir }
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
