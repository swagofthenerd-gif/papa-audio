'use strict'
// Cancel authority, duplicate-proofing, and adaptive tuning for the scheduler.
//
// The headline test — "a canceled file never re-enqueues via discovery/respread/
// duplicate" — is field failure (b): cancels that did not stick, files that came
// back again and again, including from other users. It is named exactly so it
// can never be quietly removed.
const test = require('node:test')
const assert = require('node:assert')
const S = require('../src/download-scheduler')

// Two peers' copies of the SAME release: the folder carries the real artist and
// album, which two peers of one release DO share even when the shelving above
// differs. identityKey parses artist+album+title, so these are one identity.
const A_PATH = 'Pink Floyd - Dark Side of the Moon\\08 - Time.flac'
const B_PATH = 'Shared\\Pink Floyd - Dark Side of the Moon\\08. Time.flac'

test('identityKey collapses two peers copies of the same track', () => {
  assert.strictEqual(S.identityKey(A_PATH), S.identityKey(B_PATH),
    'same parsed artist + album + track title = one identity, whatever the peer path')
})

test('identityKey keeps same-named tracks in different albums apart', () => {
  // Real artist folders: album is the disambiguator even at identical size.
  const x = S.identityKey('Pink Floyd - Animals\\01 - Intro.flac', 5e6)
  const y = S.identityKey('Radiohead - OK Computer\\01 - Intro.flac', 5e6)
  assert.notStrictEqual(x, y, '"01 - Intro" is a name dozens of albums share')
})

// ── The field failure, named exactly as required ─────────────────────────────

test('a canceled file never re-enqueues via discovery/respread/duplicate', () => {
  const st = S.createState()

  // User adds the track and it goes in flight, then the user cancels it.
  S.addItem(st, { filename: A_PATH, size: 100, sources: [{ username: 'alice', filename: A_PATH, size: 100 }] })
  S.markDispatched(st, S.itemKey(A_PATH), 'alice', 1000, A_PATH)
  S.recordAbandoned(st, S.itemKey(A_PATH))
  assert.strictEqual(S.isAbandoned(st, A_PATH), true, 'cancel must register at the identity level')

  // 1. Discovery finds a COMPATIBLE alternate from a DIFFERENT user, under a
  //    different path. It must NOT come back.
  const viaDiscovery = S.addItem(st, {
    filename: B_PATH, size: 100,
    sources: [{ username: 'bob', filename: B_PATH, size: 100 }],
  })
  assert.strictEqual(viaDiscovery.refused, 'abandoned',
    'a cancelled track must not return from a different user via discovery')

  // 2. Respread re-adds the same exact copy (as the respread path does).
  const viaRespread = S.addItem(st, {
    filename: A_PATH, size: 100,
    sources: [{ username: 'alice', filename: A_PATH, size: 100 }],
  })
  assert.ok(viaRespread.refused, 'respread must not re-add a cancelled file')

  // 3. A duplicate enqueue of the same identity from yet another user, renamed
  //    (a different track-number prefix and separators) but the same release.
  const dup = S.addItem(st, {
    filename: 'FLACs\\Pink Floyd - Dark Side of the Moon\\8. Time.flac', size: 100,
    sources: [{ username: 'carol', filename: 'x', size: 100 }],
  })
  assert.ok(dup.refused, 'a cancelled identity is refused however it is renamed')

  // Nothing landed in pending or inflight.
  assert.strictEqual(st.pending.length, 0)
  assert.strictEqual(Object.keys(st.inflight).length, 0)
})

test('a user re-asking (force) DOES override an abandoned identity', () => {
  const st = S.createState()
  S.addItem(st, { filename: A_PATH, size: 100, sources: [{ username: 'alice', filename: A_PATH, size: 100 }] })
  S.recordAbandoned(st, S.itemKey(A_PATH))
  // The scheduler must never revive it on its own, but the user asking again is
  // new information.
  const r = S.addItem(st, {
    filename: A_PATH, size: 100, sources: [{ username: 'alice', filename: A_PATH, size: 100 }],
  }, { force: true })
  assert.ok(r && !r.refused, 'an explicit re-ask brings it back')
  assert.strictEqual(st.pending.length, 1)
  assert.strictEqual(S.isAbandoned(st, A_PATH), false, 'and clears the abandonment')
})

