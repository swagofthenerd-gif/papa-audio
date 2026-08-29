'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { mergeSegments, activeSegment, buttonFor } = require('../src/skip-model')

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
