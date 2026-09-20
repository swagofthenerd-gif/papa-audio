'use strict'
// The pure model behind the sidebar transfer indicator: pill text from a
// transfers snapshot, sharing rows from an uploads snapshot, and the "today"
// line. No DOM, no window — everything here runs in node.
//
// The state strings are slskd's .NET [Flags] enum, so they arrive comma-joined
// ("Queued, Remotely", "Completed, Succeeded"). The counting must read the
// compound forms, not startsWith.
const test = require('node:test')
const assert = require('node:assert')
const TI = require('../src/transfer-indicator.js')

// A transfers snapshot in the shape the download poll already builds:
// users -> directories -> files, each file carrying a `state`.
function snap(states) {
  return [{
    username: 'peer',
    directories: [{ directory: 'a', files: states.map((s, i) => ({ id: 'f' + i, filename: 'a\\t' + i + '.flac', state: s })) }],
  }]
}

test('downloadPill is null when nothing is moving', () => {
  assert.equal(TI.downloadPill([]), null)
  assert.equal(TI.downloadPill(null), null)
  assert.equal(TI.downloadPill(snap(['Completed, Succeeded', 'Completed, Errored'])), null)
})

test('downloadPill counts active only', () => {
  const p = TI.downloadPill(snap(['InProgress', 'InProgress', 'Initializing', 'Completed, Succeeded']))
  assert.equal(p.active, 3)
  assert.equal(p.queued, 0)
  assert.equal(p.text, '↓ 3')
})

test('downloadPill counts queued only, including the compound remote form', () => {
  const p = TI.downloadPill(snap(['Queued, Remotely', 'Queued, Locally']))
  assert.equal(p.active, 0)
  assert.equal(p.queued, 2)
  assert.equal(p.text, '↓ +2')
})

test('downloadPill shows both with the +queued suffix', () => {
  const p = TI.downloadPill(snap(['InProgress', 'InProgress', 'InProgress'].concat(Array(12).fill('Queued, Remotely'))))
  assert.equal(p.active, 3)
  assert.equal(p.queued, 12)
  assert.equal(p.text, '↓ 3 +12')
})

test('downloadPill never counts a finished transfer as in flight', () => {
  // "Completed, Succeeded" contains neither InProgress nor Queued, but a
  // substring-happy matcher on "Completed, Cancelled" style strings would trip.
  assert.equal(TI.downloadPill(snap(['Completed, Cancelled', 'Completed, TimedOut'])), null)
})

test('sharingPill is live while peers are pulling', () => {
  const p = TI.sharingPill({ activeUploads: 2, filesToday: 14, distinctPeersToday: 3 })
  assert.deepEqual(p, { text: '↑ 2', live: true })
})

test('sharingPill falls back to the day tally when idle', () => {
  const p = TI.sharingPill({ activeUploads: 0, filesToday: 14, distinctPeersToday: 3 })
  assert.deepEqual(p, { text: '14 today', live: false })
})

test('sharingPill is null when nothing happened today', () => {
  assert.equal(TI.sharingPill({ activeUploads: 0, filesToday: 0, distinctPeersToday: 0 }), null)
  assert.equal(TI.sharingPill(null), null)
})

// A byte total and a file count are the same shape and nothing like the same
// number. The pill used to fall back to totalUploadedToday when filesToday was
// missing, which prints two gigabytes shared as "2254857830 today".
test('sharingPill never reads a byte total as a file count', () => {
  assert.equal(
    TI.sharingPill({ activeUploads: 0, totalUploadedToday: 2254857830, distinctPeersToday: 3 }),
    null)
})

