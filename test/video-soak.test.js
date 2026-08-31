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

// ── a slow rise that never comes down ─────────────────────────────────────
//
// The plan's words are "fail on any monotonic rise", and a twenty-percent gate
// did not do that. A real hundred-minute run measured the renderer's memory
// floor by tenths as 157, 210, 216, 221, 222, 227, 228, 231, 235, 236 MB —
// never once falling, still rising in the last three — and it passed as
// warm-up at 9.2%.

// The measured curve, reconstructed: ten flat-ish plateaus at the floors above.
function measuredRendererCurve () {
  const floors = [157, 210, 216, 221, 222, 227, 228, 231, 235, 236]
  const out = []
  for (const f of floors) for (let i = 0; i < 40; i++) out.push((f + (i % 7)) * 1048576)
  return out
}

test('a monotonic floor that creeps is a leak, however slowly', () => {
  const r = analyseSeries(measuredRendererCurve(), { minAbsGrowth: 32 * 1024 * 1024 })
  assert.strictEqual(r.verdict, 'leak')
  assert.match(r.note, /never falls and creeps/)
  assert.match(r.note, /it never comes down/)
})

test('a curve that levels off after warm-up is still warm-up', () => {
  // The distinction that matters: warm-up stops, a leak does not.
  const series = []
  for (let i = 0; i < 400; i++) series.push((i < 100 ? 150 + i * 0.6 : 210 + (i % 5)) * 1048576)
  const r = analyseSeries(series, { minAbsGrowth: 32 * 1024 * 1024 })
  assert.notStrictEqual(r.verdict, 'leak')
})

test('a floor that dips even once is not creep', () => {
  // Monotonicity is the whole evidence, so one real fall disqualifies it.
  const floors = [200, 210, 216, 221, 205, 227, 228, 231, 235, 236]
  const series = []
  for (const f of floors) for (let i = 0; i < 40; i++) series.push((f + (i % 7)) * 1048576)
  const r = analyseSeries(series, { minAbsGrowth: 32 * 1024 * 1024 })
  assert.notStrictEqual(r.verdict, 'leak')
})

test('the creep gate is a quarter of the leak gate unless overridden', () => {
  // The absolute floor exists to stop noise being called a trend, and a floor
  // that never falls has no noise in the direction that matters — so it does
  // not need as much room. A 32MB gate is what let a 20MB monotonic rise pass.
  const curve = measuredRendererCurve()
  assert.strictEqual(analyseSeries(curve, { minAbsGrowth: 32 * 1024 * 1024 }).verdict, 'leak')
  // Overridden back up to the leak gate, it is not creep.
  const strict = analyseSeries(curve, {
    minAbsGrowth: 32 * 1024 * 1024,
    creepMinAbsGrowth: 32 * 1024 * 1024,
  })
  assert.notStrictEqual(strict.verdict, 'leak')
})

test("V8's total heap is exempt, because it ratchets by design", () => {
  // heapTotal grows in steps and rarely hands memory back, so a monotonic floor
  // there is expected rather than evidence. Without the exemption the real run
  // flagged it at 24% on a heap whose USED floor was flat.
  const { METRIC_RULES } = require('../tools/video-soak')
  assert.strictEqual(METRIC_RULES.mainHeapTotal.creepMinAbsGrowth,
    METRIC_RULES.mainHeapTotal.minAbsGrowth,
    'the creep rule must not undercut this metric\'s own absolute gate')
  // And the metrics that DO carry the signal have no such exemption.
  for (const name of ['mainRss', 'rendererRss']) {
    assert.strictEqual(METRIC_RULES[name].creepMinAbsGrowth, undefined, name)
  }
})

// ── retention versus the allocator ────────────────────────────────────────
//
// A process whose footprint creeps while its DOM, its detached DOM and its
// listener counts all hold still is not holding anything: it is the allocator
// declining to hand pages back after heavy churn. Measured over 48 page
// changes — live nodes flat at 2449, detached flat at 1408, listeners flat at
// 266, RSS 195 to 238MB — which is exactly that shape.
//
// Telling the two apart is the whole reason the DOM counters are sampled. The
// alternative is a run that fails forever on a benign rise, and a light that is
// always red is a light nobody reads.

const { explainAllocatorGrowth, METRIC_RULES: RULES } = require('../tools/video-soak')

