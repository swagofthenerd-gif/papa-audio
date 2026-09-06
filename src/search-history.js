'use strict';
// Soulseek search-result persistence (App roadmap #53). The last handful of
// searches are kept across restarts so a repeat search can serve its previous
// results INSTANTLY (fromCache) while a live search revalidates in the
// background — the stale-while-revalidate shape the browse cache already uses.
//
// This module is the pure list logic over the persisted array, so the newest-
// first ordering, the entry cap and the total-size cap are all testable with no
// disk. The stored shape is an array of:
//   { key, query, results, at }
// newest first. `key` is the normalized query (lower-cased, trimmed) so a lookup
// is exact; `results` is the RAW normalized response list, never DOM.
//
// Two caps, whichever bites first:
//   MAX_ENTRIES — at most this many searches remembered (~20);
//   MAX_BYTES   — the whole array's serialized size stays under ~2 MB, trimming
//                 the oldest entries until it fits, because one huge search must
//                 not evict everything nor blow the file up.
//
// UMD-wrapped like the other pure modules.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaSearchHistory = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const MAX_ENTRIES = 20
  const MAX_BYTES = 2 * 1024 * 1024 // ~2 MB for the whole persisted array

  function _norm(query) {
    return query == null ? '' : String(query).toLowerCase().trim()
  }

  // The persisted list, defensively coerced to a clean newest-first array.
  function _list(state) {
    return Array.isArray(state) ? state.filter(e => e && typeof e === 'object' && e.key) : []
  }

  // The stored results for a query, or null when nothing is remembered.
  function get(state, query) {
    const key = _norm(query)
    if (!key) return null
    const hit = _list(state).find(e => e.key === key)
    return hit ? hit.results : null
  }

  // The full remembered entry (with its `at` timestamp), or null. Lets the
  // caller show how stale the served copy is.
  function getEntry(state, query) {
    const key = _norm(query)
    if (!key) return null
    return _list(state).find(e => e.key === key) || null
  }

  // Trim the array to both caps: first the entry count, then the byte budget by
  // dropping the oldest (tail) until the serialized whole fits. Always returns a
  // new array. A single entry that alone exceeds the budget is still kept — an
  // empty cache serves nobody — but everything after it is dropped.
  function _capped(list) {
    let out = list.slice(0, MAX_ENTRIES)
    while (out.length > 1 && JSON.stringify(out).length > MAX_BYTES) {
      out = out.slice(0, out.length - 1)
    }
    return out
  }

  // Upsert a search's results, moving it to the front (newest). Returns a NEW,
  // capped array; the caller persists it. An empty query or empty results is a
  // no-op — there is nothing worth remembering, and a blank result would just
  // mask a later good one.
  function put(state, query, results, nowMs) {
    const key = _norm(query)
    if (!key) return _list(state)
    if (!Array.isArray(results) || results.length === 0) return _list(state)
    const entry = { key, query: String(query), results, at: Number(nowMs) || 0 }
    const rest = _list(state).filter(e => e.key !== key)
    return _capped([entry, ...rest])
  }

  return {
    get,
    getEntry,
    put,
    MAX_ENTRIES,
    MAX_BYTES,
  }
})
