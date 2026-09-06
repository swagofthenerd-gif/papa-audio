'use strict'
// Pure-logic tests for the Preview Racer: query derivation from swampy remote
// filenames, and the race state machine as a reducer. The renderer wires the
// real download/stream calls and player events to this; these tests prove the
// brain without a DOM.
const test = require('node:test')
const assert = require('node:assert')
const R = require('../src/preview-racer')

// ── Query derivation ──────────────────────────────────────────────────────────

test('cleanTrackTitle strips track numbers, tags and extensions', () => {
  assert.strictEqual(R.cleanTrackTitle('01 - Paranoid Android.flac'), 'Paranoid Android')
  assert.strictEqual(R.cleanTrackTitle('1-04 The Title [FLAC].mp3'), 'The Title')
  assert.strictEqual(R.cleanTrackTitle('A1. Intro.wav'), 'Intro')
  assert.strictEqual(R.cleanTrackTitle('04_Song_Name.m4a'), 'Song Name')
  assert.strictEqual(R.cleanTrackTitle('CD2/07 - Encore.flac'), 'Encore')
})

test('cleanTrackTitle takes the basename of a full remote path', () => {
  assert.strictEqual(
    R.cleanTrackTitle('@@downloads\\Artist - Album [24-96]\\03 - Real Title.flac'),
    'Real Title')
})

test('cleanTrackTitle leaves a hyphenated title intact', () => {
  // A bare hyphen inside a word is not a track separator.
  assert.strictEqual(R.cleanTrackTitle('02 - Anti-Hero.mp3'), 'Anti-Hero')
})

test('derivePreviewQuery pairs artist with the cleaned title', () => {
  assert.strictEqual(
    R.derivePreviewQuery({ filename: '05 - Weird Fishes.flac' }, 'Radiohead'),
    'Radiohead Weird Fishes')
})

test('derivePreviewQuery does not double the artist when the title leads with it', () => {
  assert.strictEqual(
    R.derivePreviewQuery({ filename: '01 - Radiohead - Creep.flac' }, 'Radiohead'),
    'Radiohead - Creep')
})

test('derivePreviewQuery falls back to just the title with no artist', () => {
  assert.strictEqual(
    R.derivePreviewQuery({ filename: '09 - Idioteque.flac' }, ''),
    'Idioteque')
})

test('derivePreviewQuery prefers an explicit track.title over the filename', () => {
  assert.strictEqual(
    R.derivePreviewQuery({ filename: '99 - junk.flac', title: 'Everything In Its Right Place' }, 'Radiohead'),
    'Radiohead Everything In Its Right Place')
})

// ── Race state machine ────────────────────────────────────────────────────────

test('racerInit starts racing with no winner', () => {
  const s = R.racerInit()
  assert.strictEqual(s.status, 'racing')
  assert.strictEqual(s.winner, null)
})

test('first Ready wins — SLSK first stands down YT', () => {
  const s = R.racerReduce(R.racerInit(), { type: 'slskReady' })
  assert.strictEqual(s.status, 'won')
  assert.strictEqual(s.winner, 'slsk')
  assert.strictEqual(s.standDown, 'yt')
})

test('first Ready wins — YT first stands down (cancels) SLSK', () => {
  const s = R.racerReduce(R.racerInit(), { type: 'ytReady' })
  assert.strictEqual(s.status, 'won')
  assert.strictEqual(s.winner, 'yt')
  assert.strictEqual(s.standDown, 'slsk')
})

test('the loser landing after a win is ignored (idempotent)', () => {
  let s = R.racerReduce(R.racerInit(), { type: 'ytReady' })   // YT wins
  s = R.racerReduce(s, { type: 'slskReady' })                 // SLSK too late
  assert.strictEqual(s.winner, 'yt', 'YT keeps the win')
  assert.strictEqual(s.status, 'won')
})

test('one source failing keeps racing; both failing gives up', () => {
  let s = R.racerReduce(R.racerInit(), { type: 'slskFailed' })
  assert.strictEqual(s.status, 'racing', 'still waiting on YT')
  s = R.racerReduce(s, { type: 'ytFailed' })
  assert.strictEqual(s.status, 'timedout', 'both dead → give up')
  assert.strictEqual(s.winner, null)
})

test('a Ready still wins after the other source failed', () => {
  let s = R.racerReduce(R.racerInit(), { type: 'ytFailed' })
  assert.strictEqual(s.status, 'racing')
  s = R.racerReduce(s, { type: 'slskReady' })
  assert.strictEqual(s.status, 'won')
  assert.strictEqual(s.winner, 'slsk')
})

test('timeout with no winner gives up and stands down nobody in particular', () => {
  const s = R.racerReduce(R.racerInit(), { type: 'timeout' })
  assert.strictEqual(s.status, 'timedout')
  assert.strictEqual(s.winner, null)
})

test('stop while racing stands down BOTH sources', () => {
  const s = R.racerReduce(R.racerInit(), { type: 'stop' })
  assert.strictEqual(s.status, 'stopped')
  assert.strictEqual(s.standDown, 'both')
})

test('stop after a YT win stands down the winner (cancel its SLSK loser too)', () => {
  let s = R.racerReduce(R.racerInit(), { type: 'ytReady' })
  s = R.racerReduce(s, { type: 'stop' })
  assert.strictEqual(s.status, 'stopped')
  // Stopping a won preview stands down whatever the winner was so the caller can
  // cancel a still-running transfer behind a YT win.
  assert.strictEqual(s.standDown, 'yt')
})

test('events after a terminal give-up are no-ops (except stop)', () => {
  let s = R.racerReduce(R.racerInit(), { type: 'timeout' })
  const before = { ...s }
  s = R.racerReduce(s, { type: 'slskReady' })
  assert.deepStrictEqual(s, before, 'a late Ready cannot revive a timed-out race')
  s = R.racerReduce(s, { type: 'ytFailed' })
  assert.deepStrictEqual(s, before)
})

test('the reducer never mutates its input state', () => {
  const s0 = R.racerInit()
  const frozen = Object.freeze({ ...s0 })
  const s1 = R.racerReduce(frozen, { type: 'slskReady' })
  assert.notStrictEqual(s1, frozen)
  assert.strictEqual(frozen.status, 'racing', 'input untouched')
})