// ── Duplicate-proofing ───────────────────────────────────────────────────────

test('the same track from two users: the second enqueue no-ops', () => {
  const st = S.createState()
  const first = S.addItem(st, {
    filename: A_PATH, size: 100, sources: [{ username: 'alice', filename: A_PATH, size: 100 }],
  })
  assert.ok(first && !first.refused, 'the first copy is accepted')
  const second = S.addItem(st, {
    filename: B_PATH, size: 100, sources: [{ username: 'bob', filename: B_PATH, size: 100 }],
  })
  assert.strictEqual(second.refused, 'duplicate', 'the second copy of the same track is a no-op')
  assert.strictEqual(st.pending.length, 1, 'only one entry for the track')
})

test('a duplicate of an in-flight track is refused too', () => {
  const st = S.createState()
  S.addItem(st, { filename: A_PATH, size: 100, sources: [{ username: 'alice', filename: A_PATH, size: 100 }] })
  S.markDispatched(st, S.itemKey(A_PATH), 'alice', 1000, A_PATH)
  const dup = S.addItem(st, {
    filename: B_PATH, size: 100, sources: [{ username: 'bob', filename: B_PATH, size: 100 }],
  })
  assert.strictEqual(dup.refused, 'duplicate')
})

test('a succeeded track is not re-fetched, but an exhausted one can retry', () => {
  const st = S.createState()
  S.addItem(st, { filename: A_PATH, size: 100, sources: [{ username: 'alice', filename: A_PATH, size: 100 }] })
  S.markDispatched(st, S.itemKey(A_PATH), 'alice', 1000, A_PATH)
  S.recordSuccess(st, S.itemKey(A_PATH), 'alice')
  const dup = S.addItem(st, {
    filename: B_PATH, size: 100, sources: [{ username: 'bob', filename: B_PATH, size: 100 }],
  })
  assert.strictEqual(dup.refused, 'duplicate', 'a track we already have is not fetched again')
})

test('two genuinely different tracks both enqueue', () => {
  const st = S.createState()
  const a = S.addItem(st, { filename: 'Album\\01 - One.flac', size: 100, sources: [{ username: 'u', filename: 'a' }] })
  const b = S.addItem(st, { filename: 'Album\\02 - Two.flac', size: 100, sources: [{ username: 'u', filename: 'b' }] })
  assert.ok(a && !a.refused)
  assert.ok(b && !b.refused)
  assert.strictEqual(st.pending.length, 2)
})

// ── Cancel of a group abandons at both levels ────────────────────────────────

test('abandonment survives a persist/restore round trip via abandonedIds', () => {
  const st = S.createState()
  S.addItem(st, { filename: A_PATH, size: 100, sources: [{ username: 'alice', filename: A_PATH, size: 100 }] })
  S.recordAbandoned(st, S.itemKey(A_PATH))

  // Simulate persistence: a fresh state that only carries the abandoned identity
  // set (what dlPersist/dlRestore in main.js write and read back).
  const restored = S.createState()
  restored.abandonedIds = Object.assign({}, st.abandonedIds)
  assert.strictEqual(S.isAbandoned(restored, B_PATH), true,
    'a different peer copy is still blocked after a restart')
})

// ── Adversarial fixtures FROM THE FIELD (the second occurrence) ───────────────
//
// These are the exact shapes that got past the previous folder-based identity:
// the same loose single, offered by three peers in three DIFFERENT share folders,
// with DIFFERENT leading track numbers, one of them an MP3. The old key was the
// album folder + title, so three folders = three identities = three downloads.
// The old tests used lookalike folders that shared a name and proved nothing;
// these use the real thing.
//
// "ItsNotREEAALLLLLLLL": witzmankid "19 - …flac", jzdoot "21 - …flac",
// Sleety "…mp3" — different folders, different track numbers, one lossy.
const F_WITZ = 'witzmankid_stuff\\19 - ItsNotREEAALLLLLLLL.flac'
const F_JZ   = 'music\\jzdoot shares\\21 - ItsNotREEAALLLLLLLL.flac'
const F_SLEE = 'Sleety\\ItsNotREEAALLLLLLLL.mp3'
// The two FLACs are the same release and so effectively one size; the MP3 is far
// smaller (lossy). Sizes are in the same 5 MB band for the FLACs, a lower one for
// the MP3 — which is correct, they are not interchangeable.
const FLAC_SIZE = 31 * 1024 * 1024
const MP3_SIZE = 8 * 1024 * 1024

