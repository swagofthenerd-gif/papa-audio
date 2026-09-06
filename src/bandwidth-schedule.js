'use strict';
// Bandwidth schedule (App roadmap #51) — throttle downloads during the day, open
// the pipe at night. This is the pure decision half: given a schedule config and
// the current time, return the download speed cap (in kbps) that is in force
// right now. No clock, no I/O — the caller passes `now` and applies the result.
//
// The config lives in the slsk scheduler config (main's slskSchedulerConfig,
// key `schedule`) and has the shape:
//   {
//     enabled: false,        // master switch; off = no cap ever (null)
//     dayLimitKbps: <int>,   // cap during the day window (0 or null = uncapped)
//     nightLimitKbps: <int>, // cap during the night window (0 or null = uncapped)
//     dayStartHour: 8,       // local hour [0..23] the day window opens
//     nightStartHour: 23,    // local hour [0..23] the night window opens
//   }
// The two start hours partition the 24-hour clock into a day band and a night
// band; the night band wraps past midnight when nightStartHour > dayStartHour,
// which is the normal case ("day from 08:00, night from 23:00").
//
// UMD-wrapped so it loads under Node's test runner and, if ever needed, as a
// classic renderer script — same pattern as the other src/ pure modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaBandwidthSchedule = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const DEFAULTS = {
    enabled: false,
    dayLimitKbps: 0,     // 0 = uncapped during the day
    nightLimitKbps: 0,   // 0 = uncapped at night
    dayStartHour: 8,
    nightStartHour: 23,
  }

  function _hour(h, fallback) {
    const n = Number(h)
    return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : fallback
  }

  // A limit of 0, null, or anything not a positive finite number means
  // "uncapped" — the pipe is open. Only a real positive kbps value is a cap.
  function _limit(v) {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
  }

  // Is the given local hour inside the DAY band? The day band runs from
  // dayStartHour up to (but not including) nightStartHour. When nightStartHour is
  // the larger number this is a simple range; when the two are equal there is no
  // night at all and every hour is "day". A night window that wraps past midnight
  // (nightStart > dayStart, the normal case) makes the day band the inner range.
  function _isDayHour(hour, dayStart, nightStart) {
    if (dayStart === nightStart) return true   // degenerate: treat all as day
    if (dayStart < nightStart) {
      // Day is the inner range [dayStart, nightStart); night wraps around it.
      return hour >= dayStart && hour < nightStart
    }
    // dayStart > nightStart: night is the inner range [nightStart, dayStart);
    // day wraps around midnight.
    return hour >= dayStart || hour < nightStart
  }

  // The download cap in force at `now`, in kbps, or null when uncapped.
  //   schedule: the config object above (missing fields fall back to DEFAULTS)
  //   now:      a Date, or epoch ms; defaults to the real clock only if omitted
  // Disabled schedule → always null (no cap). Otherwise the local hour of `now`
  // decides which of the two limits applies, and each limit is itself null when
  // that band is meant to be uncapped.
  function currentLimitKbps(schedule, now) {
    const cfg = Object.assign({}, DEFAULTS, schedule || {})
    if (!cfg.enabled) return null
    const when = now == null ? new Date()
      : (now instanceof Date ? now : new Date(Number(now)))
    if (!Number.isFinite(when.getTime())) return null
    const dayStart = _hour(cfg.dayStartHour, DEFAULTS.dayStartHour)
    const nightStart = _hour(cfg.nightStartHour, DEFAULTS.nightStartHour)
    const hour = when.getHours()
    const inDay = _isDayHour(hour, dayStart, nightStart)
    return inDay ? _limit(cfg.dayLimitKbps) : _limit(cfg.nightLimitKbps)
  }

  // Convenience for the torrent-stream throttle, which takes bytes/second. null
  // stays null (uncapped); a kbps cap becomes bytes/sec. "kbps" here is kilobytes
  // per second (1 kB = 1000 B), the unit a download-speed field means to a user,
  // not kilobits.
  function limitToBytesPerSec(kbps) {
    const n = Number(kbps)
    return Number.isFinite(n) && n > 0 ? Math.floor(n * 1000) : null
  }

  return { DEFAULTS, currentLimitKbps, limitToBytesPerSec, _isDayHour }
})