test('sharingRows extracts the file and its parent folder from a backslash path', () => {
  const rows = TI.sharingRows([{
    username: 'ann',
    directories: [{
      directory: 'C:\\Music\\Miles Davis - Kind of Blue',
      files: [{
        filename: 'C:\\Music\\Miles Davis - Kind of Blue\\01 So What.flac',
        state: 'InProgress', percentComplete: 41.5, averageSpeed: 220000,
      }],
    }],
  }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].username, 'ann')
  assert.equal(rows[0].file, '01 So What.flac')
  assert.equal(rows[0].folder, 'Miles Davis - Kind of Blue')
  assert.equal(rows[0].pct, 41.5)
  assert.equal(rows[0].speed, 220000)
  assert.equal(rows[0].state, 'InProgress')
})

test('sharingRows puts in-flight transfers above queued ones, then sorts by username', () => {
  const rows = TI.sharingRows([
    { username: 'zoe', files: [{ filename: 'z\\1.flac', state: 'InProgress' }] },
    { username: 'bob', files: [{ filename: 'b\\1.flac', state: 'Queued, Remotely' }] },
    { username: 'amy', files: [{ filename: 'a\\1.flac', state: 'InProgress' }] },
  ])
  assert.deepEqual(rows.map(r => r.username), ['amy', 'zoe', 'bob'])
})

// The bug the user actually saw: "the same songs and user names" piling up
// while the day's byte counter climbed. slskd keeps finished transfers in
// /transfers/uploads, and the panel painted every one of them under a heading
// that says "Happening now".
test('sharingRows drops everything that is already over', () => {
  const rows = TI.sharingRows([
    { username: 'zoe', files: [{ filename: 'z\\1.flac', state: 'InProgress' }] },
    { username: 'ann', files: [{ filename: 'a\\1.flac', state: 'Completed, Succeeded' }] },
    { username: 'ben', files: [{ filename: 'b\\1.flac', state: 'Completed, Cancelled' }] },
    { username: 'cal', files: [{ filename: 'c\\1.flac', state: 'Completed, Errored' }] },
    { username: 'dot', files: [{ filename: 'd\\1.flac', state: 'Completed, TimedOut' }] },
  ])
  assert.deepEqual(rows.map(r => r.username), ['zoe'])
})

test('sharingRows keeps the queued families slskd actually sends', () => {
  const rows = TI.sharingRows([
    { username: 'a', files: [{ filename: 'a.flac', state: 'Queued, Remotely' }] },
    { username: 'b', files: [{ filename: 'b.flac', state: 'Requested, Queued' }] },
    { username: 'c', files: [{ filename: 'c.flac', state: 'Initializing' }] },
    { username: 'd', files: [{ filename: 'd.flac', state: 'Initialising' }] },
  ])
  assert.deepEqual(rows.map(r => r.username), ['c', 'd', 'a', 'b'])
})

test('sharingRows carries the bytes, so a rate and a real bar can be worked out', () => {
  const rows = TI.sharingRows([{
    username: 'ann',
    files: [{
      filename: 'a\\x.flac', state: 'InProgress',
      percentComplete: 3, bytesTransferred: 2500, size: 10000,
    }],
  }])
  assert.equal(rows[0].bytes, 2500)
  assert.equal(rows[0].size, 10000)
  // bytes/size beats slskd's rounded percentComplete when both are there.
  assert.equal(rows[0].pct, 25)
  assert.equal(rows[0].key, 'ann\na\\x.flac', 'a stable identity across polls')
})

test('sharingRows falls back to percentComplete when slskd sends no size', () => {
  const rows = TI.sharingRows([{
    username: 'ann',
    files: [{ filename: 'a.flac', state: 'InProgress', percentComplete: 41.5 }],
  }])
  assert.equal(rows[0].pct, 41.5)
  assert.equal(rows[0].bytes, 0)
})

// ── The live rate ────────────────────────────────────────────────────────────
// averageSpeed is slskd's running average over the whole transfer. It settles
// within seconds and then barely moves, which is half of why the panel did not
// read as live. The real rate is the change in bytes between two samples.

test('currentSpeed is the byte delta over the interval', () => {
  assert.equal(
    TI.currentSpeed({ bytes: 1000 }, { bytes: 3000, speed: 99 }, 1000),
    2000)
  assert.equal(
    TI.currentSpeed({ bytes: 1000 }, { bytes: 3000, speed: 99 }, 2000),
    1000)
})

