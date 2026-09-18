'use strict'
// Stats must not print two different all-time totals side by side.
//
// It did: "Listening time (All time) 112h 10m" sat next to "All time: 5d 4h ·
// 4,600 total plays" — 112 hours and 124 hours, in the same box, both labelled
// "All time". And "Last 365 days" read 112h 10m as well, so the headline was
// really a 365-day figure wearing an all-time label.
//
// Two separate causes:
//
//  1. The two TIME figures measured the same history differently. The headline
//     only counted a play whose file was still in the library (byPath.get) and
//     ignored the duration the history entry itself carried; the other used the
//     entry's own duration with a library fallback. Anything played and since
//     moved, renamed or deleted vanished from one and not the other.
//
//  2. The play COUNT came from a different store entirely. playCounts was
//     incremented on every gapless auto-advance while playHistory was not
//     written at all, so it is the more complete record of plays and the only
//     one WITHOUT dates (main logs the gap at startup: 4600 counted vs 1661
//     recorded — see history.js reconcile). Presenting it beside a time drawn
//     from history reads as one figure when it is two.
//
// _statsListeningTotals is lifted from renderer.js and driven with fixtures
// where the two stores deliberately disagree.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const history = require('../history.js')

function lift(name) {
  const start = SRC.indexOf('\nfunction ' + name + '(')
  assert.ok(start > -1, name + ' must still exist as a top-level function in renderer.js')
  const a = SRC.indexOf('\nfunction ', start + 1)
  const b = SRC.indexOf('\nasync function ', start + 1)
  const stop = [a, b].filter(n => n > -1).sort((x, y) => x - y)[0]
  return SRC.slice(start, stop === undefined ? undefined : stop)
}

const ctx = vm.createContext({ Array, Object, Number, Math })
vm.runInContext(lift('_statsListeningTotals'), ctx)
const totals = (hist, ranged, durationOf, counts) => {
  ctx.__a = hist; ctx.__b = ranged; ctx.__c = durationOf; ctx.__d = counts
  return vm.runInContext('_statsListeningTotals(__a, __b, __c, __d)', ctx)
}

// Three plays. Two of the files are still in the library; the third was moved
// off the drive months ago, so a library lookup finds nothing for it — but the
// history entry recorded its own duration at the time, which is the whole point
// of storing it there.
const LIBRARY = { '/m/a.flac': 600, '/m/b.flac': 300 }
// The fourth is an entry from before durations were written into history at
// all; only the library knows how long it is. Both fallbacks are in play here
// on purpose — each covers a case the other cannot.
const HIST = [
  { filePath: '/m/a.flac', ts: 1000, duration: 600 },
  { filePath: '/m/b.flac', ts: 2000, duration: 300 },
  { filePath: '/m/gone.flac', ts: 3000, duration: 1200 },
  { filePath: '/m/b.flac', ts: 4000 },
]
// The real renderer's duration function: the entry's own, then the library.
const durOf = p => p.duration || LIBRARY[p.filePath] || 0
// The old headline's: library only, entry duration ignored.
const oldDurOf = p => LIBRARY[p.filePath] || 0

test('all-time listening time counts a play whose file has since gone', () => {
  const t = totals(HIST, HIST, durOf, {})
  assert.strictEqual(t.allTimeSecs, 2400, '600 + 300 + 1200 + 300')
  const oldHeadline = HIST.reduce((n, p) => n + oldDurOf(p), 0)
  assert.strictEqual(oldHeadline, 1200, 'the old headline silently dropped 1200s — this was the gap')
  assert.notStrictEqual(t.allTimeSecs, oldHeadline)
})

test('the headline over the whole range equals the all-time figure', () => {
  // This is the defect in one line: two numbers, both labelled "All time",
  // that disagreed.
  const t = totals(HIST, HIST, durOf, {})
  assert.strictEqual(t.rangeSecs, t.allTimeSecs,
    'with the range set to All time the two must be the same number')
})

test('a narrower range is genuinely narrower', () => {
  const ranged = HIST.filter(h => h.ts >= 2000)
  const t = totals(HIST, ranged, durOf, {})
  assert.strictEqual(t.rangeSecs, 1800, 'and an undated-duration entry still counts in it')
  assert.strictEqual(t.allTimeSecs, 2400)
  assert.ok(t.rangeSecs < t.allTimeSecs, 'a 2-of-3 window cannot equal the whole')
})

test('the two stores are reported separately when they disagree', () => {
  // The live shape: counts far ahead of history, because gapless advances bumped
  // the counter without writing an entry.
  const counts = { '/m/a.flac': 4000, '/m/b.flac': 500, '/m/gone.flac': 100 }
  const t = totals(HIST, HIST, durOf, counts)
  assert.strictEqual(t.historyPlays, 4, 'the dated plays every windowed figure is drawn from')
  assert.strictEqual(t.countedPlays, 4600, 'the counter, which is the fuller record')
  assert.strictEqual(t.countsExceedHistory, 4596, 'and the gap between them, stated')
})

test('when they agree there is nothing extra to say', () => {
  const counts = { '/m/a.flac': 1, '/m/b.flac': 2, '/m/gone.flac': 1 }
  const t = totals(HIST, HIST, durOf, counts)
  assert.strictEqual(t.countsExceedHistory, 0,
    'the "incl. from before history was kept" line must not appear out of nowhere')
})

test('history.reconcile sees the same gap, on the same fixture', () => {
  // The number the page shows must be the number main already logs at startup,
  // not a second opinion.
  const counts = { '/m/a.flac': 4000, '/m/b.flac': 500, '/m/gone.flac': 100 }
  const r = history.reconcile(HIST, counts)
  const t = totals(HIST, HIST, durOf, counts)
  assert.strictEqual(r.countedTotal, t.countedPlays)
  assert.strictEqual(r.historyTotal, t.historyPlays)
  assert.strictEqual(r.missingFromHistory, t.countsExceedHistory)
})

test('an empty history is 0h, not a crash', () => {
  const t = totals([], [], durOf, {})
  assert.deepStrictEqual(
    [t.rangeSecs, t.allTimeSecs, t.historyPlays, t.countedPlays, t.countsExceedHistory],
    [0, 0, 0, 0, 0])
  const t2 = totals(null, null, durOf, null)
  assert.strictEqual(t2.allTimeSecs, 0)
})

test('the hero labels the count as a count, not as listening', () => {
  const hero = SRC.slice(SRC.indexOf('class="stats-hero">Listening time'))
    .slice(0, 1600)
  assert.match(hero, /plays with a date/,
    'the dated plays must say they are the dated ones')
  assert.match(hero, /before history was kept/,
    'and the counter must say where its extra plays came from')
  assert.doesNotMatch(hero, /total plays</,
    '"total plays" beside an all-time duration read as one figure when it is two')
})

test('the headline and the all-time line come from one function', () => {
  const stats = SRC.slice(SRC.indexOf('\nfunction renderStats('))
  assert.match(stats, /_statsListeningTotals\(state\.playHistory, ranged, _histDur, state\.playCounts\)/)
  assert.match(stats, /const totalSecs = _totals\.rangeSecs/)
  assert.match(stats, /var totalAllTime = _totals\.allTimeSecs/)
  assert.doesNotMatch(stats.slice(0, 2000), /totalSecs \+= \(t\.duration \|\| 0\)/,
    'the library-only headline sum must be gone')
})
