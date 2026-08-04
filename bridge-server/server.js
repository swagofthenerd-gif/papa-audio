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
const { parseFile } = require('music-metadata')
const Store = require('electron-store')
const registerYouTube = require('./youtube')

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = process.env.BRIDGE_PORT || 8765
const USER_DATA   = path.join(os.homedir(), '.config', 'papa-audio')
const ARTWORK_DIR = path.join(USER_DATA, 'artwork')
const SLSKD_BASE  = 'http://localhost:5030/api/v0'
const SLSKD_CREDS = { username: 'slskd', password: 'slskd' }
const MUSIC_EXT   = /\.(flac|mp3|wav|aiff?|m4a|aac|ogg|opus|ape|wv|wma|dsf|dff)$/i

fs.mkdirSync(USER_DATA,   { recursive: true })
fs.mkdirSync(ARTWORK_DIR, { recursive: true })

// Re-use the same electron-store data files the desktop app writes
const store = new Store({ name: 'config', cwd: USER_DATA })

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
function scanDir(dir) {
  const results = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory())                        results.push(...scanDir(full))
      else if (entry.isFile() && MUSIC_EXT.test(entry.name)) results.push(full)
    }
  } catch (_) {}
  return results
}

function buildAlbums(tracks) {
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
      if (fs.existsSync(cached)) a.artPath = cached
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
const _searchCache = new Map()
function searchCacheGet(key) {
  const e = _searchCache.get(key)
  if (!e || Date.now() - e.ts > 5 * 60 * 1000) { _searchCache.delete(key); return null }
  return e.results
}
function searchCacheSet(key, results) {
  _searchCache.set(key, { results, ts: Date.now() })
  if (_searchCache.size > 200) {
    const cutoff = Date.now() - 5 * 60 * 1000
    for (const [k, v] of _searchCache) if (v.ts < cutoff) _searchCache.delete(k)
  }
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
const _sseClients = new Set()

function sseSend(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of _sseClients) {
    try { res.write(msg) } catch (_) { _sseClients.delete(res) }
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '10mb' }))

// ── SSE event stream ──────────────────────────────────────────────────────────
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  res.write('event: connected\ndata: {}\n\n')
  _sseClients.add(res)
  req.on('close', () => _sseClients.delete(res))
})

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true, version: '1.0.0' }))

// ── App info ──────────────────────────────────────────────────────────────────
app.get('/api/app-info', (_, res) => res.json({
  musicFolders:   store.get('musicFolders', []),
  savedSites:     store.get('savedSites', []),
  recentlyPlayed: store.get('recentlyPlayed', []),
  volume:         store.get('volume', 0.8),
}))

// ── Library ───────────────────────────────────────────────────────────────────
app.get('/api/library', (_, res) => {
  const cached = store.get('libraryCache', null)
  if (cached) return res.json({ albums: cached, cached: true })
  res.json({ albums: [], cached: false })
})

app.post('/api/library/scan', async (_, res) => {
  const folders = store.get('musicFolders', [])
  if (!folders.length) return res.json({ albums: [] })
  try {
    const allFiles = folders.flatMap(f => scanDir(f))
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
          if (!fs.existsSync(artPath)) fs.writeFileSync(artPath, pic.data)
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
          addedAt: (() => { try { return fs.statSync(filePath).mtimeMs } catch { return 0 } })(),
          filePath, artPath,
        })
      } catch (_) {}
    }
    const albums = buildAlbums(tracks)
    store.set('libraryCache', albums)
    res.json({ albums })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/library/cache', (req, res) => {
  store.set('libraryCache', req.body.albums)
  res.json({ ok: true })
})

