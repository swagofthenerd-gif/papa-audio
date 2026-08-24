// Library change detection.
//
// The renderer only replaces state.library when it believes something changed,
// and it used to decide that from album ids alone. Deleting a track out of an
// album that still exists left the id list identical, so the signature matched,
// the refresh was skipped, and the deleted song stayed on screen until the user
// navigated away and back. Any signature used to gate a refresh must therefore
// change when the TRACKS change, not only when the album set changes.

function trackPaths(album) {
  var out = []
  var tracks = (album && album.tracks) || []
  for (var i = 0; i < tracks.length; i++) {
    if (tracks[i] && tracks[i].filePath) out.push(String(tracks[i].filePath))
  }
  return out
}

// Cheap order-independent digest. Reordering the same tracks is not a change
// worth tearing the page down for, but adding or removing one is.
function digestPaths(paths) {
  var h = 0
  for (var i = 0; i < paths.length; i++) {
    var p = paths[i]
    var acc = 0
    for (var j = 0; j < p.length; j++) {
      acc = (acc * 31 + p.charCodeAt(j)) | 0
    }
    h = (h + acc) | 0
  }
  return h
}

function albumSignature(album) {
  var paths = trackPaths(album)
  return String(album && album.id) + '.' + paths.length + '.' + digestPaths(paths)
}

function librarySignature(albums) {
  var list = albums || []
  var parts = []
  for (var i = 0; i < list.length; i++) parts.push(albumSignature(list[i]))
  parts.sort()
  return list.length + ':' + parts.join('|')
}

function indexPaths(albums) {
  var out = {}
  var list = albums || []
  for (var i = 0; i < list.length; i++) {
    var paths = trackPaths(list[i])
    for (var j = 0; j < paths.length; j++) out[paths[j]] = list[i].id
  }
  return out
}

function idSet(albums) {
  var out = {}
  var list = albums || []
  for (var i = 0; i < list.length; i++) out[String(list[i].id)] = list[i]
  return out
}

// removedPaths is the input every pruning step needs, so it is produced here
// once rather than re-derived by each caller.
function libraryDiff(prev, next) {
  var before = indexPaths(prev)
  var after = indexPaths(next)
  var removedPaths = []
  var addedPaths = []
  var k
  for (k in before) {
    if (Object.prototype.hasOwnProperty.call(before, k) && !after[k]) removedPaths.push(k)
  }
  for (k in after) {
    if (Object.prototype.hasOwnProperty.call(after, k) && !before[k]) addedPaths.push(k)
  }

  var prevIds = idSet(prev)
  var nextIds = idSet(next)
  var removedAlbums = []
  var addedAlbums = []
  var changedAlbums = []
  for (k in prevIds) {
    if (!Object.prototype.hasOwnProperty.call(prevIds, k)) continue
    if (!nextIds[k]) { removedAlbums.push(k); continue }
    if (albumSignature(prevIds[k]) !== albumSignature(nextIds[k])) changedAlbums.push(k)
  }
  for (k in nextIds) {
    if (Object.prototype.hasOwnProperty.call(nextIds, k) && !prevIds[k]) addedAlbums.push(k)
  }

  return {
    removedPaths: removedPaths.sort(),
    addedPaths: addedPaths.sort(),
    removedAlbums: removedAlbums.sort(),
    addedAlbums: addedAlbums.sort(),
    changedAlbums: changedAlbums.sort(),
    changed: removedPaths.length > 0 || addedPaths.length > 0 ||
             removedAlbums.length > 0 || addedAlbums.length > 0 || changedAlbums.length > 0,
  }
}

var API = {
  trackPaths: trackPaths,
  albumSignature: albumSignature,
  librarySignature: librarySignature,
  indexPaths: indexPaths,
  libraryDiff: libraryDiff,
}

if (typeof module !== 'undefined' && module.exports) module.exports = API
if (typeof window !== 'undefined') window.PapaLibrarySig = API
