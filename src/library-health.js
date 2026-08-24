// What is wrong with the library, and what is safe to do about it.
//
// Two rules shape this file. First, "not audio" is not the same as "junk": a
// .cue file is parsed by the scanner and cover art is displayed, so sweeping
// every non-audio file would delete things the app depends on. Second, every
// finding carries the exact operation that would fix it, so a Fix button is
// just that operation handed to the normal delete funnel — no second code path
// that could skip the confirmation or the state pruning.

// Scoped in an IIFE: every script here shares one global scope, so a bare
// top-level `const` can collide with another file and make THIS whole file
// fail to parse — silently, with only a console error to show for it.
;(function () {
  var AUDIO_RE = /\.(flac|mp3|m4a|aac|opus|ogg|wav|wv|ape|alac|aiff?|dsf|dff|dts|ac3|mka|mp4|webm)$/i
  var ARTWORK_RE = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i
  // Read by the scanner or genuinely useful next to the music.
  var KEEP_RE = /\.(cue|lrc)$/i
  var PLAYLIST_RE = /\.(m3u8?|pls|xspf)$/i
  // Things that have no business sitting in a music library.
  var JUNK_RE = /\.(exe|msi|bat|cmd|scr|dll|zip|rar|7z|iso|nfo|log|txt|accurip|sfv|md5|url|lnk|db|ini|ds_store)$/i

  function extOf(p) {
    var base = String(p == null ? '' : p).split(/[\\/]/).pop()
    var i = base.lastIndexOf('.')
    return i > 0 ? base.slice(i).toLowerCase() : ''
  }

  function classifyFile(filePath) {
    var p = String(filePath == null ? '' : filePath)
    if (AUDIO_RE.test(p)) return 'audio'
    if (ARTWORK_RE.test(p)) return 'artwork'
    if (KEEP_RE.test(p)) return 'keep'
    if (PLAYLIST_RE.test(p)) return 'playlist'
    if (JUNK_RE.test(p)) return 'junk'
    return 'other'
  }

  function isUnknownTag(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase()
    return !s || s === 'unknown artist' || s === 'unknown album' || s === 'unknown' || s === 'various'
  }

  function finding(id, title, severity, detail, paths, bytes, fixAction) {
    return {
      id: id, title: title, severity: severity, detail: detail,
      paths: paths || [], count: (paths || []).length, bytes: bytes || 0,
      fixAction: fixAction || null,
    }
  }

  function trashFix(paths) {
    return paths && paths.length ? { kind: 'trash', paths: paths.slice() } : null
  }

  // albums: the library. extras: what main found on disk that the library does
  // not know about — { nonAudio:[{path,bytes}], emptyDirs:[], partials:[{path,bytes}] }
  function assessLibrary(albums, extras) {
    albums = albums || []
    extras = extras || {}
    var out = []
    var i, j

    // — audio files that cannot possibly play —
    var broken = []
    var brokenBytes = 0
    for (i = 0; i < albums.length; i++) {
      var tracks = albums[i].tracks || []
      for (j = 0; j < tracks.length; j++) {
        var t = tracks[j]
        if (!t.filePath) continue
        var size = t.fileSize == null ? null : Number(t.fileSize)
        // A zero-byte file, or one the prober found no audio channels in.
        if (size === 0 || (size != null && size > 0 && size < 4096) ||
            (t.channels === 0 && (t.duration || 0) === 0)) {
          broken.push(t.filePath)
          brokenBytes += size || 0
        }
      }
    }
    if (broken.length) {
      out.push(finding('broken', 'Broken audio files', 'high',
        'Empty or unreadably small. These also poison album grouping, because a file with no channels ' +
        'reads as a separate "unknown" release.',
        broken, brokenBytes, trashFix(broken)))
    }

    // — files that do not belong in a music library —
    var junk = []
    var junkBytes = 0
    var playlists = []
    var playlistBytes = 0
    var nonAudio = extras.nonAudio || []
    for (i = 0; i < nonAudio.length; i++) {
      var kind = classifyFile(nonAudio[i].path)
      if (kind === 'junk') { junk.push(nonAudio[i].path); junkBytes += nonAudio[i].bytes || 0 }
      else if (kind === 'playlist') { playlists.push(nonAudio[i].path); playlistBytes += nonAudio[i].bytes || 0 }
    }
    if (junk.length) {
      out.push(finding('junk', 'Files that are not music', 'medium',
        'Installers, logs, archives and rip artefacts. Cover art and .cue files are deliberately left alone.',
        junk, junkBytes, trashFix(junk)))
    }
    if (playlists.length) {
      out.push(finding('playlists', 'Loose playlist files', 'low',
        'M3U/PLS files sitting in the library. Harmless, and the app can import them — remove only if you do not want them.',
        playlists, playlistBytes, trashFix(playlists)))
    }

    // — folders with nothing left in them —
    var empties = extras.emptyDirs || []
    if (empties.length) {
      out.push(finding('empty-dirs', 'Empty folders', 'low',
        'No audio left inside. Usually what a delete leaves behind.',
        empties, 0, trashFix(empties)))
    }

    // — abandoned partial downloads —
    var partials = extras.partials || []
    if (partials.length) {
      var pPaths = []
      var pBytes = 0
      for (i = 0; i < partials.length; i++) { pPaths.push(partials[i].path); pBytes += partials[i].bytes || 0 }
      out.push(finding('partials', 'Unfinished downloads', 'medium',
        'Partial files with no matching transfer any more. These sit outside your library and are pure waste.',
        pPaths, pBytes, trashFix(pPaths)))
    }

    // — problems worth SHOWING but never auto-fixing —
    var untagged = []
    var mixed = []
    var gaps = []
    for (i = 0; i < albums.length; i++) {
      var a = albums[i]
      if (isUnknownTag(a.artist) || isUnknownTag(a.name)) untagged.push(a.id)

      var chans = {}
      var nums = []
      var tr = a.tracks || []
      for (j = 0; j < tr.length; j++) {
        if (tr[j].channels > 0) chans[tr[j].channels] = true
        if (tr[j].trackNumber > 0) nums.push(tr[j].trackNumber)
      }
      if (Object.keys(chans).length > 1) mixed.push(a.id)
      if (nums.length > 1) {
        nums.sort(function (x, y) { return x - y })
        var expected = nums[nums.length - 1] - nums[0] + 1
        if (expected > nums.length) gaps.push(a.id)
      }
    }
    if (untagged.length) {
      out.push(finding('untagged', 'Albums with missing tags', 'medium',
        'Unknown artist or album. These collide with each other when looking for duplicates, so fixing ' +
        'the tags is what makes duplicate detection trustworthy.',
        untagged, 0, null))
    }
    if (mixed.length) {
      out.push(finding('mixed-channels', 'Albums mixing stereo and surround', 'low',
        'Different channel layouts under one album. Usually two separate rips sharing tags — see Duplicates.',
        mixed, 0, null))
    }
    if (gaps.length) {
      out.push(finding('missing-tracks', 'Albums with missing track numbers', 'low',
        'Gaps in the numbering, so the album is probably incomplete.',
        gaps, 0, null))
    }

    var order = { high: 0, medium: 1, low: 2 }
    return out.sort(function (x, y) {
      if (order[x.severity] !== order[y.severity]) return order[x.severity] - order[y.severity]
      return y.bytes - x.bytes
    })
  }

  function reclaimable(findings) {
    var n = 0
    for (var i = 0; i < (findings || []).length; i++) {
      if (findings[i].fixAction) n += findings[i].bytes
    }
    return n
  }

  var API = {
    AUDIO_RE: AUDIO_RE,
    classifyFile: classifyFile,
    isUnknownTag: isUnknownTag,
    assessLibrary: assessLibrary,
    reclaimable: reclaimable,
    extOf: extOf,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.PapaLibraryHealth = API

})();
