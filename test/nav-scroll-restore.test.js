'use strict'
// Press Back out of a title and you land where you were — about two times in
// three. The restore ran one animation frame after the navigation, and a
// catalogue page one frame old is a header and some empty shelves: a few
// hundred pixels tall. Assigning scrollTop past the bottom of a short page is
// silently clamped, so "back to 2,400px" became "back to 180px", and by the
// time the shelves filled in the position had already been thrown away.
//
// The restore now re-applies itself while the page is still too short to hold
// the position, and stops the moment it sticks. This runs the real function
// against a scroller that clamps exactly the way a real one does and grows the
// way shelves do.
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
    get scrollTop () { return this._top },
    set scrollTop (v) { this._top = Math.max(0, Math.min(Number(v) || 0, this.scrollHeight - this.clientHeight)) },
    grow (px) { this.scrollHeight += px },
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
  assert.strictEqual(later.size(), 0, 'and stops retrying the moment it sticks')
})

test('a page that is already tall enough is restored once and left alone', () => {
  const s = load()
  const el = scroller(800)
  el.scrollHeight = 9000
  const later = pump()
  s._restoreScrollTop(el, 2400, later)
  assert.strictEqual(el.scrollTop, 2400)
  assert.strictEqual(later.size(), 0, 'no timer left running behind a page that is already right')
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
  el.scrollTop = 0
  later.run()
  assert.strictEqual(el.scrollTop, 0, 'a page that moves under a moving finger is worse than one that forgot')
  assert.strictEqual(later.size(), 0)
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
