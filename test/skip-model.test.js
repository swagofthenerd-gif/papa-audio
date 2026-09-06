'use strict'
const test = require('node:test')
const assert = require('node:assert')
const {
  mergeSegments, activeSegment, buttonFor, creditsFallback,
  isIntroSkipSeek, recordIntroSeek, shouldOfferSkipTraining, skipSegmentFromTraining,
} = require('../src/skip-model')

const intro = (start, end, extra = {}) => ({ kind: 'intro', start, end, origin: 'chapters', confidence: 0.8, ...extra })
const recap = (start, end, extra = {}) => ({ kind: 'recap', start, end, origin: 'chapters', confidence: 0.8, ...extra })
const credits = (start, end, extra = {}) => ({ kind: 'credits', start, end, origin: 'chapters', confidence: 0.8, ...extra })

test('mergeSegments flattens sources and sorts by start', () => {
  const merged = mergeSegments([
    [intro(30, 90), credits(1400, 1500)],
    [recap(0, 25)],
  ])
  assert.deepStrictEqual(merged.map(s => [s.kind, s.start]), [
    ['recap', 0], ['intro', 30], ['credits', 1400],
  ])
})

test('overlapping segments resolve to the higher confidence', () => {
  const merged = mergeSegments([
    [intro(30, 90, { confidence: 0.5 })],
    [intro(40, 100, { confidence: 0.9 })],
  ])
  assert.strictEqual(merged.length, 1)
  assert.strictEqual(merged[0].start, 40)
  assert.strictEqual(merged[0].end, 100)
})

test('a manual segment always beats an automatic one', () => {
  const merged = mergeSegments([
    [intro(30, 90, { origin: 'aniskip', confidence: 0.99 })],
    [intro(25, 85, { origin: 'manual', confidence: 0.1 })],
  ])
  assert.strictEqual(merged.length, 1)
  assert.strictEqual(merged[0].origin, 'manual')
  assert.strictEqual(merged[0].start, 25)
})

test('adjacent, non-overlapping segments all survive', () => {
  const merged = mergeSegments([
    [recap(0, 25), intro(25, 90), credits(1400, 1500)],
  ])
  assert.strictEqual(merged.length, 3)
})

test('different kinds that overlap resolve by priority, not by union', () => {
  // An intro and a recap covering the same span: the more confident one wins.
  const merged = mergeSegments([
    [recap(0, 30, { confidence: 0.9 })],
    [intro(20, 90, { confidence: 0.4 })],
  ])
  assert.strictEqual(merged.length, 1)
  assert.strictEqual(merged[0].kind, 'recap')
})

test('garbage in the sources is dropped, never fatal', () => {
  const merged = mergeSegments([null, undefined, 42, [null, { start: 5, end: 3 }, intro(10, 20), { start: 'x', end: 1 }]])
  assert.strictEqual(merged.length, 1)
  assert.strictEqual(merged[0].start, 10)
})

test('activeSegment returns the covering segment or null', () => {
  const segs = [intro(30, 90), credits(1400, 1500)]
  assert.strictEqual(activeSegment(segs, 0), null)
  assert.strictEqual(activeSegment(segs, 30), segs[0])
  assert.strictEqual(activeSegment(segs, 89.9), segs[0])
  assert.strictEqual(activeSegment(segs, 90), null, 'end is exclusive')
  assert.strictEqual(activeSegment(segs, 1450), segs[1])
  assert.strictEqual(activeSegment(null, 10), null)
  assert.strictEqual(activeSegment(segs, NaN), null)
})

test('buttonFor offers nothing when no segment is near', () => {
  const segs = [intro(30, 90)]
  assert.strictEqual(buttonFor(segs, 0), null)
  assert.strictEqual(buttonFor(segs, 100), null)
})

test('buttonFor appears 1s before a segment starts', () => {
  const segs = [intro(30, 90)]
  assert.strictEqual(buttonFor(segs, 28.5), null)
  const btn = buttonFor(segs, 29.1)
  assert.strictEqual(btn.label, 'Skip Intro')
  assert.strictEqual(btn.action, 'offer')
  assert.strictEqual(btn.segment, segs[0])
})

test('buttonFor shows a segment while it is active', () => {
  const segs = [credits(1400, 1500)]
  const btn = buttonFor(segs, 1450)
  assert.strictEqual(btn.label, 'Skip Credits')
  assert.strictEqual(btn.action, 'offer')
})

test('buttonFor auto-skips when the matching pref is set', () => {
  const segs = [intro(30, 90), credits(1400, 1500)]
  const introBtn = buttonFor(segs, 31, { autoSkipIntro: true })
  assert.strictEqual(introBtn.action, 'auto')
  // The credits pref is separate.
  const creditsBtn = buttonFor(segs, 1450, { autoSkipIntro: true })
  assert.strictEqual(creditsBtn.action, 'offer')
})

