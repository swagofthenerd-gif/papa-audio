'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// A play is 30 seconds LISTENED. Both timers were plain setTimeouts armed at
// track start and cleared only when the next track started, so pausing after a
// second and walking away still recorded a play — inflating play counts, Stats,
// achievements and every taste signal built on them with time nobody heard.
test('the play-count and history timers hang off the listening clock, not wall clock', () => {
  assert.match(R, /_playCountTimer = _afterListening\(PLAY_RECORD_MS/,
    'the play count must wait for listening time')
  assert.match(R, /_historyTimer = _afterListening\(PLAY_RECORD_MS/,
    'so must the history entry')
  assert.doesNotMatch(R, /_playCountTimer = setTimeout\(/,
    'no wall-clock arming left for the play count')
  assert.doesNotMatch(R, /_historyTimer = setTimeout\(/,
    'nor for history')
})

test('the clock is banked on every route into pause, not just the button', () => {
  assert.match(R, /audio\.addEventListener\('pause', function \(\) \{ _listenClockPause\(\) \}\)/)
  assert.match(R, /audio\.addEventListener\('play', function \(\) \{ _listenClockPlay\(\) \}\)/)
  assert.match(R, /audio\.addEventListener\('ended', function \(\) \{ _listenClockPause\(\) \}\)/)
})

test('the clock restarts with each track', () => {
  const arm = R.slice(R.indexOf('_clearListening(_playCountTimer)'))
  assert.match(arm.slice(0, 400), /_listenClockReset\(\)/,
    "a new track must not inherit the previous track's banked time")
})

// state.playHistory was assigned once at startup and never appended to, so
// Stats, the calendar, achievements, the Trail, the player bar's "Recently
// played" and the playlist "Recent" sort were all frozen at launch for the
// whole session.
test('a recorded play is added to the in-memory history too, not only to disk', () => {
  const rec = R.slice(R.indexOf('function recordPlayAfterThreshold'))
  const body = rec.slice(0, rec.indexOf('\nfunction '))
  assert.match(body, /window\.api\.addPlayHistory\(entry\)/, 'still persisted')
  assert.match(body, /state\.playHistory\.unshift\(/, 'and reflected in memory')
  assert.match(body, /ts: Date\.now\(\)/, 'stamped the way main stamps it, so the two agree')
  assert.match(body, /HISTORY_MEMORY_CAP/, 'and capped like main caps it')
})

test('the in-memory cap matches the cap main actually keeps', () => {
  const H = fs.readFileSync(path.join(__dirname, '..', 'history.js'), 'utf8')
  const mainCap = /const HISTORY_CAP = (\d+)/.exec(H)
  const rendererCap = /const HISTORY_MEMORY_CAP = (\d+)/.exec(R)
  assert.ok(mainCap && rendererCap)
  assert.strictEqual(rendererCap[1], mainCap[1],
    'a renderer copy larger than what main keeps would show entries that no longer exist')
})

// ── Executed, not grepped ───────────────────────────────────────────────────
// The tests above pin that the timers go through _afterListening. That is not
// enough on its own: moving a plain setTimeout INSIDE _afterListening satisfies
// every one of them while restoring the wall-clock bug exactly. This runs the
// real function against a controllable clock, so the property — thirty seconds
// LISTENED, not elapsed — is what is actually held.

const vm = require('node:vm')

function liftListeningClock() {
  const names = ['_listenClockReset', '_listenedMs', '_listenClockPlay', '_listenClockPause', '_afterListening', '_clearListening']
  let code = ''
  for (const n of names) {
    const start = R.indexOf('function ' + n + '(')
    assert.ok(start > -1, n + ' must still exist in renderer.js')
    const end = R.indexOf('\nfunction ', start + 1)
    code += R.slice(start, end === -1 ? undefined : end) + '\n'
  }
  // The module-scope state the lifted functions close over. _listenTimerSeq and
  // _pendingListenTimers are declared immediately after _afterListening in the
  // source, so the slice already carries them — only the two declared before
  // the first lifted function need supplying here.
  return 'let _listenAccumMs = 0\nlet _listenSince = 0\n' + code
}

function clockContext() {
  // A real-ish epoch, not 0: the clock uses a zero timestamp as its "not
  // playing" sentinel, which is safe in production (Date.now() is never 0) and
  // would quietly make every assertion here vacuous.
  let now = 1_700_000_000_000
  const timers = []
  const ctx = vm.createContext({
    audio: { paused: false },
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms, id: timers.length + 1 }; timers.push(t); return t.id },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1) },
  })
  vm.runInContext(liftListeningClock() + '\nthis.api = { _listenClockReset, _listenedMs, _listenClockPlay, _listenClockPause, _afterListening }', ctx)
  return {
    api: ctx.api,
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers.splice(timers.indexOf(due), 1)
        now = due.at
        due.fn()
      }
      now = target
    },
    pause: () => { ctx.audio.paused = true },
    play: () => { ctx.audio.paused = false },
  }
}

test('a track paused after one second is NOT recorded, however long you are away', () => {
  const c = clockContext()
  let fired = 0
  c.api._listenClockReset()
  c.api._afterListening(30000, () => { fired++ })
  c.advance(1000)
  c.api._listenClockPause()
  c.pause()
  c.advance(10 * 60 * 1000)   // ten minutes of wall clock, none of it listening
  assert.strictEqual(fired, 0,
    'thirty seconds of wall clock is not thirty seconds of listening')
})

test('a track actually listened to for thirty seconds IS recorded', () => {
  const c = clockContext()
  let fired = 0
  c.api._listenClockReset()
  c.api._afterListening(30000, () => { fired++ })
  c.advance(30000)
  assert.strictEqual(fired, 1)
})

test('listening resumed after a pause still adds up to a play', () => {
  const c = clockContext()
  let fired = 0
  c.api._listenClockReset()
  c.api._afterListening(30000, () => { fired++ })
  c.advance(20000)                  // 20s listened
  c.api._listenClockPause(); c.pause()
  c.advance(5 * 60 * 1000)          // five minutes paused
  assert.strictEqual(fired, 0, 'not yet — only 20 seconds were heard')
  c.play(); c.api._listenClockPlay()
  c.advance(10000)                  // 10s more
  assert.strictEqual(fired, 1, 'now it is thirty seconds heard')
})

test('it fires exactly once, not once per re-check', () => {
  const c = clockContext()
  let fired = 0
  c.api._listenClockReset()
  c.api._afterListening(30000, () => { fired++ })
  c.advance(5 * 60 * 1000)
  assert.strictEqual(fired, 1)
})
