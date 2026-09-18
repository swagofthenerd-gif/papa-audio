'use strict'
// Opening a video detail page with nothing "armed" must not throw.
//
// _playOnArrival carries a Play pressed on a card or the hero until the detail
// page consumes it. Three sites assigned it and one read it, and NOTHING
// declared it. In sloppy mode an assignment quietly creates a global — but a
// READ of a name that has never been assigned throws ReferenceError. Restoring
// straight into a video-detail page on startup does the read first, so the page
// threw before painting. Because the video renderers are async, the old error
// handling never caught it: a grey skeleton, for ever. Five thousand green
// tests did not see it; a live twin did in under a minute.
//
// The real consume block is lifted and run in a vm that has NOT assigned the
// variable, which is the state on a fresh page.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function declarationLine() {
  const m = /^var _playOnArrival\b[^\n]*/m.exec(SRC)
  return m ? m[0] : null
}

function consumeBlock() {
  const start = SRC.indexOf('const arrival = _playOnArrival')
  assert.ok(start > -1, 'the consume site must still exist')
  const end = SRC.indexOf('_videoStreams = []', start)
  return SRC.slice(start, end)
}

test('the variable is declared at module scope', () => {
  assert.ok(declarationLine(), '_playOnArrival must be declared, not merely assigned')
})

test('consuming an un-armed arrival does not throw on a fresh page', () => {
  // A fresh page: the declaration has run, nothing has assigned it.
  const ctx = vm.createContext({ Number })
  const decl = declarationLine()
  assert.ok(decl)
  vm.runInContext(decl, ctx)
  vm.runInContext('var _videoState = { season: null, episode: 1 }; var _autoPlayTicket = 0; var ticket = 7', ctx)
  assert.doesNotThrow(() => vm.runInContext(consumeBlock(), ctx),
    'reading _playOnArrival with nothing armed must be a no-op, not a ReferenceError')
  assert.strictEqual(vm.runInContext('_playOnArrival', ctx), null, 'and it is cleared')
  assert.strictEqual(vm.runInContext('_videoState.episode', ctx), 1, 'nothing was applied')
})

test('WITHOUT the declaration the same block throws — this is the bug', () => {
  // Pins the mechanism so the fix cannot be "tidied away" as a redundant var.
  const ctx = vm.createContext({ Number })
  vm.runInContext('var _videoState = { season: null, episode: 1 }; var _autoPlayTicket = 0; var ticket = 7', ctx)
  assert.throws(() => vm.runInContext(consumeBlock(), ctx), /ReferenceError/)
})

test('an armed arrival is still consumed exactly once', () => {
  const ctx = vm.createContext({ Number })
  vm.runInContext(declarationLine(), ctx)
  vm.runInContext('var _videoState = { season: null, episode: 1 }; var _autoPlayTicket = 0; var ticket = 7', ctx)
  vm.runInContext('_playOnArrival = { episode: 9, season: 2 }', ctx)
  vm.runInContext(consumeBlock(), ctx)
  assert.strictEqual(vm.runInContext('_videoState.episode', ctx), 9)
  assert.strictEqual(vm.runInContext('_videoState.season', ctx), 2)
  assert.strictEqual(vm.runInContext('_autoPlayTicket', ctx), 7, 'auto-play armed')
  assert.strictEqual(vm.runInContext('_playOnArrival', ctx), null, 'taken exactly once')
})