// ── Music streaming ───────────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  const filePath = req.query.path
  if (!filePath) return res.status(400).json({ error: 'Missing path parameter' })

  const folders = store.get('musicFolders', [])
  const resolved = path.resolve(filePath)
  const allowed = folders.some(function(f) { return resolved.startsWith(path.resolve(f)) })
  if (!allowed) return res.status(403).json({ error: 'Access denied: path outside music folders' })

  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' })

  const stat = fs.statSync(filePath)
  const total = stat.size
  const range = req.headers.range

  // Determine MIME type
  const ext = path.extname(filePath).toLowerCase()
  const mimeMap = {
    '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.m4a': 'audio/mp4',
    '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
    '.ape': 'audio/ape', '.wv': 'audio/x-wavpack', '.wma': 'audio/x-ms-wma',
  }
  const mime = mimeMap[ext] || 'audio/mpeg'

  if (range) {
    const parts   = range.replace(/bytes=/, '').split('-')
    const start   = parseInt(parts[0], 10)
    const end     = parts[1] ? parseInt(parts[1], 10) : total - 1
    const chunkSz = end - start + 1
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkSz,
      'Content-Type':   mime,
    })
    fs.createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes' })
    fs.createReadStream(filePath).pipe(res)
  }
})

// ── Album art ─────────────────────────────────────────────────────────────────
app.get('/art', (req, res) => {
  const artPath = req.query.path
  if (!artPath) return res.status(400).json({ error: 'Missing path parameter' })

  const folders = store.get('musicFolders', [])
  const resolved = path.resolve(artPath)
  const allowed = folders.some(function(f) { return resolved.startsWith(path.resolve(f)) }) || resolved.startsWith(path.resolve(os.homedir() + '/.config/papa-audio/artwork'))
  if (!allowed) return res.status(403).json({ error: 'Access denied' })

  if (!fs.existsSync(artPath)) return res.status(404).send('Not found')
  const ext = path.extname(artPath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
  res.setHeader('Content-Type', mime)
  res.setHeader('Cache-Control', 'public, max-age=604800')
  fs.createReadStream(artPath).pipe(res)
})

app.post('/api/fetch-album-art', async (req, res) => {
  const { albumId, artist, album } = req.body
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
  } catch (e) { res.json(null) }
})

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings/liked',           (_, res) => res.json(store.get('likedAlbums', [])))
app.post('/api/settings/liked',          (req, res) => { store.set('likedAlbums', req.body.ids); res.json({ ok: true }) })

app.get('/api/settings/liked-tracks',    (_, res) => res.json(store.get('likedTracks', [])))
app.post('/api/settings/liked-tracks',   (req, res) => { store.set('likedTracks', req.body.paths); res.json({ ok: true }) })

app.get('/api/settings/play-counts',     (_, res) => res.json(store.get('playCounts', {})))
app.post('/api/settings/play-counts/increment', (req, res) => {
  const counts = store.get('playCounts', {})
  counts[req.body.filePath] = (counts[req.body.filePath] || 0) + 1
  store.set('playCounts', counts)
  res.json({ ok: true })
})

app.get('/api/settings/play-history',    (_, res) => res.json(store.get('playHistory', [])))
app.post('/api/settings/play-history',   (req, res) => {
  const h = store.get('playHistory', [])
  h.unshift(req.body)
  if (h.length > 2000) h.splice(2000)
  store.set('playHistory', h)
  res.json({ ok: true })
})

app.get('/api/settings/followed-artists',  (_, res) => res.json(store.get('followedArtists', [])))
app.post('/api/settings/followed-artists', (req, res) => { store.set('followedArtists', req.body.artists); res.json({ ok: true }) })

app.get('/api/settings/playlists',         (_, res) => res.json(store.get('playlists', [])))
app.post('/api/settings/playlists',        (req, res) => {
  const pls = store.get('playlists', [])
  const idx = pls.findIndex(p => p.id === req.body.id)
  if (idx >= 0) { pls[idx] = req.body } else { pls.unshift(req.body) }
  store.set('playlists', pls)
  res.json({ ok: true })
})
app.delete('/api/settings/playlists/:id', (req, res) => {
  store.set('playlists', store.get('playlists', []).filter(p => p.id !== req.params.id))
  res.json({ ok: true })
})

