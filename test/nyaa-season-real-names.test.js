'use strict'
// "i played season 1 ep 1 and its playing from a pack of season 3 ep1"
// (2026-09-21), and his follow-up: go and look at how the torrents are ACTUALLY
// numbered rather than reasoning about it.
//
// So these fixtures are real. They were taken from live nyaa results for three
// multi-season shows in his own cache. Across 225 real titles the season is
// stated three different ways — 102 as "S03", 31 as "Season 3", 18 as
// "3rd Season", and 74 not at all — and _packSeason was wrong on 3 of the 32
// that are packs, every one of them the ordinal form.
//
// The failure is specific and it is the reported bug: read the number AFTER
// the word "Season" and you get the EPISODE. "4th Season - 21" came out as
// season 21, "3rd Season - 01" as season 1 — so a later-season pack passed for
// a first-season request and served its own episode one.
const test = require('node:test')
const assert = require('node:assert')
const N = require('../providers/nyaa')

// Verbatim from live results, trimmed only in length.
const ORDINAL = '[Asakura] Tensei Shitara Slime Datta Ken 4th Season - 21 [1080p WEB AAC x264]'
const WORD = '[Doomdos] - That Time I Got Reincarnated as a Slime Season 4 - 23 - [1080p WEB-DL]'
const STOKEN = '[GetItTwisted] Psycho-Pass S03 [BD 1080p HEVC Opus AAC Dual-Audio]'

test('the season is read correctly in all three forms real releases use', () => {
  assert.strictEqual(N._packSeason(ORDINAL), 4, 'the ordinal form is the one that was broken')
  assert.strictEqual(N._packSeason(WORD), 4)
  assert.strictEqual(N._packSeason(STOKEN), 3)
})

test('the number after the word "Season" is the EPISODE, and is not the season', () => {
  assert.notStrictEqual(N._packSeason(ORDINAL), 21, 'this release is season 4, episode 21')
  assert.strictEqual(N._packSeason('[Grp] Show 3rd Season - 01 [1080p]'), 3)
  assert.strictEqual(N._packSeason('[Grp] Show 2nd Season - 13'), 2)
})

test('a release that states no season still states none', () => {
  // Silence is not evidence: refusing these would empty the list, since 74 of
  // the 225 real titles name no season at all.
  assert.strictEqual(N._packSeason('[Grp] Show - 01~12 [Batch][1080p]'), null)
  assert.strictEqual(N._packSeason('[Grp] Show COMPLETE [1080p]'), null)
})

test('a single episode is not read as a pack season', () => {
  // SxxEyy titles are single episodes; the pack-season question is not asked
  // of them, and the guard against it must stay.
  assert.strictEqual(N._packSeason('Show S02E12 1080p WEB-DL'), null)
})

// ── where the refusal lives, and why it is not here ───────────────────────
// A correct parser is not by itself the fix. The provider's guard only runs
// when the caller KNOWS the season, and an anime request carries none — anime
// is catalogued one entry per season.
//
// Making the provider assume "no season stated means season one" was tried and
// reverted: it contradicts this file's own contract ("without a known season
// the label proves nothing either way"), and many anime sequels are titled
// distinctly rather than "2nd Season", so the assumption would HARD-DROP their
// correct releases — a worse failure than the one being fixed, and an
// unrecoverable one.
//
// The season refusal for anime therefore lives in the renderer's plausibility
// filter (test/release-season-match.test.js), which is soft: refused releases
// go to the "unlikely" bucket, still counted and still reachable.
test('television compares the numbers, and now does it on a correctly-read season', () => {
  assert.strictEqual(N.matchesEpisode('Show.S03.COMPLETE', 1, { season: 1 }), false)
  assert.strictEqual(N.matchesEpisode('Show.S03.COMPLETE', 1, { season: 3 }), true)
  // The ordinal form used to defeat this guard entirely: "3rd Season - 01"
  // read as season 1, so it was accepted for a season-1 request.
  assert.strictEqual(N.matchesEpisode('[G] Show 3rd Season - 01~12', 1, { season: 1 }), false)
  assert.strictEqual(N.matchesEpisode('[G] Show 3rd Season - 01~12', 1, { season: 3 }), true)
})

test('without a known season the label still proves nothing either way', () => {
  // The contract this file has always had, kept deliberately.
  assert.strictEqual(N.matchesEpisode('[G] Show Season 2 Complete', 5), true)
})

test('a pack claiming no season is accepted exactly as before', () => {
  assert.strictEqual(N.matchesEpisode('[Grp] Show - 01~12 [Batch]', 1, { season: 1 }), true)
  assert.strictEqual(N.matchesEpisode('[Grp] Show COMPLETE', 1, { season: 1 }), true)
})
