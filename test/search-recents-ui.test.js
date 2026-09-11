'use strict'
// The shared recents dropdown, driven through a small fake DOM: paint on
// focus, filtered paint while typing, keyboard pick, and the per-row ✕ that
// re-paints in place instead of collapsing the list (the verified bug).
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

const SM = require('../src/search-memory')

// ── Fake DOM, just enough for the widget ─────────────────────────────────────
function makeInput() {
  const l = {}
  return {
    value: '', focused: false,
    addEventListener(ev, fn, cap) { (l[ev] = l[ev] || []).push({ fn, cap: !!cap }) },
    removeEventListener(ev, fn) { l[ev] = (l[ev] || []).filter(x => x.fn !== fn) },
    fire(ev, e) { (l[ev] || []).forEach(x => x.fn(e || {})) },
    focus() { this.focused = true; this.fire('focus') },
    _l: l,
  }
}

// The container parses its own innerHTML into row stubs so querySelectorAll
// and closest() behave like the real thing for the selectors the widget uses.
function makeContainer() {
  const l = {}
  const c = {
    hidden: true, innerHTML: '', _attrs: {},
    classList: { _s: new Set(), add(x) { this._s.add(x) }, remove(x) { this._s.delete(x) }, contains(x) { return this._s.has(x) } },
    setAttribute(k, v) { this._attrs[k] = v },
    addEventListener(ev, fn) { (l[ev] = l[ev] || []).push(fn) },
    removeEventListener(ev, fn) { l[ev] = (l[ev] || []).filter(f => f !== fn) },
    fire(ev, e) { (l[ev] || []).forEach(fn => fn(e)) },
    _rowsFor: '', _rows: [],
    rows() {
      // Memoized per paint: the real DOM keeps the same nodes (and their
      // classes) until innerHTML changes, so the fake must too.
      if (c._rowsFor === c.innerHTML && c._rows.length) return c._rows
      const out = []
      const re = /<div class="recents-row" role="option" data-idx="(\d+)" data-q="([^"]*)">/g
      let m
      while ((m = re.exec(c.innerHTML))) {
        const row = {
          dataset: { idx: m[1], q: m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&') },
          classList: { _s: new Set(), toggle(x, on) { on ? this._s.add(x) : this._s.delete(x) }, contains(x) { return this._s.has(x) } },
          scrollIntoView() {},
        }
        row.closest = sel => (sel === '.recents-row' ? row : null)
        out.push(row)
      }
      c._rowsFor = c.innerHTML; c._rows = out
      return out
    },
    querySelectorAll(sel) { return sel === '.recents-row' ? c.rows() : [] },
    // A click target inside the list: `.recents-del` for the ✕, `.recents-clear`,
    // or a row.
    target(kind, q) {
      if (kind === 'del') return { closest: sel => (sel === '.recents-del' ? { dataset: { q } } : null) }
      if (kind === 'clear') return { closest: sel => (sel === '.recents-clear' ? {} : null) }
      const row = c.rows().find(r => r.dataset.q === q)
      return { closest: sel => (sel === '.recents-row' ? row : null) }
    },
  }
  return c
}

function memIo() {
  const m = new Map()
  return {
    getRaw: k => (m.has(k) ? m.get(k) : null),
    readArray: k => { try { const v = JSON.parse(m.get(k)); return Array.isArray(v) ? v : [] } catch (_) { return [] } },
    write: (k, v) => { m.set(k, JSON.stringify(v)); return true },
    remove: k => { m.delete(k) },
  }
}

function loadWidget() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'search-recents-ui.js'), 'utf8')
  const ctx = { window: { PapaSearchMemory: SM }, console, setTimeout, clearTimeout }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  return ctx.window.PapaSearchRecentsUI
}

function setup(opts) {
  const UI = loadWidget()
  const store = SM.createStore(memIo())
  store.commit('camel mirage', 'music')
  store.commit('king crimson', 'music')
  store.commit('tokyo revengers', 'video')
  const input = makeInput()
  const container = makeContainer()
  const picks = []
  const w = UI.attach(Object.assign({ input, container, surface: 'music', store, onPick: (q, e) => picks.push(q) }, opts || {}))
  return { UI, store, input, container, picks, w }
}

