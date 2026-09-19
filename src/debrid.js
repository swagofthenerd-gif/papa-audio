'use strict'
const { makeCache } = require('./ttl-cache')
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

// The SAME episode matcher the torrent path uses. This module used to pick the
// largest video in a pack, full stop, so a debrid-served season pack handed
// back an arbitrary episode while the torrent path got the right one — the two
// halves of the app disagreeing about which episode "episode 9" is. One
// definition, used by both.
const { matchesWantedEpisode, episodeNumberOf, JUNK } = require('../torrent-stream')

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
// An unrestricted RealDebrid link does NOT last. Measured 2026-09-15: a link
// resolved minutes earlier answered 503 Service Unavailable to both curl and
// mpv, while one minted seconds before streamed at 2.2 MB/s. The old cache
// held links forever, so a play handed mpv a dead URL, mpv failed, and the
// app fell back to peers — which is exactly why paying for debrid changed
// nothing. Links are now short-lived and proved before use.
const LINK_TTL_MS = 10 * 60 * 1000
// How long to wait when proving a link is still alive (one byte).
const VERIFY_TIMEOUT_MS = 2500
// How many times to ask whether a link is alive before believing it is not.
// Two quick looks, not three slow ones: the relay that follows retries every
// upstream request anyway, so this only has to catch a link that is plainly
// dead — not fight a busy server (2026-09-16).
const ALIVE_TRIES = 2

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

// RealDebrid reports a file as a path inside the torrent ('/Season 1/Show - 09.mkv').
// The episode number lives in the filename; the folder is the season.
function baseNameOf(path) {
  const parts = String(path || '').split(/[/\\]/)
  return parts[parts.length - 1] || ''
}

