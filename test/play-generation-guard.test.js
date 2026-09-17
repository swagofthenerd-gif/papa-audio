'use strict'
// Starting a track is asynchronous, so two plays can be in flight at once.
//
// A stream waits on yt-dlp; a local file waits on the disk (or a network
// mount). Nothing guarantees they finish in the order they were asked for. The
// loser of that race used to run its whole onStarted anyway: it repainted the
// now-playing bar with its own track, fired a desktop notification for it,
// armed the play-count timer against it, and wrote it into playbackState — so
// the next restart resumed a track he had already skipped past.
//
// playCurrentTrack lives in renderer.js, a browser script with no exports, so
// the real source is lifted and evaluated against fakes. Lifting rather than
// copying is the point: a copy keeps passing after the original changes.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(name) {
  const start = src.indexOf('function ' + name + '(')
  assert.ok(start > -1, name + ' must still exist in renderer.js')
  const end = src.indexOf('\nfunction ', start + 1)
  return src.slice(start, end === -1 ? undefined : end)
}

const PLAY = lift('playCurrentTrack')

// Every play is a deferred promise we resolve by hand, so the test controls
// the order the two loads finish in.
function build() {
  const log = []
  const pending = []
  const state = {
    queue: [], queueIndex: 0, isPlaying: false, queuePanelOpen: false,
    modalOpen: false, savedQueues: [], playCounts: {}, shuffle: false,
    repeat: 'off', playbackSpeed: 1,
  }
  const audio = {
    paused: true, ended: false, src: '',
    pause() { log.push('pause') },
    play() { const d = defer('local'); return d },
    switchToTrack(p) { log.push('switch:' + p); return defer('stream:' + p) },
  }
  function defer(tag) {
    let resolve, reject
    const pr = new Promise((res, rej) => { resolve = res; reject = rej })
    pending.push({ tag, resolve, reject })
    return pr
  }
  const api = {
    savePlaybackState: s => log.push('savePlaybackState:' + s.filePath),
    saveQueue: () => log.push('saveQueue'),
    notifyTrack: t => log.push('notify:' + t.title),
    incrementPlayCount: p => log.push('count:' + p),
  }

  const env = {
    state, audio, console: { error() {}, log() {} },
    window: { api },
    AUTO_QUEUE_CAP: 200,
    PLAY_RECORD_MS: 30000,
    _handoff: null, _handoffResuming: false,
    _shuffleHistory: [],
    _playCountTimer: null,
  }

  const fn = new Function('env', 'log', `
    const { state, audio, console, window, AUTO_QUEUE_CAP, PLAY_RECORD_MS } = env
    let _handoff = env._handoff, _handoffResuming = env._handoffResuming
    let _shuffleHistory = env._shuffleHistory, _playCountTimer = env._playCountTimer
    var _playbackIntent = 0
    function _nextPlayableIndex() { return -1 }
    function updatePlayBtn() {}
    function updateNowPlaying(t) { log.push('nowPlaying:' + (t ? t.title : 'null')) }
    function updateTrackHighlight() {}
    function updatePlayerLikeBtn() {}
    function renderQueuePanel() {}
    function updateNowPlayingModal() {}
    function syncModalPlayBtn() {}
    function renderSavedQueues() {}
    function extractAlbumColor() {}
    function _abLoopClear() {}
    function isHttpPath(p) { return /^https?:\\/\\//.test(p) }
    function recordYtRecent() {}
    function _applyPlaylistCrossfade() { return Promise.resolve() }
    function _consumePlaylistCfArm() { return null }
    function _applyHandoff() {}
    function _videoIsPlaying() { return false }
    function _maybeOfferLongResume() {}
    function _clearListening() {}
    function _listenClockReset() {}
    function _afterListening(ms, fn) { return { fn } }
    function recordPlayAfterThreshold() {}
    function loadLyricsFor() {}
    function syncExtension() {}
    function updateNextPrefetch() {}
    function _onPlayRefused() { log.push('playRefused') }
    function _armMusicStartWatch() {}
    ${PLAY}
    return { playCurrentTrack, intent: () => _playbackIntent }
  `)
  const lifted = fn(env, log)
  return { ...lifted, state, log, pending, audio }
}

const A = { filePath: 'https://example.invalid/a', title: 'Track A', artist: 'X' }
const B = { filePath: 'https://example.invalid/b', title: 'Track B', artist: 'Y' }

test('the slower earlier play does not paint over the one actually playing', () => {
  const h = build()
  h.state.queue = [A, B]

  h.state.queueIndex = 0
  h.playCurrentTrack()          // A starts loading
  h.state.queueIndex = 1
  h.playCurrentTrack()          // B starts loading, supersedes A

  // B finishes first, then A finishes late — the race that caused the bug.
  const a = h.pending.find(p => p.tag.includes('/a'))
  const b = h.pending.find(p => p.tag.includes('/b'))
  b.resolve()
  return Promise.resolve().then(() => {
    a.resolve()
    return new Promise(r => setImmediate(r))
  }).then(() => {
    assert.ok(h.log.includes('notify:Track B'), 'B is the one playing, so B is announced')
    assert.ok(!h.log.includes('notify:Track A'),
      'the superseded track must not fire a desktop notification')
    assert.ok(!h.log.includes('savePlaybackState:' + A.filePath),
      'the superseded track must not be what a restart resumes')
    assert.ok(!h.log.includes('count:' + A.filePath),
      'the superseded track must not take a play count')
    // The last thing the bar was told is B, not A.
    const paints = h.log.filter(l => l.startsWith('nowPlaying:'))
    assert.strictEqual(paints[paints.length - 1], 'nowPlaying:Track B')
  })
})

test('a superseded load failing does not stop the track that is playing', () => {
  const h = build()
  h.state.queue = [A, B]

  h.state.queueIndex = 0
  h.playCurrentTrack()
  h.state.queueIndex = 1
  h.playCurrentTrack()

  const a = h.pending.find(p => p.tag.includes('/a'))
  const b = h.pending.find(p => p.tag.includes('/b'))
  b.resolve()
  return Promise.resolve().then(() => {
    a.reject(new Error('yt-dlp gave up'))
    return new Promise(r => setImmediate(r))
  }).then(() => {
    assert.ok(!h.log.includes('playRefused'),
      'an error from a track nobody is waiting for must not surface')
    assert.strictEqual(h.state.isPlaying, true,
      'the failure of a superseded load must not pause what is audible')
  })
})

test('an uncontested play still runs in full', () => {
  const h = build()
  h.state.queue = [A]
  h.state.queueIndex = 0
  h.playCurrentTrack()
  h.pending[0].resolve()
  return new Promise(r => setImmediate(r)).then(() => {
    assert.ok(h.log.includes('notify:Track A'))
    assert.ok(h.log.includes('savePlaybackState:' + A.filePath))
    assert.strictEqual(h.state.isPlaying, true)
  })
})
