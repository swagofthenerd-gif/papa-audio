'use strict'
// Press Back out of a title and you land where you were — about two times in
// three. The restore ran one animation frame after the navigation, and a
// catalogue page one frame old is a header and some empty shelves: a few
// hundred pixels tall. Assigning scrollTop past the bottom of a short page is
// silently clamped, so "back to 2,400px" became "back to 180px", and by the
// time the shelves filled in the position had already been thrown away.
//
// The restore re-applies itself while the page is still too short to hold the
// position. A live re-test on Movies & TV then found the other half: landing
// on the right number is not staying there. Restored to 1499, the page drifted
// to 1590 and then 2328 as two shelves ABOVE the target finished loading and
// scroll anchoring pushed the position down; `.content { scroll-behavior:
// smooth }` also turns the assignment into an animation, so the value read
// back is not the one asked for.
//
// So the restore now holds the target for the whole retry window, suspending
// anchoring and smoothing while it does, and ends early only on a real user
// scroll — content moving underneath is not the viewer. This runs the real
// function against a scroller that clamps exactly the way a real one does,
// grows the way shelves do, and drifts the way anchoring does.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extractFn (source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let depth = 0
  for (let j = source.indexOf('{', source.indexOf('(', start)); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  throw new Error('unbalanced braces in ' + name)
}

function extractVar (source, name) {
  const m = new RegExp('^var ' + name + '\\b[^\\n]*', 'm').exec(source)
  assert.ok(m, name + ' not found')
  return m[0]
}

function load () {
  const s = { console, setTimeout, clearTimeout }
  s.globalThis = s
  vm.createContext(s)
  vm.runInContext([
    extractVar(SRC, '_SCROLL_RESTORE_TRIES'),
    extractVar(SRC, '_SCROLL_RESTORE_MS'),
    extractFn(SRC, '_restoreScrollTop'),
  ].join('\n'), s)
  return s
}

// A scroll container that behaves like one: you may assign whatever you like
// to scrollTop and you get back what actually fits.
function scroller (clientHeight) {
  const el = {
    scrollHeight: clientHeight,
    clientHeight: clientHeight,
    _top: 0,
    style: { scrollBehavior: '', overflowAnchor: '' },
    _listeners: {},
    get scrollTop () { return this._top },
    set scrollTop (v) { this._top = Math.max(0, Math.min(Number(v) || 0, this.scrollHeight - this.clientHeight)) },
    grow (px) { this.scrollHeight += px },
    // A shelf ABOVE the restored position finishing its layout: the page gets
    // taller and Chromium slides the scroll position down by the same amount
    // to keep whatever was anchored on screen.
    growAbove (px) { this.scrollHeight += px; this._top += px },
    addEventListener (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn) },
    removeEventListener (t, fn) {
      const l = this._listeners[t] || []
      const i = l.indexOf(fn)
      if (i > -1) l.splice(i, 1)
    },
    // The viewer's hand: a real input event, then the scroll it causes.
    userScroll (to) {
      for (const fn of (this._listeners.wheel || []).slice()) fn({ type: 'wheel' })
      this.scrollTop = to
    },
    listenerCount () {
      return Object.keys(this._listeners).reduce((n, k) => n + this._listeners[k].length, 0)
    },
  }
  return el
}

// A scheduler the test pumps by hand, so "later" is a step in the test rather
// than a wait.
function pump () {
  const q = []
  const later = fn => q.push(fn)
  later.run = function (n) {
    for (let i = 0; i < (n || 1); i++) {
      const fn = q.shift()
      if (!fn) return false
      fn()
    }
    return true
  }
  later.size = () => q.length
  return later
}

test('a page that is still too short is retried until it can hold the position', () => {
  const s = load()
  const el = scroller(800)       // one viewport, nothing loaded yet
  el.scrollHeight = 1000
  const later = pump()
  s._restoreScrollTop(el, 2400, later)
  assert.strictEqual(el.scrollTop, 200, 'the first attempt is clamped — this is the whole bug')
  assert.strictEqual(later.size(), 1, 'so it did not give up')

  el.grow(1200)                  // the first shelves arrive
  later.run()
  assert.strictEqual(el.scrollTop, 1400, 'still short, still clamped')

  el.grow(4000)                  // the rest of them
  later.run()
  assert.strictEqual(el.scrollTop, 2400, 'and now it lands where the viewer left it')
  assert.strictEqual(later.size(), 1,
    'and keeps holding it — landing once is what the drift defeated')
  while (later.run()) { /* run the window out */ }
  assert.strictEqual(el.scrollTop, 2400)
  assert.strictEqual(later.size(), 0, 'the window is bounded, not a session-long timer')
})

