// Two crash classes this app had no defence against.
//
// Main: under Node 18+ an unhandled rejection TERMINATES the process, and
// main.js is full of un-awaited async IPC and network calls. One rejected
// promise from a background YouTube or slskd request killed the app mid-song.
//
// Renderer: a page is built as ONE HTML string and assigned in one go, so a
// single bad record thrown mid-build left #content empty with no way back.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const M = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
const R = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8')

test('the main process survives an unhandled rejection', () => {
  assert.ok(/process\.on\('unhandledRejection'/.test(M))
  assert.ok(/process\.on\('uncaughtException'/.test(M))
})

test('the handlers are registered before any async work starts', () => {
  const at = M.indexOf("process.on('unhandledRejection'")
  const ready = M.indexOf('app.whenReady()')
  assert.ok(at > -1 && at < ready,
    'registering after whenReady leaves the startup window unprotected')
})

test('a dead renderer is reported, not left as a blank window', () => {
  assert.ok(/render-process-gone/.test(M),
    'renderer-process-limit is 1, so a crash means a blank frameless window')
})

test('a throw during page render cannot blank the app', () => {
  const nav = R.slice(R.indexOf('function navigate(page'), R.indexOf('function navigateBack'))
  assert.ok(/\bcatch \(err\) \{\s*\n\s*_renderFailure\(page, err\)/.test(nav),
    'the page dispatch must be guarded')
  assert.ok(/function _renderFailure/.test(R), 'and it needs a fallback view')
})

test('the fallback offers a way out', () => {
  const fn = R.slice(R.indexOf('function _renderFailure'), R.indexOf('function setContent'))
  assert.ok(/render-fail-home/.test(fn) && /navigate\('home'\)/.test(fn),
    'a dead end is barely better than a blank page')
})
