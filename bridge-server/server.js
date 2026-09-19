/**
 * Papa Audio Bridge Server
 * Exposes all Electron IPC logic as a REST API for the Android app.
 * Run: node server.js
 * Default port: 8765
 */

'use strict'

const express  = require('express')
const cors     = require('cors')
const fs       = require('fs')
const path     = require('path')
const crypto   = require('crypto')
const http     = require('http')
const https    = require('https')
const os       = require('os')
const { spawn, spawnSync } = require('child_process')
const { parseFile } = require('music-metadata')
const Store = require('electron-store')
const registerYouTube = require('./youtube')
const mediaLib = require('./media-lib')

// ── Config ────────────────────────────────────────────────────────────────────
// BRIDGE_PORT=0 asks the OS for an ephemeral port (what the tests use so they
// never contend with the real bridge on 8765). BRIDGE_HOST lets a test bind
// loopback-only instead of exposing the LAN.
const PORT        = process.env.BRIDGE_PORT !== undefined
  ? Number(process.env.BRIDGE_PORT) : 8765
const HOST        = process.env.BRIDGE_HOST || '0.0.0.0'
// PAPA_BRIDGE_USER_DATA redirects the config/artwork/token tree. Tests point it
// at a temp dir so they never read or write the real ~/.config/papa-audio.
const USER_DATA   = process.env.PAPA_BRIDGE_USER_DATA ||
  path.join(os.homedir(), '.config', 'papa-audio')
const ARTWORK_DIR = path.join(USER_DATA, 'artwork')
const SLSKD_BASE  = 'http://localhost:5030/api/v0'
const SLSKD_CREDS = { username: 'slskd', password: 'slskd' }
const MUSIC_EXT   = /\.(flac|mp3|wav|aiff?|m4a|aac|ogg|opus|ape|wv|wma|dsf|dff)$/i

fs.mkdirSync(USER_DATA,   { recursive: true })
fs.mkdirSync(ARTWORK_DIR, { recursive: true })

// The pairing token PERSISTS across restarts (a per-boot random token made
// pairing impossible — the phone's saved token died with every bridge restart).
// Generated once, kept in userData; delete the file to rotate it.
const TOKEN_FILE = path.join(USER_DATA, 'bridge-token')
const BRIDGE_TOKEN = (() => {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (/^[0-9a-f]{32}$/.test(t)) {
      // The file shipped 0644: every local account could read the pairing
      // token and then talk to the bridge as the phone. Tighten it in place.
      try { fs.chmodSync(TOKEN_FILE, 0o600) } catch (_) {}
      return t
    }
  } catch (_) {}
  const t = crypto.randomBytes(16).toString('hex')
  try { fs.writeFileSync(TOKEN_FILE, t, { encoding: 'utf8', mode: 0o600 }) } catch (_) {}
  return t
})()

// Compare a presented token against the real one WITHOUT leaking how far the
// match got. `===` on strings short-circuits at the first differing byte, which
// over a LAN is a measurable oracle for recovering the token a byte at a time.
const _TOKEN_BUF = Buffer.from(BRIDGE_TOKEN, 'utf8')
function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false
  const given = Buffer.from(candidate, 'utf8')
  if (given.length !== _TOKEN_BUF.length) {
    // Burn an equivalent compare so a wrong LENGTH is not faster than a wrong
    // VALUE, then refuse.
    crypto.timingSafeEqual(_TOKEN_BUF, _TOKEN_BUF)
    return false
  }
  return crypto.timingSafeEqual(given, _TOKEN_BUF)
}

// The announced bridge version + what this build can do, so the Android app can
// feature-detect instead of guessing. Bumped for the artwork + transcode work
// (roadmap #64).
const BRIDGE_VERSION = '1.1.0'

// Is ffmpeg on PATH? Checked once at startup: the transcode endpoint refuses
// politely when it is missing rather than spawning a command that is not there.
const FFMPEG_AVAILABLE = (() => {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return !r.error && r.status === 0
  } catch (_) { return false }
})()

// Optional transcode gate (roadmap #64), default ON. Off means the transcode
// query param is refused even when ffmpeg is present.
function bridgeTranscodeEnabled() {
  return store.get('bridgeTranscode', true) !== false
}

function bridgeCapabilities() {
  return {
    artwork: true,
    transcode: bridgeTranscodeEnabled() && FFMPEG_AVAILABLE,
    transcodeFormats: (bridgeTranscodeEnabled() && FFMPEG_AVAILABLE)
      ? Object.keys(mediaLib.TRANSCODE_FORMATS) : [],
    ffmpeg: FFMPEG_AVAILABLE,
  }
}

// Re-use the same electron-store data files the desktop app writes.
//
// NOTE the narrowed job: config.json is now only the SETTINGS keys
// (musicFolders, volume, eqSettings, slskConfig, …). The eight big/hot keys —
// libraryCache, playbackState, recentlyPlayed, playHistory, playCounts,
// savedQueues, playlists, likedTracks — were moved to SideStore files on
// 2026-08-27 and the desktop's retireLegacyKeys() deletes them from here. Read
// those through `sideValue()` below, never through `store`.
const store = new Store({ name: 'config', cwd: USER_DATA })

// ── The desktop's SideStore files ─────────────────────────────────────────────
// Read-only. The desktop is the single writer; a phone-side mutation is queued
// in the bridge's own inbox and overlaid on the read, so the phone sees its own
// action without a second process writing the desktop's files. See
// side-store-read.js and inbox.js.
const { createSideReader } = require('./side-store-read')
const inbox = require('./inbox')
const sideRead = createSideReader(USER_DATA)

