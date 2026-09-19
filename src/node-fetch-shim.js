'use strict'
// A fetch built on Node's own HTTP stack, for the main process.
//
// Electron's main-process `fetch` is backed by Chromium's network stack, not
// Node's. Measured 2026-09-16: curl reached api.real-debrid.com six times out
// of six at ~150 ms while the app logged "fetch failed" for the very same
// host, and every debrid test that ever succeeded had been run through plain
// Node. Debrid therefore talks to RealDebrid through this instead, so the
// feature no longer depends on whichever stack Electron happens to use.
//
// Only the subset the debrid client and its relay actually use is
// implemented: ok/status, headers.get, text(), arrayBuffer(), a lazy `body`
// web-stream, request bodies, abort signals and redirects.
const https = require('https')
const http = require('http')
const { Readable } = require('stream')

const MAX_REDIRECTS = 5
// A request with no deadline can stall for ever on a half-open socket. That
// hung the debrid candidate search past its own 60 s IPC timeout, so the
// whole search errored and playback silently fell back to peers (measured
// 2026-09-16). Every request gets a deadline unless the caller sets one.
const DEFAULT_TIMEOUT_MS = 20000

function nodeFetch(url, init = {}, _depth = 0) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(String(url)) } catch (e) { return reject(e) }
    const lib = u.protocol === 'http:' ? http : https
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: init.method || 'GET',
      headers: Object.assign({}, init.headers || {}),
      timeout: Number(init.timeoutMs) > 0 ? Number(init.timeoutMs) : DEFAULT_TIMEOUT_MS,
    }, res => {
      const status = res.statusCode || 0
      const location = res.headers.location
      // RealDebrid's download links redirect to whichever server holds the
      // file; a fetch that does not follow them reads as a failure.
      if (location && status >= 300 && status < 400 && _depth < MAX_REDIRECTS) {
        res.resume()
        const next = new URL(location, u).toString()
        // A redirect after a POST is followed as a GET, as browsers do.
        const nextInit = Object.assign({}, init)
        if (status === 301 || status === 302 || status === 303) {
          nextInit.method = 'GET'
          delete nextInit.body
        }
        return resolve(nodeFetch(next, nextInit, _depth + 1))
      }
      // The deadline above is a SOCKET IDLE timeout, and Node keeps it armed
      // for the whole of the response, not just the wait for it. That is right
      // for a JSON call and wrong for a film: the relay hands the body to mpv,
      // mpv fills its cache and stops reading, TCP back-pressure stops the
      // bytes, and twenty seconds of a legitimate pause looked exactly like a
      // dead socket — so the shim destroyed it and the resume froze. Once the
      // headers are here the request phase is over, so a streaming caller
      // disarms it and relies on its own abort signal instead.
      let disarmed = false
      const disarmIdleTimeout = () => {
        if (disarmed) return
        disarmed = true
        try { req.setTimeout(0) } catch (_) {}
        try { if (res.socket) res.socket.setTimeout(0) } catch (_) {}
      }
      if (init.stream === true) disarmIdleTimeout()
      let webBody = null
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: n => { const v = res.headers[String(n).toLowerCase()]; return Array.isArray(v) ? v[0] : (v == null ? null : v) } },
        text: () => new Promise((rs, rj) => {
          let d = ''
          res.setEncoding('utf8')
          res.on('data', c => { d += c })
          res.on('end', () => rs(d))
          res.on('error', rj)
        }),
        arrayBuffer: () => new Promise((rs, rj) => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => rs(Buffer.concat(chunks)))
          res.on('error', rj)
        }),
        // Lazy: reading `body` converts the stream, so it must not happen
        // unless a caller actually streams.
        get body() {
          // Reaching for the body at all means streaming, whether or not the
          // caller said so up front.
          disarmIdleTimeout()
          if (!webBody) webBody = Readable.toWeb(res)
          return webBody
        },
      })
    })
    req.on('error', reject)
    // `timeout` only fires the event; the socket must be torn down by hand,
    // or the promise never settles.
    req.on('timeout', () => {
      const e = new Error('request timed out')
      e.code = 'ETIMEDOUT'
      try { req.destroy(e) } catch (_) { reject(e) }
    })
    if (init.signal) {
      if (init.signal.aborted) { req.destroy(new Error('aborted')) }
      else init.signal.addEventListener('abort', () => { try { req.destroy(new Error('aborted')) } catch (_) {} }, { once: true })
    }
    if (init.body != null) req.write(init.body)
    req.end()
  })
}

module.exports = { nodeFetch, MAX_REDIRECTS }
