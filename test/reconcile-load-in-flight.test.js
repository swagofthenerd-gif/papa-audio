'use strict'
// During fast Next the reconciler read mpv's path while a load it had just
// asked for was still in flight. mpv still has the PREVIOUS file open for that
// whole gap, so the reconciler treated the old path as the authority and
// dragged state.queueIndex backwards onto the track being left. The next tick
// disagreed in the other direction: the alternating "the UI and mpv disagree"
// pairs about 20ms apart, seven "load failed -> retry" decisions and one
// "skip (failed-twice)" on files that were sitting on disk the whole time.
//
// The reconciler is lifted out of renderer.js and driven against a fake shim,
// so this test follows the real control flow rather than a copy of it.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function liftNested(name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > -1, name + ' must still exist in renderer.js')
  let i = src.indexOf('{', at)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1) }
  }
  throw new Error('unbalanced ' + name)
}

const RECONCILE = liftNested('reconcileWhatIsPlaying')

const Q = ['one', 'two', 'three', 'four'].map(t => ({ filePath: '/m/' + t + '.flac', title: t }))

function build(opts) {
  opts = opts || {}
  const log = []
  const state = {
    queue: Q.slice(),
    queueIndex: opts.queueIndex == null ? 2 : opts.queueIndex,
    queuePanelOpen: false,
    modalOpen: false,
  }
  // The real shim's own signal: true while mpv has been asked to open a file
  // and has not answered yet.
  const audio = { mpvPath: opts.mpvPath || null, loadInFlight: !!opts.loadInFlight }
  const env = { state, audio }

  const fn = new Function('env', 'log', `
    const { state, audio } = env
    let _reconcileWarnedPath = null
    const console = { error: (...a) => log.push('error:' + a.join(' ')) }
    function updateNowPlaying(t) { log.push('nowPlaying:' + (t ? t.title : 'null')) }
    function updateTrackHighlight() {}
    function renderQueuePanel() {}
    function updateNowPlayingModal() {}
    function updateNextPrefetch() {}
    function updateNowPlayingFromPath(p) { log.push('fromPath:' + p) }
    ${RECONCILE}
    return { reconcileWhatIsPlaying }
  `)
  return { ...fn(env, log), state, audio, log }
}

test('a load in flight is not a disagreement', () => {
  // The user pressed Next: the UI is on track 3, mpv still has track 2 open
  // because the load it was just handed has not landed.
  const h = build({ queueIndex: 2, mpvPath: '/m/two.flac', loadInFlight: true })
  h.reconcileWhatIsPlaying()
  assert.strictEqual(h.state.queueIndex, 2,
    'the index the user just chose must not be dragged back to the track being left')
  assert.ok(!h.log.some(l => l.startsWith('error:')),
    'a load in flight must not be reported as the UI and mpv disagreeing')
  assert.ok(!h.log.some(l => l.startsWith('nowPlaying:')))
})

test('fast Next does not produce alternating corrections', () => {
  const h = build({ queueIndex: 1, mpvPath: '/m/one.flac', loadInFlight: true })
  h.reconcileWhatIsPlaying()
  h.state.queueIndex = 2                 // another Next while the first still loads
  h.reconcileWhatIsPlaying()
  h.state.queueIndex = 3
  h.reconcileWhatIsPlaying()
  assert.strictEqual(h.state.queueIndex, 3, 'every press sticks')
  assert.strictEqual(h.log.length, 0, 'and none of them is reported as a disagreement')
})

test('once the load lands, a genuine disagreement is still corrected', () => {
  const h = build({ queueIndex: 2, mpvPath: '/m/one.flac', loadInFlight: false })
  h.reconcileWhatIsPlaying()
  assert.strictEqual(h.state.queueIndex, 0,
    'mpv is the authority once it has actually answered')
  assert.ok(h.log.includes('nowPlaying:one'))
  assert.ok(h.log.some(l => l.startsWith('error:')), 'and it is still said out loud, once')
})

test('agreement is silent whether or not a load is in flight', () => {
  for (const inFlight of [true, false]) {
    const h = build({ queueIndex: 2, mpvPath: '/m/three.flac', loadInFlight: inFlight })
    h.reconcileWhatIsPlaying()
    assert.strictEqual(h.state.queueIndex, 2)
    assert.strictEqual(h.log.length, 0)
  }
})

test('a file mpv is playing that the queue does not hold still repaints the bar', () => {
  const h = build({ queueIndex: 2, mpvPath: '/m/stranger.flac', loadInFlight: false })
  h.reconcileWhatIsPlaying()
  assert.ok(h.log.includes('fromPath:/m/stranger.flac'))
})

// ── The other half: a load error must not be blamed on whatever the index
// happens to point at by the time the handler runs.
function liftErrorHandler() {
  const marker = "audio.addEventListener('error', e => {"
  const at = src.indexOf(marker)
  assert.ok(at > -1, 'the audio error handler must still exist in renderer.js')
  let i = src.indexOf('{', at + marker.length - 2)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j) }
  }
  throw new Error('unbalanced error handler')
}

const ERR_HANDLER = liftErrorHandler()

function buildErr(queueIndex) {
  const log = []
  const state = { queue: Q.slice(), queueIndex }
  const env = { state }
  const fn = new Function('env', 'log', `
    const { state } = env
    const console = { error: (...a) => log.push('log:' + a.join(' ')) }
    const document = { getElementById() { return null } }
    function handleLoadError(p) { log.push('handleLoadError:' + p) }
    function playNext() { log.push('playNext') }
    function onError(e) { ${ERR_HANDLER} }
    return { onError }
  `)
  return { ...fn(env, log), state, log }
}

test('a load error for a track the index has moved off is not counted as a failure', () => {
  const h = buildErr(2)      // the queue now points at three
  h.onError({ detail: { src: '/m/one.flac' } })
  assert.ok(!h.log.some(l => l.startsWith('handleLoadError')),
    'the retry/skip policy must not run against a track that did not fail')
  assert.ok(!h.log.includes('playNext'))
})

test('a load error for the track that is actually current is still handled', () => {
  const h = buildErr(2)
  h.onError({ detail: { src: '/m/three.flac' } })
  assert.ok(h.log.includes('handleLoadError:/m/three.flac'))
})

test('an error with no src named still falls back to the current track', () => {
  const h = buildErr(2)
  h.onError({})
  assert.ok(h.log.includes('handleLoadError:/m/three.flac'))
})
