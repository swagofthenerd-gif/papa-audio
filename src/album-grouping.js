'use strict'

// How an album is keyed when the tags disagree about who the release is BY.
//
// tag-edit's albumKeyOf keys on (albumArtist || artist) + album. On a
// compilation that shatters the release into one "album" per performer, because
// each track carries its own album artist. Measured on the real library:
// "Best 5.1 Songs" became 16 albums (every track tagged with its own performer —
// verified from the files, not the cache), "Digital Singles Vol.1" 6, "Raja Ram's
// Anthology" 5. Thirty-six cards where there should be three, each looking like
// a spurious extra release inside a real artist's discography.
//
// The rule: tracks under one album name in one folder are one release. But that
// is only applied where the tags actually FAIL — where the album artist varies
// within that folder, or is absent. A normally-tagged album keeps its tag-based
// key, so an album whose tracks happen to live in two separate folders still
// groups by its tags exactly as before. A trailing disc folder is collapsed into
// its parent first, or a two-disc compilation would split into CD1 and CD2 —
// the regression the obvious version of this fix introduces.

const path = require('path')

const DISC_SEGMENT = /^(cd|disc|disk|vol|volume)[\s._-]*\d+$/i

// The folder a release lives in, with a trailing disc folder collapsed into its
// parent so the discs of one set stay together.
function folderKey(filePath) {
  let dir = path.dirname(String(filePath || ''))
  const base = path.basename(dir)
  if (DISC_SEGMENT.test(base)) dir = path.dirname(dir)
  return dir.toLowerCase()
}

function releaseKey(track) {
  return folderKey(track.filePath) + '_' + String((track && track.album) || '').trim().toLowerCase()
}

// Two passes, because whether the tags disagree is a property of the whole
// folder and cannot be decided from one track.
//
// `legacyKeyOf` is tag-edit's albumKeyOf, injected so the tagging rules keep
// living in one place and this module stays pure.
function buildGroupKeyResolver(tracks, legacyKeyOf) {
  const artistsPerRelease = new Map()
  for (const t of tracks || []) {
    if (!t || !t.filePath) continue
    const rk = releaseKey(t)
    let names = artistsPerRelease.get(rk)
    if (!names) { names = new Set(); artistsPerRelease.set(rk, names) }
    names.add(String(t.albumArtist || '').trim().toLowerCase())
  }

  const tagsCannotSay = new Set()
  for (const [rk, names] of artistsPerRelease) {
    // More than one album artist under one album name in one folder means a
    // compilation. Exactly one, empty, means the tag is simply missing.
    if (names.size > 1 || (names.size === 1 && !names.values().next().value)) tagsCannotSay.add(rk)
  }

  return function groupKeyFor(track) {
    if (track && track.filePath) {
      const rk = releaseKey(track)
      if (tagsCannotSay.has(rk)) return 'dir:' + rk
    }
    return legacyKeyOf(track)
  }
}

// When the tags could not say, the album's artist is whatever its tracks agree
// on — and when they do not agree it is a compilation, which should say so
// rather than borrow whichever track happened to be seen first.
function displayArtistFor(tracks, fallback) {
  const names = new Set(
    (tracks || []).map(t => String((t && t.artist) || '').trim()).filter(Boolean)
  )
  if (names.size > 1) return 'Various Artists'
  if (names.size === 1) return names.values().next().value
  return fallback
}

module.exports = { DISC_SEGMENT, folderKey, releaseKey, buildGroupKeyResolver, displayArtistFor }
