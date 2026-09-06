'use strict';
// Learned dead-magnet memory (App roadmap #41). A magnet that has repeatedly
// failed to connect — no seeders, or a stream that never started — is remembered
// so the next lookup can push it DOWN the ranked source list instead of offering
// it first again. It is never hidden: coverage at the tail is the whole point of
// running many indexers, and a "dead" torrent can revive when a seeder returns.
// So a torrent with a bad history is demoted and flagged (deadHint:true) for a
// future UI badge, not dropped.
//
// The record is a plain map keyed by lower-cased infohash:
//   { "<infohash>": { failures: <int>, lastFailAt: <ms> } }
// It lives in a main-process SideStore; this module is the pure logic over that
// shape so the decay, the threshold and the demotion are all testable with no
// disk and no clock of their own (both are injected).
//
// UMD-wrapped so it loads under Node's test runner and, if it is ever needed,
// as a classic renderer script — same pattern as ttl-cache.js / video-store.js.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaDeadMagnet = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // A failure this many days old no longer counts. A magnet that failed a
  // fortnight ago and has not been tried since is given a clean slate — the
  // swarm it could not reach then may be perfectly healthy now.
  const DECAY_DAYS = 14
  const DECAY_MS = DECAY_DAYS * 24 * 60 * 60 * 1000

  // Two RECENT failures is the bar for demotion. One is noise — a transient
  // network blip, the daemon still waking up; two inside the decay window is a
  // pattern worth acting on.
  const DEMOTE_THRESHOLD = 2

  function _norm(hash) {
    return hash == null ? '' : String(hash).toLowerCase()
  }

  // Record one failure against an infohash, folding it into whatever the map
  // already held. Returns a NEW map (the caller persists it) so the input is
  // never mutated. Stale prior failures are dropped as they are folded in, so
  // the count reflects only what is still inside the decay window plus this one.
  function recordFailure(map, hash, nowMs) {
    const key = _norm(hash)
    if (!key) return map || {}
    const now = Number(nowMs) || 0
    const next = { ...(map && typeof map === 'object' ? map : {}) }
    const prev = next[key]
    const recentPriorFailures =
      prev && (now - (Number(prev.lastFailAt) || 0) <= DECAY_MS)
        ? (Number(prev.failures) || 0)
        : 0
    next[key] = { failures: recentPriorFailures + 1, lastFailAt: now }
    return next
  }

  // How many failures still count for this infohash right now — 0 once the last
  // one has decayed past the window.
  function recentFailures(map, hash, nowMs) {
    const key = _norm(hash)
    const rec = map && typeof map === 'object' ? map[key] : null
    if (!rec) return 0
    const now = Number(nowMs) || 0
    if (now - (Number(rec.lastFailAt) || 0) > DECAY_MS) return 0
    return Number(rec.failures) || 0
  }

  // True when this infohash has reached the demotion bar within the decay
  // window. The ranker uses this to decide what to push down and flag.
  function isDead(map, hash, nowMs) {
    return recentFailures(map, hash, nowMs) >= DEMOTE_THRESHOLD
  }

  // Drop every entry whose last failure has decayed, returning a NEW map. Called
  // opportunistically (e.g. on load) so the file cannot grow without bound with
  // hashes nobody will ever try again.
  function prune(map, nowMs) {
    const now = Number(nowMs) || 0
    const out = {}
    if (!map || typeof map !== 'object') return out
    for (const [key, rec] of Object.entries(map)) {
      if (!rec || typeof rec !== 'object') continue
      if (now - (Number(rec.lastFailAt) || 0) <= DECAY_MS) out[key] = rec
    }
    return out
  }

  return {
    recordFailure,
    recentFailures,
    isDead,
    prune,
    DECAY_DAYS,
    DECAY_MS,
    DEMOTE_THRESHOLD,
  }
})
