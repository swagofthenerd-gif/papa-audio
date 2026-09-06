'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { VideoEngine, SUB_STYLE_PROPS } = require('../video-engine')

// A VideoEngine wired to a fake mpv client, so setSubStyle's property writes can
// be observed without a real process. Mirrors the seam other engine tests use:
// the guard needs alive + a client + a matching generation.
function engineWithFakeClient() {
  const sent = []
  const engine = new VideoEngine()
  engine.client = { command: async (...args) => { sent.push(args) } }
  engine.alive = true
  engine._gen = 1 // _guard captures this; leave it matching
  return { engine, sent }
}

test('setSubStyle maps friendly keys to their mpv properties', async () => {
  const { engine, sent } = engineWithFakeClient()
  await engine.setSubStyle({ fontSize: 55, color: '#ffffff', pos: 90 })
  const props = sent.map(a => [a[1], a[2]])
  assert.deepStrictEqual(props, [
    ['sub-font-size', 55],
    ['sub-color', '#ffffff'],
    ['sub-pos', 90],
  ])
})

test('setSubStyle ignores keys the engine does not know', async () => {
  const { engine, sent } = engineWithFakeClient()
  await engine.setSubStyle({ fontSize: 40, bogus: 'nope', anotherBad: 1 })
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0][1], 'sub-font-size')
})

test('the friendly-key table covers the contract vocabulary the mapper targets', () => {
  // The four properties the W4-UI subStyle contract maps onto, via _mapSubStyle
  // in main.js: fontSize, color, pos and a backing box (backColor).
  for (const key of ['fontSize', 'color', 'pos', 'backColor']) {
    assert.ok(SUB_STYLE_PROPS[key], `SUB_STYLE_PROPS must define ${key}`)
  }
  assert.strictEqual(SUB_STYLE_PROPS.fontSize, 'sub-font-size')
  assert.strictEqual(SUB_STYLE_PROPS.color, 'sub-color')
  assert.strictEqual(SUB_STYLE_PROPS.pos, 'sub-pos')
  assert.strictEqual(SUB_STYLE_PROPS.backColor, 'sub-back-color')
})

// _mapSubStyle turns the contract's size/color/position/background into the
// engine's friendly keys. It is not exported (it closes over nothing, but lives
// among the IPC handlers), so its mapping is pinned by source inspection — the
// same technique the IPC-wiring tests use for main.js internals.
test('_mapSubStyle translates the contract fields onto the engine keys', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const start = MAIN.indexOf('function _mapSubStyle(')
  assert.ok(start > -1, 'main.js must define _mapSubStyle')
  const body = MAIN.slice(start, MAIN.indexOf('\n}', start))
  assert.match(body, /p\.size != null.*out\.fontSize = p\.size/s)
  assert.match(body, /p\.color != null.*out\.color = p\.color/s)
  assert.match(body, /p\.position != null.*out\.pos = p\.position/s)
  // background:true → an opaque backing box, background:false → transparent.
  assert.match(body, /out\.backColor/)
})

// The persisted style must be re-applied when mpv opens a new file, or an episode
// switch (a fresh load, sometimes a fresh engine) drops it back to the defaults.
test('the persisted sub-style is re-applied on fileLoaded', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const at = MAIN.indexOf("engine.on('fileLoaded'")
  assert.ok(at > -1, 'the engine wiring must re-apply the sub-style on fileLoaded')
  const body = MAIN.slice(at, at + 400)
  assert.match(body, /_videoConfig\(\)\.subStyle/)
  assert.match(body, /setSubStyle/)
})
