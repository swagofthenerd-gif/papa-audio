'use strict'
// Memory ceiling watchdog — pure logic (roadmap #63).
//
// A long session slowly grows the renderer's heap: art caches, virtualised
// lists, the video store. Left alone it eventually crosses a size where the OS
// starts to hurt. This is the arithmetic that decides when to warn — kept pure
// and out of main.js so the ring buffer and the two-in-a-row threshold can be
// tested without a live app, a real webContents, or a five-minute wait.
//
// The design is deliberately quiet: main samples every five minutes, feeds each
// sample here, and this returns whether a pressure event should fire. It fires
// only when the renderer's RSS crosses the ceiling on two *consecutive* samples
// — one spike (a big paste, a momentary decode) is not a leak, and warning on it
// would cry wolf. Once it has fired it stays latched until RSS drops back under
// the ceiling, so the renderer is told once per episode of pressure, not every
// five minutes for the rest of the session.

// The renderer RSS ceiling, in bytes. 1.5 GB is the contract figure: comfortably
// above a heavy-but-healthy session on this machine, below the point the OS
// starts swapping the app.
const DEFAULT_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024
// How many samples the ring keeps for papaMemoryStats(). Twelve five-minute
// samples is one hour of history, which is enough to see a trend without holding
// anything.
const DEFAULT_RING_SIZE = 12
// How many consecutive over-ceiling samples arm the warning. Two means one
// transient spike is ignored; the second confirms it.
const DEFAULT_CONSECUTIVE = 2

// A fixed-length ring of the most recent samples. push() returns the current
// contents oldest-first, which is the order papaMemoryStats() reports.
function createRing(size) {
  const cap = Number(size) > 0 ? Math.floor(Number(size)) : DEFAULT_RING_SIZE
  const buf = []
  return {
    push(sample) {
      buf.push(sample)
      while (buf.length > cap) buf.shift()
      return buf.slice()
    },
    toArray() { return buf.slice() },
    get size() { return buf.length },
    get capacity() { return cap },
  }
}

// The stateful decision-maker. Feed it one sample at a time; it tracks the run
// of consecutive over-ceiling samples and the latch, and tells the caller
// exactly when to emit. Pure in the sense that it touches nothing outside
// itself — no timers, no IPC, no clock.
function createWatchdog(opts = {}) {
  const threshold = Number(opts.thresholdBytes) > 0
    ? Number(opts.thresholdBytes) : DEFAULT_THRESHOLD_BYTES
  const consecutive = Number(opts.consecutive) > 0
    ? Math.floor(Number(opts.consecutive)) : DEFAULT_CONSECUTIVE
  const ring = createRing(opts.ringSize)

  // How many of the most recent samples in a row were over the ceiling.
  let run = 0
  // True once a pressure event has fired and RSS has not yet come back under the
  // ceiling. Stops the event repeating every sample while pressure persists.
  let latched = false

  // Feed one sample. `sample` carries at least { rendererRss }, plus whatever
  // else main wants kept in history (main rss, timestamp). Returns:
  //   { pressure, rendererRss, run, ring }
  // where `pressure` is true only on the sample that should emit the event.
  function observe(sample) {
    const s = sample && typeof sample === 'object' ? sample : {}
    const rss = Number(s.rendererRss) || 0
    const over = rss > threshold
    if (over) {
      run++
    } else {
      run = 0
      // Coming back under the ceiling clears the latch, so a later relapse can
      // warn again.
      latched = false
    }
    // Fire on the sample that reaches the consecutive count, and only if not
    // already latched from a run that already fired.
    const pressure = over && run >= consecutive && !latched
    if (pressure) latched = true
    const contents = ring.push(s)
    return { pressure, rendererRss: rss, over, run, ring: contents }
  }

  return {
    observe,
    // Inspection surface for papaMemoryStats() and tests.
    get thresholdBytes() { return threshold },
    get consecutive() { return consecutive },
    samples() { return ring.toArray() },
    _run() { return run },
    _latched() { return latched },
  }
}

module.exports = {
  createRing,
  createWatchdog,
  DEFAULT_THRESHOLD_BYTES,
  DEFAULT_RING_SIZE,
  DEFAULT_CONSECUTIVE,
}
