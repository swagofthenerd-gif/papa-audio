// Storage 2.0 — the "redundant lossy" finder.
//
// After a lossless copy of an album lands, the old lossy copy of the SAME album
// is usually pure waste: identical music, worse quality, taking space. This finds
// those pairs — albums where the library holds both a lossless and a lossy copy
// of one album identity — and reports how much the lossy copies cost.
//
// Album identity is not string equality: "Kind of Blue" and "Kind Of Blue
// (Remastered)" are the same record filed two ways. So this reuses the exact
// matcher the record shop uses (slsk-shelves' albumComparable / albumsMatch), so
// a redundant pair here is defined by the same identity rule as an upgrade there.
//
// Nothing is deleted. It lists the lossy copies with their sizes and the lossless
// copy that makes each redundant, and the caller feeds the chosen ones through
// the normal confirm-and-trash funnel.

;(function () {
  // A library album is "lossless" if a majority of its tracks are a lossless
  // codec/extension. libAlbumToComparable already computes this from track paths,
  // but we recompute here from whatever fields the album carries so this works on
  // the renderer's album shape directly.
  var LOSSLESS_EXT = /\.(flac|alac|ape|wv|wav|aiff?|dsf|dff)$/i
  var LOSSLESS_CODEC = /^(flac|alac|ape|wavpack|wav|pcm|dsd|dsf|dff|truehd|mlp)/i

  function _trackIsLossless(t) {
    if (!t) return false
    if (t.codec && LOSSLESS_CODEC.test(String(t.codec))) return true
    return LOSSLESS_EXT.test(String(t.filePath || t.path || ''))
  }

  function albumIsLossless(album) {
    var tracks = (album && album.tracks) || []
    if (!tracks.length) return false
    var n = 0
    for (var i = 0; i < tracks.length; i++) if (_trackIsLossless(tracks[i])) n++
    return n >= tracks.length / 2
  }

  function albumBytes(album) {
    var tracks = (album && album.tracks) || []
    var b = 0
    for (var i = 0; i < tracks.length; i++) {
      var s = Number(tracks[i].fileSize || tracks[i].size || 0)
      if (isFinite(s) && s > 0) b += s
    }
    return b
  }

  // `shelves` is window.PapaSlskShelves — injected so this is unit-testable with a
  // tiny fake matcher instead of pulling the whole shelves module into the test.
  // Groups library albums by identity, and within any identity that holds BOTH a
  // lossless and a lossy copy, reports the lossy copies as redundant.
  //
  // Returns {
  //   pairs: [{ lossyAlbum, losslessAlbum, lossyBytes }],  // one per redundant lossy copy
  //   totalReclaimBytes,
  // }
  function findRedundantLossy(library, shelves) {
    library = library || []
    if (!shelves || typeof shelves.albumComparable !== 'function' ||
        typeof shelves.buildLibraryIndex !== 'function') {
      return { pairs: [], totalReclaimBytes: 0 }
    }

    // Split by quality first so we only ask "is there a lossless twin?" for the
    // lossy albums, and index only the lossless side.
    var lossyAlbums = []
    var losslessAlbums = []
    for (var i = 0; i < library.length; i++) {
      var a = library[i]
      if (!a) continue
      if (albumIsLossless(a)) losslessAlbums.push(a)
      else lossyAlbums.push(a)
    }
    if (!lossyAlbums.length || !losslessAlbums.length) {
      return { pairs: [], totalReclaimBytes: 0 }
    }

    // Index the lossless copies by identity (bucketed matcher, O(1)-ish lookup).
    // Pass the raw album objects: buildLibraryIndex calls libAlbumToComparable
    // itself, which sets comp.ref to the album — that ref is how we recover the
    // matched lossless album. (Pre-converting here would strip .tracks and make
    // buildLibraryIndex re-derive from an empty shape, dropping the ref.)
    var index = shelves.buildLibraryIndex(losslessAlbums)

    var pairs = []
    var total = 0
    for (var j = 0; j < lossyAlbums.length; j++) {
      var lossy = lossyAlbums[j]
      var peer = {
        artist: lossy.artist || lossy.albumArtist || '',
        album: lossy.name || lossy.album || '',
      }
      var match = index.findMatch(peer)
      if (!match) continue
      // A same-title lossy AND lossless copy of the same identity: the lossy one
      // is redundant. Its ref is the lossless album object we indexed.
      var bytes = albumBytes(lossy)
      pairs.push({
        lossyAlbum: lossy,
        losslessAlbum: match.ref || null,
        lossyBytes: bytes,
      })
      total += bytes
    }
    // Biggest waste first.
    pairs.sort(function (x, y) { return y.lossyBytes - x.lossyBytes })
    return { pairs: pairs, totalReclaimBytes: total }
  }

  // The file paths of a redundant-lossy result's lossy copies, for the trash
  // funnel. Given the pairs (or a subset the user selected).
  function lossyPathsOf(pairs) {
    var out = []
    for (var i = 0; i < (pairs || []).length; i++) {
      var tracks = (pairs[i].lossyAlbum && pairs[i].lossyAlbum.tracks) || []
      for (var j = 0; j < tracks.length; j++) {
        if (tracks[j].filePath) out.push(tracks[j].filePath)
      }
    }
    return out
  }

  var API = {
    albumIsLossless: albumIsLossless,
    albumBytes: albumBytes,
    findRedundantLossy: findRedundantLossy,
    lossyPathsOf: lossyPathsOf,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = API
  if (typeof window !== 'undefined') window.PapaManageRedundant = API
})()
