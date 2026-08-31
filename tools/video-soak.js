'use strict'
// Papa soak harness — drives the app unattended for hours and asks one
// question: does it drift?
//
//   node tools/video-soak.js                     # ~2 hour run
//   node tools/video-soak.js --short             # 3 minute run, for development
//   node tools/video-soak.js --minutes=30 --interval=20
//   node tools/video-soak.js --analyse=/path/to/soak-samples.jsonl
//
// Smoothness over a minute and smoothness over an evening are different
// properties. Only the second one can be promised to a user, and it cannot be
// demonstrated — it has to be measured, which is what this file is for.
//
// Every stage prints PASS or FAIL with a timestamp, like video-doctor.js, and
// the run ends in a per-metric verdict plus one overall one.

const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')

// ─────────────────────────────────────────────────────────────────────────────
// Pure analysis. Everything below this heading and above the driver is free of
// I/O and of Electron, because this is the part that has to be right and the
// only way to know it is right is to test it against series whose answer is
// already known. test/video-soak.test.js does exactly that.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  // The first quarter of any run is warm-up: caches fill, lazy modules load,
  // fonts and images resolve. Growth there is the app becoming ready, not a
  // leak, so the verdict is formed on what happens after it.
  warmupFraction: 0.25,
  // The floor is sampled in this many windows. Too few and a slow leak hides
  // inside one window; too many and each window holds too little to contain a
  // GC trough.
  floorWindows: 6,
  // A metric must climb by at least this fraction of its own baseline before
  // it is worth calling a leak.
  leakRelGrowth: 0.10,
  // The bar for a floor that NEVER falls. Lower, because never falling is
  // itself the evidence and a slow leak is still a leak — five percent over a
  // run is a floor with no reason to stop.
  creepRelGrowth: 0.05,
  // Overridable per metric; defaults to a quarter of minAbsGrowth.
  creepMinAbsGrowth: null,
  // …and by at least this much in absolute units, so a DOM going 40 -> 45
  // nodes is not reported as a 12% leak.
  minAbsGrowth: 0,
  // How well a straight line has to fit the floor before a non-monotonic rise
  // counts as a trend rather than as noise.
  minR2: 0.6,
  // Monotonic means "never falls meaningfully", not "never falls": a counter
  // read across process boundaries jitters by a hair.
  monotonicTolerance: 0.01,
}

function mean (xs) {
  if (!xs.length) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

// Least-squares fit against the sample index. Returns the slope in units per
// sample and the R² of the fit, which is the part that matters: slope alone
// cannot tell a real climb from noise that happens to end high.
function trend (series) {
  const n = series.length
  if (n < 2) return { slope: 0, intercept: n ? series[0] : 0, r2: 0 }
  const xs = series.map((_, i) => i)
  const mx = mean(xs)
  const my = mean(series)
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (series[i] - my)
    den += (xs[i] - mx) * (xs[i] - mx)
  }
  const slope = den === 0 ? 0 : num / den
  const intercept = my - slope * mx
  let ssTot = 0
  let ssRes = 0
  for (let i = 0; i < n; i++) {
    const fit = intercept + slope * xs[i]
    ssTot += (series[i] - my) * (series[i] - my)
    ssRes += (series[i] - fit) * (series[i] - fit)
  }
  // A perfectly flat series explains nothing and needs to explain nothing;
  // calling that a perfect fit would let any flat-but-noisy metric claim a
  // trend, so it scores zero.
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot)
  return { slope, intercept, r2 }
}

// A number that only ever goes up is a leak whatever the app looks like while
// it is happening, so this is checked on its own and not only as an input to
// the fit. The tolerance is relative to the series range: absolute tolerances
// are meaningless when one metric is bytes and the next is DOM nodes.
function isMonotonic (series, tolerance = DEFAULTS.monotonicTolerance) {
  if (series.length < 2) return true
  const lo = Math.min(...series)
  const hi = Math.max(...series)
  const slack = Math.abs(hi - lo) * tolerance
  for (let i = 1; i < series.length; i++) {
    if (series[i] < series[i - 1] - slack) return false
  }
  return true
}

