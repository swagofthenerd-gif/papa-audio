'use strict'
const test = require('node:test')
const assert = require('node:assert')

const {
  analyseSeries, analyseRun, isMonotonic, trend, envelopeMin, maxDrawdownRatio, DEFAULTS,
} = require('../tools/video-soak')

// The whole value of a soak test is the verdict at the end of it, and the
// verdict is worthless in two opposite ways. A tool that misses a real leak
// gives false confidence in an app that degrades overnight. A tool that cries
// leak on every healthy run gets ignored within a week, which is the same as
// having no tool. So both directions are tested here, and the healthy shapes
// outnumber the leaking one deliberately.

// ── Series generators ───────────────────────────────────────────────────────
// Each is a shape a real metric actually takes, not an abstract curve.

// A counter that does not move. DOM nodes on an idle page.
function flat (n = 60, value = 1000) {
  return Array.from({ length: n }, () => value)
}

// A metric that is stable but real: it jitters, because every real measurement
// does. A perfectly repeated value means the probe is not measuring — see the
// `constant` verdict — so a fixture of one repeated number cannot stand in for
// "a metric that did not drift".
function noisyFlat (n = 60, value = 1000) {
  return Array.from({ length: n }, (_, i) => value + ((i * 7) % 5) - 2)
}

// Heap under a working garbage collector: climbs, is collected, climbs again.
// The peaks are high and the troughs return to the same floor. This is the
// shape most likely to be misread as a leak by a naive end-minus-start check.
function sawtooth (n = 60, floor = 100, peak = 180) {
  return Array.from({ length: n }, (_, i) => (i % 10 === 9 ? floor : floor + ((peak - floor) * (i % 10)) / 9))
}

// Caches filling, lazy modules loading, fonts resolving. Rises steeply, then
// stops. Growth is real and permanent, and it is not a leak.
function warmupThenPlateau (n = 60, base = 100, ceiling = 220) {
  return Array.from({ length: n }, (_, i) => {
    const t = Math.min(1, i / (n * 0.2))
    return base + (ceiling - base) * t
  })
}

// The thing we are hunting: a floor that never comes back down. Sawtoothed on
// top, so it cannot be caught by looking at raw values alone.
function slowLeak (n = 60, floor = 100, perSample = 2) {
  return Array.from({ length: n }, (_, i) => {
    const drift = floor + perSample * i
    return i % 10 === 9 ? drift : drift + 40 * ((i % 10) / 9)
  })
}

// A metric that jitters either side of a level line. Measurement noise, not
// movement. Deterministic so the test cannot flake.
function noisyFlat (n = 60, value = 500) {
  return Array.from({ length: n }, (_, i) => value + (i * 7919 % 23) - 11)
}

// ── The healthy shapes must not be reported as leaks ─────────────────────────

test('a stable metric does not read as a leak', () => {
  // The property, not the label. A real measurement that holds steady may be
  // classified 'flat' or 'sawtooth' depending on how much it jitters, and both
  // are correct answers to "did this drift?". Asserting the label made the test
  // about the classifier's taxonomy rather than about drift.
  const r = analyseSeries(noisyFlat())
  assert.notStrictEqual(r.verdict, 'leak')
  assert.notStrictEqual(r.verdict, 'constant', 'it did vary, so it was measured')
  assert.ok(Math.abs(r.floorGrowth) < DEFAULTS.leakRelGrowth, 'the floor did not move')
})

// 'flat' turns out to mean "the floor never dipped" and 'sawtooth' "it dipped
// and recovered" — both are non-leaks, and which one a real series gets depends
// on jitter rather than on health. So there is no test here asserting that a
// particular stable shape is labelled 'flat': that would be a test about the
// taxonomy, which is what the test above was rewritten to stop doing.

test('a metric that never moved at all is called constant, not flat', () => {
  // Was asserting 'flat' against a perfectly repeated value. That is the shape
  // a broken probe produces, and treating it as a pass is how the first
  // hundred-minute run announced no drift while blind to the renderer's memory:
  // Chromium's performance.memory returned exactly 10,000,000 for all 400
  // samples, and a constant series has no growth to report.
  const r = analyseSeries(flat())
  assert.strictEqual(r.verdict, 'constant')
  // Still not a leak. It is not evidence in either direction.
  assert.notStrictEqual(r.verdict, 'leak')
})

test('garbage collection is not a leak', () => {
  const r = analyseSeries(sawtooth())
  assert.notStrictEqual(r.verdict, 'leak',
    'a heap that rises and falls to the same floor is a working collector')
  assert.ok(Math.abs(r.floorGrowth) < DEFAULTS.leakRelGrowth,
    'the floor is what matters, and it did not move')
})

test('warming up is not a leak', () => {
  const r = analyseSeries(warmupThenPlateau())
  assert.notStrictEqual(r.verdict, 'leak',
    'a cache that fills once and then stops is the app becoming ready')
})