test('currentSpeed falls back to slskd\'s average with no previous sample', () => {
  assert.equal(TI.currentSpeed(null, { bytes: 3000, speed: 220000 }, 0), 220000)
  // And says nothing at all when there is not even an average to fall back on.
  assert.equal(TI.currentSpeed(null, { bytes: 3000, speed: 0 }, 0), null)
})

test('currentSpeed says nothing rather than a wrong number when the samples are unusable', () => {
  const cur = { bytes: 3000, speed: 220000 }
  assert.equal(TI.currentSpeed({ bytes: 1000 }, cur, 0), null, 'a zero interval')
  assert.equal(TI.currentSpeed({ bytes: 1000 }, cur, -5), null, 'a clock stepping back')
  assert.equal(TI.currentSpeed({ bytes: 1000 }, cur, 60001), null, 'a gap too long to average over')
  assert.equal(TI.currentSpeed({ bytes: 9000 }, cur, 1000), null, 'a restarted transfer')
  assert.equal(TI.currentSpeed({ bytes: NaN }, cur, 1000), null, 'junk in the previous sample')
  assert.equal(TI.currentSpeed({ bytes: 1000 }, null, 1000), null, 'no current sample')
  // The fallback must NOT rescue these: a stale average printed beside a
  // restarted transfer is exactly the confidently wrong number to avoid.
  assert.equal(TI.currentSpeed({ bytes: 9000 }, cur, 1000), null)
})

test('currentSpeed reports a genuine stall as zero, not as a guess', () => {
  assert.equal(TI.currentSpeed({ bytes: 3000 }, { bytes: 3000, speed: 220000 }, 2000), 0)
})

test('sharingRows reads the already-flat snapshot shape too', () => {
  const rows = TI.sharingRows([{ username: 'ann', filename: 'a\\b\\c.flac', state: 'InProgress' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].file, 'c.flac')
  assert.equal(rows[0].folder, 'b')
})

test('sharingRows tolerates junk', () => {
  assert.deepEqual(TI.sharingRows(null), [])
  assert.deepEqual(TI.sharingRows([null, 7, {}]), [])
})

test('todayLine reads as a sentence, with the size when bytes are known', () => {
  assert.equal(
    TI.todayLine({ filesToday: 14, distinctPeersToday: 3, bytesToday: 2254857830 }),
    '14 files to 3 people today · 2.1 GB')
})

test('todayLine is singular for one file and one person', () => {
  assert.equal(
    TI.todayLine({ filesToday: 1, distinctPeersToday: 1 }),
    '1 file to 1 person today')
})

// The panel can be visibly sending its first file of the day, with nothing
// finished yet. "Nothing shared today yet." underneath that is a small lie.
test('todayLine owns up to bytes that have gone out before anything finished', () => {
  assert.equal(
    TI.todayLine({ filesToday: 0, distinctPeersToday: 1, bytesToday: 5242880 }),
    'Nothing finished today yet · 5 MB out so far')
})

test('todayLine says so plainly when nothing has been shared', () => {
  assert.equal(TI.todayLine({ filesToday: 0, distinctPeersToday: 0 }), 'Nothing shared today yet.')
  assert.equal(TI.todayLine(null), 'Nothing shared today yet.')
})

// Same trap as the pill: the byte total is not a file count, and a sentence
// reading "2254857830 files to 3 people today" would be nonsense.
test('todayLine never reads a byte total as a file count', () => {
  assert.equal(
    TI.todayLine({ totalUploadedToday: 2254857830, distinctPeersToday: 3 }),
    'Nothing shared today yet.')
})

test('the pure functions never read window', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'transfer-indicator.js'), 'utf8')
  const body = src.slice(src.indexOf('function downloadPill'), src.indexOf('function todayLine'))
  assert.ok(!/\bwindow\b/.test(body), 'pill/row builders must not touch window')
})
