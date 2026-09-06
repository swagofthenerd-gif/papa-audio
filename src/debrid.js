'use strict'
// RealDebrid magnet → direct HTTPS stream (roadmap #40).
//
// When the user has a debrid account, a magnet the swarm would take a minute to
// connect to is usually already cached on RealDebrid's side and comes back as a
// plain HTTPS URL that mpv plays like any other file — no peers, no wait. This
// module is the whole of that conversation with the RealDebrid REST API, kept
// out of main.js so it is testable against a fake fetch and so the token never
// leaks past the one place that reads it.
//
// The flow RealDebrid actually requires, in order:
//   1. POST /torrents/addMagnet         → { id }              (register the magnet)
//   2. POST /torrents/selectFiles/{id}  (select all, or the video)
//   3. GET  /torrents/info/{id}         → poll until status:'downloaded'
//   4. the info's `links` are RD's own /d/ links, not yet playable
//   5. POST /unrestrict/link            → { download }        (the real HTTPS URL)
//
// Everything is config-gated in main.js: this module is never constructed unless
// debridProvider is 'realdebrid' and a token is set. It is deliberately provider-
// shaped (a `provider` field, a factory) so AllDebrid can be added later behind
// the same createDebrid() door without the caller changing.

const API = 'https://api.real-debrid.com/rest/1.0'

// The file extensions worth streaming. A pack's .nfo, .txt and sample clips are
// never the episode; picking the largest video file is the same heuristic the
// torrent streamer uses, and it is right for both a single film and a season
// pack (where the caller narrows further by size before this even runs).
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|webm|ts|wmv|flv|mpg|mpeg)$/i

// How long to wait, total, for a magnet to reach 'downloaded' on RD's side. A
// cached magnet flips to downloaded almost immediately; an uncached one would
// take minutes RD spends fetching it, which is longer than the streaming budget
// the caller allows — so this is a ceiling, and the caller's own budget (10s in
// main.js) usually trips first and falls back to P2P.
const DEFAULT_POLL_TIMEOUT_MS = 30000
// How often to re-ask for the torrent's status while polling.
const DEFAULT_POLL_INTERVAL_MS = 1500

// The statuses RealDebrid reports on GET /torrents/info. Only 'downloaded' is a
// success; the *_error and 'dead' family are terminal failures worth giving up
// on at once rather than polling to the timeout.
const RD_TERMINAL_FAIL = new Set([
  'magnet_error', 'error', 'virus', 'dead',
])

// A small typed error so the caller can tell "RD said no" (fall back to P2P
// silently) from a programming mistake.
class DebridError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DebridError'
    this.code = code || 'DEBRID_FAILED'
  }
}

// The infohash out of a magnet URI, lower-cased, or '' when there is none. Used
// as the session cache key so the same magnet asked twice in one sitting reuses
// the first answer rather than re-registering it with RD.
function infoHashOf(magnet) {
  if (typeof magnet !== 'string') return ''
  const m = magnet.match(/xt=urn:btih:([a-z0-9]+)/i)
  return m ? m[1].toLowerCase() : ''
}