// The desktop's value for `key`, with any not-yet-ingested phone mutations
// replayed on top.
function sideValue(key) {
  const base = sideRead.get(key)
  const queued = inbox.readInbox(USER_DATA).ops
  return inbox.applyInbox(key, base, queued)
}

// Queue a phone-side mutation. Answers 202 (accepted, not yet applied by the
// desktop) so a client can tell "written" from "queued" if it ever wants to.
function queueMutation(res, type, payload) {
  try {
    inbox.append(USER_DATA, type, payload)
    return res.status(202).json({ ok: true, queued: true })
  } catch (e) {
    console.error(`[bridge] inbox write failed (${e && e.message})`)
    return res.status(500).json({ error: 'Could not record the change' })
  }
}

// ── Path containment ──────────────────────────────────────────────────────────
// Is `child` the same as, or underneath, `parent`?
//
// This replaces a bare `resolved.startsWith(path.resolve(folder))`, which is a
// *string* prefix test, not a *directory* containment test: with the library at
// /mnt/data/MUSIC it happily accepted /mnt/data/MUSIC-private/anything, because
// that string does start with "/mnt/data/MUSIC". Comparing against the parent
// plus a trailing separator makes the boundary a real directory boundary.
//
// Note both sides go through path.resolve(), which already collapses "..", so
// /mnt/data/MUSIC/../etc/passwd becomes /mnt/data/etc/passwd and fails the test
// on its own. The sibling-directory escape was the live hole, not "..".
//
// Caveat (deliberately not enforced): resolve() is lexical, so a symlink that
// lives inside the library and points outside it still passes. Enforcing
// realpath() containment would break libraries that are legitimately assembled
// out of symlinks, so that stays a documented limitation.
function isInside(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false
  if (!child || !parent) return false
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (c === p) return true
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

// ── Safe file → response piping ───────────────────────────────────────────────
// `stream.pipe(res)` does not forward errors. An 'error' on a stream with no
// listener is an uncaught exception, which in Node kills the process — so one
// unreadable file (deleted mid-request, a directory, a permissions change) took
// the whole bridge down and LAN playback with it until the desktop app was
// restarted. Every read here goes through this helper instead.
function pipeFile(stream, res, label) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    stream.destroy()
  }
  stream.on('error', (err) => {
    if (done) return
    console.error(`[bridge] ${label} read failed: ${err && err.message}`)
    if (!res.headersSent) {
      finish()
      res.status(500).json({ error: 'Stream failed' })
      return
    }
    // Headers (and a Content-Length) are already on the wire; the only honest
    // signal left is an aborted transfer, so the client retries instead of
    // caching a truncated file.
    finish()
    res.destroy()
  })
  // A dead client, or a response-side error, must not leave the read fd open.
  res.on('error', finish)
  res.on('close', finish)
  stream.pipe(res)
  return stream
}

// ── Range requests ────────────────────────────────────────────────────────────
// Parse a single-range `Range: bytes=...` header against a known file size.
// Returns null when there is no usable range (serve the whole file), an
// { unsatisfiable: true } marker when the client asked for bytes past the end
// (RFC 9110 says answer 416), or a clamped { start, end } pair.
//
// The naive `parseInt(parts[0])` this replaces produced NaN for the perfectly
// legal suffix form `bytes=-500`, wrote `Content-Length: NaN` to the wire and
// then threw ERR_OUT_OF_RANGE out of createReadStream after the headers had
// already gone — a dead response the client could only read as a hang.
function parseRange(header, total) {
  if (!header || typeof header !== 'string') return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  if (total <= 0) return { unsatisfiable: true }

  let start, end
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const n = Number(rawEnd)
    if (!Number.isFinite(n) || n <= 0) return { unsatisfiable: true }
    start = Math.max(0, total - n)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? total - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    if (start >= total) return { unsatisfiable: true }
    if (end > total - 1) end = total - 1
    if (end < start) return { unsatisfiable: true }
  }
  return { start, end }
}

// ── Soulseek auth ─────────────────────────────────────────────────────────────
let slskToken  = null
let slskExpiry = 0

async function slskAcquireToken() {
  const res = await fetch(`${SLSKD_BASE}/session`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(SLSKD_CREDS),
  })
  if (!res.ok) return false
  const data = await res.json()
  slskToken  = data.token
  slskExpiry = Date.now() + (data.expiresAt
    ? new Date(data.expiresAt).getTime() - Date.now() - 60000
    : 55 * 60 * 1000)
  return true
}

