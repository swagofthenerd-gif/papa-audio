'use strict';
// Human-readable formatting for the video feature. Pure — no I/O, no state —
// so every function is a one-line unit test away.
//
// The same numbers appeared inline in three places during the first pass of
// the detail page (runtime, file size, "x days ago"), and two of them rounded
// differently from the third. One module is the fix: one definition, tested
// once, used everywhere.
//
// Loaded by the renderer as a classic script (no module system) and by tests
// via require, so it uses the UMD wrapper from ttl-cache.js and never leaks a
// top-level binding into the shared renderer scope.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaVideoFormat = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function duration(sec) {
    // Number(null) and Number('') are both 0, which would render "unknown" as
    // 0:00 — the opposite of the bug being fixed. Unknown stays unknown.
    if (sec == null || sec === '') return '—'
    const n = Number(sec)
    if (!Number.isFinite(n)) return '—'
    const total = Math.max(0, Math.round(n))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const ss = String(s).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
  }

  function size(bytes) {
    // Number(null) and Number('') are 0, which would render "unknown" as "0 B".
    if (bytes == null || bytes === '') return '—'
    const n = Number(bytes)
    if (!Number.isFinite(n) || n < 0) return '—'
    if (n === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
    let i = 0
    let v = n
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    // Whole bytes are whole; everything else keeps one decimal — enough to tell
    // 4.2 GB from 4.3 GB without pretending to more precision than a torrent
    // indexer reports.
    if (i === 0) return `${Math.round(v)} B`
    return `${v.toFixed(1)} ${units[i]}`
  }

  function bitrate(bps) {
    if (bps == null || bps === '') return '—'
    const n = Number(bps)
    if (!Number.isFinite(n)) return '—'
    // Video bitrates are conventionally decimal (Mbit = 1e6), unlike file sizes.
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mb/s`
    if (n >= 1e3) return `${Math.round(n / 1e3)} kb/s`
    return `${Math.round(n)} b/s`
  }

  // "3 days ago". Injectable `now` so tests do not depend on the wall clock;
  // the renderer never passes it.
  function relativeDate(iso, now) {
    if (iso == null || iso === '') return '—'
    const t = new Date(iso).getTime()
    if (!Number.isFinite(t)) return '—'
    const ref = now == null ? Date.now() : new Date(now).getTime()
    const diff = ref - t
    // A clock skew or a bad date must not read "N seconds ago" as if it were past.
    if (diff < 0) return 'just now'
    // diff is milliseconds; the thresholds below are the same in milliseconds.
    const MIN = 60000, HOUR = 3600000, DAY = 86400000
    if (diff < MIN) return 'just now'
    if (diff < HOUR) return `${Math.floor(diff / MIN)} minute${diff < 2 * MIN ? '' : 's'} ago`
    if (diff < DAY) return `${Math.floor(diff / HOUR)} hour${diff < 2 * HOUR ? '' : 's'} ago`
    if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} day${diff < 2 * DAY ? '' : 's'} ago`
    if (diff < 365 * DAY) {
      const months = Math.floor(diff / (30 * DAY))
      return `${months} month${months === 1 ? '' : 's'} ago`
    }
    const years = Math.floor(diff / (365 * DAY))
    return `${years} year${years === 1 ? '' : 's'} ago`
  }

  // TMDB `release_dates` is `{ results: [ { iso_3166_1, release_dates: [ ... ] } ] }`.
  // US first, GB second, and prefer the theatrical entry (type 3) — a movie can
  // carry a re-rating for a director's cut that is not the one the poster shows.
  // TV uses `content_ratings` instead (`{ results: [ { iso_3166_1, rating } ] }`);
  // both shapes are handled so one helper serves movie and TV detail pages.
  function certification(releaseDates) {
    const results = releaseDates && releaseDates.results
    if (!Array.isArray(results) || !results.length) return null
    for (const code of ['US', 'GB']) {
      const entry = results.find(r => r && r.iso_3166_1 === code)
      if (!entry) continue
      // content_ratings shape: rating sits directly on the entry.
      if (typeof entry.rating === 'string' && entry.rating) return entry.rating
      const list = Array.isArray(entry.release_dates) ? entry.release_dates : []
      if (!list.length) continue
      const theatrical = list.find(r => r && r.type === 3 && r.certification)
      const any = list.find(r => r && r.certification)
      const cert = (theatrical || any || {}).certification
      if (cert) return cert
    }
    return null
  }

  return { duration, size, bitrate, relativeDate, certification }
})
