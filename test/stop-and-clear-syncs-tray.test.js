'use strict'
// "Stop and clear" emptied the queue and stopped the music, and the tray icon,
// the MPRIS applet and now-playing.json went on advertising the cleared track
// for the rest of the session. The handler paints the bar empty with
// updateNowPlaying(null) and nothing else; updateNowPlaying never called
// syncExtension, even though its own header comment names the stale tray as
// the bug it was written to fix. Once playback stops the once-a-second sync
// stops too, so nothing was ever going to come back and correct it.
//
// Both the handler and updateNowPlaying are lifted out of renderer.js and run
// against fakes, with a recording syncExtension.

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

// The clear buttons live inside renderQueuePanel, so their handler bodies are
// sliced out by matching braces from the addEventListener that owns them.
function liftHandler(marker) {
  const at = src.indexOf(marker)
  assert.ok(at > -1, 'the handler anchored on ' + JSON.stringify(marker) + ' must still exist')
  let i = src.indexOf('{', at + marker.length - 1)
  assert.ok(i > -1)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(i + 1, j)
    }
  }
  throw new Error('unbalanced handler body for ' + marker)
}

const UPDATE_NOW_PLAYING = lift('updateNowPlaying')
const STOP_AND_CLEAR = liftHandler("clearBtn.addEventListener('click', () => {")
const CLEAR_UPCOMING = liftHandler("clearUpcomingBtn.addEventListener('click', () => {")
const CLEAR_PLAYED = liftHandler("clearPlayedBtn.addEventListener('click', () => {")

const TRACKS = ['one', 'two', 'three', 'four'].map(t => ({
  filePath: '/m/' + t + '.flac', title: t, artist: 'A', albumName: 'Album', albumId: 'al',
}))

function build(opts) {
  opts = opts || {}
  const published = []
  const log = []
  const state = {
    queue: TRACKS.slice(),
    queueIndex: opts.queueIndex == null ? 1 : opts.queueIndex,
    isPlaying: true,
    queuePanelOpen: false,
    modalOpen: false,
    _restoredFromQueue: true,
  }
  const audio = {
    paused: false, volume: 0.8, currentTime: 10, duration: 200,
    pause() { this.paused = true },
  }
  // A document where every lookup misses: updateNowPlaying guards every
  // element it touches, so this exercises the real control flow without a DOM.
  const document = { getElementById() { return null }, querySelector() { return null } }
  const undos = []

  const env = { state, audio, document, published, undos }

  const fn = new Function('env', 'log', `
    const { state, audio, document, published, undos } = env
    let _pendingShuffle = null
    const window = { PapaMusicTools: null }
    // The real sync is debounced; what matters here is the payload it would
    // publish, so the debounce is collapsed and the body is the real shape.
    function syncExtension() {
      const t = state.queue[state.queueIndex]
      published.push(t
        ? { playing: state.isPlaying, title: t.title, queueLength: state.queue.length }
        : { playing: false })
    }
    function refreshJumpbackCard() {}
    function applyTicker() {}
    function fmtSpec() { return '' }
    function updateFormatBadge() {}
    function updateBitPerfectBadge() {}
    function updateCrossfadeBadge() {}
    function updateStatsRow() {}
    function updateRadioState() {}
    function updateNextPrefetch() {}
    function updatePlayBtn() {}
    function renderQueuePanel() {}
    function pushUndo(label, fn) { undos.push({ label, fn }) }
    ${UPDATE_NOW_PLAYING}
    function stopAndClear() { ${STOP_AND_CLEAR} }
    function clearUpcoming() { ${CLEAR_UPCOMING} }
    function clearPlayed() { ${CLEAR_PLAYED} }
    return { stopAndClear, clearUpcoming, clearPlayed, updateNowPlaying }
  `)
  return { ...fn(env, log), state, audio, published, undos }
}

test('Stop and clear tells the tray that nothing is playing', () => {
  const h = build({ queueIndex: 1 })
  h.stopAndClear()
  assert.strictEqual(h.state.queue.length, 0, 'the queue is emptied')
  assert.ok(h.published.length > 0,
    'the tray, MPRIS and now-playing.json must be told, or they keep showing the cleared track')
  const last = h.published[h.published.length - 1]
  assert.strictEqual(last.playing, false)
  assert.ok(!last.title, 'nothing is playing, so no track may be published')
})

test('updateNowPlaying(null) is itself enough to clear the tray', () => {
  const h = build({ queueIndex: 1 })
  h.state.queue = []
  h.state.queueIndex = -1
  h.state.isPlaying = false
  h.updateNowPlaying(null)
  assert.strictEqual(h.published.length, 1,
    'every "nothing is playing" paint must publish, whichever call site it came from')
  assert.strictEqual(h.published[0].playing, false)
})

test('undoing Stop and clear puts the restored queue back on the tray', () => {
  const h = build({ queueIndex: 1 })
  h.stopAndClear()
  h.published.length = 0
  assert.strictEqual(h.undos.length, 1, 'Stop and clear stays undoable')
  h.undos[0].fn()
  assert.strictEqual(h.state.queue.length, 4)
  const last = h.published[h.published.length - 1]
  assert.ok(last, 'the restored queue must be republished')
  assert.strictEqual(last.title, 'two', 'the track that was playing comes back')
})

test('Clear upcoming republishes the shortened queue', () => {
  const h = build({ queueIndex: 1 })
  h.clearUpcoming()
  assert.strictEqual(h.state.queue.length, 2, 'only the played tracks and the current one remain')
  const last = h.published[h.published.length - 1]
  assert.ok(last, 'the extension still holds the old, longer queue unless told')
  assert.strictEqual(last.queueLength, 2)
})

test('Clear played republishes the shortened queue', () => {
  const h = build({ queueIndex: 2 })
  h.clearPlayed()
  assert.strictEqual(h.state.queue.length, 2)
  const last = h.published[h.published.length - 1]
  assert.ok(last)
  assert.strictEqual(last.queueLength, 2)
  assert.strictEqual(last.title, 'three', 'the current track is unchanged by clearing history')
})

test('an ordinary track paint does not spam the extension', () => {
  const h = build({ queueIndex: 1 })
  h.updateNowPlaying(TRACKS[1])
  assert.strictEqual(h.published.length, 0,
    'playCurrentTrack already syncs; only the nothing-playing case is uncovered')
})