async function slskFetch(method, endpoint, body) {
  if (!slskToken || Date.now() > slskExpiry) await slskAcquireToken()
  const opts = {
    method,
    headers: { Authorization: `Bearer ${slskToken}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
  let res = await fetch(`${SLSKD_BASE}${endpoint}`, opts)
  if (res.status === 401) {
    await slskAcquireToken()
    opts.headers.Authorization = `Bearer ${slskToken}`
    res = await fetch(`${SLSKD_BASE}${endpoint}`, opts)
  }
  if (method === 'DELETE') return null
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

// ── Library helpers (copied from main.js) ─────────────────────────────────────
async function scanDir(dir) {
  const results = []
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory())                        results.push(...(await scanDir(full)))
      else if (entry.isFile() && MUSIC_EXT.test(entry.name)) results.push(full)
    }
  } catch (_) {}
  return results
}

async function buildAlbums(tracks) {
  const map = new Map()
  for (const t of tracks) {
    const key = `${(t.albumArtist || t.artist).toLowerCase()}_${t.album.toLowerCase()}`
    if (!map.has(key)) {
      map.set(key, {
        id: crypto.createHash('md5').update(key).digest('hex'),
        name: t.album, artist: t.albumArtist || t.artist,
        year: t.year, artPath: t.artPath, tracks: [],
      })
    }
    const album = map.get(key)
    if (!album.artPath && t.artPath) album.artPath = t.artPath
    if (t.addedAt > (album._maxAddedAt || 0)) album._maxAddedAt = t.addedAt
    album.tracks.push({
      id: t.id, title: t.title, artist: t.artist, genre: t.genre || null,
      trackNumber: t.trackNumber, discNumber: t.discNumber,
      duration: t.duration, filePath: t.filePath,
      sampleRate: t.sampleRate || 0, bitsPerSample: t.bitsPerSample || 0,
    })
  }
  for (const [, a] of map) {
    if (!a.artPath) {
      const cached = path.join(ARTWORK_DIR, `${a.id}.jpg`)
      try { await fs.promises.stat(cached); a.artPath = cached } catch (_) {}
    }
    a.tracks.sort((x, y) => x.discNumber - y.discNumber || x.trackNumber - y.trackNumber)
    a.maxBitsPerSample = Math.max(0, ...a.tracks.map(t => t.bitsPerSample || 0))
    a.maxSampleRate    = Math.max(0, ...a.tracks.map(t => t.sampleRate    || 0))
    a.isHiRes  = a.maxBitsPerSample >= 24 && a.maxSampleRate > 48000
    const gc = {}
    for (const t of a.tracks) if (t.genre) gc[t.genre] = (gc[t.genre] || 0) + 1
    a.genre   = Object.entries(gc).sort((x, y) => y[1] - x[1])[0]?.[0] || null
    a.addedAt = a._maxAddedAt || 0
    delete a._maxAddedAt
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ── HTTPS helper ──────────────────────────────────────────────────────────────
function httpsGet(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'))
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
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

// ── Search cache ──────────────────────────────────────────────────────────────
// Hard-capped, not just TTL-swept: see createTtlCache in media-lib.js.
const _searchCache = mediaLib.createTtlCache({ ttlMs: 5 * 60 * 1000, max: 200 })
function searchCacheGet(key) { return _searchCache.get(key) }
function searchCacheSet(key, results) { _searchCache.set(key, results) }

// ── SSE helpers ───────────────────────────────────────────────────────────────
const _sseClients = new Set()
const SSE_MAX_CLIENTS = 32

function sseSend(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of _sseClients) {
    try { res.write(msg) } catch (_) { _sseClients.delete(res) }
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express()
// `trust proxy` makes req.ip come from the client-supplied X-Forwarded-For
// header. Nothing sits in front of this server — it binds the LAN directly —
// so trusting that header handed every caller a free rename: a fresh forged IP
// per request bypassed the rate limiter entirely and grew its bookkeeping map
// one entry per forgery. Opt in only if a real reverse proxy is ever added.
if (process.env.BRIDGE_TRUST_PROXY === '1') app.set('trust proxy', true)
app.use(cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true)
    const allowed = /^(https?:\/\/)?(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin)
    if (allowed) cb(null, true)
    else cb(null, false)
  }
}))
app.use(express.json({ limit: '10mb' }))

// ── Auth middleware ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/api/health') return next()
  // /stream and /art gate both the query-string form (?path=) and the id-keyed
  // form the Android bridge added (/stream/<trackId>, /art/<albumId>.jpg).
  // /events is guarded too: it is a live feed of what is being searched,
  // downloaded and played, so leaving it open let anything on the LAN subscribe
  // to the user's activity without the pairing token.
  const guarded = req.path.startsWith('/api/') ||
    req.path === '/stream' || req.path.startsWith('/stream/') ||
    req.path === '/art' || req.path.startsWith('/art/') ||
    req.path === '/events'
  if (!guarded) return next()
  const auth = req.headers.authorization
  // Media routes (/stream*, /art*) also accept ?token= — the phone's player
  // and image components consume plain URLs and cannot attach headers. /events
  // is in the same boat: EventSource cannot set an Authorization header.
  const isMedia = req.path === '/stream' || req.path.startsWith('/stream/') ||
    req.path === '/art' || req.path.startsWith('/art/') ||
    req.path === '/events'
  const queryTok = isMedia ? req.query.token : undefined
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice(7) : null
  if (tokenMatches(bearer) || tokenMatches(queryTok)) return next()
  return res.status(401).json({ error: 'Unauthorized' })
})

// ── Rate limiter ──────────────────────────────────────────────────────────────
const rateLimit = new Map()
// Overridable so the tests can drive the limiter to its edge in a few requests
// instead of sixty.
const RATE_LIMIT_MAX = Number(process.env.BRIDGE_RATE_LIMIT_MAX) > 0
  ? Number(process.env.BRIDGE_RATE_LIMIT_MAX) : 60
const RATE_LIMIT_WINDOW = 60 * 1000
// A LAN sees a handful of clients; anything beyond this is a forged-key flood,
// and the map must not grow with it.
const RATE_LIMIT_MAX_KEYS = 1024

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  let entry = rateLimit.get(ip)
  if (!entry || now > entry.resetAt) {
    if (rateLimit.size >= RATE_LIMIT_MAX_KEYS) {
      // Drop the oldest key rather than let the table grow unbounded.
      rateLimit.delete(rateLimit.keys().next().value)
    }
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW }
    rateLimit.set(ip, entry)
  }
  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests' })
  }
  next()
})

setInterval(() => {
  const now = Date.now()
  for (const [ip, e] of rateLimit) if (now > e.resetAt) rateLimit.delete(ip)
}, 300000)

// ── SSE event stream ──────────────────────────────────────────────────────────
app.get('/events', (req, res) => {
  // A subscriber that never closes cleanly would otherwise sit in the Set for
  // the life of the process; cap the fan-out so a client loop cannot grow it
  // without bound.
  if (_sseClients.size >= SSE_MAX_CLIENTS) {
    return res.status(503).json({ error: 'Too many event subscribers' })
  }
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  res.write('event: connected\ndata: {}\n\n')
  _sseClients.add(res)
  const drop = () => _sseClients.delete(res)
  // Without the 'error' listener a socket that dies mid-write raises an
  // unhandled 'error' on the response and takes the process with it.
  res.on('error', drop)
  res.on('close', drop)
  req.on('close', drop)
})

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({
  ok: true,
  version: BRIDGE_VERSION,
  capabilities: bridgeCapabilities(),
}))

// ── App info ──────────────────────────────────────────────────────────────────
app.get('/api/app-info', (_, res) => res.json({
  musicFolders:   store.get('musicFolders', []),
  savedSites:     store.get('savedSites', []),
  recentlyPlayed: sideValue('recentlyPlayed') || [],
  volume:         store.get('volume', 0.8),
}))

// Decorate each album with an `artUrl` (roadmap #64): the id-keyed artwork
// endpoint the Android app can hit without knowing the on-disk artPath. Only
// albums that actually have art on disk get a URL; the rest stay null so the
// client falls back to its own placeholder rather than requesting a 404.
function withArtUrls(albums) {
  if (!Array.isArray(albums)) return albums
  return albums.map(a => (a && a.id && a.artPath)
    ? Object.assign({}, a, { artUrl: `/art/${a.id}.jpg` })
    : a)
}

// ── Library ───────────────────────────────────────────────────────────────────
app.get('/api/library', (_, res) => {
  const cached = sideValue('libraryCache')
  if (cached) return res.json({ albums: withArtUrls(cached), cached: true })
  res.json({ albums: [], cached: false })
})

app.post('/api/library/scan', async (_, res) => {
  const folders = store.get('musicFolders', [])
  if (!folders.length) return res.json({ albums: [] })
  try {
    const allFiles = (await Promise.all(folders.map(f => scanDir(f)))).flat()
    const tracks = []
    for (const filePath of allFiles) {
      try {
        const meta = await parseFile(filePath, { duration: true })
        const c = meta.common, f = meta.format
        const pic = c.picture?.[0]
        let artPath = null
        if (pic) {
          const ext = pic.format.includes('png') ? 'png' : 'jpg'
          const key = crypto.createHash('md5').update((c.albumartist||c.artist||'')+(c.album||'')).digest('hex')
          artPath = path.join(ARTWORK_DIR, `${key}.${ext}`)
          try { await fs.promises.stat(artPath) } catch (_) { await fs.promises.writeFile(artPath, pic.data) }
        }
        tracks.push({
          id: crypto.createHash('md5').update(filePath).digest('hex'),
          title: c.title || path.basename(filePath, path.extname(filePath)),
          artist: c.artist || c.albumartist || 'Unknown Artist',
          albumArtist: c.albumartist || c.artist || 'Unknown Artist',
          album: c.album || 'Unknown Album',
          trackNumber: c.track?.no || 0, discNumber: c.disk?.no || 1,
          year: c.year || null, genre: c.genre?.[0] || null,
          duration: f.duration || 0, sampleRate: f.sampleRate || 0,
          bitsPerSample: f.bitsPerSample || 0, channels: f.numberOfChannels || 0,
          addedAt: await fs.promises.stat(filePath).then(s => s.mtimeMs).catch(() => 0),
          filePath, artPath,
        })
      } catch (_) {}
    }
    const albums = await buildAlbums(tracks)
    // Deliberately NOT persisted. The library cache is the desktop's
    // library-cache.json now; writing it from here made the bridge a second
    // writer AND (before that) pushed ~1.6 MB back into config.json on every
    // scan, which is where the orphaned config.json.tmp-* files came from.
    // The scan result is returned to the caller and nothing else.
    res.json({ albums: withArtUrls(albums), persisted: false })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// /api/library/cache is gone: it let the phone overwrite the desktop's library
// cache wholesale. The desktop owns library-cache.json.

// ── Music streaming ───────────────────────────────────────────────────────────
app.get('/stream', async (req, res) => {
  const filePath = req.query.path
  if (!filePath) return res.status(400).json({ error: 'Missing path parameter' })

  const folders = store.get('musicFolders', [])
  const resolved = path.resolve(filePath)
  const allowed = folders.some(function(f) { return isInside(resolved, f) })
  if (!allowed) return res.status(403).json({ error: 'Access denied: path outside music folders' })
  // Containment alone is not an allow-list. A music root holds .cue, .log,
  // .txt, .nfo and whatever else came down with an album; this route exists to
  // serve AUDIO, so anything else is refused rather than handed to the LAN.
  if (!MUSIC_EXT.test(resolved)) {
    return res.status(403).json({ error: 'Access denied: not an audio file' })
  }

  let stat
  try { stat = await fs.promises.stat(filePath) } catch (_) {
    return res.status(404).json({ error: 'File not found' })
  }

  const total = stat.size
  const range = req.headers.range

  const ext = path.extname(filePath).toLowerCase()
  const mimeMap = {
    '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.m4a': 'audio/mp4',
    '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
    '.ape': 'audio/ape', '.wv': 'audio/x-wavpack', '.wma': 'audio/x-ms-wma',
  }
  const mime = mimeMap[ext] || 'audio/mpeg'

  const etag = '"' + stat.mtimeMs.toString(36) + '-' + stat.size.toString(36) + '"'

  const wanted = parseRange(range, total)
  if (wanted && wanted.unsatisfiable) {
    res.status(416).set({ 'Content-Range': `bytes */${total}` }).end()
    return
  }
  if (wanted) {
    const { start, end } = wanted
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   mime,
      'Cache-Control':  'no-cache',
      'ETag':           etag,
    })
    pipeFile(fs.createReadStream(filePath, { start, end }), res, '/stream')
  } else {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'ETag': etag })
    pipeFile(fs.createReadStream(filePath), res, '/stream')
  }
})

// ── Album art ─────────────────────────────────────────────────────────────────
app.get('/art', async (req, res) => {
  const artPath = req.query.path
  if (!artPath) return res.status(400).json({ error: 'Missing path parameter' })

  const resolved = path.resolve(artPath)
  if (!pathAllowed(resolved)) return res.status(403).json({ error: 'Access denied' })

  let artStat
  try { artStat = await fs.promises.stat(artPath) } catch (_) { return res.status(404).send('Not found') }
  const ext = path.extname(artPath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
  res.setHeader('Content-Type', mime)
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.setHeader('ETag', '"' + artStat.mtimeMs.toString(36) + '-' + artStat.size.toString(36) + '"')
  pipeFile(fs.createReadStream(artPath), res, '/art')
})

// Whether a resolved path is inside the music folders or the shared artwork
// cache — the same allow-list every art/stream route enforces, in one place.
// ARTWORK_DIR rather than a second hardcoded ~/.config/papa-audio/artwork, so
// the allow-list follows USER_DATA instead of silently diverging from it.
function pathAllowed(resolved) {
  const folders = store.get('musicFolders', [])
  return folders.some(function(f) { return isInside(resolved, f) }) ||
    isInside(resolved, ARTWORK_DIR)
}

// ── Album art by id (roadmap #64) ───────────────────────────────────────────
// GET /art/<albumId>.jpg — serve the album's artPath resolved from the library
// cache, so the Android app can request art without knowing the on-disk path.
app.get('/art/:albumId.jpg', async (req, res) => {
  const albums = sideValue('libraryCache')
  const { artById } = mediaLib.buildAlbumIndex(albums)
  const artPath = artById.get(String(req.params.albumId))
  if (!artPath) return res.status(404).send('Not found')

  const resolved = path.resolve(artPath)
  if (!pathAllowed(resolved)) return res.status(403).json({ error: 'Access denied' })

  let artStat
  try { artStat = await fs.promises.stat(artPath) } catch (_) { return res.status(404).send('Not found') }
  const ext = path.extname(artPath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
  res.setHeader('Content-Type', mime)
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.setHeader('ETag', '"' + artStat.mtimeMs.toString(36) + '-' + artStat.size.toString(36) + '"')
  pipeFile(fs.createReadStream(artPath), res, '/art/:albumId')
})

// ── Transcoded stream by id (roadmap #64) ───────────────────────────────────
// GET /stream/<trackId>?fmt=mp3 — resolve the track from the library cache and
// stream it re-encoded to the requested format via ffmpeg. Without ?fmt it is a
// plain re-encode-free passthrough of the original file (with range support).
// The gate + ffmpeg presence are checked by mediaLib.transcodeDecision, which
// returns a polite reason when the request cannot be honoured.
app.get('/stream/:trackId', async (req, res) => {
  const albums = sideValue('libraryCache')
  const { trackById } = mediaLib.buildAlbumIndex(albums)
  const filePath = trackById.get(String(req.params.trackId))
  if (!filePath) return res.status(404).json({ error: 'Track not found' })

  const resolved = path.resolve(filePath)
  const folders = store.get('musicFolders', [])
  if (!folders.some(function(f) { return isInside(resolved, f) })) {
    return res.status(403).json({ error: 'Access denied: path outside music folders' })
  }
  if (!MUSIC_EXT.test(resolved)) {
    return res.status(403).json({ error: 'Access denied: not an audio file' })
  }
  try { await fs.promises.stat(filePath) } catch (_) {
    return res.status(404).json({ error: 'File not found' })
  }

  const fmt = req.query.fmt
  // No fmt → the client wants the original bytes. Stream them with range support
  // so a seek on the Android side works, mirroring the path-based /stream route.
  if (!fmt) {
    const stat = await fs.promises.stat(filePath)
    const total = stat.size
    const ext = path.extname(filePath).toLowerCase()
    const mimeMap = {
      '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
      '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.m4a': 'audio/mp4',
      '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
      '.ape': 'audio/ape', '.wv': 'audio/x-wavpack', '.wma': 'audio/x-ms-wma',
    }
    const mime = mimeMap[ext] || 'audio/mpeg'
    const etag = '"' + stat.mtimeMs.toString(36) + '-' + stat.size.toString(36) + '"'
    const wanted = parseRange(req.headers.range, total)
    if (wanted && wanted.unsatisfiable) {
      return res.status(416).set({ 'Content-Range': `bytes */${total}` }).end()
    }
    if (wanted) {
      const { start, end } = wanted
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
        'Content-Type': mime, 'Cache-Control': 'no-cache', 'ETag': etag,
      })
      return pipeFile(fs.createReadStream(filePath, { start, end }), res, '/stream/:trackId')
    }
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'ETag': etag })
    return pipeFile(fs.createReadStream(filePath), res, '/stream/:trackId')
  }

  const decision = mediaLib.transcodeDecision({
    fmt,
    bridgeTranscode: bridgeTranscodeEnabled(),
    ffmpegAvailable: FFMPEG_AVAILABLE,
  })
  if (!decision.ok) return res.status(decision.status).json({ error: decision.reason })

  const args = mediaLib.transcodeArgs(filePath, decision.spec)
  const ff = spawn('ffmpeg', args)
  res.setHeader('Content-Type', decision.spec.mime)
  res.setHeader('Accept-Ranges', 'none')
  res.setHeader('Cache-Control', 'no-cache')
  ff.stdout.pipe(res)
  ff.stderr.on('data', () => {}) // errors are surfaced by a non-zero exit below
  ff.on('error', (e) => {
    if (!res.headersSent) res.status(500).json({ error: 'Transcode failed: ' + e.message })
    else res.destroy()
  })
  ff.on('close', (code) => {
    if (code !== 0 && !res.headersSent) res.status(500).json({ error: 'Transcode exited ' + code })
    else res.end()
  })
  // Client hung up mid-stream: stop wasting CPU on a transcode nobody is reading.
  req.on('close', () => { try { ff.kill('SIGKILL') } catch (_) {} })
})

// The album id becomes a FILE NAME under ARTWORK_DIR, so it has to be a name
// and not a path. Ids in the wild are two shapes: the desktop/bridge md5 hex
// (32 chars) and the Android local-scan djb2 base36 (short). Both are covered
// by a bare alphanumeric token; anything with a dot or a separator in it was an
// attempt to write outside the artwork cache — `../../../../tmp/x.jpg` did
// exactly that, and the blanket catch returned 200 null so it looked like a
// harmless miss.
const ALBUM_ID = /^[A-Za-z0-9_-]{1,64}$/

app.post('/api/fetch-album-art', async (req, res) => {
  const { albumId, artist, album } = req.body || {}
  if (!ALBUM_ID.test(String(albumId || ''))) {
    return res.status(400).json({ error: 'Invalid albumId' })
  }
  if (typeof artist !== 'string' || typeof album !== 'string') {
    return res.status(400).json({ error: 'artist and album are required' })
  }
  try {
    const cached = path.join(ARTWORK_DIR, `${albumId}.jpg`)
    if (fs.existsSync(cached)) return res.json({ artPath: cached })
    const query = encodeURIComponent(`${artist} ${album}`)
    const raw   = await httpsGet(`https://itunes.apple.com/search?term=${query}&entity=album&limit=8&media=music`)
    const data  = JSON.parse(raw.toString())
    if (!data.results?.length) return res.json(null)
    const al = album.toLowerCase(), ar = artist.toLowerCase().split(/\s+/)[0]
    const best = data.results.find(r =>
      r.collectionName?.toLowerCase().includes(al) && r.artistName?.toLowerCase().includes(ar)
    ) || data.results.find(r => r.collectionName?.toLowerCase().includes(al)) || data.results[0]
    if (!best?.artworkUrl100) return res.json(null)
    const imgBuf = await httpsGet(best.artworkUrl100.replace('100x100bb', '600x600bb'))
    fs.writeFileSync(cached, imgBuf)
    res.json({ artPath: cached })
  } catch (e) {
    // "No artwork exists" is `null` above. THIS is "the lookup broke", and
    // reporting it as a miss hid both a traversal and every iTunes outage.
    console.error(`[bridge] fetch-album-art failed: ${e && e.message}`)
    res.status(502).json({ error: 'Artwork lookup failed' })
  }
})

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings/liked',           (_, res) => res.json(store.get('likedAlbums', [])))
app.post('/api/settings/liked',          (req, res) => { store.set('likedAlbums', req.body.ids); res.json({ ok: true }) })

