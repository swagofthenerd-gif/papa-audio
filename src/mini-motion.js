'use strict'
// The mini card's motion (video plan V1): how a released drag becomes a fling
// to a corner, how the card settles there on a spring, how a corner-grip drag
// becomes a new size, and how the picture flies between the theatre and the
// card. Pure maths, no DOM, no timers — the deck in src/video-player.js feeds
// pointer samples in and paints the positions out. Tested in
// test/mini-motion.test.js.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaMiniMotion = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  const VELOCITY_WINDOW_MS = 100   // pointer history that counts as "the release"
  const FLING_TAU = 0.18           // seconds of travel a release velocity projects to
  const FLING_MAX_PX = 640         // a violent flick still lands within reach
  const MIN_W = 240                // narrowest picture the card allows
  const MAX_W = 720                // widest
  const ASPECT = 16 / 9

  function _n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0 }

  // Pointer velocity in px/s from the samples inside the last window. Two
  // samples are enough; one (or none) is a still release. A long pause before
  // letting go leaves nothing in the window, which correctly reads as zero.
  function velocity(samples, now, windowMs) {
    const w = windowMs || VELOCITY_WINDOW_MS
    const list = (Array.isArray(samples) ? samples : []).filter(s => s && _n(now) - _n(s.t) <= w)
    if (list.length < 2) return { vx: 0, vy: 0 }
    const a = list[0], b = list[list.length - 1]
    const dt = _n(b.t) - _n(a.t)
    if (dt <= 0) return { vx: 0, vy: 0 }
    return { vx: (_n(b.x) - _n(a.x)) / dt * 1000, vy: (_n(b.y) - _n(a.y)) / dt * 1000 }
  }

  // Where a release would carry the card if it kept sliding: the drop point
  // plus a short projection of the velocity, capped. The nearest corner to
  // THIS point is where a flick lands, so a fast flick toward a far corner
  // gets there even if the card was let go nearer another.
  function projectedPoint(tl, v, opts) {
    const tau = (opts && opts.tau) || FLING_TAU
    const max = (opts && opts.maxPx) || FLING_MAX_PX
    let dx = _n(v && v.vx) * tau, dy = _n(v && v.vy) * tau
    const len = Math.hypot(dx, dy)
    if (len > max) { dx *= max / len; dy *= max / len }
    return { x: _n(tl && tl.x) + dx, y: _n(tl && tl.y) + dy }
  }

  // A damped spring from `from` to `to`, starting with the release velocity so
  // the motion continues the hand's motion instead of restarting from rest.
  // Slightly under-damped (zeta .92): a whisper of overshoot reads as weight,
  // more reads as bounce. step(dtMs) advances and returns the position; done
  // flips once it is within half a pixel and nearly still.
  function spring(from, to, v0, opts) {
    const k = (opts && opts.stiffness) || 320
    const zeta = (opts && opts.damping) || 0.92
    const c = 2 * Math.sqrt(k) * zeta
    let x = _n(from && from.x), y = _n(from && from.y)
    let vx = _n(v0 && v0.vx), vy = _n(v0 && v0.vy)
    const tx = _n(to && to.x), ty = _n(to && to.y)
    let done = false
    function step(dtMs) {
      if (done) return { x: tx, y: ty, done: true }
      let dt = Math.min(64, Math.max(0, _n(dtMs))) / 1000
      while (dt > 0) {
        const h = Math.min(dt, 0.004)
        vx += (-k * (x - tx) - c * vx) * h
        vy += (-k * (y - ty) - c * vy) * h
        x += vx * h; y += vy * h
        dt -= h
      }
      if (Math.abs(x - tx) < 0.5 && Math.abs(y - ty) < 0.5 && Math.abs(vx) < 8 && Math.abs(vy) < 8) {
        done = true; x = tx; y = ty; vx = vy = 0
      }
      return { x, y, done }
    }
    return { step, isDone: () => done }
  }

  // The width a corner-grip drag asks for. The grip sits on the corner OPPOSITE
  // the card's anchored corner, so for a card in the bottom-right the grip is
  // top-left and pulling up-left grows it. Whichever axis the hand moved more
  // along wins, so a mostly-horizontal pull is not slowed by its slight tilt.
  function resizedWidth(startW, dx, dy, corner, maxW) {
    const sx = /r/.test(corner || '') ? -1 : 1
    const sy = /b/.test(corner || '') ? -1 : 1
    const ax = sx * _n(dx), ay = sy * _n(dy) * ASPECT
    const delta = Math.abs(ax) >= Math.abs(ay) ? ax : ay
    const cap = Math.min(MAX_W, _n(maxW) || MAX_W)
    return Math.round(Math.max(MIN_W, Math.min(cap, _n(startW) + delta)))
  }

  // The keyframes for the picture's flight between the theatre stage and the
  // card. The card is scaled from its top-left so its video region lands
  // exactly on the stage's contained picture (uniform scale: the picture must
  // never stretch mid-flight), the handle strip above accounted for. The same
  // pair runs forward for minimise and reversed for restore.
  function flipKeyframes(stage, anchor, videoDims, handleH) {
    const sw = _n(stage && stage.width), sh = _n(stage && stage.height)
    const vw = Math.max(1, _n(videoDims && videoDims.w)), vh = Math.max(1, _n(videoDims && videoDims.h))
    const s = Math.max(0.05, Math.min(sw / vw, sh / vh))
    const x = _n(stage && stage.x) + (sw - vw * s) / 2
    const y = _n(stage && stage.y) + (sh - vh * s) / 2 - _n(handleH) * s
    return {
      start: { x: Math.round(x), y: Math.round(y), s: Math.round(s * 1000) / 1000 },
      end: { x: Math.round(_n(anchor && anchor.x)), y: Math.round(_n(anchor && anchor.y)), s: 1 },
    }
  }

  function transformOf(f) { return 'translate(' + f.x + 'px,' + f.y + 'px) scale(' + f.s + ')' }

  return {
    velocity, projectedPoint, spring, resizedWidth, flipKeyframes, transformOf,
    VELOCITY_WINDOW_MS, FLING_TAU, FLING_MAX_PX, MIN_W, MAX_W, ASPECT,
  }
})
