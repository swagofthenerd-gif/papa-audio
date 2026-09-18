'use strict'
// L6 — the search-result category strip (All / Songs / Albums / Artists /
// Playlists) declared role="tablist" and role="tab" and then answered to
// nothing but the mouse. Left/Right/Home/End did not move between the
// categories, which is the single thing that role promises a screen-reader or
// keyboard user.
//
// _bindTablist — which already implements exactly that, moving focus AND
// selection together — had only ever been wired to `.vtabs` and
// `.vcal-viewtoggle` on the video side.
//
// The real _bindTablist, _tablistNextIndex and _setActiveTab are lifted and
// driven, so what is tested is the behaviour, not the presence of a call.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftFn(name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > -1, name + ' must still exist in renderer.js')
  return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

const TABS = ['All', 'Songs', 'Albums', 'Artists', 'Playlists']

function tab(name, active) {
  const t = {
    name, cls: new Set(active ? ['search-tab', 'active'] : ['search-tab']),
    attrs: { role: 'tab', 'aria-selected': String(!!active), tabindex: active ? '0' : '-1' },
    dataset: { tab: name }, focused: 0, clicked: 0,
    classList: {
      toggle(c, on) { if (on) t.cls.add(c); else t.cls.delete(c) },
      contains(c) { return t.cls.has(c) },
    },
    setAttribute(a, v) { t.attrs[a] = String(v) },
    getAttribute(a) { return a in t.attrs ? t.attrs[a] : null },
    focus() { t.focused++ },
    click() { t.clicked++ },
  }
  return t
}

// A strip, the lifted keyboard binding on it, and a key-press driver.
function strip() {
  const tabs = TABS.map((n, i) => tab(n, i === 0))
  const list = {
    dataset: {}, handlers: {},
    addEventListener(type, fn) { list.handlers[type] = fn },
    querySelectorAll() { return tabs },
  }
  const ctx = { console, list, tabs }
  vm.createContext(ctx)
  vm.runInContext(
    'document = { querySelectorAll: function () { return tabs } }\n' +
    liftFn('_tablistNextIndex') + '\n' + liftFn('_bindTablist') + '\n' + liftFn('_setActiveTab'),
    ctx
  )
  vm.runInContext('_bindTablist(list)', ctx)

  return {
    tabs,
    press(key, fromIndex, mods) {
      const e = Object.assign({
        key, target: tabs[fromIndex],
        defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.propagationStopped = true },
      }, mods || {})
      ctx.__e = e
      vm.runInContext('list.handlers.keydown(__e)', ctx)
      return e
    },
    choose(t) { ctx.__t = t; vm.runInContext('_setActiveTab(".search-tab", __t)', ctx) },
  }
}

test('Right moves to the next category and selects it', () => {
  const s = strip()
  s.press('ArrowRight', 0)
  assert.strictEqual(s.tabs[1].focused, 1, 'focus must land on Songs')
  assert.strictEqual(s.tabs[1].clicked, 1,
    'and selection moves with it — arrows that only move focus need a second keypress')
})

test('Left from the first wraps to the last', () => {
  const s = strip()
  s.press('ArrowLeft', 0)
  assert.strictEqual(s.tabs[TABS.length - 1].focused, 1)
})

test('Home and End jump to the ends', () => {
  const s = strip()
  s.press('End', 0)
  assert.strictEqual(s.tabs[TABS.length - 1].focused, 1)
  const t = strip()
  t.press('Home', 3)
  assert.strictEqual(t.tabs[0].focused, 1)
})

test('the strip keeps one tab stop as focus moves', () => {
  const s = strip()
  s.press('ArrowRight', 0)
  assert.strictEqual(s.tabs[0].getAttribute('tabindex'), '-1')
  assert.strictEqual(s.tabs[1].getAttribute('tabindex'), '0')
  assert.strictEqual(s.tabs.filter((t) => t.getAttribute('tabindex') === '0').length, 1)
})

test('a plain letter is left alone for the page to handle', () => {
  const s = strip()
  const e = s.press('a', 0)
  assert.ok(!e.defaultPrevented)
  assert.strictEqual(s.tabs.reduce((n, t) => n + t.focused, 0), 0)
})

test('the keypress does not escape to the grid-navigation handler', () => {
  const s = strip()
  const e = s.press('ArrowRight', 0)
  assert.ok(e.defaultPrevented && e.propagationStopped,
    'the document arrow handler would otherwise yank focus into the card grid')
})

test('a modified arrow is somebody else\'s shortcut', () => {
  const s = strip()
  const e = s.press('ArrowRight', 0, { ctrlKey: true })
  assert.ok(!e.defaultPrevented, 'Ctrl+Right belongs to the page, not the strip')
  assert.strictEqual(s.tabs.reduce((n, t) => n + t.focused, 0), 0)
})

test('choosing a category marks it selected AND makes it the tab stop', () => {
  const s = strip()
  s.choose(s.tabs[2])
  assert.strictEqual(s.tabs[2].getAttribute('aria-selected'), 'true')
  assert.strictEqual(s.tabs[2].getAttribute('tabindex'), '0')
  assert.strictEqual(s.tabs[0].getAttribute('aria-selected'), 'false')
  assert.strictEqual(s.tabs[0].getAttribute('tabindex'), '-1')
})

// ── the wiring itself ────────────────────────────────────────────────────────

test('the search strip is bound, not just the two video ones', () => {
  assert.match(src, /_bindTablist\(document\.getElementById\('search-tabs'\)\)/,
    'the binding that makes the arrows work must actually be called for #search-tabs')
})

test('the rendered strip starts with exactly one tab stop', () => {
  const m = src.match(/tabs\.map\(t => `<button class="search-tab[^`]*`\)/)
  assert.ok(m, 'the search-tab template must still exist')
  assert.match(m[0], /tabindex="\$\{t==='All'\?'0':'-1'\}"/,
    'without this, Tab walks through all five categories one at a time')
})
