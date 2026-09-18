'use strict'
// Three parts of watching a season straight through, each of which behaved as
// if the app were watching a different show than the viewer:
//
//  1. pressing Next three minutes in marked the episode watched. It went into
//     the diary, greyed out in the list, and — now that finishing an episode
//     frees its cached file — would have deleted a file barely started.
//  2. the last frame of a file stopped playback dead even with auto-play on,
//     whenever the file ended before the Up Next countdown could fire.
//  3. the Up Next card and the next-episode source search read the page on
//     screen rather than the title in the picture, so browsing something else
//     while the mini player ran prepared the wrong episode entirely.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')

const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'src', 'video-player.js'), 'utf8')
const rules = require('../src/watch-rules')

function lift(decl, extra) {
  const start = RENDERER.indexOf(decl)
  assert.ok(start > 0, 'not found: ' + decl)
  const end = RENDERER.indexOf('\n}', start) + 2
  const ctx = Object.assign({
    console: { warn() {}, log() {} },
    Number, String, Object, Array, Boolean, Math, JSON, Promise, setTimeout,
  }, extra || {})
  vm.createContext(ctx)
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return ctx
}

// ── 1. an early Next is a skip, not a finish ────────────────────────────────

function advanceCtx(position, duration) {
  return lift('function _advanceCountsAsWatched() {', {
    PapaWatchRules: rules,
    _player: { _state: () => ({ position, duration }) },
  })
}

test('pressing Next three minutes into an episode is not finishing it', () => {
  const ctx = advanceCtx(180, 1440)
  assert.strictEqual(ctx._advanceCountsAsWatched(), false)
})

test('pressing Next past the half-way mark does count', () => {
  assert.strictEqual(advanceCtx(800, 1440)._advanceCountsAsWatched(), true)
  assert.strictEqual(advanceCtx(720, 1440)._advanceCountsAsWatched(), true, 'exactly half counts')
  assert.strictEqual(advanceCtx(719, 1440)._advanceCountsAsWatched(), false)
})

test('an unknown duration is never treated as a finish', () => {
  assert.strictEqual(advanceCtx(180, 0)._advanceCountsAsWatched(), false)
})

test('the advance path only marks watched behind that gate, and says it was an advance', () => {
  const start = RENDERER.indexOf('async function _playNextEpisode() {')
  const body = RENDERER.slice(start, RENDERER.indexOf('\nasync function', start + 10))
  const marks = body.match(/store\.markWatched\([^)]*\)/g) || []
  assert.ok(marks.length >= 2, 'both advance routes mark watched: ' + marks.join(' | '))
  for (const m of marks) {
    assert.match(m, /reason: 'advance'/, m + ' must not read as a real finish')
  }
  assert.strictEqual((body.match(/_advanceCountsAsWatched\(\)/g) || []).length, marks.length,
    'every markWatched on the advance path is behind the half-way gate')
})

// ── 2. the last frame rolls on when auto-play is on ─────────────────────────

function playerAutoAdvance({ autoNext, upNextInfo, upNextDismissed, autoAdvances }) {
  // The real expression out of video-player.js, with its four inputs supplied.
  const start = PLAYER.indexOf('shouldAutoAdvanceAtEnd: function () {')
  assert.ok(start > 0, 'shouldAutoAdvanceAtEnd not found')
  const end = PLAYER.indexOf('},', start)
  const src = PLAYER.slice(PLAYER.indexOf('{', PLAYER.indexOf('function ()', start)), end)
  const ctx = { autoNext, upNextInfo, upNextDismissed, autoAdvances, STILL_WATCHING_AFTER: 3, Boolean }
  vm.createContext(ctx)
  return vm.runInContext('(function () ' + src + '})()', ctx)
}

test('the end of a file rolls on when auto-play is on and there is a next episode', () => {
  assert.strictEqual(playerAutoAdvance({
    autoNext: true, upNextInfo: { title: 'Ep 6' }, upNextDismissed: false, autoAdvances: 0,
  }), true)
})

test('auto-play off, a dismissed card, or no next episode all stop at the last frame', () => {
  assert.strictEqual(playerAutoAdvance({
    autoNext: false, upNextInfo: { title: 'Ep 6' }, upNextDismissed: false, autoAdvances: 0 }), false)
  assert.strictEqual(playerAutoAdvance({
    autoNext: true, upNextInfo: { title: 'Ep 6' }, upNextDismissed: true, autoAdvances: 0 }), false,
    '"Watch credits" is a decision and must be honoured')
  assert.strictEqual(playerAutoAdvance({
    autoNext: true, upNextInfo: null, upNextDismissed: false, autoAdvances: 0 }), false,
    'a film, or the last episode of a season')
})

test('after enough unattended episodes it stops asking nobody and just stops', () => {
  assert.strictEqual(playerAutoAdvance({
    autoNext: true, upNextInfo: { title: 'Ep 6' }, upNextDismissed: false, autoAdvances: 3 }), false)
})

test('the ended handler asks the deck before stopping', () => {
  const at = RENDERER.indexOf("payload.kind === 'ended'")
  const body = RENDERER.slice(at, RENDERER.indexOf("payload.kind === 'stalled'", at))
  assert.match(body, /shouldAutoAdvanceAtEnd\(\)/)
  assert.ok(body.indexOf('_playNextEpisode()') < body.indexOf('_videoStopAndHide()'),
    'the advance is decided before the stop')
})

// ── 3. the look-ahead follows the picture, not the page ─────────────────────

const PLAYING = { type: 'tv', d: { id: 1396, title: 'Breaking Bad', seasons: [] } }
const BROWSING = { type: 'tv', d: { id: 999, title: 'Something Else', seasons: [] } }

test('the Up Next card describes what is playing, not the page being browsed', () => {
  const shown = []
  const ctx = lift('function _setUpNextInfo() {', {
    _player: { setUpNext: i => shown.push(i) },
    _playCtx: () => ({ detail: PLAYING, state: { season: 1, episode: 5 }, streams: [] }),
    _videoDetail: BROWSING,
    _videoState: { season: 4, episode: 2 },
    _nextEpisodeOf: (d, st) => ({ season: st.season, episode: st.episode + 1 }),
  })
  ctx._setUpNextInfo()
  assert.strictEqual(shown.length, 1)
  assert.strictEqual(shown[0].subtitle, 'Season 1 · Episode 6',
    'it announced the episode of the show the viewer is browsing, not the one playing')
})

test('the next episode’s sources are resolved for what is playing', async () => {
  const asked = []
  const ctx = lift('async function _prefetchNextSources() {', {
    _playCtx: () => ({ detail: PLAYING, state: { season: 1, episode: 5 }, streams: [] }),
    _videoDetail: BROWSING,
    _videoState: { season: 4, episode: 2 },
    _nextEpisodeOf: (d, st) => ({ season: st.season, episode: st.episode + 1 }),
    _prefetchKey: n => 's' + n.season + 'e' + n.episode,
    _prefetch: { key: null, streams: null, inflight: false },
    _playing: { dub: false },
    window: { api: { videoStreams: r => { asked.push(r); return Promise.resolve({ ok: true, streams: [] }) } } },
  })
  await ctx._prefetchNextSources()
  assert.strictEqual(asked.length, 1)
  assert.strictEqual(asked[0].tmdbId, 1396, 'it searched for the wrong show')
  assert.strictEqual(asked[0].season, 1)
  assert.strictEqual(asked[0].episode, 6)
})
