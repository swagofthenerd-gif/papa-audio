// Cover-art prefetch planning for the record shop. Pure: it takes parsed shelves
// (from slsk-shelves.buildShelves) and answers one question — "in what order
// should I background-fetch covers so the shelves a shopper actually looks at
// fill in first?" No DOM, no IPC, no window; the renderer owns the actual fetch
// pump and the IntersectionObserver. This module only decides ORDER and DEDUPES,
// so the ordering, the dedupe and the negative-cache accounting are unit-testable
// without a browser.
//
// Priority, briefed by the user: the Upgrades shelf first (the cards a collector
// opened the shop to see), then the first rows of Missing, then everything else
// in shelf order. Within that, every album identity appears once — the same
// {artist, album} held under three folders is one cover fetch, not three.

// The identity key a cover is cached under. Mirrors the renderer's artKey:
// normalise artist+album so "The Beatles — Abbey Road" and "beatles abbey road"
// collapse to one fetch. `normKey` is injected (slsk-shelves.normKey in the app,
// a stub in tests) so this module carries no dependency on that module's window
// binding and stays trivially testable.
function artKeyOf(album, normKey) {
  const a = album || {}
  const raw = `${a.artist || ''} ${a.album || ''}`
  return normKey ? normKey(raw) : raw.toLowerCase().replace(/\s+/g, ' ').trim()
}

// Build the ordered, de-duplicated prefetch plan from parsed shelves.
//
//   shelves   — { upgrades, missing, surround, hires, everything } (any may be
//               absent/empty); each entry is a parsed album with artist/album.
//   opts.normKey        — identity normaliser (see above).
//   opts.missingFirst   — how many Missing-shelf rows count as "first rows" and
//                         therefore jump ahead of the rest (default 12).
//   opts.hasLocalArt    — optional (album) => boolean; albums whose cover the
//                         local library already supplies are skipped (no fetch).
//   opts.alreadyCached  — optional (artKey) => boolean; identities already in the
//                         session/disk cache are skipped (nothing to fetch).
//
// Returns an array of { key, artist, album } in fetch order, each key unique.
function planArtPrefetch(shelves, opts) {
  const o = opts || {}
  const normKey = o.normKey || null
  const missingFirst = Number.isFinite(o.missingFirst) ? o.missingFirst : 12
  const hasLocalArt = typeof o.hasLocalArt === 'function' ? o.hasLocalArt : null
  const alreadyCached = typeof o.alreadyCached === 'function' ? o.alreadyCached : null
  const s = shelves || {}

  const missing = Array.isArray(s.missing) ? s.missing : []
  // Priority sequence: Upgrades, then the first N Missing, then the rest of the
  // shelves in the order they read on screen (remaining Missing, Surround,
  // Hi-Res, then the full Everything grid as the long tail).
  const sequence = []
  const pushAll = (list) => { for (const a of (list || [])) sequence.push(a) }
  pushAll(s.upgrades)
  pushAll(missing.slice(0, missingFirst))
  pushAll(missing.slice(missingFirst))
  pushAll(s.surround)
  pushAll(s.hires)
  pushAll(s.everything)

  const seen = new Set()
  const plan = []
  for (const a of sequence) {
    if (!a) continue
    // Nothing fetchable to key on: skip rather than emit a blank-keyed job.
    if (!a.artist && !a.album) continue
    if (hasLocalArt && hasLocalArt(a)) continue
    const key = artKeyOf(a, normKey)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    if (alreadyCached && alreadyCached(key)) continue
    plan.push({ key, artist: a.artist || '', album: a.album || '' })
  }
  return plan
}

// A tiny session negative-cache: remember identities iTunes had no cover for so
// the prefetch (and the visible-first observer) never re-ask for the same miss.
// The renderer's shArtCache already stores '' for a miss, so this is really an
// accounting helper the tests can exercise in isolation and the renderer can
// reuse for a clean predicate. `store` is any Map-like ({ has, get, set }).
function shouldFetchArt(store, key) {
  if (!key) return false
  if (!store || typeof store.has !== 'function') return true
  if (!store.has(key)) return true
  // A stored value: '' (or any falsy) is a recorded miss — don't refetch. A
  // truthy value is a hit already painted — also nothing to fetch.
  return false
}

const artPrefetchApi = { planArtPrefetch, artKeyOf, shouldFetchArt }
if (typeof module !== 'undefined' && module.exports) module.exports = artPrefetchApi
if (typeof window !== 'undefined') window.PapaSlskArtPrefetch = artPrefetchApi
