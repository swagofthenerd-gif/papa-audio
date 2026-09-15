'use strict'
// The rewatch cache (2026-09-14): an episode or film that finished
// downloading is kept on disk in a bounded store, so watching it again — or
// seeking through it — is a local file, instant. Pure policy here: what to
// evict and when an entry counts. The wiring (directories, renames, IPC)
// lives in main.js and is pinned by test/video-device.test.js.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaVideoCache = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Least-recently-WATCHED first: savedAt seeds the clock, a replay updates
  // lastUsedAt, and the entry being added must fit after the evictions.
  // Returns the entries to delete, oldest first; an empty list when the new
  // file already fits. capBytes <= 0 means the cache is off: everything
  // (including the newcomer, signalled by ok:false) goes.
  // `protectKeys` (V123): entries that must never be evicted — the file that
  // is playing right now. If the newcomer cannot fit without touching one,
  // the newcomer is refused (ok:false) rather than the viewer's picture
  // vanishing from under them. Kept-for-offline files live in their own
  // store and are never in this list at all.
  function evictPlan(entries, capBytes, addBytes, protectKeys) {
    const cap = Number(capBytes) || 0
    const add = Math.max(0, Number(addBytes) || 0)
    const protect = new Set((Array.isArray(protectKeys) ? protectKeys : []).filter(Boolean))
    const list = (Array.isArray(entries) ? entries : []).filter(e => e && e.path)
    if (cap <= 0) return { ok: false, evict: list.filter(e => !protect.has(e.key)) }
    if (add > cap) return { ok: false, evict: [] }   // one file bigger than the whole cache
    const byAge = list.slice().sort((a, b) =>
      (Number(a.lastUsedAt) || Number(a.savedAt) || 0) - (Number(b.lastUsedAt) || Number(b.savedAt) || 0))
    let used = byAge.reduce((n, e) => n + (Number(e.sizeBytes) || 0), 0)
    const evict = []
    const candidates = byAge.filter(e => !protect.has(e.key))
    while (used + add > cap && candidates.length) {
      const gone = candidates.shift()
      used -= Number(gone.sizeBytes) || 0
      evict.push(gone)
    }
    if (used + add > cap) return { ok: false, evict: [], blockedBy: 'protected' }
    return { ok: true, evict }
  }

  // One safe file name from a cache key like "anime:21:null:3": the key is
  // the identity, the extension keeps mpv's demuxer detection cheap.
  function fileNameFor(key, sourceName) {
    const ext = /\.[A-Za-z0-9]{2,4}$/.exec(String(sourceName || ''))
    return String(key).replace(/[^A-Za-z0-9]+/g, '_') + (ext ? ext[0].toLowerCase() : '.mkv')
  }

  return { evictPlan, fileNameFor, GB: 1024 * 1024 * 1024 }
})
