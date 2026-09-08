// Manage-tab result cache.
//
// The tools measure slowly (Storage walks every folder, duplicates and health
// fold the whole library). Recomputing on every visit is what made the tab feel
// heavy and made the dashboard impossible. This caches each tool's last result
// keyed by a library signature, so a revisit paints instantly from the cache and
// only recomputes when the library actually changed.
//
// The pure staleness logic lives here and is tested without any store. The store
// itself is injected: in the app it is a thin wrapper over a main-process
// SideStore (survives restarts); in tests it is a plain object.

;(function () {
  // A cache entry is { sig, at, value }. It is FRESH for a given library
  // signature only when the stored signature matches — a changed library means
  // the numbers are stale no matter how recently they were computed. A max age
  // is a secondary guard so a long-lived session eventually refreshes even if
  // the signature machinery ever missed a change.
  var DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000 // a day

  function isFresh(entry, sig, now, maxAgeMs) {
    if (!entry || typeof entry !== 'object') return false
    if (entry.sig !== sig) return false
    var age = Number(now) - Number(entry.at)
    if (!isFinite(age)) return false
    var cap = maxAgeMs != null ? maxAgeMs : DEFAULT_MAX_AGE_MS
    return age >= 0 && age <= cap
  }

  function makeEntry(value, sig, now) {
    return { sig: sig, at: Number(now) || 0, value: value }
  }

  // Read a fresh value for `key` (e.g. 'storage', 'duplicates') from a cache map,
  // or null when missing/stale. `map` is the whole { key: entry } object.
  function readFresh(map, key, sig, now, maxAgeMs) {
    var entry = map && map[key]
    return isFresh(entry, sig, now, maxAgeMs) ? entry.value : null
  }

  // Return a NEW map with `key` set to a fresh entry. Pure — never mutates the
  // input — so a caller can persist the result atomically.
  function withValue(map, key, value, sig, now) {
    var out = {}
    var src = map && typeof map === 'object' ? map : {}
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k]
    out[key] = makeEntry(value, sig, now)
    return out
  }

  // ── Renderer store wrapper ────────────────────────────────────────────────
  // Wraps window.api.manageCacheGet/Set (main-process SideStore) with an
  // in-memory copy so reads are synchronous and writes are fire-and-forget. Falls
  // back to PapaLocal (localStorage) if the IPC is unavailable, so the cache
  // still works in a degraded build. DOM-free; only constructed in the renderer.
  function createStore(deps) {
    deps = deps || {}
    var api = deps.api || (typeof window !== 'undefined' ? window.api : null)
    var local = deps.local || (typeof window !== 'undefined' ? window.PapaLocal : null)
    var LKEY = 'papa.manageCache'
    var mem = null

    function _loadSync() {
      if (mem) return mem
      // Prefer the last snapshot localStorage holds (synchronous); the IPC value
      // hydrates it asynchronously via load().
      if (local) { try { mem = local.readObject(LKEY) || {} } catch (_) { mem = {} } }
      else mem = {}
      return mem
    }

    // Pull the persisted map from the main-process store once at startup.
    async function load() {
      if (api && api.manageCacheGet) {
        try {
          var v = await api.manageCacheGet()
          if (v && typeof v === 'object') mem = v
        } catch (_) { /* keep whatever _loadSync had */ }
      }
      return _loadSync()
    }

    function get(key, sig, now) {
      return readFresh(_loadSync(), key, sig, now != null ? now : Date.now())
    }

    function put(key, value, sig, now) {
      mem = withValue(_loadSync(), key, value, sig, now != null ? now : Date.now())
      if (api && api.manageCacheSet) { try { api.manageCacheSet(mem) } catch (_) {} }
      else if (local) { try { local.write(LKEY, mem) } catch (_) {} }
      return mem
    }

    return { load: load, get: get, put: put }
  }

  var API = {
    DEFAULT_MAX_AGE_MS: DEFAULT_MAX_AGE_MS,
    isFresh: isFresh,
    makeEntry: makeEntry,
    readFresh: readFresh,
    withValue: withValue,
    createStore: createStore,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.PapaManageCache = API
})()
