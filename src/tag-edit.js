// Editing tags, and surviving the consequences.
//
// An album's identity in this app is derived from its tags:
//   md5(`${(albumArtist||artist).toLowerCase()}_${album.toLowerCase()}`)
// So correcting an artist name mints a NEW album id, and everything keyed by
// the old one -- likes, ratings, notes, recently-played, the cached cover --
// silently detaches. Fixing tags is exactly what a person does to tidy their
// library, so "tidying" must not quietly cost them all of that.
//
// This module owns the key string. Main hashes it, and BOTH places that need
// it use this one function, because they used to build it differently and the
// artwork lookup never matched what the extractor wrote.

;(function () {

  // Must stay byte-identical to what main hashes, or ids drift.
  // Trimmed and internally collapsed. Untrimmed tags are routine in downloaded
  // rips, and without this one album whose tracks disagree about padding became
  // several albums in the library — each with its own id, and therefore its own
  // artwork file, rating and notes. Changing this changes album ids, so
  // main.js migrates the artwork and the id-keyed state on startup.
  function normKeyPart(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim()
  }

  function albumKeyOf(t) {
    t = t || {}
    return normKeyPart(t.albumArtist || t.artist) + '_' + normKeyPart(t.album)
  }

  // The key this track WOULD have had before the trim, so a migration can find
  // what to rename. Returns null when the two agree and nothing needs moving.
  function legacyAlbumKeyOf(t) {
    t = t || {}
    var artist = String(t.albumArtist || t.artist || '').toLowerCase()
    var album = String(t.album || '').toLowerCase()
    var legacy = artist + '_' + album
    return legacy === albumKeyOf(t) ? null : legacy
  }

  // Fields the writer understands. Anything else is ignored rather than
  // silently dropped into the file.
  var FIELDS = ['title', 'artist', 'album', 'albumartist', 'date', 'genre', 'track', 'disc', 'composer']

  // The UI shows this when a field differs across the selection. It means
  // "leave alone", and must never reach the file.
  var MIXED = '—'   // em dash

  function isBlank(v) { return v == null || String(v).trim() === '' }

  // Only what actually changed. Writing every field would rewrite tags the
  // user never touched, and normalise them in ways they did not ask for.
  function diffTags(original, edited) {
    var out = {}
    original = original || {}
    edited = edited || {}
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i]
      if (!Object.prototype.hasOwnProperty.call(edited, f)) continue
      var v = edited[f]
      if (v === MIXED) continue                       // untouched mixed field
      if (v === undefined) continue
      var was = original[f] == null ? '' : String(original[f])
      var now = v == null ? '' : String(v)
      if (was === now) continue
      out[f] = now
    }
    return out
  }

  function changedFieldCount(original, edited) {
    return Object.keys(diffTags(original, edited)).length
  }

  // Collapse a set of tracks into one editable form: shared values show
  // through, differing ones come back as MIXED.
  function commonTags(tracks) {
    var out = {}
    var list = tracks || []
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i]
      var seen = null
      var mixed = false
      for (var j = 0; j < list.length; j++) {
        var v = list[j] && list[j][f]
        var s = v == null ? '' : String(v)
        if (seen === null) seen = s
        else if (seen !== s) { mixed = true; break }
      }
      out[f] = mixed ? MIXED : (seen === null ? '' : seen)
    }
    return out
  }

  // opts: { renumber } -- renumber rewrites track numbers 1..N in list order,
  // which is the usual fix for a folder of files with no numbering at all.
  function bulkApply(tracks, patch, opts) {
    opts = opts || {}
    var list = tracks || []
    var out = []
    for (var i = 0; i < list.length; i++) {
      var t = list[i]
      var edited = {}
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) edited[k] = patch[k]
      }
      if (opts.renumber) edited.track = String(i + 1)
      var tags = diffTags(t, edited)
      if (!Object.keys(tags).length) continue        // nothing to do for this file
      out.push({ filePath: t.filePath, tags: tags })
    }
    return out
  }

  // What the album identity would become, and whether it moved at all.
  function migrationFor(before, after) {
    var oldKey = albumKeyOf(before)
    var newKey = albumKeyOf(after)
    return { oldKey: oldKey, newKey: newKey, changed: oldKey !== newKey }
  }

  // The album identity after an edit is applied to a representative track.
  function albumKeyAfter(track, patch) {
    var merged = {
      albumArtist: track && track.albumArtist,
      artist: track && track.artist,
      album: track && track.album,
    }
    // A CLEARED field is an edit, not an absence. Skipping blanks here meant
    // clearing the album artist computed the OLD key, so the migration this
    // module exists to drive ran against the wrong target and detached the
    // likes/ratings/artwork it was supposed to carry across.
    // undefined and MIXED still mean "untouched"; '' means "the user cleared it".
    if (patch && patch.albumartist !== undefined && patch.albumartist !== MIXED) {
      merged.albumArtist = patch.albumartist
    }
    if (patch && patch.artist !== undefined && patch.artist !== MIXED) {
      // artist only decides the key when there is no album artist -- which is
      // exactly what a just-cleared album artist leaves behind.
      if (isBlank(merged.albumArtist)) merged.artist = patch.artist
    }
    if (patch && patch.album !== undefined && patch.album !== MIXED) merged.album = patch.album
    return albumKeyOf(merged)
  }

  function looksUnknown(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase()
    return !s || s === 'unknown' || s === 'unknown artist' || s === 'unknown album'
  }

  var API = {
    FIELDS: FIELDS,
    MIXED: MIXED,
    albumKeyOf: albumKeyOf,
    legacyAlbumKeyOf: legacyAlbumKeyOf,
    albumKeyAfter: albumKeyAfter,
    diffTags: diffTags,
    changedFieldCount: changedFieldCount,
    commonTags: commonTags,
    bulkApply: bulkApply,
    migrationFor: migrationFor,
    looksUnknown: looksUnknown,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.PapaTagEdit = API

})();
