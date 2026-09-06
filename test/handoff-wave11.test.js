'use strict'
// Wave-11 tests. Three pure surfaces:
//   #72 media-handoff state machine (all six transitions)
//   #44 video-keep-file path/name safety (pure helpers)
//   #74 keymap no-conflict (music vs video grammar)
//   #22 My List collection/franchise grouping heuristic
//
// Everything here is pure — no DOM, no IPC, no mpv — so a transition that drifts
// is a red test at commit time, not a bug found by a user with a film paused.
const test = require('node:test')
const assert = require('node:assert')

// ── #72 Media handoff ─────────────────────────────────────────────────────────
const handoff = require('../src/media-handoff')

test('#72 t1: video-start while music plays → pause music, debt owed', () => {
  const h = handoff.create()
  const act = h.onVideoStart(true)
  assert.deepStrictEqual(act, { target: 'music', op: 'pause' })
  assert.deepStrictEqual(h.state(), { musicOwesResume: true, videoOwesResume: false })
})

test('#72 t2: video-start while music paused → nothing owed', () => {
  const h = handoff.create()
  const act = h.onVideoStart(false)
  assert.strictEqual(act, null)
  assert.deepStrictEqual(h.state(), { musicOwesResume: false, videoOwesResume: false })
})

test('#72 t3: video-stop with debt → resume music, debt cleared', () => {
  const h = handoff.create()
  h.onVideoStart(true)
  const act = h.onVideoStop()
  assert.deepStrictEqual(act, { target: 'music', op: 'resume' })
  assert.deepStrictEqual(h.state(), { musicOwesResume: false, videoOwesResume: false })
})

test('#72 t3b: video-stop with no debt → nothing', () => {
  const h = handoff.create()
  h.onVideoStart(false)
  assert.strictEqual(h.onVideoStop(), null)
})

test('#72 t4: music-start while video plays → pause video, debt owed', () => {
  const h = handoff.create()
  const act = h.onMusicStart(true)
  assert.deepStrictEqual(act, { target: 'video', op: 'pause' })
  assert.deepStrictEqual(h.state(), { musicOwesResume: false, videoOwesResume: true })
})

test('#72 t4b: music-start while video paused/absent → nothing owed', () => {
  const h = handoff.create()
  assert.strictEqual(h.onMusicStart(false), null)
  assert.deepStrictEqual(h.state(), { musicOwesResume: false, videoOwesResume: false })
})

test('#72 t5: music-stop with debt → resume video, debt cleared', () => {
  const h = handoff.create()
  h.onMusicStart(true)
  const act = h.onMusicStop()
  assert.deepStrictEqual(act, { target: 'video', op: 'resume' })
  assert.deepStrictEqual(h.state(), { musicOwesResume: false, videoOwesResume: false })
})

test('#72 t6: user plays other music after video paused it → no auto-resume', () => {
  const h = handoff.create()
  h.onVideoStart(true)                 // music paused, debt owed
  h.onMusicUserAction()                // user starts other music
  assert.strictEqual(h.onVideoStop(), null, 'video-close must not resume music the user re-owned')
  assert.deepStrictEqual(h.state(), { musicOwesResume: false, videoOwesResume: false })
})

test('#72 symmetry: starting one side voids the other side owing it', () => {
  const h = handoff.create()
  h.onVideoStart(true)   // musicOwesResume = true
  h.onMusicStart(true)   // now music foreground: music debt void, video debt set
  assert.deepStrictEqual(h.state(), { musicOwesResume: false, videoOwesResume: true })
})

test('#72 user-pausing the film voids the resume it owed music', () => {
  const h = handoff.create()
  h.onMusicStart(true)     // videoOwesResume = true
  h.onVideoUserAction()    // user pauses the film themselves
  assert.strictEqual(h.onMusicStop(), null)
})