test('measurement noise is not a leak', () => {
  const r = analyseSeries(noisyFlat())
  assert.notStrictEqual(r.verdict, 'leak')
})

// ── The unhealthy shape must be caught ───────────────────────────────────────

test('a floor that never comes back down is a leak', () => {
  const r = analyseSeries(slowLeak())
  assert.strictEqual(r.verdict, 'leak')
  assert.ok(r.floorGrowth > DEFAULTS.leakRelGrowth)
})

// The point of tracking the floor rather than the raw values: this series ends
// lower than it starts at several points and still leaks.
test('a leak hidden under a sawtooth is still caught', () => {
  const r = analyseSeries(slowLeak(80, 100, 1))
  assert.strictEqual(r.verdict, 'leak',
    'raw peaks and troughs hide the drift; the floor does not')
})

// ── The pieces the verdict rests on ──────────────────────────────────────────

test('monotonic means never falls meaningfully, not never falls at all', () => {
  assert.strictEqual(isMonotonic([1, 2, 3, 4, 5]), true)
  // The slack is a fraction of the series' own range, not of its values, which
  // is the behaviour that matters: a metric climbing 100 -> 10000 tolerates the
  // jitter of a counter read across a process boundary, while a level metric
  // tolerates almost none — and a level metric should not be called a rise.
  assert.strictEqual(isMonotonic([100, 4000, 3990, 8000, 10000]), true)
  assert.strictEqual(isMonotonic([100, 100.5, 100.4, 101, 101.6]), false,
    'nearly flat with jitter is not a rise')
  assert.strictEqual(isMonotonic([100, 140, 90, 130, 80]), false)
})

test('the floor ignores the peaks', () => {
  const floor = envelopeMin(sawtooth())
  assert.ok(floor.every(v => v <= 120), 'peaks near 180 must not reach the floor series: ' + floor)
})

test('drawdown separates a collector from a climb', () => {
  assert.ok(maxDrawdownRatio(sawtooth()) > 0.3, 'a sawtooth falls a long way from its peak')
  assert.ok(maxDrawdownRatio(warmupThenPlateau()) < 0.05, 'a plateau barely falls at all')
})

test('the trend line reports how well it fits, not just its slope', () => {
  const straight = trend([1, 2, 3, 4, 5, 6, 7, 8])
  assert.ok(straight.r2 > 0.99, 'a straight line fits a straight line')
  assert.ok(straight.slope > 0)
  const scatter = trend(noisyFlat(40))
  assert.ok(scatter.r2 < 0.5, 'noise around a level line has no trend to speak of')
})

// ── Refusing to answer ───────────────────────────────────────────────────────
// A verdict from four samples would be a guess wearing a verdict's clothes.

test('too little data produces no verdict rather than a wrong one', () => {
  assert.strictEqual(analyseSeries([1, 2]).verdict, 'insufficient')
  assert.strictEqual(analyseSeries([]).verdict, 'insufficient')
  assert.strictEqual(analyseSeries(null).verdict, 'insufficient')
})

test('non-numeric samples are discarded, not counted as zero', () => {
  const r = analyseSeries([100, null, 100, undefined, 100, NaN, 100, 100, 100, 100])
  assert.strictEqual(r.samples, 7, 'a dropped sample must not be read as a collapse to zero')
})

// ── The whole run ────────────────────────────────────────────────────────────

function run (series) {
  const leak = slowLeak(); const saw = sawtooth(); const level = flat(); const noise = noisyFlat()
  return Array.from({ length: 60 }, (_, i) => ({
    t: i * 1000,
    metrics: {
      rendererHeapUsed: series === 'leak' ? leak[i] : saw[i],
      domNodes: level[i],
      listeners: noise[i],
    },
  }))
}

test('one leaking metric condemns the whole run', () => {
  const out = analyseRun(run('leak'))
  assert.strictEqual(out.verdict, 'FAIL')
  assert.deepStrictEqual(out.leaks, ['rendererHeapUsed'], 'the offending metric is named')
  assert.notStrictEqual(out.metrics.domNodes.verdict, 'leak')
})

test('a healthy run passes even though its heap sawtooths', () => {
  const out = analyseRun(run('healthy'))
  assert.strictEqual(out.verdict, 'PASS')
  assert.deepStrictEqual(out.leaks, [])
})

// The failure mode that matters most, because it is the one that looks like
// success: the harness never attached, nothing was sampled, and the tool
// reported a pass.
test('a run that measured nothing is inconclusive, not a pass', () => {
  assert.strictEqual(analyseRun([]).verdict, 'INCONCLUSIVE')
  assert.strictEqual(analyseRun(null).verdict, 'INCONCLUSIVE')
})

test('a run too short to judge is inconclusive, not a pass', () => {
  const short = [1, 2, 3].map((v, i) => ({ t: i, metrics: { domNodes: v } }))
  assert.strictEqual(analyseRun(short).verdict, 'INCONCLUSIVE')
})
