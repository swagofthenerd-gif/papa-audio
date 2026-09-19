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
// BRIDGE_SLSKD_BASE points the daemon calls somewhere else. The tests aim it at
// a local stub so they exercise the real error handling without ever touching
// the user's live slskd (and his real Soulseek account) on :5030.
const SLSKD_BASE  = process.env.BRIDGE_SLSKD_BASE || 'http://localhost:5030/api/v0'
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
// bridgeTranscode lives in the bridge's own file. The legacy config.json copy
// is consulted ONLY as the seed for a profile that predates bridge-settings.json
// — a lazy fallback, not a read on every request, so a torn config.json cannot
// stall unrelated traffic.
const _TRANSCODE_UNSET = Symbol('unset')
function bridgeTranscodeEnabled() {
  const own = bridgeSettings.get(USER_DATA, 'bridgeTranscode', _TRANSCODE_UNSET)
  if (own !== _TRANSCODE_UNSET) return own !== false
  return cfgGet('bridgeTranscode', true) !== false
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

// Read the same electron-store config file the desktop app writes.
//
// READ-ONLY. The bridge no longer writes config.json at all: the desktop's `conf`
// rewrites the whole of config.json on every set(), so a bridge write and a
// desktop write with no lock between them silently destroyed each other, and
// the bridge's write also dropped the desktop's `configFileMode: 0o600`.
// Phone-side changes to a desktop-owned key are queued in the inbox and applied
// by the desktop (src/bridge-inbox-ingest.js); the bridge's own setting lives
// in bridge-settings.json. One writer per file, in both directions.
//
// NOTE the narrowed job: config.json is now only the SETTINGS keys
// (musicFolders, volume, eqSettings, slskConfig, …). The eight big/hot keys —
// libraryCache, playbackState, recentlyPlayed, playHistory, playCounts,
// savedQueues, playlists, likedTracks — were moved to SideStore files on
// 2026-08-27 and the desktop's retireLegacyKeys() deletes them from here. Read
// those through `sideValue()` below, never through `store`.
const store = new Store({ name: 'config', cwd: USER_DATA })
const bridgeSettings = require('./bridge-settings')

// Every config read goes through here.
//
// electron-store re-reads config.json on every get(), and the desktop writes it
// by renaming a tmp file over it. A read that lands between the unlink and the
// rename, or on a partially visible file, throws a SyntaxError — `conf` is
// configured with clearInvalidConfig:false, so it does NOT swallow it — and
// that turned a 20-microsecond rename window into a 500 on a settings route.
// One retry after a moment is enough: the rename is atomic, so the second read
// either sees the old file or the new one, never a torn one.
//
// A second failure is reported as the fallback rather than thrown. A settings
// GET answering the default beats the phone seeing an error, and the desktop
// (the writer) is the one that has to notice a genuinely corrupt config.
// How long the retry waits. Only the tests move it: they need a window wide
// enough to put the good file back inside, which a microsecond-wide real rename
// does not give them.
const CONFIG_RETRY_MS = process.env.BRIDGE_CONFIG_RETRY_MS !== undefined
  ? Number(process.env.BRIDGE_CONFIG_RETRY_MS) : 5

function cfgGet(key, fallback) {
  try {
    return store.get(key, fallback)
  } catch (e) {
    console.error(`[bridge] config read of ${key} failed (${e && e.message}); retrying once`)
    try {
      // Synchronous on purpose: these are request paths, and sleeping the
      // handler for a few milliseconds is cheaper than an async rewrite of
      // every caller. The rename window is microseconds wide.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CONFIG_RETRY_MS)
    } catch (_) {}
    try {
      return store.get(key, fallback)
    } catch (e2) {
      console.error(`[bridge] config read of ${key} failed twice (${e2 && e2.message}); using the default`)
      return fallback
    }
  }
}

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

// The desktop's config value for `key`, with any not-yet-ingested phone
// mutations replayed on top — the same overlay `sideValue` gives the side
// files, for the settings keys that never left config.json. Without it a phone
// POST followed by its own GET would read back the pre-POST value for up to a
// full ingest interval and the phone's UI would snap backwards.
function configValue(key, fallback) {
  const base = cfgGet(key, fallback)
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

// An upstream failure carries its status so a route can report the real thing
// instead of inventing a success.
class SlskError extends Error {
  constructor(status, endpoint, body) {
    super(`slskd ${status} on ${endpoint}${body ? `: ${String(body).slice(0, 200)}` : ''}`)
    this.name = 'SlskError'
    this.status = status
    this.endpoint = endpoint
  }
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
  // res.ok was never checked. A 400 on a DELETE returned null and the route
  // above it answered {ok:true} -- which is exactly the non-sticking cancel the
  // phone sees: it reports the transfer removed, slskd never removed it. A 400
  // on a POST was an invented successful download; a 500 on a GET was an empty
  // list that looked like "nothing is transferring".
  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch (_) {}
    throw new SlskError(res.status, endpoint, detail)
  }
  if (method === 'DELETE') return null
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

// slskd answers /transfers/downloads as users -> directories -> files, and the
// Android app's Transfer type is a FLAT file record — so this flattens it.
//
// It is NOT what /api/slsk/transfers answers with. The phone does its own
// flattening (flattenTransfers in app/(tabs)/downloads.tsx walks
// group.directories[].files[]), so handing it an already-flat list produced an
// empty On PC screen exactly like the raw nested array used to: one shape, two
// flattenings. The route sends the nested array the phone expects and this
// stays for /api/slsk/active-count, which needs one list of states to count.
function flattenTransfers(data) {
  const out = []
  for (const user of Array.isArray(data) ? data : []) {
    for (const dir of (user && user.directories) || []) {
      for (const f of (dir && dir.files) || []) {
        out.push({
          id: f.id,
          username: user.username,
          filename: String(f.filename || ''),
          size: Number(f.size) || 0,
          bytesTransferred: Number(f.bytesTransferred) || 0,
          state: String(f.state || ''),
          averageSpeed: Number(f.averageSpeed) || 0,
          elapsed: f.elapsed ?? null,
          remainingTime: f.remainingTime ?? null,
        })
      }
    }
  }
  return out
}

// slskd reports durations as .NET TimeSpan STRINGS — "HH:MM:SS", with
// fractional seconds ("00:01:23.4560000") and a leading dot-separated day group
// past 24 hours ("1.02:03:04"). The phone does arithmetic on them
// (formatEta(secs) → `${Math.ceil(secs / 60)}m`), so a string reaches the
// screen as "NaNm" and a seek estimate is unreadable.
//
// Same parser shape as the desktop renderer's _hmsToSecs: counted from the
// RIGHT, so a bare "30" is thirty SECONDS and not thirty hours, the day group
// is taken before the colon split, and fractional seconds are dropped rather
// than rounded (an ETA to the ten-millionth of a second is noise).
function hmsToSecs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0
  const str = String(value == null ? '' : value).trim()
  if (!str) return 0
  let days = 0
  let rest = str
  // The day separator and the fractional-seconds separator are both a dot, so
  // the leading dot-group is a day count only when a colon follows it.
  const dot = rest.indexOf('.')
  if (dot > 0 && rest.indexOf(':') > dot) {
    const d = Number(rest.slice(0, dot))
    if (Number.isFinite(d)) days = d
    rest = rest.slice(dot + 1)
  }
  const nums = rest.split(':').map(p => {
    const v = Number(String(p).split('.')[0])
    return Number.isFinite(v) ? v : 0
  })
  let secs = 0
  let mult = 1
  // Stops after the hours field: anything past it is the day part, already
  // taken above.
  for (let i = nums.length - 1; i >= 0 && mult <= 3600; i--) {
    secs += nums[i] * mult
    mult *= 60
  }
  return Math.max(0, days * 86400 + secs)
}

// The nested array, untouched except that the two TimeSpan fields inside each
// file become SECONDS. A copy, never a mutation of the parsed upstream body.
// Keys that are not there stay not there: inventing `elapsedTime: 0` would read
// on the phone as a transfer that has been running for no time at all.
const TIME_FIELDS = ['remainingTime', 'elapsedTime']
function normaliseTransfers(data) {
  return (Array.isArray(data) ? data : []).map(user => Object.assign({}, user, {
    directories: ((user && user.directories) || []).map(dir => Object.assign({}, dir, {
      files: ((dir && dir.files) || []).map(file => {
        const out = Object.assign({}, file)
        for (const k of TIME_FIELDS) {
          if (out[k] !== undefined && out[k] !== null) out[k] = hmsToSecs(out[k])
        }
        return out
      }),
    })),
  }))
}

// The same predicate the Downloads tab uses (isActive in downloads.tsx), so the
// badge count and the list can never disagree.
const SLSK_ACTIVE = /queued|initializing|inprogress|requested/i
function countActive(transfers) {
  return transfers.filter(t => SLSK_ACTIVE.test(t.state || '')).length
}

// An upstream failure must reach the client as an upstream failure.
function slskFail(res, e) {
  if (e instanceof SlskError) {
    return res.status(502).json({ error: e.message, upstreamStatus: e.status })
  }
  return res.status(502).json({ error: `slskd unreachable: ${(e && e.message) || e}` })
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
  // The APK download is in the same boat and for the same reason: the phone
  // hands the URL to expo-file-system's downloader (and to Linking.openURL for
  // the "save to Downloads" path), neither of which can attach a header.
  const isMedia = req.path === '/stream' || req.path.startsWith('/stream/') ||
    req.path === '/art' || req.path.startsWith('/art/') ||
    req.path === '/events' || req.path === '/api/app-update/apk'
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
// 60/min was below what ONE phone does legitimately. A cold launch is ~12 API
// calls, plus one per merged playlist and one per album with no art, so a
// library of any size crossed 60 before the first screen had finished drawing —
// and then the failover made it permanent (see rateLimitExempt below).
//
// 600 is the budget for a LAN with a handful of trusted, paired clients: ten
// requests a second sustained from one address, which no phone reaches by using
// the app and which still bounds a runaway loop or a token holder hammering
// slskd. The alternative considered was limiting only non-GET; rejected because
// the expensive routes here are GETs (the slskd search poll, the library read),
// so that would have left the real work unbounded while capping the cheap part.
const RATE_LIMIT_MAX = Number(process.env.BRIDGE_RATE_LIMIT_MAX) > 0
  ? Number(process.env.BRIDGE_RATE_LIMIT_MAX) : 600
const RATE_LIMIT_WINDOW = 60 * 1000
// A LAN sees a handful of clients; anything beyond this is a forged-key flood,
// and the map must not grow with it.
const RATE_LIMIT_MAX_KEYS = 1024

// Static media and the event stream are NOT rate-limited. 60 requests a minute
// is a sane budget for API calls and an absurd one for a library screen: 245
// albums means 245 thumbnail requests in a burst, and a single track seek is a
// stream of range requests. Every one past the 60th came back as a JSON 429 to
// an <Image> or the player. The limiter's job is to bound API work and writes,
// which is what it still does.
//
// /api/health is exempt for a different reason: it is the LIVENESS PROBE, and a
// probe that can itself be throttled cannot report liveness. The phone's
// failover (findWorkingServer in services/bridge.ts) probes /api/health on every
// candidate address the moment a call fails — so once the limiter tripped, the
// probe tripped too, every candidate "failed", and the app showed Offline while
// the bridge was answering everything else perfectly. A 429 on the one route
// whose whole job is to say "I am here" turns a busy bridge into a dead one.
// It reads nothing off disk and does no work worth bounding.
function rateLimitExempt(p) {
  return p === '/events' || p === '/api/health' ||
    p === '/art'    || p.startsWith('/art/') ||
    p === '/stream' || p.startsWith('/stream/')
}

app.use((req, res, next) => {
  if (rateLimitExempt(req.path)) return next()
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

// Held (and unref'd) so shutdown can clear them. An un-unref'd interval keeps
// the event loop alive forever, so a closed server still could not let the
// process exit.
const _rateSweep = setInterval(() => {
  const now = Date.now()
  for (const [ip, e] of rateLimit) if (now > e.resetAt) rateLimit.delete(ip)
}, 300000)
_rateSweep.unref()

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
  musicFolders:   cfgGet('musicFolders', []),
  savedSites:     cfgGet('savedSites', []),
  recentlyPlayed: sideValue('recentlyPlayed') || [],
  volume:         cfgGet('volume', 0.8),
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

// "Refresh" on the phone. It used to mean a full re-parse of the library with
// music-metadata — 3.4 TB, tens of minutes, against the phone's 120 s axios
// timeout, so it never returned an answer the phone could use. Worse, the album
// ids it built (md5 of `artist_album`) are NOT the desktop's ids
// (albumGrouping / tagEdit.albumKeyOf), so on the runs that did finish, every
// /art/<id>.jpg and /stream/<trackId> the phone then asked for 404'd: a refresh
// broke the library it was meant to refresh.
//
// The desktop already watches the music roots and rescans on its own, and
// library-cache.json is the result. So the honest answer to "refresh" is the
// desktop's current cache — the same albums, with the same ids, in under a
// millisecond. `rescanned: false` says plainly that nothing was re-read.
app.post('/api/library/scan', (_, res) => {
  const cached = sideValue('libraryCache')
  res.json({
    albums: withArtUrls(Array.isArray(cached) ? cached : []),
    persisted: false,
    rescanned: false,
  })
})

// /api/library/cache is gone: it let the phone overwrite the desktop's library
// cache wholesale. The desktop owns library-cache.json.

// ── Music streaming ───────────────────────────────────────────────────────────
app.get('/stream', async (req, res) => {
  const filePath = req.query.path
  if (!filePath) return res.status(400).json({ error: 'Missing path parameter' })

  const folders = cfgGet('musicFolders', [])
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
  const folders = cfgGet('musicFolders', [])
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
  const folders = cfgGet('musicFolders', [])
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
app.get('/api/settings/liked',           (_, res) => res.json(configValue('likedAlbums', [])))
app.post('/api/settings/liked',          (req, res) =>
  queueMutation(res, 'likedAlbums.set', { ids: Array.isArray(req.body && req.body.ids) ? req.body.ids : [] }))

app.get('/api/settings/liked-tracks',    (_, res) => res.json(sideValue('likedTracks') || []))

// The phone has no "toggle" call. store/library.ts keeps the whole liked set in
// memory (loaded once at startup) and POSTs all of it every time the user taps
// a heart, so the body is a FULL LIST that means "one track changed".
//
// Queued verbatim as `likedTracks.set`, that list replaced the desktop's list
// at ingest time — minutes later, against a value that had moved on. One tap on
// the phone wiped every like made on the PC since the phone booted, and one
// like on the PC was undone by the next tap on the phone. Last writer wins, and
// the loser is never told.
//
// So the route diffs the posted list against the desktop's CURRENT value (with
// the inbox replayed, so two taps in a row diff against each other and not
// against a stale file) and queues only what actually changed. A tap then
// touches exactly the one track it was about, and a like it never saw survives
// because no op ever names it.
//
// The residual window is narrow and honest: a like made on the PC between the
// phone's startup read and this POST is still in `removed`. Closing it needs
// the phone to send the list it started FROM, which is a phone-side change.
app.post('/api/settings/liked-tracks',   (req, res) => {
  const paths = Array.isArray(req.body && req.body.paths)
    ? req.body.paths.filter(p => typeof p === 'string') : []
  const currentValue = sideValue('likedTracks')
  const current = Array.isArray(currentValue) ? currentValue : []
  const have = new Set(current)
  const want = new Set(paths)
  const added = paths.filter(p => !have.has(p))
  const removed = current.filter(p => !want.has(p))

  // Nothing changed: the phone re-sending its list is not a mutation, and an
  // empty op would wake the desktop's ingester for no reason.
  if (!added.length && !removed.length) {
    return res.status(202).json({ ok: true, queued: false, added: 0, removed: 0 })
  }
  try {
    if (added.length) inbox.append(USER_DATA, 'likedTracks.add', { paths: added })
    if (removed.length) inbox.append(USER_DATA, 'likedTracks.remove', { paths: removed })
  } catch (e) {
    console.error(`[bridge] inbox write failed (${e && e.message})`)
    return res.status(500).json({ error: 'Could not record the change' })
  }
  res.status(202).json({ ok: true, queued: true, added: added.length, removed: removed.length })
})

app.get('/api/settings/play-counts',     (_, res) => res.json(sideValue('playCounts') || {}))
app.post('/api/settings/play-counts/increment', (req, res) => {
  const filePath = req.body && req.body.filePath
  if (!filePath) return res.status(400).json({ error: 'filePath required' })
  return queueMutation(res, 'playCounts.increment', { filePath })
})

// The two sides of this key name the same moment differently, and neither can
// read the other's name.
//
// The phone posts { filePath, artist, title, playedAt } (hooks/usePlayer.ts)
// and filters its Stats screen on `playedAt` (app/stats.tsx). The desktop
// writes `ts` (main.js) and history.js quarantines any entry carrying neither
// `ts` nor `timestamp` — so every play made on the phone was queued, ingested,
// and then set aside on the desktop's next normalisation pass. Silently: a
// quarantine is not a failure.
//
// So the bridge stamps `ts` on the way in (keeping `playedAt`, which is what
// the phone reads back) and re-derives `playedAt` on the way out for the
// entries the desktop wrote. One entry, both names, neither reader changed.
app.get('/api/settings/play-history',    (_, res) => {
  const list = sideValue('playHistory')
  res.json((Array.isArray(list) ? list : []).map(e => (e && typeof e === 'object')
    ? Object.assign({}, e, { playedAt: e.playedAt ?? e.ts })
    : e))
})
app.post('/api/settings/play-history',   (req, res) => {
  const entry = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body : {}
  // A playedAt of 0, or a string, is not a usable time; Date.now() is the
  // honest stand-in (history.js rejects anything before 2000 outright).
  const ts = Number(entry.playedAt) || Date.now()
  return queueMutation(res, 'playHistory.push', { entry: Object.assign({}, entry, { ts }) })
})

app.get('/api/settings/followed-artists',  (_, res) => res.json(configValue('followedArtists', [])))
app.post('/api/settings/followed-artists', (req, res) =>
  queueMutation(res, 'followedArtists.set', { artists: Array.isArray(req.body && req.body.artists) ? req.body.artists : [] }))

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

app.get('/api/settings/eq',               (_, res) => res.json(configValue('eqSettings', { enabled: true, gains: [0,0,0,0,0,0,0,0,0,0], replayGainMode: 'track', preamp: 0 })))
app.post('/api/settings/eq',              (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'eq settings required' })
  return queueMutation(res, 'eqSettings.set', { settings: req.body })
})

app.get('/api/settings/volume',           (_, res) => res.json({ volume: configValue('volume', 0.8) }))
app.post('/api/settings/volume',          (req, res) => {
  const volume = req.body && req.body.volume
  if (typeof volume !== 'number' || !isFinite(volume)) return res.status(400).json({ error: 'volume must be a number' })
  return queueMutation(res, 'volume.set', { volume })
})

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

app.get('/api/settings/agent-model',      (_, res) => res.json({ model: configValue('agentModel', '') }))
app.post('/api/settings/agent-model',     (req, res) => {
  const model = req.body && req.body.model
  if (typeof model !== 'string') return res.status(400).json({ error: 'model must be a string' })
  return queueMutation(res, 'agentModel.set', { model })
})

// Transcode gate (roadmap #64): read/write the bridgeTranscode config the
// id-keyed /stream endpoint honours. The read also reports whether ffmpeg is
// present so a client can grey out the option when transcoding is impossible.
app.get('/api/settings/transcode',        (_, res) => res.json({ enabled: bridgeTranscodeEnabled(), ffmpeg: FFMPEG_AVAILABLE }))
app.post('/api/settings/transcode',       (req, res) => {
  // bridgeTranscode is bridge-owned (no desktop reader), so this writes the
  // bridge's own file rather than queueing a mutation for the desktop.
  try {
    bridgeSettings.set(USER_DATA, 'bridgeTranscode', !!(req.body && req.body.enabled))
  } catch (e) {
    console.error(`[bridge] could not save bridgeTranscode (${e && e.message})`)
    return res.status(500).json({ error: 'Could not save the setting' })
  }
  res.json({ enabled: bridgeTranscodeEnabled(), ffmpeg: FFMPEG_AVAILABLE })
})

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
  } catch (e) { slskFail(res, e) }
})

// ── Soulseek download ─────────────────────────────────────────────────────────
app.post('/api/slsk/download', async (req, res) => {
  const { username, filename, size } = req.body
  try {
    await slskFetch('POST', `/transfers/downloads/${encodeURIComponent(username)}`, [{ filename, size }])
    res.json({ ok: true })
  } catch (e) { slskFail(res, e) }
})

// The NESTED slskd array, because the phone flattens it itself. See
// normaliseTransfers above for the one thing that is changed on the way past.
app.get('/api/slsk/transfers', async (_, res) => {
  try {
    res.json(normaliseTransfers(await slskFetch('GET', '/transfers/downloads')))
  } catch (e) { slskFail(res, e) }
})

// The Downloads tab's badge. The phone was calling this and getting a 404 (it
// does not exist in this server), so getSlskActiveCount()'s catch turned every
// real count into 0 and the dot never appeared.
app.get('/api/slsk/active-count', async (_, res) => {
  try {
    const flat = flattenTransfers(await slskFetch('GET', '/transfers/downloads'))
    res.json({ count: countActive(flat) })
  } catch (e) { slskFail(res, e) }
})

app.delete('/api/slsk/transfers/:username/:id', async (req, res) => {
  try {
    await slskFetch('DELETE', `/transfers/downloads/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.id)}?remove=true`)
    res.json({ ok: true })
  } catch (e) { slskFail(res, e) }
})

app.get('/api/slsk/resolve', (req, res) => {
  const { username, filename } = req.query
  const cfg         = cfgGet('slskConfig', {})
  const folders     = cfgGet('musicFolders', [])
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

// ── Library file deletion ────────────────────────────────────────────────────
// The Android app's "Phone only" download mode calls this to remove the PC copy
// once the file has been pulled to the phone (services/phonePull.ts). It has
// never existed here, so the PC copy was silently always kept.
//
// It is NOT implemented as an unlink. The desktop deletes library files through
// Electron's shell.trashItem (main.js 'library-trash-paths'), which puts them in
// the freedesktop trash so a mistake is recoverable — and the desktop has a
// whole restore path built on that (trashRootsFor / library-restore-trashed).
// This process is plain Node with no Electron and no IPC channel to the desktop
// (main.js has no bridge/phone/remote surface at all — grepped), so there is no
// way from here to the trash. An unlink() would be a permanent delete wearing
// the name of a reversible one.
//
// So: answer honestly. 501 with the reason, which the phone's catch already
// turns into "the PC copy was kept".
app.post('/api/library/delete-file', (req, res) => {
  const filePath = req.body && req.body.path
  if (!filePath) return res.status(400).json({ error: 'path required' })
  return res.status(501).json({
    ok: false,
    error: 'The bridge cannot delete PC files. Deleting goes through the ' +
      'desktop app’s trash so it can be undone, and the bridge has no channel ' +
      'to the desktop. Remove it from the desktop app instead.',
  })
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
app.get('/api/folders', (_, res) => res.json(cfgGet('musicFolders', [])))
// POST/DELETE /api/folders are gone. musicFolders IS the allow-list every
// /stream and /art route checks against, so a route that appends to it let a
// token holder add "/" and then read any file on disk through /stream?path=.
// It only checked fs.existsSync. The music roots are the desktop's to choose;
// the Android app never called these.

// ── Per-track loudness (ReplayGain) ───────────────────────────────────────────
// services/bridge.ts getLoudness(): GET /api/loudness?path=<filePath>, and it
// reads exactly one field — `res.data?.gain`, a NUMBER in dB, which the phone
// feeds to gainDbToLinear(). Anything else (including a missing entry) has to
// come back as `gain: null`, which the phone caches as "this file has no
// measurement" rather than retrying it on every play.
//
// The number is the desktop's own: main.js measures integrated loudness with
// ffmpeg's ebur128 filter and stores { lufs, gainDb, at } per file in the
// loudness-map SideStore. This route READS that file and nothing else — it
// never measures, and it never writes. A track the desktop has not scanned is
// honestly unknown here.
app.get('/api/loudness', (req, res) => {
  const p = req.query.path
  if (typeof p !== 'string' || !p) return res.status(400).json({ error: 'path required' })
  // No containment check on purpose: nothing is read from `p`, it is only a
  // lookup key in a map the desktop wrote. There is no file access to escape.
  const map = sideRead.get('loudnessMap') || {}
  const entry = map[p]
  const gainDb = entry && typeof entry === 'object' ? entry.gainDb : null
  res.json({
    gain: typeof gainDb === 'number' && isFinite(gainDb) ? gainDb : null,
    lufs: entry && typeof entry === 'object' && typeof entry.lufs === 'number' ? entry.lufs : null,
  })
})

// ── Phone crash / diagnostic reports ──────────────────────────────────────────
// services/crash.ts POSTs JSON here from three places — reportCrash (context,
// isFatal, message, stack, appVersion, at), sendScanReport (context
// 'scan-report' plus the scan counters) and sendViewReport (context
// 'view-report' plus whatever the Library screen was holding). All three
// `.catch(() => {})` the response and parse nothing, so the body only has to be
// honest, not shaped: `{ ok: true }`.
//
// The log is bridge-owned. It is NOT the desktop's app-crashes.log: that file
// belongs to main.js's _appendCrashLog, and a second writer on it is the same
// mistake the SideStore split exists to avoid. Phone reports get their own file.
const PHONE_CRASH_LOG = path.join(USER_DATA, 'phone-crash-log.txt')
const PHONE_CRASH_LOG_MAX = 1024 * 1024
// One rotation, not a series: the point is bounded disk use plus "the last
// couple of megabytes of reports are still there". `.1` is overwritten.
function appendPhoneCrashLog(line) {
  try {
    let size = 0
    try { size = fs.statSync(PHONE_CRASH_LOG).size } catch (_) { size = 0 }
    if (size + Buffer.byteLength(line) > PHONE_CRASH_LOG_MAX) {
      try { fs.renameSync(PHONE_CRASH_LOG, `${PHONE_CRASH_LOG}.1`) } catch (_) {}
    }
    fs.appendFileSync(PHONE_CRASH_LOG, line, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch (e) {
    console.error(`[bridge] phone crash log write failed (${(e && e.message) || e})`)
    return false
  }
}

app.post('/api/crash-log', (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  // Serialised as one JSON line per report so the file stays greppable and a
  // truncated write can only damage the line it was writing.
  const record = Object.assign({}, body, {
    receivedAt: new Date().toISOString(),
    // The client's own `at` is kept as-is; this is when the bridge saw it.
    source: 'phone',
  })
  let line
  try {
    line = JSON.stringify(record) + '\n'
  } catch (_) {
    line = JSON.stringify({ receivedAt: record.receivedAt, source: 'phone', error: 'unserialisable report' }) + '\n'
  }
  // A 10 MB body limit is already on express.json; this is the per-line cap so
  // one enormous stack cannot eat the whole rotation budget by itself.
  if (line.length > 64 * 1024) line = line.slice(0, 64 * 1024 - 1) + '\n'
  appendPhoneCrashLog(line)
  // Always 200: crash reporting that answers 500 turns a phone bug into two.
  res.json({ ok: true })
})

// ── Android app update ────────────────────────────────────────────────────────
// services/appUpdate.ts findUpdate(): GET /api/app-update, then
// `typeof info.versionCode !== 'number'` → no update, else compares
// info.versionCode against the phone's APP_VERSION_CODE. When it is newer the
// banner shows info.versionName and info.notes, and downloads
// appUpdateUrl(info.url) — the bridge base plus that path, with ?token=
// appended, fetched as a plain URL by expo-file-system.
//
// So the advertised object is { versionCode, versionName, url, notes } at the
// TOP level, not wrapped.
//
// There is no release feed and none is invented. The producer is the Android
// repo's scripts/publish-apk.sh, which writes version.json
// ({versionCode, versionName, notes}) and latest.apk into a dist directory. This
// route serves that pair from the first of these that exists:
//   1. $PAPA_BRIDGE_APK_DIR
//   2. <USER_DATA>/apk/
//   3. ~/papa-audio-android/dist/   (where publish-apk.sh writes today)
// With no manifest anywhere the answer is `{ ok: true, update: null, reason }`,
// which the phone reads as "no versionCode" → no update. The reason is there
// for a human reading the endpoint, not for the app.
// PAPA_BRIDGE_APK_DIR is an override, not an extra candidate: when it is set it
// is the ONLY directory consulted. Anything else and a test (or a deliberate
// "serve nothing") would still fall through to whatever happens to be in the
// home directory, which is host state deciding the answer.
const APK_DIRS = process.env.PAPA_BRIDGE_APK_DIR
  ? [process.env.PAPA_BRIDGE_APK_DIR]
  : [
    path.join(USER_DATA, 'apk'),
    path.join(os.homedir(), 'papa-audio-android', 'dist'),
  ]

function findApkManifest() {
  for (const dir of APK_DIRS) {
    const manifest = path.join(dir, 'version.json')
    let raw
    try { raw = fs.readFileSync(manifest, 'utf8') } catch (_) { continue }
    let parsed
    try { parsed = JSON.parse(raw) } catch (e) {
      console.error(`[bridge] ${manifest} is unreadable (${(e && e.message) || e})`)
      continue
    }
    if (!parsed || typeof parsed.versionCode !== 'number') {
      console.error(`[bridge] ${manifest} has no numeric versionCode; ignoring it`)
      continue
    }
    const apk = path.join(dir, 'latest.apk')
    let size = 0
    try { size = fs.statSync(apk).size } catch (_) {
      // A manifest with no APK beside it would advertise a download that 404s.
      console.error(`[bridge] ${manifest} names v${parsed.versionCode} but ${apk} is missing`)
      continue
    }
    return { dir, apk, size, manifest: parsed }
  }
  return null
}

app.get('/api/app-update', (_, res) => {
  const found = findApkManifest()
  if (!found) {
    return res.json({
      ok: true,
      update: null,
      reason: `no version.json + latest.apk pair in ${APK_DIRS.join(', ')}`,
    })
  }
  res.json({
    versionCode: found.manifest.versionCode,
    versionName: typeof found.manifest.versionName === 'string'
      ? found.manifest.versionName : `v${found.manifest.versionCode}`,
    notes: typeof found.manifest.notes === 'string' ? found.manifest.notes : '',
    url: '/api/app-update/apk',
    sizeBytes: found.size,
  })
})

// The APK itself. Streamed through pipeFile for the same reason every other
// file read is: an unhandled 'error' on a read stream kills the process.
app.get('/api/app-update/apk', (_, res) => {
  const found = findApkManifest()
  if (!found) return res.status(404).json({ error: 'No published APK' })
  res.setHeader('Content-Type', 'application/vnd.android.package-archive')
  res.setHeader('Content-Length', String(found.size))
  res.setHeader('Content-Disposition',
    `attachment; filename="papa-audio-${found.manifest.versionCode}.apk"`)
  pipeFile(fs.createReadStream(found.apk), res, 'apk')
})

// ── Start ─────────────────────────────────────────────────────────────────────
// YouTube bridge (search, stream, download for Android app)
fs.mkdirSync(path.join(USER_DATA, 'yt-cache'), { recursive: true })
const ytBridge = registerYouTube(app, {
  sseSend,
  getDownloadDir() {
    const cfg = cfgGet('slskConfig', {})
    const folders = cfgGet('musicFolders', [])
    return cfg.downloadDir || folders[0] || path.join(os.homedir(), 'Music')
  },
  cacheDir: path.join(USER_DATA, 'yt-cache'),
  scheduleRescan() {},
})

// Periodic cleanup of stale YouTube URL cache entries to prevent memory leak
const _ytSweep = setInterval(function() {
  const now = Date.now()
  for (const [id, entry] of ytBridge._urlCache) {
    if (now > entry.expiresAt) ytBridge._urlCache.delete(id)
  }
}, 600000) // Every 10 minutes
_ytSweep.unref()

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

// listen() reports its failure as an 'error' event, and there was no listener.
// An unhandled 'error' on the server is an uncaught exception: the process died
// with a stack trace and systemd restarted it 5 s later, forever, with nothing
// in the journal but the same trace. Say what happened, once, and exit with a
// status systemd can act on.
let _exiting = false
server.on('error', (e) => {
  if (_exiting) return
  _exiting = true
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[bridge] port ${PORT} is already in use — another bridge (or ` +
      `the papa-bridge service) is already listening. Not starting.`)
  } else {
    console.error(`[bridge] could not listen on ${HOST}:${PORT}: ${(e && e.message) || e}`)
  }
  process.exit(1)
})

// systemd sends SIGTERM on stop/restart. Close the listener, clear the timers
// and let the loop drain, so in-flight streams finish instead of being cut.
// The timeout is the backstop: a wedged connection must not make systemd wait
// out its whole TimeoutStopSec.
function shutdown(signal) {
  if (_exiting) return
  _exiting = true
  console.log(`[bridge] ${signal} — shutting down`)
  clearInterval(_rateSweep)
  clearInterval(_ytSweep)
  for (const res of _sseClients) { try { res.end() } catch (_) {} }
  _sseClients.clear()
  const force = setTimeout(() => process.exit(0), 5000)
  force.unref()
  server.close(() => process.exit(0))
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
