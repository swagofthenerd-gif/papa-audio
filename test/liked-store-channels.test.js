'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// Two separate stores, two separate channel pairs:
//   getLiked / saveLiked             <-> likedAlbums  (album id hashes)
//   getLikedTracks / saveLikedTracks <-> likedTracks  (absolute file paths)
//
// Crossing them is silent and destructive: it replaces one store's contents
// with the other's shape, and the next ordinary save persists the corruption.
// This happened twice, in two unrelated places, so it is worth pinning.
//
// It was pinned, but only as four forbidden spellings — regexes that forbade
// `saveLiked(state.likedTracks)` written exactly that way. One local variable
// of indirection walked straight past all four, and the same file already
// contains `saveLiked(keep)`, so that form is not hypothetical. Worse, all four
// were assertions of ABSENCE: deleting every save call left them green. The
// real functions are lifted and run below, and what reaches each channel is
// checked against the shape that channel stores.

function lift(names, deps) {
  let code = ''
  for (const [from, to] of names) {
    const a = SRC.indexOf(from)
    assert.ok(a > -1, 'renderer.js must still contain: ' + from.split('\n')[0])
    const b = SRC.indexOf(to, a + from.length)
    assert.ok(b > a, 'and it must still be followed by: ' + to.split('\n')[0])
    code += SRC.slice(a, b) + '\n'
  }
  const keys = Object.keys(deps)
  return new Function(...keys, code + '\nreturn { toggleTrackLike: typeof toggleTrackLike === "function" ? toggleTrackLike : null, toggleLike: typeof toggleLike === "function" ? toggleLike : null }')(
    ...keys.map(k => deps[k]))
}

// Everything a like touches, recorded. `saved` is what went down each channel.
function harness(over = {}) {
  const state = Object.assign({
    likedAlbums: ['alb-aphex', 'alb-boards'],
    likedTracks: ['/m/xtal.flac', '/m/rhubarb.flac'],
    currentPage: 'album', currentAlbumId: 'alb-aphex', library: [],
  }, over)
  const saved = { liked: [], likedTracks: [] }
  const store = {}
  const snacks = []
  const api = {
    saveLiked: v => saved.liked.push(v),
    saveLikedTracks: v => saved.likedTracks.push(v),
  }
  const lifted = lift([
    ['function toggleTrackLike(filePath) {', '\nconst GENRE_COLORS'],
    ['function toggleLike(albumId) {', '\nfunction updateLikeBtn('],
  ], {
    state,
    window: { api, PapaLocal: { readArray: k => { try { return JSON.parse(store[k]) || [] } catch (_) { return [] } } } },
    localStorage: { setItem: (k, v) => { store[k] = v }, getItem: k => store[k] },
    showSnackbar: (msg, label, undo) => snacks.push({ msg, label, undo }),
    navigate: () => {},
    _currentNavId: () => null,
    updateLikeBtn: () => {},
  })
  return { ...lifted, state, saved, snacks, store }
}

// The value a channel is handed must look like what that channel stores.
const looksLikePaths = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.startsWith('/'))
const looksLikeAlbumIds = v => Array.isArray(v) && v.every(x => typeof x === 'string' && !x.startsWith('/'))

test('liking a track writes file paths, and only down the tracks channel', () => {
  const h = harness()
  assert.strictEqual(h.toggleTrackLike('/m/avril14.flac'), true)
  assert.strictEqual(h.saved.liked.length, 0, 'the ALBUM store must not be written by a track like')
  assert.strictEqual(h.saved.likedTracks.length, 1)
  const written = h.saved.likedTracks[0]
  assert.ok(looksLikePaths(written), 'saveLikedTracks stores paths: ' + JSON.stringify(written))
  assert.ok(written.includes('/m/avril14.flac'))
  assert.strictEqual(written.length, 3, 'and keeps what was already there')
})

test('liking an album writes album ids, and only down the albums channel', () => {
  const h = harness()
  h.toggleLike('alb-selected')
  assert.strictEqual(h.saved.likedTracks.length, 0, 'the TRACK store must not be written by an album like')
  const written = h.saved.liked[0]
  assert.ok(looksLikeAlbumIds(written), 'saveLiked stores album ids: ' + JSON.stringify(written))
  assert.ok(written.includes('alb-selected'))
  assert.strictEqual(written.length, 3)
})

test('one store is never handed the other\'s contents', () => {
  // The corruption in full: after both kinds of like, neither channel has ever
  // been handed the other shape. A cross would have persisted on the next save.
  const h = harness()
  h.toggleTrackLike('/m/avril14.flac')
  h.toggleLike('alb-selected')
  h.toggleTrackLike('/m/xtal.flac')      // unlike
  h.toggleLike('alb-aphex')              // unlike
  for (const v of h.saved.liked) assert.ok(looksLikeAlbumIds(v), 'an album-id list reached saveLiked')
  for (const v of h.saved.likedTracks) assert.ok(looksLikePaths(v), 'a path list reached saveLikedTracks')
  assert.ok(h.saved.liked.length >= 2 && h.saved.likedTracks.length >= 2, 'both channels were exercised')
})

