'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { resolve, ACTIONS } = require('../src/video-keymap')

function ev(key, mods = {}) {
  return { key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods }
}

test('space and k play/pause', () => {
  assert.deepStrictEqual(resolve(ev(' ')), { action: ACTIONS.PLAY_PAUSE })
  assert.deepStrictEqual(resolve(ev('k')), { action: ACTIONS.PLAY_PAUSE })
  assert.deepStrictEqual(resolve(ev('K')), { action: ACTIONS.PLAY_PAUSE })
})

test('arrows seek ±10, ±60 with shift', () => {
  assert.deepStrictEqual(resolve(ev('ArrowRight')), { action: ACTIONS.SEEK, arg: 10 })
  assert.deepStrictEqual(resolve(ev('ArrowLeft')), { action: ACTIONS.SEEK, arg: -10 })
  assert.deepStrictEqual(resolve(ev('ArrowRight', { shiftKey: true })), { action: ACTIONS.SEEK, arg: 60 })
  assert.deepStrictEqual(resolve(ev('ArrowLeft', { shiftKey: true })), { action: ACTIONS.SEEK, arg: -60 })
  assert.deepStrictEqual(resolve(ev('j')), { action: ACTIONS.SEEK, arg: -10 })
  assert.deepStrictEqual(resolve(ev('l')), { action: ACTIONS.SEEK, arg: 10 })
})

test('up/down adjust volume by a step', () => {
  assert.deepStrictEqual(resolve(ev('ArrowUp')), { action: ACTIONS.VOLUME, arg: 5 })
  assert.deepStrictEqual(resolve(ev('ArrowDown')), { action: ACTIONS.VOLUME, arg: -5 })
})

test('comma/period frame-step, brackets step speed', () => {
  assert.deepStrictEqual(resolve(ev(',')), { action: ACTIONS.FRAME, arg: -1 })
  assert.deepStrictEqual(resolve(ev('.')), { action: ACTIONS.FRAME, arg: 1 })
  assert.deepStrictEqual(resolve(ev('[')), { action: ACTIONS.SPEED, arg: -1 })
  assert.deepStrictEqual(resolve(ev(']')), { action: ACTIONS.SPEED, arg: 1 })
})

test('single-letter commands map to their actions', () => {
  const table = {
    f: ACTIONS.FULLSCREEN, m: ACTIONS.MUTE, c: ACTIONS.SUBTITLES,
    v: ACTIONS.AUDIO_TRACK, s: ACTIONS.SKIP, n: ACTIONS.NEXT,
    p: ACTIONS.PREV, t: ACTIONS.THEATRE, i: ACTIONS.STATS, b: ACTIONS.BOOKMARK,
  }
  for (const [key, action] of Object.entries(table)) {
    assert.deepStrictEqual(resolve(ev(key)), { action }, key)
  }
})

test('Escape exits', () => {
  assert.deepStrictEqual(resolve(ev('Escape')), { action: ACTIONS.EXIT })
})

test('slash focuses search, shift-slash opens the shortcut sheet', () => {
  assert.deepStrictEqual(resolve(ev('/')), { action: ACTIONS.FOCUS_SEARCH })
  assert.deepStrictEqual(resolve(ev('/', { shiftKey: true })), { action: ACTIONS.SHORTCUTS })
  assert.deepStrictEqual(resolve(ev('?')), { action: ACTIONS.SHORTCUTS })
})

test('digits seek to a percentage of the file', () => {
  assert.deepStrictEqual(resolve(ev('0')), { action: ACTIONS.SEEK_TO, arg: 0 })
  assert.deepStrictEqual(resolve(ev('5')), { action: ACTIONS.SEEK_TO, arg: 0.5 })
  assert.deepStrictEqual(resolve(ev('9')), { action: ACTIONS.SEEK_TO, arg: 0.9 })
})

test('focus in an input returns null for every key', () => {
  for (const key of [' ', 'k', 'ArrowRight', 'f', '/', '5']) {
    assert.strictEqual(resolve(ev(key), { isInput: true }), null, key)
  }
})

test('Ctrl/Alt/Meta combos are left to the browser/OS', () => {
  assert.strictEqual(resolve(ev('f', { ctrlKey: true })), null)
  assert.strictEqual(resolve(ev('s', { metaKey: true })), null)
  assert.strictEqual(resolve(ev('ArrowLeft', { altKey: true })), null)
})

test('unknown keys and non-key events return null', () => {
  assert.strictEqual(resolve(ev('q')), null)
  assert.strictEqual(resolve(ev('z')), null)
  assert.strictEqual(resolve(ev('Shift')), null)
  assert.strictEqual(resolve(null), null)
  assert.strictEqual(resolve({ key: undefined }), null)
})

test('shift does not break letter keys', () => {
  // Shift+F is still fullscreen, not a different command.
  assert.deepStrictEqual(resolve(ev('F', { shiftKey: true })), { action: ACTIONS.FULLSCREEN })
})
