'use strict'
// An album with three tracks called "Untitled" downloaded one of them.
//
// _normTitle strips the leading track number, for a good reason: two peers
// number the same song differently ("19 - ItsNot…" vs "21 - ItsNot…") and
// leaving the number in stopped those collapsing across peers. But the
// album-scoped identity used that stripped title too, so "01 - Untitled" and
// "02 - Untitled" off one record produced the SAME identity. addItems merged
// them into one item, addItem refused the rest as duplicates, and dlRestore
// dropped them again on the next start. Twelve tracks queued, ten downloaded,
// no error anywhere.
//
// Plenty of records do this: Led Zeppelin IV, every untitled-track ambient
// release, "Interlude" twice on one album, a "Reprise" at the end.
//
// The real scheduler is used here. The tests pin both halves: same-titled
// tracks of one album must stay separate, and the cross-peer collapse that the
// number-stripping exists for must still fire.

const test = require('node:test')
const assert = require('node:assert')

const dlSched = require('../src/download-scheduler.js')

function freshState() { return dlSched.createState() }

// A folder chain shaped so parseAlbumFolder yields a real artist — that is what
// puts the key in its album-scoped 'a:' form, which is the form this fix
// touches. The parser reads the artist from the folder ABOVE the album, so a
// peer's own shelf name ("shares/", "peerB music/") sits above that and is what
// differs between two peers of one release.
const FOLDER = 'shares/Sigur Ros/( )/'

function untitled(n, size) {
  return { filename: FOLDER + '0' + n + ' - Untitled.flac', size: size,
    sources: [{ username: 'peerA', filename: FOLDER + '0' + n + ' - Untitled.flac', size: size }] }
}

test('the premise: these files really do key in the album-scoped form', () => {
  const id = dlSched.identityKey(untitled(1, 40e6).filename, 40e6)
  assert.ok(id.startsWith('a:'),
    'if this stops being an artist-keyed identity the fix is in the wrong place, got ' + id)
})

test('three tracks called Untitled are three different identities', () => {
  const a = dlSched.identityKey(untitled(1, 40e6).filename, 40e6)
  const b = dlSched.identityKey(untitled(2, 41e6).filename, 41e6)
  const c = dlSched.identityKey(untitled(3, 42e6).filename, 42e6)
  assert.notStrictEqual(a, b)
  assert.notStrictEqual(b, c)
  assert.notStrictEqual(a, c)
})

test('three tracks called Untitled all get added', () => {
  const st = freshState()
  const res = dlSched.addItems(st, [untitled(1, 40e6), untitled(2, 41e6), untitled(3, 42e6)])
  assert.strictEqual(res.added, 3, 'the user asked for three tracks: ' + JSON.stringify(res.refused))
  assert.deepStrictEqual(res.refused, [])
  assert.strictEqual(st.pending.length, 3)
})

test('the same track from two peers still collapses into one item', () => {
  // The whole point of stripping the number is that this keeps working. A fix
  // that separated same-titled tracks by breaking this would be no fix at all.
  const st = freshState()
  const b = 'peerB music/Sigur Ros/( )/01 - Untitled.flac'
  const res = dlSched.addItems(st, [
    { filename: FOLDER + '01 - Untitled.flac', size: 40e6,
      sources: [{ username: 'peerA', filename: FOLDER + '01 - Untitled.flac', size: 40e6 }] },
    { filename: b, size: 40e6, sources: [{ username: 'peerB', filename: b, size: 40e6 }] },
  ])
  assert.strictEqual(res.added, 1, 'one song, not two downloads')
  assert.strictEqual(st.pending.length, 1)
  assert.strictEqual(st.pending[0].sources.length, 2, 'the second peer became an alternate source')
})

test('the loose-single key is untouched — two peers numbering it differently still collapse', () => {
  // The 't:' form: no parseable artist, so title plus size band. This is the
  // case the number-stripping was written for, and it must not regress.
  const a = dlSched.identityKey('witzmankid_stuff/19 - ItsNotUp2You.mp3', 8_000_000)
  const b = dlSched.identityKey('jzdoot shares/21 - ItsNotUp2You.mp3', 8_010_000)
  assert.ok(a.startsWith('t:'), 'this fixture must key in the loose-single form, got ' + a)
  assert.strictEqual(a, b, 'two peers of one loose single are still one want')
})

test('disc numbers count: 1-04 and 2-04 are different tracks', () => {
  const d1 = dlSched.identityKey(FOLDER + '1-04 Reprise.flac', 30e6)
  const d2 = dlSched.identityKey(FOLDER + '2-04 Reprise.flac', 30e6)
  assert.notStrictEqual(d1, d2)
})

test('files with no track number key exactly as they did before', () => {
  const id = dlSched.identityKey(FOLDER + 'Untitled.flac', 40e6)
  assert.ok(id.startsWith('a:'))
  assert.ok(id.includes('||untitled'),
    'an empty track-number segment, so an album without numbers is unchanged: ' + id)
})

test('a leading zero is not a different track from no leading zero', () => {
  // Peers write "04 - X" and "4 - X" for the same track. That must not fork.
  assert.strictEqual(
    dlSched.identityKey(FOLDER + '04 - Untitled.flac', 40e6),
    dlSched.identityKey(FOLDER + '4 - Untitled.flac', 40e6))
})

test('a restore round-trip keeps all three tracks', () => {
  // dlRestore replays the persisted queue through addItem, which is where the
  // duplicate gate lives — this is where the missing tracks actually died, one
  // restart after they were queued.
  const st = freshState()
  dlSched.addItems(st, [untitled(1, 40e6), untitled(2, 41e6), untitled(3, 42e6)])
  const saved = st.pending.map(e => ({
    key: e.key, filename: e.filename, size: e.size, sources: e.sources,
    tried: e.tried, triedAt: e.triedAt, attempts: e.attempts, addedAt: e.addedAt,
  }))
  assert.strictEqual(saved.length, 3)

  const restored = freshState()
  let kept = 0
  for (const e of saved) {
    const entry = dlSched.addItem(restored, {
      filename: e.filename, size: e.size, sources: e.sources, addedAt: e.addedAt,
    })
    if (entry && !entry.refused) kept++
  }
  assert.strictEqual(kept, 3, 'all three survive the restart')
  assert.strictEqual(restored.pending.length, 3)
})

test('cancelling one Untitled does not blacklist the other two', () => {
  // recordAbandoned writes the band-independent song key, and that key shares
  // the album-scoped shape — so without the track number a single cancel took
  // every same-titled track on the record down with it, permanently.
  const st = freshState()
  dlSched.addItems(st, [untitled(1, 40e6), untitled(2, 41e6), untitled(3, 42e6)])
  const victim = st.pending[0]
  dlSched.recordAbandoned(st, victim.key)

  assert.ok(dlSched.isAbandoned(st, victim.filename, victim.key, victim.size),
    'the cancelled one really is blocked')
  for (const survivor of st.pending) {
    assert.ok(!dlSched.isAbandoned(st, survivor.filename, survivor.key, survivor.size),
      survivor.filename + ' was cancelled by proxy')
  }
})
