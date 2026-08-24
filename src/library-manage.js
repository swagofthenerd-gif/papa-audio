// Library duplicate analysis.
//
// The dangerous mistake here is assuming a surround rip replaces a stereo one.
// Often it does not: a 5.1 Blu-Ray rip of "Wish You Were Here 50" may hold 5
// tracks where the stereo release holds 30. Deleting the stereo copy because
// it has fewer channels would destroy 25 tracks that exist nowhere else.
//
// So nothing here ever decides to delete. It groups, it measures, and it
// states plainly whether one folder actually covers another. The caller
// decides, with the warnings in front of them.

var EDITION_WORDS = [
  '5.1', '7.1', '2.0', 'stereo', 'surround', 'multichannel', 'multi-channel',
  'remaster', 'remastered', 'bluray', 'blu-ray', 'dvda', 'dvd-audio', 'dvd audio',
  'sacd', 'hi-res', 'hires', 'dsd', 'deluxe', 'edition', 'anniversary', 'atmos',
  'flac', 'mix', 'remix',
]

var UNKNOWN_RE = /^(unknown|various|va|untitled)?\s*(artist|album)?\s*$/i

function normalizeName(s) {
  var out = String(s == null ? '' : s).toLowerCase()
  out = out.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ')
  out = out.replace(/\{[^}]*\}/g, ' ')
  for (var i = 0; i < EDITION_WORDS.length; i++) {
    out = out.split(EDITION_WORDS[i]).join(' ')
  }
  out = out.replace(/\b(19|20)\d{2}\b/g, ' ')
  out = out.replace(/[^a-z0-9]+/g, ' ').trim()
  return out
}

function isUnknown(s) {
  var v = String(s == null ? '' : s).trim()
  if (!v) return true
  return UNKNOWN_RE.test(v)
}

function dirOf(filePath) {
  var p = String(filePath == null ? '' : filePath)
  var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : ''
}

function baseOf(p) {
  var s = String(p == null ? '' : p)
  var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) : s
}

// "Disc 1" / "CD2" folders are one release split up, not rival copies of it.
function discPartOf(dirPath) {
  var name = baseOf(dirPath)
  var m = /^(disc|disk|cd)\s*0*(\d+)$/i.exec(name.trim())
  return m ? parseInt(m[2], 10) : null
}

function parentOf(dirPath) { return dirOf(dirPath) }

// Counting tracks is not enough to know one folder covers another: two
// one-track folders can hold two different songs. Coverage has to be decided
// on the songs themselves, or "delete the stereo copy" can delete music that
// exists nowhere else.
function trackIdentity(track) {
  var name = track && track.title
    ? String(track.title)
    : baseOf(track && track.filePath).replace(/\.[^.]+$/, '')
  name = name.toLowerCase()
  name = name.replace(/^[\s\d]*[-._)\]]+\s*/, '')   // leading "03 - ", "1." etc
  name = name.replace(/^\d+\s+/, '')
  name = name.replace(/\b(remaster(ed)?|mono|stereo|5\.1|7\.1)\b/g, ' ')
  name = name.replace(/\b(19|20)\d{2}\b/g, ' ')
  name = name.replace(/[^a-z0-9]+/g, '')
  return name
}

function channelLabel(ch) {
  var n = Number(ch) || 0
  if (n >= 8) return '7.1'
  if (n >= 6) return '5.1'
  if (n === 2) return 'Stereo'
  if (n === 1) return 'Mono'
  return 'Unknown'
}

// Build one entry per folder on disk, merging Disc N children into their parent
// release so a two-disc surround set is measured as a single copy.
function buildFolders(tracks) {
  var byDir = {}
  for (var i = 0; i < (tracks || []).length; i++) {
    var t = tracks[i]
    if (!t || !t.filePath) continue
    var dir = dirOf(t.filePath)
    if (!dir) continue
    var disc = discPartOf(dir)
    var key = disc != null ? parentOf(dir) : dir
    if (!key) key = dir
    if (!byDir[key]) {
      byDir[key] = {
        dir: key, trackCount: 0, bytes: 0, maxChannels: 0, minChannels: null,
        codecs: {}, parts: {}, files: [], maxBitDepth: 0, maxSampleRate: 0,
        titles: {},
      }
    }
    var e = byDir[key]
    var ch = Number(t.channels) || 0
    e.trackCount++
    e.bytes += Number(t.fileSize) || 0
    if (ch > e.maxChannels) e.maxChannels = ch
    if (ch > 0 && (e.minChannels === null || ch < e.minChannels)) e.minChannels = ch
    if (t.codec) e.codecs[t.codec] = (e.codecs[t.codec] || 0) + 1
    if ((Number(t.bitsPerSample) || 0) > e.maxBitDepth) e.maxBitDepth = Number(t.bitsPerSample) || 0
    if ((Number(t.sampleRate) || 0) > e.maxSampleRate) e.maxSampleRate = Number(t.sampleRate) || 0
    if (disc != null) e.parts[dir] = true
    var ident = trackIdentity(t)
    if (ident) e.titles[ident] = true
    e.files.push(t.filePath)
  }
  var out = []
  for (var k in byDir) {
    if (!Object.prototype.hasOwnProperty.call(byDir, k)) continue
    var f = byDir[k]
    f.partCount = Object.keys(f.parts).length
    f.channelLabel = channelLabel(f.maxChannels)
    // A folder holding both stereo and surround tracks is mixed, and pruning
    // it wholesale would take the surround tracks with it.
    f.mixedChannels = f.minChannels !== null && f.maxChannels > 0 && f.minChannels !== f.maxChannels
    delete f.parts
    out.push(f)
  }
  return out
}

