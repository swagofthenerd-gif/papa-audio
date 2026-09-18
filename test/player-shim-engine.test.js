'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'player-shim.js'), 'utf8')

// player-shim.js is a classic script that ends by assigning window.__papaPlayer.
// Loading it with a fake window is enough to drive it: everything it touches in
// the constructor is window.api.on, and the rest is DOM-free.
function loadShim() {
  const calls = []
  let emit = null
  const window = {
    api: new Proxy({
      on: (channel, cb) => { if (channel === 'player-event') emit = cb },
    }, {
      get: (t, k) => k in t ? t[k] : (...args) => { calls.push([k, ...args]); return Promise.resolve({ ok: true }) },
    }),
  }
  new Function('window', SRC)(window)
  return { player: window.__papaPlayer, emit: (type, data) => emit({ type, data }), calls }
}

// Same loader, but every IPC call resolves to whatever `respond` returns.
function loadShimWith(respond) {
  let emit = null
  const window = {
    api: new Proxy({
      on: (channel, cb) => { if (channel === 'player-event') emit = cb },
    }, {
      get: (t, k) => k in t ? t[k] : (...args) => respond(k, ...args),
    }),
  }
  new Function('window', SRC)(window)
  return { player: window.__papaPlayer, emit: (type, data) => emit({ type, data }) }
}

function captured(player, name) {
  const seen = []
  player.addEventListener(name, e => seen.push(e))
  return seen
}

test('the shim delivers every engine lifecycle event it is sent', () => {
  const { player, emit } = loadShim()
  // main.js forwards all four. Before this, the shim had no case for any of
  // them, so they arrived and vanished — which is why a respawn was invisible.
  const cases = [
    ['engineDown', 'enginedown'],
    ['engineRecovered', 'enginerecovered'],
    ['stopped', 'enginestopped'],
    ['engineFailed', 'enginefailed'],
  ]
  for (const [incoming, outgoing] of cases) {
    const seen = captured(player, outgoing)
    emit(incoming, {})
    assert.strictEqual(seen.length, 1, `${incoming} produced no ${outgoing}`)
  }
})

test('engineDown stops the shim claiming it is playing, and says if recovery is coming', () => {
  const { player, emit } = loadShim()
  const seen = captured(player, 'enginedown')
  emit('paused', false)
  assert.strictEqual(player.paused, false)
  emit('engineDown', { willRecover: true, path: '/music/a.flac', position: 85.2 })
  assert.strictEqual(player.paused, true, 'the UI must stop saying "playing" during the gap')
  assert.strictEqual(player.engineDown, true)
  assert.strictEqual(seen[0].detail.willRecover, true)
  assert.strictEqual(seen[0].detail.position, 85.2)
})

test('engineRecovered puts the shim back where mpv actually is', () => {
  const { player, emit } = loadShim()
  const seen = captured(player, 'enginerecovered')
  emit('engineDown', { willRecover: true })
  emit('engineRecovered', { resumed: true, wasPlaying: true, position: 85.2, path: '/music/a.flac' })
  assert.strictEqual(player.engineDown, false)
  assert.strictEqual(player.paused, false, 'it was playing before the crash, so it is playing now')
  assert.strictEqual(player.currentTime, 85.2, 'resumed at the same position, not at zero')
  assert.strictEqual(seen[0].detail.resumed, true)
})

test('recovering while paused stays paused', () => {
  const { player, emit } = loadShim()
  emit('engineDown', { willRecover: true })
  emit('engineRecovered', { resumed: true, wasPlaying: false, position: 12 })
  assert.strictEqual(player.paused, true)
})

test('an unexplained stop carries the reason mpv gave', () => {
  const { player, emit } = loadShim()
  const seen = captured(player, 'enginestopped')
  emit('stopped', { reason: 'stop', path: '/music/06 - The Snow Goose.flac', position: 85.2, duration: 192 })
  assert.strictEqual(player.paused, true)
  // Not 'ended': nothing finished, so the renderer must not treat it as a
  // normal track end and advance the album.
  assert.strictEqual(player.ended, false)
  assert.strictEqual(seen[0].detail.reason, 'stop')
  assert.strictEqual(seen[0].detail.position, 85.2)
})

test('engineFailed carries the reason, not a bare event', () => {
  const { player, emit } = loadShim()
  const seen = captured(player, 'enginefailed')
  emit('engineFailed', { reason: 'respawn-limit', detail: 'mpv died 4 times in 60s', log: ['[error] Audio device lost'] })
  assert.strictEqual(player.paused, true)
  assert.strictEqual(seen[0].detail.reason, 'respawn-limit')
  assert.deepStrictEqual(seen[0].detail.log, ['[error] Audio device lost'])
})

test('a payload-free engine event does not throw', () => {
  const { player, emit } = loadShim()
  for (const type of ['engineDown', 'engineRecovered', 'stopped', 'engineFailed']) {
    assert.doesNotThrow(() => emit(type, undefined), `${type} with no data`)
  }
  assert.strictEqual(player.paused, true)
})

// ── Item 14: one source of truth for paused ─────────────────────────────────

test('mpv is the authority on paused once it has spoken', () => {
  const { player, emit } = loadShim()
  emit('paused', false)
  assert.strictEqual(player.paused, false)
  emit('paused', true)
  assert.strictEqual(player.paused, true)
})

test('a click flips paused immediately, before mpv has confirmed it', async () => {
  // Waiting for the round trip left `paused` reading true mid-flight, so a
  // second click saw "still paused" and started a second play instead of
  // pausing — rapid toggling silently dropped every other click.
  const { player, emit } = loadShim()
  emit('paused', true)
  const playing = player.play()
  assert.strictEqual(player.paused, false, 'the optimistic value must apply at once')
  await playing
  assert.strictEqual(player.paused, false)
})

