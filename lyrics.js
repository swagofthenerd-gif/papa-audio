'use strict'
// Lyrics via LRCLIB (synced LRC, free, no key) with a YT Music plain-text
// fallback for streamed tracks. Runs in the main process — no CSP involvement.

const https = require('https')
const fs = require('fs')
const path = require('path')

const LRCLIB_BASE = 'https://lrclib.net/api'
const CACHE_MAX = 200

let _httpOverride = null
function _setHttpForTest(fn) { _httpOverride = fn }

const _cache = new Map() // "artist|title" → result
function _clearCacheForTest() { _cache.clear() }

function _httpGet(url) {
  if (_httpOverride) return _httpOverride(url)
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'PapaAudio/1.0 (https://github.com/shaharyar/papa-audio)' },
      timeout: 10000,
    }, res => {
      let body = ''
      res.on('data', d => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => req.destroy(new Error('lyrics request timed out')))
    req.on('error', reject)
  })
}

// "[mm:ss.xx]text" lines → [{ time, text }] sorted by time; null if no timestamps.
// Standard LRC repeats a chorus by stacking timestamps on one line:
//   [00:10.00][01:20.00][02:30.00]the same words
// Taking only the first left the rest sitting in the text, so the panel showed
// a literal "[01:20.00]the same words" and the line never highlighted at its
// later occurrences.
const LRC_STAMP = /^\s*\[(\d+):(\d+(?:[.:]\d+)?)\]/

function parseLrc(lrc) {
  if (!lrc) return null
  const lines = []
  for (const raw of String(lrc).split('\n')) {
    let rest = raw
    const times = []
    // Consume every leading timestamp, not just one.
    for (;;) {
      const m = rest.match(LRC_STAMP)
      if (!m) break
      // Some files use [mm:ss:cc] instead of [mm:ss.cc].
      const secs = parseFloat(String(m[2]).replace(':', '.'))
      const time = parseInt(m[1], 10) * 60 + secs
      if (!isNaN(time)) times.push(time)
      rest = rest.slice(m[0].length)
    }
    if (!times.length) continue
    // Metadata lines -- [ar:...], [length:...] -- do not match LRC_STAMP
    // because the tag is not numeric, so they are skipped above.
    const text = rest.replace(/<[^>]*>/g, '').trim()
    // One entry per timestamp, all with the same text.
    for (const time of times) lines.push({ time, text })
  }
  if (!lines.length) return null
  return lines.sort((a, b) => a.time - b.time)
}

// Best /api/search hit: prefer duration within ±3s, then synced over plain.
function pickSearchHit(hits, duration) {
  if (!Array.isArray(hits) || !hits.length) return null
  const scored = hits.map(h => {
    let score = 0
    if (duration && Math.abs((h.duration || 0) - duration) <= 3) score += 2
    if (h.syncedLyrics) score += 1
    return { h, score }
  }).sort((a, b) => b.score - a.score)
  return scored[0].h
}

function _toResult(rec, source) {
  const synced = parseLrc(rec?.syncedLyrics)
  const plain = rec?.plainLyrics || (synced ? null : null)
  if (!synced && !rec?.plainLyrics) return null
  return { synced, plain: rec.plainLyrics || null, source }
}

async function _lrclibGet({ artist, title, album, duration }) {
  const q = new URLSearchParams({ artist_name: artist || '', track_name: title || '' })
  if (album) q.set('album_name', album)
  if (duration) q.set('duration', String(Math.round(duration)))
  const res = await _httpGet(`${LRCLIB_BASE}/get?${q}`)
  if (res.status !== 200) return null
  try { return _toResult(JSON.parse(res.body), 'lrclib') } catch { return null }
}

async function _lrclibSearch({ artist, title, duration }) {
  const q = new URLSearchParams({ artist_name: artist || '', track_name: title || '' })
  const res = await _httpGet(`${LRCLIB_BASE}/search?${q}`)
  if (res.status !== 200) return null
  try {
    const hit = pickSearchHit(JSON.parse(res.body), duration)
    return hit ? _toResult(hit, 'lrclib-search') : null
  } catch { return null }
}

async function _ytLyrics(videoId) {
  if (!videoId) return null
  try {
    const ys = require('./youtube-search')
    const yt = await ys._clientForLyrics()
    const shelf = await yt.music.getLyrics(videoId)
    const text = shelf?.description?.text || shelf?.description?.toString?.() || null
    return text ? { synced: null, plain: String(text), source: 'youtube' } : null
  } catch { return null }
}

function _sidecarPath(filePath) {
  if (!filePath || /^https?:\/\//.test(filePath)) return null
  const ext = path.extname(filePath)
  return ext ? filePath.slice(0, -ext.length) + '.lrc' : filePath + '.lrc'
}

// A saved .lrc next to the audio file always wins — works offline and lets
// the user pin corrected lyrics.
function _fromSidecar(filePath) {
  const lrcPath = _sidecarPath(filePath)
  if (!lrcPath) return null
  try {
    if (!fs.existsSync(lrcPath)) return null
    const synced = parseLrc(fs.readFileSync(lrcPath, 'utf8'))
    return synced ? { synced, plain: null, source: 'file' } : null
  } catch { return null }
}

function saveLyrics({ filePath, lrcContent }) {
  const lrcPath = _sidecarPath(filePath)
  if (!lrcPath) return { ok: false, error: 'Streams have no local file to save next to' }
  try {
    fs.writeFileSync(lrcPath, lrcContent)
    _cache.clear() // next fetch must pick up the sidecar
    return { ok: true, path: lrcPath }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

async function fetchLyrics({ artist, title, album, duration, videoId, filePath, force }) {
  const fromFile = _fromSidecar(filePath)
  if (fromFile) return fromFile
  const key = `${(artist || '').toLowerCase()}|${(title || '').toLowerCase()}`
  if (force) _cache.delete(key)
  if (_cache.has(key)) return _cache.get(key)
  let result = null
  try { result = await _lrclibGet({ artist, title, album, duration }) } catch { /* fall through */ }
  if (!result) { try { result = await _lrclibSearch({ artist, title, duration }) } catch { /* fall through */ } }
  if (!result) result = await _ytLyrics(videoId)
  if (!result) result = { synced: null, plain: null, source: null }
  _cache.set(key, result)
  if (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value)
  return result
}

module.exports = { fetchLyrics, saveLyrics, parseLrc, pickSearchHit, _setHttpForTest, _clearCacheForTest }
