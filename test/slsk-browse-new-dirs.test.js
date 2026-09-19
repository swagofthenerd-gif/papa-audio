'use strict'
// "N new files" has to be able to show you the N.
//
// A saved peer's card carried a "13 new files" badge and a "New since last
// visit" affordance that opened onto nothing: the diff was a subtraction of two
// file COUNTS, which can say how many but never which. Worse, any browse at all
// rotated the pair — including the background refresh that fires the moment a
// cached library is served — so by the time the library opened, last visit's
// folders were this visit's folders and even the count was gone.
//
// The snapshot below is what the shelf is built from, and _browseRecordDiff is
// lifted out of main.js and run for real against a fake store.
const test = require('node:test')
const assert = require('node:assert')
const SU = require('../src/saved-users')
const { liftFns, MAIN } = require('./helpers/lift-main-fn')

const dir = (name, files) => ({ name, files: new Array(files || 1).fill(0).map((_, i) => ({ filename: name + '\\' + i + '.flac', size: 100 })) })

// ── The snapshot primitives ──────────────────────────────────────────────────
test('a snapshot is order-independent and dedupes', () => {
  const a = SU.dirSnapshot(['Music\\A', 'Music\\B', 'Music\\A'])
  const b = SU.dirSnapshot(['Music\\B', 'Music\\A'])
  assert.deepStrictEqual(a.sig, b.sig)
  assert.strictEqual(a.truncated, false)
})

test('newDirPaths names the folders that were not there before', () => {
  const prev = SU.dirSnapshot(['Music\\A', 'Music\\B'])
  const now = ['Music\\A', 'Music\\B', 'Music\\C', 'Music\\D']
  assert.deepStrictEqual(SU.newDirPaths(prev, now), ['Music\\C', 'Music\\D'])
})

test('a first visit reports nothing new rather than everything', () => {
  assert.deepStrictEqual(SU.newDirPaths(null, ['Music\\A', 'Music\\B']), [])
  assert.deepStrictEqual(SU.newDirPaths({ sig: [], truncated: false }, ['Music\\A']), [])
})

test('a share too big to snapshot refuses to answer instead of guessing', () => {
  const many = []
  for (let i = 0; i < 12; i++) many.push('Music\\' + i)
  const prev = SU.dirSnapshot(many, 5)
  assert.strictEqual(prev.truncated, true)
  assert.deepStrictEqual(SU.newDirPaths(prev, many.concat(['Music\\new'])), [])
})

test('the new-paths list is capped', () => {
  const prev = SU.dirSnapshot(['Music\\seed'])
  const now = ['Music\\seed']
  for (let i = 0; i < 500; i++) now.push('Music\\n' + i)
  assert.strictEqual(SU.newDirPaths(prev, now).length, 200)
  assert.strictEqual(SU.newDirPaths(prev, now, 5).length, 5)
})

test('recordBrowse rolls the snapshot into prevDirSnap, and leaves it alone otherwise', () => {
  let list = SU.saveUser([], 'sherrybaaz')
  list = SU.recordBrowse(list, 'sherrybaaz', {
    fileCount: 10, dirCount: 2, dirSnap: SU.dirSnapshot(['A', 'B']) })
  assert.strictEqual(list[0].prevDirSnap, null, 'nothing to roll on the first visit')

  list = SU.recordBrowse(list, 'sherrybaaz', {
    fileCount: 13, dirCount: 3, dirSnap: SU.dirSnapshot(['A', 'B', 'C']) })
  assert.deepStrictEqual(list[0].prevDirSnap.sig, SU.dirSnapshot(['A', 'B']).sig)
  assert.strictEqual(list[0].prevFileCount, 10)

  // An unrelated touch must not disturb either snapshot.
  const touched = SU.touchUser(list, 'sherrybaaz', { fileCount: 13 })
  assert.deepStrictEqual(touched[0].dirSnap.sig, list[0].dirSnap.sig)
  assert.deepStrictEqual(touched[0].prevDirSnap.sig, list[0].prevDirSnap.sig)
})

// ── _browseRecordDiff, for real ──────────────────────────────────────────────
function liftDiff(saved) {
  let stored = saved
  const broadcasts = []
  const { fns } = liftFns(['_browseRecordDiff'], {
    savedUsers: SU,
    store: {
      get: (_k, d) => (stored === undefined ? d : stored),
      set: (_k, v) => { stored = v },
    },
    savedUsersChanged: (l) => broadcasts.push(l),
  }, ['BROWSE_NEW_DIRS_CAP'])
  return { diff: fns._browseRecordDiff, read: () => stored, broadcasts }
}

