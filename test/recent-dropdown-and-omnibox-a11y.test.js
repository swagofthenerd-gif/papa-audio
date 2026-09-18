'use strict'
// L10 + L13 — two keyboard holes in the player bar and the Omnibox.
//
// L10: the recently-played dropdown (#btn-recent) was mouse-only. Its rows
// carried tabindex="-1" with nothing that could ever focus them, Escape did
// not close the menu, and closing it dropped the keyboard on <body>. The
// elapsed/remaining/total readout (#time-cur) was a <span> with a click
// handler — a three-way control with no tab stop, no role and no name, so the
// digits alone never said which of the three you were looking at.
//
// L13: the Omnibox input is a role="combobox" over a role="listbox", and
// nothing ever set aria-activedescendant — the arrow keys moved a highlight a
// screen reader could not see. And #results-filter set `outline:none` with
// only a 1px border tint to replace it, so tabbing into it looked exactly like
// not being in it.
//
// The two dropdown helpers are lifted and run for real; the Omnibox painter is
// checked through the markup it produces and the attribute it writes.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8')
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8')
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

function liftFn(name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > -1, name + ' must still exist in renderer.js')
  return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

// ── L10: the recently-played menu ────────────────────────────────────────────

function menu(count) {
  const items = []
  for (let i = 0; i < count; i++) {
    const it = {
      i, attrs: { tabindex: i === 0 ? '0' : '-1', role: 'menuitem' },
      style: {}, focused: 0, clicked: 0, dataset: { ri: String(i) },
      setAttribute(a, v) { it.attrs[a] = String(v) },
      getAttribute(a) { return a in it.attrs ? it.attrs[a] : null },
      focus() { it.focused++ },
      click() { it.clicked++ },
    }
    items.push(it)
  }
  const btn = {
    attrs: { 'aria-expanded': 'true' }, focused: 0,
    setAttribute(a, v) { btn.attrs[a] = String(v) },
    getAttribute(a) { return a in btn.attrs ? btn.attrs[a] : null },
    focus() { btn.focused++ },
  }
  const parent = { removed: 0, removeChild() { parent.removed++; dd.parentNode = null } }
  const dd = { parentNode: parent, querySelectorAll: () => items }

  const ctx = {
    console, items, dd, btn,
    document: { getElementById: (id) => (id === 'recent-dropdown' ? (dd.parentNode ? dd : null) : id === 'btn-recent' ? btn : null) },
  }
  vm.createContext(ctx)
  vm.runInContext(liftFn('_closeRecentDropdown') + '\n' + liftFn('_recentDropdownKey'), ctx)

  return {
    items, btn, parent, dd, ctx,
    press(key, fromIndex) {
      const e = {
        key, target: fromIndex == null ? dd : items[fromIndex],
        defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.propagationStopped = true },
      }
      ctx.__e = e
      vm.runInContext('_recentDropdownKey(__e, dd)', ctx)
      return e
    },
  }
}

test('Down moves to the next recent play', () => {
  const m = menu(5)
  m.press('ArrowDown', 0)
  assert.strictEqual(m.items[1].focused, 1, 'the rows were unreachable by keyboard entirely')
  assert.strictEqual(m.items[1].getAttribute('tabindex'), '0')
  assert.strictEqual(m.items[0].getAttribute('tabindex'), '-1')
})

test('Up from the first wraps to the last, and Home/End jump', () => {
  const a = menu(5); a.press('ArrowUp', 0)
  assert.strictEqual(a.items[4].focused, 1)
  const b = menu(5); b.press('End', 0)
  assert.strictEqual(b.items[4].focused, 1)
  const c = menu(5); c.press('Home', 3)
  assert.strictEqual(c.items[0].focused, 1)
})

test('Enter and Space play the row the keyboard is on', () => {
  for (const key of ['Enter', ' ']) {
    const m = menu(5)
    m.press(key, 2)
    assert.strictEqual(m.items[2].clicked, 1, key + ' must activate the focused row')
  }
})

test('Escape closes the menu and hands focus back to the button', () => {
  const m = menu(5)
  const e = m.press('Escape', 1)
  assert.strictEqual(m.parent.removed, 1, 'Escape did nothing at all before')
  assert.strictEqual(m.btn.focused, 1,
    'closing without restoring focus drops the keyboard on <body> with no way back')
  assert.strictEqual(m.btn.getAttribute('aria-expanded'), 'false')
  assert.ok(e.defaultPrevented && e.propagationStopped)
})

test('Escape works even when focus is on the menu itself, not a row', () => {
  const m = menu(0)
  m.press('Escape', null)
  assert.strictEqual(m.parent.removed, 1)
  assert.strictEqual(m.btn.focused, 1)
})

test('a key the menu does not own is left for the page', () => {
  const m = menu(5)
  const e = m.press('a', 0)
  assert.ok(!e.defaultPrevented)
  assert.strictEqual(m.items.reduce((n, i) => n + i.focused, 0), 0)
})

test('closing it any other way does not steal focus', () => {
  const m = menu(5)
  vm.runInContext('_closeRecentDropdown()', m.ctx)
  assert.strictEqual(m.parent.removed, 1)
  assert.strictEqual(m.btn.focused, 0, 'a click elsewhere must not yank focus back to the bar')
  assert.strictEqual(m.btn.getAttribute('aria-expanded'), 'false')
})

