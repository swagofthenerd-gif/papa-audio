'use strict'
// "Delete watched (3)" on the On Device tab shipped two defects.
//
//   * It wore .mcs-set-refresh — the Settings icon button, pinned to a 30x30
//     square — so a five-word label was squeezed into an icon slot.
//   * One press answered three times. The tab repaints from four places (a
//     download event, the cache-swept event, the automatic sweep and the
//     handler's own re-render); the sweep had no in-flight latch and the
//     binding had no "already bound" guard, so any trigger that arrived while
//     another was live spoke again.
//
// The stylesheet half is read out of the shipped CSS; the behaviour half
// drives the real _renderDeviceTab against a miniature DOM.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.join(__dirname, '..')
const CSS = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const SRC = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8')

function ruleProps (selector) {
  const re = new RegExp('(^|\\}|\\{)\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'gm')
  const found = []
  let m
  while ((m = re.exec(CSS))) found.push(m[2])
  const out = {}
  for (const body of found) {
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
    }
  }
  return out
}

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
      if (!depth) {
        const body = source.slice(start, j + 1)
        return (source.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '') + body
      }
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

// ── The stylesheet half ─────────────────────────────────────────────────────

// The classes the renderer actually puts on the button, read from source so
// the test tracks the markup rather than a copy of it.
function delWatchedClasses () {
  const m = SRC.match(/<button class="([^"]*)" id="vdevice-del-watched"/)
  assert.ok(m, 'the Delete watched button must still be built in renderer.js')
  return m[1].split(/\s+/).filter(Boolean)
}

test('Delete watched is a text button, not a 30px icon square', () => {
  for (const cls of delWatchedClasses()) {
    const props = ruleProps('.' + cls)
    for (const dim of ['width', 'height']) {
      const v = props[dim]
      if (!v) continue
      assert.ok(!/^\d+px$/.test(v),
        '.' + cls + ' pins ' + dim + ' to ' + v + ' — a five-word label cannot fit')
    }
  }
})

test('it still uses a button class the stylesheet knows about', () => {
  const known = delWatchedClasses().filter(function (c) {
    return new RegExp('(^|\\}|\\{)\\s*\\.' + c + '\\s*\\{', 'm').test(CSS)
  })
  assert.ok(known.length, 'none of ' + delWatchedClasses().join(' ') + ' is styled')
  const props = ruleProps('.' + known[0])
  assert.ok(props.padding, 'a text button needs padding, not a fixed box')
})

// ── The behaviour half ──────────────────────────────────────────────────────

// Small enough to read. The innerHTML setter only needs to notice the one
// button this test presses; `reuseButton` models a repaint that leaves the
// node in place, which is the shape that let listeners stack.
function makeDom (opts) {
  const nodes = {}
  let button = null
  const el = function (id) {
    return {
      id,
      dataset: {},
      disabled: false,
      listeners: [],
      children: [],
      addEventListener (t, fn) { if (t === 'click') this.listeners.push(fn) },
      click () { for (const fn of this.listeners.slice()) fn({}) },
      querySelector () { return { dataset: {} } },
      querySelectorAll () { return [] },
      set innerHTML (html) {
        this._html = html
        if (/id="vdevice-del-watched"/.test(html)) {
          if (!button || !opts.reuseButton) button = el('vdevice-del-watched')
          nodes['vdevice-del-watched'] = button
        } else {
          delete nodes['vdevice-del-watched']
        }
      },
      get innerHTML () { return this._html || '' },
    }
  }
  nodes.vrows = el('vrows')
  return {
    doc: {
      getElementById (id) { return nodes[id] || null },
    },
    get button () { return nodes['vdevice-del-watched'] },
  }
}