// The lower envelope: the minimum of each window. This is the single idea the
// whole analysis rests on. Heap under a healthy GC is a sawtooth — it rises
// and is collected, rises and is collected — so its peaks and its mean both
// wander, but its troughs stay level, because everything reachable at the
// bottom of a collection is everything the app is actually still holding. A
// leak is precisely the case where those troughs climb. Comparing floors
// instead of ends is what stops "end > start" from firing on every healthy run.
function envelopeMin (series, windows = DEFAULTS.floorWindows) {
  const n = series.length
  if (!n) return []
  const w = Math.max(1, Math.min(windows, n))
  const out = []
  for (let i = 0; i < w; i++) {
    const from = Math.floor((i * n) / w)
    const to = Math.max(from + 1, Math.floor(((i + 1) * n) / w))
    out.push(Math.min(...series.slice(from, to)))
  }
  return out
}

// Largest peak-to-trough fall, as a fraction of the total range. High means
// the series gives memory back, which is the signature of GC sawtooth and the
// opposite of a leak.
function maxDrawdownRatio (series) {
  if (series.length < 2) return 0
  let peak = series[0]
  let worst = 0
  for (const v of series) {
    if (v > peak) peak = v
    const fall = peak - v
    if (fall > worst) worst = fall
  }
  const range = Math.max(...series) - Math.min(...series)
  return range === 0 ? 0 : worst / range
}

function relGrowth (from, to) {
  const base = Math.abs(from)
  if (base < 1e-9) return to > 0 ? Infinity : 0
  return (to - from) / base
}

// Decile comparison, kept as its own function because it is what a human reads
// first ("it ended 40% higher than it started") even though it is not what the
// verdict is based on.
function decileDelta (series) {
  if (series.length < 2) return { first: series[0] || 0, last: series[0] || 0, growth: 0 }
  const k = Math.max(1, Math.round(series.length / 10))
  const first = mean(series.slice(0, k))
  const last = mean(series.slice(-k))
  return { first, last, growth: relGrowth(first, last) }
}

// Verdicts, in the order they are decided:
//   leak     — the floor climbs through the settled part of the run
//   warmup   — it climbed early and then the floor went flat (caches filling)
//   sawtooth — it rises and falls a lot, but the floor is level (healthy GC)
//   flat     — it barely moved at all
function analyseSeries (raw, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts)
  const series = (raw || []).filter(v => typeof v === 'number' && isFinite(v))
  if (series.length < 4) {
    return {
      verdict: 'insufficient',
      samples: series.length,
      note: 'need at least 4 samples',
      growth: 0,
      floorGrowth: 0,
      slopePerSample: 0,
      r2: 0,
      monotonic: false,
      drawdownRatio: 0,
      overall: decileDelta(series),
    }
  }

  // A series that never moved is not a measurement of a stable thing; it is a
  // measurement of nothing. Chromium's performance.memory is quantized for
  // privacy and, without --enable-precise-memory-info, returns a flat
  // placeholder — 10,000,000 for every one of 400 samples in the first
  // hundred-minute run. Both renderer heap metrics therefore PASSED, because a
  // constant series has no growth, and the run announced no drift while blind
  // to the process where the UI actually lives.
  //
  // This is the same shape as the tool's own warning about a run that measured
  // nothing, one level down: per metric rather than per run. A constant is
  // reported as such and does not count towards the metrics that decided
  // anything.
  if (new Set(series).size === 1) {
    return {
      verdict: 'constant',
      samples: series.length,
      note: 'never varied (' + series[0] + ') — nothing happened, or nothing was measured',
      growth: 0,
      floorGrowth: 0,
      slopePerSample: 0,
      r2: 0,
      monotonic: false,
      drawdownRatio: 0,
      overall: 0,
      value: series[0],
    }
  }

  const cut = Math.min(series.length - 3, Math.floor(series.length * o.warmupFraction))
  const tail = series.slice(cut)
  const overall = decileDelta(series)
  const floor = envelopeMin(tail, o.floorWindows)
  const floorFirst = floor[0]
  const floorLast = floor[floor.length - 1]
  const floorGrowth = relGrowth(floorFirst, floorLast)
  const floorAbs = floorLast - floorFirst
  const floorTrend = trend(floor)
  const monotonic = isMonotonic(floor, o.monotonicTolerance)
  const drawdownRatio = maxDrawdownRatio(tail)
  const tailDecile = decileDelta(tail)

  const bigEnough = floorGrowth >= o.leakRelGrowth && floorAbs >= o.minAbsGrowth
  // Two independent ways to be a leak: the floor never came back down, or it
  // came down a little but a straight line still explains most of its rise. A
  // noisy-but-flat metric fails both, because its floor wanders in both
  // directions and no line fits it.
  const leak = bigEnough && (monotonic || floorTrend.r2 >= o.minR2)

  // A monotonic floor gets a lower bar, because monotonicity is itself the
  // evidence. This plan's own words are "fail on any monotonic rise", and a
  // twenty-percent gate did not do that: a hundred-minute run measured the
  // renderer's floor climbing 157, 210, 216, 221, 222, 227, 228, 231, 235, 236
  // MB by tenths — never once falling, still rising in the last three — and it
  // passed as warm-up at 9.2%.
  //
  // Slow is not the same as harmless. A floor that never comes down has no
  // reason to stop, and the difference between a leak and warm-up is whether it
  // levels off, not how fast it climbs.
  // A quarter of the leak gate by default. The absolute floor exists to stop
  // noise being called a trend, and a floor that never falls has no noise in
  // the direction that matters — so it does not need as much room. This is what
  // let the renderer's 20MB monotonic rise through: the gate was 32MB, tuned for
  // a metric that wanders.
  const creepAbs = o.creepMinAbsGrowth != null
    ? o.creepMinAbsGrowth
    : Math.round(o.minAbsGrowth / 4)
  const creep = !leak && monotonic &&
    floorGrowth >= o.creepRelGrowth && floorAbs >= creepAbs

  let verdict
  let note
  if (leak) {
    verdict = 'leak'
    note = monotonic
      ? 'floor never falls and climbs ' + pct(floorGrowth) + ' after warm-up'
      : 'floor climbs ' + pct(floorGrowth) + ' after warm-up, r2 ' + floorTrend.r2.toFixed(2)
  } else if (creep) {
    // Reported as a leak so the run fails, and named separately so the reader
    // knows it is the slow kind.
    verdict = 'leak'
    note = 'floor never falls and creeps ' + pct(floorGrowth) + ' after warm-up — slow, but it never comes down'
  } else if (overall.growth >= o.leakRelGrowth && Math.abs(floorGrowth) < o.leakRelGrowth) {
    verdict = 'warmup'
    note = 'grew ' + pct(overall.growth) + ' overall but the floor is flat after warm-up'
  } else if (drawdownRatio >= 0.5 && Math.abs(floorGrowth) < o.leakRelGrowth) {
    verdict = 'sawtooth'
    note = 'rises and falls (drawdown ' + pct(drawdownRatio) + ') with a level floor'
  } else {
    verdict = 'flat'
    note = 'floor moved ' + pct(floorGrowth)
  }

  return {
    verdict,
    note,
    samples: series.length,
    warmupDropped: cut,
    growth: overall.growth,
    tailGrowth: tailDecile.growth,
    floorGrowth,
    floorAbs,
    floor,
    slopePerSample: floorTrend.slope,
    r2: floorTrend.r2,
    monotonic,
    drawdownRatio,
    overall,
  }
}

