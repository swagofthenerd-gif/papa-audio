'use strict'
// library.json is NOT dead code, though nothing inside the app reads it: the
// papa-audio GNOME Shell panel extension reads it on an 800 ms poll to draw
// its album list. So it stays — but it used to be a 618 KB JSON.stringify plus
// a SYNCHRONOUS writeFileSync on every scan and every file-watcher event, on
// the same thread that drives mpv's IPC and the UI.
//
// These lift the real writer out of main.js and run it against a temp file.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function liftWriter(dir) {
  const start = MAIN.indexOf('const LIBRARY_EXT_DEBOUNCE_MS')
  assert.ok(start > 0, 'main.js must define the debounced library.json writer')
  const end = MAIN.indexOf('\nlet _lastNotifiedId', start)
  assert.ok(end > start)
  const timers = []
  const ctx = {
    fs,
    LIBRARY_EXT_PATH: path.join(dir, 'library.json'),
    console: { log() {}, error() {}, warn() {} },
    Promise, JSON, Array, Object, Number, String, Boolean,
    setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t },
    clearTimeout: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) },
  }
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(start, end), ctx)
  return {
    ctx, timers,
    write: vm.runInContext('writeLibraryExt', ctx),
    flushSync: vm.runInContext('flushLibraryExtSync', ctx),
    // The timer callback kicks off an async write and returns, so settling it
    // means waiting for the file, not for the callback.
    async runTimers() {
      while (timers.length) { const t = timers.shift(); await t.fn() }
      for (let i = 0; i < 200; i++) {
        if (fs.existsSync(path.join(dir, 'library.json')) &&
            !fs.existsSync(path.join(dir, 'library.json.tmp'))) return
        await new Promise(r => setTimeout(r, 5))
      }
    },
  }
}

const album = n => ({
  id: 'a' + n, name: 'Album ' + n, artist: 'Artist', artPath: null, isHiRes: true,
  maxBitsPerSample: 24, maxSampleRate: 96000,
  tracks: [{ title: 'T', filePath: '/mnt/data/MUSIC/' + n + '.flac', trackNumber: 1, duration: 200, sampleRate: 96000, bitsPerSample: 24 }],
})

test('a scan does not write the file on the calling thread', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-libext-'))
  try {
    const w = liftWriter(dir)
    w.write([album(1)])
    assert.strictEqual(fs.existsSync(path.join(dir, 'library.json')), false,
      'the write must be deferred, not done synchronously in the scan')
    assert.strictEqual(w.timers.length, 1, 'it is scheduled')
    await w.runTimers()
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'))
    assert.strictEqual(out.length, 1)
    assert.strictEqual(out[0].name, 'Album 1')
    assert.strictEqual(out[0].tracks[0].sampleRate, 96000, 'the shape the extension reads is unchanged')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a burst of watcher events collapses to one write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-libext-'))
  try {
    const w = liftWriter(dir)
    for (let i = 1; i <= 50; i++) w.write([album(i)])
    assert.strictEqual(w.timers.length, 1,
      '50 watcher events must not schedule 50 writes')
    await w.runTimers()
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'))
    assert.strictEqual(out[0].name, 'Album 50', 'and the last state wins')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// The extension polls every 800 ms. A plain write into the live path can be
// caught half done; a rename cannot.
test('the file is swapped in whole, never written in place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-libext-'))
  try {
    const w = liftWriter(dir)
    w.write([album(1)])
    await w.runTimers()
    assert.strictEqual(fs.existsSync(path.join(dir, 'library.json.tmp')), false,
      'the temp file is renamed away, not left behind')
    const block = MAIN.slice(MAIN.indexOf('async function _flushLibraryExt'),
      MAIN.indexOf('\nfunction flushLibraryExtSync'))
    assert.match(block, /fs\.promises\.writeFile/, 'the write is asynchronous')
    assert.match(block, /fs\.promises\.rename/, 'and lands by rename')
    assert.doesNotMatch(block, /writeFileSync/, 'nothing synchronous on this path')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a pending write still lands on the way out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papa-libext-'))
  try {
    const w = liftWriter(dir)
    w.write([album(7)])
    w.flushSync()
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'))
    assert.strictEqual(out[0].name, 'Album 7',
      'quitting before the debounce fires must not lose the scan')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('both shutdown paths flush it', () => {
  const willQuit = MAIN.slice(MAIN.indexOf("app.on('will-quit'"), MAIN.indexOf('\n// Given a saved window rectangle'))
  assert.match(willQuit, /flushLibraryExtSync\(\)/)
  const sig = MAIN.slice(MAIN.indexOf('function shutdownFromSignal'), MAIN.indexOf('\nfor (const sig of'))
  assert.match(sig, /flushLibraryExtSync\(\)/)
})
