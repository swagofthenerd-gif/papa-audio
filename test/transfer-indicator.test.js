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

test('sharingRows sorts live transfers first, then by username', () => {
  const rows = TI.sharingRows([
    { username: 'zoe', files: [{ filename: 'z\\1.flac', state: 'InProgress' }] },
    { username: 'ann', files: [{ filename: 'a\\1.flac', state: 'Completed, Succeeded' }] },
    { username: 'bob', files: [{ filename: 'b\\1.flac', state: 'Queued, Remotely' }] },
  ])
  assert.deepEqual(rows.map(r => r.username), ['bob', 'zoe', 'ann'])
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