test('the menu it builds is announced as one, with reachable rows', () => {
  assert.match(src, /dd\.setAttribute\('role', 'menu'\)/)
  assert.match(src, /role="menuitem" tabindex="' \+ \(i === 0 \? '0' : '-1'\)/,
    'the first row must be the tab stop and the rest reachable by arrow')
  assert.match(src, /recentBtn\.setAttribute\('aria-haspopup', 'menu'\)/)
})

// ── L10: the time readout ────────────────────────────────────────────────────

test('the elapsed/remaining/total readout is a button, not a span', () => {
  const m = HTML.match(/<(\w+)[^>]*id="time-cur"[^>]*>/)
  assert.ok(m, '#time-cur must still exist')
  assert.strictEqual(m[1], 'button',
    'it cycles three modes on click; a <span> is not a tab stop and has no role')
  assert.match(m[0], /aria-label="/, 'and the digits alone never said which mode you are in')
})

test('its name says both what is shown and what the next press will show', () => {
  const ctx = { console, labels: [], el: { setAttribute(a, v) { ctx.labels.push(v) } } }
  ctx.document = { getElementById: () => ctx.el }
  vm.createContext(ctx)
  const at = src.indexOf('function _labelTimeDisplay() {')
  assert.ok(at > -1, '_labelTimeDisplay must still exist')
  const end = src.indexOf('\n    }', at)
  vm.runInContext('var timeDisplay = "elapsed"\n' + src.slice(at, end + 6), ctx)
  for (const mode of ['elapsed', 'remaining', 'total']) {
    ctx.__m = mode
    vm.runInContext('timeDisplay = __m; _labelTimeDisplay()', ctx)
  }
  assert.strictEqual(ctx.labels.length, 3)
  assert.match(ctx.labels[0], /Time elapsed\. Activate to show time remaining\./)
  assert.match(ctx.labels[1], /Time remaining\. Activate to show total album duration\./)
  assert.match(ctx.labels[2], /Total album duration\. Activate to show time elapsed\./)
  assert.strictEqual(new Set(ctx.labels).size, 3, 'each mode must announce differently')
})

test('cycling the mode re-labels it', () => {
  const at = src.indexOf('function _cycleTimeDisplay() {')
  const body = src.slice(at, src.indexOf('\n    }', at))
  assert.match(body, /_labelTimeDisplay\(\)/,
    'a name that never updates is worse than no name')
})

test('and it still looks like a label and can be aimed at', () => {
  const re = /\.time-label-btn\s*\{([^}]*)\}/
  const m = CSS.match(re)
  assert.ok(m, '.time-label-btn must style the button back into a label')
  assert.match(m[1], /border:\s*none/)
  assert.match(m[1], /background:\s*none/)
  assert.match(m[1], /font-size:\s*10px/, 'same size as the label it replaced')
  const target = CSS.match(/\.time-label-btn::after\s*\{([^}]*)\}/)
  assert.ok(target, 'a 10px readout needs a 24px target')
  assert.match(target[1], /height:\s*24px/)
  assert.ok(/\.time-label-btn:focus-visible\s*\{[^}]*outline:/.test(CSS),
    'a tab stop with no focus ring is a tab stop you cannot find')
})

// ── L13: the Omnibox ─────────────────────────────────────────────────────────

test('every Omnibox row has an id the combobox can point at', () => {
  assert.match(src, /id="cmd-item-' \+ idx \+ '"/,
    'aria-activedescendant needs a real id on each option')
  assert.match(src, /aria-selected="true"/)
})

test('the input points at the highlighted row, and stops when there is none', () => {
  const at = src.indexOf("c.innerHTML = html")
  const block = src.slice(at, at + 700)
  assert.match(block, /inp\.setAttribute\('aria-activedescendant', 'cmd-item-' \+ _cpIdx\)/,
    'the arrow keys moved a highlight assistive tech could not see')
  assert.match(block, /inp\.removeAttribute\('aria-activedescendant'\)/,
    'a dangling id pointing at nothing is worse than no id')
  assert.match(block, /rows\.length && c\.querySelector\('#cmd-item-' \+ _cpIdx\)/,
    'it must only point at a row that is actually on the page')
})

test('the mouse keeps it in step too', () => {
  const at = src.indexOf("results.querySelectorAll('.cmd-item').forEach")
  const block = src.slice(at - 200, at + 500)
  assert.match(block, /aria-activedescendant', 'cmd-item-' \+ i/,
    'hovering moves the highlight without a repaint, so it must set it itself')
})

test('the results filter shows where the keyboard is', () => {
  const base = CSS.match(/\.results-filter\s*\{([^}]*)\}/)
  assert.ok(base, '.results-filter must still exist')
  assert.match(base[1], /outline:\s*none/,
    'if it stopped suppressing the native ring, this test is measuring nothing')
  const ring = CSS.match(/\.results-filter:focus-visible\s*\{([^}]*)\}/)
  assert.ok(ring, 'suppressing the native ring without replacing it is the defect')
  assert.match(ring[1], /outline:\s*2px solid var\(--accent\)/)
  assert.match(ring[1], /outline-offset/)
})
