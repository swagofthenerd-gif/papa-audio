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
    let lingering = null
    let upcoming = null
    for (const seg of segments) {
      if (!seg) continue
      if (time >= seg.start && time < seg.end) {
        if (!active || _byPriority(seg, active) < 0) active = seg
      } else if (time >= seg.end && time < seg.end + DISMISS_AFTER_S) {
        // §9: the button auto-dismisses 5s after the segment ends, not the
        // instant it does — a hand reaching for it must not find it gone.
        // Kept below a truly active segment, so an intro that has begun is
        // never shadowed by the recap that just finished.
        if (!lingering || _byPriority(seg, lingering) < 0) lingering = seg
      } else if (time >= seg.start - APPEAR_BEFORE_S && time < seg.start) {
        if (!upcoming || seg.start < upcoming.start) upcoming = seg
      }
    }
    const seg = active || lingering || upcoming
    if (!seg) return null

    const autoPref = {
      intro: prefs.autoSkipIntro === true,
      recap: prefs.autoSkipRecap === true,
      credits: prefs.autoSkipCredits === true,
      preview: prefs.autoSkipPreview === true,
    }
  // V045: a segment whose source did not match this file's edition (a
  // different cut's timings, an unverified length) is offered as a button,
  // never jumped to automatically — the person decides.
  const uncertain = seg.uncertain === true || (Number(seg.confidence) || 0) < AUTO_MIN_CONFIDENCE
  return {
    label: `Skip ${KIND_LABEL[seg.kind] || 'Segment'}`,
    action: autoPref[seg.kind] && !uncertain ? 'auto' : 'offer',
    segment: seg,
  }
}

// Below this confidence a segment is never auto-skipped (V045).
const AUTO_MIN_CONFIDENCE = 0.8

// V045: drop or demote segments that cannot belong to this file. A segment
// that starts past the end or ends past the end (beyond a small tolerance)
// is not this cut's; one from a source whose reported episode length is
// more than `toleranceS` off the real duration is kept but marked uncertain.
function validateSegments(segments, duration, { toleranceS = 15 } = {}) {
  const dur = Number(duration) || 0
  const out = []
  for (const seg of segments || []) {
    if (!seg || typeof seg.start !== 'number' || typeof seg.end !== 'number') continue
    if (dur > 0) {
      if (seg.start >= dur) continue
      if (seg.end > dur + toleranceS) continue
    }
    const src = Number(seg.sourceLength) || 0
    const mismatch = dur > 0 && src > 0 && Math.abs(src - dur) > toleranceS
    out.push(mismatch ? { ...seg, uncertain: true, confidence: Math.min(Number(seg.confidence) || 0, 0.5) } : seg)
  }
  return out
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

  // ── Skip-intro training from manual seeks (App #46) ───────────────────────
  // When a viewer repeatedly jumps past the opening of a season's episodes, that
  // is a manual intro skip waiting to be learned. These pure helpers hold the
  // detection maths; the renderer feeds them raw position jumps and persists the
  // attempt counts, and offers to write a manual skip segment once the pattern
  // is clear. No I/O, no state — the caller owns both.

  // The window a learned skip lives in: a jump only counts as "skipping the
  // intro" when it starts inside the first FIVE minutes and lands 60–120 s
  // later. A two-second nudge is not an intro; a ten-minute jump is scrubbing.
  const TRAIN_MAX_FROM_S = 300
  const TRAIN_MIN_JUMP_S = 60
  const TRAIN_MAX_JUMP_S = 120
  // Two matching jumps in a season is enough to offer to learn it — the first
  // could be a one-off, the second is a habit.
  const TRAIN_OFFER_AT = 2

  // Is this position jump the kind that skips an opening? `from`/`to` are two
  // playback positions (seconds); a forward jump of 60–120 s that begins in the
  // first five minutes qualifies. Everything else — backward, too small, too
  // large, or starting deep into the episode — does not.
  function isIntroSkipSeek(from, to) {
    const f = Number(from)
    const t = Number(to)
    if (!Number.isFinite(f) || !Number.isFinite(t)) return false
    if (f < 0 || f > TRAIN_MAX_FROM_S) return false
    const jump = t - f
    return jump >= TRAIN_MIN_JUMP_S && jump <= TRAIN_MAX_JUMP_S
  }

  // Fold one qualifying seek into a running record for a season. The record is
  // `{ count, sumFrom, sumTo }` (all zero to begin); this returns a new record
  // rather than mutating, so the caller can persist it verbatim. A non-qualifying
  // seek returns the record unchanged.
  function recordIntroSeek(prev, from, to) {
    const rec = _trainRec(prev)
    if (!isIntroSkipSeek(from, to)) return rec
    return { count: rec.count + 1, sumFrom: rec.sumFrom + Number(from), sumTo: rec.sumTo + Number(to) }
  }

  // Should the "learn this skip?" offer be made? True the moment the count
  // reaches the threshold — the caller is expected to stop asking once it has
  // acted, since accepting writes a manual segment that supersedes the training.
  function shouldOfferSkipTraining(prev) {
    return _trainRec(prev).count >= TRAIN_OFFER_AT
  }

  // The manual skip segment to write from an accumulated record: an intro from
  // the average seek-from point to the average seek-to point. Returns null when
  // there is nothing to average or the averages do not form a real interval.
  function skipSegmentFromTraining(prev) {
    const rec = _trainRec(prev)
    if (rec.count <= 0) return null
    const start = rec.sumFrom / rec.count
    const end = rec.sumTo / rec.count
    if (!(end > start)) return null
    return { kind: 'intro', start: start, end: end, origin: MANUAL, confidence: 1 }
  }

  function _trainRec(prev) {
    const p = prev && typeof prev === 'object' ? prev : {}
    return {
      count: Number(p.count) || 0,
      sumFrom: Number(p.sumFrom) || 0,
      sumTo: Number(p.sumTo) || 0,
    }
  }

  return {
    mergeSegments, activeSegment, buttonFor, creditsFallback, validateSegments, AUTO_MIN_CONFIDENCE,
    isIntroSkipSeek, recordIntroSeek, shouldOfferSkipTraining, skipSegmentFromTraining,
    KIND_LABEL, MANUAL, APPEAR_BEFORE_S, DISMISS_AFTER_S,
    TRAIN_MAX_FROM_S, TRAIN_MIN_JUMP_S, TRAIN_MAX_JUMP_S, TRAIN_OFFER_AT,
  }
})