test('a shelf loading ABOVE the target does not carry the page away', () => {
  // The live failure, reproduced: the restore succeeds, then two rows above it
  // finish and anchoring pushes the position down twice.
  const s = load()
  const el = scroller(800)
  el.scrollHeight = 9000
  const later = pump()
  s._restoreScrollTop(el, 1499, later)
  assert.strictEqual(el.scrollTop, 1499)

  el.growAbove(91)               // 1499 -> 1590, as measured
  later.run()
  assert.strictEqual(el.scrollTop, 1499, 'the drift is corrected, not accepted')

  el.growAbove(738)              // 1590 -> 2328, as measured
  later.run()
  assert.strictEqual(el.scrollTop, 1499)

  while (later.run()) { /* the rest of the window */ }
  assert.strictEqual(el.scrollTop, 1499, 'and it is still there when the window closes')
})

test('smooth scrolling and anchoring are suspended only for the restore', () => {
  const s = load()
  const el = scroller(800)
  el.scrollHeight = 9000
  el.style.scrollBehavior = ''   // inherited from `.content { scroll-behavior:smooth }`
  const later = pump()
  s._restoreScrollTop(el, 2400, later)
  assert.strictEqual(el.style.scrollBehavior, 'auto',
    'a smooth assignment animates, so scrollTop reads back wrong mid-flight')
  assert.strictEqual(el.style.overflowAnchor, 'none')
  while (later.run()) { /* run the window out */ }
  assert.strictEqual(el.style.scrollBehavior, '', 'and smooth scrolling comes back for the viewer')
  assert.strictEqual(el.style.overflowAnchor, '')
  assert.strictEqual(el.listenerCount(), 0, 'no listener left on the page')
})

test('a page that is already tall enough lands at once and is held, briefly', () => {
  const s = load()
  const el = scroller(800)
  el.scrollHeight = 9000
  const later = pump()
  s._restoreScrollTop(el, 2400, later)
  assert.strictEqual(el.scrollTop, 2400, 'right on the first frame')
  let runs = 0
  while (later.run()) runs++
  assert.strictEqual(runs, s._SCROLL_RESTORE_TRIES - 1,
    'held for the window and no longer — 2 s, not the session')
  assert.strictEqual(el.scrollTop, 2400)
})

test('the viewer scrolling wins — the page does not yank itself back', () => {
  const s = load()
  const el = scroller(800)
  el.scrollHeight = 1000
  const later = pump()
  s._restoreScrollTop(el, 2400, later)
  assert.strictEqual(el.scrollTop, 200)

  // They start reading from the top while the shelves fill in.
  el.grow(6000)
  el.userScroll(0)
  later.run()
  assert.strictEqual(el.scrollTop, 0, 'a page that moves under a moving finger is worse than one that forgot')
  assert.strictEqual(later.size(), 0)
  assert.strictEqual(el.listenerCount(), 0, 'and it tidies up after itself')
})

test('a page that never grows gives up instead of retrying for ever', () => {
  const s = load()
  const el = scroller(800)
  el.scrollHeight = 1000
  const later = pump()
  s._restoreScrollTop(el, 9999, later)
  let runs = 0
  while (later.run()) runs++
  assert.ok(runs < 40, 'it must terminate')
  assert.strictEqual(runs, s._SCROLL_RESTORE_TRIES - 1,
    'exactly the cap, so a dead shelf cannot spin a timer for the session')
  assert.strictEqual(later.size(), 0)
})

test('a page with nothing to restore does nothing at all', () => {
  const s = load()
  const el = scroller(800)
  el.scrollHeight = 9000
  const later = pump()
  s._restoreScrollTop(el, 0, later)
  assert.strictEqual(el.scrollTop, 0)
  assert.strictEqual(later.size(), 0)
  // And a missing container is not an error — navigate() runs before the
  // renderer has necessarily built one.
  assert.doesNotThrow(() => s._restoreScrollTop(null, 2400, later))
})

test('navigate() routes Back through the retrying restore, not a bare assignment', () => {
  // The one-line version is what shipped, and it is exactly what the retries
  // exist to replace.
  assert.match(SRC, /requestAnimationFrame\(\(\) => \{ _restoreScrollTop\(contentEl, savedScroll\) \}\)/)
})
