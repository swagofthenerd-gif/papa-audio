'use strict'
// Next on the last track with repeat off moved the index to 0 while track 10
// was still the audible one. The queue panel highlighted the wrong row, the
// tray and MPRIS named the wrong track, and two further presses walked 1, 2, 3
// -- the album silently restarting from the top instead of saying it had
// finished. The continuation paths (keep-going, YT autoplay) were also seeded
// from the first track rather than the one that had just played.
//
// playNext is lifted from renderer.js rather than copied, so this test follows
// the real function.

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

const PLAY_NEXT = lift('playNext')

function build(opts) {
  opts = opts || {}
  const log = []
  const titles = opts.titles || ['one', 'two', 'three']
  const state = {
    queue: titles.map(t => ({ filePath: '/m/' + t + '.flac', title: t, duration: 200 })),
    queueIndex: opts.queueIndex == null ? titles.length - 1 : opts.queueIndex,
    isPlaying: true,
    shuffle: false,
    repeat: opts.repeat || 'off',
    stopAfterTrack: false,
    skipShortTracks: false,
    skipInterludes: false,
    skipShortSecs: 30,
    queuePanelOpen: true,
    modalOpen: false,
  }
  const audio = {
    paused: false,
    currentTime: 199,
    pause() { log.push('pause'); this.paused = true },
    play() { log.push('play'); this.paused = false },
  }
  const env = { state, audio, keepGoing: !!opts.keepGoing, autoplay: !!opts.autoplay }

  const fn = new Function('env', 'log', `
    const { state, audio } = env
    let _pendingShuffle = null
    let _shuffleHistory = []
    let _skipShortGuard = 0
    let _oldQueue = null
    function _sleepAtTrackEnd() { return false }
    function updatePlayBtn() {}
    function updateStopAfterBtn() {}
    function updateTrackHighlight() { log.push('highlight') }
    function updateNowPlaying(t) { log.push('nowPlaying:' + (t ? t.title : 'null')) }
    function renderQueuePanel() { log.push('renderQueuePanel@' + state.queueIndex) }
    function updateNowPlayingModal() {}
    function syncExtension() { log.push('syncExtension@' + state.queueIndex) }
    function _radioMaybeRefill() {}
    function pickShuffleIndex() { return 0 }
    function restoreOldQueue() { log.push('restoreOldQueue') }
    function keepGoingEnabled() { return env.keepGoing }
    function _keepGoingContinue() { log.push('keepGoingSeed:' + (state.queue[state.queueIndex] || {}).title) }
    function autoplayEnabled() { return env.autoplay }
    function tryAutoplayContinue() { log.push('autoplaySeed:' + (state.queue[state.queueIndex] || {}).title) }
    function showSnackbar(m) { log.push('snackbar:' + m) }
    function _isInterlude() { return false }
    function playCurrentTrack() { log.push('playCurrentTrack:' + state.queueIndex) }
    ${PLAY_NEXT}
    return { playNext }
  `)
  return { ...fn(env, log), state, audio, log, env }
}

test('the end of the queue leaves the index on the track that is audible', () => {
  const h = build({ queueIndex: 2 })      // last of three
  h.playNext()
  assert.strictEqual(h.state.queueIndex, 2,
    'the last track stays selected -- it is the one that was playing')
  assert.strictEqual(h.state.isPlaying, false)
  assert.ok(h.log.includes('pause'))
  assert.ok(h.log.includes('nowPlaying:three'),
    'the bar keeps naming the track that actually played')
  assert.ok(h.log.some(l => l.startsWith('snackbar:')),
    'the user is told the queue finished rather than left guessing')
})

test('further presses of Next do not silently restart the album', () => {
  const h = build({ queueIndex: 2 })
  h.playNext()
  h.playNext()
  h.playNext()
  assert.strictEqual(h.state.queueIndex, 2,
    'Next at the end of a finished queue must not walk 1, 2, 3')
  assert.ok(!h.log.some(l => l.startsWith('playCurrentTrack')),
    'nothing new is started once the queue has finished')
})

test('the tray and MPRIS are told about the last track, not the first', () => {
  const h = build({ queueIndex: 2 })
  h.playNext()
  assert.ok(h.log.includes('syncExtension@2'),
    'syncExtension reads state.queueIndex, so it must run with the honest index')
  assert.ok(h.log.includes('renderQueuePanel@2'),
    'the open queue panel highlights the track that played, not track 1')
})

test('keep-going is seeded from the track that just finished', () => {
  const h = build({ queueIndex: 2, keepGoing: true })
  h.playNext()
  assert.ok(h.log.includes('keepGoingSeed:three'),
    'the continuation must resemble the last track, not the first')
})

test('YT autoplay is also seeded from the last track', () => {
  const h = build({ queueIndex: 2, autoplay: true })
  h.playNext()
  assert.ok(h.log.includes('autoplaySeed:three'))
})

test('repeat all still wraps to the top and keeps playing', () => {
  const h = build({ queueIndex: 2, repeat: 'all' })
  h.playNext()
  assert.strictEqual(h.state.queueIndex, 0)
  assert.ok(h.log.includes('playCurrentTrack:0'))
  assert.ok(!h.log.includes('pause'))
})

test('an ordinary Next in the middle of the queue still advances', () => {
  const h = build({ queueIndex: 0 })
  h.playNext()
  assert.strictEqual(h.state.queueIndex, 1)
  assert.ok(h.log.includes('playCurrentTrack:1'))
})
