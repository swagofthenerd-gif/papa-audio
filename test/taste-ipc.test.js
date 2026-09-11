'use strict'
// The taste pipeline's IPC shape. tasteRecordPlay was ipcRenderer.send —
// which returns undefined — while the renderer chains .catch() on it and
// refreshes the taste pills afterwards. That mismatch was the app's only
// recurring uncaught TypeError (once per qualifying track), and it silently
// killed the profile refresh. Recording always worked; the refresh never ran.
// These pins keep both ends promise-shaped so it cannot quietly regress.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

test('tasteRecordPlay is invoke-shaped end to end', () => {
  assert.match(PRELOAD, /tasteRecordPlay: \(d\) => ipcRenderer\.invoke\('taste-record-play', d\)/)
  assert.match(MAIN, /ipcMain\.handle\('taste-record-play'/)
  assert.doesNotMatch(MAIN, /ipcMain\.on\('taste-record-play'/)
})

test('the renderer still chains on the returned promise and refreshes the profile', () => {
  const at = RENDERER.indexOf("tasteRecordPlay({ artist, album, title })")
  assert.ok(at > -1)
  const after = RENDERER.slice(at, at + 300)
  assert.match(after, /\.catch\(/)
  assert.match(after, /tasteGetProfile\(\)/)
})
