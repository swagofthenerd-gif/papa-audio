'use strict'
// With shuffle on, roughly one Next in every queue-length presses killed the
// music. The shuffle branch wrote its pick straight into state.queueIndex, and
// the very next line read `state.queueIndex === 0` as "the queue finished" and
// paused. Index 0 is a perfectly ordinary shuffle pick -- the first track in
// the queue -- so the album stopped dead on a track that was never played, and
// the autoplay rescue could not catch it either because that branch requires
// !state.shuffle.
//
// playNext lives in renderer.js, a browser script with no exports, so the real
// source is lifted and run against fakes. Lifting rather than copying is the
// point: a copy keeps passing after the original changes.

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

// `shufflePick` is the controllable picker: whatever it returns is what
// pickShuffleIndex hands back, so the test can force the index-0 case that
// only happened one press in seven on the live app.
function build(opts) {
  opts = opts || {}
  const log = []
  const state = {
    queue: (opts.queue || ['a', 'b', 'c', 'd', 'e', 'f', 'g']).map((t, i) => (
      typeof t === 'string' ? { filePath: '/m/' + t + '.flac', title: t, duration: 200 } : t
    )),
    queueIndex: opts.queueIndex == null ? 3 : opts.queueIndex,
    isPlaying: true,
    shuffle: opts.shuffle !== false,
    repeat: opts.repeat || 'off',
    stopAfterTrack: false,
    skipShortTracks: false,
    skipInterludes: false,
    skipShortSecs: 30,
    queuePanelOpen: false,
    modalOpen: false,
  }
  const audio = {
    paused: false,
    currentTime: 42,
    pause() { log.push('pause'); this.paused = true },
    play() { log.push('play'); this.paused = false },
  }
  const env = {
    state, audio,
    shufflePick: opts.shufflePick == null ? 0 : opts.shufflePick,
    keepGoing: !!opts.keepGoing,
    autoplay: !!opts.autoplay,
  }

  const fn = new Function('env', 'log', `
    const { state, audio } = env
    let _pendingShuffle = null
    let _shuffleHistory = []
    let _skipShortGuard = 0
    let _oldQueue = null
    function _sleepAtTrackEnd() { return false }
    function updatePlayBtn() { log.push('updatePlayBtn') }
    function updateStopAfterBtn() {}
    function updateTrackHighlight() { log.push('highlight') }
    function updateNowPlaying(t) { log.push('nowPlaying:' + (t ? t.title : 'null')) }
    function renderQueuePanel() {}
    function updateNowPlayingModal() {}
    function syncExtension() { log.push('syncExtension') }
    function _radioMaybeRefill() {}
    function pickShuffleIndex() { return env.shufflePick }
    function restoreOldQueue() { log.push('restoreOldQueue') }
    function keepGoingEnabled() { return env.keepGoing }
    function _keepGoingContinue() { log.push('keepGoing@' + state.queueIndex) }
    function autoplayEnabled() { return env.autoplay }
    function tryAutoplayContinue() { log.push('autoplay@' + state.queueIndex) }
    function showSnackbar(m) { log.push('snackbar:' + m) }
    function _isInterlude() { return false }
    function playCurrentTrack() { log.push('playCurrentTrack:' + state.queueIndex) }
    ${PLAY_NEXT}
    return { playNext }
  `)
  const lifted = fn(env, log)
  return { ...lifted, state, audio, log, env }
}

test('a shuffle pick of 0 plays track 0 instead of stopping the music', () => {
  const h = build({ shuffle: true, shufflePick: 0, queueIndex: 3 })
  h.playNext()
  assert.strictEqual(h.state.queueIndex, 0, 'the shuffle pick is honoured')
  assert.ok(h.log.includes('playCurrentTrack:0'),
    'track 0 must actually be played, not treated as the end of the queue')
  assert.ok(!h.log.includes('pause'),
    'a shuffle pick of 0 must never pause playback')
  assert.strictEqual(h.state.isPlaying, true)
})

test('a shuffle pick of 0 does not hand off to keep-going or autoplay either', () => {
  const h = build({ shuffle: true, shufflePick: 0, keepGoing: true, autoplay: true })
  h.playNext()
  assert.ok(!h.log.some(l => l.startsWith('keepGoing')),
    'the queue is not finished, so nothing should be appended to it')
  assert.ok(!h.log.some(l => l.startsWith('autoplay')))
  assert.ok(h.log.includes('playCurrentTrack:0'))
})

test('every shuffle pick keeps playing, 0 included', () => {
  for (let pick = 0; pick < 7; pick++) {
    const h = build({ shuffle: true, shufflePick: pick, queueIndex: pick === 3 ? 4 : 3 })
    h.playNext()
    assert.ok(h.log.includes('playCurrentTrack:' + pick),
      'shuffle pick ' + pick + ' must play, not stop')
    assert.ok(!h.log.includes('pause'), 'shuffle pick ' + pick + ' must not pause')
  }
})

test('the sequential wrap off the end is still the end of the queue', () => {
  const h = build({ shuffle: false, queueIndex: 6 })   // last of seven
  h.playNext()
  assert.ok(h.log.includes('pause'), 'repeat off at the end still stops')
  assert.strictEqual(h.state.isPlaying, false)
  assert.ok(!h.log.some(l => l.startsWith('playCurrentTrack')),
    'nothing new starts when the queue has genuinely run out')
})

test('sequentially arriving at index 0 mid-queue is impossible, but repeat-all still wraps', () => {
  const h = build({ shuffle: false, queueIndex: 6, repeat: 'all' })
  h.playNext()
  assert.strictEqual(h.state.queueIndex, 0)
  assert.ok(h.log.includes('playCurrentTrack:0'), 'repeat all restarts the queue')
})