// Does `candidate` genuinely cover `other`? Only if it is at least as complete
// AND strictly better in channels. Anything less and the answer is no.
function covers(candidate, other) {
  if (!candidate || !other) return false
  if (candidate.dir === other.dir) return false
  if (candidate.trackCount < other.trackCount) return false
  if (candidate.maxChannels <= other.maxChannels) return false
  // Every song in `other` must actually be present in `candidate`.
  var mine = candidate.titles || {}
  var theirs = Object.keys(other.titles || {})
  if (!theirs.length) return false
  for (var i = 0; i < theirs.length; i++) {
    if (!mine[theirs[i]]) return false
  }
  return true
}

// Which songs would be lost if `other` went and `candidate` stayed.
function missingFrom(candidate, other) {
  var mine = (candidate && candidate.titles) || {}
  var out = []
  var theirs = Object.keys((other && other.titles) || {})
  for (var i = 0; i < theirs.length; i++) if (!mine[theirs[i]]) out.push(theirs[i])
  return out
}

function assessGroup(group) {
  var folders = group.folders || []
  var warnings = []
  var reliable = true

  if (group.unknownTags) {
    reliable = false
    warnings.push('Tags are missing or generic, so these folders may not be the same album at all. Fix the tags before deleting anything here.')
  }
  var labels = {}
  for (var i = 0; i < folders.length; i++) labels[folders[i].channelLabel] = true
  if (Object.keys(labels).length < 2) {
    reliable = false
    warnings.push('Every copy has the same channel layout, so none of them is a surround upgrade of another.')
  }

  for (var j = 0; j < folders.length; j++) {
    var f = folders[j]
    var best = null
    for (var k = 0; k < folders.length; k++) {
      if (covers(folders[k], f) && (!best || folders[k].maxChannels > best.maxChannels)) best = folders[k]
    }
    f.supersededBy = best ? best.dir : null
    f.safeToDelete = !!best && reliable && !f.mixedChannels

    f.blockers = []
    if (!reliable) f.blockers.push('grouping is not reliable')
    if (f.mixedChannels) f.blockers.push('folder mixes stereo and surround tracks')
    if (!best) {
      // The specific trap: a higher-channel copy exists but is incomplete.
      var richer = null
      for (var m = 0; m < folders.length; m++) {
        if (folders[m] !== f && folders[m].maxChannels > f.maxChannels) {
          if (!richer || folders[m].trackCount > richer.trackCount) richer = folders[m]
        }
      }
      if (richer && richer.trackCount < f.trackCount) {
        f.blockers.push('the ' + richer.channelLabel + ' copy has only ' +
          richer.trackCount + ' of these ' + f.trackCount + ' tracks')
      } else if (richer) {
        var miss = missingFrom(richer, f)
        f.blockers.push(miss.length
          ? 'the ' + richer.channelLabel + ' copy is missing ' + miss.length +
            ' track' + (miss.length === 1 ? '' : 's') + ' this one has'
          : 'the ' + richer.channelLabel + ' copy does not cover these tracks')
      } else if (!richer) {
        f.blockers.push('this is the best copy in the group')
      }
    }
  }

  group.warnings = warnings
  group.reliable = reliable
  group.deletableBytes = folders.reduce(function (n, f) { return n + (f.safeToDelete ? f.bytes : 0) }, 0)
  return group
}

function findDuplicates(tracks) {
  var groups = {}
  for (var i = 0; i < (tracks || []).length; i++) {
    var t = tracks[i]
    if (!t || !t.filePath) continue
    var artist = t.albumArtist || t.artist || ''
    var album = t.album || ''
    var unknown = isUnknown(artist) || isUnknown(album)
    var key = normalizeName(artist) + ' :: ' + normalizeName(album)
    if (!groups[key]) {
      groups[key] = { key: key, artist: artist, album: album, unknownTags: unknown, _tracks: [] }
    }
    if (unknown) groups[key].unknownTags = true
    groups[key]._tracks.push(t)
  }
  var out = []
  for (var k in groups) {
    if (!Object.prototype.hasOwnProperty.call(groups, k)) continue
    var g = groups[k]
    g.folders = buildFolders(g._tracks)
    delete g._tracks
    if (g.folders.length < 2) continue
    g.totalBytes = g.folders.reduce(function (n, f) { return n + f.bytes }, 0)
    out.push(assessGroup(g))
  }
  // Most reclaimable space first, but never-safe groups sink to the bottom.
  return out.sort(function (a, b) {
    if (a.reliable !== b.reliable) return a.reliable ? -1 : 1
    return b.deletableBytes - a.deletableBytes
  })
}

var API = {
  normalizeName: normalizeName,
  isUnknown: isUnknown,
  dirOf: dirOf,
  baseOf: baseOf,
  discPartOf: discPartOf,
  channelLabel: channelLabel,
  buildFolders: buildFolders,
  covers: covers,
  missingFrom: missingFrom,
  trackIdentity: trackIdentity,
  assessGroup: assessGroup,
  findDuplicates: findDuplicates,
}

if (typeof module !== 'undefined' && module.exports) module.exports = API
if (typeof window !== 'undefined') window.PapaLibraryManage = API