test('focus on an empty box paints this box\'s recents first, then what was searched elsewhere', () => {
  const { input, container, w } = setup()
  input.focus()
  assert.ok(w.isOpen() && !container.hidden && container.classList.contains('open'))
  assert.deepEqual(container.rows().map(r => r.dataset.q), ['king crimson', 'camel mirage', 'tokyo revengers'])
  assert.match(container.innerHTML, /Recent searches/)
  assert.match(container.innerHTML, /Searched elsewhere/)
  assert.match(container.innerHTML, /class="recents-from">Movies &amp; TV</)
  assert.match(container.innerHTML, /Clear this box’s history/)
})

test('a box with text shows nothing unless filterWhileTyping; then it filters', () => {
  const a = setup()
  a.input.value = 'cam'
  a.input.focus()
  assert.ok(!a.w.isOpen(), 'live results own the typing state on the music bar')
  const b = setup({ filterWhileTyping: true })
  b.input.value = 'cam'
  b.input.focus()
  assert.deepEqual(b.container.rows().map(r => r.dataset.q), ['camel mirage'])
  assert.match(b.container.innerHTML, /Matching recent searches/)
})

test('↓ ↓ Enter picks the highlighted row and claims the key; Enter with no highlight is left to the box', () => {
  const { input, container, picks } = setup()
  input.focus()
  const ev = key => ({ key, preventDefault() { this.pd = true }, stopImmediatePropagation() { this.stop = true } })
  let e = ev('Enter'); input.fire('keydown', e)
  assert.ok(!e.stop && picks.length === 0, 'nothing highlighted → the box commits its own text')
  input.fire('keydown', ev('ArrowDown'))
  e = ev('ArrowDown'); input.fire('keydown', e)
  assert.ok(e.stop && container.rows()[1].classList.contains('active'))
  e = ev('Enter'); input.fire('keydown', e)
  assert.ok(e.stop)
  assert.deepEqual(picks, ['camel mirage'])
  assert.equal(input.value, 'camel mirage')
})

test('the per-row ✕ forgets that search and re-paints in place — the list stays open', () => {
  const { input, container, store, w } = setup()
  input.focus()
  container.fire('mousedown', { preventDefault() {}, target: container.target('del', 'king crimson') })
  assert.ok(w.isOpen(), 'the dropdown must NOT collapse')
  assert.deepEqual(container.rows().map(r => r.dataset.q), ['camel mirage', 'tokyo revengers'])
  assert.equal(store.list().length, 2)
})

test('"Clear this box\'s history" empties only this surface; what lives elsewhere stays', () => {
  const { input, container, store } = setup()
  input.focus()
  container.fire('mousedown', { preventDefault() {}, target: container.target('clear') })
  assert.deepEqual(store.list().map(e => e.q), ['tokyo revengers'])
  assert.deepEqual(container.rows().map(r => r.dataset.q), ['tokyo revengers'], 'still offered from elsewhere')
})

test('a row click picks; Escape and blur close; hideAll closes every surface at once', async () => {
  const { UI, input, container, picks, w } = setup()
  input.focus()
  container.fire('mousedown', { preventDefault() {}, target: container.target('row', 'tokyo revengers') })
  assert.deepEqual(picks, ['tokyo revengers'])
  assert.ok(!w.isOpen())
  input.focus()
  input.fire('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} })
  assert.ok(!w.isOpen())
  input.focus()
  input.fire('blur')
  await new Promise(r => setTimeout(r, 200))
  assert.ok(!w.isOpen(), 'closed after the blur grace period')
  input.focus()
  UI.hideAll()
  assert.ok(!w.isOpen())
})

test('re-attaching the same surface retires the stale widget', () => {
  const { UI, store } = setup()
  const first = UI.get('music')
  const input2 = makeInput(); const c2 = makeContainer()
  const second = UI.attach({ input: input2, container: c2, surface: 'music', store, onPick() {} })
  assert.notEqual(first, second)
  assert.equal(UI.get('music'), second)
})

test('with no memory available, attach is a harmless null', () => {
  const UI = loadWidget()
  assert.equal(UI.attach({ input: makeInput(), container: makeContainer(), surface: 'music', store: null, onPick() {} }), null)
})
