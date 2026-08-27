// Keeping saved state honest when files move or disappear.
//
// Every persisted reference to a song in this app is its absolute file path:
// liked tracks, play counts, play history, playlist entries, saved queues, and
// the resume position. Nothing prunes them, so a deleted album leaves dead
// paths behind forever — playlists that skip, stats that undercount, a resume
// that silently fails.
//
// Written REMAP-first on purpose. A delete is just a remap to null, so renaming
// or moving a folder reuses all of this instead of growing a parallel copy that
// drifts out of step.

// Music here lives on a fuseblk/NTFS volume which Linux presents
// case-sensitively, so paths are compared exactly. Only separators are
// normalized, since those genuinely vary by how a path was constructed.
function normalizePath(p) {
  if (p == null) return ''
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

// removed: paths that are gone. renamed: [{from, to}] pairs.
// Result maps normalized old path -> new path, or null when it is gone.
function buildRemap(removed, renamed) {
  var map = {}
  var i
  for (i = 0; i < (removed || []).length; i++) {
    var r = normalizePath(removed[i])
    if (r) map[r] = null
  }
  for (i = 0; i < (renamed || []).length; i++) {
    var pair = renamed[i]
    if (!pair) continue
    var from = normalizePath(pair.from)
    var to = normalizePath(pair.to)
    if (from && to) map[from] = to
  }
  return map
}

function has(map, p) {
  return Object.prototype.hasOwnProperty.call(map, normalizePath(p))
}

function resolve(map, p) {
  return map[normalizePath(p)]
}

function pruneLikedTracks(list, map) {
  var out = []
  var removed = 0
  var renamed = 0
  for (var i = 0; i < (list || []).length; i++) {
    var p = list[i]
    // A rename can collide with an entry that already exists, in either order,
    // so BOTH branches have to dedup -- guarding only the renamed one left a
    // duplicate whenever the renamed path was listed first. This is a set.
    if (!has(map, p)) {
      if (out.indexOf(normalizePath(p)) === -1 && out.indexOf(p) === -1) out.push(p)
      continue
    }
    var next = resolve(map, p)
    if (next == null) { removed++; continue }
    if (out.indexOf(next) === -1) out.push(next)
    renamed++
  }
  return { value: out, removed: removed, renamed: renamed }
}

function prunePlayCounts(counts, map) {
  var out = {}
  var removed = 0
  var renamed = 0
  for (var p in (counts || {})) {
    if (!Object.prototype.hasOwnProperty.call(counts, p)) continue
    // Both branches ACCUMULATE. Assigning here instead would let a surviving
    // entry overwrite plays already merged in from a renamed one, silently
    // losing them depending on key order.
    if (!has(map, p)) { out[p] = (out[p] || 0) + counts[p]; continue }
    var next = resolve(map, p)
    if (next == null) { removed++; continue }
    // A renamed file's plays are the same plays.
    out[next] = (out[next] || 0) + counts[p]
    renamed++
  }
  return { value: out, removed: removed, renamed: renamed }
}

function prunePlayHistory(history, map) {
  var out = []
  var removed = 0
  var renamed = 0
  for (var i = 0; i < (history || []).length; i++) {
    var e = history[i]
    if (!e || !e.filePath || !has(map, e.filePath)) { out.push(e); continue }
    var next = resolve(map, e.filePath)
    if (next == null) { removed++; continue }
    var copy = {}
    for (var k in e) { if (Object.prototype.hasOwnProperty.call(e, k)) copy[k] = e[k] }
    copy.filePath = next
    out.push(copy)
    renamed++
  }
  return { value: out, removed: removed, renamed: renamed }
}

function pruneTrackList(tracks, map) {
  var out = []
  var removed = 0
  var renamed = 0
  for (var i = 0; i < (tracks || []).length; i++) {
    var t = tracks[i]
    // Streams and anything without a path are untouched.
    if (!t || !t.filePath || !has(map, t.filePath)) { out.push(t); continue }
    var next = resolve(map, t.filePath)
    if (next == null) { removed++; continue }
    var copy = {}
    for (var k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) copy[k] = t[k] }
    copy.filePath = next
    out.push(copy)
    renamed++
  }
  return { value: out, removed: removed, renamed: renamed }
}

// An emptied playlist is KEPT. Deleting someone's playlist because its files
// went away is a second, unasked-for destruction.
function prunePlaylists(playlists, map) {
  var out = []
  var affected = []
  var removed = 0
  var renamed = 0
  for (var i = 0; i < (playlists || []).length; i++) {
    var pl = playlists[i]
    if (!pl) continue
    var res = pruneTrackList(pl.tracks, map)
    if (res.removed || res.renamed) {
      affected.push({ id: pl.id, name: pl.name, removed: res.removed, renamed: res.renamed })
    }
    removed += res.removed
    renamed += res.renamed
    var copy = {}
    for (var k in pl) { if (Object.prototype.hasOwnProperty.call(pl, k)) copy[k] = pl[k] }
    copy.tracks = res.value
    out.push(copy)
  }
  return { value: out, affected: affected, removed: removed, renamed: renamed }
}

