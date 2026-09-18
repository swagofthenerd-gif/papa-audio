'use strict'
// The progress-bar stall watchdog must only ever report a real duration.
//
// QA saw this in the console of the live app:
//
//   [papa] the progress bar has not moved for Infinityms while unpaused
//
// The number came from the shim. `positionAgeMs` was "milliseconds since mpv
// last reported a position, or Infinity if it never has", and mpv does not
// report a position until it has actually opened the file. So between the
// renderer asking for a track and mpv's first reply — every single track
// change — the age was Infinity, the watchdog compared Infinity > 3000, and a
// track that had just been chosen was announced as infinitely frozen. It was
// never a formatting bug: the watchdog was firing on healthy playback.
//
// The fix is a clock that starts when there is a reason to expect movement (a
// load, a resume, an auto-advance) rather than at mpv's first position report.
//
// Both halves are driven here against the real code: the shim is loaded from
// source, and the watchdog body is lifted out of renderer.js rather than
// copied, so a copy cannot keep passing after the original changes.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SHIM = fs.readFileSync(path.join(__dirname, '..', 'src', 'player-shim.js'), 'utf8')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// ── The real shim, with a fake window.api ───────────────────────────────────
function loadShim() {
  let emit = null
  const window = {
    api: new Proxy({
      on: (channel, cb) => { if (channel === 'player-event') emit = cb },
    }, {
      get: (t, k) => k in t ? t[k] : () => Promise.resolve({ ok: true }),
    }),
  }
  new Function('window', SHIM)(window)
  return { player: window.__papaPlayer, emit: (type, data) => emit({ type, data }) }
}

