'use strict'
// Quitting left the WebTorrent client running. Nothing ever called
// client.destroy(), so every torrent kept seeding, kept its sockets and kept
// its file handles right up to the moment the process died — and the
// background video downloads kept their own streamers and poll timers
// alongside, so a signal shutdown left half-written files behind.
//
// This runs the real _torrentTeardown lifted from main.js against fakes.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

function lift({ client, downloads }) {
  const start = MAIN.indexOf('let _torrentTornDown = false')
  assert.ok(start > 0, 'main.js must define the torrent teardown')
  const end = MAIN.indexOf('\n}\n', MAIN.indexOf('function _torrentTeardown', start))
  const ctx = {
    _torrentClient: client,
    _videoDownloads: downloads,
    Promise, Map, clearTimeout, setTimeout,
    console: { log() {}, error() {}, warn() {} },
  }
  vm.createContext(ctx)
  vm.runInContext(MAIN.slice(start, end + 2), ctx)
  return {
    teardown: vm.runInContext('_torrentTeardown', ctx),
    client: () => vm.runInContext('_torrentClient', ctx),
  }
}

function fakeDownloads(n) {
  const stopped = []
  const cleared = []
  const m = new Map()
  for (let i = 0; i < n; i++) {
    m.set('d' + i, {
      timer: { id: i },
      streamer: { stop() { stopped.push('d' + i) } },
    })
  }
  // clearInterval in the sandbox records instead of throwing on a fake timer.
  return { map: m, stopped, cleared }
}

test('quitting destroys the torrent client and stops every background download', async () => {
  let destroyed = 0
  const client = { destroy(cb) { destroyed++; setTimeout(cb, 5) } }
  const d = fakeDownloads(3)
  const l = lift({ client, downloads: d.map })
  await l.teardown(1000)
  assert.strictEqual(destroyed, 1, 'the swarm must be told we are going')
  assert.deepStrictEqual(d.stopped.sort(), ['d0', 'd1', 'd2'],
    'every background download streamer must be stopped')
  assert.strictEqual(d.map.size, 0, 'and forgotten')
  assert.strictEqual(l.client(), null, 'the client reference is dropped')
})

test('a destroy that never calls back does not hold the quit open', async () => {
  const client = { destroy() { /* never calls back */ } }
  const d = fakeDownloads(1)
  const l = lift({ client, downloads: d.map })
  const started = Date.now()
  await l.teardown(60)
  const took = Date.now() - started
  assert.ok(took < 1000, 'the wait is bounded; it took ' + took + 'ms')
  assert.deepStrictEqual(d.stopped, ['d0'], 'the downloads are stopped either way')
})

test('a second teardown is a no-op, not a second destroy', async () => {
  let destroyed = 0
  const client = { destroy(cb) { destroyed++; cb() } }
  const l = lift({ client, downloads: fakeDownloads(0).map })
  await l.teardown(100)
  await l.teardown(100)
  assert.strictEqual(destroyed, 1,
    'will-quit and a signal shutdown can both run; the second must not destroy a dead client')
})

test('no client yet is harmless', async () => {
  const l = lift({ client: null, downloads: fakeDownloads(2).map })
  await l.teardown(100)
})

test('both shutdown paths run it', () => {
  const willQuit = MAIN.slice(MAIN.indexOf("app.on('will-quit'"), MAIN.indexOf('\n// Given a saved window rectangle'))
  assert.match(willQuit, /_torrentTeardown\(/, 'a clean quit')
  const sig = MAIN.slice(MAIN.indexOf('function shutdownFromSignal'), MAIN.indexOf('\nfor (const sig of'))
  assert.match(sig, /_torrentTeardown\(/, 'a signal shutdown')
  assert.match(sig, /Promise\.race\(\[torrentsDown/,
    'the exit waits on it, but only briefly')
})

// The per-watch teardown must NOT stop background downloads: stopping a film
// is not a reason to cancel a download the user started.
test('stopping a film does not cancel background downloads', () => {
  const body = MAIN.slice(MAIN.indexOf('function _videoTeardown() {'),
    MAIN.indexOf('\n// mpv dying mid-playback'))
  assert.doesNotMatch(body, /_torrentTeardown/,
    'the per-watch teardown is not the quit teardown')
  assert.doesNotMatch(body, /_videoDownloads/)
})
