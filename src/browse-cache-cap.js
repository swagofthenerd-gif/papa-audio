'use strict'

// Keeping the Soulseek browse cache to a size the main thread can afford.
//
// The cap counted USERS — twenty of them — which on a real machine never fired:
// six users had accumulated 173 MB, one peer alone being 102 MB. A peer's share
// is a whole file tree, so "how many users" says nothing about how big the
// cache is.
//
// The cost is not disk. The SideStore serialises on every write, and measured
// against the real file that is 713 ms of JSON.stringify on the main process
// thread — the same thread that drives mpv's IPC socket and every video
// handler. Add 333 ms to read it and 772 ms to parse it, and a single browse of
// a large peer stalls the whole app for over a second.
//
// So the cap is bytes, evicting oldest-first until it fits. A single entry
// larger than the whole budget is still kept — it is what the user just asked
// for, and refusing to cache it would mean re-fetching that peer every time —
// but it is kept ALONE, so the 102 MB peer can never sit alongside the 32 MB
// one.

// 24 MB of cached browse trees. At roughly 100 ms of stringify per 24 MB this
// keeps the write cost inside a couple of frames rather than a second.
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024

function sizeOf(value) {
  try { return JSON.stringify(value).length } catch (_) { return 0 }
}

// Trim `map` to fit `maxBytes`, dropping the least recently cached first.
// Returns { map, evicted, bytes } — `map` is a new object, never the input.
function capByBytes(map, maxBytes = DEFAULT_MAX_BYTES, keepKey = null) {
  const out = (map && typeof map === 'object' && !Array.isArray(map)) ? { ...map } : {}
  const evicted = []

  const sizes = new Map()
  let total = 0
  for (const k of Object.keys(out)) {
    const n = sizeOf(out[k])
    sizes.set(k, n)
    total += n
  }
  if (total <= maxBytes) return { map: out, evicted, bytes: total }

  // Oldest first. A missing cachedAt sorts oldest, because an entry we cannot
  // date is the one we can least justify keeping.
  const order = Object.keys(out).sort((a, b) => {
    const ta = (out[a] && out[a].cachedAt) || 0
    const tb = (out[b] && out[b].cachedAt) || 0
    return ta - tb
  })

  for (const k of order) {
    if (total <= maxBytes) break
    // Never evict the entry that was just written — that is the one the user is
    // looking at, and dropping it would re-fetch the peer immediately.
    if (k === keepKey) continue
    total -= sizes.get(k) || 0
    delete out[k]
    evicted.push(k)
  }

  return { map: out, evicted, bytes: total }
}

module.exports = { capByBytes, sizeOf, DEFAULT_MAX_BYTES }
