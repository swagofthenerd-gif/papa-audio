'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const R = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

// The resume snapshot always kept tracks 1-100 and then clamped the index into
// them, so past track 100 of a long playlist the queue panel, the highlight and
// Next/Previous all pointed at a different song from the one playing.
const CAP = 100
function windowFor(queueLength, queueIndex) {
  const half = Math.floor(CAP / 2)
  const from = Math.max(0, Math.min(Math.max(0, queueIndex) - half, Math.max(0, queueLength - CAP)))
  const kept = Math.min(CAP, queueLength - from)
  return { from, index: Math.max(0, Math.min(Math.max(0, queueIndex) - from, kept - 1)), kept }
}

test('the saved window always contains the track that was playing', () => {
  const cases = [[200, 150], [200, 5], [200, 199], [50, 20], [400, 0], [400, 399], [100, 99], [101, 100], [1, 0]]
  for (const [len, idx] of cases) {
    const w = windowFor(len, idx)
    assert.strictEqual(w.from + w.index, idx,
      `queue of ${len} at ${idx} restored to ${w.from + w.index}`)
    assert.ok(w.kept <= CAP, 'and never saves more than the cap')
    assert.ok(w.kept > 0)
  }
})

test('the first hundred are still kept when that is where the listener is', () => {
  assert.strictEqual(windowFor(500, 10).from, 0, 'no need to slide the window early on')
})

test('the snapshot is windowed, not taken from the front', () => {
  assert.doesNotMatch(R, /state\.queue\.slice\(0, AUTO_QUEUE_CAP\)/,
    'slicing from zero is what put the listener on the wrong track')
  assert.match(R, /var _autoTracks = state\.queue\.slice\(_from, _from \+ AUTO_QUEUE_CAP\)/)
  assert.match(R, /windowFrom: _from/, 'and records where the window sits, so the message can be honest')
})

// Shuffle, repeat and speed were pure in-memory state, reset on every restart.
test('shuffle, repeat and speed ride with the queue they belong to', () => {
  const save = R.slice(R.indexOf('var _autoQ = {'))
  const body = save.slice(0, save.indexOf('\n    }') + 6)
  assert.match(body, /shuffle: !!state\.shuffle/)
  assert.match(body, /repeat: state\.repeat/)
  assert.match(body, /speed: Number\(state\.playbackSpeed\)/)
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
