'use strict'
// Instant-play B: one RealDebrid resolution answers a whole season.
//
// A season pack is one torrent holding every episode, so the resolve the
// detail page already performs has, in the info it just cached, the answer for
// every other episode too. That answer was thrown away and re-asked one
// episode at a time — three requests each, against an account that answers a
// burst with too_many_requests and a two-minute back-off.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const W = require('../src/watch-key')
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('a pack becomes one key per episode, in the renderer own spelling', () => {
  const files = [{ episode: 3 }, { episode: 1 }, { episode: 2 }]
  const out = W.packEpisodeKeys({ type: 'anime', id: '21', files })
  assert.deepEqual(out.map(e => e.episode), [1, 2, 3], 'sorted by episode')
  assert.deepEqual(out.map(e => e.key), ['anime:21:e1', 'anime:21:e2', 'anime:21:e3'])
  // The keys must be the ones every other surface already uses, or the badge
  // lands on a key nothing looks up.
  assert.equal(out[0].key, W.watchKey('anime', '21', null, 1))
})

test('a TV pack carries its season, so season 2 episode 1 is not season 1 episode 1', () => {
  const out = W.packEpisodeKeys({ type: 'tv', id: '1399', season: 2, files: [{ episode: 1 }, { episode: 2 }] })
  assert.deepEqual(out.map(e => e.key), ['tv:1399:s2e1', 'tv:1399:s2e2'])
  const s1 = W.packEpisodeKeys({ type: 'tv', id: '1399', season: 1, files: [{ episode: 1 }, { episode: 2 }] })
  assert.notDeepEqual(out.map(e => e.key), s1.map(e => e.key))
})

test('a file the episode number could not be read from is skipped, not guessed', () => {
  const files = [{ episode: 1 }, { episode: null }, { episode: undefined }, {}, null, { episode: 2 }]
  const out = W.packEpisodeKeys({ type: 'anime', id: '21', files })
  assert.deepEqual(out.map(e => e.episode), [1, 2])
})

test('the same episode twice in a pack is marked once', () => {
  // Packs routinely carry a duplicate: a v2 re-release, or the same episode in
  // two folders. Marking it twice would double-count nothing useful.
  const out = W.packEpisodeKeys({ type: 'anime', id: '21', files: [{ episode: 5 }, { episode: 5 }, { episode: 6 }] })
  assert.deepEqual(out.map(e => e.episode), [5, 6])
})

test('a single-file torrent is not a season and claims nothing', () => {
  assert.deepEqual(W.packEpisodeKeys({ type: 'anime', id: '21', files: [{ episode: 1 }] }), [],
    'one file says nothing the title key did not already say')
  assert.deepEqual(W.packEpisodeKeys({ type: 'anime', id: '21', files: [] }), [])
})

test('a film has no episodes to promise', () => {
  assert.deepEqual(W.packEpisodeKeys({ type: 'movie', id: '603', files: [{ episode: 1 }, { episode: 2 }] }), [])
})

test('a missing type or id yields nothing rather than a malformed key', () => {
  for (const bad of [{ id: '21' }, { type: 'anime' }, { type: 'anime', id: '' }, {}, null]) {
    assert.deepEqual(W.packEpisodeKeys(bad && Object.assign({ files: [{ episode: 1 }, { episode: 2 }] }, bad)), [],
      JSON.stringify(bad) + ' must not produce keys')
  }
  assert.deepEqual(W.packEpisodeKeys(), [])
})

test('junk in the files array cannot throw', () => {
  assert.doesNotThrow(() => W.packEpisodeKeys({ type: 'anime', id: '21', files: 'nope' }))
  assert.doesNotThrow(() => W.packEpisodeKeys({ type: 'anime', id: '21', files: [{ episode: 'x' }, { episode: NaN }] }))
  assert.deepEqual(W.packEpisodeKeys({ type: 'anime', id: '21', files: [{ episode: -1 }, { episode: 2 }] }), [],
    'a negative episode is not an episode, and one survivor is not a season')
})

