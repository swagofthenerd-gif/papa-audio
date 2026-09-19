'use strict'

/**
 * YouTube endpoints for the bridge server.
 * Reuses the desktop app's ../youtube-search (youtubei.js) and ../youtube-download (yt-dlp).
 * Audio is proxied through the bridge so react-native-track-player gets a normal,
 * seekable HTTP source instead of an expiring googlevideo URL.
 */

const path = require('path')
const https = require('https')
const http = require('http')
const { spawn } = require('child_process')

const ytSearch = require('../youtube-search')
const ytDownloader = require('../youtube-download')

// yt-dlp resolves a fresh signed URL each call; cache per videoId to avoid
// re-resolving on every range request the player makes while seeking.
const URL_TTL_MS = 60 * 60 * 1000
const _urlCache = new Map() // videoId -> { url, expiresAt }
// videoId -> the in-flight resolve promise. A player opening a track fires
// several range requests at once and each one used to spawn its own yt-dlp:
// N processes, N network round-trips, all racing to write the same cache entry.
// One resolve per videoId; everyone else waits on it.
const _inflight = new Map() // videoId -> Promise

// `spawnFn` is injectable so tests can count spawns without running yt-dlp.
let _spawn = spawn
function _setSpawn(fn) { _spawn = fn || spawn }

function resolveAudioUrl(videoId) {
  const cached = _urlCache.get(videoId)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve({ ok: true, url: cached.url })

  const pending = _inflight.get(videoId)
  if (pending) return pending

  const p = _resolveAudioUrlUncached(videoId)
  _inflight.set(videoId, p)
  // Always clear, success or failure: a failed resolve must be retryable.
  p.then(() => _inflight.delete(videoId), () => _inflight.delete(videoId))
  return p
}

function _resolveAudioUrlUncached(videoId) {
  return new Promise(resolve => {
    let proc
    try {
      proc = _spawn('yt-dlp', ['-f', 'bestaudio', '-g', '--no-playlist', '--', videoId])
    } catch (e) {
      resolve({ ok: false, error: `yt-dlp spawn failed: ${e.message}` })
      return
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
      resolve({ ok: false, error: 'yt-dlp timed out after 30s' })
    }, 30000)
    let out = ''
    let err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err = (err + d.toString()).slice(-500) })
    proc.on('error', e => {
      clearTimeout(timer)
      if (timedOut) return
      resolve({ ok: false, error: `yt-dlp error: ${e.message}` })
    })
    proc.on('close', code => {
      clearTimeout(timer)
      if (timedOut) return
      const url = out.trim().split('\n')[0]
      if (code === 0 && url) {
        _urlCache.set(videoId, { url, expiresAt: Date.now() + URL_TTL_MS })
        resolve({ ok: true, url })
      } else {
        resolve({ ok: false, error: err.trim() || `yt-dlp exited ${code}` })
      }
    })
  })
}

function passHeaders(upstream) {
  const h = { 'Accept-Ranges': 'bytes' }
  if (upstream.headers['content-type']) h['Content-Type'] = upstream.headers['content-type']
  if (upstream.headers['content-length']) h['Content-Length'] = upstream.headers['content-length']
  if (upstream.headers['content-range']) h['Content-Range'] = upstream.headers['content-range']
  return h
}

function streamFromUrl(url, req, res, videoId, allowRetry) {
  const client = url.startsWith('https') ? https : http
  const headers = { 'user-agent': 'Mozilla/5.0' }
  if (req.headers.range) headers.range = req.headers.range

  const upstream = client.get(url, { headers }, up => {
    // Signed URL expired — drop it, resolve fresh, retry once.
    if ((up.statusCode === 403 || up.statusCode === 410) && allowRetry) {
      up.resume()
      _urlCache.delete(videoId)
      resolveAudioUrl(videoId).then(fresh => {
        if (fresh.ok) streamFromUrl(fresh.url, req, res, videoId, false)
        else if (!res.headersSent) res.status(502).json({ error: fresh.error })
      })
      return
    }
    res.writeHead(up.statusCode || 200, passHeaders(up))
    up.pipe(res)
  })

  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).end()
    else res.end()
  })
  req.on('close', () => upstream.destroy())
}

module.exports = function registerYouTube(app, { sseSend, getDownloadDir, cacheDir, scheduleRescan }) {
  ytSearch.setCacheDir(cacheDir)

  // Track in-flight/recent YouTube downloads so the app's Downloads tab can show
  // them (yt-dlp downloads aren't Soulseek transfers, so they're invisible otherwise).
  const ytDownloads = new Map() // videoId -> { videoId, title, artist, pct, state, at }

  app.get('/api/youtube/downloads', (_, res) => {
    // Drop completed entries older than 2 minutes so the list stays tidy
    const now = Date.now()
    for (const [id, d] of ytDownloads) {
      if (d.state !== 'downloading' && now - d.at > 120000) ytDownloads.delete(id)
    }
    res.json([...ytDownloads.values()].sort((a, b) => b.at - a.at))
  })

  app.get('/api/youtube/search', async (req, res) => {
    const q = (req.query.q || '').toString().trim()
    const scope = (req.query.scope || 'music').toString()
    if (!q) return res.status(400).json({ error: 'q required' })
    try {
      const items = scope === 'all' ? await ytSearch.searchAll(q) : await ytSearch.searchMusic(q)
      res.json({ items })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.get('/api/youtube/stream', async (req, res) => {
    const videoId = (req.query.videoId || '').toString()
    if (!videoId) return res.status(400).json({ error: 'videoId required' })
    const r = await resolveAudioUrl(videoId)
    if (!r.ok) return res.status(502).json({ error: r.error })
    streamFromUrl(r.url, req, res, videoId, true)
  })

  app.post('/api/youtube/download', async (req, res) => {
    const { videoId, title, artist } = req.body || {}
    if (!videoId) return res.status(400).json({ error: 'videoId required' })
    // A second request for a track already downloading used to spawn a second
    // yt-dlp onto the same output path. Both wrote the same file, the progress
    // events interleaved, and the Downloads tab showed one entry jumping
    // backwards. The download already in flight IS the answer.
    const running = ytDownloads.get(videoId)
    if (running && running.state === 'downloading') {
      return res.status(202).json({ ok: true, alreadyDownloading: true, pct: running.pct })
    }
    const outDir = path.join(getDownloadDir(), 'YouTube')
    ytDownloads.set(videoId, { videoId, title: title || videoId, artist: artist || '', pct: 0, state: 'downloading', at: Date.now() })
    const result = await ytDownloader.downloadAudio({
      videoId,
      title: title || videoId,
      artist: artist || '',
      outDir,
      onProgress: pct => {
        const d = ytDownloads.get(videoId)
        if (d) { d.pct = pct; d.at = Date.now() }
        sseSend('youtube-download-progress', { videoId, pct })
      },
    })
    if (result.ok) {
      const d = ytDownloads.get(videoId)
      if (d) { d.pct = 100; d.state = 'complete'; d.at = Date.now() }
      sseSend('youtube-download-progress', { videoId, pct: 100, done: true })
      if (typeof scheduleRescan === 'function') scheduleRescan()
      res.json({ ok: true })
    } else {
      const d = ytDownloads.get(videoId)
      if (d) { d.state = 'failed'; d.at = Date.now() }
      sseSend('youtube-download-progress', { videoId, error: result.error, done: true })
      res.status(500).json({ error: result.error })
    }
  })

  // exposed for tests
  return { resolveAudioUrl, _urlCache, _inflight, _setSpawn, ytDownloads }
}
