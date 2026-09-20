'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { matchesWantedEpisode, pickVideoFile } = require('../torrent-stream')

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

function batch(n) {
  const out = []
  for (let i = 1; i <= n; i++) {
    out.push({ name: `[SubsPlease] Show - ${String(i).padStart(2, '0')} (1080p).mkv`, length: 1e9 + i, index: i - 1 })
  }
  return out
}

// Main computes an absolute episode number for anime and the indexers ACCEPT a
// batch because that number matched — a fansub release for a continuing season
// is numbered "Show - 37", not "S02E09". The number then never left the
// renderer, so the picker inside the won pack looked for the SEASONAL number
// and returned an earlier season's episode. And pickInfo().matched reported
// true, because it genuinely did match "09" — so the "this is not the episode
// you asked for" warning never fired either. Wrong episode, no warning.
test('a complete-series batch yields the episode asked for, not the seasonal number', () => {
  const pack = batch(56)            // two 28-episode seasons, numbered 01-56
  // Season 2 episode 9 is absolute 37.
  assert.strictEqual(pickVideoFile(pack, { season: null, episode: 9, absoluteEpisode: 37 }), 36,
    'file 37 is season 2 episode 9')
  assert.strictEqual(pickVideoFile(pack, { season: null, episode: 9 }), 8,
    'without the absolute number it still picks file 09 — which is the bug')
})

// The order is load-bearing, so pin the reason rather than only the result.
test('a genuinely seasonal pack is unaffected, because the absolute file cannot exist in it', () => {
  const seasonOnly = batch(28)
  assert.ok(!seasonOnly.some(f => matchesWantedEpisode(f.name, { season: null, episode: 37 })),
    'a 28-file pack cannot contain a file numbered 37')
  assert.strictEqual(pickVideoFile(seasonOnly, { season: null, episode: 9, absoluteEpisode: 37 }), 8,
    'so the absolute pass misses and the seasonal pass answers')
})

test('the absolute number is ignored when it is the same as the seasonal one', () => {
  const pack = batch(24)
  assert.strictEqual(pickVideoFile(pack, { season: null, episode: 9, absoluteEpisode: 9 }), 8,
    'a first season needs no second pass')
})

test('the matcher accepts either number, and nothing else', () => {
  const want = { season: null, episode: 9, absoluteEpisode: 37 }
  assert.strictEqual(matchesWantedEpisode('[G] Show - 37 (1080p).mkv', want), true)
  assert.strictEqual(matchesWantedEpisode('[G] Show - 09 (1080p).mkv', want), true)
  assert.strictEqual(matchesWantedEpisode('[G] Show - 38 (1080p).mkv', want), false)
  assert.strictEqual(matchesWantedEpisode('[G] Show - 3 (1080p).mkv', want), false,
    'and 37 must not match inside a bare 3')
})

test('an opening or ending clip is still never mistaken for the absolute episode', () => {
  const want = { season: null, episode: 9, absoluteEpisode: 37 }
  for (const junk of ['[G] Show - NCED37 (1080p).mkv', '[G] Show - OP37.mkv', '[G] Show SP37.mkv']) {
    assert.strictEqual(matchesWantedEpisode(junk, want), false, junk)
  }
})

// The matcher was never the broken half — the thread-through was. A matcher
// test alone passes against the shipped bug.
test('the number actually reaches the picker from the renderer', () => {
  const R = read('src/renderer.js'), M = read('main.js'), T = read('torrent-stream.js'), D = read('src/debrid.js')
  assert.match(R, /function _absoluteEpisodeFor\(detail, state\)/, 'the renderer can compute it')
  // This assertion used to be a regex over the whole file, and the string it
  // matched lived in the SUBTITLE payload (subMeta) — so it was green while
  // the play request carried no absolute number at all, the exact bug it was
  // written to prevent. Scoping it to _videoPlayResult is NOT enough either:
  // subMeta is built inside that same function, so a per-function pin matches
  // it too (proved by mutation — removing the real line left the test green).
  //
  // Pin the REQUEST OBJECT itself: the Object.assign that builds what goes to
  // main must carry the absolute number next to the episode it belongs to.
  assert.match(R, /result = Object\.assign\(\{\}, result, \{[\s\S]{0,600}?absoluteEpisode: typeof _absoluteEpisodeFor/,
    'the play request must carry it')
  // And both source-switch paths, since switching mid-episode has to resolve
  // the same file the play would have.
  const switches = R.match(/result = Object\.assign\(\{\}, next, \{[\s\S]{0,600}?absoluteEpisode: typeof _absoluteEpisodeFor/g) || []
  assert.equal(switches.length, 2,
    'both _playerPickSource and _autoSwitchSource must carry it; got ' + switches.length)
  assert.match(M, /absoluteEpisode: result\.absoluteEpisode \?\? null/, 'main hands it to the streamer')
  assert.match(M, /absoluteEpisode: num\(result && result\.absoluteEpisode\)/, 'and into the debrid want')
  assert.match(T, /const want = episode != null \? \{ season, episode, absoluteEpisode \} : null/)
  assert.match(D, /want\.absoluteEpisode/, 'the debrid picker uses it too')
})

test('it is anime-only, and never a stale number from a different episode', () => {
  const fnAt = read('src/renderer.js').indexOf('function _absoluteEpisodeFor')
  const body = read('src/renderer.js').slice(fnAt, fnAt + 1400)
  assert.match(body, /detail\.type !== 'anime'/, 'film and television have no absolute numbering')
  assert.match(body, /Number\(n\.episode\) !== ep/, 'a numbering resolved for another episode is refused')
})
