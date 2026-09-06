'use strict';
// Profiler capture (App roadmap #70) — the pure, testable half of the one-click
// "report what's slow" profiler. Given the caller's request, decide how long to
// profile for and what to name the output file. No Electron, no debugger, no
// clock beyond what the caller passes — main.js does the CDP dance with these
// answers.
//
// The seconds request is clamped to a sane band: a profile shorter than a second
// captures nothing useful, and one longer than a couple of minutes is a foot-gun
// (the profile balloons and the UI looks frozen). The default is ten seconds,
// which is long enough to catch a stutter and short enough to feel instant.
//
// UMD-wrapped so it loads under Node's test runner and, if ever needed, as a
// classic renderer script — same pattern as the other src/ pure modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaProfilerCapture = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const DEFAULT_SECONDS = 10
  const MIN_SECONDS = 1
  const MAX_SECONDS = 120

  // Normalise the `{ seconds }` request into an integer count of seconds within
  // the allowed band. Anything missing, non-numeric or out of range is coerced
  // to the nearest sane value rather than rejected — the caller asked for a
  // profile, so give them one of a usable length instead of an error.
  function normalizeSeconds(input) {
    const raw = input && typeof input === 'object' ? input.seconds : input
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_SECONDS
    return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Math.floor(n)))
  }

  // The filename for a capture taken at `now` (a Date or epoch ms; defaults to
  // the real clock only if omitted). Timestamped so repeated captures never
  // clobber each other, and always ends in .cpuprofile so Chrome DevTools and
  // the speedscope viewer both recognise it.
  function profileFilename(now) {
    const when = now == null ? new Date()
      : (now instanceof Date ? now : new Date(Number(now)))
    const stamp = (Number.isFinite(when.getTime()) ? when : new Date())
      .toISOString().replace(/[:.]/g, '-')
    return `papa-${stamp}.cpuprofile`
  }

  return {
    DEFAULT_SECONDS,
    MIN_SECONDS,
    MAX_SECONDS,
    normalizeSeconds,
    profileFilename,
  }
})