// ── the wiring, in main ────────────────────────────────────────────────────
test('the season marking rides the resolve the page already did', () => {
  const at = MAIN.indexOf('async function _markPackEpisodesInstant(')
  assert.ok(at > 0, 'the helper must exist')
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at))
  assert.match(body, /debrid\(\)\.packFiles\(magnet, want\)/,
    'packFiles reads the cache this resolve filled; it must not re-resolve')
  assert.match(body, /watchKeys\.packEpisodeKeys\(/,
    'the key spelling belongs to watch-key, not to a second loop here')
  assert.match(body, /_instantMark\(e\.key, 'debrid'\)/)
  assert.match(body, /if \(type === 'movie'\) return \[\]/, 'a film has no season to mark')
  assert.match(body, /catch \(_\) \{/, 'this runs while the page is read and must never fail the pick')
})

test('the pick hands the episode list back to the page', () => {
  const at = MAIN.indexOf("ipcMain.handle('video-debrid-pick'")
  const body = MAIN.slice(at, MAIN.indexOf("ipcMain.handle('video-warm-cancel'", at))
  assert.match(body, /const episodes = await _markPackEpisodesInstant\(c\.magnet, want, titleKey, season\)/,
    'marked for the season that was asked for, not for whatever season')
  assert.match(body, /return \{ ok: true, magnet: c\.magnet, held: heldMagnets, episodes \}/)
})

// ── the wiring, in the renderer ────────────────────────────────────────────
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

test('one badge vocabulary serves the cards and the episode rows', () => {
  assert.match(R, /function _instantWords\(via\)/,
    'SAVED / CACHED / INSTANT must be defined once')
  assert.match(R, /function _instantBadgeHtml\(via, extraClass\)/)
  // The card builder must no longer carry its own copy of the words.
  const at = R.indexOf('const instant = (typeof _instantKeys')
  assert.ok(at > 0)
  const after = R.slice(at, at + 400)
  assert.match(after, /badges\.push\(_instantBadgeHtml\(instant\)\)/)
  assert.doesNotMatch(after, /'SAVED'/, 'a second copy of the vocabulary would drift')
})

test('an episode row looks itself up by its own watch key, with the season', () => {
  const at = R.indexOf('function _epInstantVia(n)')
  assert.ok(at > 0, 'the per-episode lookup must exist')
  const body = R.slice(at, at + 600)
  assert.match(body, /_watchKey\(_videoDetail\.type, _videoDetail\.d\.id,/)
  assert.match(body, /_videoDetail\.type === 'tv' \? _videoState\.season : null/,
    'season 2 episode 1 must not read as season 1 episode 1')
  assert.match(body, /_videoDetail\.type === 'movie'/, 'a film has no episode rows')
  assert.match(body, /catch \(_\) \{ return null \}/, 'a badge must never throw the list away')
})

test('the mark appears on first paint as well as on the later answer', () => {
  const at = R.indexOf('function _epRowHtml(r)')
  const body = R.slice(at, R.indexOf('\n}\n', at))
  assert.match(body, /_epInstantVia\(r\.n\)/, 'painted rows carry it immediately')
  assert.match(R, /function _syncEpisodeInstantBadges\(\)/, 'and late answers reach painted rows')
})

test('the late answer updates the rows in place instead of repainting the season', () => {
  const at = R.indexOf('function _syncEpisodeInstantBadges()')
  const body = R.slice(at, R.indexOf('\n}\n', at))
  assert.match(body, /querySelectorAll\('\.vep-row\[data-ep\]'\)/)
  assert.match(body, /if \(!via\) \{ if \(existing\) existing\.remove\(\); return \}/,
    'a mark that stops being true must come off')
  assert.doesNotMatch(body, /innerHTML =/, 'repainting the list would lose the reader scroll position')
})

test('the debrid pick refreshes the map and then the rows', () => {
  assert.match(R, /_refreshInstantKeys\(true\)\.then\(_syncEpisodeInstantBadges\)/,
    'the rows must be synced AFTER the map that feeds them')
})