function folderOf(path) {
  const parts = String(path || '').split(/[/\\]/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : ''
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
  // Dry run (injected by main.js from PAPA_DRY_RUN). A QA twin must never be
  // able to write to the user's real RealDebrid account — the twelve stray
  // addMagnet calls of 2026-09-18 are why this exists. Rather than gate the
  // four write helpers one by one and hope none is added later, the refusal
  // sits at the single choke point every RealDebrid request passes through
  // (rd(), below) and refuses anything that is not a GET. addMagnet,
  // selectFiles, delete and unrestrict/link are all POST or DELETE, so all
  // four are covered, and so is any write nobody has written yet.
  // A function is accepted as well as a boolean so the flag can be read late.
  const isDryRun = typeof opts.dryRun === 'function'
    ? () => opts.dryRun() === true
    : () => opts.dryRun === true
  const pollTimeoutMs = Number(opts.pollTimeoutMs) > 0 ? Number(opts.pollTimeoutMs) : DEFAULT_POLL_TIMEOUT_MS
  const pollIntervalMs = Number(opts.pollIntervalMs) > 0 ? Number(opts.pollIntervalMs) : DEFAULT_POLL_INTERVAL_MS

  // magnet infohash → resolved HTTPS URL, for the life of this instance. A magnet
  // resolved once should not pay the whole addMagnet/poll/unrestrict round trip
  // again in the same session (a source switch back and forth, a re-watch).
  // Capped and TTL'd rather than a bare Map. Both of these grew one entry per
  // distinct magnet or torrent ever resolved, for the life of the instance —
  // and an infoCache entry holds a whole torrent's files array plus its links,
  // which for a season pack is twenty-plus file records. Thirteen caches in
  // main.js already go through makeCache for exactly this reason.
  //
  // A debrid link is short-lived anyway (the /d/ link outlives the torrent
  // entry, but not by days), so a TTL is not just hygiene here — it stops a
  // stale link being handed back long after it stopped working.
  const linkCache = makeCache({ cap: 400, ttlMs: 6 * 60 * 60 * 1000 })

  // hash → the torrent's file list and restricted links, as RealDebrid last
  // reported them. Kept because a season pack has one entry per episode and
  // the strip needs all of them, while linkCache only ever held the one file
  // that happened to be played. RD's /d/ links outlive the torrent entry, so
  // this stays usable for switching episodes even after the torrent is gone
  // from the account.
  const infoCache = makeCache({ cap: 200, ttlMs: 6 * 60 * 60 * 1000 })

  // A pack's episodes are different files behind one infohash, so the link
  // cache cannot be keyed on the hash alone — asking for episode 3 after
  // episode 1 would be handed episode 1's link. Requests that name no episode
  // keep the bare hash, so every existing caller behaves exactly as before.
  function keyFor(hash, want) {
    const ep = Number(want && want.episode)
    if (!hash || !Number.isFinite(ep)) return hash
    const se = Number(want && want.season)
    return hash + '#' + (Number.isFinite(se) ? se : '') + 'e' + ep
  }

  function authHeaders() {
    const token = getToken()
    if (!token) throw new DebridError('no debrid token configured', 'NO_TOKEN')
    return { Authorization: `Bearer ${token}` }
  }

  // One RD request. Non-2xx is an error carrying RD's own code where it sent one,
  // so 401 (bad token) reads differently from a 503 (RD down). JSON is parsed
  // only when the body is non-empty — selectFiles answers 204 with no body.
  async function rd(method, endpoint, body) {
    // Refused before authHeaders(), before fetchFn: in a dry run the request is
    // never built, so there is nothing for a later edit to accidentally let out.
    if (isDryRun() && String(method).toUpperCase() !== 'GET') {
      throw new DebridError(
        `Dry run — RealDebrid ${method} ${endpoint} was not performed`, 'DRY_RUN')
    }
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
  function pickVideoFile(files, want) {
    const list = Array.isArray(files) ? files : []
    const videos = list.filter(f => f && VIDEO_EXT.test(String(f.path || '')))
    if (!videos.length) return null
    const selected = videos.filter(f => Number(f.selected) === 1)
    const pool = selected.length ? selected : videos

    // In a pack the requested episode is the answer, never the biggest file.
    // Mirrors pickVideoFile in torrent-stream.js, including the "several
    // matches means several encodes of the same episode, take the largest"
    // rule — a v2 and a v1 of episode 9 are both episode 9.
    if (want && want.episode != null && pool.length > 1) {
      // Absolute first, for the same reason as torrent-stream.js's picker: a
      // complete-series batch holds both the seasonal number's file (an earlier
      // season) and the absolute one (the episode actually asked for).
      const pass = w => {
        const m = pool.filter(f => matchesWantedEpisode(baseNameOf(f.path), w))
        return m.length ? m.reduce((best, f) =>
          (!best || (Number(f.bytes) || 0) > (Number(best.bytes) || 0)) ? f : best, null) : null
      }
      const _abs = Number(want.absoluteEpisode)
      if (Number.isFinite(_abs) && _abs >= 1 && _abs !== Number(want.episode)) {
        const hit = pass({ season: null, episode: _abs })
        if (hit) return hit
      }
      const matches = pool.filter(f => matchesWantedEpisode(baseNameOf(f.path), want))
      if (matches.length) {
        return matches.reduce((best, f) =>
          (!best || (Number(f.bytes) || 0) > (Number(best.bytes) || 0)) ? f : best, null)
      }
      // No match: fall through to the largest. A pack that does not hold the
      // episode is better answered with something playable than with nothing,
      // and the caller sees the real file name in the strip either way.
    }
    return pool.reduce((best, f) =>
      (!best || (Number(f.bytes) || 0) > (Number(best.bytes) || 0)) ? f : best, null)
  }

  // The whole flow. Returns the direct HTTPS URL, or throws DebridError. The
  // caller races this against its own budget and falls back to P2P on any throw.
  async function resolveMagnet(magnet, want) {
    if (!magnet || typeof magnet !== 'string') {
      throw new DebridError('no magnet to resolve', 'NO_MAGNET')
    }
    const hash = infoHashOf(magnet)
    const key = keyFor(hash, want)
    // A magnet already registered here only needs a new unrestricted link:
    // two round trips instead of the whole add/select/poll flow.
    const held = key ? linkCache.get(key) : null
    if (held && held.restricted) {
      const fresh = await _unrestrict(held.restricted)
      if (fresh) { linkCache.set(key, { url: fresh, restricted: held.restricted, at: now(), ok: false }); return fresh }
    }
    // The file list from an earlier resolve answers a different episode of the
    // same pack without going near the network again.
    const remembered = hash ? infoCache.get(hash) : null
    if (remembered) {
      const pick = pickVideoFile(remembered.files, want)
      const restricted = pick ? _restrictedFor(remembered, pick) : null
      if (restricted) {
        const fresh = await _unrestrict(restricted)
        if (fresh) { linkCache.set(key, { url: fresh, restricted, at: now(), ok: false }); return fresh }
      }
    }

    // 1. Register the magnet.
    const added = await rd('POST', '/torrents/addMagnet',
      'magnet=' + encodeURIComponent(magnet))
    const id = added && added.id
    if (!id) throw new DebridError('RealDebrid did not return a torrent id', 'NO_ID')

    // 2. Select the files. 'all' lets RD download the whole pack; pickVideoFile
    //    below narrows to the one worth streaming. Selecting all is simplest and
    //    matches what the RD web UI does for a magnet you have not curated.
    await rd('POST', `/torrents/selectFiles/${id}`, 'files=all')

    // 3. Poll until downloaded, a terminal failure, or the timeout. Anything
    //    that does not become playable is removed again — otherwise every
    //    rejected candidate is left cluttering the user's account as a
    //    half-finished download.
    const deadline = now() + pollTimeoutMs
    let info = null
    let settled = false
    const abandon = async () => {
      if (settled) return
      try { await rd('DELETE', `/torrents/delete/${id}`) } catch (_) {}
    }
    try {
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
    // Every file and every link, kept before anything narrows to one: this is
    // the only moment RD reports the whole pack, and the episode strip needs
    // all of it.
    if (hash) infoCache.set(hash, { files: Array.isArray(info.files) ? info.files : [], links: Array.isArray(info.links) ? info.links : [], at: now() })
    const file = pickVideoFile(info.files, want)
    if (!file) throw new DebridError('no video file in this magnet', 'NO_VIDEO')
    const restricted = _restrictedFor(infoCache.get(hash) || { files: info.files, links: info.links }, file)
    if (!restricted) throw new DebridError('RealDebrid returned no download link', 'NO_LINK')

    // 5. Unrestrict into the real, streamable HTTPS URL.
    const un = await rd('POST', '/unrestrict/link', 'link=' + encodeURIComponent(restricted))
    const url = un && un.download
    if (!url) throw new DebridError('RealDebrid did not return a direct link', 'NO_DOWNLOAD')
    settled = true

    // ok:false until something has actually fetched a byte from it — an
    // unproved link must never be offered as instant (found by test, and it
    // is the same class of bug as the stale link that started all this).
    if (key) linkCache.set(key, { url, restricted, at: now(), ok: false })
    return url
    } finally {
      await abandon()
    }
  }

  // The /d/ link belonging to one file. RD's `links` array is in the order of
  // the SELECTED files, so a file's position among the selected ones is its
  // index into links — not its position in `files`, which counts the .nfo and
  // the sample too.
  function _restrictedFor(info, file) {
    const files = Array.isArray(info && info.files) ? info.files : []
    const links = Array.isArray(info && info.links) ? info.links : []
    const selected = files.filter(f => Number(f.selected) === 1)
    const at = file ? selected.findIndex(f => f && f.id === file.id) : -1
    return (at >= 0 && links[at]) || links[0] || null
  }

  // Turn a restricted /d/ link into a playable one. Returns null rather than
  // throwing: every caller has a fallback.
  async function _unrestrict(restricted) {
    try {
      const un = await rd('POST', '/unrestrict/link', 'link=' + encodeURIComponent(restricted))
      return (un && un.download) || null
    } catch (_) { return null }
  }

  // Whether a failure genuinely means "RealDebrid does not have this", as
  // opposed to "RealDebrid could not answer". Only a 404 and RD's own terminal
  // verdicts on a magnet are about the release; a 401, a 429, a 503 and a
  // network error are about the service or the account, and reporting those as
  // a missing file sends the user hunting in the wrong place.
  function _isNotFound(e) {
    const code = e && e.code
    if (!code) return false
    return code === 'HTTP_404' || code === 'HTTP_204' ||
      (typeof code === 'string' && code.startsWith('RD_'))
  }

  // Drop a response body we are never going to read. Cancel if it can be
  // cancelled, consume it otherwise; either way the socket goes back.
  function _discard(res) {
    if (!res) return
    try {
      const body = res.body
      if (body && typeof body.cancel === 'function') { body.cancel().catch(() => {}); return }
      if (body && typeof body.destroy === 'function') { body.destroy(); return }
    } catch (_) { /* fall through to draining */ }
    try { if (typeof res.text === 'function') Promise.resolve(res.text()).catch(() => {}) } catch (_) {}
  }

  // Prove a link still serves bytes. RealDebrid answers 503 on a link that has
  // gone stale, and handing that to the player looks exactly like debrid not
  // working at all. One byte is enough to tell.
  // RETRIED, because these servers answer 503 to a perfectly good link about
  // two times in five (measured). A single probe threw away working links and
  // sent playback back to the swarm — "held but unplayable" in the log.
  async function _alive(url) {
    for (let i = 0; i < ALIVE_TRIES; i++) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null
      const timer = ctrl ? setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS) : null
      try {
        const res = await fetchFn(url, Object.assign(
          { method: 'GET', headers: { Range: 'bytes=0-0' } },
          ctrl ? { signal: ctrl.signal } : {}))
        // A server that ignores the one-byte range answers 200 and starts
        // sending the whole film. Nothing here reads that body, so the socket
        // sat open until the shim's own deadline killed it 20 s later — one
        // held connection per candidate probed, against servers that start
        // refusing everything once connections pile up. Let it go now.
        _discard(res)
        if (res && (res.status === 206 || res.status === 200)) return true
        // A 404/410 is a settled answer about the link; only retry a refusal
        // that is plausibly the server being busy.
        if (res && res.status !== 503 && res.status !== 500 && res.status !== 429) return false
      } catch (_) {
        // network hiccup: worth one more look
      } finally { if (timer) clearTimeout(timer) }
      if (i < ALIVE_TRIES - 1) await new Promise(r => setTimeout(r, 200))
    }
    return false
  }

  // The link to actually play: a held one when it is young AND still alive,
  // otherwise a freshly minted one. This is what the play path must use —
  // cachedLink() below is only for deciding whether to show a badge.
  async function linkFor(magnet, want) {
    const hash = infoHashOf(magnet)
    const key = keyFor(hash, want)
    const held = key ? linkCache.get(key) : null
    const bless = url => {
      if (key) {
        const e = linkCache.get(key)
        if (e) e.ok = true
        else linkCache.set(key, { url, restricted: null, at: now(), ok: true })
      }
      return url
    }
    if (held && held.url && (now() - held.at) < LINK_TTL_MS && await _alive(held.url)) return bless(held.url)
    // Stale, or dead: resolveMagnet re-mints from the restricted link it kept.
    const fresh = await resolveMagnet(magnet, want)
    if (fresh && await _alive(fresh)) return bless(fresh)
    // Nothing usable. Drop the url but keep `restricted`, which still lets a
    // later attempt re-mint in two round trips instead of the whole flow.
    if (key) {
      const e = linkCache.get(key)
      if (e) { e.url = null; e.ok = false }
    }
    throw new DebridError('RealDebrid link would not serve', 'DEAD_LINK')
  }

  // Every episode RealDebrid is holding behind this magnet, in the shape the
  // episode strip already speaks — the same shape TorrentStreamer.files()
  // returns, so the strip needs no knowledge of where the files came from.
  // `index` is RD's own file id, which is what linkForFile() takes back.
  //
  // This exists because the debrid path never built a file list at all: it
  // resolved one URL and played it, so a season pack served by debrid showed
  // no episode strip and could not be switched, while the same pack served by
  // peers could.
  async function packFiles(magnet, want) {
    const hash = infoHashOf(magnet)
    if (!hash) return []
    let info = infoCache.get(hash)
    if (!info) {
      // Nothing remembered: resolving fills infoCache as a side effect. A
      // release RealDebrid genuinely does not have is an empty strip, fair
      // enough — but swallowing EVERY failure here turned a bad token or an RD
      // outage into "this release has one file", which is a lie the viewer has
      // no way to see through. Anything that is not a plain not-found is said
      // out loud.
      try { await resolveMagnet(magnet, want) } catch (e) {
        if (_isNotFound(e)) return []
        throw e
      }
      info = infoCache.get(hash)
    }
    const files = Array.isArray(info && info.files) ? info.files : []
    const current = pickVideoFile(files, want)
    const groupOrder = new Map()
    return files
      .filter(f => f && Number(f.selected) === 1 &&
        VIDEO_EXT.test(String(f.path || '')) &&
        !JUNK.test(String(f.path || '')) &&
        !/\bnc(?:op|ed)\d*\b/i.test(baseNameOf(f.path)))
      .map(f => {
        const group = folderOf(f.path)
        if (!groupOrder.has(group)) groupOrder.set(group, groupOrder.size)
        return {
          index: Number(f.id),
          name: baseNameOf(f.path),
          group,
          length: Number(f.bytes) || 0,
          episode: episodeNumberOf(baseNameOf(f.path)),
          current: !!(current && current.id === f.id),
        }
      })
      .sort((a, b) => {
        const g = groupOrder.get(a.group) - groupOrder.get(b.group)
        if (g) return g
        if (a.episode == null && b.episode == null) return a.name.localeCompare(b.name)
        if (a.episode == null) return 1
        if (b.episode == null) return -1
        return a.episode - b.episode
      })
  }

  // A playable link for one named file of a pack — what switching episodes
  // needs. Keyed per file, so switching back and forth costs one unrestrict
  // rather than the whole flow.
  async function linkForFile(magnet, fileId) {
    const hash = infoHashOf(magnet)
    const id = Number(fileId)
    if (!hash || !Number.isFinite(id)) throw new DebridError('no such file in this release', 'NO_FILE')
    const key = hash + '/' + id
    const held = linkCache.get(key)
    if (held && held.url && (now() - held.at) < LINK_TTL_MS && await _alive(held.url)) {
      held.ok = true
      return held.url
    }
    let info = infoCache.get(hash)
    if (!info) {
      // The same lie as packFiles told, and worse here: a 401 or a 503 fell
      // through to the NO_FILE below, so a bad token and an RD outage both
      // reported "no such file in this release" — the viewer went looking for
      // a problem with the release while the actual problem was their account.
      try { await resolveMagnet(magnet) } catch (e) {
        if (!_isNotFound(e)) throw e
      }
      info = infoCache.get(hash)
    }
    const files = Array.isArray(info && info.files) ? info.files : []
    const file = files.find(f => f && Number(f.id) === id)
    if (!file) throw new DebridError('no such file in this release', 'NO_FILE')
    const restricted = _restrictedFor(info, file)
    if (!restricted) throw new DebridError('RealDebrid returned no download link', 'NO_LINK')
    const url = await _unrestrict(restricted)
    if (!url) throw new DebridError('RealDebrid did not return a direct link', 'NO_DOWNLOAD')
    linkCache.set(key, { url, restricted, at: now(), ok: true })
    return url
  }

  // Is RealDebrid already holding this file? Cheap, and the ONLY part that
  // needs to be asked of every candidate: register, select, look once. A
  // cached torrent reports 'downloaded' immediately; anything else is queued
  // for download on the account, which is not what a viewer pressing Play
  // wants, so it is removed again at once.
  //
  // This exists because resolving candidates one at a time took 30-60 s —
  // far longer than anyone waits before pressing Play, so the app fell back
  // to peers every time and the subscription looked broken (2026-09-16).
  async function isCached(magnet) {
    if (!magnet) return false
    const hash = infoHashOf(magnet)
    // Any proved link for this torrent settles the question, whichever episode
    // it was minted for. Links are keyed per episode now (a pack has one per
    // file), so looking only under the bare hash missed every entry a
    // previously-resolved episode had left behind and re-asked RealDebrid for
    // something it had already answered.
    // makeCache() hands back a plain object with get/set/has/keys, NOT a Map,
    // so `for (const [k, v] of linkCache)` threw "linkCache is not iterable"
    // on every single call and the held-link shortcut never ran. keys() is the
    // cache's own live-entries-only listing, which is what this scan wants.
    if (hash) {
      for (const k of linkCache.keys()) {
        if (k !== hash && !k.startsWith(hash + '#') && !k.startsWith(hash + '/')) continue
        const v = linkCache.get(k)
        if (v && v.ok) return true
      }
    }
    let id = null
    try {
      const added = await rd('POST', '/torrents/addMagnet', 'magnet=' + encodeURIComponent(magnet))
      id = added && added.id
      if (!id) return false
      await rd('POST', `/torrents/selectFiles/${id}`, 'files=all')
      const info = await rd('GET', `/torrents/info/${id}`)
      if (info && info.status === 'downloaded') {
        // Keep the restricted link so resolveMagnet re-mints in two round
        // trips instead of repeating the whole flow.
        const links = Array.isArray(info.links) ? info.links : []
        const file = pickVideoFile(info.files)
        const selected = (Array.isArray(info.files) ? info.files : []).filter(f => Number(f.selected) === 1)
        const at = file ? selected.findIndex(f => f && f.id === file.id) : -1
        const restricted = (at >= 0 && links[at]) || links[0] || null
        if (hash && restricted) linkCache.set(hash, { url: null, restricted, at: now(), ok: false })
        return true
      }
      // Not held: do not leave it downloading on the user's account.
      await rd('DELETE', `/torrents/delete/${id}`).catch(() => {})
      return false
    } catch (e) {
      if (id) { try { await rd('DELETE', `/torrents/delete/${id}`) } catch (_) {} }
      throw e
    }
  }

  // The already-resolved direct link for a magnet, or null. Lets a caller
  // spend no budget at all on a magnet it resolved earlier — the whole point
  // of resolving while the viewer is still reading the page.
  function cachedLink(magnet) {
    const hash = infoHashOf(magnet)
    const held = hash ? linkCache.get(hash) : null
    // Only a young link counts: an expired one is a promise the play path
    // would have to re-mint anyway.
    return held && held.url && held.ok === true && (now() - held.at) < LINK_TTL_MS ? held.url : null
  }

  // Resolve in the background and keep the answer. Never throws and never
  // reports: it is a head start, and a failure just means the play path does
  // the work itself. Concurrent calls for the same magnet share one attempt.
  const inflight = new Map()
  function prewarm(magnet) {
    const hash = infoHashOf(magnet)
    const ready = cachedLink(magnet)
    if (!hash || ready) return Promise.resolve(ready)
    if (inflight.has(hash)) return inflight.get(hash)
    const p = linkFor(magnet)
      .catch(() => null)
      .finally(() => { inflight.delete(hash) })
    inflight.set(hash, p)
    return p
  }

  return {
    provider,
    resolveMagnet,
    isCached,
    linkFor,
    linkForFile,
    packFiles,
    cachedLink,
    prewarm,
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
  LINK_TTL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  RD_TERMINAL_FAIL,
}
