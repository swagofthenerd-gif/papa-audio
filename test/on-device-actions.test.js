'use strict'
// The "On device" page (2026-09-17).
//
// Reported verbatim: "some tabs dont even open the saved anime or movies or
// anything, like on the 'on device' page, i have cached episodes which i like,
// but i cant fucking open them or play them from there, and i cant even delete
// them man".
//
// His store held five real cached episodes, every file present on disk, and the
// page drew all five correctly. Nothing on it did anything, because the binder
// began:
//
//     const root = document.getElementById('vdevice-grid')
//     if (!root) return
//
// and no markup in the app ever carried that id — the rendered page was
// `<div class="vdevice-page">`, class only. So the very first line of the only
// click handler on the page returned, and Play, Delete, Cancel and the card
// itself were all decoration.
//
// These tests run the real card builder, the real page renderer and the real
// binder against a hand-rolled DOM, and press the buttons. A source-text check
// could not have caught this: every individual line was correct, and only the
// id they disagree about was wrong.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// Lift a top-level function out of renderer.js by brace-matching. The renderer
// cannot be required outside Electron, so this is how the video tests reach it.
function extractFrom(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' not found')
  let i = source.indexOf('(', start)
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === '(') paren++
    else if (source[i] === ')') { paren--; if (!paren) { i++; break } }
  }
  const bodyStart = source.indexOf('{', i)
  let depth = 0
  for (let j = bodyStart; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') {
      depth--
      if (!depth) {
        const body = source.slice(start, j + 1)
        // `async function x(` contains `function x(`, so the async keyword is
        // outside the slice. Put it back or the await inside is a syntax error.
        return (source.slice(Math.max(0, start - 6), start) === 'async ' ? 'async ' : '') + body
      }
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

// ── A DOM small enough to read and real enough to click ──────────────────────
// innerHTML is parsed with a regex that understands exactly the two shapes the
// device page produces: the <article> cards and the <button data-device-act>
// controls inside them. Attributes come from the REAL rendered markup, so a
// card that stops carrying data-device-path fails these tests.

function unesc(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
function camel(k) { return k.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()) }
function parseAttrs(tagText) {
  const out = {}
  const re = /([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g
  let m
  while ((m = re.exec(tagText))) out[m[1]] = unesc(m[2])
  return out
}

function makeEl(attrs, cls) {
  const el = {
    _attrs: attrs || {},
    _class: cls || '',
    dataset: {},
    style: { removeProperty () {}, setProperty () {} },
    children: [],
    parent: null,
    _listeners: {},
    _html: '',
    get innerHTML() { return this._html },
    set innerHTML(html) { this._html = html; this.children = parseCards(html, this) },
    getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null },
    setAttribute(k, v) { this._attrs[k] = String(v) },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn) },
    matches(sel) {
      if (sel === '.vdevice-card') return /\bvdevice-card\b/.test(this._class)
      if (sel === '.vdevice-page') return /\bvdevice-page\b/.test(this._class)
      if (sel === '[data-device-act]') return this.dataset.deviceAct != null
      return false
    },
    closest(sel) {
      let n = this
      while (n) { if (n.matches(sel)) return n; n = n.parent }
      return null
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null },
    querySelectorAll(sel) {
      const out = []
      const walk = n => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c) } }
      walk(this)
      return out
    },
    // Dispatch through the listeners the production binder registered.
    fire(type, ev) {
      for (const fn of (this._listeners[type] || [])) fn(ev)
    },
  }
  for (const k of Object.keys(el._attrs)) {
    if (k.startsWith('data-')) el.dataset[camel(k)] = el._attrs[k]
  }
  el._class = el._attrs.class || cls || ''
  return el
}