// Runs analyseSeries over every metric in a list of samples. Per-metric options
// exist because the thresholds are not universal: a listener count that only
// climbs is damning at any magnitude, while a few megabytes of RSS is not.
function analyseRun (samples, perMetric = {}) {
  const rows = Array.isArray(samples) ? samples : []
  const names = new Set()
  for (const s of rows) {
    for (const k of Object.keys(s.metrics || {})) {
      // An underscore prefix means "recorded, not judged": a label carried
      // alongside a number so a rise can name its own cause. Without this it
      // becomes a metric with no numbers and reports as "insufficient" forever,
      // which also drags down the count of metrics that actually decided
      // anything.
      if (k.charAt(0) === '_') continue
      names.add(k)
    }
  }
  const metrics = {}
  const leaks = []
  for (const name of names) {
    const series = rows
      .map(s => (s.metrics || {})[name])
      .filter(v => typeof v === 'number' && isFinite(v))
    const res = analyseSeries(series, perMetric[name] || {})
    metrics[name] = res
    if (res.verdict === 'leak') leaks.push(name)
  }
  // A run that measured nothing is not a run that found nothing wrong, and the
  // difference matters most in exactly the case where it is easiest to miss:
  // the harness failed to attach, every sample came back empty, and the tool
  // reported PASS. Silence is not evidence.
  const decided = Object.values(metrics).filter(m => m.verdict !== 'insufficient' && m.verdict !== 'constant')
  let verdict
  if (leaks.length) verdict = 'FAIL'
  else if (!decided.length) verdict = 'INCONCLUSIVE'
  else verdict = 'PASS'
  return {
    samples: rows.length,
    durationMs: rows.length ? (rows[rows.length - 1].t - rows[0].t) : 0,
    metrics,
    leaks,
    decidedMetrics: decided.length,
    verdict,
  }
}

function pct (x) {
  if (!isFinite(x)) return '∞'
  return (x * 100).toFixed(1) + '%'
}

