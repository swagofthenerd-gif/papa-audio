'use strict'
// loadInFlight is what tells the renderer's reconciler "mpv has been asked to
// open a file and has not answered yet, so the path it reports is the OLD one
// and proves nothing". It is derived from _pendingLoad, which used to be set
// once and never cleared — so it answered "has a load ever happened", which is
// true forever after the first track and would have parked the reconciler for
// the rest of the session.
//
// A live soak then found the other half of the same gap (D10): the IPC reply
// only means MAIN sent `loadfile`. mpv opens the file and answers separately,
// and for that window loadInFlight was already false while mpvPath was still
// the file being replaced — 13 "the UI and mpv disagree about what is playing"
// errors across 40 Nexts at a ~650 ms cadence. So the flag now stays true
// until mpv itself speaks, and gives up after a bounded blind window so a load
// mpv silently dropped is still reported.
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
  let onEvent = null
  const window = {
    api: new Proxy({ on(ch, fn) { if (ch === 'player-event') onEvent = fn } }, {
      get: (t, k) => k in t ? t[k] : (...args) => new Promise(res => {
        pending.push({ name: k, args, resolve: res })
      }),
    }),
  }
  new Function('window', 'CustomEvent', 'Event', SRC)(window, CustomEvent, Event)
  return {
    player: window.__papaPlayer,
    pending,
    // mpv answering, the way main relays it.
    mpvSays: (type, data) => onEvent({ type, data }),
  }
}

const tick = () => new Promise(r => setImmediate(r))

// The blind window is a real duration; the test moves the clock rather than
// waiting it out.
const BLIND_MS = Number(/LOAD_SETTLE_BLIND_MS = (\d+)/.exec(SRC)[1])
async function advance (ms) {
  const real = Date.now
  const at = real() + ms
  Date.now = () => at
  try { await tick() } finally { /* leave the clock moved for the assertion */ }
  return () => { Date.now = real }
}

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
  assert.strictEqual(player.loadInFlight, true,
    'the reply is main sending loadfile — mpv has not opened it yet')
})

test('mpv answering is what ends the load, not the IPC reply', async () => {
  const { player, pending, mpvSays } = loadShim()
  player.src = 'file:///m/one.flac'
  pending.find(p => p.name === 'playerLoad').resolve({ ok: true })
  await tick()
  assert.strictEqual(player.mpvPath, null, 'mpv has said nothing yet')
  assert.strictEqual(player.loadInFlight, true)
  mpvSays('trackChanged', '/m/one.flac')
  assert.strictEqual(player.loadInFlight, false,
    'once mpv has answered, its reported path is evidence again')
  assert.strictEqual(player.mpvPath, '/m/one.flac')
})

test('a gapless advance also closes the window', async () => {
  const { player, pending, mpvSays } = loadShim()
  player.src = 'file:///m/one.flac'
  pending.find(p => p.name === 'playerLoad').resolve({ ok: true })
  await tick()
  mpvSays('autoAdvanced', '/m/one.flac')
  assert.strictEqual(player.loadInFlight, false)
})

test('a load mpv never acknowledges is reported again, not hidden for ever', async () => {
  const { player, pending } = loadShim()
  player.src = 'file:///m/one.flac'
  pending.find(p => p.name === 'playerLoad').resolve({ ok: true })
  await tick()
  assert.strictEqual(player.loadInFlight, true)
  const restore = await advance(BLIND_MS + 50)
  try {
    assert.strictEqual(player.loadInFlight, false,
      'blind is a short window, not a permanent excuse — a dropped load is a real disagreement')
  } finally { restore() }
})

test('a load that fails also stops being in flight', async () => {
  const { player, pending } = loadShim()
  player.src = 'file:///m/one.flac'
  pending.find(p => p.name === 'playerLoad').resolve({ ok: false, error: 'no such file' })
  await tick()
  const restore = await advance(BLIND_MS + 50)
  try {
    assert.strictEqual(player.loadInFlight, false,
      'a failed load must not park the reconciler for the rest of the session')
  } finally { restore() }
})

test('a second load supersedes the first without leaving the flag stuck', async () => {
  const { player, pending, mpvSays } = loadShim()
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
  assert.strictEqual(player.loadInFlight, true, 'still waiting on mpv')
  mpvSays('trackChanged', '/m/two.flac')
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
  const { player, pending, mpvSays } = loadShim()
  const sw = player.switchToTrack('https://example.invalid/a')
  assert.strictEqual(player.loadInFlight, true)
  pending.find(p => p.name === 'playerSwitch').resolve({ ok: true })
  await sw
  assert.strictEqual(player.loadInFlight, true, 'the switch landed; mpv has not answered')
  mpvSays('trackChanged', 'https://example.invalid/a')
  assert.strictEqual(player.loadInFlight, false)
})

test('the reconciler stays blind across a fast Next, and only that long', async () => {
  // 40 Nexts at ~650 ms is the soak that produced the 13 errors. One hop:
  // ask, main replies, mpv is still on the old file, mpv catches up.
  const { player, pending, mpvSays } = loadShim()
  mpvSays('trackChanged', '/m/one.flac')
  player.src = 'file:///m/two.flac'
  pending.find(p => p.name === 'playerLoad').resolve({ ok: true })
  await tick()
  assert.strictEqual(player.mpvPath, '/m/one.flac',
    'this stale path is exactly what used to be read as a disagreement')
  assert.strictEqual(player.loadInFlight, true, 'so the reconciler must not look')
  mpvSays('trackChanged', '/m/two.flac')
  assert.strictEqual(player.loadInFlight, false)
  assert.strictEqual(player.mpvPath, '/m/two.flac')
})