test('mpv confirming the optimistic value retires the overlay', () => {
  const { player, emit } = loadShim()
  emit('paused', true)
  player.play()
  assert.strictEqual(player._pausedGuess, false)
  emit('paused', false)
  assert.strictEqual(player._pausedGuess, null, 'a confirmed guess is no longer a guess')
  assert.strictEqual(player.paused, false)
})

test('mpv contradicting the optimistic value wins once the overlay expires', () => {
  const { player, emit } = loadShim()
  emit('paused', true)
  player.play()
  assert.strictEqual(player.paused, false, 'the guess holds while it is fresh')
  // mpv says otherwise, and never agrees.
  emit('paused', true)
  // Two independent writers with no expiry is how these ended up disagreeing
  // and both staying wrong after an engineDown.
  player._pausedGuessUntil = Date.now() - 1
  assert.strictEqual(player.paused, true, 'an expired guess must not outrank mpv')
  assert.strictEqual(player._pausedGuess, null, 'and reading it must retire it')
})

test('a play that mpv rejects stops asserting that it happened', async () => {
  const { player, emit } = loadShim()
  emit('paused', true)
  player.api = null
  // Make the IPC call fail.
  const failing = loadShimWith(() => Promise.resolve({ ok: false, error: 'engine unavailable' }))
  failing.emit('paused', true)
  await assert.rejects(() => failing.player.play())
  assert.strictEqual(failing.player.paused, true, 'it never started, so it is still paused')
})

test('engineDown voids any optimistic value outright', () => {
  const { player, emit } = loadShim()
  emit('paused', false)
  player.play()
  emit('engineDown', { willRecover: true })
  assert.strictEqual(player._pausedGuess, null, 'there is no mpv left to confirm it')
  assert.strictEqual(player.paused, true)
})

// ── Item 13: a failed prefetch has to be observable ─────────────────────────

test('setNext returns its result instead of being fire-and-forget', () => {
  const { player } = loadShim()
  const r = player.setNext('/music/b.flac')
  assert.ok(r && typeof r.then === 'function',
    'the first symptom of a silent prefetch failure is the album stopping at a boundary')
})

test('the events that already worked still work', () => {
  const { player, emit } = loadShim()
  const err = captured(player, 'error')
  const adv = captured(player, 'autoadvanced')
  const ended = captured(player, 'ended')
  emit('loadError', '/music/gone.flac')
  emit('autoAdvanced', '/music/b.flac')
  emit('ended', undefined)
  emit('duration', 192)
  emit('position', 12.5)
  assert.strictEqual(err[0].detail.src, '/music/gone.flac')
  assert.strictEqual(adv[0].detail, '/music/b.flac')
  assert.strictEqual(ended.length, 1)
  assert.strictEqual(player.duration, 192)
  assert.strictEqual(player.currentTime, 12.5)
})

// ── Items 127 and 128: what mpv actually has open, and whether it is moving ──

test('the shim records the path mpv reports, not the one the renderer asked for', () => {
  const { player, emit } = loadShim()
  assert.strictEqual(player.mpvPath, null)
  emit('trackChanged', '/music/06 - The Snow Goose.flac')
  assert.strictEqual(player.mpvPath, '/music/06 - The Snow Goose.flac')
  emit('autoAdvanced', '/music/07 - Rhayader Alone.flac')
  assert.strictEqual(player.mpvPath, '/music/07 - Rhayader Alone.flac')
})

test('trackChanged reaches the renderer instead of being dropped', () => {
  // It was dropped on the grounds that the renderer issued the load and so
  // already knows. It knows what it ASKED for; this is what mpv is playing, and
  // that is the thing several desync findings turn on.
  const { player, emit } = loadShim()
  const seen = captured(player, 'trackchanged')
  emit('trackChanged', '/music/a.flac')
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].detail, '/music/a.flac')
})

test('position age tells a frozen bar apart from a paused one', () => {
  const { player, emit } = loadShim()
  // Nothing has ever been loaded, so there is no bar that could be frozen.
  // This used to answer Infinity, which the renderer's watchdog printed into
  // its warning verbatim.
  assert.strictEqual(player.positionAgeMs, 0, 'nothing playing is not a stall')
  emit('position', 12.5)
  assert.ok(player.positionAgeMs < 50)
})

test('loading a new track restarts the position age from the load', () => {
  const { player, emit } = loadShim()
  emit('position', 12.5)
  assert.ok(player.positionAgeMs < 50)
  player.src = 'file:///music/b.flac'
  const age = player.positionAgeMs
  assert.ok(Number.isFinite(age), 'the age of a just-loaded track is a real duration')
  assert.ok(age < 50, 'and it is measured from the load, not from mpv first replying')
})

test('the age is always a finite number of milliseconds', () => {
  // The whole of the "has not moved for Infinityms" report: every state the
  // shim can be in has to answer with a duration.
  const { player, emit } = loadShim()
  const states = [
    () => {},
    () => { player.src = 'file:///music/a.flac' },
    () => emit('paused', false),
    () => emit('paused', true),
    () => emit('position', 3),
    () => emit('autoAdvanced', '/music/b.flac'),
    () => emit('engineDown', {}),
    () => emit('ended', null),
  ]
  for (const step of states) {
    step()
    assert.ok(Number.isFinite(player.positionAgeMs),
      'positionAgeMs went non-finite: ' + player.positionAgeMs)
  }
})