// Thresholds per metric. A listener or DOM node that only ever grows is a bug
// no matter how slowly; heap needs more room because a JIT and a GC both move
// it around for reasons that are not the app's fault.
const METRIC_RULES = {
  domNodes: { leakRelGrowth: 0.08, minAbsGrowth: 200 },
  // Tuned for the live count, which sits in the tens rather than the hundreds.
  // A one-time init on a page first visited late in a run moves it by 2, so the
  // absolute floor is what stops that reading as a leak.
  listeners: { leakRelGrowth: 0.15, minAbsGrowth: 8 },
  // Nothing collects these, so a sustained rise matters — but the app registers
  // a fixed set of them as pages are first visited, and on a short run those
  // first visits fall AFTER the warm-up window and read as a step change. The
  // floor is set above the app's whole global budget (twenty registrations, of
  // which the measured live count is six) so a genuine repeat leak still trips
  // it while one-time init does not. test/soak-probe.test.js guards the budget
  // statically, which is the check that catches a new leak at commit time
  // rather than two hours into a run.
  listenersGlobal: { leakRelGrowth: 0.5, minAbsGrowth: 24 },
  rendererHeapUsed: { leakRelGrowth: 0.15, minAbsGrowth: 8 * 1024 * 1024 },
  rendererHeapTotal: { leakRelGrowth: 0.20, minAbsGrowth: 16 * 1024 * 1024 },
  mainHeapUsed: { leakRelGrowth: 0.15, minAbsGrowth: 8 * 1024 * 1024 },
  // V8's TOTAL allocated heap ratchets by design: it grows in steps and rarely
  // hands memory back to the OS, so a monotonic floor here is expected rather
  // than evidence. mainHeapUsed is the figure that says whether anything is
  // actually being retained, and mainRss whether the process is growing.
  //
  // So the creep rule gets no relaxed absolute gate for this one. Without that,
  // the real hundred-minute run flagged it at 24% floor growth on a heap whose
  // used-floor was flat and whose absolute rise was under its own 16MB bar.
  mainHeapTotal: {
    leakRelGrowth: 0.20,
    minAbsGrowth: 16 * 1024 * 1024,
    creepMinAbsGrowth: 16 * 1024 * 1024,
  },
  mainExternal: { leakRelGrowth: 0.25, minAbsGrowth: 16 * 1024 * 1024 },
  mainRss: { leakRelGrowth: 0.20, minAbsGrowth: 32 * 1024 * 1024 },
  // The renderer holds the whole UI, so it is the process a leak shows up in
  // first. Same shape of threshold as main's.
  rendererRss: { leakRelGrowth: 0.20, minAbsGrowth: 32 * 1024 * 1024 },
  cacheEntries: { leakRelGrowth: 0.25, minAbsGrowth: 50 },
  ipcRttMs: { leakRelGrowth: 0.50, minAbsGrowth: 5 },
  // The stream cache is a disk cache that is meant to fill; only a monotonic
  // climb past the purge point says the purge is broken.
  streamCacheBytes: { leakRelGrowth: 0.50, minAbsGrowth: 512 * 1024 * 1024 },
}

module.exports = {
  analyseSeries,
  analyseRun,
  isMonotonic,
  trend,
  envelopeMin,
  maxDrawdownRatio,
  decileDelta,
  relGrowth,
  mean,
  METRIC_RULES,
  DEFAULTS,
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver. Nothing below here runs on require, so the tests above stay cheap.
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs (argv) {
  const opt = {
    minutes: 120,
    intervalSec: 15,
    userDataDir: path.join(require('os').tmpdir(), 'papa-soak-profile'),
    out: path.join(require('os').tmpdir(), 'papa-soak-samples.jsonl'),
    resume: false,
    analyse: null,
    headless: false,
  }
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const [, k, v] = m
    if (k === 'short') { opt.minutes = 3; opt.intervalSec = 5 }
    else if (k === 'minutes') opt.minutes = Number(v)
    else if (k === 'interval') opt.intervalSec = Number(v)
    else if (k === 'user-data-dir') opt.userDataDir = path.resolve(v)
    else if (k === 'out') opt.out = path.resolve(v)
    else if (k === 'resume') opt.resume = true
    else if (k === 'analyse' || k === 'analyze') opt.analyse = path.resolve(v)
    else if (k === 'headless') opt.headless = true
  }
  if (process.env.PAPA_SOAK_MINUTES) opt.minutes = Number(process.env.PAPA_SOAK_MINUTES)
  if (process.env.PAPA_SOAK_INTERVAL) opt.intervalSec = Number(process.env.PAPA_SOAK_INTERVAL)
  return opt
}

