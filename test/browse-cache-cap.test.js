'use strict'
// The browse cache has to be capped by SIZE, and the backup must not carry it.
//
// The old cap counted users — twenty of them — which never fired: six users had
// accumulated 173 MB, one peer alone 102 MB. A peer's share is a whole file
// tree, so "how many users" says nothing about how big the cache is. The cost
// lands on the main process thread: measured on the real file, 333 ms to read,
// 772 ms to parse and 713 ms to stringify, on the thread that also drives mpv's
// IPC socket. And because the backup collected every store, each automatic
// backup was 173 MB, seven kept, 1.2 GB on a volume 90% full.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { capByBytes, sizeOf, DEFAULT_MAX_BYTES } = require('../src/browse-cache-cap')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

const entry = (bytes, cachedAt) => ({ directories: 'x'.repeat(bytes), cachedAt })
const MB = 1024 * 1024

test('a cache within budget is left exactly alone', () => {
  const m = { a: entry(10, 1), b: entry(10, 2) }
  const r = capByBytes(m, 1000)
  assert.deepStrictEqual(Object.keys(r.map).sort(), ['a', 'b'])
  assert.deepStrictEqual(r.evicted, [])
})

test('over budget, the OLDEST go first', () => {
  const m = { old: entry(4 * MB, 1), mid: entry(4 * MB, 2), fresh: entry(4 * MB, 3) }
  const r = capByBytes(m, 9 * MB)
  assert.ok(r.evicted.includes('old'), 'the least recently cached is the one to lose')
  assert.ok(!r.evicted.includes('fresh'))
  assert.ok(r.bytes <= 9 * MB)
})

test('the entry just written is never evicted', () => {
  // It is the peer he is looking at; dropping it would re-fetch immediately.
  const m = { huge: entry(20 * MB, 99), justWritten: entry(20 * MB, 1) }
  const r = capByBytes(m, 24 * MB, 'justWritten')
  assert.ok('justWritten' in r.map, 'the freshly written entry must survive')
  assert.deepStrictEqual(r.evicted, ['huge'])
})

test('one entry larger than the whole budget is kept, but kept ALONE', () => {
  const m = { a: entry(5 * MB, 1), b: entry(5 * MB, 2), monster: entry(100 * MB, 3) }
  const r = capByBytes(m, 24 * MB, 'monster')
  assert.deepStrictEqual(Object.keys(r.map), ['monster'],
    'a 102 MB peer must never sit alongside a 32 MB one')
})

test('an entry with no timestamp sorts oldest', () => {
  const m = { undated: { directories: 'x'.repeat(4 * MB) }, dated: entry(4 * MB, 1000) }
  const r = capByBytes(m, 5 * MB)
  assert.deepStrictEqual(r.evicted, ['undated'],
    'an entry we cannot date is the one we can least justify keeping')
})

test('junk input yields an empty map rather than throwing', () => {
  for (const bad of [null, undefined, [], 'nope', 42]) {
    assert.deepStrictEqual(capByBytes(bad, 10).map, {}, String(bad))
  }
})

test('the default budget is small enough to matter', () => {
  assert.ok(DEFAULT_MAX_BYTES <= 32 * MB,
    'a budget above ~32 MB puts the stringify back over a frame budget')
  assert.ok(DEFAULT_MAX_BYTES >= 8 * MB, 'and below ~8 MB it would thrash')
})

// ── the backup half ─────────────────────────────────────────────────────────

function liftCollect() {
  const skipAt = MAIN.indexOf('const BACKUP_SKIP_STORES = new Set([')
  assert.ok(skipAt > -1, 'BACKUP_SKIP_STORES must still exist')
  const fnAt = MAIN.indexOf('function _collectBackupStores()')
  const fnEnd = MAIN.indexOf('\n}', fnAt) + 2
  const skipEnd = MAIN.indexOf('])', skipAt) + 2
  return new Function('sideStores', `
    ${MAIN.slice(skipAt, skipEnd)}
    ${MAIN.slice(fnAt, fnEnd)}
    return { stores: _collectBackupStores(), skip: BACKUP_SKIP_STORES }
  `)
}
const collect = liftCollect()

test('the re-fetchable caches are not in a backup — and are not even read', () => {
  let browseRead = false
  const sideStores = {
    browseCache: { get() { browseRead = true; return { huge: true } } },
    animeDetailCache: { get() { return {} } },
    playHistory: { get() { return [{ filePath: '/m/a.flac' }] } },
  }
  const { stores } = collect(sideStores)
  assert.ok(!('browseCache' in stores), 'the 166 MB cache must not be in the backup')
  assert.ok(!('animeDetailCache' in stores))
  assert.strictEqual(browseRead, false,
    'reading it would pay the ~1.1 s parse this exists to avoid')
  assert.ok('playHistory' in stores, 'real data must still be backed up')
})

test('every store that is NOT a re-fetchable cache is still backed up', () => {
  // The guard against the skip list quietly growing to swallow real data.
  const realData = ['playHistory', 'playCounts', 'likedTracks', 'playlists',
    'savedQueues', 'videoStore', 'libraryCache', 'recentlyPlayed']
  const sideStores = {}
  for (const n of realData) sideStores[n] = { get: () => ({ real: n }) }
  const { stores, skip } = collect(sideStores)
  for (const n of realData) {
    assert.ok(n in stores, n + ' is his data and must be in the backup')
    assert.ok(!skip.has(n), n + ' must never be added to the skip list')
  }
})

test('a store that throws does not take the whole backup down', () => {
  const sideStores = {
    bad: { get() { throw new Error('disk') } },
    good: { get: () => ({ ok: 1 }) },
  }
  const { stores } = collect(sideStores)
  assert.strictEqual(stores.bad, null)
  assert.deepStrictEqual(stores.good, { ok: 1 })
})
