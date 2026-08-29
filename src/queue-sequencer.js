'use strict'
// Ordering, which is what separates a curated queue from a bag of good tracks.
//
// Selection decides WHAT plays; this decides IN WHAT ORDER. Without it the
// queue slams a quiet acoustic piece into a heavy one and plays three albums by
// the same artist back to back.

const { distance } = require('./audio-features')

const ZERO = { energy: 0, brightness: 0, dynamics: 0, density: 0, punch: 0 }

function sequence(candidates, { vectors = new Map(), artistGap = 3, albumGap = 5 } = {}) {
  const pool = [...(candidates || [])]
  if (pool.length <= 1) return pool

  const vecOf = t => vectors.get(t.filePath) || ZERO
  const out = []

  // Start from the least energetic track so the queue has somewhere to rise to.
  let startIdx = 0
  for (let i = 1; i < pool.length; i++) {
    if (vecOf(pool[i]).energy < vecOf(pool[startIdx]).energy) startIdx = i
  }
  out.push(pool.splice(startIdx, 1)[0])

  const tooClose = (track, gap, key) => {
    // Look back gap-1 entries, not gap. Placing at index i with the same artist
    // at i-gap is a gap of exactly `gap` and is allowed; scanning `gap` entries
    // would reject it and silently enforce gap+1.
    const limit = Math.min(gap - 1, out.length)
    for (let i = 1; i <= limit; i++) {
      const prev = out[out.length - i]
      if (prev && track[key] && prev[key] === track[key]) return true
    }
    return false
  }

  while (pool.length) {
    const last = out[out.length - 1]

    // Prefer the artist with the most tracks still waiting. Taking the nearest
    // candidate instead defers a crowded artist until only its own tracks are
    // left, and then has to place them adjacent -- the trap that put Pink Floyd
    // at 6 and 8. Distance only breaks ties.
    const remaining = new Map()
    for (const t of pool) remaining.set(t.artist, (remaining.get(t.artist) || 0) + 1)

    let best = -1, bestRemaining = -1, bestDistance = Infinity
    let relaxed = -1, relaxedDistance = Infinity

    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]
      const d = distance(vecOf(last), vecOf(cand))
      const blocked = tooClose(cand, artistGap, 'artist') || tooClose(cand, albumGap, 'albumId')
      if (!blocked) {
        const r = remaining.get(cand.artist) || 0
        if (r > bestRemaining || (r === bestRemaining && d < bestDistance)) {
          bestRemaining = r; bestDistance = d; best = i
        }
      }
      if (d < relaxedDistance) { relaxedDistance = d; relaxed = i }
    }

    // When everything left violates spacing -- a pool that is all one artist --
    // relax the rule rather than dropping tracks. A shorter queue is a worse
    // failure than a repeated artist.
    const pick = best >= 0 ? best : relaxed
    out.push(pool.splice(pick, 1)[0])
  }

  return out
}

module.exports = { sequence }
