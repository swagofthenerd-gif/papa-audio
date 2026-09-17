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
