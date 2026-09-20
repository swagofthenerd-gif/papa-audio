'use strict'
// The upload half of the sidebar transfer indicator, over IPC. main.js cannot be
// required outside Electron, so this pins the source shape: the existing upload
// poll now remembers a slimmed copy of the current upload rows, and the
// slsk-upload-stats handler hands them to the renderer alongside the counters
// it already returned. No new poller, no new channel.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function handlerBody() {
  const start = MAIN.indexOf("ipcMain.handle('slsk-upload-stats'")
  assert.ok(start > 0, 'the slsk-upload-stats handler still exists')
  const end = MAIN.indexOf('ipcMain.handle(', start + 10)
  return MAIN.slice(start, end > 0 ? end : start + 2000)
}

test('the upload poll remembers the current rows in a module-level cache', () => {
  assert.match(MAIN, /let _lastUploadRows = \[\]/,
    'the cache is declared once, beside the poll')
  const start = MAIN.indexOf('async function slskUploadPollOnce')
  const body = MAIN.slice(start, MAIN.indexOf('function slskUploadPollStart'))
  assert.match(body, /_lastUploadRows = slimUploadRows\(uploads\)/,
    'the poll slims the snapshot it already fetched')
})

test('the slimmer keeps only the five fields the panel needs', () => {
  const start = MAIN.indexOf('function slimUploadRows')
  assert.ok(start > 0, 'slimUploadRows exists')
  const body = MAIN.slice(start, start + 1600)
  for (const field of ['filename', 'username', 'state', 'percentComplete', 'averageSpeed']) {
    assert.match(body, new RegExp('\\b' + field + ':'), field + ' is kept')
  }
  // Nothing else rides along: a peer-controlled row must not carry unknown keys
  // across the bridge.
  const kept = body.match(/^\s{6}\w+:/gm) || []
  assert.equal(kept.length, 5, 'exactly five fields, got: ' + kept.join(' '))
  assert.ok(!/bytesTransferred:/.test(body), 'the byte counter stays in upload-stats')
})

test('the slimmer walks the same three shapes slskd answers with', () => {
  const start = MAIN.indexOf('function slimUploadRows')
  const body = MAIN.slice(start, start + 1600)
  assert.match(body, /u\.directories/, 'grouped user -> directories -> files')
  assert.match(body, /u\.files/, 'flat-per-user')
})

test('the handler returns the rows with the counters', () => {
  const body = handlerBody()
  assert.match(body, /rows: _lastUploadRows/,
    'the success path carries the current rows')
})

test('an unreachable daemon still answers, with no rows', () => {
  const body = handlerBody()
  const tail = body.slice(body.indexOf('rolled'))
  assert.match(tail, /ok: true/, 'the failure path keeps the ok shape')
  assert.match(tail, /rows: \[\]/, 'no rows rather than stale ones')
  assert.match(tail, /totalUploadedToday: rolled\.totalUploadedToday/)
})

test('no second upload poller was added for the rows', () => {
  const timers = MAIN.match(/setInterval\(\(\) => \{ slskUploadPollOnce\(\) \}/g) || []
  assert.ok(timers.length <= 2, 'still only the existing poll/retune pair, got ' + timers.length)
})
