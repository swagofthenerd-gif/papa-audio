'use strict'
// One search memory for the whole app (roadmap J2).
//
// Before this module the app kept three disjoint recent-search lists — the
// music search bar (`pa_search_history`), the library page
// (`papa-lib-recent-searches`) and Movies & TV (`papaVideoRecentSearches`) —
// with three shapes, three caps and three commit rules. A search typed on one
// surface was invisible on the others, and the user's honest complaint was
// "there is no history of my recent searches".
//
// This is the single store behind every search box. One entry per distinct
// query (case/whitespace-insensitive), newest first:
//
//   { q, key, ts, n, surfaces: { music: ts, video: ts, ... }, opened: [...] }
//
//   q        the spelling the user last typed
//   key      the normalized identity (lower-cased, whitespace-collapsed)
//   ts       the latest commit, on any surface
//   n        how many times it has been committed
//   surfaces which boxes it was committed on, each with its own latest time —
//            so a box can show its own recents first and the others after
//   opened   what the user opened from this search (album, track, film…),
//            newest first, capped — the seed of the journey trail (J4)
//
// Commit rule, everywhere: a search is remembered when it is ACTED ON (Enter,
// a result click), never on a debounce tick. That is what kills the verified
// prefix junk ("transf", "knight of") and the verified under-capture.
//
// Pure list logic first (testable with no DOM, no storage), then a small
// store factory that binds the list to a key/value io and migrates the three
// legacy lists on first use. Named-global export like the other shared pure
// modules (smart-query.js, library-index.js).

