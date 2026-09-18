'use strict'
// The Movies & TV tab strips called themselves role="tablist" and then ignored
// every key a tablist is supposed to answer (audit N13).
//
// A screen reader announces "Anime, tab, 4 of 8" and then Left and Right do
// nothing, Home and End do nothing, and — because every tab was its own Tab
// stop — getting past the strip took eight presses of Tab.
//
// Both halves are lifted from the shipped renderer: the pure index arithmetic,
// and the container keydown handler driven against a fake strip of tabs. A
// tablist that stops moving, or stops being a single Tab stop, goes red.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const RENDERER = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')

function liftFn(name, args) {
  const open = RENDERER.indexOf('function ' + name + '(')
  assert.ok(open > -1, name + ' must still exist in renderer.js')
  let depth = 0
  let i = RENDERER.indexOf('{', open)
  const start = i
  do {
    if (RENDERER[i] === '{') depth++
    else if (RENDERER[i] === '}') depth--
    i++
  } while (depth > 0 && i < RENDERER.length)
  // eslint-disable-next-line no-new-func
  return new Function(...args, RENDERER.slice(start + 1, i - 1))
}

const nextIndex = liftFn('_tablistNextIndex', ['key', 'count', 'index'])
const bindTablist = liftFn('_bindTablist', ['Array', '_tablistNextIndex', 'list'])

test('Right and Left step, and the strip is a ring', () => {
  assert.strictEqual(nextIndex('ArrowRight', 8, 0), 1)
  assert.strictEqual(nextIndex('ArrowRight', 8, 7), 0, 'the last tab wraps to the first')
  assert.strictEqual(nextIndex('ArrowLeft', 8, 3), 2)
  assert.strictEqual(nextIndex('ArrowLeft', 8, 0), 7, 'the first tab wraps to the last')
})

test('Home and End reach the ends', () => {
  assert.strictEqual(nextIndex('Home', 8, 5), 0)
  assert.strictEqual(nextIndex('End', 8, 5), 7)
})

test('keys the strip does not own are left alone', () => {
  for (const k of ['Enter', ' ', 'a', 'Tab', 'Escape', 'PageDown']) {
    assert.strictEqual(nextIndex(k, 8, 2), null, k + ' must not be swallowed')
  }
})

test('an empty strip answers nothing', () => {
  assert.strictEqual(nextIndex('ArrowRight', 0, 0), null)
})

// ── The DOM half ──────────────────────────────────────────────────────────────

// A strip of role="tab" buttons and the container they live in.
function strip(labels, activeIndex = 0) {
  const tabs = labels.map((label, i) => ({
    label,
    role: 'tab',
    attrs: { tabindex: i === activeIndex ? '0' : '-1', 'aria-selected': String(i === activeIndex) },
    focused: 0,
    clicked: 0,
    focus() { this.focused++ },
    click() { this.clicked++ },
    setAttribute(a, v) { this.attrs[a] = String(v) },
    getAttribute(a) { return a in this.attrs ? this.attrs[a] : null },
  }))
  let handler = null
  const list = {
    dataset: {},
    tabs,
    querySelectorAll(sel) {
      assert.strictEqual(sel, '[role="tab"]', 'the binder must find tabs by role')
      return tabs
    },
    addEventListener(type, fn) { assert.strictEqual(type, 'keydown'); handler = fn },
    press(key, target, extra = {}) {
      // stopPropagation is real DOM API the binder calls (F2: the document's
      // card-focus handler must never see a tablist arrow) — the fake needs it.
      const e = { key, target, prevented: false, stopped: false,
        preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...extra }
      handler(e)
      return e
    },
  }
  bindTablist(Array, nextIndex, list)
  assert.ok(handler, 'the binder must attach a keydown handler to the container')
  return list
}

const LABELS = ['All', 'Movies', 'TV', 'Anime', 'Browse', 'Diary', 'My List', 'On device']

test('Right moves focus AND chooses the tab', () => {
  const list = strip(LABELS, 0)
  const e = list.press('ArrowRight', list.tabs[0])
  assert.strictEqual(e.prevented, true, 'the page must not also scroll')
  assert.strictEqual(list.tabs[1].focused, 1, 'focus lands on the next tab')
  assert.strictEqual(list.tabs[1].clicked, 1,
    'and it is selected — arrows that only move focus need a second key press')
})

test('End jumps to On device, Home back to All', () => {
  const list = strip(LABELS, 0)
  list.press('End', list.tabs[0])
  assert.strictEqual(list.tabs[7].clicked, 1)
  list.press('Home', list.tabs[7])
  assert.strictEqual(list.tabs[0].clicked, 1)
})

test('exactly one tab is ever a Tab stop', () => {
  const list = strip(LABELS, 0)
  const stops = () => list.tabs.filter(t => t.getAttribute('tabindex') === '0')
  assert.strictEqual(stops().length, 1, 'to begin with')
  list.press('ArrowRight', list.tabs[0])
  assert.strictEqual(stops().length, 1, 'after moving')
  assert.strictEqual(list.tabs[1].getAttribute('tabindex'), '0', 'and it is the tab in hand')
  list.press('End', list.tabs[1])
  assert.strictEqual(stops().length, 1)
  assert.strictEqual(list.tabs[7].getAttribute('tabindex'), '0')
})

test('Enter, Space and the app-wide chords pass straight through', () => {
  const list = strip(LABELS, 2)
  for (const e of [list.press('Enter', list.tabs[2]),
    list.press(' ', list.tabs[2]),
    list.press('ArrowRight', list.tabs[2], { ctrlKey: true }),
    list.press('ArrowRight', list.tabs[2], { metaKey: true })]) {
    assert.strictEqual(e.prevented, false)
  }
  assert.strictEqual(list.tabs.reduce((n, t) => n + t.clicked, 0), 0)
})

test('an arrow from a non-tab inside the strip enters it at the first tab', () => {
  const list = strip(LABELS, 0)
  // The handler is bound to the .vtabs container only, so the search box next
  // to it never reaches here. What can reach here is a wrapper element inside
  // the strip; treating that as "enter the strip" is deliberate, and it must
  // not silently do nothing.
  const e = list.press('ArrowRight', { role: 'presentation' })
  assert.strictEqual(e.prevented, true)
  assert.strictEqual(list.tabs[1].clicked, 1)
})

// ── The markup ────────────────────────────────────────────────────────────────

test('the shipped tab strips carry the roving tabindex and are bound', () => {
  const head = RENDERER.slice(RENDERER.indexOf('function _vHeadHtml()'),
    RENDERER.indexOf('function _bindVideoHead()'))
  assert.match(head, /role="tab" tabindex="' \+ \(t\.key === _videoTab \? '0' : '-1'\)/,
    'the Movies & TV tabs must ship a roving tabindex')
  assert.match(head, /role="tablist" aria-label=/, 'and the strip must name itself')
  assert.match(RENDERER, /_bindTablist\(document\.querySelector\('\.vtabs'\)\)/,
    'the Movies & TV strip must be bound')
  assert.match(RENDERER, /_bindTablist\(document\.querySelector\('\.vcal-viewtoggle'\)\)/,
    'and so must the calendar view toggle')
})

test('choosing a tab moves the Tab stop with it', () => {
  const bind = RENDERER.slice(RENDERER.indexOf('function _bindVideoHead()'),
    RENDERER.indexOf('function _tablistNextIndex('))
  assert.match(bind, /x\.setAttribute\('tabindex', on \? '0' : '-1'\)/,
    'a click must leave exactly one Tab stop behind, like an arrow press does')
})
