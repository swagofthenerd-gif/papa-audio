'use strict'
// A local relay in front of a debrid direct link (2026-09-15).
//
// RealDebrid's download servers answer 503 to an OPEN-ENDED range request
// ("Range: bytes=0-"), which is exactly what ffmpeg/mpv sends when it opens a
// file. Measured on one fresh link, same second:
//     plain GET               → 200, 94,007,336 bytes
//     Range: bytes=0-         → 503, a 2,252-byte error page
//     Range: bytes=0-100000   → 206, 100,001 bytes
//     HEAD                    → 200
// So the player received an error page as if it were the film, failed to find
// the container headers, and gave up — which is why paying for debrid appeared
// to change nothing at all.
//
// Turning seeking off would dodge it (a plain GET works) at the cost of not
// being able to seek in a film, which is not a trade worth making. Instead
// this relay bounds every range before it goes upstream: the player asks for
// "from here to the end", the relay asks for "from here to the last byte".
// Seeking keeps working and the player never sees a 503.
const http = require('http')

// A request that fails upstream is retried a couple of times: the same
// servers intermittently 503 even a bounded range (two in five, measured).
const UPSTREAM_TRIES = 3
const RETRY_DELAY_MS = 400

function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m) return null
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return null
  // "bytes=-500" means the last 500 bytes.
  if (!hasStart) {
    const len = Number(m[2])
    if (!Number.isFinite(len) || len <= 0 || !total) return null
    return { start: Math.max(0, total - len), end: total - 1 }
  }
  const start = Number(m[1])
  if (!Number.isFinite(start) || start < 0) return null
  // The whole point: an absent end becomes the last byte, never open-ended.
  const end = hasEnd ? Number(m[2]) : (total ? total - 1 : null)
  if (end == null || !Number.isFinite(end) || end < start) return null
  return { start, end }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function createDebridProxy({ fetchFn, host = '127.0.0.1' } = {}) {
  const fetcher = fetchFn || fetch
  let server = null
  let target = null
  let total = 0
  let contentType = 'video/x-matroska'

  // The file's size. A HEAD usually answers, but these servers 503
  // intermittently (two in five, measured) — including on HEAD — so it is
  // retried, and then falls back to asking for a single byte and reading the
  // total out of Content-Range ("bytes 0-0/94007336").
  async function _probe(url) {
    for (let i = 0; i < UPSTREAM_TRIES; i++) {
      try {
        const res = await fetcher(url, { method: 'HEAD' })
        if (res && res.ok) {
          const len = Number(res.headers.get('content-length'))
          if (Number.isFinite(len) && len > 0) {
            total = len
            contentType = res.headers.get('content-type') || contentType
            return total
          }
        }
      } catch (_) { /* fall through to the retry */ }
      await _sleep(RETRY_DELAY_MS * (i + 1))
    }
    for (let i = 0; i < UPSTREAM_TRIES; i++) {
      try {
        const res = await fetcher(url, { headers: { Range: 'bytes=0-0' } })
        if (res && (res.status === 206 || res.status === 200)) {
          const cr = res.headers.get('content-range') || ''
          const m = /\/(\d+)\s*$/.exec(cr)
          contentType = res.headers.get('content-type') || contentType
          try { if (res.body && res.body.cancel) res.body.cancel() } catch (_) {}
          if (m) { total = Number(m[1]); return total }
        }
      } catch (_) { /* fall through to the retry */ }
      await _sleep(RETRY_DELAY_MS * (i + 1))
    }
    throw new Error('debrid server would not report the file size')
  }

  async function _upstream(start, end) {
    let last = null
    for (let i = 0; i < UPSTREAM_TRIES; i++) {
      try {
        const res = await fetcher(target, { headers: { Range: `bytes=${start}-${end}` } })
        if (res && (res.status === 206 || res.status === 200)) return res
        last = new Error('upstream ' + (res && res.status))
      } catch (e) { last = e }
      await _sleep(RETRY_DELAY_MS * (i + 1))
    }
    throw last || new Error('upstream failed')
  }

  async function _handle(req, res) {
    try {
      const wanted = parseRange(req.headers.range, total) || { start: 0, end: total ? total - 1 : 0 }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(total), 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
        return res.end()
      }
      const up = await _upstream(wanted.start, wanted.end)
      const length = wanted.end - wanted.start + 1
      res.writeHead(req.headers.range ? 206 : 200, Object.assign({
        'Content-Length': String(length),
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      }, req.headers.range ? { 'Content-Range': `bytes ${wanted.start}-${wanted.end}/${total}` } : {}))
      if (!up.body) { const buf = Buffer.from(await up.arrayBuffer()); return res.end(buf) }
      const reader = up.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(Buffer.from(value))) {
          await new Promise(r => res.once('drain', r))
        }
      }
      res.end()
    } catch (e) {
      // A player that loses the stream mid-file retries; an honest 502 is
      // better than a silent truncation it would treat as the end.
      try { if (!res.headersSent) res.writeHead(502); res.end() } catch (_) {}
    }
  }

  return {
    // Point the relay at a debrid link; returns the local URL to play.
    async serve(url) {
      target = url
      await _probe(url)
      if (!server) {
        server = http.createServer((req, res) => { _handle(req, res) })
        server.on('clientError', (_e, sock) => { try { sock.destroy() } catch (_) {} })
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, host, resolve)
        })
      }
      const addr = server.address()
      return `http://${host}:${addr.port}/stream`
    },
    stop() {
      if (server) { try { server.close() } catch (_) {} server = null }
      target = null; total = 0
    },
    _total: () => total,
  }
}

module.exports = { createDebridProxy, parseRange, UPSTREAM_TRIES }
