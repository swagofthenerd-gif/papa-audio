'use strict'
// V2.3: one set of numbers for resume, watched, bars and marks.
const test = require('node:test')
const assert = require('node:assert')
const R = require('../src/watch-rules')

test('the thresholds are the stated ones', () => {
  assert.equal(R.STARTED_AT, 0.05); assert.equal(R.WATCHED_AT, 0.92); assert.equal(R.MIN_SECONDS, 30)
  assert.equal(R.STARTED_CAP_SECONDS, 120)
})

// V111: percentage-only eligibility discarded meaningful progress in long films.
test('the 5 % start threshold is capped at two minutes, so long films resume', () => {
  assert.equal(R.status(300, 7200), 'partial', 'five minutes into a two-hour film (4.2 %) resumes')
  assert.equal(R.status(119, 7200), 'fresh', 'just under the cap and under 5 % is still fresh')
  assert.equal(R.status(120, 7200), 'partial', 'the cap itself')
  assert.equal(R.status(120, 2700), 'partial', '45-minute episode: 120 s beats its 135 s 5 %')
  assert.equal(R.status(100, 3600), 'fresh', 'a one-hour title keeps the 5 % rule below the cap')
  assert.equal(R.status(25, 200), 'fresh', 'MIN_SECONDS still applies to short clips')
  assert.deepEqual(R.resumeOffer(300, 7200), { position: 300, left: 6900 })
})

test('status: fresh under 5 % or 30 s, partial between, watched at 92 %', () => {
  assert.equal(R.status(0, 3600), 'fresh')
  assert.equal(R.status(100, 3600), 'fresh', '2.8 % is fresh')
  assert.equal(R.status(180, 3600), 'partial', '5 % is partial')
  assert.equal(R.status(20, 300), 'fresh', '6.7 % but under 30 s is fresh')
  assert.equal(R.status(3311, 3600), 'partial', '91.97 %')
  assert.equal(R.status(3312, 3600), 'watched', '92 %')
  assert.equal(R.status(3600, 0), 'fresh', 'no duration, no claim')
  assert.equal(R.status(NaN, 3600), 'fresh')
})

test('progress bars and resume offers exist only for partial titles', () => {
  assert.equal(R.progressPct(1800, 3600), 50)
  assert.equal(R.progressPct(100, 3600), 0)
  assert.equal(R.progressPct(3500, 3600), 0, 'watched shows no bar')
  assert.equal(R.progressPct(181, 3600), 5)
  assert.deepEqual(R.resumeOffer(1800, 3600), { position: 1800, left: 1800 })
  assert.equal(R.resumeOffer(10, 3600), null)
  assert.equal(R.resumeOffer(3550, 3600), null)
})

// V012: the primary button says what it will do.
test('primaryAction reads Play or Resume from <time>, and offers Start over only when resuming', () => {
  const mmss = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')
  assert.deepEqual(R.primaryAction(null, mmss), { kind: 'play', label: 'Play', startOver: false })
  assert.deepEqual(R.primaryAction({ position: 1800, duration: 3600 }, mmss), { kind: 'resume', label: 'Resume from 30:00', startOver: true, position: 1800 })
  assert.equal(R.primaryAction({ position: 10, duration: 3600 }, mmss).kind, 'play', 'fresh plays')
  assert.equal(R.primaryAction({ position: 3500, duration: 3600, watched: true }, mmss).kind, 'play', 'watched plays from the start')
})