test('unliking a song offers an undo that really puts it back', () => {
  const h = harness()
  assert.strictEqual(h.toggleTrackLike('/m/xtal.flac'), false, 'it was liked, so this unlikes')
  assert.ok(!h.saved.likedTracks[0].includes('/m/xtal.flac'))
  const snack = h.snacks.find(s => s.label === 'Undo')
  assert.ok(snack, 'an unlike is offered back')
  snack.undo()
  const after = h.saved.likedTracks.at(-1)
  assert.ok(after.includes('/m/xtal.flac'), 'undo restores it')
  assert.ok(looksLikePaths(after), 'and still down the right channel')
})

test('a corrupt like-history value costs the history, not the click', () => {
  // It was an unguarded JSON.parse: a bad value threw out of the click handler,
  // so liking a track did nothing at all and said nothing.
  const h = harness()
  h.store['papa_like_history'] = '{not json'
  assert.strictEqual(h.toggleTrackLike('/m/avril14.flac'), true, 'the like still happened')
  assert.strictEqual(h.saved.likedTracks.length, 1, 'and was still saved')
})

test('the like history is capped, so it cannot grow without end', () => {
  const h = harness()
  h.store['papa_like_history'] = JSON.stringify(
    Array.from({ length: 600 }, (_, i) => ({ path: '/m/' + i + '.flac', ts: i })))
  h.toggleTrackLike('/m/new.flac')
  const hist = JSON.parse(h.store['papa_like_history'])
  assert.strictEqual(hist.length, 500)
  assert.strictEqual(hist.at(-1).path, '/m/new.flac', 'the newest is kept, the oldest dropped')
})

// ── The orphan prune ────────────────────────────────────────────────────────
// A rescan prunes album likes that no longer match anything. A scan that came
// back empty — an unplugged drive — must never be read as "every album is gone".

function liftPrune(state) {
  const from = '      if (state.library.length) {\n        var known = {}'
  const a = SRC.indexOf(from)
  assert.ok(a > -1, 'the rescan like-prune must still be guarded on a non-empty library')
  const b = SRC.indexOf('\n      // Don\'t yank the user back', a)
  assert.ok(b > a)
  const saved = []
  new Function('state', 'window', SRC.slice(a, b))(state, { api: { saveLiked: v => saved.push(v) } })
  return saved
}

test('a rescan drops album likes that match nothing', () => {
  const state = {
    likedAlbums: ['alb-here', 'alb-gone', 'pl_favourites'],
    library: [{ id: 'alb-here' }, { id: 'alb-other' }],
  }
  const saved = liftPrune(state)
  assert.deepStrictEqual(state.likedAlbums, ['alb-here', 'pl_favourites'],
    'a playlist like has no album to match and must survive')
  assert.deepStrictEqual(saved, [['alb-here', 'pl_favourites']], 'and the prune is persisted once')
})

test('an unplugged drive does not wipe every liked album', () => {
  const state = { likedAlbums: ['alb-here', 'alb-gone'], library: [] }
  const saved = liftPrune(state)
  assert.deepStrictEqual(state.likedAlbums, ['alb-here', 'alb-gone'],
    'an empty scan is a failed scan, not an empty library')
  assert.deepStrictEqual(saved, [], 'and nothing was written over the real list')
})

test('a rescan that changes nothing writes nothing', () => {
  const state = { likedAlbums: ['alb-here'], library: [{ id: 'alb-here' }] }
  assert.deepStrictEqual(liftPrune(state), [], 'no pointless whole-store rewrite')
})

// ── Belt and braces ─────────────────────────────────────────────────────────
// The literal crossings that actually shipped, twice. Cheap to keep, and they
// name the exact mistake for anyone reading.

test('the two literal crossings that shipped do not come back', () => {
  assert.equal([...SRC.matchAll(/api\.saveLiked\(\s*state\.likedTracks\s*\)/g)].length, 0,
    'saveLiked() writes likedAlbums — passing likedTracks wipes every liked album')
  assert.equal([...SRC.matchAll(/api\.saveLikedTracks\(\s*state\.likedAlbums\s*\)/g)].length, 0,
    'saveLikedTracks() writes likedTracks — passing likedAlbums wipes every liked song')
  assert.equal([...SRC.matchAll(/state\.likedTracks\s*=\s*await\s+window\.api\.getLiked\(\)/g)].length, 0,
    'getLiked() returns album ids; loading them into likedTracks corrupts it in memory')
  assert.equal([...SRC.matchAll(/state\.likedAlbums\s*=\s*await\s+window\.api\.getLikedTracks\(\)/g)].length, 0)
})

test('every reload of the liked stores reads each from its own channel', () => {
  // The reload path that got this wrong sat 20,000 lines from the init that got
  // it right. Both are checked, wherever they are: a load of one store from the
  // other's getter is the in-memory half of the same corruption.
  const loads = [...SRC.matchAll(/state\.(likedAlbums|likedTracks)\s*=\s*await\s+window\.api\.(getLiked|getLikedTracks)\(\)/g)]
  assert.ok(loads.length >= 2, 'the stores are still loaded from the bridge somewhere')
  for (const [, field, getter] of loads) {
    assert.strictEqual(getter, field === 'likedAlbums' ? 'getLiked' : 'getLikedTracks',
      `state.${field} must not be loaded from ${getter}()`)
  }
})