app.get('/api/settings/liked-tracks',    (_, res) => res.json(sideValue('likedTracks') || []))
app.post('/api/settings/liked-tracks',   (req, res) =>
  queueMutation(res, 'likedTracks.set', { paths: Array.isArray(req.body && req.body.paths) ? req.body.paths : [] }))

app.get('/api/settings/play-counts',     (_, res) => res.json(sideValue('playCounts') || {}))
app.post('/api/settings/play-counts/increment', (req, res) => {
  const filePath = req.body && req.body.filePath
  if (!filePath) return res.status(400).json({ error: 'filePath required' })
  return queueMutation(res, 'playCounts.increment', { filePath })
})

app.get('/api/settings/play-history',    (_, res) => res.json(sideValue('playHistory') || []))
app.post('/api/settings/play-history',   (req, res) =>
  queueMutation(res, 'playHistory.push', { entry: req.body }))

app.get('/api/settings/followed-artists',  (_, res) => res.json(store.get('followedArtists', [])))
app.post('/api/settings/followed-artists', (req, res) => { store.set('followedArtists', req.body.artists); res.json({ ok: true }) })

app.get('/api/settings/playlists',         (_, res) => res.json(sideValue('playlists') || []))
app.post('/api/settings/playlists',        (req, res) => {
  if (!req.body || !req.body.id) return res.status(400).json({ error: 'playlist id required' })
  return queueMutation(res, 'playlists.upsert', { playlist: req.body })
})
app.delete('/api/settings/playlists/:id', (req, res) =>
  queueMutation(res, 'playlists.delete', { id: req.params.id }))

