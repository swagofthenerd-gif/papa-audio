'use strict'
// Bit-perfect output (roadmap #65) — the main.js/preload wiring, source-shape
// asserted the same way the other player-config handlers are, since main.js
// cannot be required outside Electron. The pure policy is covered in
// test/bit-perfect.test.js; this pins that main actually consults it.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const MAIN = root('main.js')
const PRELOAD = root('preload.js')

test('main requires the pure bit-perfect module (lazily, off the startup path)', () => {
  assert.match(MAIN, /const bitPerfect = _lazyNs\(\(\) => require\('\.\/src\/bit-perfect'\)\)/)
})

test('getPlayerSettings reads the bitPerfect store key and reports the note', () => {
  const start = MAIN.indexOf('function getPlayerSettings(')
  const body = MAIN.slice(start, MAIN.indexOf('\n}\n', start))
  assert.match(body, /const bitPerfectOn = saved\.bitPerfect === true/, 'default off: only true is on')
  assert.match(body, /bitPerfect: bitPerfectOn/)
  assert.match(body, /exclusivityNote: bitPerfect\.EXCLUSIVITY_NOTE/)
  // The derived mode must never be crossfade while bit-perfect is on.
  assert.match(body, /bitPerfect\.forcesGapless\(bitPerfectOn\)/)
  assert.match(body, /mode: crossfadeAllowed \? 'crossfade' : 'gapless'/)
})

test('buildPlayer routes the engine config through the pure resolver', () => {
  const start = MAIN.indexOf('function buildPlayer(')
  const body = MAIN.slice(start, start + 900)
  assert.match(body, /bitPerfect\.resolveEngineConfig\(cfg\)/)
  // and never builds a crossfade engine while bit-perfect is on.
  assert.match(body, /!bitPerfect\.forcesGapless\(cfg\.bitPerfect\)/)
})

test('toggling bit-perfect forces an engine rebuild', () => {
  const start = MAIN.indexOf('async function _applyPlayerConfig(')
  const body = MAIN.slice(start, start + 600)
  assert.match(body, /'bitPerfect'\]\s*\n?\s*\.some\(k => k in partial\)/,
    'bitPerfect is in the needsRebuild key list')
})

test('the player-set-bit-perfect IPC handler exists and returns the resolved settings', () => {
  assert.match(MAIN, /ipcMain\.handle\('player-set-bit-perfect'/)
  const start = MAIN.indexOf("ipcMain.handle('player-set-bit-perfect'")
  const body = MAIN.slice(start, start + 400)
  assert.match(body, /_applyPlayerConfig\(\{ bitPerfect: on \}\)/)
  assert.match(body, /settings: getPlayerSettings\(\)/)
})

test('preload exposes playerSetBitPerfect against that channel', () => {
  assert.match(PRELOAD, /playerSetBitPerfect:.*invoke\('player-set-bit-perfect'/)
})