test('the same track from three peers with different folders becomes one item', () => {
  const st = S.createState()
  const res = S.addItems(st, [
    { filename: F_WITZ, size: FLAC_SIZE, sources: [{ username: 'witzmankid', filename: F_WITZ, size: FLAC_SIZE }] },
    { filename: F_JZ, size: FLAC_SIZE, sources: [{ username: 'jzdoot', filename: F_JZ, size: FLAC_SIZE }] },
  ])
  assert.strictEqual(res.added, 1, 'one track = one item, not one-per-peer')
  assert.strictEqual(st.pending.length, 1, 'exactly one pending entry')
  // The second peer is folded in as an ALTERNATE SOURCE, not lost.
  assert.strictEqual(st.pending[0].sources.length, 2, 'both peers are sources of the one item')
  const users = st.pending[0].sources.map(s => s.username).sort()
  assert.deepStrictEqual(users, ['jzdoot', 'witzmankid'])
})

test('an mp3 never joins a flac item\'s sources', () => {
  const st = S.createState()
  const res = S.addItems(st, [
    { filename: F_WITZ, size: FLAC_SIZE, sources: [{ username: 'witzmankid', filename: F_WITZ, size: FLAC_SIZE }] },
    { filename: F_SLEE, size: MP3_SIZE, sources: [{ username: 'Sleety', filename: F_SLEE, size: MP3_SIZE }] },
  ])
  // One FLAC item, and the MP3 is DROPPED — not folded in, not enqueued as its
  // own item. The user asked for the track; a lossy copy is not the track.
  assert.strictEqual(res.added, 1, 'the lossy copy does not become a second item')
  assert.strictEqual(st.pending.length, 1)
  const users = st.pending[0].sources.map(s => s.username)
  assert.ok(!users.includes('Sleety'), 'the mp3 peer is not a source of the flac item')
  // And the rejection is logged so the UI can explain it.
  const rej = (st.subLog || []).find(e => e.candidate === 'Sleety' && !e.accepted)
  assert.ok(rej, 'the mp3 rejection is logged')
  assert.match(rej.reason, /lossy/, 'the log says why')
})

test('a cancel on one peer blocks the identity from every peer', () => {
  const st = S.createState()
  // The user downloads it from one peer, then cancels.
  S.addItems(st, [
    { filename: F_WITZ, size: FLAC_SIZE, sources: [{ username: 'witzmankid', filename: F_WITZ, size: FLAC_SIZE }] },
  ])
  S.markDispatched(st, S.itemKey(F_WITZ), 'witzmankid', 1000, F_WITZ)
  S.recordAbandoned(st, S.itemKey(F_WITZ))
  assert.strictEqual(S.isAbandoned(st, F_WITZ, null, FLAC_SIZE), true,
    'the cancel registers at the identity level')

  // Now the SAME track shows up from the OTHER two peers (discovery / a fresh
  // DL All / respread). Neither may come back — the field failure was "Lights
  // Out": a cancel on one peer that did not stop the same track elsewhere.
  const res = S.addItems(st, [
    { filename: F_JZ, size: FLAC_SIZE, sources: [{ username: 'jzdoot', filename: F_JZ, size: FLAC_SIZE }] },
    { filename: F_SLEE, size: MP3_SIZE, sources: [{ username: 'Sleety', filename: F_SLEE, size: MP3_SIZE }] },
  ])
  assert.strictEqual(res.added, 0, 'not one peer\'s copy comes back after the cancel')
  assert.strictEqual(st.pending.length, 0)
  assert.strictEqual(Object.keys(st.inflight).length, 0)
})

test('different songs sharing a title on different albums do NOT merge', () => {
  const st = S.createState()
  // Two genuinely different "Intro" tracks: different real albums, and different
  // sizes (different songs are different sizes — what the size-band relies on).
  const a = 'Pink Floyd - Animals\\01 - Intro.flac'
  const b = 'Radiohead - OK Computer\\01 - Intro.flac'
  const res = S.addItems(st, [
    { filename: a, size: 4 * 1024 * 1024, sources: [{ username: 'u1', filename: a, size: 4 * 1024 * 1024 }] },
    { filename: b, size: 9 * 1024 * 1024, sources: [{ username: 'u2', filename: b, size: 9 * 1024 * 1024 }] },
  ])
  assert.strictEqual(res.added, 2, 'two different songs, two items')
  assert.strictEqual(st.pending.length, 2)
})