const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(7) + 'ms'
const pass = (s, extra) => console.log(`${ms()}  PASS  ${s}${extra ? ' — ' + extra : ''}`)
const fail = (s, extra) => console.log(`${ms()}  FAIL  ${s}${extra ? ' — ' + extra : ''}`)
const info = (s) => console.log(`${ms()}  ....  ${s}`)

function readSamples (file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (_) { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    // A run killed mid-write leaves a torn last line. Losing it is fine;
    // refusing to read the other three hours of data would not be.
    try { out.push(JSON.parse(line)) } catch (_) {}
  }
  return out
}

function reportRun (samples) {
  const res = analyseRun(samples, METRIC_RULES)
  console.log('')
  console.log(`${ms()}  ====  ${res.samples} samples over ${(res.durationMs / 60000).toFixed(1)} min`)
  const names = Object.keys(res.metrics).sort()
  for (const name of names) {
    const m = res.metrics[name]
    const line = `${name.padEnd(20)} ${m.verdict.padEnd(12)} start→end ${pct(m.growth).padStart(8)}  floor ${pct(m.floorGrowth).padStart(8)}  ${m.note}`
    if (m.verdict === 'leak') fail(line)
    else pass(line)
  }
  console.log('')
  if (res.verdict === 'PASS') {
    console.log('>>> No drift. The app held steady for the whole run.')
  } else {
    console.log('>>> DRIFT in: ' + res.leaks.join(', '))
    console.log('    A rising floor means the app is holding something it never gives back.')
  }
  return res
}

// The renderer counts its own listeners, because there is no API that will tell
// you from outside. Chromium exposes getEventListeners only in DevTools, so the
// only honest count comes from wrapping the two functions that change it.
//
// The first version of this counted registrations: adds minus explicit removes.
// On a renderer that builds pages by assigning innerHTML, that number can only
// go up — every page render attaches listeners to fresh elements and then
// discards those elements, and discarding an element takes its listeners with
// it without any removeEventListener call. So the metric grew linearly forever
// and the harness reported a leak on its first run: measured at 25, 42, 59,
// 474, 793, 1014 across one three-minute soak.
//
// It was not a leak. Counting only LIVE listeners — a registration whose target
// is still reachable and, for an element, still attached to the document — the
// same navigation loop sits flat at 27 across six rounds. A metric that cannot
// ever pass is worse than no metric, because a light that is always red is a
// light nobody looks at.
//
// What survives is what actually leaks: listeners on window, document, the
// documentElement and body, which nothing collects, plus anything still in the
// tree. WeakRef is what makes the difference visible — if the target has been
// collected, the listener went with it.
const LISTENER_PROBE = `(function () {
  if (window.__soakListeners) return 'already'
  var add = EventTarget.prototype.addEventListener
  var rem = EventTarget.prototype.removeEventListener
  var reg = []
  function isGlobal (t) {
    return t === window || t === document || t === document.documentElement || t === document.body
  }
  // The call site of a surviving global listener, so a rise names its own
  // culprit instead of sending the next person back to a bisect. Only computed
  // for globals: building a stack for every element listener would change what
  // is being measured.
  function site () {
    try {
      var lines = ((new Error()).stack || '').split('\\n').slice(2)
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('renderer.js') >= 0) return lines[i].trim().replace(/^at /, '')
      }
      return (lines[0] || '?').trim()
    } catch (e) { return '?' }
  }
  EventTarget.prototype.addEventListener = function (type, fn) {
    // Never allowed to break the app it is measuring.
    try {
      var g = isGlobal(this)
      reg.push({ ref: new WeakRef(this), type: type, fn: fn, g: g, s: g ? site() : null })
    } catch (e) {}
    return add.apply(this, arguments)
  }
  EventTarget.prototype.removeEventListener = function (type, fn) {
    try {
      for (var i = reg.length - 1; i >= 0; i--) {
        var r = reg[i]
        if (r.type !== type || r.fn !== fn) continue
        if (r.ref.deref() === this) { reg.splice(i, 1); break }
      }
    } catch (e) {}
    return rem.apply(this, arguments)
  }
  window.__soakListeners = {
    read: function () {
      var live = 0, glob = 0, kept = [], by = {}
      for (var i = 0; i < reg.length; i++) {
        var r = reg[i]
        var t = r.ref.deref()
        if (!t) continue                       // collected with its element
        if (!r.g && !t.isConnected) continue   // detached, so collectable
        kept.push(r)
        live++
        if (r.g) { glob++; var k = r.s + ' :: ' + r.type; by[k] = (by[k] || 0) + 1 }
      }
      // Pruned on every read, or the registry becomes the leak.
      reg = kept
      var sites = Object.keys(by).map(function (k) { return by[k] + ' x ' + k })
      sites.sort()
      return { live: live, global: glob, sites: sites }
    },
  }
  return 'installed'
})()`

