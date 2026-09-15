'use strict'
// The resume and watched rules (video plan V2.3), stated once and used by the
// store, the theatre's resume offer, the cards, Continue Watching and the
// episode marks — they had drifted (90 % here, 95 % there, 2 % on a card,
// 1 % on another). Pure; tested in test/watch-rules.test.js.
//
//   fresh    under 5 % in (or under 30 s), or no usable duration: play from
//            the start, no progress bar, not in Continue Watching.
//   partial  5 %–92 % in: offer resume, show the bar, list it, mark started.
//            The 5 % is capped at two minutes (V111): on a two-hour film five
//            minutes in is real progress, and 5 % would have thrown it away.
//   watched  92 % or more: watched. Credits are the last 8 %.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaWatchRules = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  const STARTED_AT = 0.05
  const WATCHED_AT = 0.92
  const MIN_SECONDS = 30
  // The percentage threshold never asks for more than this many seconds.
  const STARTED_CAP_SECONDS = 120

  function _n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0 }

  function ratio(position, duration) {
    const d = _n(duration), p = _n(position)
    if (d <= 0) return 0
    return Math.max(0, Math.min(1, p / d))
  }

  function status(position, duration) {
    const d = _n(duration), p = _n(position)
    if (d <= 0) return 'fresh'
    const r = p / d
    if (r >= WATCHED_AT) return 'watched'
    if (p >= MIN_SECONDS && (r >= STARTED_AT || p >= STARTED_CAP_SECONDS)) return 'partial'
    return 'fresh'
  }

  function isWatched(position, duration) { return status(position, duration) === 'watched' }
  function isPartial(position, duration) { return status(position, duration) === 'partial' }

  // Whole-number percent for a bar; 0 unless partial, so a bar never shows
  // for a title that would play from the start anyway.
  function progressPct(position, duration) {
    if (!isPartial(position, duration)) return 0
    return Math.max(1, Math.min(99, Math.round(ratio(position, duration) * 100)))
  }

  // The resume offer: the position to jump to and the seconds left, or null.
  function resumeOffer(position, duration) {
    if (!isPartial(position, duration)) return null
    return { position: _n(position), left: Math.max(0, _n(duration) - _n(position)) }
  }

  // The primary button on a detail page (V012): its label names what it will
  // do. `saved` is the stored record ({ position, duration, watched }) or
  // null; `fmt` formats seconds. Resume is offered only when the shared rule
  // says the title is partial; a watched title plays from the start again.
  function primaryAction(saved, fmt) {
    const f = typeof fmt === 'function' ? fmt : (s) => Math.round(s) + 's'
    if (!saved || saved.watched) return { kind: 'play', label: 'Play', startOver: false }
    const offer = resumeOffer(saved.position, saved.duration)
    if (!offer) return { kind: 'play', label: 'Play', startOver: false }
    return { kind: 'resume', label: 'Resume from ' + f(offer.position), startOver: true, position: offer.position }
  }

  return { STARTED_AT, WATCHED_AT, MIN_SECONDS, STARTED_CAP_SECONDS, primaryAction, ratio, status, isWatched, isPartial, progressPct, resumeOffer }
})