function lift (opts) {
  opts = opts || {}
  const dom = makeDom(opts)
  const snackbars = []
  const sweeps = []
  const ctx = {
    console,
    Promise,
    Array,
    Object,
    Number,
    Set,
    document: dom.doc,
    state: { currentPage: 'video' },
    _videoCatalogTicket: 1,
    _delWatchedInFlight: false,
    esc: function (s) { return String(s) },
    _fmtBytes: function (n) { return n + ' B' },
    _shortQ: function (s) { return String(s) },
    showSnackbar: function (msg) { snackbars.push(msg) },
    _deviceStorageHtml: function () { return '' },
    _deviceSectionHtml: function (a, b, body) { return body },
    _deviceCardHtml: function () { return '<div class="vcard"></div>' },
    _groupDeviceEntries: function (items) { return [{ show: 's', items, bytes: 0 }] },
    _bindDeviceCards: function () {},
    _refreshInstantKeys: function () {},
    _sweepWatchedCache: function () { return Promise.resolve(null) },
    _vStore: function () { return { get: function () { return { watched: true } } } },
    window: {
      api: {
        videoDownloadList: function () { return Promise.resolve({ ok: true, downloads: [] }) },
        videoKeepList: function () { return Promise.resolve({ ok: true, entries: [] }) },
        videoCacheList: function () {
          return Promise.resolve({ ok: true, entries: [{ key: 'k1', sizeBytes: 1, meta: {} }], capGB: 1 })
        },
        // The dry-run refusal main really returns.
        videoCacheSweepWatched: function (p) {
          sweeps.push(p)
          return Promise.resolve({ ok: false, dryRun: true, error: 'Dry run — deleting watched episodes from the cache was not performed' })
        },
      },
    },
  }
  vm.createContext(ctx)
  vm.runInContext(extractFn(SRC, '_renderDeviceTab'), ctx)
  return { ctx, dom, snackbars, sweeps }
}

test('one press produces one sweep and one snackbar', async () => {
  const t = lift()
  await t.ctx._renderDeviceTab(t.dom.doc.getElementById('vrows'), 1)
  assert.ok(t.dom.button, 'the button must be on the page')
  t.dom.button.click()
  await new Promise(function (r) { setTimeout(r, 5) })
  assert.strictEqual(t.sweeps.length, 1, 'one press, one sweep')
  assert.strictEqual(t.snackbars.length, 1,
    'one press said it ' + t.snackbars.length + ' times: ' + JSON.stringify(t.snackbars))
})

test('an impatient second press while the first is in flight stays silent', async () => {
  const t = lift()
  await t.ctx._renderDeviceTab(t.dom.doc.getElementById('vrows'), 1)
  t.dom.button.click()
  t.dom.button.click()
  t.dom.button.click()
  await new Promise(function (r) { setTimeout(r, 5) })
  assert.strictEqual(t.sweeps.length, 1, 'three presses must not delete three times')
  assert.strictEqual(t.snackbars.length, 1,
    'got ' + t.snackbars.length + ' snackbars: ' + JSON.stringify(t.snackbars))
})

test('repaints that leave the button in place do not stack listeners', async () => {
  const t = lift({ reuseButton: true })
  const rows = t.dom.doc.getElementById('vrows')
  await t.ctx._renderDeviceTab(rows, 1)
  await t.ctx._renderDeviceTab(rows, 1)
  await t.ctx._renderDeviceTab(rows, 1)
  assert.strictEqual(t.dom.button.listeners.length, 1,
    'three repaints bound ' + t.dom.button.listeners.length + ' click handlers')
  t.dom.button.click()
  await new Promise(function (r) { setTimeout(r, 5) })
  assert.strictEqual(t.snackbars.length, 1,
    'got ' + t.snackbars.length + ' snackbars: ' + JSON.stringify(t.snackbars))
})

test('the refusal text is the one the dry run actually returns', async () => {
  const t = lift()
  await t.ctx._renderDeviceTab(t.dom.doc.getElementById('vrows'), 1)
  t.dom.button.click()
  await new Promise(function (r) { setTimeout(r, 5) })
  assert.match(t.snackbars[0], /^Could not delete those: Dry run/)
})