function creepRun (overrides) {
  const floors = [157, 210, 216, 221, 222, 227, 228, 231, 235, 236]
  const rows = []
  for (let i = 0; i < 400; i++) {
    const tenth = Math.floor(i / 40)
    rows.push({
      metrics: Object.assign({
        rendererRss: (floors[tenth] + (i % 7)) * 1048576,
        liveNodes: 2449 + (i % 3),
        detachedNodes: 1408 + (i % 2),
        cdpListeners: 266,
        domNodes: 1041 + (i % 5),
        listenersGlobal: 4,
      }, overrides ? overrides(i, tenth) : {}),
    })
  }
  return analyseRun(rows, RULES)
}

test('a creeping footprint with flat retention is explained, not called a leak', () => {
  const res = creepRun()
  assert.deepStrictEqual(res.leaks, ['rendererRss'], 'the rise is still detected')
  const expl = explainAllocatorGrowth(res)
  assert.ok(expl, 'and it is attributable to the allocator')
  assert.deepStrictEqual(expl.flagged, ['rendererRss'])
  assert.ok(expl.evidence.includes('liveNodes'), 'the evidence is named')
})

test('a creeping footprint WITH growing live nodes is a leak', () => {
  // The case the discrimination exists to preserve: retention that is real.
  const res = creepRun((i, tenth) => ({ liveNodes: 2449 + tenth * 400 + (i % 3) }))
  assert.ok(res.leaks.includes('liveNodes'))
  assert.strictEqual(explainAllocatorGrowth(res), null, 'this must not be downgraded')
})

test('growing detached nodes alone is a leak', () => {
  // Detached DOM that something still references is the classic renderer leak,
  // and it is invisible to a count of attached nodes.
  const res = creepRun((i, tenth) => ({ detachedNodes: 1408 + tenth * 300 + (i % 2) }))
  assert.ok(res.leaks.includes('detachedNodes'))
  assert.strictEqual(explainAllocatorGrowth(res), null)
})

test('nothing is downgraded when the DOM counters are missing', () => {
  // Absence of evidence is not evidence. A run without the debugger attached
  // must not get the benefit of the doubt.
  const res = creepRun()
  delete res.metrics.liveNodes
  assert.strictEqual(explainAllocatorGrowth(res), null)
})

test('a flagged metric that is not a footprint is never downgraded', () => {
  // The rule applies to memory footprints only. A creeping cache or listener
  // count is retention by definition.
  const res = creepRun()
  res.leaks = ['cacheEntries']
  assert.strictEqual(explainAllocatorGrowth(res), null)
})

test('a clean run is not explained as anything', () => {
  const res = creepRun((i) => ({ rendererRss: (220 + (i % 5)) * 1048576 }))
  assert.deepStrictEqual(res.leaks, [])
  assert.strictEqual(explainAllocatorGrowth(res), null)
})

test('the two metric groups do not overlap', () => {
  const { RETENTION_METRICS, ALLOCATOR_METRICS } = require('../tools/video-soak')
  const both = RETENTION_METRICS.filter(n => ALLOCATOR_METRICS.includes(n))
  assert.deepStrictEqual(both, [], 'a metric cannot be both the evidence and the thing judged')
})

test('the DOM counters are read after a forced collection', () => {
  // Without it they report garbage not yet collected rather than garbage that
  // cannot be, and the difference is the whole question. A hundred-minute run
  // flagged liveNodes, detachedNodes and cdpListeners as leaks with floors
  // climbing 28%, 72% and 65%; a probe that forced a collection first showed all
  // three dead flat over 180 navigations. What the soak had measured was
  // collection becoming less frequent as the process settled, which lifts the
  // minimum of each window and reads as a rising floor with nothing retained.
  const SOAK = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'tools', 'video-soak.js'), 'utf8')
  const fn = SOAK.slice(SOAK.indexOf('const domCounters = async () => {'),
                        SOAK.indexOf('// Resolved on every read, not captured once.'))
  assert.ok(fn.length > 100, 'found domCounters')
  const gcAt = fn.indexOf("HeapProfiler.collectGarbage")
  const readAt = fn.indexOf("Memory.getDOMCounters")
  assert.ok(gcAt > 0, 'no forced collection')
  assert.ok(gcAt < readAt, 'the collection must come before the reading')
  // A refused collection must not lose the counters entirely.
  assert.match(fn, /try \{ await win\.webContents\.debugger\.sendCommand\('HeapProfiler\.collectGarbage'\) \} catch \(_\) \{\}/)
})
