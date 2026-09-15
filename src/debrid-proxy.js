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

// Opening or seeking in a film costs FOUR requests to RealDebrid, each
// waiting about 750 ms (logged 2026-09-15): the file opens, the index at the
// very end is read, the headers near the start are read, and only the fourth
// is the place you actually asked for. Three of those four touch the same two
// small regions every single time, so both are fetched once when the relay
// starts and served from memory afterwards. That is ~2.3 s of dead waiting
// removed from every open and every seek.
const HEAD_CACHE_BYTES = 4 * 1024 * 1024
const TAIL_CACHE_BYTES = 8 * 1024 * 1024

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
  // { from, buf } for the opening and closing regions of the file.
  let headCache = null
  let tailCache = null

  // Read one region into memory, retried. Returns null rather than throwing:
  // an uncached region only costs a round trip later.
  async function _slurp(start, end) {
    try {
      const res = await _upstream(start, end, null)
      if (!res) return null
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.length ? { from: start, buf } : null
    } catch (_) { return null }
  }

  // Serve whatever part of [start,end] is already in memory. Returns the
  // number of bytes written, so the caller knows where to resume upstream.
  function _fromCache(res, start, end) {
    for (const c of [headCache, tailCache]) {
      if (!c) continue
      const cStart = c.from
      const cEnd = c.from + c.buf.length - 1
      if (start < cStart || start > cEnd) continue
      const upTo = Math.min(end, cEnd)
      res.write(c.buf.subarray(start - cStart, upTo - cStart + 1))
      return upTo - start + 1
    }
    return 0
  }

  // The file's size. HEAD and a one-byte range are asked AT THE SAME TIME and
  // whichever answers first wins: these servers refuse about two requests in
  // five, and asking them in sequence with backoff was costing seconds on
  // every single play (measured 2026-09-16 — the candidate check took 1 s and
  // then this took over ten).
  async function _probe(url) {
    const viaHead = async () => {
      const res = await fetcher(url, { method: 'HEAD' })
      if (!res || !res.ok) throw new Error('HEAD ' + (res && res.status))
      const len = Number(res.headers.get('content-length'))
      if (!Number.isFinite(len) || len <= 0) throw new Error('no length')
      return { total: len, type: res.headers.get('content-type') }
    }
    const viaRange = async () => {
      const res = await fetcher(url, { headers: { Range: 'bytes=0-0' } })
      if (!res || !(res.status === 206 || res.status === 200)) throw new Error('range ' + (res && res.status))
      const cr = res.headers.get('content-range') || ''
      try { if (res.body && res.body.cancel) res.body.cancel() } catch (_) {}
      const m = /\/(\d+)\s*$/.exec(cr)
      if (!m) throw new Error('no content-range')
      return { total: Number(m[1]), type: res.headers.get('content-type') }
    }
    for (let round = 0; round < 2; round++) {
      const results = await Promise.allSettled([viaHead(), viaRange()])
      const win = results.find(r => r.status === 'fulfilled' && r.value && r.value.total > 0)
      if (win) {
        total = win.value.total
        contentType = win.value.type || contentType
        return total
      }
      if (round === 0) await _sleep(300)
    }
    throw new Error('debrid server would not report the file size')
  }

  async function _upstream(start, end, signal) {
    let last = null
    for (let i = 0; i < UPSTREAM_TRIES; i++) {
      if (signal && signal.aborted) throw new Error('client gone')
      try {
        const res = await fetcher(target, Object.assign(
          { headers: { Range: `bytes=${start}-${end}` } },
          signal ? { signal } : {}))
        if (res && (res.status === 206 || res.status === 200)) return res
        // Drain the error body so the socket is returned to the pool rather
        // than left half-read — a leaked connection is what makes these
        // servers start refusing everything.
        try { if (res && res.body && res.body.cancel) await res.body.cancel() } catch (_) {}
        last = new Error('upstream ' + (res && res.status))
      } catch (e) {
        if (signal && signal.aborted) throw e
        last = e
      }
      await _sleep(RETRY_DELAY_MS * (i + 1))
    }
    throw last || new Error('upstream failed')
  }

  // Wait for the socket to drain, but never forever: a player that seeks
  // abandons its request mid-flight, and a handler parked on a drain that
  // will never come holds an upstream connection open for good.
  function _drain(res) {
    return new Promise(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; cleanup(); resolve() } }
      const cleanup = () => {
        res.off('drain', finish); res.off('close', finish); res.off('error', finish)
      }
      res.once('drain', finish)
      res.once('close', finish)
      res.once('error', finish)
    })
  }

  async function _handle(req, res) {
    // Every request owns an abort signal, fired the moment the player goes
    // away. Without this the upstream fetch keeps running against a dead
    // socket and the connection is never given back.
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    const giveUp = () => { try { if (ctrl) ctrl.abort() } catch (_) {} }
    res.once('close', giveUp)
    req.once('aborted', giveUp)
    try {
      const wanted = parseRange(req.headers.range, total) || { start: 0, end: total ? total - 1 : 0 }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Length': String(total), 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
        return res.end()
      }
      const length = wanted.end - wanted.start + 1
      res.writeHead(req.headers.range ? 206 : 200, Object.assign({
        'Content-Length': String(length),
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      }, req.headers.range ? { 'Content-Range': `bytes ${wanted.start}-${wanted.end}/${total}` } : {}))
      // Anything already in memory goes out with no network wait at all —
      // which is most of what opening and seeking actually read.
      const served = _fromCache(res, wanted.start, wanted.end)
      if (served >= length) return res.end()
      const from = wanted.start + served
      if (res.destroyed || res.writableEnded) return
      const up = await _upstream(from, wanted.end, ctrl ? ctrl.signal : null)
      if (res.destroyed || res.writableEnded) { try { await up.body.cancel() } catch (_) {} ; return }
      if (!up.body) { const buf = Buffer.from(await up.arrayBuffer()); return res.end(buf) }
      const reader = up.body.getReader()
      try {
        for (;;) {
          if (res.destroyed || res.writableEnded) break
          const { done, value } = await reader.read()
          if (done) break
          if (!res.write(Buffer.from(value))) await _drain(res)
        }
      } finally {
        // Whether the player finished, seeked away or vanished, the upstream
        // read is closed here and nowhere else.
        try { await reader.cancel() } catch (_) {}
      }
      if (!res.writableEnded) res.end()
    } catch (e) {
      try {
        if (!res.headersSent && !res.destroyed) { res.writeHead(502); res.end() }
        else if (!res.writableEnded) res.end()
      } catch (_) {}
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
      // Both ends of the file, fetched once, in parallel with each other.
      if (total > 0) {
        const headEnd = Math.min(total - 1, HEAD_CACHE_BYTES - 1)
        const tailFrom = Math.max(0, total - TAIL_CACHE_BYTES)
        const [h, t] = await Promise.all([
          _slurp(0, headEnd),
          tailFrom > headEnd ? _slurp(tailFrom, total - 1) : Promise.resolve(null),
        ])
        headCache = h
        tailCache = t
      }
      const addr = server.address()
      return `http://${host}:${addr.port}/stream`
    },
    stop() {
      if (server) { try { server.close() } catch (_) {} server = null }
      target = null; total = 0
      headCache = null; tailCache = null
    },
    _cached: () => ({ head: headCache ? headCache.buf.length : 0, tail: tailCache ? tailCache.buf.length : 0 }),
    _total: () => total,
  }
}

module.exports = { createDebridProxy, parseRange, UPSTREAM_TRIES }
