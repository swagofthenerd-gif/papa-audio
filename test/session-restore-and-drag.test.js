'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The resume snapshot always kept tracks 1-100 and then clamped the index into
// them, so past track 100 of a long playlist the queue panel, the highlight and
// Next/Previous all pointed at a different song from the one playing.
//
// The snapshot is built inline inside a long renderer function, so the real
// block is lifted out by its anchors and run against a fake state. An earlier
// version of this file kept a private copy of the windowing arithmetic: putting
// the original bug back (`var _from = 0`, verbatim) left it green, because the
// copy is the only thing it ever ran.
const CAP = 100
function liftSnapshot() {
  const start = R.indexOf('var _half = Math.floor(AUTO_QUEUE_CAP / 2)')
  assert.ok(start > -1, 'the auto-queue snapshot must still start at _half')
  const end = R.indexOf('window.api.saveQueue(_autoQ)', start)
  assert.ok(end > start, 'and must still hand _autoQ to saveQueue')
  return new Function('state', 'AUTO_QUEUE_CAP', R.slice(start, end) + '\nreturn _autoQ')
}
const buildSnapshot = liftSnapshot()

// A queue of `len` whose tracks are their own index, playing track `idx`.
function snapshot(len, idx, extra = {}) {
  const state = {
    queue: Array.from({ length: len }, (_, i) => ({ n: i })),
    queueIndex: idx,
    shuffle: false, repeat: 'off', playbackSpeed: 1, ...extra,
  }
  return buildSnapshot(state, CAP)
}

test('the saved window always contains the track that was playing', () => {
  const cases = [[200, 150], [200, 5], [200, 199], [50, 20], [400, 0], [400, 399], [100, 99], [101, 100], [1, 0]]
  for (const [len, idx] of cases) {
    const q = snapshot(len, idx)
    // The restore reads tracks[index]. That must be the song that was playing.
    assert.strictEqual(q.tracks[q.index].n, idx,
      `queue of ${len} at ${idx} restored to track ${q.tracks[q.index].n}`)
    assert.ok(q.tracks.length <= CAP, 'and never saves more than the cap')
    assert.ok(q.tracks.length > 0)
    assert.strictEqual(q.windowFrom + q.index, idx,
      'and windowFrom places the window honestly in the full queue')
  }
})

test('the first hundred are still kept when that is where the listener is', () => {
  assert.strictEqual(snapshot(500, 10).windowFrom, 0, 'no need to slide the window early on')
  assert.strictEqual(snapshot(500, 10).tracks[0].n, 0)
})

test('the window slides to the end rather than running off it', () => {
  const q = snapshot(400, 399)
  assert.strictEqual(q.windowFrom, 300, 'the last hundred, not a window hanging past the end')
  assert.strictEqual(q.tracks.length, CAP)
})

test('a long queue records how long it really was, so the restore can say so', () => {
  assert.strictEqual(snapshot(400, 10).truncatedFrom, 400)
  assert.strictEqual(snapshot(40, 10).truncatedFrom, 0, 'a short queue was not truncated')
})

// Shuffle, repeat and speed were pure in-memory state, reset on every restart.
test('shuffle, repeat and speed ride with the queue they belong to', () => {
  const q = snapshot(10, 3, { shuffle: true, repeat: 'one', playbackSpeed: 1.25 })
  assert.strictEqual(q.shuffle, true)
  assert.strictEqual(q.repeat, 'one')
  assert.strictEqual(q.speed, 1.25)
  const plain = snapshot(10, 3, { repeat: null, playbackSpeed: 0 })
  assert.strictEqual(plain.repeat, 'off', 'a missing mode is off, not undefined')
  assert.strictEqual(plain.speed, 1, 'and a missing speed is normal speed, never zero')
})

test('the restored settings are actually put back on startup', () => {
  assert.match(R, /if \(typeof autoQueue\.shuffle === 'boolean'\) state\.shuffle = autoQueue\.shuffle/,
    'and are put back on restore')
  assert.match(R, /if \(autoQueue\.repeat\) state\.repeat = autoQueue\.repeat/)
})

// Dragging the scrubber fired a real, sample-accurate mpv seek on every
// pointermove — one per pixel of travel. On local FLAC each does demux work, so
// the audio stuttered through a dozen positions and lagged behind the thumb.
test('dragging coalesces to one seek per frame, but still paints every move', () => {
  const fn = R.slice(R.indexOf('function makeDraggable'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.match(body, /requestAnimationFrame\(flush\)/, 'the expensive half is frame-gated')
  assert.ok(body.indexOf('fillEl.style.width') < body.indexOf('pendingRatio = ratio'),
    'the thumb is still moved on every event, before the gate')
  assert.match(body, /update\(e, true\)/, 'a click lands exactly where it was clicked')
  assert.match(body, /if \(pendingRatio !== null\)/, 'and the last position is delivered on release')
})

// "The Beatles", "The Avalanches" and six others all filed under T.
test('artists sort by their name without a leading article', () => {
  const ARTICLE = /^(the|a|an)\s+/i
  const key = n => String(n || '').replace(ARTICLE, '').trim().toLowerCase()
  const sorted = ['The Beatles', 'Talking Heads', 'A Tribe Called Quest', 'Air', 'The Avalanches', 'Beach House']
    .sort((a, b) => key(a).localeCompare(key(b)))
  assert.deepStrictEqual(sorted,
    ['Air', 'The Avalanches', 'Beach House', 'The Beatles', 'Talking Heads', 'A Tribe Called Quest'])
  assert.match(R, /function _artistSortKey/)
  assert.doesNotMatch(R, /\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name\)\)/,
    'the raw-name sort must not come back')
})

test('the article is stripped for sorting only, never for display', () => {
  const fn = R.slice(R.indexOf('function _artistSortKey'))
  const body = fn.slice(0, fn.indexOf('\n}') + 2)
  assert.match(body, /replace\(_ARTICLE, ''\)/)
  // The rendered name must still come from a.name somewhere in the artist grid.
  assert.match(R, /esc\(a\.name\)|esc\(artist\.name\)|\$\{esc\(a\.name\)\}/,
    'the displayed name is still the real one')
})