const SAMPLE_PROBE = `(async function () {
  var t = performance.now()
  try { await window.api.getAppInfo() } catch (e) {}
  var rtt = performance.now() - t
  var mem = (performance && performance.memory) || {}
  var ls = (window.__soakListeners && window.__soakListeners.read)
    ? window.__soakListeners.read()
    : { live: 0, global: 0 }
  return {
    domNodes: document.getElementsByTagName('*').length,
    listeners: ls.live,
    // Broken out because these are the ones nothing can collect. A rise here is
    // a leak with no ambiguity at all.
    listenersGlobal: ls.global,
    // Not a metric -- a label. Reported alongside the number so a rise says
    // where it came from.
    _globalSites: ls.sites,
    // Recorded, not judged. Chromium quantizes performance.memory for privacy
    // and without --enable-precise-memory-info it returns a flat placeholder,
    // so as metrics these two passed by never moving. rendererRss, taken from
    // the main process, is the real figure.
    _rendererHeapUsed: mem.usedJSHeapSize || 0,
    _rendererHeapTotal: mem.totalJSHeapSize || 0,
    ipcRttMs: rtt,
  }
})()`

function dirSizeBytes (dir) {
  let total = 0
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSizeBytes(p)
      else total += fs.statSync(p).size
    } catch (_) {}
  }
  return total
}

// Every action the loop can take. Each drives real work through the renderer's
// own entry points rather than synthesising DOM, so what is measured is the app
// and not the harness.
const ACTIONS = [
  { name: 'home', js: `(function(){ navigate('home'); return 1 })()` },
  { name: 'library', js: `(function(){ navigate('library'); return 1 })()` },
  { name: 'artists', js: `(function(){ navigate('artists'); return 1 })()` },
  { name: 'browse', js: `(function(){ navigate('browse'); return 1 })()` },
  { name: 'video-shelves', js: `(function(){ try { _videoTab = 'all' } catch (e) {} navigate('video'); return 1 })()` },
  { name: 'explore', js: `(function(){ navigate('explore'); return 1 })()` },
  { name: 'search', js: `(function(){ navigate('search', 'radiohead'); return 1 })()` },
  { name: 'search-2', js: `(function(){ navigate('search', 'miles davis'); return 1 })()` },
  { name: 'liked', js: `(function(){ navigate('liked'); return 1 })()` },
  { name: 'stats', js: `(function(){ navigate('stats'); return 1 })()` },
  // Detail pages are where per-item listeners get attached, so they are the
  // most likely place for a listener count to ratchet.
  {
    name: 'first-album',
    js: `(function(){
      var el = document.querySelector('[data-album-id]')
      if (!el) return 0
      navigate('album', el.dataset.albumId)
      return 1
    })()`,
  },
  {
    name: 'video-detail',
    js: `(function(){
      var el = document.querySelector('[data-video-id],[data-nav-id]')
      if (!el) return 0
      navigate('video-detail', el.dataset.videoId || el.dataset.navId)
      return 1
    })()`,
  },
  { name: 'back', js: `(function(){ try { navigateBack() } catch (e) {} return 1 })()` },
]

