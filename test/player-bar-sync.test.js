'use strict'
// The player bar lagging and showing the wrong song (2026-09-16).
//
// "the audio player bar needs some work, its lagging and showing the wrong
// song". Measured on a twin, and it was almost exactly a second every time:
//
//   correction by the once-a-second poll : 953 ms, 903 ms, 953 ms
//   correction by the event              :  11 ms,  11 ms,  11 ms
//
// src/player-shim.js emits 'trackchanged' whenever mpv reports the file it
// actually has open, and its own comment says why that matters — "this is what
// mpv is actually playing, which is the thing several desync findings turn on".
// Nothing in the renderer had ever listened. So the bar's only corrections were
// a gapless auto-advance and a 1 s poll, and on a gapless album that poll is hit
// at every single track boundary.
const test = require('node:test')
const assert = require('node:assert')
const vm = require('node:vm')
const fs = require('fs')
const path = require('path')
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')
const SHIM = fs.readFileSync(path.join(__dirname, '..', 'src', 'player-shim.js'), 'utf8')

test('the shim still reports what mpv actually has open', () => {
  assert.match(SHIM, /case 'trackChanged':/)
  assert.match(SHIM, /this\._mpvPath = data/)
  assert.match(SHIM, /new CustomEvent\('trackchanged'/)
})

test('the renderer listens to it — the whole point of it being emitted', () => {
  assert.match(RENDERER, /audio\.addEventListener\('trackchanged', function \(\) \{ reconcileWhatIsPlaying\(\) \}\)/,
    'without a listener the bar waits out a poll at every track change')
})

test('the poll and the event share one reconciler, so they cannot drift apart', () => {
  assert.match(RENDERER, /function reconcileWhatIsPlaying\(\) \{/)
  const timer = RENDERER.slice(RENDERER.indexOf('const reconcileTimer = setInterval'),
                               RENDERER.indexOf('reconcileTimer.unref'))
  assert.match(timer, /reconcileWhatIsPlaying\(\)/, 'the timer calls the same function')
  assert.ok(!/const shown = state\.queue\[state\.queueIndex\][\s\S]{0,400}RECONCILE_MS\)/.test(timer),
    'the logic must not be duplicated back into the timer')
})

// Executed, not grepped: the throttle guard used to sit ABOVE the correction, so
// it suppressed the FIX and not just the console line.
function reconciler(over) {
  const calls = { nowPlaying: [], fromPath: [], logs: [] }
  const ctx = Object.assign({
    console: { error: (...a) => calls.logs.push(a.join(' ').slice(0, 80)) },
    JSON, RegExp, String, Number,
    state: { queue: [], queueIndex: 0, queuePanelOpen: false, modalOpen: false },
    audio: { mpvPath: null },
    _reconcileWarnedPath: null,
    updateNowPlaying: t => calls.nowPlaying.push(t && t.filePath),
    updateNowPlayingFromPath: p => calls.fromPath.push(p),
    updateTrackHighlight() {}, renderQueuePanel() {}, updateNowPlayingModal() {},
    updateNextPrefetch() {},
  }, over)
  vm.createContext(ctx)
  const start = RENDERER.indexOf('function reconcileWhatIsPlaying() {')
  const end = RENDERER.indexOf("\n    audio.addEventListener('trackchanged'", start)
  vm.runInContext(RENDERER.slice(start, end), ctx)
  return { ctx, calls }
}

const T = p => ({ filePath: p, title: p.split('/').pop() })

test('a disagreement is corrected, and the queue index follows mpv', () => {
  const { ctx, calls } = reconciler({
    state: { queue: [T('/a.flac'), T('/b.flac')], queueIndex: 0, queuePanelOpen: false, modalOpen: false },
    audio: { mpvPath: '/b.flac' },
  })
  ctx.reconcileWhatIsPlaying()
  assert.strictEqual(ctx.state.queueIndex, 1, 'mpv is the authority')
  assert.deepStrictEqual(Array.from(calls.nowPlaying), ['/b.flac'])
})

test('the same disagreement is corrected EVERY time, not only the first', () => {
  const { ctx, calls } = reconciler({
    state: { queue: [T('/a.flac'), T('/b.flac')], queueIndex: 0, queuePanelOpen: false, modalOpen: false },
    audio: { mpvPath: '/b.flac' },
  })
  ctx.reconcileWhatIsPlaying()
  ctx.state.queueIndex = 0          // something optimistic put it back
  ctx.reconcileWhatIsPlaying()
  assert.strictEqual(ctx.state.queueIndex, 1, 'the throttle must gate the log, never the fix')
  assert.strictEqual(calls.nowPlaying.length, 2)
  assert.strictEqual(calls.logs.length, 1, 'but it is still said only once')
})

test('a file mpv has that the queue does not still reaches the bar', () => {
  const { ctx, calls } = reconciler({
    state: { queue: [T('/a.flac')], queueIndex: 0, queuePanelOpen: false, modalOpen: false },
    audio: { mpvPath: '/elsewhere.flac' },
  })
  ctx.reconcileWhatIsPlaying()
  assert.deepStrictEqual(Array.from(calls.fromPath), ['/elsewhere.flac'])
})

test('agreement is silent, and clears the throttle for next time', () => {
  const { ctx, calls } = reconciler({
    state: { queue: [T('/a.flac')], queueIndex: 0, queuePanelOpen: false, modalOpen: false },
    audio: { mpvPath: '/a.flac' },
    _reconcileWarnedPath: '/old.flac',
  })
  ctx.reconcileWhatIsPlaying()
  assert.strictEqual(calls.nowPlaying.length, 0)
  assert.strictEqual(calls.logs.length, 0)
  assert.strictEqual(ctx._reconcileWarnedPath, null)
})

test('a stream is never reported as a disagreement', () => {
  // Streams are resolved to a direct URL before mpv sees them, so the paths
  // legitimately differ and comparing them would cry wolf every track.
  const { ctx, calls } = reconciler({
    state: { queue: [T('https://example/stream')], queueIndex: 0, queuePanelOpen: false, modalOpen: false },
    audio: { mpvPath: '/tmp/resolved.m4a' },
  })
  ctx.reconcileWhatIsPlaying()
  assert.strictEqual(calls.logs.length, 0)
  assert.strictEqual(calls.nowPlaying.length, 0)
})
