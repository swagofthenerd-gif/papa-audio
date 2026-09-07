'use strict'
// In-memory library search index — built once when the library loads (and
// rebuilt on rescan) so the global search can rank tracks, albums and artists
// per keystroke without touching the whole library array each time.
//
// The index is three flat entry lists (tracks, albums, artists), each entry
// carrying its pre-tokenized combined field and a display payload the renderer
// can paint directly. Pre-tokenizing at build time is the whole point: the hot
// path (query()) never re-tokenizes a record, only the short query, so a search
// is O(records × query-tokens) with tiny constant factors — a few ms at 10k
// tracks (proven in library-index.test.js's micro-bench).
//
// Pure and DOM-free. Depends only on smart-query for the tokenizer/scorer/
// vocabulary, resolved from module.exports (Node/tests) or the shared global
// (renderer). Named-global export like the other pure modules.

var _PapaLibraryIndex = (function () {

  // Prefer the already-loaded shared global (renderer: smart-query.js runs first
  // via its own <script>) and only fall back to require() in Node/tests. Doing it
  // this way avoids a bundler/Electron quirk where `module` can be defined in the
  // renderer yet a relative require() resolves differently than the script tag.
  var SQ = (typeof window !== 'undefined' && window.PapaSmartQuery)
    ? window.PapaSmartQuery
    : ((typeof module !== 'undefined' && module.exports) ? require('./smart-query') : null)

  // Build the index from state.library (an array of album objects, each with
  // { id, name, artist, year, tracks: [{ title, filePath, artist, ... }] }).
  // Returns an object with the three entry lists, the token vocabulary (for
  // offline correction), and cheap counts. Defensive throughout: a malformed
  // album must not abort the whole build.
  function build(library) {
    var albums = []
    var tracks = []
    var artistMap = Object.create(null)
    var vocabRecords = []

    var lib = Array.isArray(library) ? library : []
    for (var i = 0; i < lib.length; i++) {
      var a = lib[i]
      if (!a || typeof a !== 'object') continue
      var aName = a.name || ''
      var aArtist = a.artist || ''
      var combined = [aArtist, aName]
      var aTokens = SQ.tokenize(aArtist).concat(SQ.tokenize(aName))
      albums.push({
        type: 'album',
        id: a.id,
        name: aName,
        artist: aArtist,
        artPath: a.artPath || null,
        year: a.year || null,
        tokens: aTokens,
      })
      vocabRecords.push(combined)

      // Artists: fold albums into a per-artist entry (first art wins as avatar).
      if (aArtist) {
        var key = aArtist.toLowerCase()
        if (!artistMap[key]) {
          artistMap[key] = {
            type: 'artist',
            name: aArtist,
            artPath: a.artPath || null,
            albumCount: 0,
            tokens: SQ.tokenize(aArtist),
          }
        }
        artistMap[key].albumCount++
        if (!artistMap[key].artPath && a.artPath) artistMap[key].artPath = a.artPath
      }

      // Tracks: each carries artist|title|album so "song band" and "band song"
      // both hit, and a track whose own artist differs from the album artist
      // (compilations, features) still matches on its real artist.
      var tr = Array.isArray(a.tracks) ? a.tracks : []
      for (var j = 0; j < tr.length; j++) {
        var t = tr[j]
        if (!t || typeof t !== 'object') continue
        var tArtist = t.artist || aArtist
        var tTitle = t.title || ''
        var tTokens = SQ.tokenize(tArtist)
          .concat(SQ.tokenize(tTitle))
          .concat(SQ.tokenize(aName))
        tracks.push({
          type: 'track',
          title: tTitle,
          artist: tArtist,
          album: aName,
          albumId: a.id,
          filePath: t.filePath || null,
          duration: t.duration || 0,
          artPath: a.artPath || null,
          tokens: tTokens,
        })
        vocabRecords.push([tArtist, tTitle])
      }
    }

    var artists = []
    for (var kk in artistMap) artists.push(artistMap[kk])

    return {
      albums: albums,
      tracks: tracks,
      artists: artists,
      vocabulary: SQ.buildVocabulary(vocabRecords),
      counts: { albums: albums.length, tracks: tracks.length, artists: artists.length },
      builtAt: Date.now(),
    }
  }

  // Rank one entry list against a set of pre-tokenized query tokens. Returns the
  // top `limit` entries with their score attached, highest first. Ties break on
  // an exact-name preference then alphabetically so results don't jump around.
  function _rankList(list, qTokens, limit) {
    var scored = []
    for (var i = 0; i < list.length; i++) {
      var s = SQ.scoreTokens(qTokens, list[i].tokens)
      if (s > 0) scored.push({ entry: list[i], score: s })
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score
      var an = (a.entry.name || a.entry.title || '')
      var bn = (b.entry.name || b.entry.title || '')
      return an.localeCompare(bn)
    })
    var out = []
    var cap = limit || scored.length
    for (var k = 0; k < scored.length && out.length < cap; k++) {
      var e = scored[k].entry
      out.push(Object.assign({ _score: scored[k].score }, e))
    }
    return out
  }

  // The hot path. Query the index for a term, returning ranked tracks, albums
  // and artists sections plus an optional correction. `opts.limits` caps each
  // section (defaults: tracks 8, albums 5, artists 4). When the raw query finds
  // nothing AND the vocabulary offers an unambiguous fix, the search is re-run
  // against the corrected query and `corrected` describes what happened — the
  // "did you mean, auto-applied" behavior.
  function query(index, term, opts) {
    opts = opts || {}
    var limits = opts.limits || {}
    var empty = { tracks: [], albums: [], artists: [], corrected: null, query: term }
    if (!index || !term || !String(term).trim()) return empty

    var qTokens = SQ.tokenize(term)
    if (!qTokens.length) return empty

    var res = _run(index, qTokens, limits)

    // Zero-hit → try an offline correction against the vocabulary. Only re-run
    // when the correction actually changed something AND it now finds results;
    // a correction that still finds nothing is not worth surfacing.
    if (!res.tracks.length && !res.albums.length && !res.artists.length && opts.correct !== false) {
      // Wider reach (3) than the scorer's typo tolerance (2): the scorer already
      // caught everything within 2, so a genuine zero-hit means the typo is
      // heavier — give correction the extra edit to rescue it.
      var fix = SQ.correctQuery(term, index.vocabulary, 3)
      if (fix.corrected && fix.query && fix.query !== SQ.normalize(term)) {
        var cTokens = SQ.tokenize(fix.query)
        var cRes = _run(index, cTokens, limits)
        if (cRes.tracks.length || cRes.albums.length || cRes.artists.length) {
          cRes.corrected = { from: term, to: fix.query }
          cRes.query = fix.query
          return cRes
        }
      }
    }
    res.corrected = null
    res.query = term
    return res
  }

  function _run(index, qTokens, limits) {
    return {
      tracks: _rankList(index.tracks, qTokens, limits.tracks != null ? limits.tracks : 8),
      albums: _rankList(index.albums, qTokens, limits.albums != null ? limits.albums : 5),
      artists: _rankList(index.artists, qTokens, limits.artists != null ? limits.artists : 4),
      corrected: null,
    }
  }

  return {
    build: build,
    query: query,
    _rankList: _rankList,
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaLibraryIndex
if (typeof window !== 'undefined') window.PapaLibraryIndex = _PapaLibraryIndex