// ── The real watchdog, lifted from the reconcile tick ────────────────────────
function liftTickBody() {
  const at = RENDERER.indexOf('const reconcileTimer = setInterval(')
  assert.ok(at > -1, 'the reconcile tick must still exist in renderer.js')
  const bodyStart = RENDERER.indexOf('{', RENDERER.indexOf('=> {', at)) + 1
  let depth = 1, i = bodyStart
  while (depth > 0 && i < RENDERER.length) {
    const c = RENDERER[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    i++
  }
  const body = RENDERER.slice(bodyStart, i - 1)
  assert.match(body, /has not moved for/, 'the lifted body must contain the watchdog')
  return body
}

const TICK_BODY = liftTickBody()

// The thresholds come out of renderer.js, not out of this file: a stub that
// carries its own copy of a number cannot notice the number changing.
function liftConst(name) {
  const m = new RegExp('const ' + name + ' = (\\d+)').exec(RENDERER)
  assert.ok(m, name + ' must still be declared in renderer.js')
  return Number(m[1])
}
const STALE_POSITION_MS = liftConst('STALE_POSITION_MS')
const STALE_AFTER_LOAD_MS = liftConst('STALE_AFTER_LOAD_MS')

// Everything the tick touches, and nothing else. `_barStale` and the stale
// classes live in the closure, so the builder returns a fresh tick each time.
function buildTick(audio) {
  const errors = []
  const classes = { 'progress-track': [], 'np-modal-track': [] }
  const env = {
    audio,
    state: { isPlaying: false, modalOpen: false },
    document: {
      getElementById: (id) => id in classes ? {
        classList: { toggle: (cls, on) => classes[id].push(cls + ':' + on) },
      } : null,
    },
    console: { error: (...a) => errors.push(a.join(' ')) },
    STALE_POSITION_MS,
    STALE_AFTER_LOAD_MS,
  }
  const tick = new Function('env', `
    const { audio, state, document, console, STALE_POSITION_MS, STALE_AFTER_LOAD_MS } = env
    let _barStale = false
    function updatePlayBtn() {}
    function syncModalPlayBtn() {}
    function reconcileWhatIsPlaying() {}
    return function tick() { ${TICK_BODY} }
  `)(env)
  return { tick, errors, classes, state: env.state }
}

// A controllable Date.now, so a stall can be aged without waiting for one.
function withClock(fn) {
  const real = Date.now
  let now = 1700000000000
  Date.now = () => now
  try {
    return fn({ advance: (ms) => { now += ms } })
  } finally {
    Date.now = real
  }
}

// ── The reported defect ─────────────────────────────────────────────────────

test('a track that was just chosen is not announced as frozen', () => {
  withClock(({ advance }) => {
    const { player, emit } = loadShim()
    const { tick, errors } = buildTick(player)
    // Exactly the live sequence: the renderer sets src and calls play, and the
    // reconcile tick lands before mpv's first position report.
    player.src = 'file:///mnt/data/MUSIC/Camel/Moonmadness/01 Aristillus.flac'
    emit('paused', false)
    advance(1000)
    // The cause, not the sentence: the age itself has to be a real duration
    // here — one second — and not "never reported".
    assert.strictEqual(player.positionAgeMs, 1000,
      'the clock runs from the load, not from mpv first replying')
    tick()
    assert.deepStrictEqual(errors, [],
      'a track one second into loading is not a frozen bar')
  })
})

test('the warning can never print a non-finite number', () => {
  // Belt and braces, and the half that does not depend on the shim: a hostile
  // age must not be able to reach the sentence.
  const hostile = { paused: false, engineDown: false, mpvPath: null, positionAgeMs: Infinity }
  const { tick, errors } = buildTick(hostile)
  tick()
  hostile.positionAgeMs = NaN
  tick()
  hostile.positionAgeMs = -Infinity
  tick()
  assert.deepStrictEqual(errors, [], 'a non-finite age is not a duration and cannot be reported')
})

// ── And the watchdog still does its job ─────────────────────────────────────

test('a bar that really has stopped is still reported, in real milliseconds', () => {
  withClock(({ advance }) => {
    const { player, emit } = loadShim()
    const { tick, errors, classes } = buildTick(player)
    player.src = 'file:///mnt/data/MUSIC/Camel/Moonmadness/01 Aristillus.flac'
    emit('paused', false)
    emit('position', 12.5)
    advance(1000)
    tick()
    assert.deepStrictEqual(errors, [], 'one second of silence is not yet a stall')
    advance(4000)   // mpv has said nothing for five seconds
    tick()
    assert.strictEqual(errors.length, 1, 'five seconds of a motionless bar is a stall')
    assert.match(errors[0], /the progress bar has not moved for 5000ms while unpaused/)
    assert.deepStrictEqual(classes['progress-track'], ['stale:true'])
  })
})

test('the stall is said once, not once a second', () => {
  withClock(({ advance }) => {
    const { player, emit } = loadShim()
    const { tick, errors } = buildTick(player)
    player.src = 'file:///music/a.flac'
    emit('paused', false)
    emit('position', 1)
    advance(9000)
    tick(); tick(); tick()
    assert.strictEqual(errors.length, 1)
  })
})

test('resuming after a long pause is not a stall', () => {
  // Position reports stop while paused, so without a clock restart at the
  // resume the first tick after unpausing reported the length of the pause.
  withClock(({ advance }) => {
    const { player, emit } = loadShim()
    const { tick, errors } = buildTick(player)
    player.src = 'file:///music/a.flac'
    emit('paused', false)
    emit('position', 30)
    emit('paused', true)
    advance(60000)          // a minute of being paused
    tick()
    emit('paused', false)
    advance(500)
    tick()
    assert.deepStrictEqual(errors, [], 'the pause is not a freeze')
  })
})

test('a gapless auto-advance starts the next track with a fresh clock', () => {
  withClock(({ advance }) => {
    const { player, emit } = loadShim()
    const { tick, errors } = buildTick(player)
    player.src = 'file:///music/a.flac'
    emit('paused', false)
    emit('position', 200)
    advance(2500)
    emit('autoAdvanced', '/music/b.flac')
    advance(1000)
    tick()
    assert.deepStrictEqual(errors, [], 'the boundary between two tracks is not a freeze')
  })
})

test('nothing is said while the engine is down', () => {
  withClock(({ advance }) => {
    const { player, emit } = loadShim()
    const { tick, errors } = buildTick(player)
    player.src = 'file:///music/a.flac'
    emit('paused', false)
    emit('position', 1)
    emit('engineDown', { willRecover: true })
    advance(30000)
    tick()
    assert.deepStrictEqual(errors, [], 'the engine being down is already being reported, loudly')
  })
})

// ── The cold start (live re-test, 2026-09-19) ───────────────────────────────
// The watchdog fired ~2.5 s into a fresh local play: mpv's FIRST position
// report for a file lands well after the loadfile on a cold start, and the
// 3 s mid-track threshold was being applied to that wait. Silence before the
// first report is a different silence from silence after one.

test('a cold start gets the longer patience until mpv reports a position', () => {
  withClock(({ advance }) => {
    const { player, emit } = loadShim()
    const { tick, errors } = buildTick(player)
    player.src = 'file:///mnt/data/MUSIC/Camel/Moonmadness/01 Aristillus.flac'
    emit('paused', false)
    assert.strictEqual(player.hasReportedPosition, false,
      'mpv has not reported a position for this file yet')
    advance(2500)                       // the measured cold-start lag
    tick()
    assert.deepStrictEqual(errors, [],
      '2.5 s waiting for mpv to open a file is not a frozen bar')
    advance(STALE_AFTER_LOAD_MS - 2500 + 100)
    tick()
    assert.strictEqual(errors.length, 1,
      'but a load that never produces a position IS a stall, just later')
  })
})

test('once mpv has reported, the ordinary threshold applies again', () => {
  withClock(({ advance }) => {
    const { player, emit } = loadShim()
    const { tick, errors } = buildTick(player)
    player.src = 'file:///music/a.flac'
    emit('paused', false)
    emit('position', 0.5)
    assert.strictEqual(player.hasReportedPosition, true)
    advance(STALE_POSITION_MS + 100)
    tick()
    assert.strictEqual(errors.length, 1,
      'the long grace is for the first report only, not for the rest of the track')
  })
})

test('the next track in a queue gets its own cold-start grace', () => {
  withClock(({ advance }) => {
    const { player, emit } = loadShim()
    const { tick, errors } = buildTick(player)
    player.src = 'file:///music/a.flac'
    emit('paused', false)
    emit('position', 30)
    player.src = 'file:///music/b.flac'   // Next
    assert.strictEqual(player.hasReportedPosition, false,
      'a new file has had nothing reported about it')
    advance(STALE_POSITION_MS + 500)
    tick()
    assert.deepStrictEqual(errors, [], 'the previous track having reported does not count for this one')
  })
})
