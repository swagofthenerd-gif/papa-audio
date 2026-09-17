'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const DEBRID = fs.readFileSync(path.join(__dirname, '..', 'src', 'debrid.js'), 'utf8')

// Every execFile in main.js carries an explicit timeout; the four spawn('ffmpeg')
// sites were missed. A hung ffmpeg — a stalled network mount, a file that decodes
// forever — otherwise stays alive for the life of the app: the promise never
// settles, the IPC handler behind it never returns, the temp file stays on disk,
// and batch-transcode (which awaits sequentially) stalls every remaining file.
test('every ffmpeg spawn can be killed', () => {
  const sites = [...MAIN.matchAll(/spawn\('ffmpeg'/g)].map(m => m.index)
  assert.ok(sites.length >= 4, `found ${sites.length} ffmpeg spawns`)
  for (const at of sites) {
    const after = MAIN.slice(at, at + 900)
    assert.match(after, /_killAfter\(proc,/,
      `the ffmpeg spawn at offset ${at} has no deadline — a hang there never returns`)
  }
})

test('the deadline disarms itself, so a normal run leaves no timer behind', () => {
  const fn = MAIN.slice(MAIN.indexOf('function _killAfter(proc, ms)'))
  const body = fn.slice(0, fn.indexOf('\n}') + 2)
  assert.match(body, /proc\.once\('close', disarm\)/)
  assert.match(body, /proc\.once\('error', disarm\)/)
  assert.match(body, /timer\.unref/, 'and never holds the process open by itself')
})

// Both grew one entry per distinct magnet or torrent ever resolved, for the life
// of the instance. An infoCache entry holds a whole torrent's files array plus
// its links — twenty-plus file records for a season pack.
test('the debrid caches are bounded and expire', () => {
  assert.doesNotMatch(DEBRID, /const linkCache = new Map\(\)/, 'no bare Map')
  assert.doesNotMatch(DEBRID, /const infoCache = new Map\(\)/)
  assert.match(DEBRID, /const linkCache = makeCache\(\{ cap: \d+, ttlMs: /)
  assert.match(DEBRID, /const infoCache = makeCache\(\{ cap: \d+, ttlMs: /)
})

test('the capped cache really does evict, and really does expire', () => {
  const { makeCache } = require('../src/ttl-cache')
  let clock = 0
  const c = makeCache({ cap: 3, ttlMs: 1000, now: () => clock })
  for (const k of ['a', 'b', 'c', 'd']) c.set(k, k)
  assert.strictEqual(c.get('a'), undefined, 'the oldest is evicted at the cap')
  assert.strictEqual(c.get('d'), 'd')
  clock = 1500
  assert.strictEqual(c.get('d'), undefined, 'and a stale entry expires')
})

// dlSucceeded gained TWO entries per completed file and held full remote path
// strings; dlGroups one per album with its own growing files Set. Neither had an
// eviction anywhere, and dlCheckCompletedGroups walks ALL of dlGroups on every
// four-second tick — so a group that never completes was re-walked forever.
test('a verified download group is retired from all three ledgers', () => {
  const fn = MAIN.slice(MAIN.indexOf('async function dlCheckCompletedGroups'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.match(body, /dlGroups\.delete\(key\)/, 'the group leaves the ledger')
  assert.match(body, /dlVerifiedGroups\.delete\(key\)/, 'and the verified set')
  assert.match(body, /dlSucceeded\.delete\(f\)/, 'and its files leave the succeeded set')
  const verifyAt = body.indexOf('await dlVerifyGroup(group)')
  const deleteAt = body.indexOf('dlGroups.delete(key)')
  assert.ok(verifyAt > 0 && deleteAt > verifyAt,
    'retirement must happen after the verification, never before it')
})
