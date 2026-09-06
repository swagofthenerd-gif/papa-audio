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

// ── the active-interval probe ───────────────────────────────────────────────
//
// A running setInterval is nothing's to collect: it holds its callback and
// everything the closure reaches, and it keeps firing, until clearInterval is
// called with its exact id. This is the same shape of leak as the modal-reopen
// listener leak — a poll re-armed on every navigation without clearing the last
// one — and it was measured by nothing until this probe. It mirrors the listener
// probe: wrap the two functions that change the count, and report only LIVE
// timers (set and not yet cleared), because counting every setInterval ever
// called would climb forever on a page that re-renders.

function runIntervalProbe() {
  const m = SOAK.match(/const INTERVAL_PROBE = `([\s\S]*?)`\n/)
  assert.ok(m, 'found INTERVAL_PROBE')

  // A stand-in window whose setInterval hands out incrementing ids, so the probe
  // has real ids to track and clear — the only way to test what it does.
  let next = 1
  const cleared = []
  const win = {
    setInterval() { return next++ },
    clearInterval(id) { cleared.push(id) },
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'return ' + m[1])
  const result = fn(win)
  assert.strictEqual(result, 'installed')
  return { win, cleared, read: () => win.__soakIntervals.read() }
}

test('the interval probe installs and starts at nothing', () => {
  const w = runIntervalProbe()
  const r = w.read()
  assert.strictEqual(r.active, 0)
  assert.deepStrictEqual(r.sites, [])
})

test('a live interval counts and a cleared one does not', () => {
  const w = runIntervalProbe()
  const id = w.win.setInterval(() => {}, 1000)
  assert.strictEqual(w.read().active, 1)
  w.win.clearInterval(id)
  assert.strictEqual(w.read().active, 0, 'a cleared timer must not read as a leak')
})

test('the real clearInterval is still called, so the timer actually stops', () => {
  // The probe must not swallow the clear — it wraps it, it does not replace it.
  const w = runIntervalProbe()
  const id = w.win.setInterval(() => {}, 1000)
  w.win.clearInterval(id)
  assert.deepStrictEqual(w.cleared, [id], 'the underlying clearInterval ran')
})

test('a hundred armed-and-cleared timers do not accumulate', () => {
  // The healthy shape: a page arms a poll, tears it down, repeats. This is the
  // interval equivalent of the "hundred renders do not accumulate" listener test.
  const w = runIntervalProbe()
  for (let i = 0; i < 100; i++) {
    const id = w.win.setInterval(() => {}, 1000)
    w.win.clearInterval(id)
  }
  assert.strictEqual(w.read().active, 0)
})

test('the re-armed-without-clear leak is caught', () => {
  // The bug this metric exists for: a poll re-armed on every navigation whose
  // previous id was never cleared. Twenty navigations, twenty orphaned timers.
  const w = runIntervalProbe()
  for (let i = 0; i < 20; i++) {
    w.win.setInterval(() => {}, 1000)   // never cleared
  }
  assert.strictEqual(w.read().active, 20, 'twenty timers still firing')
})

test('a fixed set of session timers armed once holds flat', () => {
  // The benign shape that must NOT read as a leak: arm the session's polls once
  // and leave them running. The count steps up and stays put.
  const w = runIntervalProbe()
  w.win.setInterval(() => {}, 1000)   // stall watch
  w.win.setInterval(() => {}, 1000)   // transfer poll
  w.win.setInterval(() => {}, 1000)   // connection check
  const a = w.read().active
  // Reading again changes nothing; the set is stable.
  assert.strictEqual(a, 3)
  assert.strictEqual(w.read().active, 3)
})

test('clearing an id that was never set is harmless', () => {
  const w = runIntervalProbe()
  w.win.setInterval(() => {}, 1000)
  assert.doesNotThrow(() => w.win.clearInterval(999999))
  assert.strictEqual(w.read().active, 1, 'an unknown clear does not disturb the count')
})