function pruneSavedQueues(queues, map) {
  var out = []
  var affected = []
  var removed = 0
  var renamed = 0
  for (var i = 0; i < (queues || []).length; i++) {
    var q = queues[i]
    if (!q) continue
    var res = pruneTrackList(q.tracks, map)
    if (res.removed || res.renamed) {
      affected.push({ id: q.id, name: q.name, removed: res.removed, renamed: res.renamed })
    }
    removed += res.removed
    renamed += res.renamed
    var copy = {}
    for (var k in q) { if (Object.prototype.hasOwnProperty.call(q, k)) copy[k] = q[k] }
    copy.tracks = res.value
    // Keep the index inside the shortened list. An emptied queue gets -1, the
    // app's "nothing selected" value -- clamping to 0 against a zero-length
    // array hands every consumer an out-of-bounds index instead.
    if (typeof copy.index === 'number' && copy.index > res.value.length - 1) {
      copy.index = res.value.length ? res.value.length - 1 : -1
    }
    out.push(copy)
  }
  return { value: out, affected: affected, removed: removed, renamed: renamed }
}

function prunePlaybackState(st, map) {
  if (!st || !st.filePath || !has(map, st.filePath)) return { value: st, removed: 0, renamed: 0 }
  var next = resolve(map, st.filePath)
  if (next == null) return { value: null, removed: 1, renamed: 0 }
  return { value: { filePath: next, position: st.position }, removed: 0, renamed: 1 }
}

// One pass over everything, so a caller cannot forget one of the seven.
function pruneAll(snapshot, map) {
  var liked = pruneLikedTracks(snapshot.likedTracks, map)
  var counts = prunePlayCounts(snapshot.playCounts, map)
  var history = prunePlayHistory(snapshot.playHistory, map)
  var playlists = prunePlaylists(snapshot.playlists, map)
  var queues = pruneSavedQueues(snapshot.savedQueues, map)
  var playback = prunePlaybackState(snapshot.playbackState, map)

  return {
    next: {
      likedTracks: liked.value,
      playCounts: counts.value,
      playHistory: history.value,
      playlists: playlists.value,
      savedQueues: queues.value,
      playbackState: playback.value,
    },
    summary: {
      likedTracks: liked.removed,
      playCounts: counts.removed,
      playHistory: history.removed,
      playlists: playlists.affected,
      savedQueues: queues.affected,
      playbackState: playback.removed,
      renamed: liked.renamed + counts.renamed + history.renamed +
               playlists.renamed + queues.renamed + playback.renamed,
      touched: liked.removed + counts.removed + history.removed +
               playlists.removed + queues.removed + playback.removed,
    },
  }
}

// Plain-language report for the snackbar. Only mentions what actually changed.
function describeSummary(summary) {
  if (!summary) return ''
  var bits = []
  if (summary.likedTracks) bits.push(summary.likedTracks + ' liked')
  var pl = (summary.playlists || []).filter(function (p) { return p.removed })
  if (pl.length === 1) bits.push(pl[0].removed + ' from “' + pl[0].name + '”')
  else if (pl.length > 1) bits.push(pl.length + ' playlists')
  var sq = (summary.savedQueues || []).filter(function (q) { return q.removed })
  if (sq.length) bits.push(sq.length + ' saved queue' + (sq.length === 1 ? '' : 's'))
  if (!bits.length) return ''
  return 'Also removed from ' + bits.join(', ')
}

// Named per file on purpose: eight scripts share one global scope, and a bare
// `var API` in each meant every later file overwrote the earlier binding. It
// was latent only because each one reads it on the next line.
var _PapaLibraryPrune = {
  normalizePath: normalizePath,
  buildRemap: buildRemap,
  pruneLikedTracks: pruneLikedTracks,
  prunePlayCounts: prunePlayCounts,
  prunePlayHistory: prunePlayHistory,
  pruneTrackList: pruneTrackList,
  prunePlaylists: prunePlaylists,
  pruneSavedQueues: pruneSavedQueues,
  prunePlaybackState: prunePlaybackState,
  pruneAll: pruneAll,
  describeSummary: describeSummary,
}

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaLibraryPrune
if (typeof window !== 'undefined') window.PapaLibraryPrune = _PapaLibraryPrune
