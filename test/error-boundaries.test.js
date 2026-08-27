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

// ── Item 114: a card that can be acted on ─────────────────────────────────

test('the failure card carries a copyable stack, not just a message', () => {
  // The stack reached devtools and nowhere else, so a report of this card could
  // not be acted on. The person looking at it is not the person who fixes it.
  const fn = R.slice(R.indexOf('function _renderFailure'), R.indexOf('function setContent'))
  assert.ok(/err && err\.stack/.test(fn), 'the stack has to be in the card')
  assert.ok(/render-fail-copy/.test(fn) && /clipboard\.writeText\(diagnostics\)/.test(fn))
  assert.ok(/render-fail-details/.test(fn), 'collapsed by default, not a wall of text')
  // A clipboard write can be refused; falling back to showing the text matters
  // more here than anywhere else in the app.
  const copy = fn.slice(fn.indexOf('render-fail-copy'))
  assert.ok(/\.catch\(/.test(copy) && /pre\.style\.display = ''/.test(copy))
})

test('the diagnostics identify the session and the build', () => {
  const fn = R.slice(R.indexOf('function _renderFailure'), R.indexOf('function setContent'))
  for (const field of ['session: ', 'page: ', 'app: ', 'when: ']) {
    assert.ok(fn.includes(field), `diagnostics must include "${field}"`)
  }
})

// ── Item 115: one id across both log streams ─────────────────────────────

test('main stamps a session id on every log line', () => {
  assert.ok(/const SESSION_ID = crypto\.randomBytes/.test(M))
  assert.ok(/\[\$\{SESSION_ID\}\]/.test(M), 'it has to be in the line, not just in memory')
})

test('the renderer can read the same id', () => {
  assert.ok(/ipcMain\.handle\('get-session-id'/.test(M))
  assert.ok(/window\.api\.getSessionId\(\)/.test(R))
  assert.ok(/_sessionId = /.test(R))
})
