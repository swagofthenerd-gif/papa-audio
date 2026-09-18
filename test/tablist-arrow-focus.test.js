'use strict'
// Pressing Left/Right on the Movies & TV tab strip jumped focus onto the
// first poster instead of moving along the tabs.
//
// Two handlers see the same keydown. _bindTablist (on the strip) moves the
// roving index and calls preventDefault — but not stopPropagation, so the
// event keeps bubbling to the document handler, which calls _moveCardFocus.
// That function's "nothing focused yet" branch only asks whether the active
// element is a .vcard; a tab is not, so it focuses cards[0] and the tab the
// user just moved to loses focus in the same tick.
//
// Both real functions are lifted and wired to a miniature DOM with real
// bubbling, so the test fails if either guard is removed.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function extractFn (source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  let depth = 0
  for (let j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') {
      depth--
      if (!depth) return source.slice(start, j + 1)
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

// ── A DOM small enough to read and real enough to bubble ────────────────────
let doc = null

class El {
  constructor (tag, attrs) {
    this.tagName = tag
    this.attrs = Object.assign({}, attrs)
    this.dataset = {}
    this.children = []
    this.parentNode = null
    this.listeners = {}
    this.classList = {
      _o: this,
      contains: function (c) { return String(this._o.attrs.class || '').split(/\s+/).includes(c) },
      add () {}, remove () {}, toggle () {},
    }
    this.clicks = 0
    this.top = 0
  }
  append (...kids) {
    for (const k of kids) { k.parentNode = this; this.children.push(k) }
    return this
  }
  setAttribute (k, v) { this.attrs[k] = String(v) }
  getAttribute (k) { return k in this.attrs ? this.attrs[k] : null }
  addEventListener (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  focus () { doc.activeElement = this }
  click () { this.clicks++ }
  scrollIntoView () {}
  getBoundingClientRect () { return { top: this.top } }
  closest (sel) {
    let n = this
    while (n) { if (n._matches(sel)) return n; n = n.parentNode }
    return null
  }
  _matches (sel) {
    if (sel[0] === '.') return this.classList.contains(sel.slice(1))
    const attr = sel.match(/^\[([^=\]]+)="([^"]*)"\]$/)
    if (attr) return this.attrs[attr[1]] === attr[2]
    return this.tagName === sel
  }
  _walk (out) { for (const k of this.children) { out.push(k); k._walk(out) } return out }
  querySelectorAll (sel) { return this._walk([]).filter(function (n) { return n._matches(sel) }) }
}

function dispatch (target, key) {
  const e = {
    key,
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault () { this.defaultPrevented = true },
    stopPropagation () { this.propagationStopped = true },
  }
  let n = target
  while (n) {
    for (const fn of (n.listeners.keydown || [])) fn(e)
    if (e.propagationStopped) break
    n = n.parentNode
  }
  return e
}

// The document handler in renderer.js does a lot of page-state work before it
// reaches the arrow branch; this stands in for exactly that last line, which
// is the only part implicated here.
function buildPage () {
  const root = new El('body')
  doc = {
    activeElement: null,
    listeners: {},
    addEventListener (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
    querySelectorAll (sel) { return root.querySelectorAll(sel) },
  }
  const strip = new El('div', { role: 'tablist' })
  const tabs = ['movies', 'tv', 'anime'].map(function (name) {
    return new El('button', { role: 'tab', 'data-tab': name, tabindex: '-1' })
  })
  tabs[0].setAttribute('tabindex', '0')
  strip.append(...tabs)
  const grid = new El('div', { class: 'vgrid' })
  const cards = [0, 1, 2].map(function () { return new El('div', { class: 'vcard' }) })
  grid.append(...cards)
  root.append(strip, grid)
  // Bubbling needs the strip's ancestor chain to end at something that holds
  // the document-level listener, so the body forwards to doc.
  root.addEventListener('keydown', function (e) {
    for (const fn of (doc.listeners.keydown || [])) fn(e)
  })
  return { root, strip, tabs, cards }
}

function lift () {
  const ctx = { document: null, Array }
  vm.createContext(ctx)
  vm.runInContext(extractFn(SRC, '_tablistNextIndex'), ctx)
  vm.runInContext(extractFn(SRC, '_bindTablist'), ctx)
  vm.runInContext(extractFn(SRC, '_moveCardFocus'), ctx)
  return ctx
}

function wire () {
  const page = buildPage()
  const ctx = lift()
  ctx.document = doc
  ctx._bindTablist(page.strip)
  doc.addEventListener('keydown', function (e) {
    if (e.key.startsWith('Arrow')) ctx._moveCardFocus(e)
  })
  return page
}

test('ArrowRight on a tab leaves focus on the next tab, not the first poster', function () {
  const page = wire()
  page.tabs[0].focus()
  dispatch(page.tabs[0], 'ArrowRight')
  assert.strictEqual(doc.activeElement, page.tabs[1],
    'focus must land on the next tab; it landed on ' +
      (doc.activeElement === page.cards[0] ? 'the first poster' : 'something else'))
  assert.strictEqual(page.tabs[1].getAttribute('tabindex'), '0')
  assert.strictEqual(page.tabs[1].clicks, 1, 'the arrow selects as well as moves')
})

test('ArrowLeft wraps to the last tab without entering the grid', function () {
  const page = wire()
  page.tabs[0].focus()
  dispatch(page.tabs[0], 'ArrowLeft')
  assert.strictEqual(doc.activeElement, page.tabs[2])
})

test('a handled tab arrow never reaches the document handler at all', function () {
  // The first of the two guards, tested on its own: once the strip has moved
  // focus the event stops there. Without this, a document handler bound by
  // any other feature would still see a "stray" arrow press on a tab.
  const page = buildPage()
  const ctx = lift()
  ctx.document = doc
  ctx._bindTablist(page.strip)
  let reachedDocument = 0
  doc.addEventListener('keydown', function () { reachedDocument++ })
  page.tabs[0].focus()
  dispatch(page.tabs[0], 'ArrowRight')
  assert.strictEqual(reachedDocument, 0,
    'the strip handled the key; it must not bubble on')
  // An arrow the strip does NOT handle still bubbles, so nothing else breaks.
  dispatch(page.cards[0], 'ArrowRight')
  assert.strictEqual(reachedDocument, 1)
})

test('_moveCardFocus declines any event raised inside a tablist', function () {
  // The document handler must not steal focus even if a strip somewhere
  // forgets to stop the event — this is the second, independent guard.
  const page = wire()
  const ctx = lift()
  ctx.document = doc
  page.tabs[1].focus()
  const e = { key: 'ArrowRight', target: page.tabs[1], preventDefault () {} }
  ctx._moveCardFocus(e)
  assert.strictEqual(doc.activeElement, page.tabs[1])
})

test('arrows still enter and move through the grid from outside a tablist', function () {
  const page = wire()
  const ctx = lift()
  ctx.document = doc
  doc.activeElement = page.root
  ctx._moveCardFocus({ key: 'ArrowRight', target: page.root, preventDefault () {} })
  assert.strictEqual(doc.activeElement, page.cards[0], 'first press enters the grid')
  ctx._moveCardFocus({ key: 'ArrowRight', target: page.cards[0], preventDefault () {} })
  assert.strictEqual(doc.activeElement, page.cards[1], 'next press steps along')
})
