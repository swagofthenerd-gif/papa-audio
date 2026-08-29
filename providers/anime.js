'use strict'
// Direct-stream (HTTP) provider adapter for anime.
//
// Same adapter contract as `providers/movie-tv.js`: run an injectable list of
// `resolvers` and merge their entries, wrapping each in try/catch so a dead
// resolver is silently skipped. The anime adapter additionally coerces each
// raw result through `normalizeHttpEntry` so `sub`/`dub` (tagged by anime
// resolvers such as gogoanime/Consumet) always land on the entry as booleans.

const { normalizeHttpEntry } = require('./movie-tv')

function createAnimeProvider({ fetchFn, resolvers = [] } = {}) {
  void fetchFn // resolvers own their I/O; `fetchFn` accepted for interface parity
  const list = Array.isArray(resolvers) ? resolvers : []
  return async function animeProvider(request) {
    request = request || {}
    const entries = []
    for (const resolver of list) {
      if (typeof resolver !== 'function') continue
      try {
        const result = await resolver(request)
        if (!Array.isArray(result)) continue
        for (const raw of result) {
          if (!raw || typeof raw !== 'object') continue
          entries.push(normalizeHttpEntry(raw))
        }
      } catch (_err) {
        // dead resolver — skip
      }
    }
    return entries
  }
}

module.exports = {
  normalizeHttpEntry,
  createAnimeProvider,
}