var _PapaSearchMemory = (function () {

  var STORAGE_KEY = 'papa-search-memory'
  var LEGACY_KEYS = {
    music: 'pa_search_history',
    library: 'papa-lib-recent-searches',
    video: 'papaVideoRecentSearches',
  }
  var SURFACES = ['music', 'library', 'video', 'soulseek']
  var LABELS = { music: 'Search', library: 'Library', video: 'Movies & TV', soulseek: 'Soulseek' }
  var MAX_ENTRIES = 100
  var MAX_OPENED = 5
  // A shorter query committed just before a longer one that starts with it
  // ("tokyo" then "tokyo revengers", within this window) is a half-typed
  // stepping stone, not a search of its own.
  var PREFIX_WINDOW_MS = 10 * 60 * 1000
  // Every search box shares these. Local filtering (the library grid) repaints
  // fast enough to feel live; anything that leaves the machine waits a beat.
  var DEBOUNCE = { local: 150, remote: 300 }

  function keyOf(q) {
    return String(q == null ? '' : q).toLowerCase().replace(/\s+/g, ' ').trim()
  }

  function _clean(q) {
    return String(q == null ? '' : q).replace(/\s+/g, ' ').trim()
  }

  function _isSurface(s) { return SURFACES.indexOf(s) !== -1 }

  function _now(now) { return typeof now === 'number' ? now : Date.now() }

  // Coerce anything persisted into a clean list. A damaged entry is dropped,
  // never a reason to discard the whole memory.
  function sanitize(list) {
    if (!Array.isArray(list)) return []
    var out = []
    var seen = Object.create(null)
    for (var i = 0; i < list.length; i++) {
      var e = list[i]
      if (!e || typeof e !== 'object') continue
      var q = _clean(e.q)
      var key = keyOf(q)
      if (!key || seen[key]) continue
      seen[key] = true
      var surfaces = {}
      if (e.surfaces && typeof e.surfaces === 'object') {
        for (var s in e.surfaces) {
          if (_isSurface(s) && typeof e.surfaces[s] === 'number') surfaces[s] = e.surfaces[s]
        }
      }
      var opened = Array.isArray(e.opened) ? e.opened.filter(function (o) {
        return o && typeof o === 'object' && typeof o.label === 'string' && o.label
      }).slice(0, MAX_OPENED) : []
      out.push({
        q: q,
        key: key,
        ts: typeof e.ts === 'number' ? e.ts : 0,
        n: typeof e.n === 'number' && e.n > 0 ? e.n : 1,
        surfaces: surfaces,
        opened: opened,
      })
    }
    out.sort(function (a, b) { return b.ts - a.ts })
    return out.slice(0, MAX_ENTRIES)
  }

  function _find(list, query) {
    var key = keyOf(query)
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return i
    return -1
  }

  // Remember a search the user acted on. Returns a NEW list, newest first.
  function commit(list, opts) {
    opts = opts || {}
    var q = _clean(opts.query)
    var key = keyOf(q)
    var surface = _isSurface(opts.surface) ? opts.surface : 'music'
    var now = _now(opts.now)
    var out = sanitize(list)
    if (!key) return out
    var at = _find(out, q)
    var entry
    if (at !== -1) {
      entry = out.splice(at, 1)[0]
      entry.q = q
      entry.n += 1
    } else {
      entry = { q: q, key: key, ts: now, n: 1, surfaces: {}, opened: [] }
    }
    entry.ts = now
    entry.surfaces[surface] = now
    // Stepping stones: a same-surface strict prefix committed moments ago.
    out = out.filter(function (e) {
      if (!(surface in e.surfaces)) return true
      if (e.key.length >= key.length || key.indexOf(e.key) !== 0) return true
      if (now - e.surfaces[surface] > PREFIX_WINDOW_MS) return true
      // It was only ever a stepping stone if this surface was its only home.
      return Object.keys(e.surfaces).length > 1 && _stripSurface(e, surface)
    })
    out.unshift(entry)
    return out.slice(0, MAX_ENTRIES)
  }

  // Remove one surface from an entry in place; returns true when the entry
  // still lives somewhere else (so the caller keeps it).
  function _stripSurface(entry, surface) {
    delete entry.surfaces[surface]
    return Object.keys(entry.surfaces).length > 0
  }

  // Forget one query everywhere (the per-row ✕).
  function remove(list, query) {
    var out = sanitize(list)
    var at = _find(out, query)
    if (at !== -1) out.splice(at, 1)
    return out
  }

  // Clear one surface's history (entries that lived only there are dropped),
  // or everything when no surface is given.
  function clear(list, surface) {
    if (!_isSurface(surface)) return []
    return sanitize(list).filter(function (e) {
      if (!(surface in e.surfaces)) return true
      return _stripSurface(e, surface)
    })
  }

  // The user opened something from a search: keep the trail. A query that
  // was never committed (a result clicked straight from a live dropdown) is
  // committed here first, because opening a result IS acting on the search.
  function recordOpen(list, opts) {
    opts = opts || {}
    var item = opts.item
    if (!item || typeof item !== 'object' || !item.label) return sanitize(list)
    var out = commit(list, { query: opts.query, surface: opts.surface, now: opts.now })
    var at = _find(out, opts.query)
    if (at === -1) return out
    var entry = out[at]
    // Opening counts as one act, not a second commit.
    entry.n = Math.max(1, entry.n - 1)
    var rec = { kind: String(item.kind || 'item'), id: item.id == null ? null : String(item.id), label: String(item.label), ts: _now(opts.now) }
    entry.opened = entry.opened.filter(function (o) { return !(o.kind === rec.kind && o.id === rec.id) })
    entry.opened.unshift(rec)
    entry.opened = entry.opened.slice(0, MAX_OPENED)
    return out
  }

  function lastOpened(entry) {
    return entry && Array.isArray(entry.opened) && entry.opened.length ? entry.opened[0] : null
  }

  // What a box should offer: its own recents first (by their time on THAT
  // surface), then what was searched elsewhere, each tagged with where.
  // `filter` narrows both groups to queries containing the typed text, so a
  // half-typed box can still offer "you searched this before".
  function recent(list, opts) {
    opts = opts || {}
    var surface = _isSurface(opts.surface) ? opts.surface : 'music'
    var limit = opts.limit > 0 ? opts.limit : 8
    var elsewhereLimit = opts.elsewhereLimit != null ? opts.elsewhereLimit : 3
    var f = keyOf(opts.filter)
    var all = sanitize(list).filter(function (e) { return !f || e.key.indexOf(f) !== -1 })
    var own = []
    var elsewhere = []
    for (var i = 0; i < all.length; i++) {
      var e = all[i]
      if (surface in e.surfaces) own.push(e)
      else elsewhere.push(e)
    }
    own.sort(function (a, b) { return b.surfaces[surface] - a.surfaces[surface] })
    return {
      own: own.slice(0, limit),
      elsewhere: elsewhere.slice(0, elsewhereLimit).map(function (e) {
        var from = Object.keys(e.surfaces).sort(function (a, b) { return e.surfaces[b] - e.surfaces[a] })
        return Object.assign({ from: from, fromLabel: LABELS[from[0]] || from[0] }, e)
      }),
    }
  }

  // Strict-prefix cleanup for lists polluted by the old per-keystroke bug
  // ("toky", "tokyo r", "tokyo re" all under "tokyo rev"). Idempotent.
  function dropPrefixes(strings) {
    var list = (strings || []).filter(function (s) { return typeof s === 'string' && s.trim() })
    return list.filter(function (a, i) {
      var la = keyOf(a)
      return !list.some(function (b, j) {
        if (i === j) return false
        var lb = keyOf(b)
        return lb.length > la.length && lb.indexOf(la) === 0
      })
    })
  }

  // Fold the three legacy lists into one. Music entries carry a real time;
  // the library and video lists were plain strings newest-first with no time
  // at all, so they are stamped "yesterday", each a minute older than the one
  // before it — the ORDER survives, the label is honest ("we don't know when,
  // but before today"), and any real timestamp outranks them.
  function migrate(legacy, now) {
    legacy = legacy || {}
    now = _now(now)
    var list = []
    var minute = 60 * 1000
    var untimed = now - 24 * 60 * minute
    var music = Array.isArray(legacy.music) ? legacy.music : []
    // Oldest first so the commit order rebuilds newest-first naturally.
    for (var i = music.length - 1; i >= 0; i--) {
      var h = music[i]
      var q = typeof h === 'string' ? h : (h && h.query)
      var ts = h && typeof h.ts === 'number' ? h.ts : now - (i + 1) * minute
      if (q) list = commit(list, { query: q, surface: 'music', now: ts })
    }
    var video = dropPrefixes(Array.isArray(legacy.video) ? legacy.video : [])
    for (var v = video.length - 1; v >= 0; v--) {
      list = commit(list, { query: video[v], surface: 'video', now: untimed - (v + 1) * minute })
    }
    var library = Array.isArray(legacy.library) ? legacy.library : []
    for (var l = library.length - 1; l >= 0; l--) {
      if (typeof library[l] === 'string') list = commit(list, { query: library[l], surface: 'library', now: untimed - (l + 1) * minute })
    }
    // Migration stamps are approximations; the merge above may have pushed a
    // real music time behind a fake one. Sort by the best time we have.
    return sanitize(list)
  }

  function relativeTime(ts, now) {
    if (!ts) return ''
    var diff = _now(now) - ts
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'
    if (diff < 172800000) return 'yesterday'
    if (diff < 30 * 86400000) return Math.floor(diff / 86400000) + 'd ago'
    return Math.floor(diff / (30 * 86400000)) + 'mo ago'
  }

  function surfaceLabel(s) { return LABELS[s] || s }

  // ── Store ──────────────────────────────────────────────────────────────────
  // Binds the pure list to a key/value io: { getRaw(key) → string|null,
  // readArray(key) → [], write(key, value), remove(key) }. The renderer
  // passes window.PapaLocal; tests pass an in-memory map. The list is cached
  // after the first read and every mutation writes through.
  function createStore(io, opts) {
    opts = opts || {}
    var cache = null
    var listeners = []

    function load() {
      if (cache) return cache
      var present = io.getRaw(STORAGE_KEY) !== null
      if (present) {
        cache = sanitize(io.readArray(STORAGE_KEY))
        return cache
      }
      // First run on this profile: fold the legacy lists in, persist, and
      // retire them — one memory, not four.
      cache = migrate({
        music: io.readArray(LEGACY_KEYS.music),
        library: io.readArray(LEGACY_KEYS.library),
        video: io.readArray(LEGACY_KEYS.video),
      }, opts.now)
      if (io.write(STORAGE_KEY, cache)) {
        io.remove(LEGACY_KEYS.music)
        io.remove(LEGACY_KEYS.library)
        io.remove(LEGACY_KEYS.video)
      }
      return cache
    }

    function save(next) {
      cache = next
      io.write(STORAGE_KEY, cache)
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](cache) } catch (_) { /* a bad listener never blocks a save */ }
      }
      return cache
    }

    // Load now, not on first read: the migration then happens once, at
    // startup, and every surface sees the same list from its first paint.
    load()

    return {
      list: function () { return load().slice() },
      commit: function (query, surface) { return save(commit(load(), { query: query, surface: surface })) },
      recordOpen: function (query, surface, item) { return save(recordOpen(load(), { query: query, surface: surface, item: item })) },
      remove: function (query) { return save(remove(load(), query)) },
      clear: function (surface) { return save(clear(load(), surface)) },
      recent: function (surface, o) { return recent(load(), Object.assign({ surface: surface }, o || {})) },
      onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn }) } },
    }
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    LEGACY_KEYS: LEGACY_KEYS,
    SURFACES: SURFACES,
    MAX_ENTRIES: MAX_ENTRIES,
    MAX_OPENED: MAX_OPENED,
    PREFIX_WINDOW_MS: PREFIX_WINDOW_MS,
    DEBOUNCE: DEBOUNCE,
    keyOf: keyOf,
    sanitize: sanitize,
    commit: commit,
    remove: remove,
    clear: clear,
    recordOpen: recordOpen,
    lastOpened: lastOpened,
    recent: recent,
    dropPrefixes: dropPrefixes,
    migrate: migrate,
    relativeTime: relativeTime,
    surfaceLabel: surfaceLabel,
    createStore: createStore,
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaSearchMemory
if (typeof window !== 'undefined') window.PapaSearchMemory = _PapaSearchMemory