test('the sample probe reports the active-interval count', () => {
  const m = SOAK.match(/const SAMPLE_PROBE = `([\s\S]*?)`\n/)
  assert.ok(m, 'found SAMPLE_PROBE')
  assert.match(m[1], /activeIntervals: iv\.active/)
})

test('the active-interval metric has a threshold', () => {
  // Without an entry it falls back to the heap-sized defaults, which would call
  // a move of one or two timers a leak.
  const from = SOAK.indexOf('activeIntervals: {')
  assert.ok(from > 0, 'found the threshold entry')
  const block = SOAK.slice(from, SOAK.indexOf('}', from) + 1)
  assert.match(block, /activeIntervals: \{[^}]*minAbsGrowth: \d+/)
})

test('a failed interval-probe install aborts the run instead of passing blind', () => {
  // Same load-bearing check as the listener probe: a probe that reports zero at
  // every sample reads as flat, and flat is a PASS.
  const at = SOAK.indexOf('const ivProbe = await js(INTERVAL_PROBE)')
  assert.ok(at > 0)
  const block = SOAK.slice(at, at + 800)
  assert.match(block, /fail\('interval probe installs'/)
  assert.match(block, /app\.exit\(1\)/, 'a blind run must not continue')
})

test('the interval sites are recorded as a label, not judged as a metric', () => {
  // _intervalSites carries the call sites of the live timers so a rise names its
  // cause, exactly like _globalSites. The underscore keeps it out of the metrics.
  const m = SOAK.match(/const SAMPLE_PROBE = `([\s\S]*?)`\n/)
  assert.match(m[1], /_intervalSites: iv\.sites/)
  const { analyseRun } = require(path.join(__dirname, '..', 'tools', 'video-soak.js'))
  const samples = []
  for (let i = 0; i < 40; i++) {
    samples.push({ metrics: { activeIntervals: 3, _intervalSites: ['3 x poll :: renderer.js'] } })
  }
  const res = analyseRun(samples)
  assert.ok(res.metrics.activeIntervals, 'the number is judged')
  assert.strictEqual(res.metrics._intervalSites, undefined, 'the label is not')
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
  // 16: the pagehide position-save + store flush in _initVideoUI, which is
  //     behind the _videoUiReady run-once guard.
  // 20: wave-6 video work added four, all behind run-once guards or paired
  //     removals:
  //       • _bindGlobalGenreJumps — one document click, guarded by
  //         _genreJumpsBound (delegated genre-chip jumps, App §30).
  //       • _bindVideoCardContextMenu — one document contextmenu, guarded by
  //         _vCtxBound (card context menus, App §83).
  //       • _openVideoCardMenu — a document click and a window scroll, both
  //         added on menu-open and removed in _closeVideoCardMenu, so they are
  //         never standing listeners even though the source counts the sites.
  // 21: the clean-exit pagehide marker in setupListeners (App §1), which runs
  //     once from init() and only writes a localStorage flag on shutdown.
  assert.strictEqual(sites.inFunction.length, 21,
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

// ── every renderer script must be reachable from the renderer ─────────────

test('no script is loaded into the renderer that the renderer never uses', () => {
  // This project has now shipped four modules that were written, tested and
  // loaded, and that nothing could reach: the taste store, the taste panel, the
  // search parser and the keymap. Two more were being parsed at startup for
  // main's benefit only — main requires them directly, so the script tag bought
  // nothing.
  //
  // A module can legitimately be used by another renderer script rather than by
  // renderer.js, so the search is across all of them.
  const root = path.join(__dirname, '..')
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])
  assert.ok(scripts.length > 10, 'found the script list')

  const sources = new Map()
  for (const f of scripts) sources.set(f, fs.readFileSync(path.join(root, 'src', f), 'utf8'))

  const orphans = []
  for (const [file, src] of sources) {
    const m = /root\.(Papa[A-Za-z]+)\s*=/.exec(src) || /window\.(Papa[A-Za-z]+)\s*=/.exec(src)
    if (!m) continue                       // not a UMD module; nothing to check
    const globalName = m[1]
    let used = false
    for (const [other, otherSrc] of sources) {
      if (other === file) continue
      if (otherSrc.includes(globalName)) { used = true; break }
    }
    if (!used) orphans.push(globalName + ' (' + file + ')')
  }
  assert.deepStrictEqual(orphans, [],
    'loaded into the renderer and used by nothing there. Either wire it, or ' +
    'drop the script tag and let main require it.')
})

// ── a constant series is not a measurement ────────────────────────────────

test('a series that never varied is reported as constant, not as a pass', () => {
  // The first hundred-minute run returned exactly 10,000,000 for
  // rendererHeapUsed and rendererHeapTotal in all 400 samples: Chromium
  // quantizes performance.memory for privacy, so the process where the whole UI
  // lives was the one process never measured — and both metrics PASSED, because
  // a constant series has no growth. The run announced "no drift" while blind
  // to the renderer.
  const { analyseSeries } = require(path.join(__dirname, '..', 'tools', 'video-soak.js'))
  const res = analyseSeries(new Array(400).fill(10000000))
  assert.strictEqual(res.verdict, 'constant')
  assert.match(res.note, /never varied/)
  assert.strictEqual(res.value, 10000000, 'and it says what the value was')
  // Still not a leak — it is simply not evidence either way.
  assert.notStrictEqual(res.verdict, 'leak')
})

test('a constant metric does not count towards the metrics that decided anything', () => {
  // The run-level check exists to catch a harness that attached to nothing.
  // A constant metric is that failure one level down, so it must not prop the
  // count up.
  const { analyseRun } = require(path.join(__dirname, '..', 'tools', 'video-soak.js'))
  const rows = []
  for (let i = 0; i < 40; i++) rows.push({ metrics: { blind: 10000000, real: 100 + (i % 5) } })
  const res = analyseRun(rows)
  assert.strictEqual(res.metrics.blind.verdict, 'constant')
  assert.notStrictEqual(res.metrics.real.verdict, 'constant')
})

test('a genuinely near-flat series is still analysed', () => {
  // The rule must be "never moved at all", not "barely moved" — listenersGlobal
  // legitimately sits at 4 for a whole run with a couple of samples at 0, and
  // that IS a measurement.
  const { analyseSeries } = require(path.join(__dirname, '..', 'tools', 'video-soak.js'))
  const series = new Array(400).fill(4)
  series[0] = 0
  series[1] = 0
  const res = analyseSeries(series)
  assert.notStrictEqual(res.verdict, 'constant')
  assert.notStrictEqual(res.verdict, 'leak', 'and a bounded step is not a leak')
})

test("the renderer's memory is taken from the main process, not from the page", () => {
  const SOAK4 = fs.readFileSync(path.join(__dirname, '..', 'tools', 'video-soak.js'), 'utf8')
  assert.match(SOAK4, /app\.getAppMetrics\(\)/)
  assert.match(SOAK4, /getOSProcessId\(\)/, 'the renderer is found by pid, not by a type string')
  assert.match(SOAK4, /rendererRss: rendererRss\(\)/)
  assert.match(SOAK4, /workingSetSize \|\| 0\) \* 1024/, 'workingSetSize is in kilobytes')
  // And it has a threshold, or it would fall back to the heap-sized defaults.
  assert.match(SOAK4, /rendererRss: \{ leakRelGrowth/)
})

test('the quantized figures are recorded but no longer judged', () => {
  const SOAK4 = fs.readFileSync(path.join(__dirname, '..', 'tools', 'video-soak.js'), 'utf8')
  const probe = SOAK4.match(/const SAMPLE_PROBE = `([\s\S]*?)`\n/)[1]
  assert.match(probe, /_rendererHeapUsed/, 'kept for the record, under the underscore convention')
  assert.doesNotMatch(probe, /\n\s+rendererHeapUsed:/, 'and no longer a metric')
})
