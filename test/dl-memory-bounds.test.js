'use strict'
// Four in-memory structures that only ever grew, and a group that could never
// be complete.
//
// peerFailures gained an entry per peer ever met and lost none — over a long run
// it is a map of every Soulseek user the app has spoken to, persisted and
// reloaded on every start. dlGroups, dlSucceeded and dlVerifiedGroups are
// retired when a group VERIFIES, which is exactly what a group that never
// completes never does — so the incomplete ones accumulated, and dlTick walked
// all of them every four seconds.
//
// And dlTrackGroups runs BEFORE addItems, so it recorded files the scheduler
// then refused (an abandoned identity, a duplicate, a lossy copy dropped because
// the same title arrived lossless). isGroupComplete requires EVERY file to have
// succeeded, so one refused member meant the album could never verify, never
// auto-organize, and never be retired.
//
// The real prunePeerFailures, dlUntrackGroupFiles and dlCapGroups are used.

const test = require('node:test')
const assert = require('node:assert')

const dlSched = require('../src/download-scheduler.js')
const { liftFns } = require('./helpers/lift-main-fn.js')


test('a peer whose bench expired with no streak left is forgotten', () => {
  const now = 1_700_000_000_000
  const st = dlSched.createState()
  st.peerFailures = {
    spent: { consecutive: 0, benchedUntil: now - 60_000 },
    stillBenched: { consecutive: 5, benchedUntil: now + 60_000 },
    streaking: { consecutive: 2, benchedUntil: 0 },
  }
  dlSched.prunePeerFailures(st, now)
  assert.deepStrictEqual(Object.keys(st.peerFailures).sort(), ['stillBenched', 'streaking'],
    'only the ones something still reads')
})

test('the peer ledger is capped even when every entry is live', () => {
  const now = 1_700_000_000_000
  const st = dlSched.createState()
  for (let i = 0; i < 900; i++) {
    st.peerFailures['peer' + i] = { consecutive: 1, benchedUntil: now + 1000 + i }
  }
  dlSched.prunePeerFailures(st, now, 500)
  assert.strictEqual(Object.keys(st.peerFailures).length, 500)
  assert.ok(!st.peerFailures.peer0, 'the oldest bench goes first')
  assert.ok(st.peerFailures.peer899, 'the newest is kept')
})

test('addItems names the files it dropped, not just how many', () => {
  // The ledger cannot remove a file it was not told about. The batch-local lossy
  // suppression is the path that drops without refusing: two peers' copies of one
  // loose single, one FLAC one MP3, land in different size bands so identity
  // cannot link them — the MP3 is dropped whole rather than enqueued alongside.
  const st = dlSched.createState()
  const res = dlSched.addItems(st, [
    { filename: 'witzmankid_stuff/Lights Out.flac', size: 30e6,
      sources: [{ username: 'a', filename: 'witzmankid_stuff/Lights Out.flac', size: 30e6 }] },
    { filename: 'jzdoot shares/Lights Out.mp3', size: 7e6,
      sources: [{ username: 'b', filename: 'jzdoot shares/Lights Out.mp3', size: 7e6 }] },
  ])
  assert.strictEqual(res.dropped, 1, 'the lossy copy is dropped, as before')
  assert.deepStrictEqual(res.droppedFiles, ['jzdoot shares/Lights Out.mp3'],
    'and it says which one')
})

const groupFns = liftFns(['dlUntrackGroupFiles', 'dlCapGroups'], {
  dlGroups: new Map(),
  dlSucceeded: new Set(),
  dlVerifiedGroups: new Set(),
}, ['DL_GROUP_CAP'])

function seedGroup(G, key, files) {
  G.dlGroups.set(key, { key, username: 'peerA', folder: key, folderPath: key,
    expected: files.length, files: new Set(files), surroundLabel: null })
}

test('a refused file is taken back out of the album group', () => {
  const G = groupFns.globals
  G.dlGroups.clear(); G.dlSucceeded.clear(); G.dlVerifiedGroups.clear()
  seedGroup(G, 'peerA::Dummy', ['a.flac', 'b.flac', 'c.flac'])

  const removed = groupFns.fns.dlUntrackGroupFiles(['b.flac'])
  assert.strictEqual(removed, 1)
  const g = G.dlGroups.get('peerA::Dummy')
  assert.strictEqual(g.expected, 2, 'the album is two tracks now, and two can all succeed')
  assert.ok(!g.files.has('b.flac'))

  // The point of it: the group can now actually complete.
  const dlOrganize = require('../src/download-organize.js')
  assert.ok(dlOrganize.isGroupComplete(g, new Set(['a.flac', 'c.flac'])),
    'with the refused member gone the album verifies; with it there it never could')
})

test('a group whose every file was refused is not left behind as a husk', () => {
  const G = groupFns.globals
  G.dlGroups.clear()
  seedGroup(G, 'peerA::Ghost', ['x.flac'])
  groupFns.fns.dlUntrackGroupFiles(['x.flac'])
  assert.strictEqual(G.dlGroups.size, 0)
})

test('groups that will never complete are evicted at the cap', () => {
  const G = groupFns.globals
  G.dlGroups.clear(); G.dlSucceeded.clear(); G.dlVerifiedGroups.clear()
  for (let i = 0; i < 260; i++) {
    seedGroup(G, 'peerA::Album' + i, ['t' + i + '.flac'])
    G.dlSucceeded.add('t' + i + '.flac')
  }
  const evicted = groupFns.fns.dlCapGroups(200)
  assert.strictEqual(evicted, 60)
  assert.strictEqual(G.dlGroups.size, 200)
  assert.ok(!G.dlGroups.has('peerA::Album0'), 'the oldest goes first')
  assert.ok(G.dlGroups.has('peerA::Album259'), 'the newest stays')
  assert.strictEqual(G.dlSucceeded.size, 200,
    'and the succeeded-filename set shrinks with it, rather than holding remote ' +
    'path strings for albums nobody is waiting on')
})
