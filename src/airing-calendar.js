'use strict';
// Airing calendar month view (App roadmap #36). The airing shelf already merges
// AniList + TMDB into one flat, time-sorted list of rows via main's _mergeAiring:
//   [{ key, title, episode, airsAt, type }]   airsAt = epoch MILLISECONDS
// The month calendar wants those same rows bucketed by the local calendar day
// they fall on, restricted to one month, and tagged with whether the show is on
// the viewer's My List. This is the pure bucketing half — no network, no clock —
// so main only has to fetch the schedule and hand it here.
//
// UMD-wrapped so it loads under Node's test runner and, if ever needed, as a
// classic renderer script — same pattern as ttl-cache.js / dead-magnet.js.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaAiringCalendar = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The local calendar day an epoch-ms timestamp falls on, as a "YYYY-MM-DD"
  // string. Local, not UTC, because the shelf and the calendar both show the day
  // the viewer would call it — a Thursday episode must not slide to Wednesday's
  // cell for a viewer west of Greenwich.
  function dayKey(ms) {
    const d = new Date(Number(ms))
    if (!Number.isFinite(d.getTime())) return null
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  // Whether a merged airing row belongs to a followed show. `followed` is the
  // set the caller builds from My List: keys are the same "anime:<id>" /
  // "tv:<id>" strings _mergeAiring stamps on every row, so membership is a plain
  // lookup with no id/type juggling here. A missing or non-Set `followed` means
  // "nothing followed" rather than an error, so the calendar still renders.
  function _isFollowed(row, followed) {
    if (!row || !row.key) return false
    if (followed instanceof Set) return followed.has(row.key)
    if (Array.isArray(followed)) return followed.indexOf(row.key) !== -1
    return false
  }

  // The number of days in a given month (1-based month). Feb in a leap year is
  // the case that a naive 30-day assumption gets wrong; `new Date(y, m, 0)` rolls
  // back to the last day of the previous month, which is the count we want.
  function daysInMonth(year, month) {
    return new Date(Number(year), Number(month), 0).getDate()
  }

  // Bucket the flat airing rows into the days of one month.
  //
  //   rows:  [{ key, title, episode, airsAt, type }]  (main's _mergeAiring output)
  //   year:  full year, e.g. 2026
  //   month: 1-12 (calendar month, NOT the 0-based Date month)
  //   opts.followed: Set|Array of followed row keys ("anime:<id>"/"tv:<id>")
  //
  // Returns a stable, always-complete month shape so the renderer can lay out a
  // grid without a null check per cell:
  //   {
  //     year, month,
  //     days: [{ day: 1..N, date: "YYYY-MM-DD", entries: [...] }, ...],  // every day
  //     total: <count of entries placed in this month>,
  //     followedTotal: <count of those that are followed>
  //   }
  // Each entry is the row plus an `isFollowed` flag; rows outside the requested
  // month, or with no usable airsAt, are simply not placed. Within a day, entries
  // keep the soonest-first order _mergeAiring already produced.
  function bucketMonth(rows, year, month, opts) {
    opts = opts || {}
    const y = Number(year)
    const m = Number(month)
    const followed = opts.followed
    const count = (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12)
      ? daysInMonth(y, m) : 0
    const mm = String(m).padStart(2, '0')
    const days = []
    const byKey = new Map()
    for (let d = 1; d <= count; d++) {
      const date = `${y}-${mm}-${String(d).padStart(2, '0')}`
      const cell = { day: d, date, entries: [] }
      days.push(cell)
      byKey.set(date, cell)
    }

    let total = 0
    let followedTotal = 0
    const list = Array.isArray(rows) ? rows : []
    for (const row of list) {
      if (!row) continue
      const ms = Number(row.airsAt)
      if (!Number.isFinite(ms) || ms <= 0) continue
      const key = dayKey(ms)
      if (!key) continue
      const cell = byKey.get(key)
      if (!cell) continue   // airs in a different month than the one requested
      const isFollowed = _isFollowed(row, followed)
      cell.entries.push({
        key: row.key || null,
        title: row.title || null,
        episode: row.episode ?? null,
        airsAt: ms,
        type: row.type || null,
        isFollowed,
      })
      total++
      if (isFollowed) followedTotal++
    }

    return { year: y, month: m, days, total, followedTotal }
  }

  return { dayKey, daysInMonth, bucketMonth }
})
