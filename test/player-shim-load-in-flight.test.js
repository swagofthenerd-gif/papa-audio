'use strict'
// loadInFlight is what tells the renderer's reconciler "mpv has been asked to
// open a file and has not answered yet, so the path it reports is the OLD one
// and proves nothing". It is derived from _pendingLoad, which used to be set
// once and never cleared — so it answered "has a load ever happened", which is
// true forever after the first track and would have parked the reconciler for
// the rest of the session.
//
// The real player-shim.js is loaded against a fake window, so this follows the
// shipped shim rather than a copy of it.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'player-shim.js'), 'utf8')

// Every IPC call returns a promise this test resolves by hand, so the window
// between asking mpv to open a file and mpv answering is under its control.
function loadShim() {
  const pending = []
  const window = {
    api: new Proxy({ on() {} }, {
      get: (t, k) => k in t ? t[k] : (...args) => new Promise(res => {
        pending.push({ name: k, args, resolve: res })
      }),
    }),
  }
  new Function('window', SRC)(window)
  return { player: window.__papaPlayer, pending }
}

const tick = () => new Promise(r => setImmediate(r))

test('nothing is in flight before anything is asked for', () => {
  const { player } = loadShim()
  assert.strictEqual(player.loadInFlight, false)
})

test('a load is in flight from the moment it is asked for until mpv answers', async () => {
  const { player, pending } = loadShim()
  player.src = 'file:///m/one.flac'
  assert.strictEqual(player.loadInFlight, true,
    'mpv still has the previous file open until it answers')
  const load = pending.find(p => p.name === 'playerLoad')
  assert.ok(load, 'the src setter must still go through playerLoad')
  load.resolve({ ok: true })
  await tick()
  assert.strictEqual(player.loadInFlight, false,
    'once mpv has answered, its reported path is evidence again')
})

test('a load that fails also stops being in flight', async () => {
  const { player, pending } = loadShim()
  player.src = 'file:///m/one.flac'
  pending.find(p => p.name === 'playerLoad').resolve({ ok: false, error: 'no such file' })
  await tick()
  assert.strictEqual(player.loadInFlight, false,
    'a failed load must not park the reconciler for the rest of the session')
})

test('a second load supersedes the first without leaving the flag stuck', async () => {
  const { player, pending } = loadShim()
  player.src = 'file:///m/one.flac'
  const first = pending.find(p => p.name === 'playerLoad')
  player.src = 'file:///m/two.flac'
  const second = pending.filter(p => p.name === 'playerLoad')[1]
  assert.ok(second)
  // The first one lands late, as it does on a slow disk during fast Next.
  first.resolve({ ok: true })
  await tick()
  assert.strictEqual(player.loadInFlight, true,
    'the load that is actually outstanding is the second one')
  second.resolve({ ok: true })
  await tick()
  assert.strictEqual(player.loadInFlight, false)
})

test('play() still waits for the load it was handed', async () => {
  const { player, pending } = loadShim()
  player.src = 'file:///m/one.flac'
  let played = false
  const p = player.play().then(() => { played = true })
  await tick()
  assert.strictEqual(played, false, 'play must not overtake the load')
  assert.ok(!pending.some(x => x.name === 'playerPlay'),
    'and must not have been sent yet')
  pending.find(x => x.name === 'playerLoad').resolve({ ok: true })
  await tick()
  const play = pending.find(x => x.name === 'playerPlay')
  assert.ok(play, 'play is sent once the load has landed')
  play.resolve({ ok: true })
  await p
  assert.strictEqual(played, true)
})

test('an atomic switch counts as in flight too', async () => {
  const { player, pending } = loadShim()
  const sw = player.switchToTrack('https://example.invalid/a')
  assert.strictEqual(player.loadInFlight, true)
  pending.find(p => p.name === 'playerSwitch').resolve({ ok: true })
  await sw
  assert.strictEqual(player.loadInFlight, false)
})