// §9: the button auto-dismisses 5s after the segment, not the instant it ends.
test('buttonFor lingers 5s past the segment end before dismissing', () => {
  const segs = [intro(30, 90)]
  assert.strictEqual(buttonFor(segs, 92).segment, segs[0])
  assert.strictEqual(buttonFor(segs, 94.9).label, 'Skip Intro')
  assert.strictEqual(buttonFor(segs, 95), null, 'gone at end + DISMISS_AFTER_S')
  // activeSegment is untouched: only the button lingers, not the segment.
  assert.strictEqual(activeSegment(segs, 92), null)
})

test('a segment that has begun beats one that is merely lingering', () => {
  const segs = [recap(0, 25), intro(25, 90)]
  const btn = buttonFor(segs, 26)
  assert.strictEqual(btn.segment, segs[1], 'the intro is playing; the recap is history')
})

test('buttonFor prefers the active segment over an upcoming one', () => {
  const segs = [recap(0, 25), intro(25, 90)]
  const btn = buttonFor(segs, 24.5)
  assert.strictEqual(btn.segment, segs[0])
  assert.strictEqual(btn.label, 'Skip Recap')
})

test('buttonFor labels every known kind and guards unknowns', () => {
  assert.strictEqual(buttonFor([{ kind: 'preview', start: 0, end: 10, confidence: 1 }], 5).label, 'Skip Preview')
  assert.strictEqual(buttonFor([{ kind: 'recap', start: 0, end: 10, confidence: 1 }], 5).label, 'Skip Recap')
  assert.strictEqual(buttonFor([{ kind: 'whatever', start: 0, end: 10, confidence: 1 }], 5).label, 'Skip Segment')
})

test('creditsFallback caps the tail at min(8%, 90s)', () => {
  const seg = creditsFallback(3600)
  assert.strictEqual(seg.kind, 'credits')
  assert.strictEqual(seg.origin, 'detected')
  assert.strictEqual(seg.start, 3510)
  assert.strictEqual(seg.end, 3600)
  // A very long file caps at 90 s, not 8% of two hours.
  assert.strictEqual(creditsFallback(7200).start, 7110)
})

test('creditsFallback returns null for a short or invalid duration', () => {
  assert.strictEqual(creditsFallback(null), null)
  assert.strictEqual(creditsFallback(0), null)
  assert.strictEqual(creditsFallback(50), null, 'a 4s tail is not worth a button')
})

// ── Skip-intro training from manual seeks (App #46) ──────────────────────────

test('isIntroSkipSeek accepts a 60-120s forward jump inside the first 5 minutes', () => {
  assert.ok(isIntroSkipSeek(10, 100), 'a 90s jump from 0:10')
  assert.ok(isIntroSkipSeek(0, 60), 'the minimum jump')
  assert.ok(isIntroSkipSeek(295, 415), 'the maximum jump from near the window edge')
})

test('isIntroSkipSeek rejects the seeks that are not intro skips', () => {
  assert.ok(!isIntroSkipSeek(10, 30), 'too small — a nudge, not an intro')
  assert.ok(!isIntroSkipSeek(10, 200), 'too large — scrubbing')
  assert.ok(!isIntroSkipSeek(100, 40), 'backward')
  assert.ok(!isIntroSkipSeek(400, 480), 'starts past the opening window')
  assert.ok(!isIntroSkipSeek(NaN, 60), 'a missing position is not a seek')
})

test('recordIntroSeek accumulates only qualifying seeks', () => {
  let rec = recordIntroSeek(null, 10, 100)          // +1
  assert.deepStrictEqual(rec, { count: 1, sumFrom: 10, sumTo: 100 })
  rec = recordIntroSeek(rec, 20, 110)               // +1
  assert.deepStrictEqual(rec, { count: 2, sumFrom: 30, sumTo: 210 })
  rec = recordIntroSeek(rec, 10, 15)                // ignored (too small)
  assert.deepStrictEqual(rec, { count: 2, sumFrom: 30, sumTo: 210 })
})

test('the offer is made at the second qualifying seek, not the first', () => {
  assert.ok(!shouldOfferSkipTraining({ count: 1, sumFrom: 10, sumTo: 100 }))
  assert.ok(shouldOfferSkipTraining({ count: 2, sumFrom: 30, sumTo: 210 }))
  assert.ok(!shouldOfferSkipTraining(null))
})

test('skipSegmentFromTraining averages the seeks into a manual intro', () => {
  const seg = skipSegmentFromTraining({ count: 2, sumFrom: 30, sumTo: 210 })
  assert.deepStrictEqual(seg, { kind: 'intro', start: 15, end: 105, origin: 'manual', confidence: 1 })
})

test('skipSegmentFromTraining is null with nothing to average or no interval', () => {
  assert.strictEqual(skipSegmentFromTraining(null), null)
  assert.strictEqual(skipSegmentFromTraining({ count: 0, sumFrom: 0, sumTo: 0 }), null)
  // Degenerate: a record whose averages do not form a forward interval.
  assert.strictEqual(skipSegmentFromTraining({ count: 1, sumFrom: 100, sumTo: 100 }), null)
})
