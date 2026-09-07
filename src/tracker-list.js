'use strict'
// Curated BitTorrent tracker-list refresh for the video side.
//
// A magnet's announce list is how a fresh torrent finds peers before DHT/PEX
// warm up: an empty or stale tracker list is the difference between a stream
// that starts in two seconds and one that "buffers" for thirty while it waits
// for the swarm to find it on its own. The best public trackers churn — one
// that was healthy last month may be dead today — so a list baked into the app
// once at release slowly rots. This module keeps a small, curated list fresh by
// pulling ngosang/trackerslist's `trackers_best.txt` on a weekly cadence,
// validating its shape, and merging it into the announce list every torrent is
// added with. It NEVER fails playback: a refresh that errors, times out, or
// returns junk leaves the last-good list (or the baked-in default) in place.
//
// The file is two halves. Above the "Exec layer" divider everything is pure —
// no network, no clock except what is passed in — so the validation, the
// staleness window and the merge are all testable offline. The exec layer below
// binds those decisions to fetch and a persistent side-store.

// ── Constants (policy) ───────────────────────────────────────────────────────

// The upstream list. `trackers_best.txt` is ngosang's hand-pruned "best" subset
// (roughly a dozen high-uptime trackers), not the exhaustive `trackers_all`,
// which is exactly what an announce list wants — a short list of trackers that
// actually answer beats a long list mostly full of dead ones.
const SOURCE_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt'

// One network fetch, hard-capped. A refresh is best-effort background work; a
// hung raw.githubusercontent must never hold anything open.
const FETCH_TIMEOUT_MS = 10 * 1000

// Refresh no more than weekly. The list changes on the order of days, and this
// is a background convenience, not something to hammer on every launch.
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

// Never let a fetched (or merged) list grow without bound: a magnet with a
// hundred trackers spends its first seconds firing announces at dead hosts. The
// curated "best" list is well under this; the cap is a guard against a upstream
// change or a merge that balloons.
const MAX_TRACKERS = 30

// The list baked into the module, used on a first run before any refresh has
// happened and as the permanent floor if every refresh ever fails. These are
// long-lived, high-uptime open trackers; kept deliberately short. Maintenance
// note: this only needs revisiting if ALL of these die at once, which the weekly
// refresh is designed to paper over long before it matters.
const DEFAULT_TRACKERS = Object.freeze([
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'udp://tracker.moeking.me:6969/announce',
])

// ── Validation (pure) ────────────────────────────────────────────────────────

// A tracker URL we are willing to announce to: a udp/http/https URL and nothing
// else. Anything with a wss:// (webtorrent-only), a ws://, or garbage is
// rejected — the WebTorrent Node client cannot use wss trackers usefully and a
// non-URL is just noise in the announce list.
function isValidTracker(url) {
  if (typeof url !== 'string') return false
  const u = url.trim()
  if (!u) return false
  return /^(udp|https?):\/\/[^\s]+$/i.test(u)
}

// Turn the raw text body of trackers_best.txt into a clean, de-duplicated,
// capped array of valid tracker URLs. The upstream format is one URL per line
// with blank separator lines; anything that is not a valid tracker line is
// dropped rather than failing the whole parse — a single junk line must not
// discard a dozen good trackers. Returns [] when nothing valid was found, which
// the caller treats as a failed refresh (last-good stands).
function parseTrackerList(text) {
  if (typeof text !== 'string') return []
  const seen = new Set()
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!isValidTracker(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= MAX_TRACKERS) break
  }
  return out
}

// Validate a whole candidate list (the parsed result, or a persisted side-store
// value). Valid means: a non-empty array of valid tracker strings. Returns the
// cleaned/capped list, or null when the candidate is not usable — so a corrupt
// side-store or an empty fetch both collapse to "fall back to last-good/default"
// through one code path.
function validateList(list) {
  if (!Array.isArray(list)) return null
  const seen = new Set()
  const clean = []
  for (const u of list) {
    if (!isValidTracker(u)) continue
    const t = u.trim()
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    clean.push(t)
    if (clean.length >= MAX_TRACKERS) break
  }
  return clean.length ? clean : null
}

// Merge a provider's own announce list (whatever came in the magnet) with our
// curated list, de-duplicated, order-stable (the magnet's own trackers first so
// a provider that knows a private/faster tracker keeps its lead), capped. Either
// side may be missing. Kept pure so the wiring can call it per-add cheaply.
function mergeAnnounce(magnetAnnounce, curated) {
  const seen = new Set()
  const out = []
  const push = arr => {
    if (!Array.isArray(arr)) return
    for (const u of arr) {
      if (!isValidTracker(u)) continue
      const t = u.trim()
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(t)
      if (out.length >= MAX_TRACKERS) return
    }
  }
  push(magnetAnnounce)
  push(curated)
  return out
}