app.get('/api/settings/saved-queues',      (_, res) => res.json(sideValue('savedQueues') || []))
app.post('/api/settings/saved-queues',     (req, res) => {
  if (!req.body || !req.body.id) return res.status(400).json({ error: 'queue id required' })
  return queueMutation(res, 'savedQueues.upsert', { queue: req.body })
})
app.delete('/api/settings/saved-queues/:id', (req, res) =>
  queueMutation(res, 'savedQueues.delete', { id: req.params.id }))

app.get('/api/settings/eq',               (_, res) => res.json(store.get('eqSettings', { enabled: true, gains: [0,0,0,0,0,0,0,0,0,0], replayGainMode: 'track', preamp: 0 })))
app.post('/api/settings/eq',              (req, res) => { store.set('eqSettings', req.body); res.json({ ok: true }) })

app.get('/api/settings/volume',           (_, res) => res.json({ volume: store.get('volume', 0.8) }))
app.post('/api/settings/volume',          (req, res) => { store.set('volume', req.body.volume); res.json({ ok: true }) })

app.get('/api/settings/recently-played', (_, res) => res.json(sideValue('recentlyPlayed') || []))
app.post('/api/settings/recently-played', (req, res) => {
  if (!req.body || req.body.id === undefined) return res.status(400).json({ error: 'id required' })
  return queueMutation(res, 'recentlyPlayed.push', { id: req.body.id })
})

