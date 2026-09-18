'use strict'
// The volume slider only reached 0 if you dragged PAST its left edge and let
// the clamp catch you. A click on the edge itself landed on pixel 1 of an
// 80-110px track, which is 1% — quiet, not off. The same at the other end: a
// click on the right edge stopped a percent short of full.
//
// makeDraggable is lifted out of renderer.js and driven with real pointer
// coordinates against a track of a real width, so this follows the shipped
// helper rather than a copy.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8')

function lift(name) {
  const at = src.indexOf('function ' + name + '(')
  assert.ok(at > -1, name + ' must still exist in renderer.js')
  return src.slice(at, src.indexOf('\nfunction ', at + 1))
}

const MAKE_DRAGGABLE = lift('makeDraggable')

// A track 100px wide starting at x=200: one pixel is exactly one percent, the
// proportions the live volume bar actually has.
function build({ left = 200, width = 100 } = {}) {
  const changes = []
  const listeners = {}
  const trackEl = {
    style: {},
    getBoundingClientRect: () => ({ left, width, right: left + width }),
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
    setPointerCapture() {},
    releasePointerCapture() {},
  }
  const fillEl = { style: {} }
  const thumbEl = { style: {} }
  const env = { trackEl, fillEl, thumbEl, changes }
  new Function('env', `
    const { trackEl, fillEl, thumbEl, changes } = env
    // The rAF batching is collapsed: this test is about the value, not the
    // frame it lands on. Returning 0 matters — the helper assigns the handle
    // AFTER the callback has run, so a truthy handle would leave it believing
    // a frame is still outstanding and drop every later move.
    function requestAnimationFrame(fn) { fn(); return 0 }
    function cancelAnimationFrame() {}
    ${MAKE_DRAGGABLE}
    makeDraggable(trackEl, fillEl, thumbEl, r => changes.push(r))
  `)(env)

  function clickAt(x) {
    const e = { button: 0, pointerId: 1, clientX: x, preventDefault() {} }
    for (const fn of listeners.pointerdown || []) fn(e)
    return changes[changes.length - 1]
  }
  function dragTo(x) {
    const e = { pointerId: 1, clientX: x, preventDefault() {} }
    for (const fn of listeners.pointermove || []) fn(e)
    return changes[changes.length - 1]
  }
  return { clickAt, dragTo, changes, left, width }
}

test('clicking the left edge of the volume slider reaches silence', () => {
  const h = build()
  assert.strictEqual(h.clickAt(h.left), 0,
    'silence must be reachable without dragging off the end of the control')
})

test('clicking a pixel inside the left edge still means silence, not 1%', () => {
  const h = build()
  assert.strictEqual(h.clickAt(h.left + 1), 0)
  assert.strictEqual(h.clickAt(h.left + 2), 0)
})

test('clicking the right edge reaches full, not 99%', () => {
  const h = build()
  assert.strictEqual(h.clickAt(h.left + h.width), 1)
  assert.strictEqual(h.clickAt(h.left + h.width - 1), 1)
})

test('dragging to the ends reaches them too', () => {
  const h = build()
  h.clickAt(h.left + 50)
  assert.strictEqual(h.dragTo(h.left), 0)
  assert.strictEqual(h.dragTo(h.left + h.width), 1)
})

test('the middle of the track is still a plain proportion', () => {
  const h = build()
  assert.strictEqual(h.clickAt(h.left + 50), 0.5)
  assert.strictEqual(h.clickAt(h.left + 25), 0.25)
  assert.strictEqual(h.clickAt(h.left + 80), 0.8)
})

test('a click well inside the track is never snapped', () => {
  const h = build()
  const r = h.clickAt(h.left + 10)
  assert.ok(r > 0 && r < 1, 'only the ends mean the ends')
  assert.strictEqual(r, 0.1)
})

test('dragging past either edge is still clamped', () => {
  const h = build()
  h.clickAt(h.left + 50)
  assert.strictEqual(h.dragTo(h.left - 40), 0)
  assert.strictEqual(h.dragTo(h.left + h.width + 40), 1)
})

test('a track too narrow for two snap zones keeps the plain proportion', () => {
  const h = build({ left: 0, width: 8 })
  assert.strictEqual(h.clickAt(4), 0.5,
    'snapping both ends of a tiny track would leave no middle at all')
})
