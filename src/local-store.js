'use strict'
// One validated reader for localStorage.
//
// JSON.parse succeeds for "null", "{}" and "5" — none of which have .length or
// .filter — so a bare parse guards against a syntax error and nothing else. And
// an unguarded throw here is not a local failure: initSearchHistory() is called
// synchronously from setupListeners(), so one bad key aborted the rest of the
// wiring, leaving the queue panel, the sleep timer, drag and drop and every
// keyboard shortcut unbound for the whole session, with nothing shown.
//
// localStorage itself can also throw: private windows, disabled site data, and a
// full quota on write.
;(function () {
  function raw(key) {
    try {
      return window.localStorage.getItem(key)
    } catch (_) {
      // Storage disabled entirely. Not recoverable, and not worth crashing over.
      return null
    }
  }

  function parse(key, fallback) {
    const text = raw(key)
    if (text === null || text === '') return fallback
    try {
      const v = JSON.parse(text)
      return v === undefined ? fallback : v
    } catch (e) {
      // Say so once, loudly enough to be findable, then carry on. Silence here
      // is what made the keyboard-unbinding bug so hard to see.
      try { console.error(`[papa][localStorage] ${key} is not valid JSON; using the default`, e && e.message) } catch (_) {}
      return fallback
    }
  }

  // Always an array. `keep` filters members; a member that fails is dropped, not
  // a reason to discard the whole list.
  function readArray(key, keep) {
    const v = parse(key, null)
    if (!Array.isArray(v)) {
      if (v !== null) warnShape(key, 'an array', v)
      return []
    }
    return typeof keep === 'function' ? v.filter(item => { try { return keep(item) } catch (_) { return false } }) : v
  }

  // Always a plain object. Arrays are rejected: every caller that wants one asks
  // for one, and Array has none of the keys they then read.
  function readObject(key) {
    const v = parse(key, null)
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      if (v !== null) warnShape(key, 'an object', v)
      return {}
    }
    return v
  }

  function describe(v) {
    if (Array.isArray(v)) return 'an array'
    if (v === null) return 'null'
    const t = typeof v
    return (t === 'object' ? 'an ' : 'a ') + t
  }

  function warnShape(key, wanted, got) {
    try {
      console.error(`[papa][localStorage] ${key} should be ${wanted}, found ${describe(got)}; using the default`)
    } catch (_) {}
  }

  // Writes fail on a full quota and in private windows. A failed write must not
  // take down whatever the user was doing.
  function write(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch (e) {
      try { console.error(`[papa][localStorage] could not save ${key}:`, e && e.message) } catch (_) {}
      return false
    }
  }

  function remove(key) {
    try { window.localStorage.removeItem(key); return true } catch (_) { return false }
  }

  // Raw text access, for the one caller (video-store.js) that needs to see a
  // corrupt blob before parsing throws it away — readObject turns malformed
  // JSON into {}, which is indistinguishable from an empty store, and that
  // ambiguity is exactly what let a truncated blob get overwritten by the next
  // save. writeRaw stores the text verbatim (no JSON.stringify) so a
  // quarantined blob stays byte-for-byte recoverable.
  function readRaw(key) {
    return raw(key)
  }

  function writeRaw(key, text) {
    try {
      window.localStorage.setItem(key, String(text))
      return true
    } catch (e) {
      try { console.error(`[papa][localStorage] could not save ${key}:`, e && e.message) } catch (_) {}
      return false
    }
  }

  // Append to a capped list in one step: the like-history and search-history
  // call sites all did read, push, slice, write by hand, and two of them did the
  // read unguarded.
  function push(key, item, cap) {
    const list = readArray(key)
    list.push(item)
    const capped = cap && list.length > cap ? list.slice(list.length - cap) : list
    write(key, capped)
    return capped
  }

  window.PapaLocal = { readArray, readObject, readRaw, write, writeRaw, remove, push }
})()
