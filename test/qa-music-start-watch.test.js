'use strict'
// L14 — "Play was accepted but nothing is sounding yet…" while the position
// was visibly advancing.
//
// _armMusicStartWatch snapshotted audio.currentTime as its baseline, but it is
// called from inside .then() — AFTER the play() promise resolves. With mpv that
// can be well after the clock has started moving, so the baseline was already a
// few seconds in. Six seconds later the check "has it moved past the baseline?"
// could still come out false — most obviously when the queue had moved on to
// the next track, which resets currentTime to near zero.
//
// The baseline is now read before play() is asked for, and any position event
// since arming counts as progress whatever the clock reads.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(source, name) {
  const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(source)
  assert.ok(m, `${name} not found in the renderer`)
  const start = m.index + 1
  const end = source.indexOf('\n}\n', start)
  assert.ok(end > start, `${name} has no closing brace`)
  return source.slice(start, end + 2)
}

// A fake timeline: nothing happens until the test advances it, so the six
// second wait is instant and exact.
function harness(source, { currentTime = 0, paused = false, isPlaying = true } = {}) {
  const timers = []
  const snackbars = []
  const listeners = {}
  const audio = {
    currentTime, paused,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
  }
  const ctx = {
    console, Number,
    audio,
    state: { isPlaying },
    snackbars,
    showSnackbar(msg, action, fn, ms) { snackbars.push({ msg, action, fn, ms }) },
    playCurrentTrack() {},
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cancelled = true },
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext([
    'var _musicStartWatch = null',
    source.slice(source.indexOf('// Every position event the engine emits, counted.'),
      source.indexOf('function _onPlayRefused(')),
    lift(source, '_armMusicStartWatch'),
    lift(source, '_disarmMusicStartWatch'),
  ].join('\n'), ctx)
  return {
    ctx, audio, snackbars,
    arm: (at) => vm.runInContext('_armMusicStartWatch(' + (at === undefined ? '' : at) + ')', ctx),
    disarm: () => vm.runInContext('_disarmMusicStartWatch()', ctx),
    tick(n = 1) { for (let i = 0; i < n; i++) for (const fn of listeners.timeupdate || []) fn() },
    fire() {
      const t = timers.find(t => !t.cancelled && !t.fired)
      assert.ok(t, 'a watchdog must have been armed')
      assert.strictEqual(t.ms, 6000)
      t.fired = true
      t.fn()
    },
    armed: () => timers.filter(t => !t.cancelled && !t.fired).length,
  }
}

test('a track that never moves still gets the warning', () => {
  const h = harness(RENDERER, { currentTime: 0 })
  h.arm(0)
  h.fire()
  assert.strictEqual(h.snackbars.length, 1)
  assert.match(h.snackbars[0].msg, /nothing is sounding yet/)
  assert.strictEqual(h.snackbars[0].action, 'Retry')
})

test('a clock that has advanced past the baseline is silent, as before', () => {
  const h = harness(RENDERER, { currentTime: 0 })
  h.arm(0)
  h.audio.currentTime = 4.5
  h.fire()
  assert.deepStrictEqual(h.snackbars, [])
})

test('the baseline is the position play was asked from, not the one when it resolved', () => {
  // The reported case: the promise settled at 3.0s, so the old code baselined
  // there. The caller asked for play at 0.
  const h = harness(RENDERER, { currentTime: 3.0 })
  h.arm(0)
  h.audio.currentTime = 3.1    // barely past where the promise settled...
  h.fire()
  assert.deepStrictEqual(h.snackbars, [], '...but 3.1s past where play was asked from')
})

test('a track change between arming and the check is progress, not silence', () => {
  // This is what made it fire on "Surprise me": the queue moved on, currentTime
  // reset to near zero, and "did it move past the baseline?" said no.
  const h = harness(RENDERER, { currentTime: 0 })
  h.arm(0)
  h.tick(40)                  // the first track played through
  h.audio.currentTime = 0.1   // ...and the next one only just started
  h.fire()
  assert.deepStrictEqual(h.snackbars, [],
    'the engine was emitting position events the whole time')
})

test('one position event is enough — the engine is alive', () => {
  const h = harness(RENDERER, { currentTime: 0 })
  h.arm(0)
  h.tick(1)
  h.fire()
  assert.deepStrictEqual(h.snackbars, [])
})

test('events from BEFORE arming do not count', () => {
  const h = harness(RENDERER, { currentTime: 0 })
  h.tick(10)      // a previous track's events
  h.arm(0)
  h.fire()
  assert.strictEqual(h.snackbars.length, 1, 'silence after arming is still silence')
})

test('a paused or stopped player says nothing', () => {
  for (const s of [{ paused: true }, { isPlaying: false }]) {
    const h = harness(RENDERER, Object.assign({ currentTime: 0 }, s))
    h.arm(0)
    h.fire()
    assert.deepStrictEqual(h.snackbars, [])
  }
})

test('arming twice leaves one watchdog', () => {
  const h = harness(RENDERER, { currentTime: 0 })
  h.arm(0)
  h.arm(0)
  assert.strictEqual(h.armed(), 1)
})

test('disarming cancels it', () => {
  const h = harness(RENDERER, { currentTime: 0 })
  h.arm(0)
  h.disarm()
  assert.strictEqual(h.armed(), 0)
})

test('both call sites read the clock before asking for play', () => {
  assert.match(RENDERER,
    /var _startedAt = Number\(audio\.currentTime\) \|\| 0\n  audio\.play\(\)\.then\(function \(\) \{ _armMusicStartWatch\(_startedAt\)/,
    'the local-file path')
  assert.match(RENDERER,
    /var _resumeAt = Number\(audio\.currentTime\) \|\| 0\n    Promise\.resolve\(\)[\s\S]{0,140}_armMusicStartWatch\(_resumeAt\)/,
    'the togglePlay resume path')
})

// ── Mutation checks ─────────────────────────────────────────────────────────

test('MUTATION: without the tick check a track change reads as silence again', () => {
  const broken = RENDERER.replace(
    /    \/\/ Any position event since arming is progress[\s\S]*?\n    if \(_musicStartTicks > ticks\) return\n/,
    '')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken, { currentTime: 0 })
  h.arm(0)
  h.tick(40)
  h.audio.currentTime = 0.1
  h.fire()
  assert.strictEqual(h.snackbars.length, 1, 'this is the reported bug')
})

test('MUTATION: snapshotting the baseline after play() resolves brings it back', () => {
  const broken = RENDERER.replace(
    '  var at = Number(startedAt != null ? startedAt : audio.currentTime) || 0',
    '  var at = Number(audio.currentTime) || 0')
  assert.notStrictEqual(broken, RENDERER, 'the mutation applied')
  const h = harness(broken, { currentTime: 3.0 })
  h.arm(0)
  h.audio.currentTime = 3.1
  h.fire()
  assert.strictEqual(h.snackbars.length, 1, 'this is the reported bug')
})