// One <div class="vdevice-page"> with <article class="vcard vdevice-card">
// children, each with its <button data-device-act> controls.
function parseCards(html, parent) {
  const out = []
  const pageTag = /<div class="vdevice-page"([^>]*)>/.exec(html)
  let host = parent
  if (pageTag) {
    const page = makeEl(Object.assign(parseAttrs(pageTag[0]), { class: 'vdevice-page' }), 'vdevice-page')
    page.parent = parent
    page._html = html
    out.push(page)
    host = page
  }
  const cardRe = /<article ([^>]*class="vcard vdevice-card"[^>]*)>([\s\S]*?)<\/article>/g
  let m
  while ((m = cardRe.exec(html))) {
    const card = makeEl(parseAttrs('<article ' + m[1] + '>'), 'vcard vdevice-card')
    card.parent = host
    const btnRe = /<button ([^>]*data-device-act="[^"]*"[^>]*)>/g
    let b
    while ((b = btnRe.exec(m[2]))) {
      const btn = makeEl(parseAttrs('<button ' + b[1] + '>'), 'vcard-act')
      btn.parent = card
      card.children.push(btn)
    }
    if (host === parent) out.push(card)
    else host.children.push(card)
  }
  return out
}

function makeDoc() {
  const byId = {}
  const doc = {
    _mk(id, cls) { const e = makeEl({ id: id, class: cls || '' }, cls); byId[id] = e; return e },
    getElementById(id) { return byId[id] || null },
    querySelector() { return null },
  }
  return doc
}

// ── The page under test ──────────────────────────────────────────────────────
function build(opts) {
  opts = opts || {}
  const calls = []
  const doc = makeDoc()
  const rows = doc._mk('vrows')

  const api = {
    videoDownloadList: () => { calls.push(['list-dl']); return Promise.resolve({ ok: true, downloads: opts.downloads || [] }) },
    videoKeepList: () => Promise.resolve({ ok: true, entries: opts.keeps || [], usedBytes: 0, quotaBytes: 0 }),
    videoCacheList: () => Promise.resolve({ ok: true, entries: opts.cached || [], capGB: 40 }),
    videoCacheDelete: p => { calls.push(['cache-delete', p]); return (opts.answers && opts.answers.cacheDelete) || Promise.resolve({ ok: true }) },
    videoKeepDelete: id => { calls.push(['keep-delete', id]); return (opts.answers && opts.answers.keepDelete) || Promise.resolve({ ok: true }) },
    videoDownloadCancel: p => { calls.push(['cancel', p]); return (opts.answers && opts.answers.cancel) || Promise.resolve({ ok: true }) },
  }

  const sandbox = {
    document: doc,
    window: { api: api, CSS: null },
    state: { currentPage: 'video' },
    _videoCatalogTicket: 1,
    _videoTab: 'device',
    calls,
    snackbars: [],
    toasts: [],
    plays: [],
    navs: [],
    instantRefreshes: 0,
    instantForce: [],
    // Stubs for the formatting helpers — not what is under test here.
    _fmtBytes: n => String(n) + 'B',
    _agoLabel: () => 'a while',
    _vDurText: n => n + 's',
    _VICON: { play: '<svg></svg>' },
    navigate: (page, id) => sandbox.navs.push([page, id]),
    showToast: m => sandbox.toasts.push(m),
    showSnackbar: m => sandbox.snackbars.push(m),
    _videoPlayResult: (result, o) => sandbox.plays.push({ result, opts: o }),
    // Records the ARGUMENT as well as the count. Calling this without `true`
    // is a no-op for the first 30 seconds after any earlier refresh, so a bare
    // `_refreshInstantKeys()` leaves every poster claiming CACHED for a file
    // that was just deleted — a call, but not a refresh.
    _refreshInstantKeys: f => { sandbox.instantRefreshes++; sandbox.instantForce.push(f); return Promise.resolve() },
  }
  sandbox.window.window = sandbox.window
  vm.createContext(sandbox)

  const names = ['esc', '_shortQ', '_etaLabel', '_deviceFactsHtml', '_deviceEpisodeLabel',
    '_deviceCardHtml', '_groupDeviceEntries', '_deviceSectionHtml', '_deviceStorageHtml',
    '_renderDeviceTab', '_deviceAction', '_bindDeviceCards', '_playDeviceFile']
  // With realInstant the actual badge refresher is lifted in, throttle and
  // all, instead of the counting stub — so the test can watch whether the
  // badge list is genuinely re-fetched rather than merely called.
  if (opts.realInstant) {
    delete sandbox._refreshInstantKeys
    sandbox._instantKeys = []
    sandbox._instantAt = Date.now()
    sandbox.window.api.videoInstantList = () => {
      calls.push(['instant-list'])
      return Promise.resolve({ ok: true, instant: ['anime:30:e1'] })
    }
    names.push('_refreshInstantKeys')
  }
  let code = names.map(n => extractFrom(opts.source || SRC, n)).join('\n')
  vm.runInContext(code, sandbox)
  return { sandbox, rows, doc, calls, api }
}