test('#72 a full round-trip returns to a clean slate', () => {
  const h = handoff.create()
  assert.deepStrictEqual(h.onVideoStart(true), { target: 'music', op: 'pause' })
  assert.deepStrictEqual(h.onVideoStop(), { target: 'music', op: 'resume' })
  assert.deepStrictEqual(h.onMusicStart(true), { target: 'video', op: 'pause' })
  assert.deepStrictEqual(h.onMusicStop(), { target: 'video', op: 'resume' })
  assert.deepStrictEqual(h.state(), { musicOwesResume: false, videoOwesResume: false })
})

test('#72 reset clears every debt', () => {
  const h = handoff.create()
  h.onVideoStart(true)
  h.reset()
  assert.deepStrictEqual(h.state(), { musicOwesResume: false, videoOwesResume: false })
})

// ── #44 video-keep-file path safety ───────────────────────────────────────────
const keep = require('../src/video-keep')

test('#44 sanitizes a filename: strips separators and unsafe chars', () => {
  assert.strictEqual(keep.sanitizeName('The Matrix (1999).mkv'), 'The Matrix (1999).mkv')
  assert.strictEqual(keep.sanitizeName('a/b\\c:d*e?.mkv'), 'a_b_c_d_e_.mkv')
  assert.strictEqual(keep.sanitizeName('  ..\t\n leading  '), 'leading')
})

test('#44 sanitizeName never returns a path-traversal fragment', () => {
  const bad = keep.sanitizeName('../../etc/passwd')
  assert.ok(!bad.includes('/'), 'no separators survive')
  assert.ok(!bad.includes('..'), 'no parent-dir dots')
})

test('#44 sanitizeName falls back when nothing safe is left', () => {
  assert.strictEqual(keep.sanitizeName('///'), 'video')
  assert.strictEqual(keep.sanitizeName(''), 'video')
  assert.strictEqual(keep.sanitizeName(null), 'video')
})

test('#44 destPath joins root/show/file with sanitized segments', () => {
  const p = keep.destPath('/home/u/Videos/Papa Audio', 'Breaking Bad', 'S01E01.mkv')
  assert.strictEqual(p, '/home/u/Videos/Papa Audio/Breaking Bad/S01E01.mkv')
})

test('#44 destPath sanitizes a malicious show name into one segment', () => {
  // Leading ../ is stripped entirely, so a traversal attempt collapses to its
  // safe tail — one segment, no separators, no parent-dir climb.
  const p = keep.destPath('/root', '../../etc', 'x.mkv')
  assert.strictEqual(p, '/root/etc/x.mkv')
  assert.ok(!p.includes('/../'), 'no traversal in the joined path')
  // An interior separator (not leading) still collapses to underscores.
  const p2 = keep.destPath('/root', 'a/../b', 'x.mkv')
  assert.strictEqual(p2, '/root/a_.._b/x.mkv')
  assert.ok(!p2.includes('/../'))
})

test('#44 destPath uses a default show folder when show is blank', () => {
  const p = keep.destPath('/root', '', 'x.mkv')
  assert.strictEqual(p, '/root/Videos/x.mkv')
})

test('#44 isComplete only when bytes reach the total', () => {
  assert.strictEqual(keep.isComplete({ bytes: 100, total: 100 }), true)
  assert.strictEqual(keep.isComplete({ bytes: 120, total: 100 }), true)
  assert.strictEqual(keep.isComplete({ bytes: 99, total: 100 }), false)
  assert.strictEqual(keep.isComplete({ bytes: 0, total: 0 }), false)
  assert.strictEqual(keep.isComplete(null), false)
})

// ── #74 keymap no-conflict ────────────────────────────────────────────────────
// The two grammars share one document. They must never both act on the same
// keypress. This asserts the shared concepts share keys and no letter fires two
// unrelated handlers on the same page/context.
const { auditKeymapConflicts, MUSIC_KEYS, VIDEO_KEYS } = require('../src/keymap-audit')