app.get('/api/settings/playback-state',   (_, res) => res.json(sideValue('playbackState') ?? null))
app.post('/api/settings/playback-state',  (req, res) =>
  queueMutation(res, 'playbackState.set', { state: req.body }))

// /api/settings/agent-keys is gone. It handed every AI provider key in the
// user's config to anyone holding the pairing token, and let them be replaced.
// The keys are desktop-only; the Android app never called this.

app.get('/api/settings/agent-model',      (_, res) => res.json({ model: store.get('agentModel', '') }))
app.post('/api/settings/agent-model',     (req, res) => { store.set('agentModel', req.body.model); res.json({ ok: true }) })

// Transcode gate (roadmap #64): read/write the bridgeTranscode config the
// id-keyed /stream endpoint honours. The read also reports whether ffmpeg is
// present so a client can grey out the option when transcoding is impossible.
app.get('/api/settings/transcode',        (_, res) => res.json({ enabled: bridgeTranscodeEnabled(), ffmpeg: FFMPEG_AVAILABLE }))
app.post('/api/settings/transcode',       (req, res) => { store.set('bridgeTranscode', !!req.body.enabled); res.json({ enabled: bridgeTranscodeEnabled(), ffmpeg: FFMPEG_AVAILABLE }) })

// ── Soulseek status ───────────────────────────────────────────────────────────
app.get('/api/slsk/status', async (_, res) => {
  try {
    const data = await slskFetch('GET', '/application')
    res.json({
      installed: true, running: true,
      connected: data?.server?.isLoggedIn ?? false,
      username: data?.user?.username || '',
    })
  } catch {
    res.json({ installed: false, running: false, connected: false })
  }
})

