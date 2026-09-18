'use strict'
// L5 — the player bar's Like, Shuffle and Stop-after buttons lit up but kept
// announcing "not pressed".
//
// All three are toggles. Their visible state lives in a class, which assistive
// tech cannot see; aria-pressed is the only thing it has. updateAriaToggles()
// existed and did the right thing, but none of the three click paths called it
// — so a live probe found the class flipped and aria-pressed still "false"
// 900 ms after the click. Repeat and Mute were right because their setters
// already carried the mirror.
//
// Shuffle was the worst of the three: SEVEN places flipped the class by hand
// (the bar, the deck, a media key, the media-shuffle event, the keyboard
// shortcut, the agent tool, the command palette). They all go through one
// updateShuffleBtns() now.
//
// The three setters and the three click bodies are lifted out of renderer.js
// and run against a small document, so what is asserted is the attribute the
// app actually writes.

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

// The body of a `getElementById('x')?.addEventListener('click', function() {…})`
// binding, from the shipped source.
function liftClick(id) {
  const marker = "document.getElementById('" + id + "')?.addEventListener('click', function() {"
  const at = src.indexOf(marker)
  assert.ok(at > -1, 'the ' + id + ' click binding must still exist')
  const bodyStart = at + marker.length
  let depth = 1, i = bodyStart
  while (depth > 0 && i < src.length) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  return src.slice(bodyStart, i - 1)
}

function button(id) {
  const b = {
    id, cls: new Set(), attrs: {}, dataset: {},
    classList: {
      toggle(c, on) { if (on) b.cls.add(c); else b.cls.delete(c) },
      contains(c) { return b.cls.has(c) },
      remove(c) { b.cls.delete(c) },
      add(c) { b.cls.add(c) },
    },
    setAttribute(a, v) { b.attrs[a] = String(v) },
    getAttribute(a) { return a in b.attrs ? b.attrs[a] : null },
    removeAttribute(a) { delete b.attrs[a] },
    addEventListener() {},
    get offsetWidth() { return 1 },
  }
  return b
}

// A context with the real setters, a document holding every button the bar
// paints, and stubs for everything the click paths call on the way past.
function app(over) {
  const buttons = {}
  for (const id of ['btn-like', 'btn-shuffle', 'np-modal-shuffle', 'btn-stop-after',
    'np-modal-like', 'btn-sleep', 'btn-vol', 'btn-queue']) buttons[id] = button(id)

  const calls = []
  const ctx = {
    console,
    buttons,
    calls,
    document: { getElementById: (id) => buttons[id] || null },
    state: Object.assign({
      shuffle: false, stopAfterTrack: false, queue: [], queueIndex: -1,
      likedTracks: [], library: [], sleepTimerEnd: 0,
    }, over || {}),
    audio: { volume: 0.8 },
    _pendingShuffle: 'stale',
    updateNextPrefetch() { calls.push('prefetch') },
    showSnackbar(msg) { calls.push('snack:' + msg) },
    toggleTrackLike(fp) {
      const i = ctx.state.likedTracks.indexOf(fp)
      if (i < 0) ctx.state.likedTracks.push(fp); else ctx.state.likedTracks.splice(i, 1)
    },
    _syncNpLike() { calls.push('syncNp') },
  }
  vm.createContext(ctx)
  for (const fn of ['updateStopAfterBtn', 'updateShuffleBtns', 'updatePlayerLikeBtn',
    'updateAriaToggles']) {
    vm.runInContext(liftFn(fn), ctx)
  }
  return ctx
}

function click(ctx, id) {
  const body = liftClick(id)
  // `this` is the button the listener is bound to, as in the browser.
  vm.runInContext('(function(){ ' + body + ' }).call(document.getElementById(' + JSON.stringify(id) + '))', ctx)
}

// ── the three defects ────────────────────────────────────────────────────────

test('clicking Shuffle moves aria-pressed, not just the class', () => {
  const ctx = app()
  click(ctx, 'btn-shuffle')
  assert.strictEqual(ctx.state.shuffle, true)
  assert.ok(ctx.buttons['btn-shuffle'].classList.contains('active'), 'the lamp is lit')
  assert.strictEqual(ctx.buttons['btn-shuffle'].getAttribute('aria-pressed'), 'true',
    'and the button must say so — this stayed "false" for the whole session')
})

test('and clicking it again moves it back', () => {
  const ctx = app()
  click(ctx, 'btn-shuffle')
  click(ctx, 'btn-shuffle')
  assert.strictEqual(ctx.buttons['btn-shuffle'].getAttribute('aria-pressed'), 'false')
  assert.ok(!ctx.buttons['btn-shuffle'].classList.contains('active'))
})

test('the deck copy of the button is kept in step with the bar one', () => {
  const ctx = app()
  click(ctx, 'btn-shuffle')
  assert.strictEqual(ctx.buttons['np-modal-shuffle'].getAttribute('aria-pressed'), 'true')
  assert.ok(ctx.buttons['np-modal-shuffle'].classList.contains('active'))
})

test('clicking Stop-after moves aria-pressed', () => {
  const ctx = app()
  click(ctx, 'btn-stop-after')
  assert.strictEqual(ctx.state.stopAfterTrack, true)
  assert.strictEqual(ctx.buttons['btn-stop-after'].getAttribute('aria-pressed'), 'true')
  click(ctx, 'btn-stop-after')
  assert.strictEqual(ctx.buttons['btn-stop-after'].getAttribute('aria-pressed'), 'false')
})

test('liking the playing track moves the heart\'s aria-pressed', () => {
  const track = { filePath: '/mnt/data/MUSIC/Camel/Mirage/03.flac', title: 'Lady Fantasy' }
  const ctx = app({ queue: [track], queueIndex: 0 })
  click(ctx, 'btn-like')
  assert.deepStrictEqual(ctx.state.likedTracks, [track.filePath])
  assert.ok(ctx.buttons['btn-like'].classList.contains('liked'))
  assert.strictEqual(ctx.buttons['btn-like'].getAttribute('aria-pressed'), 'true')
  click(ctx, 'btn-like')
  assert.strictEqual(ctx.buttons['btn-like'].getAttribute('aria-pressed'), 'false')
})

// ── the shape of the fix ─────────────────────────────────────────────────────

test('nothing paints the shuffle class by hand any more', () => {
  assert.ok(!/classList\.toggle\('active', state\.shuffle\)/.test(src),
    'a hand-painted class is exactly how aria-pressed went stale — every path ' +
    'must go through updateShuffleBtns()')
  // Seven flip sites plus the deck sync, all calling the one setter.
  const calls = src.split('updateShuffleBtns()').length - 1
  assert.ok(calls >= 8, 'expected every shuffle flip site to call the setter, found ' + calls)
})

test('the stop-after keyboard shortcut goes through the same setter', () => {
  assert.ok(!/getElementById\('btn-stop-after'\)\?\.classList\.toggle/.test(src),
    'the shortcut painted the class directly and left aria behind')
})

test('the setters are safe when the bar is not on the page', () => {
  const ctx = app()
  vm.runInContext('document.getElementById = function () { return null }', ctx)
  vm.runInContext('updateShuffleBtns(); updateStopAfterBtn(); updatePlayerLikeBtn()', ctx)
})