// Fixture shaped exactly like the entries in his real video-cache-index.json:
// key, path, sizeBytes, savedAt, lastUsedAt, title, meta.
function cacheEntry(n, ep) {
  return {
    key: 'anime:' + n + ':e' + ep,
    path: '/fixture/video-cache/anime_' + n + '_e' + ep + '.mkv',
    sizeBytes: 1000, savedAt: 1, lastUsedAt: 2,
    title: 'Show ' + n,
    meta: { type: 'anime', id: n, title: 'Show ' + n, poster: null, season: null, episode: ep },
  }
}
function keepEntry(id) {
  return { id: id, title: 'Kept ' + id, path: '/fixture/keep/' + id + '.mkv', sizeBytes: 2000, keptAt: 5 }
}

function press(card, act) {
  const target = act ? card.children.find(c => c.dataset.deviceAct === act) : card
  assert.ok(target, 'the card carries a ' + (act || 'body') + ' control')
  // The listener is on the page div; the event bubbles from the target.
  const page = card.parent
  page.fire('click', { target: target, stopPropagation () {} })
}

test('the rendered page carries the id the binder looks for', async () => {
  const h = build({ cached: [cacheEntry(30, 1)] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  assert.match(h.rows.innerHTML, /id="vdevice-grid"/,
    'without this id _bindDeviceCards returns on its first line and the page is dead')
  assert.ok(h.doc.getElementById('vrows').querySelector('.vdevice-page'),
    'and the page node exists to bind to')
})

test('Play on a cached card plays that file, with no borrowed identity', async () => {
  const h = build({ cached: [cacheEntry(30, 2)] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const card = h.rows.querySelectorAll('.vdevice-card')[0]
  assert.ok(card, 'a card was rendered')
  press(card, 'play')
  assert.strictEqual(h.sandbox.plays.length, 1, 'pressing Play starts a play')
  const p = h.sandbox.plays[0]
  assert.strictEqual(p.result.kind, 'cached')
  assert.strictEqual(p.result.url, '/fixture/video-cache/anime_30_e2.mkv',
    'and it plays the file the card is about')
  assert.strictEqual(p.result.title, 'Show 30', 'the theatre gets a real name')
  // The whole point: the On-device page has no detail page behind it, so the
  // play must NOT be allowed to fall back to _videoDetail / _videoState — that
  // is another title entirely, and its watch key is where the position ticks
  // would have been written.
  assert.ok(p.opts && p.opts.ctx, 'the play carries an explicit context')
  assert.strictEqual(p.opts.ctx.detail, null, 'and that context is empty, not the page behind it')
  assert.strictEqual(p.opts.ctx.state, null)
  assert.ok(Array.isArray(p.opts.ctx.streams) && p.opts.ctx.streams.length === 0)
})

test('the card body opens the title page when the entry knows its identity', async () => {
  const h = build({ cached: [cacheEntry(11757, 1)] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const card = h.rows.querySelectorAll('.vdevice-card')[0]
  press(card, null)
  assert.deepStrictEqual(h.sandbox.navs, [['video-detail', 'anime:11757']])
})

test('a body click with no identity and no file says so instead of doing nothing', async () => {
  // A keep entry written by the old "Keep this episode" path carries no meta,
  // and a pruned file carries no path.
  const h = build({ keeps: [{ id: 'k1', title: 'Orphan', sizeBytes: 1, keptAt: 1 }] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const card = h.rows.querySelectorAll('.vdevice-card')[0]
  press(card, null)
  assert.strictEqual(h.sandbox.navs.length, 0)
  assert.strictEqual(h.sandbox.plays.length, 0)
  assert.strictEqual(h.sandbox.toasts.length, 1, 'the click is answered, not swallowed')
})

test('Delete on a cached card deletes by key; on a kept card by id', async () => {
  const h = build({ cached: [cacheEntry(21311, 1)], keeps: [keepEntry('abc123')] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const cards = h.rows.querySelectorAll('.vdevice-card')
  assert.strictEqual(cards.length, 2)
  // Keeps render above the cache section.
  const kept = cards.find(c => c.dataset.deviceKind === 'keep')
  const cached = cards.find(c => c.dataset.deviceKind === 'cache')
  press(kept, 'delete')
  press(cached, 'delete')
  await new Promise(r => setTimeout(r, 0))
  const del = h.calls.filter(c => c[0] === 'keep-delete' || c[0] === 'cache-delete')
  // Compared as JSON: the argument objects are built inside the vm realm, so
  // they are structurally right but never reference-equal to a literal here.
  assert.strictEqual(JSON.stringify(del), JSON.stringify([
    ['keep-delete', 'abc123'],
    ['cache-delete', { key: 'anime:21311:e1' }],
  ]), 'each kind is deleted through its own handler, with its own identifier')
})

test('a delete that fails says so out loud', async () => {
  const h = build({
    keeps: [keepEntry('gone')],
    answers: { keepDelete: Promise.resolve({ ok: false, error: 'That download is not in the list' }) },
  })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  press(h.rows.querySelectorAll('.vdevice-card')[0], 'delete')
  await new Promise(r => setTimeout(r, 0))
  assert.strictEqual(h.sandbox.snackbars.length, 1, 'the refusal reaches the viewer')
  assert.match(h.sandbox.snackbars[0], /Could not delete/)
  assert.match(h.sandbox.snackbars[0], /not in the list/, 'including what the handler actually said')
})

test('a delete whose IPC rejects is reported, not lost', async () => {
  const h = build({
    cached: [cacheEntry(30, 1)],
    answers: { cacheDelete: Promise.reject(new Error('ipc channel closed')) },
  })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  press(h.rows.querySelectorAll('.vdevice-card')[0], 'delete')
  await new Promise(r => setTimeout(r, 0))
  assert.strictEqual(h.sandbox.snackbars.length, 1)
  assert.match(h.sandbox.snackbars[0], /ipc channel closed/)
})

test('a successful delete re-asks for the instant badges it just invalidated', async () => {
  const h = build({ cached: [cacheEntry(30, 1)] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  press(h.rows.querySelectorAll('.vdevice-card')[0], 'delete')
  await new Promise(r => setTimeout(r, 0))
  assert.strictEqual(h.sandbox.instantRefreshes, 1,
    'otherwise every poster for that title keeps claiming CACHED')
  assert.strictEqual(h.sandbox.instantForce[0], true,
    'and it must FORCE the refresh — an unforced call inside the 30s window ' +
    'returns without asking, so the badges keep lying about a deleted file')
})

test('the forced refresh actually re-fetches, throttle window or not', async () => {
  // The real refresher, not the counting stub: a delete happening seconds
  // after the page painted is exactly the case the throttle would swallow.
  const h = build({ realInstant: true, cached: [cacheEntry(30, 1)] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const before = h.calls.filter(c => c[0] === 'instant-list').length
  press(h.rows.querySelectorAll('.vdevice-card')[0], 'delete')
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))
  const after = h.calls.filter(c => c[0] === 'instant-list').length
  assert.strictEqual(after - before, 1,
    'the badge list is asked for again after the delete, inside the throttle window')
})

test('Cancel stops a running download and reports a refusal', async () => {
  const dl = { id: 'k|magnet', title: 'Arriving', bytes: 5, total: 10, status: 'downloading', speedBps: 1, peers: 2, eta: 5 }
  const ok = build({ downloads: [dl] })
  await ok.sandbox._renderDeviceTab(ok.rows, 1)
  press(ok.rows.querySelectorAll('.vdevice-card')[0], 'cancel')
  await new Promise(r => setTimeout(r, 0))
  assert.strictEqual(JSON.stringify(ok.calls.filter(c => c[0] === 'cancel')),
    JSON.stringify([['cancel', { id: 'k|magnet' }]]))

  const bad = build({ downloads: [dl], answers: { cancel: Promise.resolve({ ok: false }) } })
  await bad.sandbox._renderDeviceTab(bad.rows, 1)
  press(bad.rows.querySelectorAll('.vdevice-card')[0], 'cancel')
  await new Promise(r => setTimeout(r, 0))
  assert.match(bad.sandbox.snackbars[0], /Could not stop/)
})

test('the card answers the keyboard it claims to answer', async () => {
  const h = build({ cached: [cacheEntry(195600, 1)] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const card = h.rows.querySelectorAll('.vdevice-card')[0]
  assert.strictEqual(card.getAttribute('role'), 'button')
  assert.strictEqual(card.getAttribute('tabindex'), '0')
  let prevented = 0
  card.parent.fire('keydown', { key: 'Enter', target: card, preventDefault () { prevented++ } })
  assert.strictEqual(prevented, 1)
  assert.deepStrictEqual(h.sandbox.navs, [['video-detail', 'anime:195600']])
})

test('a repaint does not blank the page it is repainting', async () => {
  const h = build({ cached: [cacheEntry(30, 1)] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const first = h.rows.innerHTML
  assert.ok(!/class="spin"/.test(first))
  // Freeze the IPCs so the render is caught mid-flight, the way a download
  // event repaint is while the three lists are being fetched.
  let release
  const gate = new Promise(r => { release = r })
  h.api.videoCacheList = () => gate.then(() => ({ ok: true, entries: [cacheEntry(30, 1)], capGB: 40 }))
  const p = h.sandbox._renderDeviceTab(h.rows, 1)
  assert.ok(!/class="spin"/.test(h.rows.innerHTML),
    'the cards stay on screen while the repaint is in flight')
  assert.ok(/vdevice-card/.test(h.rows.innerHTML))
  release()
  await p
})

test('the first paint still shows a spinner', async () => {
  const h = build({ cached: [cacheEntry(30, 1)] })
  let release
  const gate = new Promise(r => { release = r })
  h.api.videoCacheList = () => gate.then(() => ({ ok: true, entries: [], capGB: 40 }))
  const p = h.sandbox._renderDeviceTab(h.rows, 1)
  assert.match(h.rows.innerHTML, /class="spin"/)
  release()
  await p
})

// ── The mutation check, run as a test ────────────────────────────────────────
// Revert the fix in a copy of the source and prove the page goes dead again.
// This is what keeps the tests above from being decoration.
test('MUTATION: without the id on the page node, every click does nothing', async () => {
  // Both halves of the fix are reverted, which is exactly the shipped defect:
  // the page node loses the id, and the binder goes back to looking it up
  // instead of being handed the node it should bind to.
  const broken = SRC
    .replace('<div class="vdevice-page" id="vdevice-grid">', '<div class="vdevice-page">')
    .replace("  root = root || document.getElementById('vdevice-grid')",
             "  root = document.getElementById('vdevice-grid')")
  assert.ok(broken !== SRC && !broken.includes('id="vdevice-grid"') &&
    broken.includes("  root = document.getElementById('vdevice-grid')"), 'the mutation applied')
  const h = build({ source: broken, cached: [cacheEntry(30, 1)], keeps: [keepEntry('x')] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const cards = h.rows.querySelectorAll('.vdevice-card')
  assert.strictEqual(cards.length, 2, 'the cards still render — that is what made this invisible')
  for (const c of cards) {
    press(c, null)
    const act = c.children.find(x => x.dataset.deviceAct)
    if (act) press(c, act.dataset.deviceAct)
  }
  await new Promise(r => setTimeout(r, 0))
  assert.strictEqual(h.sandbox.plays.length, 0, 'nothing plays')
  assert.strictEqual(h.sandbox.navs.length, 0, 'nothing opens')
  assert.strictEqual(h.calls.filter(c => /delete|cancel/.test(c[0])).length, 0, 'nothing deletes')
})

// ── Right-click ──────────────────────────────────────────────────────────────
// The delegated card context menu matches any .vcard, and an On-device card is
// a .vcard with no data-video. So every row of the menu was built around an
// empty key: Play and "Go to details" both navigated to video-detail with no
// id, and "Add to My List" pushed a ghost entry keyed "movie:". The device card
// gets its own menu instead — and the Delete row is the discoverable way to do
// the thing he could not do at all.
function menuHarness(source, opts) {
  opts = opts || {}
  const h = build(opts)
  vm.runInContext([
    extractFrom(source || SRC, '_deviceCardMenuItems'),
  ].join('\n'), h.sandbox)
  return h
}

test('a cached card gets a menu about the file, not about an empty key', async () => {
  const h = menuHarness(SRC, { cached: [cacheEntry(30, 1)] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const card = h.rows.querySelectorAll('.vdevice-card')[0]
  card.classList = { contains: c => c === 'vdevice-card' }
  const items = h.sandbox._deviceCardMenuItems(card)
  assert.strictEqual(items.map(i => i.label).join('|'),
    'Play|Go to details|Delete from this device')

  items[0].run()
  assert.strictEqual(h.sandbox.plays.length, 1, 'Play plays the file')
  assert.strictEqual(h.sandbox.plays[0].result.url, '/fixture/video-cache/anime_30_e1.mkv')

  items[1].run()
  assert.strictEqual(JSON.stringify(h.sandbox.navs), JSON.stringify([['video-detail', 'anime:30']]),
    'and details go to the real title, not to an empty id')

  items[2].run()
  await new Promise(r => setTimeout(r, 0))
  assert.strictEqual(JSON.stringify(h.calls.filter(c => c[0] === 'cache-delete')),
    JSON.stringify([['cache-delete', { key: 'anime:30:e1' }]]))
  assert.strictEqual(h.sandbox.instantRefreshes, 1)
})

test('a running download offers Stop, never Delete', async () => {
  const h = menuHarness(SRC, {
    downloads: [{ id: 'dl1', title: 'Arriving', bytes: 1, total: 2, status: 'downloading' }],
  })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const card = h.rows.querySelectorAll('.vdevice-card')[0]
  const labels = h.sandbox._deviceCardMenuItems(card).map(i => i.label)
  assert.ok(labels.includes('Stop this download'))
  assert.ok(!labels.includes('Delete from this device'),
    'deleting a half-arrived file is not what the ✕ on a download means')
})

test('a kept entry with no file left offers no Play', async () => {
  const h = menuHarness(SRC, { keeps: [{ id: 'k9', title: 'Pruned', sizeBytes: 1, keptAt: 1 }] })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  const card = h.rows.querySelectorAll('.vdevice-card')[0]
  const labels = h.sandbox._deviceCardMenuItems(card).map(i => i.label)
  assert.strictEqual(labels.join('|'), 'Delete from this device',
    'nothing to play and nothing to open — only the row that still means something')
})

// Slice a `const NAME = ...` initialiser up to its matching close bracket, so
// the branch itself is executed rather than read.
function sliceInit(source, startText, closer) {
  const a = source.indexOf(startText)
  assert.ok(a > -1, 'found ' + startText)
  const open = closer === ']' ? '[' : '{'
  let depth = 0
  for (let i = source.indexOf(open, a); i < source.length; i++) {
    if (source[i] === open) depth++
    else if (source[i] === closer) { depth--; if (!depth) return source.slice(a, i + 1) }
  }
  throw new Error('unbalanced')
}

test('the menu builder routes a device card to the device menu', () => {
  const pick = sliceInit(SRC, '  const items = card.classList && card.classList.contains', ']')
  const ctx = {
    _deviceCardMenuItems: () => [{ label: 'DEVICE' }],
    _VICON: { play: '', info: '', plus: '', check: '', stop: '' },
    navigate () {}, showToast () {}, _toggleWatchlist () {}, window: {},
    st: { inList: false, watched: false }, open () {}, type: 'movie', id: '1', title: '', poster: null,
  }
  vm.createContext(ctx)
  const run = card => {
    ctx.card = card
    // The initialiser is executed verbatim; only its binding name is rebound.
    vm.runInContext('var card = this.card; ' + pick.replace('  const items =', 'globalThis.__items ='), ctx)
    return ctx.__items
  }
  const device = { classList: { contains: c => c === 'vdevice-card' }, dataset: {} }
  const normal = { classList: { contains: () => false }, dataset: { video: 'movie:603' } }
  assert.strictEqual(run(device).map(i => i.label).join('|'), 'DEVICE')
  assert.ok(run(normal).map(i => i.label).join('|').startsWith('Play|Go to details'),
    'an ordinary card keeps the four documented rows')
})

test('a .vcard that can answer nothing gets no menu at all', () => {
  const handlers = {}
  const ctx = {
    _vCtxBound: false,
    document: { addEventListener: (t, fn) => { handlers[t] = fn } },
    opened: [],
    _openVideoCardMenu: (card) => ctx.opened.push(card),
  }
  vm.createContext(ctx)
  vm.runInContext(extractFrom(SRC, '_bindVideoCardContextMenu'), ctx)
  ctx._bindVideoCardContextMenu()
  const fire = card => handlers.contextmenu({
    target: { closest: sel => (sel === '.vcard' ? card : null) },
    preventDefault () {}, clientX: 0, clientY: 0,
  })
  fire({ dataset: {}, classList: { contains: () => false } })
  assert.strictEqual(ctx.opened.length, 0, 'no id and not a device card → no menu')
  fire({ dataset: {}, classList: { contains: c => c === 'vdevice-card' } })
  assert.strictEqual(ctx.opened.length, 1, 'a device card does get one')
  fire({ dataset: { video: 'tv:1396' }, classList: { contains: () => false } })
  assert.strictEqual(ctx.opened.length, 2, 'and so does an ordinary card')
})

// ── A list that could not be read is not an empty list ───────────────────────
// All three answers were folded into `|| []`, so a failed handler painted the
// same page as a genuinely empty device. On a page whose whole complaint was
// "my cached episodes are here but nothing works", an error that renders as
// "nothing is saved on this device yet" is the worst possible answer.
test('a failed list is named, not painted as an empty device', async () => {
  const h = build({})
  h.api.videoCacheList = () => Promise.resolve({ ok: false, error: 'EACCES reading the cache index' })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  assert.match(h.rows.innerHTML, /Could not read the rewatch cache/)
  assert.match(h.rows.innerHTML, /EACCES reading the cache index/, 'and says what went wrong')
  assert.doesNotMatch(h.rows.innerHTML, /Nothing is saved on this device yet/)
})

test('a rejected list is named too', async () => {
  const h = build({})
  h.api.videoKeepList = () => Promise.reject(new Error('channel closed'))
  await h.sandbox._renderDeviceTab(h.rows, 1)
  assert.match(h.rows.innerHTML, /Could not read your downloads/)
})

test('a genuinely empty device still says so', async () => {
  const h = build({})
  await h.sandbox._renderDeviceTab(h.rows, 1)
  assert.match(h.rows.innerHTML, /Nothing is saved on this device yet/)
  assert.doesNotMatch(h.rows.innerHTML, /Could not read/)
})

test('two failures are named in one sentence', async () => {
  const h = build({ cached: [cacheEntry(30, 1)] })
  h.api.videoDownloadList = () => Promise.resolve({ ok: false })
  h.api.videoKeepList = () => Promise.resolve({ ok: false })
  await h.sandbox._renderDeviceTab(h.rows, 1)
  assert.match(h.rows.innerHTML, /Could not read what is downloading and your downloads\./)
  assert.match(h.rows.innerHTML, /vdevice-card/, 'and the cache that DID load is still shown')
})
