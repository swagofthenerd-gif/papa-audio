'use strict'

// Which of these files are still on disk.
//
// Both video list handlers did this with a synchronous `fs.statSync` per entry,
// on the main process thread — the same thread that drives mpv's IPC socket and
// every other handler. Fine at five entries; a visible stall at a few hundred,
// and far worse on a network mount where a single stat can block for as long as
// the mount takes to answer. The On Device page re-renders on every download
// event, so this ran constantly.
//
// Statting in parallel does not make any single stat faster; it stops them
// being serialised, and — because these are promises — it stops them blocking
// the event loop at all.

// Returns { alive, missing } preserving input order. Never throws: an entry
// that cannot be statted counts as missing, which is the same answer the
// synchronous version gave, so pruning behaviour is unchanged.
async function partitionAlive(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : []
  const stat = opts.stat || require('fs').promises.stat
  const pathOf = opts.pathOf || (e => e && e.path)

  const results = await Promise.all(list.map(async e => {
    const p = pathOf(e)
    if (!e || !p) return false
    try {
      const st = await stat(p)
      return !!(st && typeof st.isFile === 'function' ? st.isFile() : false)
    } catch (_) {
      return false
    }
  }))

  const alive = []
  const missing = []
  for (let i = 0; i < list.length; i++) (results[i] ? alive : missing).push(list[i])
  return { alive, missing }
}

module.exports = { partitionAlive }
