// electron-store .set() is a synchronous writeFileSync of the WHOLE config, and
// this app's config is ~2.4 MB (libraryCache alone is 1.4 MB). Measured on the
// real file: JSON.stringify 15.6 ms + atomic write/fsync 2.3 ms = 17.9 ms per
// set -- above the 16.7 ms frame budget at 60 Hz.
//
// 'move' fires continuously while a window is dragged, so binding a bare
// store.set to it meant ~1077 ms of blocking main-process work per second of
// drag. The main process owns the window message pump, so it stops responding.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const M = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
const start = M.indexOf('const saveWinState = ')
assert.ok(start > -1, 'saveWinState must exist')
const region = M.slice(start, start + 1800)

test('the move handler does not write synchronously on every event', () => {
  const moveLine = M.slice(M.indexOf("mainWindow.on('move'"), M.indexOf("mainWindow.on('move'") + 120)
  assert.ok(!/store\.set/.test(moveLine), "'move' must not call store.set directly")
})

test('writes are coalesced after motion stops', () => {
  assert.ok(/setTimeout\(/.test(region), 'needs a trailing debounce')
  assert.ok(/clearTimeout\(_winSaveTimer\)/.test(region), 'each event must reset the timer')
})

test('an unchanged position does not write at all', () => {
  assert.ok(/json === _lastWinJson/.test(region),
    'a 17.9 ms write for identical bounds is pure waste')
})

test('quitting flushes instead of losing a pending debounce', () => {
  assert.ok(/saveWinStateNow/.test(M), 'needs an immediate flush path')
  const close = M.slice(M.indexOf("mainWindow.on('close'"), M.indexOf("mainWindow.on('close'") + 200)
  assert.ok(/saveWinStateNow\(\)/.test(close),
    'close must flush, or a debounced move is lost on quit')
})

test('the flush guards against a destroyed window', () => {
  assert.ok(/isDestroyed\(\)/.test(region),
    'the debounce can fire after the window is gone')
})
