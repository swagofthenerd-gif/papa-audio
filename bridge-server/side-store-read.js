'use strict'

// Read-only access to the desktop's SideStore files.
//
// On 2026-08-27 the desktop moved its eight biggest/hottest keys out of the
// shared electron-store config and into one small JSON file each (see
// ../side-store.js and ../src/store-migration.js, which DELETES the legacy copy
// from config.json once the side file holds the data). The bridge never
// followed: it kept reading `store.get('libraryCache')` and friends from
// config.json, where those keys no longer exist. On the phone that is an empty
// library, a 404 for every /art and /stream/:id, and likes/playlists written
// into a key nothing reads.
//
// The format is deliberately boring: `<USER_DATA>/<kebab-case-name>.json`
// holding the bare JSON value (not wrapped in an object). So a reader needs no
// electron-store, no SideStore instance and no write path.
//
// This module READS ONLY. The desktop is the single writer for every one of
// these files; a second writer is how two copies of the truth start diverging.
// Phone-side mutations go to the bridge's own inbox (see inbox.js) instead.

const fs = require('fs')
const path = require('path')

// key (the name the desktop's `sideStores` map uses, and the name the bridge's
// old store.get() calls used) → { file, fallback }. The file names and the
// fallbacks are copied from main.js's sideStores definition; the fallback
// matters because an absent file must read as the desktop's default, not as
// undefined.
const SIDE_STORES = {
  libraryCache:   { file: 'library-cache.json',   fallback: null },
  playbackState:  { file: 'playback-state.json',  fallback: null },
  recentlyPlayed: { file: 'recently-played.json', fallback: [] },
  playHistory:    { file: 'play-history.json',    fallback: [] },
  playCounts:     { file: 'play-counts.json',     fallback: {} },
  savedQueues:    { file: 'saved-queues.json',    fallback: [] },
  playlists:      { file: 'playlists.json',       fallback: [] },
  likedTracks:    { file: 'liked-tracks.json',    fallback: [] },
}

// The desktop rewrites these files while the bridge is running — a scan, a
// like, a play. A value cached for the life of the process would serve the
// phone a library from whenever the bridge last restarted, which on a systemd
// unit is "since boot". So the cache is keyed on the file's mtime+size and a
// changed file is re-read on the next request.
function createSideReader(userData) {
  const cache = new Map() // key -> { mtimeMs, size, value }

  function fileFor(key) {
    const spec = SIDE_STORES[key]
    if (!spec) throw new Error(`unknown side store: ${key}`)
    return path.join(userData, spec.file)
  }

  function get(key) {
    const spec = SIDE_STORES[key]
    if (!spec) throw new Error(`unknown side store: ${key}`)
    const file = path.join(userData, spec.file)

    let stat
    try {
      stat = fs.statSync(file)
    } catch (_) {
      // No file yet (fresh profile, or a store the user has never written).
      // The desktop's own fallback is the honest answer, not an error.
      cache.delete(key)
      return spec.fallback
    }

    const hit = cache.get(key)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value

    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, value })
      return value
    } catch (e) {
      // A half-written or corrupt file must not 500 every request, and must
      // not be "fixed" from here — the desktop owns these files and moves a
      // corrupt one aside itself. Say so once per change and serve the default.
      console.error(`[bridge] ${spec.file} unreadable (${(e && e.code) || (e && e.message)}); serving the default`)
      cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, value: spec.fallback })
      return spec.fallback
    }
  }

  return { get, fileFor, keys: Object.keys(SIDE_STORES) }
}

module.exports = { createSideReader, SIDE_STORES }
