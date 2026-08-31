'use strict';
// The listener probe, executed.
//
// Its first version counted registrations — adds minus explicit removes — and
// on a renderer that assigns innerHTML that can only rise: every render
// attaches listeners to fresh elements, and discarding an element takes its
// listeners with it without any removeEventListener call. So the harness
// reported a leak on its first ever run (25 → 1014 in three minutes) and there
// was no leak. A metric that can never pass is worse than no metric.
//
// These tests run the probe source against a fake EventTarget world and assert
// the distinction it now has to make: a listener on a thrown-away element is
// not a leak; a listener on document is.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SOAK = fs.readFileSync(path.join(__dirname, '..', 'tools', 'video-soak.js'), 'utf8')

// The probe is a string of browser JS. Lift it out and run it against a
// stand-in DOM, which is the only way to test what it actually does.
function runProbe() {
  const m = SOAK.match(/const LISTENER_PROBE = `([\s\S]*?)`\n/)
  assert.ok(m, 'found LISTENER_PROBE')

  class FakeTarget {
    constructor(name) { this.name = name; this._l = []; this.isConnected = true }
    addEventListener(type, fn) { this._l.push([type, fn]) }
    removeEventListener(type, fn) {
      const i = this._l.findIndex(([t, f]) => t === type && f === fn)
      if (i >= 0) this._l.splice(i, 1)
    }
  }
  const documentEl = new FakeTarget('documentElement')
  const body = new FakeTarget('body')
  const doc = new FakeTarget('document')
  doc.documentElement = documentEl
  doc.body = body
  const win = new FakeTarget('window')

  // The probe patches EventTarget.prototype, so the fake world needs one.
  const sandbox = {
    EventTarget: FakeTarget,
    window: win,
    document: doc,
    WeakRef: global.WeakRef,
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('EventTarget', 'window', 'document', 'WeakRef', 'return ' + m[1])
  const result = fn(FakeTarget, win, doc, sandbox.WeakRef)
  assert.strictEqual(result, 'installed')
  return { FakeTarget, win, doc, body, documentEl, read: () => win.__soakListeners.read() }
}

test('the probe installs and starts at nothing', () => {
  const w = runProbe()
  const r = w.read()
  assert.strictEqual(r.live, 0)
  assert.strictEqual(r.global, 0)
  assert.deepStrictEqual(r.sites, [])
})

test('a listener on a live element counts', () => {
  const w = runProbe()
  const el = new w.FakeTarget('div')
  el.addEventListener('click', () => {})
  const r = w.read()
  assert.strictEqual(r.live, 1)
  assert.strictEqual(r.global, 0)
})

test('a listener on a DETACHED element does not count', () => {
  // This is the whole correction. setContent() replaces innerHTML; the old
  // elements leave the tree and their listeners go with them.
  const w = runProbe()
  const el = new w.FakeTarget('div')
  el.addEventListener('click', () => {})
  assert.strictEqual(w.read().live, 1)
  el.isConnected = false
  assert.strictEqual(w.read().live, 0, 'a discarded element must not read as a leak')
})

test('a hundred renders of a page do not accumulate', () => {
  // The exact shape that produced the false leak: bind, discard, repeat.
  const w = runProbe()
  for (let i = 0; i < 100; i++) {
    const el = new w.FakeTarget('page' + i)
    for (let j = 0; j < 17; j++) el.addEventListener('click', () => {})
    el.isConnected = false
  }
  assert.strictEqual(w.read().live, 0)
})

test('listeners on document and window are counted as global and never collected', () => {
  const w = runProbe()
  w.doc.addEventListener('keydown', () => {})
  w.win.addEventListener('resize', () => {})
  w.body.addEventListener('click', () => {})
  w.documentEl.addEventListener('scroll', () => {})
  const r = w.read()
  assert.strictEqual(r.global, 4)
  assert.strictEqual(r.live, 4)
})

test('a global listener stays counted even if it looks detached', () => {
  // document does not leave the document. isConnected must not be consulted for
  // a global target, or the one category that really leaks would be invisible.
  const w = runProbe()
  w.doc.addEventListener('keydown', () => {})
  w.doc.isConnected = false
  assert.strictEqual(w.read().global, 1, 'document cannot be detached away')
})

test('an explicit removal is reflected', () => {
  const w = runProbe()
  const fn = () => {}
  w.doc.addEventListener('keydown', fn)
  assert.strictEqual(w.read().global, 1)
  w.doc.removeEventListener('keydown', fn)
  const r = w.read()
  assert.strictEqual(r.live, 0)
  assert.strictEqual(r.global, 0)
  assert.deepStrictEqual(r.sites, [])
})

test('a removal only drops its own registration', () => {
  const w = runProbe()
  const a = () => {}
  const b = () => {}
  w.doc.addEventListener('keydown', a)
  w.doc.addEventListener('keydown', b)
  w.doc.removeEventListener('keydown', a)
  assert.strictEqual(w.read().global, 1)
})

test('a removal on a different target does not drop the entry', () => {
  const w = runProbe()
  const fn = () => {}
  w.doc.addEventListener('keydown', fn)
  const other = new w.FakeTarget('other')
  other.removeEventListener('keydown', fn)
  assert.strictEqual(w.read().global, 1, 'a same-type, same-fn removal elsewhere must not count')
})

test('the modal-reopen leak this app has had three times would be caught', () => {
  // Items 73, 74 and 257: a modal that registers a document keydown and whose
  // re-open path bypasses its own teardown. Three separate instances, each
  // found by hand. This is what it looks like to the probe.
  const w = runProbe()
  for (let i = 0; i < 20; i++) {
    const el = new w.FakeTarget('modal' + i)
    el.addEventListener('click', () => {})
    w.doc.addEventListener('keydown', () => {})   // never removed
    el.isConnected = false                         // DOM replaced, listener orphaned
  }
  const r = w.read()
  assert.strictEqual(r.global, 20, 'twenty orphaned document listeners')
  assert.strictEqual(r.live, 20, 'and nothing else, because the elements went')
})

test('the registry prunes itself, so the probe is not the leak', () => {
  const w = runProbe()
  for (let i = 0; i < 500; i++) {
    const el = new w.FakeTarget('x' + i)
    el.addEventListener('click', () => {})
    el.isConnected = false
  }
  w.read()
  // A second read must be just as cheap: the dead entries are gone, not
  // re-scanned forever.
  assert.strictEqual(w.read().live, 0)
})

test('the sample probe reports both counts', () => {
  const m = SOAK.match(/const SAMPLE_PROBE = `([\s\S]*?)`\n/)
  assert.ok(m, 'found SAMPLE_PROBE')
  assert.match(m[1], /listeners: ls\.live/)
  assert.match(m[1], /listenersGlobal: ls\.global/)
  assert.doesNotMatch(m[1], /\{ n: 0 \}/, 'the registration counter is gone')
})

test('both listener metrics have thresholds', () => {
  // A metric with no entry falls back to the defaults, which are tuned for
  // heap-sized numbers and would call a move of 2 a leak.
  // Sliced from the first to well past the second; the comment between them is
  // long, which is why a fixed window was too small.
  const from = SOAK.indexOf('listeners: {')
  const to = SOAK.indexOf('}', SOAK.indexOf('listenersGlobal: {'))
  assert.ok(from > 0 && to > from, 'found both threshold entries')
  const block = SOAK.slice(from, to + 1)
  assert.match(block, /listeners: \{[^}]*minAbsGrowth: \d+/)
  assert.match(block, /listenersGlobal: \{[^}]*minAbsGrowth: \d+/)
})

// ── the app's global-listener budget ───────────────────────────────────────
//
// A listener on document or window is never collected: the target outlives
// every page. This app has already shipped three separate instances of the same
// leak (catalogue items 73, 74 and 257 — a modal that registers a document
// keydown and whose re-open path bypasses its own teardown), each found by hand
// after the fact.
//
// Measured behaviour today, over five rounds of ten page changes: four global
// listeners after the first round, six after the fifth, and every call site
// holding exactly one. Nothing repeats. That is the property worth keeping.
//
// A soak run finds a regression here only after two hours, and only if the run
// happens to open the modal that leaks. This finds it at commit time. It is a
// budget rather than a proof: adding a global listener is allowed, and it
// requires updating this number, which is the moment to ask whether the
// function it sits in can run twice.

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function globalListenerSites() {
  const out = { moduleScope: [], inFunction: [] }
  RENDERER.split('\n').forEach((line, i) => {
    const m = /^(\s*)(document|window)\.addEventListener\(\s*'([a-z]+)'/.exec(line)
    if (!m) return
    const site = { line: i + 1, target: m[2], type: m[3] }
    if (m[1].length === 0) out.moduleScope.push(site)
    else out.inFunction.push(site)
  })
  return out
}

test('the number of global listener registrations is a deliberate budget', () => {
  const sites = globalListenerSites()
  // Module scope runs exactly once, so these cannot accumulate however the app
  // is driven.
  assert.strictEqual(sites.moduleScope.length, 5,
    'module-scope global listeners changed; these are safe by construction, ' +
    'but update the number so the change was seen')
  // These are the ones that need a run-once guard or a paired removal. If this
  // number grows, check that the new one cannot be registered twice.
  assert.strictEqual(sites.inFunction.length, 15,
    'a global listener was added inside a function. Nothing collects a listener ' +
    'on document or window, so make sure that function cannot run twice — this ' +
    'app has shipped that exact leak three times (items 73, 74, 257) — then ' +
    'update this number.')
})

test('no function registers more than one global listener of the same type', () => {
  // Two keydowns from one function is the signature of a copy-paste that will
  // fire twice per event as well as leaking twice.
  const sites = globalListenerSites()
  const seen = new Map()
  for (const s of [...sites.moduleScope, ...sites.inFunction]) {
    const key = s.target + ':' + s.type
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  // keydown legitimately has several, each for a different surface (the browse
  // grid, a modal, the shortcut handler). What must not happen is one of them
  // being registered twice, which the measurement above covers and this records.
  assert.ok(seen.get('document:keydown') <= 8, 'document keydown registrations: ' + seen.get('document:keydown'))
  assert.ok((seen.get('window:online') || 0) <= 1)
  assert.ok((seen.get('window:offline') || 0) <= 1)
})

test('the video UI init is guarded, because it registers three global listeners', () => {
  // _initVideoUI adds keydown, pointerdown and resize. It is called by every
  // video page render, so without the guard that is three per navigation.
  const fn = RENDERER.slice(RENDERER.indexOf('function _initVideoUI()'),
                            RENDERER.indexOf('function _initVideoUI()') + 400)
  assert.match(fn, /if \(_videoUiReady\) return/, 'the run-once guard is gone')
  assert.match(fn, /_videoUiReady = true/)
})

test('an underscore-prefixed sample key is recorded but never judged', () => {
  // _globalSites carries the call sites of the surviving global listeners so a
  // rise names its own cause. It is an array, so as a metric it would have no
  // numbers, report "insufficient" forever, and drag down the count of metrics
  // that actually decided something — which is the check that catches a run
  // that measured nothing.
  const { analyseRun } = require(path.join(__dirname, '..', 'tools', 'video-soak.js'))
  const samples = []
  for (let i = 0; i < 40; i++) {
    samples.push({ metrics: { listenersGlobal: 4, _globalSites: ['1 x foo :: keydown'] } })
  }
  const res = analyseRun(samples)
  assert.ok(res.metrics.listenersGlobal, 'the number is judged')
  assert.strictEqual(res.metrics._globalSites, undefined, 'the label is not')
})

test('a rise in global listeners is reported with its call sites', () => {
  const SOAK2 = fs.readFileSync(path.join(__dirname, '..', 'tools', 'video-soak.js'), 'utf8')
  assert.match(SOAK2, /global: ' \+ line/, 'the sites are printed alongside the count')
  const probe = SOAK2.match(/const LISTENER_PROBE = `([\s\S]*?)`\n/)[1]
  assert.match(probe, /function site \(\)/)
  // Only for globals: a stack per element listener would change what is being
  // measured.
  assert.match(probe, /s: g \? site\(\) : null/)
})

test('a failed probe install aborts the run instead of passing blind', () => {
  // A probe that does not install reports zero at every sample; a constant
  // series reads as "flat"; flat is a PASS. So the run would end by announcing
  // that nothing drifted in the one metric it could not see. This happened: an
  // escaping slip put a real newline inside the probe source and the samples
  // read 0/0g for a whole run.
  const SOAK3 = fs.readFileSync(path.join(__dirname, '..', 'tools', 'video-soak.js'), 'utf8')
  const at = SOAK3.indexOf("const probe = await js(LISTENER_PROBE)")
  assert.ok(at > 0)
  const block = SOAK3.slice(at, at + 1200)
  assert.match(block, /fail\('listener probe installs'/)
  assert.match(block, /app\.exit\(1\)/, 'a blind run must not continue')
})

test('a constant-zero series really does read as a pass, which is why that matters', () => {
  // The assertion behind the abort above. If this ever stops being true the
  // abort could be relaxed — until then it is load-bearing.
  const { analyseSeries } = require(path.join(__dirname, '..', 'tools', 'video-soak.js'))
  const res = analyseSeries(new Array(40).fill(0))
  assert.notStrictEqual(res.verdict, 'leak', 'a blind run would not be reported as a leak')
})

test('the probe source has no unescaped newline inside its template literal', () => {
  // The exact slip: '\n' written into the template literal becomes a real
  // newline in the injected source, which is an unterminated string.
  const SOAK3 = fs.readFileSync(path.join(__dirname, '..', 'tools', 'video-soak.js'), 'utf8')
  for (const name of ['LISTENER_PROBE', 'SAMPLE_PROBE']) {
    const m = SOAK3.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`\\n'))
    assert.ok(m, 'found ' + name)
    // In the file, an intended newline inside browser JS must be written \\n.
    // A single backslash-n would have been consumed by the template literal.
    const lines = m[1].split('\n')
    for (const line of lines) {
      assert.doesNotMatch(line, /split\('\n/, name + ' has a raw newline in a string literal')
    }
    // And the source must at least parse.
    assert.doesNotThrow(() => new Function('return ' + m[1]), name + ' does not parse')
  }
})

// ── the leak the soak actually found ───────────────────────────────────────

test('the file-drop handlers are not registered by a polling function', () => {
  // They lived at the end of checkConnections(), which runs every thirty
  // seconds on an interval — so the app added one dragover and one drop
  // listener to document twice a minute for as long as it was open.
  //
  // The leak was not only memory. Every drop event runs all of them, so
  // dropping a file after an hour of uptime enqueued it about a hundred and
  // twenty times. The soak named it once its probe reported call sites:
  // "7 x checkConnections :: dragover" after five minutes.
  const from = RENDERER.indexOf('async function checkConnections()')
  assert.ok(from > 0, 'found checkConnections')
  // To the next top-level function.
  const rest = RENDERER.slice(from + 10)
  const to = from + 10 + (rest.search(/\n(async )?function /) >>> 0)
  const body = RENDERER.slice(from, to)
  assert.doesNotMatch(body, /document\.addEventListener/,
    'checkConnections runs on a timer and must not register a global listener')
})

test('the file drop is bound once, behind a guard', () => {
  assert.match(RENDERER, /var _dropBound = false/)
  const fn = RENDERER.slice(RENDERER.indexOf('function _bindFileDrop()'),
                            RENDERER.indexOf('async function checkConnections()'))
  assert.match(fn, /if \(_dropBound\) return/)
  assert.match(fn, /_dropBound = true/)
  // Both halves of the gesture live in the one guarded place.
  assert.match(fn, /addEventListener\('dragover'/)
  assert.match(fn, /addEventListener\('drop'/)
})

test('nothing else registers a document drop listener', () => {
  // Two of these means a dropped file is enqueued twice.
  const globals = [...RENDERER.matchAll(/document\.addEventListener\('(dragover|drop)'/g)]
  assert.strictEqual(globals.length, 2, 'expected exactly one dragover and one drop')
})

test('no function called on an interval registers a global listener', () => {
  // The general shape of what went wrong. Every function named in a setInterval
  // is checked, because a listener added on a timer grows without bound by
  // definition — no amount of care at the call site helps.
  const timed = new Set([...RENDERER.matchAll(/setInterval\(\s*([A-Za-z_$][\w$]*)\s*,/g)].map(m => m[1]))
  assert.ok(timed.size > 0, 'found interval callbacks by name')
  for (const name of timed) {
    const at = RENDERER.indexOf('function ' + name + '(')
    if (at < 0) continue
    const rest = RENDERER.slice(at + 10)
    const end = at + 10 + (rest.search(/\n(async )?function /) >>> 0)
    const body = RENDERER.slice(at, end)
    assert.doesNotMatch(body, /(document|window)\.addEventListener/,
      name + ' runs on an interval and registers a global listener, which grows without bound')
  }
})