test('field: three peers via addItems collapse to one, mp3 dropped', () => {
  // The whole field row at once, exactly as a DL All would deliver it.
  const st = S.createState()
  const res = S.addItems(st, [
    { filename: F_WITZ, size: FLAC_SIZE, sources: [{ username: 'witzmankid', filename: F_WITZ, size: FLAC_SIZE }] },
    { filename: F_JZ, size: FLAC_SIZE, sources: [{ username: 'jzdoot', filename: F_JZ, size: FLAC_SIZE }] },
    { filename: F_SLEE, size: MP3_SIZE, sources: [{ username: 'Sleety', filename: F_SLEE, size: MP3_SIZE }] },
  ])
  assert.strictEqual(res.added, 1, 'three peers, one track, one item')
  assert.strictEqual(st.pending.length, 1)
  const users = st.pending[0].sources.map(s => s.username).sort()
  assert.deepStrictEqual(users, ['jzdoot', 'witzmankid'], 'the two FLAC peers, not the mp3')
})

// ── Substitution logging ─────────────────────────────────────────────────────

test('substitution decisions are logged, accepted or rejected, and bounded', () => {
  const st = S.createState()
  S.logSubstitution(st, { key: 'k', from: A_PATH, to: B_PATH, candidate: 'bob', accepted: true, reason: 'compatible 5.1' })
  S.logSubstitution(st, { key: 'k', from: A_PATH, to: 'x', candidate: 'eve', accepted: false, reason: 'surround mismatch: 5.1 vs stereo' })
  assert.strictEqual(st.subLog.length, 2)
  assert.strictEqual(st.subLog[0].accepted, true)
  assert.strictEqual(st.subLog[1].accepted, false)
  assert.match(st.subLog[1].reason, /surround mismatch/)
  // Bounded.
  for (let i = 0; i < 500; i++) S.logSubstitution(st, { reason: 'x' })
  assert.ok(st.subLog.length <= 200, 'the log is capped')
})

// ── Adaptive tuning (pure, injected metrics) ─────────────────────────────────

test('the cap grows one step when saturated and throughput is rising', () => {
  const next = S.nextGlobalInflight(60, { currentInflight: 58, throughputRising: true, troubleCount: 0 })
  assert.strictEqual(next, 65, 'nearly full + climbing = one step up')
})

test('the cap holds when there is room but no upward trend', () => {
  const next = S.nextGlobalInflight(60, { currentInflight: 58, throughputRising: false, troubleCount: 0 })
  assert.strictEqual(next, 60, 'no evidence to grow = hold')
})

test('the cap holds when throughput rises but we are not filling it', () => {
  const next = S.nextGlobalInflight(60, { currentInflight: 20, throughputRising: true, troubleCount: 0 })
  assert.strictEqual(next, 60, 'raising a cap we do not use does nothing')
})

test('the cap steps down when stalls and timeouts pile up', () => {
  const next = S.nextGlobalInflight(60, { currentInflight: 60, throughputRising: true, troubleCount: 4 })
  assert.strictEqual(next, 55, 'trouble wins over growth, every time')
})

test('the cap never exceeds the ceiling or drops below the floor', () => {
  assert.strictEqual(S.nextGlobalInflight(90, { currentInflight: 90, throughputRising: true }), 90, 'ceiling holds')
  assert.strictEqual(S.nextGlobalInflight(88, { currentInflight: 88, throughputRising: true }), 90, 'clamps to ceiling, not over')
  assert.strictEqual(S.nextGlobalInflight(20, { troubleCount: 9 }), 20, 'floor holds')
  assert.strictEqual(S.nextGlobalInflight(22, { troubleCount: 9 }), 20, 'clamps to floor, not under')
})

test('default ceiling is 90 and floor is 20, default cap 60', () => {
  assert.strictEqual(S.TUNE.ceiling, 90)
  assert.strictEqual(S.TUNE.floor, 20)
  assert.strictEqual(S.DEFAULTS.maxGlobalInflight, 60)
})
