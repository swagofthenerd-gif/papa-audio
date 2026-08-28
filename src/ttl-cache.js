'use strict';
// A Map with a TTL and a hard cap, because three places in this app needed
// exactly that and each got it wrong differently: main's search cache and
// YouTube URL cache both evict only EXPIRED entries when over the cap, so a run
// of distinct keys inside the TTL grows without limit (1000 distinct searches
// leave 1000 entries, each holding a whole search response); the renderer's
// _cacheGet/_cacheSet pair had the LRU right and no TTL at all.
//
// Insertion order is the LRU order: Map preserves it, and a re-set deletes
// first, so the oldest key is always keys().next().
//
// Loaded by main via require and by the renderer as a classic script, so it
// attaches to window when there is no module system.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaTtlCache = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function makeCache(opts) {
    opts = opts || {}
    const cap = Number(opts.cap) > 0 ? Number(opts.cap) : 200
    const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : 0
    // Injectable so a test can advance time without sleeping.
    const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now() }
    const map = new Map()

    // A per-entry expiry wins over the uniform TTL. The YouTube URL cache needs
    // this: googlevideo URLs carry their own `expire`, which is often sooner
    // than any TTL we would pick.
    function expired(entry) {
      if (entry.expiresAt != null) return now() >= entry.expiresAt
      return ttlMs > 0 && now() - entry.ts > ttlMs
    }

    function get(key) {
      if (!map.has(key)) return undefined
      const entry = map.get(key)
      if (expired(entry)) { map.delete(key); return undefined }
      // Touch: re-inserting moves it to the end, so it is the last evicted.
      map.delete(key)
      map.set(key, entry)
      return entry.value
    }

    function set(key, value, entryOpts) {
      map.delete(key)
      const expiresAt = entryOpts && entryOpts.expiresAt != null ? Number(entryOpts.expiresAt) : null
      map.set(key, { value: value, ts: now(), expiresAt: expiresAt })
      // Expired first -- they are worthless -- and only then the oldest live
      // entries. This second loop is the part main was missing.
      if (map.size > cap) {
        for (const [k, v] of map) {
          if (map.size <= cap) break
          if (expired(v)) map.delete(k)
        }
        while (map.size > cap) map.delete(map.keys().next().value)
      }
      return value
    }

    function has(key) { return get(key) !== undefined }
    function del(key) { return map.delete(key) }
    function clear() { map.clear() }
    // Live entries only: a caller listing the cache must not see expired ones.
    function keys() {
      const out = []
      for (const [k, v] of map) if (!expired(v)) out.push(k)
      return out
    }
    function values() {
      const out = []
      for (const [, v] of map) if (!expired(v)) out.push(v.value)
      return out
    }
    // Drops expired entries. Worth calling on a timer for a cache that is
    // written rarely and read rarely, where nothing else triggers eviction.
    function sweep() {
      let dropped = 0
      for (const [k, v] of map) if (expired(v)) { map.delete(k); dropped++ }
      return dropped
    }

    return {
      get: get, set: set, has: has, delete: del, clear: clear,
      keys: keys, values: values, sweep: sweep,
      get size() { return map.size },
      get cap() { return cap },
      get ttlMs() { return ttlMs },
    }
  }

  return { makeCache: makeCache }
})
