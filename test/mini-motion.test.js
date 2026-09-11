'use strict'
// V1: the mini card's release physics, corner resize and theatre↔card flight,
// as pure maths.
const test = require('node:test')
const assert = require('node:assert')
const M = require('../src/mini-motion')

test('velocity reads the last 100 ms of pointer history; a pause before release is zero', () => {
  const s = [{ t: 0, x: 0, y: 0 }, { t: 50, x: 40, y: 10 }, { t: 100, x: 80, y: 20 }]
  assert.deepEqual(M.velocity(s, 100), { vx: 800, vy: 200 })
  assert.deepEqual(M.velocity(s, 500), { vx: 0, vy: 0 }, 'everything older than the window is ignored')
  assert.deepEqual(M.velocity([{ t: 0, x: 0, y: 0 }], 0), { vx: 0, vy: 0 })
  assert.deepEqual(M.velocity(null, 0), { vx: 0, vy: 0 })
})

test('a flick projects the drop point along the velocity, capped so it stays within reach', () => {
  assert.deepEqual(M.projectedPoint({ x: 100, y: 100 }, { vx: 1000, vy: 0 }), { x: 100 + 1000 * M.FLING_TAU, y: 100 })
  const wild = M.projectedPoint({ x: 0, y: 0 }, { vx: 30000, vy: 0 })
  assert.equal(Math.round(wild.x), M.FLING_MAX_PX)
  assert.deepEqual(M.projectedPoint({ x: 5, y: 6 }, { vx: 0, vy: 0 }), { x: 5, y: 6 })
})

test('the spring settles at the target within half a second, continues the release velocity, and barely overshoots', () => {
  const sp = M.spring({ x: 0, y: 0 }, { x: 300, y: 0 }, { vx: 1200, vy: 0 })
  let t = 0, maxX = 0, p
  const first = sp.step(16); assert.ok(first.x > 15, 'the first frame carries the hand\'s speed: ' + first.x)
  maxX = first.x
  while (t < 2000) { p = sp.step(16); t += 16; maxX = Math.max(maxX, p.x); if (p.done) break }
  assert.ok(p.done && t <= 500, 'settled in ' + t + ' ms')
  assert.deepEqual([p.x, p.y], [300, 0])
  assert.ok(maxX < 300 * 1.06, 'overshoot ' + (maxX - 300).toFixed(1) + ' px is a whisper, not a bounce')
  assert.deepEqual(sp.step(16), { x: 300, y: 0, done: true }, 'stays put once done')
})

test('the spring survives a long hitch frame without exploding', () => {
  const sp = M.spring({ x: 0, y: 0 }, { x: 100, y: 100 }, { vx: 0, vy: 0 })
  const p = sp.step(5000)
  assert.ok(Number.isFinite(p.x) && p.x >= 0 && p.x <= 110, 'one hitch frame is clamped, not integrated for 5 s: ' + p.x)
  let q, n = 0
  do { q = sp.step(16); n++ } while (!q.done && n < 200)
  assert.deepEqual(q, { x: 100, y: 100, done: true })
})

test('the corner grip grows the card away from its anchored corner and clamps the width', () => {
  // Bottom-right card: the grip is top-left, so pulling up-left grows it.
  assert.equal(M.resizedWidth(320, -100, -20, 'br'), 420)
  assert.equal(M.resizedWidth(320, 100, 0, 'br'), 240, 'pushing toward the anchor shrinks, floored')
  // Top-left card: grip bottom-right, pulling down-right grows it.
  assert.equal(M.resizedWidth(320, 60, 80, 'tl'), 320 + Math.round(80 * 16 / 9), 'the axis moved more wins')
  assert.equal(M.resizedWidth(320, 900, 0, 'tl'), M.MAX_W)
  assert.equal(M.resizedWidth(320, 900, 0, 'tl', 500), 500, 'a narrow window caps it lower')
})

test('flip keyframes put the video region on the stage at a uniform scale, then land on the anchor', () => {
  const f = M.flipKeyframes({ x: 0, y: 60, width: 1600, height: 800 }, { x: 1256, y: 630 }, { w: 320, h: 180 }, 26)
  // 1600/320 = 5 wide, 800/180 = 4.44 tall: the smaller wins, centred.
  assert.equal(f.start.s, 4.444)
  assert.equal(f.start.x, Math.round((1600 - 320 * 4.444) / 2))
  assert.equal(f.start.y, Math.round(60 + (800 - 180 * 4.444) / 2 - 26 * 4.444))
  assert.deepEqual(f.end, { x: 1256, y: 630, s: 1 })
  assert.equal(M.transformOf(f.end), 'translate(1256px,630px) scale(1)')
})