function createDebrid(opts = {}) {
  const provider = opts.provider || 'realdebrid'
  // The token is read through a getter so a token changed in Settings is picked
  // up without rebuilding the instance, mirroring the catalog factories.
  const getToken = typeof opts.token === 'function' ? opts.token : () => opts.token
  // Seams for tests: the default is global fetch, the default clock is Date.now,
  // and sleep is awaited between polls so a fake can advance instantly.
  const fetchFn = opts.fetchFn || ((...a) => fetch(...a))
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : ms => new Promise(r => setTimeout(r, ms))
  const pollTimeoutMs = Number(opts.pollTimeoutMs) > 0 ? Number(opts.pollTimeoutMs) : DEFAULT_POLL_TIMEOUT_MS
  const pollIntervalMs = Number(opts.pollIntervalMs) > 0 ? Number(opts.pollIntervalMs) : DEFAULT_POLL_INTERVAL_MS

  // magnet infohash → resolved HTTPS URL, for the life of this instance. A magnet
  // resolved once should not pay the whole addMagnet/poll/unrestrict round trip
  // again in the same session (a source switch back and forth, a re-watch).
  const linkCache = new Map()

  function authHeaders() {
    const token = getToken()
    if (!token) throw new DebridError('no debrid token configured', 'NO_TOKEN')
    return { Authorization: `Bearer ${token}` }
  }

  // One RD request. Non-2xx is an error carrying RD's own code where it sent one,
  // so 401 (bad token) reads differently from a 503 (RD down). JSON is parsed
  // only when the body is non-empty — selectFiles answers 204 with no body.
  async function rd(method, endpoint, body) {
    const init = { method, headers: { ...authHeaders() } }
    if (body != null) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded'
      init.body = body
    }
    const res = await fetchFn(`${API}${endpoint}`, init)
    if (!res || !res.ok) {
      const status = res ? res.status : 0
      let detail = ''
      try { detail = await res.text() } catch (_) {}
      throw new DebridError(
        `RealDebrid ${method} ${endpoint} → ${status}${detail ? ` ${detail}` : ''}`,
        status === 401 ? 'BAD_TOKEN' : 'HTTP_' + status,
      )
    }
    const text = await res.text()
    if (!text) return null
    try { return JSON.parse(text) } catch (_) { return null }
  }

  // The user's account, used by debridCheck(): whether the token works and, when
  // premium, until when. Any failure is reported as not-ok rather than thrown,
  // so a settings surface can show one boolean without a try/catch.
  async function check() {
    if (!getToken()) return { configured: false, ok: false }
    try {
      const user = await rd('GET', '/user')
      const premium = user && (user.type === 'premium' || Number(user.premium) > 0)
      // RD's `expiration` is an ISO string; carry it through only for premium.
      const premiumUntil = premium && user.expiration ? user.expiration : null
      return { configured: true, ok: !!premium, premiumUntil }
    } catch (e) {
      return { configured: true, ok: false, error: (e && e.message) || String(e) }
    }
  }

  // Pick the file to stream out of an RD torrent-info `files` array. RD numbers
  // files from 1 and marks the selected ones with `selected:1`; the largest
  // selected video wins, falling back to the largest video of any, then null.
  function pickVideoFile(files) {
    const list = Array.isArray(files) ? files : []
    const videos = list.filter(f => f && VIDEO_EXT.test(String(f.path || '')))
    if (!videos.length) return null
    const selected = videos.filter(f => Number(f.selected) === 1)
    const pool = selected.length ? selected : videos
    return pool.reduce((best, f) =>
      (!best || (Number(f.bytes) || 0) > (Number(best.bytes) || 0)) ? f : best, null)
  }

  // The whole flow. Returns the direct HTTPS URL, or throws DebridError. The
  // caller races this against its own budget and falls back to P2P on any throw.
  async function resolveMagnet(magnet) {
    if (!magnet || typeof magnet !== 'string') {
      throw new DebridError('no magnet to resolve', 'NO_MAGNET')
    }
    const hash = infoHashOf(magnet)
    if (hash && linkCache.has(hash)) return linkCache.get(hash)

    // 1. Register the magnet.
    const added = await rd('POST', '/torrents/addMagnet',
      'magnet=' + encodeURIComponent(magnet))
    const id = added && added.id
    if (!id) throw new DebridError('RealDebrid did not return a torrent id', 'NO_ID')

    // 2. Select the files. 'all' lets RD download the whole pack; pickVideoFile
    //    below narrows to the one worth streaming. Selecting all is simplest and
    //    matches what the RD web UI does for a magnet you have not curated.
    await rd('POST', `/torrents/selectFiles/${id}`, 'files=all')

    // 3. Poll until downloaded, a terminal failure, or the timeout.
    const deadline = now() + pollTimeoutMs
    let info = null
    for (;;) {
      info = await rd('GET', `/torrents/info/${id}`)
      const status = info && info.status
      if (status === 'downloaded') break
      if (RD_TERMINAL_FAIL.has(status)) {
        throw new DebridError(`RealDebrid could not fetch this magnet (${status})`, 'RD_' + status)
      }
      if (now() >= deadline) {
        throw new DebridError('RealDebrid did not finish in time', 'TIMEOUT')
      }
      await sleep(pollIntervalMs)
    }

    // 4. Match the picked file to its /d/ link. RD's `links` are in the order of
    //    the *selected* files, so the video's position among selected files is
    //    its index into links.
    const file = pickVideoFile(info.files)
    if (!file) throw new DebridError('no video file in this magnet', 'NO_VIDEO')
    const selected = (Array.isArray(info.files) ? info.files : []).filter(f => Number(f.selected) === 1)
    const at = selected.findIndex(f => f && f.id === file.id)
    const links = Array.isArray(info.links) ? info.links : []
    const restricted = (at >= 0 && links[at]) || links[0]
    if (!restricted) throw new DebridError('RealDebrid returned no download link', 'NO_LINK')

    // 5. Unrestrict into the real, streamable HTTPS URL.
    const un = await rd('POST', '/unrestrict/link', 'link=' + encodeURIComponent(restricted))
    const url = un && un.download
    if (!url) throw new DebridError('RealDebrid did not return a direct link', 'NO_DOWNLOAD')

    if (hash) linkCache.set(hash, url)
    return url
  }

  return {
    provider,
    resolveMagnet,
    check,
    // Test/inspection surface, not part of the caller contract.
    _pickVideoFile: pickVideoFile,
    _cacheSize: () => linkCache.size,
    _hasCached: hash => linkCache.has(String(hash || '').toLowerCase()),
  }
}

module.exports = {
  createDebrid,
  infoHashOf,
  DebridError,
  VIDEO_EXT,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  RD_TERMINAL_FAIL,
}