async function runElectron (opt) {
  const { app, BrowserWindow } = require('electron')

  // Never the user's real profile: a soak run writes settings, caches and
  // history, and it may be killed at any moment.
  fs.mkdirSync(opt.userDataDir, { recursive: true })
  app.setPath('userData', opt.userDataDir)

  // Wrapping the cache factory before main.js is required is the only way to
  // see inside caches that are module-scoped consts. main.js gets this same
  // module object out of the require cache, so every cache it makes lands in
  // the registry without main.js being touched.
  const ttl = require(path.join(ROOT, 'src/ttl-cache.js'))
  const caches = []
  const realMake = ttl.makeCache
  ttl.makeCache = function (o) { const c = realMake(o); caches.push(c); return c }

  let mainMod
  try {
    require(path.join(ROOT, 'main.js'))
    mainMod = true
    pass('main process loads')
  } catch (e) {
    fail('main process loads', e && e.message)
    process.exit(1)
  }
  if (!mainMod) return

  await app.whenReady()
  const win = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 60000
    const poll = () => {
      const w = BrowserWindow.getAllWindows()[0]
      if (w) return resolve(w)
      if (Date.now() > deadline) return reject(new Error('no window after 60s'))
      setTimeout(poll, 250)
    }
    poll()
  }).catch(e => { fail('window appears', e.message); return null })
  if (!win) { app.exit(1); return }
  pass('window appears')

  if (opt.headless) win.hide()

  await new Promise(r => {
    if (!win.webContents.isLoading()) return r()
    win.webContents.once('did-finish-load', r)
    setTimeout(r, 30000)
  })
  // The renderer builds its first page asynchronously; sampling before it
  // settles would put the whole of start-up into the first sample and make
  // every metric look like it shrank.
  await wait(5000)

  const js = (src) => win.webContents.executeJavaScript(src, true)

  // app.getAppMetrics() reports every child process with real numbers. The
  // renderer is identified by its pid rather than by its type string, which
  // differs across Electron versions.
  // Resolved on every read, not captured once. getOSProcessId() returns 0
  // before the renderer process exists, and a pid captured then would make this
  // metric a constant zero for the whole run — which the `constant` verdict
  // would now catch, but silently measuring nothing is not worth risking twice.
  let rendererPid = null
  const rendererRss = () => {
    try {
      if (!rendererPid) {
        const p = win.webContents.getOSProcessId()
        if (p) rendererPid = p
      }
      if (!rendererPid) return 0
      const hit = app.getAppMetrics().find(x => x && x.pid === rendererPid)
      // workingSetSize is in kilobytes.
      return hit && hit.memory ? (hit.memory.workingSetSize || 0) * 1024 : 0
    } catch (_) { return 0 }
  }
  const probe = await js(LISTENER_PROBE).catch(e => 'THREW ' + e.message)
  if (String(probe).startsWith('THREW')) {
    // Aborted, not noted and carried on. A probe that failed to install reports
    // zero listeners at every sample, a constant series reads as "flat", and
    // flat is a PASS — so the run would end by announcing that nothing drifted
    // in the one metric it was blind to. This tool already says elsewhere that
    // a run which measured nothing is not a run that found nothing wrong; this
    // is that principle applied to itself.
    //
    // It has happened: an escaping slip put a real newline inside the probe
    // source, the install threw, and the samples read 0/0g for the whole run.
    fail('listener probe installs', probe)
    fail('soak aborted', 'refusing to run blind on listeners')
    app.exit(1)
    return
  }
  pass('listener probe installs', String(probe))

  let torrent = null
  try { torrent = require(path.join(ROOT, 'torrent-stream.js')) } catch (_) {}

  const samples = opt.resume ? readSamples(opt.out) : []
  if (opt.resume && samples.length) info(`resuming with ${samples.length} samples already on disk`)
  const stream = fs.createWriteStream(opt.out, { flags: opt.resume ? 'a' : 'w' })
  pass('sample file open', opt.out)

  const endAt = Date.now() + opt.minutes * 60000
  info(`soaking for ${opt.minutes} min, sampling every ${opt.intervalSec}s — Ctrl-C is safe, samples are on disk`)

  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  let actionIdx = 0
  let sampleNo = 0
  while (!stopping && Date.now() < endAt) {
    const action = ACTIONS[actionIdx++ % ACTIONS.length]
    const drove = await js(action.js).catch(e => 'THREW ' + e.message)
    // Real pages need time to render and fetch before the next one replaces
    // them; hammering navigate() would measure a queue, not a session.
    await wait(Math.min(opt.intervalSec * 1000, 8000))

    let m = {}
    try { m = await js(SAMPLE_PROBE) } catch (e) { m = {} }
    const mem = process.memoryUsage()
    let cacheEntries = 0
    for (const c of caches) { try { cacheEntries += c.size } catch (_) {} }
    const sample = {
      t: Date.now(),
      n: ++sampleNo,
      action: action.name,
      drove: drove === 1,
      metrics: Object.assign({
        mainHeapUsed: mem.heapUsed,
        mainHeapTotal: mem.heapTotal,
        mainExternal: mem.external,
        mainRss: mem.rss,
        // The renderer's real memory, from the main process. The probe's own
        // performance.memory numbers are quantized by Chromium for privacy and
        // came back as a flat 10,000,000 for all 400 samples of the first
        // hundred-minute run — so the process where the UI actually lives was
        // the one process never measured, and it passed by being constant.
        rendererRss: rendererRss(),
        cacheEntries,
        streamCacheBytes: torrent ? dirSizeBytes(torrent.streamRoot()) : 0,
      }, m),
    }
    samples.push(sample)
    // Written one line at a time, flushed as we go: a crash three hours in
    // must cost the last sample, not the run.
    stream.write(JSON.stringify(sample) + '\n')
    if (sampleNo % 10 === 0 || sampleNo <= 3) {
      info(`sample ${sampleNo} (${action.name}) dom ${sample.metrics.domNodes} listeners ${sample.metrics.listeners}/${sample.metrics.listenersGlobal}g rss ${(sample.metrics.rendererRss / 1048576).toFixed(0)}MB main ${(sample.metrics.mainRss / 1048576).toFixed(0)}MB rtt ${(sample.metrics.ipcRttMs || 0).toFixed(1)}ms`)
      // Who holds the uncollectable ones. Printed rather than left in the file,
      // because the number on its own sends the reader back to a bisect.
      const sites = sample.metrics._globalSites
      if (Array.isArray(sites) && sites.length) {
        for (const line of sites) info('    global: ' + line)
      }
    }

    const remain = Math.max(0, opt.intervalSec * 1000 - 8000)
    if (remain) await wait(remain)
  }

  stream.end()
  if (stopping) info('interrupted — analysing what was collected')
  const res = reportRun(samples)

  // Killing the harness must not leave mpv processes behind talking to sockets
  // nobody owns any more, so the same purge the app runs at startup runs here
  // at shutdown, plus the stream directories this run created.
  try {
    const ve = require(path.join(ROOT, 'video-engine.js'))
    const purged = await ve.purgeOrphanPlayers()
    info(`purged mpv: ${purged.quit} quit, ${purged.stale} stale sockets`)
  } catch (e) { info('mpv purge skipped: ' + (e && e.message)) }
  try {
    if (torrent && typeof torrent.purgeOrphanStreams === 'function') {
      const p = torrent.purgeOrphanStreams()
      info(`purged stream dirs: ${p.removed || 0}`)
    }
  } catch (_) {}

  app.exit(res.verdict === 'PASS' ? 0 : 2)
}

