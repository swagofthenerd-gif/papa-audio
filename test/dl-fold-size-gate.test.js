'use strict'
// The 5.1-versus-stereo scar, re-opened on the enqueue path.
//
// _foldSources folds a second peer's copy of a track in as an alternate source
// of the first. Its only gate was the quality fingerprint — and on an enqueue
// payload bitDepth and sampleRate are undefined, so compatible() collapses to
// "is it lossless". A 5.1 FLAC and a stereo FLAC of the same track, in the same
// album, under the same title, both pass that. So the surround copy was folded
// in as a substitute for the stereo one and the album came down half surround,
// half not — which is precisely the failure this scheduler was written after.
//
// Discovery (main.js, dlDiscoverForItem) and the seed hunt both apply
// sameRecordingSize's 2% rule. This path did not, so DL-All, the respread, the
// wishlist and retry all skipped it.
//
// The real scheduler and the real sameRecordingSize are used here.

const test = require('node:test')
const assert = require('node:assert')

const dlSched = require('../src/download-scheduler.js')

// Same artist, same album, same title, same extension — everything an identity
// and a fingerprint can see is identical. Only the byte count differs.
const STEREO = 'shares/Pink Floyd/The Wall/08 - Another Brick.flac'
const SURROUND = 'other peer/Pink Floyd/The Wall/08 - Another Brick.flac'

const STEREO_BYTES = 30_000_000
const SURROUND_BYTES = 92_000_000

function item(filename, size, username) {
  return { filename, size, sources: [{ username, filename, size }] }
}

test('the premise: these two files are one identity and one fingerprint', () => {
  // If either of these stops being true the merge could not happen anyway, and
  // this file should be revisited rather than quietly kept.
  assert.strictEqual(
    dlSched.identityKey(STEREO, STEREO_BYTES),
    dlSched.identityKey(SURROUND, SURROUND_BYTES),
    'they must group together, or nothing is being tested')
})

test('a 92 MB copy is not folded in as an alternate for a 30 MB one', () => {
  const st = dlSched.createState()
  const res = dlSched.addItems(st, [
    item(STEREO, STEREO_BYTES, 'peerA'),
    item(SURROUND, SURROUND_BYTES, 'peerB'),
  ])
  assert.strictEqual(res.added, 1, 'one item, as before')
  assert.strictEqual(st.pending.length, 1)
  assert.strictEqual(st.pending[0].sources.length, 1,
    'the surround copy must NOT be a source of the stereo item — dispatching it ' +
    'would put a 5.1 file where a stereo one was asked for')
  assert.strictEqual(res.merged, 0)
})

test('the rejection says both sizes, so a person can see why', () => {
  const st = dlSched.createState()
  dlSched.addItems(st, [item(STEREO, STEREO_BYTES, 'peerA'), item(SURROUND, SURROUND_BYTES, 'peerB')])
  const rejected = (st.subLog || []).filter(e => !e.accepted)
  assert.strictEqual(rejected.length, 1)
  assert.ok(rejected[0].reason.includes(String(STEREO_BYTES)), rejected[0].reason)
  assert.ok(rejected[0].reason.includes(String(SURROUND_BYTES)), rejected[0].reason)
  assert.strictEqual(rejected[0].candidate, 'peerB')
})

test('the same recording from another peer still folds in', () => {
  // The gate must not break the thing folding exists for. Two peers of one rip
  // differ by a few bytes of tagging at most.
  const st = dlSched.createState()
  const res = dlSched.addItems(st, [
    item(STEREO, STEREO_BYTES, 'peerA'),
    item(SURROUND, STEREO_BYTES + 4000, 'peerB'),
  ])
  assert.strictEqual(res.added, 1)
  assert.strictEqual(st.pending[0].sources.length, 2, 'peerB is a real alternate')
  assert.strictEqual(res.merged, 1)
})

test('a re-rip inside the 2% band is accepted, one just outside is not', () => {
  // The band, at its edges. 2% of 30 MB is 600,000 bytes.
  const inside = dlSched.createState()
  dlSched.addItems(inside, [
    item(STEREO, STEREO_BYTES, 'peerA'),
    item(SURROUND, STEREO_BYTES + 590_000, 'peerB'),
  ])
  assert.strictEqual(inside.pending[0].sources.length, 2, 'inside the band')

  const outside = dlSched.createState()
  dlSched.addItems(outside, [
    item(STEREO, STEREO_BYTES, 'peerA'),
    item(SURROUND, STEREO_BYTES + 700_000, 'peerB'),
  ])
  assert.strictEqual(outside.pending[0].sources.length, 1, 'outside the band')
})

test('an unknown size on either side is refused, not waved through', () => {
  // Fail-closed, the same direction sameRecordingSize takes everywhere else: an
  // unverifiable substitution is exactly how the wrong file gets downloaded and
  // called done.
  const noCand = dlSched.createState()
  dlSched.addItems(noCand, [
    item(STEREO, STEREO_BYTES, 'peerA'),
    { filename: SURROUND, sources: [{ username: 'peerB', filename: SURROUND }] },
  ])
  assert.strictEqual(noCand.pending[0].sources.length, 1)

  const noAnchor = dlSched.createState()
  dlSched.addItems(noAnchor, [
    { filename: STEREO, sources: [{ username: 'peerA', filename: STEREO }] },
    item(SURROUND, SURROUND_BYTES, 'peerB'),
  ])
  assert.strictEqual(noAnchor.pending[0].sources.length, 1)
})

test('the size on a source is read when the item itself carries none', () => {
  // Enqueue payloads arrive both ways: some callers put the size on the item,
  // some only on its sources. A gate that only looked at the item would refuse
  // every legitimate fold from the second kind of caller.
  const st = dlSched.createState()
  const res = dlSched.addItems(st, [
    { filename: STEREO, sources: [{ username: 'peerA', filename: STEREO, size: STEREO_BYTES }] },
    { filename: SURROUND, sources: [{ username: 'peerB', filename: SURROUND, size: STEREO_BYTES }] },
  ])
  assert.strictEqual(res.added, 1)
  assert.strictEqual(st.pending[0].sources.length, 2)
})

test('the same rule discovery uses, not a second copy of it', () => {
  // A duplicated 2% constant drifts. The fold must call the exported function.
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'download-scheduler.js'), 'utf8')
  const at = src.indexOf('function _foldSources(')
  const body = src.slice(at, src.indexOf('\nfunction peerBenched', at))
  assert.ok(body.includes('sameRecordingSize('),
    '_foldSources must use sameRecordingSize, not its own size arithmetic')
})
