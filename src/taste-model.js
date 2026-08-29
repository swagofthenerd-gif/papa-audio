'use strict'
// What this listener actually returns to, derived from their own history.
// Pure: no disk, no clock of its own -- `now` is always passed in so tests
// are not time-dependent.

const { normaliseHistory } = require('../history')

const HALF_LIFE_DAYS = 120
const LIKED_BOOST = 1.4
const DAY = 86400000

function buildAffinity({ history = [], playCounts = {}, likedTracks = [], now = Date.now() } = {}) {
  // Through normaliseHistory, never raw entry.ts: 463 of the 1,097 entries in
  // this library were written under the old `timestamp` key and are invisible
  // to a direct read.
  const { entries } = normaliseHistory(history, { now })

  const lastPlayed = new Map()
  const historyCount = new Map()
  for (const e of entries) {
    const prev = lastPlayed.get(e.filePath) || 0
    if (e.ts > prev) lastPlayed.set(e.filePath, e.ts)
    historyCount.set(e.filePath, (historyCount.get(e.filePath) || 0) + 1)
  }

  const liked = new Set(likedTracks || [])
  const paths = new Set([...Object.keys(playCounts || {}), ...lastPlayed.keys()])

  const raw = new Map()
  let max = 0
  for (const p of paths) {
    const countFromPlayCounts = Math.max(0, Number(playCounts[p]) || 0)
    const countFromHistory = historyCount.get(p) || 0
    const count = countFromPlayCounts || countFromHistory
    // log damping: 40 plays is worth more than 2, but not twenty times more.
    let score = Math.log1p(count)
    const last = lastPlayed.get(p)
    if (last) {
      const ageDays = Math.max(0, (now - last) / DAY)
      score *= Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
    } else {
      score *= 0.5
    }
    if (liked.has(p)) score *= LIKED_BOOST
    if (score > 0) {
      raw.set(p, score)
      if (score > max) max = score
    }
  }

  const out = new Map()
  for (const [p, s] of raw) out.set(p, Math.min(1, s))
  return out
}

module.exports = { buildAffinity, HALF_LIFE_DAYS, LIKED_BOOST }