test('#74 shared concepts use the same base key across contexts', () => {
  // Space = play/pause, m = mute, f = fullscreen in both grammars.
  for (const shared of [' ', 'm', 'f']) {
    assert.ok(MUSIC_KEYS[shared], 'music binds ' + JSON.stringify(shared))
    assert.ok(VIDEO_KEYS[shared], 'video binds ' + JSON.stringify(shared))
  }
})

test('#74 no key means two different things across the grammars', () => {
  const conflicts = auditKeymapConflicts()
  assert.deepStrictEqual(conflicts, [],
    'keys that do different things in music vs video (would double-fire if both handlers ran): ' +
    conflicts.map(c => c.key + ' → music:' + c.music + ' video:' + c.video).join(', '))
})

// ── #22 My List collection / franchise grouping ───────────────────────────────
const { groupMyList } = require('../src/mylist-group')

test('#22 groups 2+ items sharing a stored collection', () => {
  const items = [
    { type: 'movie', id: '1', title: 'Iron Man', collection: { id: 86311, name: 'The Avengers Collection' } },
    { type: 'movie', id: '2', title: 'The Avengers', collection: { id: 86311, name: 'The Avengers Collection' } },
    { type: 'movie', id: '3', title: 'Dune', collection: null },
  ]
  const groups = groupMyList(items)
  assert.strictEqual(groups.length, 2)
  const coll = groups.find(g => g.grouped)
  assert.strictEqual(coll.name, 'The Avengers Collection')
  assert.strictEqual(coll.items.length, 2)
  const solo = groups.find(g => !g.grouped)
  assert.strictEqual(solo.items.length, 1)
  assert.strictEqual(solo.items[0].title, 'Dune')
})

test('#22 a lone collection member is not grouped', () => {
  const items = [
    { type: 'movie', id: '1', title: 'Iron Man', collection: { id: 86311, name: 'Avengers' } },
    { type: 'movie', id: '2', title: 'Dune' },
  ]
  const groups = groupMyList(items)
  assert.ok(groups.every(g => !g.grouped), 'no group forms from a single member')
  assert.strictEqual(groups.length, 2)
})

test('#22 falls back to franchise title-prefix when collection is absent', () => {
  const items = [
    { type: 'movie', id: '1', title: 'Mission: Impossible' },
    { type: 'movie', id: '2', title: 'Mission: Impossible - Fallout' },
    { type: 'movie', id: '3', title: 'Dune' },
  ]
  const groups = groupMyList(items)
  const fr = groups.find(g => g.grouped)
  assert.ok(fr, 'a franchise group forms from the shared leading words')
  assert.strictEqual(fr.items.length, 2)
  assert.ok(/Mission/i.test(fr.name))
})

test('#22 stored collection wins over the title heuristic', () => {
  // Same collection id but titles that would NOT share a prefix — grouping must
  // still bind them, proving it reads the stored field first.
  const items = [
    { type: 'movie', id: '1', title: 'Alien', collection: { id: 8091, name: 'Alien Collection' } },
    { type: 'movie', id: '2', title: 'Aliens', collection: { id: 8091, name: 'Alien Collection' } },
  ]
  const groups = groupMyList(items)
  assert.strictEqual(groups.length, 1)
  assert.strictEqual(groups[0].name, 'Alien Collection')
})

test('#22 a single leading word is not enough to franchise', () => {
  // "The Matrix" and "The Terminator" share only the stop-word "The".
  const items = [
    { type: 'movie', id: '1', title: 'The Matrix' },
    { type: 'movie', id: '2', title: 'The Terminator' },
  ]
  const groups = groupMyList(items)
  assert.ok(groups.every(g => !g.grouped), 'a bare article must not fake a franchise')
})

test('#22 empty list yields no groups', () => {
  assert.deepStrictEqual(groupMyList([]), [])
  assert.deepStrictEqual(groupMyList(null), [])
})