// ── Staleness (pure) ─────────────────────────────────────────────────────────

// Is a weekly refresh due? A never-refreshed store (lastRefreshAt null/0) is
// always due; otherwise throttled to REFRESH_INTERVAL_MS. Mirrors
// ytdlp-manager's shouldAutoCheck exactly.
//   input: { lastRefreshAt, now, intervalMs? }
function isRefreshDue({ lastRefreshAt, now, intervalMs = REFRESH_INTERVAL_MS } = {}) {
  if (!lastRefreshAt) return true
  return (now - lastRefreshAt) >= intervalMs
}

// ═════════════════════════════════════════════════════════════════════════════
// Exec layer — binds the pure decisions above to fetch and a persistent
// side-store. `fetchFn`, `nowFn` and `store` are injected so the whole class is
// unit-testable without a network, a clock, or a real SideStore.
// ═════════════════════════════════════════════════════════════════════════════

// A hard-deadline fetch, matching tools/source-canary.js's fetchWithTimeout —
// AbortController + timer so a mirror that never answers cannot hold the refresh
// open past FETCH_TIMEOUT_MS.
async function _fetchText(fetchFn, url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, headers: { 'User-Agent': 'papa-audio/1.0' } })
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

class TrackerList {
  // opts:
  //   store   — a SideStore-shaped object: get()/set(). Holds
  //             { trackers, lastRefreshAt }. Optional; without it the class
  //             just serves the default list and never persists.
  //   fetchFn — global fetch by default.
  //   nowFn   — Date.now by default.
  constructor(opts = {}) {
    this._store = opts.store || null
    this._fetchFn = opts.fetchFn || (typeof fetch === 'function' ? fetch : null)
    this._nowFn = opts.nowFn || Date.now
    this._url = opts.url || SOURCE_URL
  }

  now() { return this._nowFn() }

  // The curated list to merge into announce lists right now: the persisted
  // last-good list if it validates, else the baked-in default. Never throws,
  // never empty.
  current() {
    if (this._store) {
      const saved = this._store.get()
      const valid = validateList(saved && saved.trackers)
      if (valid) return valid
    }
    return DEFAULT_TRACKERS.slice()
  }

  // Merge this module's curated list into a magnet's own announce list.
  announceFor(magnetAnnounce) {
    return mergeAnnounce(magnetAnnounce, this.current())
  }

  lastRefreshAt() {
    if (!this._store) return 0
    const saved = this._store.get()
    return (saved && saved.lastRefreshAt) || 0
  }

  // The scheduled weekly refresh. Throttled by the persisted lastRefreshAt;
  // force=true bypasses it (the manual "Check now" button). Best-effort: on any
  // failure the last-good list stays, and { ok:false } is returned rather than
  // thrown. On success persists the fresh list and stamps lastRefreshAt.
  async refresh({ force = false } = {}) {
    const now = this._nowFn()
    if (!force && !isRefreshDue({ lastRefreshAt: this.lastRefreshAt(), now })) {
      return { ok: true, skipped: 'throttled', count: this.current().length }
    }
    if (!this._fetchFn) return { ok: false, error: 'no fetch available' }
    let text
    try {
      text = await _fetchText(this._fetchFn, this._url, FETCH_TIMEOUT_MS)
    } catch (e) {
      // A failed refresh must not touch lastRefreshAt — we want the next tick to
      // try again, not wait a week after a transient failure.
      return { ok: false, error: String((e && e.message) || e), count: this.current().length }
    }
    const parsed = validateList(parseTrackerList(text))
    if (!parsed) {
      return { ok: false, error: 'fetched list had no valid trackers', count: this.current().length }
    }
    if (this._store) {
      this._store.set({ trackers: parsed, lastRefreshAt: now })
    }
    return { ok: true, updated: true, count: parsed.length }
  }
}

module.exports = {
  TrackerList,
  // Pure functions and constants (exported for tests and the wiring).
  isValidTracker,
  parseTrackerList,
  validateList,
  mergeAnnounce,
  isRefreshDue,
  SOURCE_URL,
  FETCH_TIMEOUT_MS,
  REFRESH_INTERVAL_MS,
  MAX_TRACKERS,
  DEFAULT_TRACKERS,
}
