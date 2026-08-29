'use strict';
// Skip-segment model — pure merging and decision logic for the skip
// intro/recap/credits feature. No I/O, no state.
//
// Segments come from four layers (embedded chapters, AniSkip, cross-episode
// audio detection, manual correction) and they routinely disagree. This module
// is the one place the disagreement is resolved, so the seek bar and the skip
// button always agree.
//
// Segment shape (§4.3): { kind: 'intro'|'recap'|'credits'|'preview',
//   start, end, origin: 'chapters'|'aniskip'|'detected'|'manual', confidence } // 0..1
//
// UMD-wrapped like ttl-cache.js so it loads as a classic script without leaking
// top-level bindings into the shared renderer scope.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaSkipModel = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const MANUAL = 'manual'

  const KIND_LABEL = {
    intro: 'Intro',
    recap: 'Recap',
    credits: 'Credits',
    preview: 'Preview',
  }

  // How long before a segment the button appears, and how long after its end it
  // stays before auto-dismissing. §9: "appears 1s before, auto-dismisses 5s after".
  const APPEAR_BEFORE_S = 1
  const DISMISS_AFTER_S = 5

  function _interval(a, b) {
    return a.start < b.end && b.start < a.end
  }

  // The priority order a segment wins by: manual always, then confidence, then
  // the earlier start (a deterministic tie-break so the result never depends on
  // the input order of the sources).
  function _byPriority(a, b) {
    const am = a.origin === MANUAL
    const bm = b.origin === MANUAL
    if (am !== bm) return am ? -1 : 1
    const ca = Number(a.confidence) || 0
    const cb = Number(b.confidence) || 0
    if (ca !== cb) return cb - ca
    return a.start - b.start
  }

  // `sources` is an array of segment arrays — one per layer. The result is a
  // single non-overlapping list sorted by start. Where two segments overlap, the
  // higher-priority one wins and the other is dropped; a manual correction can
  // never be shadowed by an automatic detection, however confident.
  function mergeSegments(sources) {
    const flat = []
    for (const src of sources || []) {
      if (!Array.isArray(src)) continue
      for (const seg of src) {
        if (!seg || typeof seg.start !== 'number' || typeof seg.end !== 'number') continue
        if (seg.end <= seg.start) continue
        flat.push(seg)
      }
    }
    flat.sort(_byPriority)
    const out = []
    for (const seg of flat) {
      if (out.some(kept => _interval(kept, seg))) continue
      out.push(seg)
    }
    out.sort((a, b) => a.start - b.start)
    return out
  }

  // The segment covering `t`, or null. `t` in [start, end) — a segment ending
  // exactly at `t` is no longer active.
  function activeSegment(segments, t) {
    const time = Number(t)
    if (!Number.isFinite(time) || !Array.isArray(segments)) return null
    for (const seg of segments) {
      if (seg && time >= seg.start && time < seg.end) return seg
    }
    return null
  }

  // The skip decision at time `t`: which button to show, and whether prefs say it
  // should act automatically. Returns null when no segment is in the window.
  function buttonFor(segments, t, prefs = {}) {
    const time = Number(t)
    if (!Number.isFinite(time) || !Array.isArray(segments)) return null

    let active = null
    let upcoming = null
    for (const seg of segments) {
      if (!seg) continue
      if (time >= seg.start && time < seg.end) {
        if (!active || _byPriority(seg, active) < 0) active = seg
      } else if (time >= seg.start - APPEAR_BEFORE_S && time < seg.start) {
        if (!upcoming || seg.start < upcoming.start) upcoming = seg
      }
    }
    const seg = active || upcoming
    if (!seg) return null

    const autoPref = {
      intro: prefs.autoSkipIntro === true,
      recap: prefs.autoSkipRecap === true,
      credits: prefs.autoSkipCredits === true,
      preview: prefs.autoSkipPreview === true,
    }
  return {
    label: `Skip ${KIND_LABEL[seg.kind] || 'Segment'}`,
    action: autoPref[seg.kind] ? 'auto' : 'offer',
    segment: seg,
  }
}

// Layer 4 fallback: with no better credits source (chapter, AniSkip, manual),
// the tail of the file is the credits. Conservative — min(8% of runtime, 90 s) —
// so a film whose final minutes are the climax is not mislabelled. Returns a
// low-confidence segment the higher-confidence sources will outrank in a merge.
function creditsFallback(duration, { maxSeconds = 90, maxFraction = 0.08 } = {}) {
  const dur = Number(duration)
  if (!Number.isFinite(dur) || dur <= 0) return null
  const tail = Math.min(dur * maxFraction, maxSeconds)
  if (tail < 5) return null
  return { kind: 'credits', start: dur - tail, end: dur, origin: 'detected', confidence: 0.3 }
}

  return { mergeSegments, activeSegment, buttonFor, creditsFallback, KIND_LABEL, MANUAL, APPEAR_BEFORE_S, DISMISS_AFTER_S }
})
