'use strict'
// "i played season 1 ep 1 and its playing from a pack of season 3 ep1"
// (2026-09-21).
//
// The plausibility check asked whether a release carries the TITLE, and for
// films whether the year agrees. It never looked at the season. Its sequel
// detector knew bare ordinals ("Show 2", "Show III") and nothing of "S03",
// "Season 3" or "3rd Season" — so a third-season pack was a perfectly good
// answer to a first-season request, and the pack's own "01" file then
// satisfied "episode 1". Season three, episode one.
const test = require('node:test')
const assert = require('node:assert')
const RN = require('../src/release-name')

test('the season a release declares is read, in every form releases use', () => {
  assert.strictEqual(RN.declaredSeason('Show.S03E07.1080p.WEB'), 3)
  assert.strictEqual(RN.declaredSeason('Show.S03.COMPLETE'), 3)
  assert.strictEqual(RN.declaredSeason('Show Season 3 - 01'), 3)
  assert.strictEqual(RN.declaredSeason('[Grp] Show 3rd Season - 01 [1080p]'), 3)
  assert.strictEqual(RN.declaredSeason('[Grp] Show 2nd Season 13'), 2)
  assert.strictEqual(RN.declaredSeason('Show 1st Season - 05'), 1)
})

test('the ordinal wins over the number that follows the word', () => {
  // Read the other way round, "Show 3rd Season - 01" gives 1, because that
  // trailing number is the EPISODE. Reading it as the season is precisely how
  // a third-season pack passes for a first-season request.
  assert.strictEqual(RN.declaredSeason('[Grp] Show 3rd Season - 01'), 3)
  assert.notStrictEqual(RN.declaredSeason('[Grp] Show 3rd Season - 01'), 1)
})

test('a release that says nothing about a season declares nothing', () => {
  // Silence is not evidence of a mismatch: most first-season releases name no
  // season at all, and refusing them would empty the list.
  assert.strictEqual(RN.declaredSeason('[Grp] Show - 01 [1080p][DTS5.1]'), null)
  assert.strictEqual(RN.declaredSeason('Show.1080p.WEB-DL.x264'), null)
  assert.strictEqual(RN.declaredSeason(''), null)
  assert.strictEqual(RN.declaredSeason(null), null)
})

test('a letter-run is not a season', () => {
  // "DTS5.1" must not read as season 5.
  assert.strictEqual(RN.declaredSeason('[Grp] Show - 01 [DTS5.1][1080p]'), null)
})

// ── anime: NOT judged on the season, deliberately ─────────────────────────
// Refusing anime releases that declare a later season was tried and reverted
// the same day it shipped. Most anime season-two entries are catalogued under
// a title that states no season, so every correctly-labelled "2nd Season"
// release was marked unlikely and the source list collapsed to whatever stray
// release happened to name none — which was then from the wrong season anyway.
// Reported as "whatever source i select, its playing only one source".
//
// A guess about the season is worse than no guess, because it hides the right
// answers. The accurate season PARSER is still worth having (the provider uses
// it, and television compares real numbers with it); the guess is not.
test('an anime release is not refused for naming a later season', () => {
  assert.strictEqual(RN.plausible({ type: 'anime', title: 'Bungo Stray Dogs' },
    '[Grp] Bungo Stray Dogs 2nd Season - 01'), true)
  assert.strictEqual(RN.plausible({ type: 'anime', title: 'Show' }, '[Grp] Show 3rd Season - 01'), true)
})

test('and an anime release naming no season is offered as it always was', () => {
  assert.strictEqual(RN.plausible({ type: 'anime', title: 'Show' }, '[Grp] Show - 01 [1080p]'), true)
})

// ── television: the seasons live under one title, so the numbers must agree ─
test('the declared season must equal the season asked for', () => {
  assert.strictEqual(RN.plausible({ type: 'tv', title: 'Show', season: 3 }, 'Show.S03E01.1080p'), true)
  assert.strictEqual(RN.plausible({ type: 'tv', title: 'Show', season: 1 }, 'Show.S03E01.1080p'), false)
  assert.strictEqual(RN.plausible({ type: 'tv', title: 'Show', season: 2 }, 'Show.Season.2.COMPLETE'), true)
})

test('a television release that declares nothing is not refused', () => {
  assert.strictEqual(RN.plausible({ type: 'tv', title: 'Show', season: 1 }, 'Show.1080p.WEB-DL'), true)
})

test('a film is judged on its year, never on a season', () => {
  assert.strictEqual(RN.plausible({ type: 'movie', title: 'Dune', year: 2021 }, 'Dune.2021.2160p'), true)
  // An S-token in a film name must not start refusing films.
  assert.strictEqual(RN.plausible({ type: 'movie', title: 'Dune', year: 2021 }, 'Dune.2021.S01.2160p'), true)
})

test('the request carries the season from the page, or the check cannot fire', () => {
  const fs = require('fs'); const path = require('path')
  const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
  const at = R.indexOf('function _splitPlausibleStreams(')
  assert.ok(at > 0)
  assert.match(R.slice(at, at + 900), /season: _videoDetail\.type === 'tv'/,
    'television sends its season; anime has none to send')
})