// ── Soulseek search (streaming SSE results) ───────────────────────────────────
app.post('/api/slsk/search', async (req, res) => {
  const { query, timeoutMs = 25000 } = req.body
  if (!query) return res.status(400).json({ error: 'query required' })

  const cacheKey = query.toLowerCase().trim()
  const cached   = searchCacheGet(cacheKey)
  if (cached) return res.json({ results: cached, cached: true })

  try {
    const capMs  = Math.min(timeoutMs, 30000)
    const search = await slskFetch('POST', '/searches', {
      searchText: query, filterResponses: false,
      minimumResponseFileCount: 1, minimumPeerUploadSpeed: 0,
      fileLimit: 10000, responseLimit: 5000, searchTimeout: capMs,
    })
    const id = search?.id
    if (!id) return res.status(500).json({ error: 'Search failed to start' })

    const start = Date.now()
    let lastCount = 0

    while (true) {
      await new Promise(r => setTimeout(r, 800))
      const elapsed = Date.now() - start
      if (elapsed > capMs + 4000) break
      const st = await slskFetch('GET', `/searches/${id}`)
      const partial = await slskFetch('GET', `/searches/${id}/responses`)
      const count = (partial || []).length
      if (count !== lastCount) {
        lastCount = count
        sseSend('slsk-progress', { query, results: partial || [], done: false })
      }
      if (st?.state?.includes('Completed')) break
      if (elapsed >= 7000  && lastCount >= 60) break
      if (elapsed >= 12000 && lastCount >= 20) break
      if (elapsed >= 18000 && lastCount >=  5) break
    }

    const responses = await slskFetch('GET', `/searches/${id}/responses`)
    try { await slskFetch('DELETE', `/searches/${id}`) } catch (_) {}
    const results = responses || []
    if (results.length) searchCacheSet(cacheKey, results)
    sseSend('slsk-progress', { query, results, done: true })
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Soulseek download ─────────────────────────────────────────────────────────
app.post('/api/slsk/download', async (req, res) => {
  const { username, filename, size } = req.body
  try {
    await slskFetch('POST', `/transfers/downloads/${encodeURIComponent(username)}`, [{ filename, size }])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/slsk/transfers', async (_, res) => {
  try {
    const data = await slskFetch('GET', '/transfers/downloads')
    res.json(data || [])
  } catch { res.json([]) }
})

app.delete('/api/slsk/transfers/:username/:id', async (req, res) => {
  try {
    await slskFetch('DELETE', `/transfers/downloads/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.id)}?remove=true`)
    res.json({ ok: true })
  } catch { res.json({ ok: true }) }
})

app.get('/api/slsk/resolve', (req, res) => {
  const { username, filename } = req.query
  const cfg         = store.get('slskConfig', {})
  const folders     = store.get('musicFolders', [])
  const downloadDir = cfg.downloadDir || folders[0] || path.join(os.homedir(), 'Music')
  // The filename comes from a Soulseek peer, so ".." segments in it would walk
  // path.join() straight out of the download directory and let the caller probe
  // for files anywhere on disk.
  const parts       = mediaLib.safeSegments(filename)
  if (!parts.length) return res.json({ path: null, downloadDir })

  const tail1 = parts.slice(1)
  const tail2 = parts.slice(2)
  const last2 = parts.slice(-2)
  const last1 = parts.slice(-1)
  const candidates = [
    tail1.length ? path.join(downloadDir, ...tail1) : null,
    path.join(downloadDir, ...parts),
    tail1.length ? path.join(downloadDir, username, ...tail1) : null,
    tail2.length ? path.join(downloadDir, ...tail2) : null,
    last2.length === 2 ? path.join(downloadDir, ...last2) : null,
    path.join(downloadDir, ...last1),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return res.json({ path: c, downloadDir })
  }
  res.json({ path: null, downloadDir })
})

// ── Network info (for QR code setup) ─────────────────────────────────────────
app.get('/api/network', (_, res) => {
  const interfaces = os.networkInterfaces()
  const ips = []
  for (const iface of Object.values(interfaces)) {
    for (const addr of (iface || [])) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address)
    }
  }
  // Report the port actually bound (BRIDGE_PORT=0 means the OS chose one), so
  // the QR code a client scans points somewhere real.
  const bound = server.address()
  res.json({ ips, port: (bound && bound.port) || PORT })
})

// ── Music folder management ───────────────────────────────────────────────────
app.get('/api/folders', (_, res) => res.json(store.get('musicFolders', [])))
// POST/DELETE /api/folders are gone. musicFolders IS the allow-list every
// /stream and /art route checks against, so a route that appends to it let a
// token holder add "/" and then read any file on disk through /stream?path=.
// It only checked fs.existsSync. The music roots are the desktop's to choose;
// the Android app never called these.

// ── Start ─────────────────────────────────────────────────────────────────────
// YouTube bridge (search, stream, download for Android app)
fs.mkdirSync(path.join(USER_DATA, 'yt-cache'), { recursive: true })
const ytBridge = registerYouTube(app, {
  sseSend,
  getDownloadDir() {
    const cfg = store.get('slskConfig', {})
    const folders = store.get('musicFolders', [])
    return cfg.downloadDir || folders[0] || path.join(os.homedir(), 'Music')
  },
  cacheDir: path.join(USER_DATA, 'yt-cache'),
  scheduleRescan() {},
})

// Periodic cleanup of stale YouTube URL cache entries to prevent memory leak
setInterval(function() {
  const now = Date.now()
  for (const [id, entry] of ytBridge._urlCache) {
    if (now > entry.expiresAt) ytBridge._urlCache.delete(id)
  }
}, 600000) // Every 10 minutes

const server = app.listen(PORT, HOST, () => {
  // With BRIDGE_PORT=0 the OS picks the port, so report the one we actually
  // got, not the one we asked for. The BRIDGE_LISTENING line is the handshake
  // the tests parse to learn where to send requests.
  const bound = server.address()
  const boundPort = (bound && bound.port) || PORT
  console.log(`BRIDGE_LISTENING ${boundPort}`)
  const interfaces = os.networkInterfaces()
  const ips = []
  for (const iface of Object.values(interfaces)) {
    for (const addr of (iface || [])) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address)
    }
  }
  console.log(`\n🎵 Papa Audio Bridge Server v${BRIDGE_VERSION} running on port ${boundPort}`)
  console.log(`Transcode: ${bridgeTranscodeEnabled() && FFMPEG_AVAILABLE ? 'on (mp3)' : (FFMPEG_AVAILABLE ? 'disabled in settings' : 'unavailable — ffmpeg not found')}`)
  console.log(`Bridge token (add this to Android app): ${BRIDGE_TOKEN}`)
  console.log(`\nAndroid app should connect to one of:`)
  for (const ip of ips) console.log(`  http://${ip}:${boundPort}`)
  console.log(`\nHealth check: http://localhost:${boundPort}/api/health`)
})
