'use strict'
// Per-show memory for audio/subtitle track choices and the dub/sub preference
// (roadmap #31, #32), pure logic behind videoTrackMemoryGet/Set.
//
// When someone picks Japanese audio with English subs for one episode of a show,
// the next episode should open the same way rather than making them choose
// again. The choice is remembered per show, keyed by a stable showKey the
// renderer supplies (tmdb:tv:1234, anime:5678 — whatever it uses elsewhere).
// This module is the shape and the bookkeeping: a bounded map, an LRU trim so a
// heavy watcher never grows it without bound, and a merge that lets Set patch one
// field without clobbering the others.
//
// Kept pure and out of main.js so the cap maths, the merge and the touch-on-read
// LRU can be tested without a SideStore or a live app.

// How many shows the memory keeps before the least-recently-touched are dropped.
// Each entry is a handful of short strings, so 200 is generous and stays tiny on
// disk.
const DEFAULT_CAP = 200

// The fields an entry may carry. Anything else in a Set patch is ignored, so a
// renderer bug cannot write arbitrary keys into the store.
//   audioLang — the audio track's language tag last selected (e.g. 'jpn')
//   subLang   — the subtitle track's language tag last selected (e.g. 'eng')
//   dubPref   — 'sub' | 'dub' | null, the per-series override of the global pref
const FIELDS = ['audioLang', 'subLang', 'dubPref']

// A normalised, non-empty string, or null. Track language tags and the dub pref
// are all short strings; a blank or non-string collapses to null so "cleared"
// and "never set" read the same.
function _str(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

// The stored value for one show, or null when the show has no memory. A copy, so
// a caller cannot mutate what is in the map.
function get(map, showKey) {
  const key = _str(showKey)
  if (!key) return null
  const m = map && typeof map === 'object' ? map : {}
  const entry = m[key]
  if (!entry || typeof entry !== 'object') return null
  return {
    audioLang: _str(entry.audioLang),
    subLang: _str(entry.subLang),
    dubPref: _str(entry.dubPref),
  }
}

// Merge a patch into the show's entry and return the NEW map (never mutates the
// input, mirroring dead-magnet.js's discipline). Only the FIELDS actually
// present in the patch are changed; the rest of the entry survives. A field set
// to null is remembered as null (an explicit "clear this"), distinct from a
// field simply absent from the patch. Touches `at` so the LRU trim knows this
// show was just used, then trims to the cap.
function set(map, showKey, patch, at, cap) {
  const key = _str(showKey)
  if (!key) return map && typeof map === 'object' ? { ...map } : {}
  const capN = Number(cap) > 0 ? Math.floor(Number(cap)) : DEFAULT_CAP
  const now = Number(at) || 0
  const next = map && typeof map === 'object' ? { ...map } : {}
  const prev = next[key] && typeof next[key] === 'object' ? next[key] : {}
  const entry = { ...prev }
  const p = patch && typeof patch === 'object' ? patch : {}
  for (const f of FIELDS) {
    if (Object.prototype.hasOwnProperty.call(p, f)) entry[f] = _str(p[f])
  }
  entry.at = now
  next[key] = entry
  return _trim(next, capN)
}

// Drop the least-recently-touched entries until the map is at or under the cap.
// Recency is the stored `at`; entries without one sort as oldest, which is right
// for anything written before touch tracking existed.
function _trim(map, cap) {
  const keys = Object.keys(map)
  if (keys.length <= cap) return map
  keys.sort((a, b) => (Number(map[a] && map[a].at) || 0) - (Number(map[b] && map[b].at) || 0))
  const out = { ...map }
  for (const k of keys.slice(0, keys.length - cap)) delete out[k]
  return out
}

module.exports = { get, set, DEFAULT_CAP, FIELDS }