test('two visits: the second names the three folders that appeared', () => {
  const { diff, read } = liftDiff(SU.saveUser([], 'sherrybaaz'))

  const first = diff('sherrybaaz', [dir('Music\\A', 4), dir('Music\\B', 6)])
  assert.deepStrictEqual(first, [], 'a first visit has nothing to be new against')
  assert.strictEqual(read()[0].fileCount, 10)

  const second = diff('sherrybaaz', [
    dir('Music\\A', 4), dir('Music\\B', 6),
    dir('Music\\C', 1), dir('Music\\D', 1), dir('Music\\E', 1),
  ])
  assert.deepStrictEqual(second, ['Music\\C', 'Music\\D', 'Music\\E'])
  assert.strictEqual(read()[0].prevFileCount, 10)
  assert.strictEqual(read()[0].fileCount, 13)
})

test('re-opening without a change reports nothing new', () => {
  const { diff } = liftDiff(SU.saveUser([], 'sherrybaaz'))
  const dirs = [dir('Music\\A', 4), dir('Music\\B', 6)]
  diff('sherrybaaz', dirs)
  assert.deepStrictEqual(diff('sherrybaaz', dirs), [])
})

test('a peer who is not saved is not recorded at all', () => {
  const { diff, read } = liftDiff([])
  // Array built inside the vm realm, so length rather than prototype identity.
  assert.strictEqual(diff('stranger', [dir('Music\\A', 4)]).length, 0)
  assert.strictEqual(read().length, 0)
})

// ── The background refresh must not rotate ───────────────────────────────────
// The live failure in one run: open a saved library (served from cache), the
// background refresh fires, and by the next open the diff is gone. So drive
// exactly that — _browseDirectories, _browseRefresh and _browseRecordDiff all
// lifted together, with a fake cache and a fake wire.
function liftBrowse(cacheDirs) {
  let stored = SU.saveUser([], 'sherrybaaz')
  let cache = cacheDirs ? { directories: cacheDirs, cachedAt: 1 } : null
  let wire = cacheDirs || []
  const sends = []
  const { fns } = liftFns(
    ['_browseRecordDiff', '_browseRefresh', '_browseDirectories'],
    {
      savedUsers: SU,
      store: { get: (_k, d) => (stored === undefined ? d : stored), set: (_k, v) => { stored = v } },
      savedUsersChanged: () => {},
      safeSend: (ch, p) => sends.push(ch),
      _browseFetch: async () => wire,
      _browseCacheRead: () => cache,
      _browseCacheWrite: (_u, dirs) => { cache = { directories: dirs, cachedAt: 2 } },
      _browseRefreshing: new Set(),
    },
    ['BROWSE_NEW_DIRS_CAP'])
  return {
    open: (u) => fns._browseDirectories(u),
    setWire: (d) => { wire = d },
    dropCache: () => { cache = null },
    read: () => stored,
    sends,
  }
}

// Let the refresh's self-invoking async closure run to completion.
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)) }

test('a background refresh does not consume the diff the next visit should show', async () => {
  const A = [dir('Music\\A', 4), dir('Music\\B', 6)]
  const b = liftBrowse(A)

  const first = await b.open('sherrybaaz')
  assert.strictEqual(first.newDirs.length, 0, 'first recorded visit has nothing new')
  await settle()
  assert.ok(b.sends.includes('slsk-browse-refreshed'), 'the background refresh ran')

  // While he was away, the peer added three folders; the refresh picked them up.
  b.setWire(A.concat([dir('Music\\C'), dir('Music\\D'), dir('Music\\E')]))
  await b.open('sherrybaaz')      // serves the old cache, kicks a refresh
  await settle()                  // the refresh writes the new cache

  const next = await b.open('sherrybaaz')
  assert.deepStrictEqual(Array.from(next.newDirs), ['Music\\C', 'Music\\D', 'Music\\E'],
    'the background refresh rotated the snapshot and ate the diff')
})

test('the fetch path records the visit too, not just the cache path', async () => {
  const b = liftBrowse(null)      // no cache: _browseDirectories fetches
  b.setWire([dir('Music\\A', 4)])
  const first = await b.open('sherrybaaz')
  assert.strictEqual(first.fromCache, false)
  assert.strictEqual(b.read()[0].fileCount, 4, 'the fetch path recorded nothing')

  b.setWire([dir('Music\\A', 4), dir('Music\\Z', 2)])
  b.dropCache()                   // force the fetch path again
  const second = await b.open('sherrybaaz')
  assert.deepStrictEqual(Array.from(second.newDirs), ['Music\\Z'])
})
