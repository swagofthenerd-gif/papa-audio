'use strict'
// M3 — Enter on a command nobody has ran a MUSIC search for the raw command.
//
// Type ">zzqq" in the Omnibox. The palette correctly says "Nothing matches".
// Press Enter and the bare-query fallback fired:
//
//     if (!row && inp.value.trim()) { toggleCommandPalette(); commitSearchQuery(...) }
//
// — so the palette closed, the app ran a library search for the literal
// ">zzqq", and remembered ">zzqq" as a recent search, which then came back as a
// suggestion. The fallback never asked whether the text was a command.
//
// This drives the real _setupCP()'s keydown handler against the real
// PapaOmnibox.isCommandMode.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const PapaOmnibox = require(path.join(__dirname, '..', 'src', 'omnibox-model.js'))

function lift(source, name) {
  const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(source)
  assert.ok(m, `${name} not found in the renderer`)
  const start = m.index + 1
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `${name} has no closing brace`)
  return source.slice(start, end + 2)
}

function el(id) {
  return {
    id, value: '', dataset: {}, _l: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn) },
    fire(t, ev) { for (const fn of this._l[t] || []) fn(ev || {}) },
    querySelectorAll: () => [],
  }
}

// `rows` is what the model produced for the typed text — an empty list is the
// "Nothing matches" state both in command mode and out of it.
function harness(source, { rows = [] } = {}) {
  const els = {
    'cmd-palette': el('cmd-palette'),
    'cmd-palette-input': el('cmd-palette-input'),
    'cmd-palette-results': el('cmd-palette-results'),
  }
  const calls = { toggled: 0, committed: [], remembered: [], execed: [], rendered: 0 }
  const ctx = {
    console,
    document: { getElementById: id => els[id] || null },
    // The real model, so isCommandMode is the app's own answer, not a copy.
    window: { PapaOmnibox },
    _cpIdx: 0,
    _omniRows: () => rows,
    _omniRender() { calls.rendered++ },
    _omniExec(row) { calls.execed.push(row) },
    toggleCommandPalette() { calls.toggled++ },
    commitSearchQuery(q) { calls.committed.push(q) },
    _rememberSearch(q, surface) { calls.remembered.push([q, surface]) },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(lift(source, '_setupCP'), ctx)
  vm.runInContext('_setupCP()', ctx)
  return { ctx, els, calls }
}

function pressEnter(h, typed) {
  h.els['cmd-palette-input'].value = typed
  let prevented = 0
  h.els['cmd-palette-input'].fire('keydown', { key: 'Enter', preventDefault() { prevented++ } })
  return prevented
}

test('sanity: the model does call ">zzqq" command mode and finds nothing', () => {
  assert.strictEqual(PapaOmnibox.isCommandMode('>zzqq'), true)
  assert.strictEqual(PapaOmnibox.isCommandMode('zzqq'), false)
})

test('Enter on a command that matches nothing runs no search and remembers nothing', () => {
  const h = harness(RENDERER)
  pressEnter(h, '>zzqq')
  assert.deepStrictEqual(h.calls.committed, [], 'it used to search the library for ">zzqq"')
  assert.deepStrictEqual(h.calls.remembered, [], 'and file ">zzqq" as a recent search')
  assert.deepStrictEqual(h.calls.execed, [], 'there was no row to perform')
})

test('and the palette stays open, with "Nothing matches" still on screen', () => {
  const h = harness(RENDERER)
  pressEnter(h, '>zzqq')
  assert.strictEqual(h.calls.toggled, 0, 'closing it hid the only explanation the user had')
})

test('every command-mode spelling is covered, leading space included', () => {
  for (const typed of ['>zzqq', '>', '  > nope', '>a b c']) {
    const h = harness(RENDERER)
    pressEnter(h, typed)
    assert.strictEqual(h.calls.committed.length, 0, typed)
    assert.strictEqual(h.calls.toggled, 0, typed)
  }
})

test('a plain query with nothing highlighted still searches, as it always did', () => {
  const h = harness(RENDERER)
  pressEnter(h, 'karma police')
  assert.deepStrictEqual(h.calls.committed, ['karma police'])
  assert.strictEqual(h.calls.toggled, 1, 'and the palette closes onto the results')
})

test('a highlighted command row is still performed', () => {
  const row = { kind: 'command', cmd: { action() {} } }
  const h = harness(RENDERER, { rows: [row] })
  pressEnter(h, '>set')
  assert.strictEqual(h.calls.execed.length, 1, 'a real match must still run')
  assert.strictEqual(h.calls.execed[0], row)
})

test('an empty box does nothing either way', () => {
  const h = harness(RENDERER)
  const prevented = pressEnter(h, '   ')
  assert.strictEqual(prevented, 1, 'Enter is still swallowed')
  assert.strictEqual(h.calls.committed.length, 0)
  assert.strictEqual(h.calls.toggled, 0)
})

test('MUTATION: without the command-mode check ">zzqq" becomes a music search again', () => {
  const broken = RENDERER.replace(
    "        if (!row && _typed && window.PapaOmnibox && window.PapaOmnibox.isCommandMode(_typed)) return\n", '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken)
  pressEnter(h, '>zzqq')
  assert.deepStrictEqual(h.calls.committed, ['>zzqq'], 'this is the reported bug')
  assert.strictEqual(h.calls.toggled, 1)
})
