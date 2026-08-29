'use strict';
// Watch state, watchlist, skip segments and per-show preferences, in one
// persisted blob behind a synchronous namespace the UI reads directly.
//
// The schema is §16 of docs/papa-video-plan.md:
//   { items:     { "movie:27205" | "tv:1396:s1e2": { type, id, title, poster,
//                 position, duration, watched, updatedAt, source, … } },
//     watchlist: [ { type, id, title, poster, addedAt } ],
//     skip:      { "tv:1396:s1": Segment[] },
//     prefs:     { "tv:1396": { autoSkipIntro, autoSkipCredits, autoNext, … } } }
//
// Watched means the file reached ≥90%; anything under 2% is not "in progress"
// and so never shows up in Continue Watching.
//
// Persistence goes through an injectable `storage` adapter ({ read, write }) so
// the logic is fully testable without localStorage. The renderer's default
// adapter reads/writes through window.PapaLocal, the one validated localStorage
// reader in the app; tests inject an in-memory adapter.
//
// UMD-wrapped like ttl-cache.js so it loads as a classic script without leaking
// top-level bindings into the shared renderer scope.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaVideoStore = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const KEY = 'papa-video-store'

  const WATCHED_AT = 0.9
  const MIN_PROGRESS = 0.02

  function _empty() {
    return { items: {}, watchlist: [], skip: {}, prefs: {} }
  }

  // The renderer storage. PapaLocal is loaded first (local-store.js precedes this
  // in index.html), so the readObject/write pair is what survives quota failures
  // and private windows without throwing into the caller.
  function _browserStorage() {
    return {
      read() {
        try {
          return (typeof window !== 'undefined' && window.PapaLocal)
            ? window.PapaLocal.readObject(KEY)
            : null
        } catch (_) { return null }
      },
      write(value) {
        try {
          if (typeof window !== 'undefined' && window.PapaLocal) return window.PapaLocal.write(KEY, value)
          return false
        } catch (_) { return false }
      },
    }
  }

  // Test / Node storage: one blob in memory, inspectable via _dump.
  function _memoryStorage(seed) {
    let value = seed === undefined ? null : seed
    return {
      read: () => value,
      write: v => { value = v; return true },
      _dump: () => value,
    }
  }

  function createVideoStore({ storage, now } = {}) {
    const backend = storage || (typeof window !== 'undefined' ? _browserStorage() : _memoryStorage())
    const clock = typeof now === 'function' ? now : () => Date.now()

    let cache = null
    function load() {
      if (cache !== null) return cache
      cache = _sanitize(backend.read())
      return cache
    }
    function save() {
      backend.write(cache)
    }

    // A corrupt or wrong-shaped blob must not take down a render — every field
    // is read defensively and replaced by its default when it is not the right
    // shape.
    function _sanitize(raw) {
      const base = _empty()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
      if (raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) base.items = raw.items
      if (Array.isArray(raw.watchlist)) base.watchlist = raw.watchlist
      if (raw.skip && typeof raw.skip === 'object' && !Array.isArray(raw.skip)) base.skip = raw.skip
      if (raw.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs)) base.prefs = raw.prefs
      return base
    }

    function ratio(item) {
      const pos = Number(item && item.position) || 0
      const dur = Number(item && item.duration) || 0
      return dur > 0 ? pos / dur : 0
    }

    function get(key) {
      return load().items[key] || null
    }

    // Upserts the item identified by `key`, merging `meta` (the identifying and
    // display fields) over whatever was already saved for it. Records the
    // position, recomputes `watched`, and stamps `updatedAt` so Continue Watching
    // orders by most-recent.
    function setPosition(key, meta, position, duration) {
      const state = load()
      const prev = state.items[key] || {}
      const pos = Number(position) || 0
      const dur = Number(duration) || 0
      const item = {
        ...prev,
        ...(meta && typeof meta === 'object' ? meta : {}),
        position: pos,
        duration: dur,
        watched: dur > 0 && pos / dur >= WATCHED_AT,
        updatedAt: clock(),
      }
      state.items[key] = item
      save()
      return item
    }

    function markWatched(key) {
      const state = load()
      const prev = state.items[key] || {}
      const item = { ...prev, watched: true, updatedAt: clock() }
      state.items[key] = item
      save()
      return item
    }

    function _inProgress(item) {
      if (!item || item.watched) return false
      const dur = Number(item.duration) || 0
      if (dur <= 0) return false
      return ratio(item) >= MIN_PROGRESS
    }

    function _newest(list, limit) {
      const sorted = list.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      return typeof limit === 'number' && limit > 0 ? sorted.slice(0, limit) : sorted
    }

    function continueWatching(limit) {
      return _newest(Object.values(load().items).filter(_inProgress), limit)
    }

    function watchlist() {
      return load().watchlist.slice()
    }

    // Adds when absent, removes when present. Returns the new list so the caller
    // can re-render without a second read.
    function toggleWatchlist(item) {
      const state = load()
      const type = item && item.type
      const id = item && item.id
      const idx = state.watchlist.findIndex(w => w.type === type && w.id === id)
      if (idx >= 0) {
        state.watchlist.splice(idx, 1)
      } else if (type != null && id != null) {
        state.watchlist.push({
          type,
          id,
          title: (item && item.title) ?? null,
          poster: (item && item.poster) ?? null,
          addedAt: clock(),
        })
      }
      save()
      return state.watchlist.slice()
    }

    function inWatchlist(type, id) {
      return load().watchlist.some(w => w.type === type && w.id === id)
    }

    // Watched items, newest first. This is the History view.
    function history(limit) {
      return _newest(Object.values(load().items).filter(it => it.watched === true), limit)
    }

    function prefs(showKey) {
      return { ...(load().prefs[showKey] || {}) }
    }

    function setPrefs(showKey, patch) {
      const state = load()
      const next = { ...(state.prefs[showKey] || {}), ...(patch && typeof patch === 'object' ? patch : {}) }
      state.prefs[showKey] = next
      save()
      return { ...next }
    }

    function skip(seasonKey) {
      return Array.isArray(load().skip[seasonKey]) ? load().skip[seasonKey].slice() : []
    }

    function setSkip(seasonKey, segments) {
      const state = load()
      state.skip[seasonKey] = Array.isArray(segments) ? segments.slice() : []
      save()
      return state.skip[seasonKey].slice()
    }

    // Test/debug hooks. Not part of the §4.4 surface the UI relies on.
    function _dump() {
      return JSON.parse(JSON.stringify(load()))
    }
    function _reset() {
      cache = null
      backend.write(_empty())
    }

    return {
      get, setPosition, markWatched,
      continueWatching, watchlist, toggleWatchlist, inWatchlist, history,
      prefs, setPrefs, skip, setSkip,
      _dump, _reset,
    }
  }

  // The §4.4 surface: the default instance's methods, plus the factory and the
  // constants the tests and later phases reach for.
  const singleton = createVideoStore()
  const api = {
    ...singleton,
    createVideoStore,
    _memoryStorage,
    WATCHED_AT,
    MIN_PROGRESS,
  }

  return api
})