app.get('/api/settings/saved-queues',      (_, res) => res.json(store.get('savedQueues', [])))
app.post('/api/settings/saved-queues',     (req, res) => {
  const queues = store.get('savedQueues', []).filter(q => q.id !== req.body.id)
  queues.unshift(req.body)
  store.set('savedQueues', queues.slice(0, 30))
  res.json({ ok: true })
})
app.delete('/api/settings/saved-queues/:id', (req, res) => {
  store.set('savedQueues', store.get('savedQueues', []).filter(q => q.id !== req.params.id))
  res.json({ ok: true })
})

app.get('/api/settings/eq',               (_, res) => res.json(store.get('eqSettings', { enabled: true, gains: [0,0,0,0,0,0,0,0,0,0], replayGainMode: 'track', preamp: 0 })))
app.post('/api/settings/eq',              (req, res) => { store.set('eqSettings', req.body); res.json({ ok: true }) })

app.get('/api/settings/volume',           (_, res) => res.json({ volume: store.get('volume', 0.8) }))
app.post('/api/settings/volume',          (req, res) => { store.set('volume', req.body.volume); res.json({ ok: true }) })

app.post('/api/settings/recently-played', (req, res) => {
  let r = store.get('recentlyPlayed', []).filter(x => x !== req.body.id)
  r.unshift(req.body.id); store.set('recentlyPlayed', r.slice(0, 20))
  res.json({ ok: true })
})

app.get('/api/settings/playback-state',   (_, res) => res.json(store.get('playbackState', null)))
app.post('/api/settings/playback-state',  (req, res) => { store.set('playbackState', req.body); res.json({ ok: true }) })

app.get('/api/settings/agent-keys',       (_, res) => res.json(store.get('apiKeys', {})))
app.post('/api/settings/agent-keys',      (req, res) => { store.set('apiKeys', req.body); res.json(req.body) })

app.get('/api/settings/agent-model',      (_, res) => res.json({ model: store.get('agentModel', '') }))
app.post('/api/settings/agent-model',     (req, res) => { store.set('agentModel', req.body.model); res.json({ ok: true }) })

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
  const parts       = (filename || '').replace(/\\/g, '/').split('/').filter(Boolean)
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
  res.json({ ips, port: PORT })
})

// ── Music folder management ───────────────────────────────────────────────────
app.get('/api/folders', (_, res) => res.json(store.get('musicFolders', [])))
app.post('/api/folders', (req, res) => {
  const { folder } = req.body
  if (!folder || !fs.existsSync(folder)) return res.status(400).json({ error: 'Folder not found' })
  const folders = store.get('musicFolders', [])
  if (!folders.includes(folder)) folders.push(folder)
  store.set('musicFolders', folders)
  res.json(folders)
})
app.delete('/api/folders', (req, res) => {
  const folders = store.get('musicFolders', []).filter(f => f !== req.query.folder)
  store.set('musicFolders', folders)
  res.json(folders)
})

// ── Start ─────────────────────────────────────────────────────────────────────
// YouTube bridge (search, stream, download for Android app)
fs.mkdirSync(path.join(USER_DATA, 'yt-cache'), { recursive: true })
registerYouTube(app, {
  sseSend,
  getDownloadDir() {
    const cfg = store.get('slskConfig', {})
    const folders = store.get('musicFolders', [])
    return cfg.downloadDir || folders[0] || path.join(os.homedir(), 'Music')
  },
  cacheDir: path.join(USER_DATA, 'yt-cache'),
  scheduleRescan() {},
})

app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces()
  const ips = []
  for (const iface of Object.values(interfaces)) {
    for (const addr of (iface || [])) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address)
    }
  }
  console.log(`\n🎵 Papa Audio Bridge Server running on port ${PORT}`)
  console.log(`\nAndroid app should connect to one of:`)
  for (const ip of ips) console.log(`  http://${ip}:${PORT}`)
  console.log(`\nHealth check: http://localhost:${PORT}/api/health`)
})