function wait (msec) { return new Promise(r => setTimeout(r, msec)) }

// Re-executes itself under Electron, because the app under test only exists
// inside an Electron main process, and `node tools/video-soak.js` is what the
// other tools in this folder are run as.
function relaunchUnderElectron (opt, argv) {
  const { spawn } = require('child_process')
  let electronBin
  try { electronBin = require(path.join(ROOT, 'node_modules/electron')) } catch (e) {
    fail('electron available', e && e.message)
    process.exit(1)
  }
  info('starting Electron…')
  const child = spawn(electronBin, [__filename].concat(argv), {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { PAPA_SOAK: '1' }),
  })
  // Forwarded rather than killed outright: the child needs to finish its
  // analysis and purge mpv before it goes.
  const forward = (sig) => () => { try { child.kill(sig) } catch (_) {} }
  process.on('SIGINT', forward('SIGINT'))
  process.on('SIGTERM', forward('SIGTERM'))
  child.on('exit', code => process.exit(code == null ? 1 : code))
}

// Electron does not set require.main for the app's entry script, so
// `require.main === module` is FALSE in the Electron child this file spawns for
// itself. The child therefore loaded this module, defined every function in it,
// and did nothing at all — no window, no samples, no output, and no exit. The
// parent printed "starting Electron…" and waited forever.
//
// That is why this harness had never run. The pure analysis below the fold has
// always been tested, which is exactly why the gap survived: the part with the
// tests was fine and the part that runs it was never exercised end to end.
function isEntryPoint () {
  if (require.main === module) return true
  if (!process.versions.electron) return false
  const entry = process.argv[1]
  if (!entry) return false
  try { return path.resolve(entry) === path.resolve(__filename) } catch (_) { return false }
}

if (isEntryPoint()) {
  const argv = process.argv.slice(2)
  const opt = parseArgs(argv)
  if (opt.analyse) {
    const rows = readSamples(opt.analyse)
    info(`${rows.length} samples from ${opt.analyse}`)
    const res = reportRun(rows)
    process.exit(res.verdict === 'PASS' ? 0 : 2)
  } else if (process.versions.electron) {
    runElectron(opt).catch(e => { fail('soak crashed', e && e.stack); process.exit(1) })
  } else {
    relaunchUnderElectron(opt, argv)
  }
}
