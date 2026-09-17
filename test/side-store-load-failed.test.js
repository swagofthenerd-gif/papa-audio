'use strict'
// An unreadable store must stay distinguishable from an empty one.
//
// SideStore renames a damaged file aside and adopts its fallback, which is the
// right call — but the value in memory is then the FALLBACK, and nothing said
// so. For the video store that fallback is null, which is exactly what a
// genuine first run looks like: the watch history, Continue Watching and My
// List all came back blank, the next play wrote that emptiness through, and the
// launch after that overwrote the rolling backup kept for exactly this case.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { SideStore } = require('../side-store')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'papa-lf-'))

test('a clean load leaves the flag down', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ real: true }))
  const s = new SideStore({ dir, name: 's', fallback: null, debounceMs: 0 })
  assert.deepStrictEqual(s.get(), { real: true })
  assert.strictEqual(s.loadFailed, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a genuinely absent file is NOT a failure', () => {
  const dir = tmpdir()
  const s = new SideStore({ dir, name: 'missing', fallback: null, debounceMs: 0 })
  assert.strictEqual(s.get(), null)
  assert.strictEqual(s.loadFailed, false, 'a first run must not look like damage')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an unreadable file raises the flag', () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 's.json'), '{ this is not json')
  const s = new SideStore({ dir, name: 's', fallback: null, debounceMs: 0 })
  assert.strictEqual(s.get(), null, 'the fallback is adopted, as before')
  assert.strictEqual(s.loadFailed, true, 'but the caller can now tell')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the flag is STICKY — a later write must not clear it', () => {
  // The value in memory is still the fallback plus whatever has been written
  // since; the data that was on disk is gone either way. A flag that cleared
  // itself would make the damage invisible again on the second read.
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, 's.json'), 'not json at all')
  const s = new SideStore({ dir, name: 's', fallback: null, debounceMs: 0 })
  s.get()
  assert.strictEqual(s.loadFailed, true)
  s.set({ written: 'later' })
  s.get()
  assert.strictEqual(s.loadFailed, true, 'still true after a write and a re-read')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the video-store read handler reports unreadable rather than empty', () => {
  const at = MAIN.indexOf("ipcMain.handle('video-store-read'")
  assert.ok(at > -1, 'the handler must still exist')
  const body = MAIN.slice(at, MAIN.indexOf('\n})', at)).replace(/^[ \t]*\/\/.*$/gm, '')
  assert.match(body, /loadFailed/, 'it must consult the flag')
  assert.match(body, /return false/, 'and answer with the unreadable signal')
})
