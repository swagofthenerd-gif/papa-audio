'use strict'
// A written record of what a source switch actually did.
//
// Every attempt to fix the switch was reasoned from reading the code, and each
// fixed something real without fixing what he was seeing. The switch spans two
// processes and a dozen decisions, any of which can be the one that stops.
// This exists so the next fault is READ rather than guessed at.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const T = require('../src/switch-trace')

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-trace-'))
  T.setDir(d)
  return d
}
const lines = (d) => fs.readFileSync(path.join(d, T.NAME), 'utf8').trim().split('\n').map(JSON.parse)

test('each step is one readable line, timed from the start of the switch', () => {
  const d = tmp()
  T.begin({ magnet: 'abc', episode: 1 })
  T.write('torn-down', { hadStreamer: true })
  const out = lines(d)
  assert.strictEqual(out.length, 2)
  assert.strictEqual(out[0].step, 'BEGIN')
  assert.strictEqual(out[0].episode, 1)
  assert.strictEqual(out[1].step, 'torn-down')
  assert.strictEqual(out[1].hadStreamer, true)
  for (const l of out) {
    assert.ok(typeof l.ms === 'number', 'every line carries the time since the switch began')
    assert.ok(typeof l.at === 'string')
  }
})

test('a debrid URL is never written down — it carries the account token', () => {
  const secret = 'https://rd.example/d/TOKEN0123456789ABCDEF/file.mkv'
  const shape = T.safeUrl(secret)
  assert.ok(!shape.includes('TOKEN0123456789ABCDEF'), 'the token must not appear: ' + shape)
  assert.match(shape, /^https:\/\/rd\.example/, 'the host is useful and safe')
  assert.match(shape, /\+\d+ chars/, 'and the rest is recorded only as a length')
  const d = tmp()
  T.begin({})
  T.write('debrid-ok', { url: T.safeUrl(secret) })
  assert.ok(!fs.readFileSync(path.join(d, T.NAME), 'utf8').includes('TOKEN0123456789ABCDEF'))
})

test('a malformed url is still not written out verbatim', () => {
  assert.strictEqual(T.safeUrl('not a url at all'), '(16 chars)')
  assert.strictEqual(T.safeUrl(''), null)
  assert.strictEqual(T.safeUrl(null), null)
})

test('it cannot grow without bound', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, T.NAME), 'x'.repeat(T.CAP_BYTES + 10))
  T.begin({ magnet: 'after-the-cap' })
  const text = fs.readFileSync(path.join(d, T.NAME), 'utf8')
  assert.ok(text.length < T.CAP_BYTES, 'the old contents are dropped past the cap')
  assert.match(text, /after-the-cap/, 'and the new line is kept')
})

test('with nowhere to write it stays silent instead of throwing', () => {
  // It runs inside playback: a broken trace must never break a switch.
  T.setDir(null)
  assert.doesNotThrow(() => { T.begin({ magnet: 'x' }); T.write('step', { a: 1 }) })
  T.setDir('/definitely/not/a/real/directory/anywhere')
  assert.doesNotThrow(() => { T.begin({ magnet: 'x' }); T.write('step', { a: 1 }) })
})

test('both halves of the switch write into the same record', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /switchTrace\.begin\(/, 'main records the switch beginning')
  assert.match(main, /ipcMain\.handle\('video-trace'/, 'and the page has a channel of its own')
  assert.match(main, /switchTrace\.write\('ui:'/, 'marked so the two halves are told apart')
  const r = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  for (const step of ['pick', 'commit', 'abandon', 'adopt']) {
    assert.ok(r.includes("_switchTrace('" + step + "'"), 'the page records ' + step)
  }
})
