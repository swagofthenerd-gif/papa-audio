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
      var albumEntry = {
        type: 'album',
        id: a.id,
        name: aName,
        artist: aArtist,
        artPath: a.artPath || null,
        year: a.year || null,
        tokens: aTokens,
        // artist + album + every distinct song word: the wide field the
        // library grid falls back to, so "supertramp school" finds the album
        // that carries the song even though neither its name nor its artist
        // says "school".
        allTokens: null,
      }
      albums.push(albumEntry)
      vocabRecords.push(combined)
      var trackWordSet = Object.create(null)

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
        var titleTokens = SQ.tokenize(tTitle)
        for (var w = 0; w < titleTokens.length; w++) trackWordSet[titleTokens[w]] = true
        var tTokens = SQ.tokenize(tArtist)
          .concat(titleTokens)
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
      var extra = []
      for (var tw in trackWordSet) extra.push(tw)
      albumEntry.allTokens = extra.length ? aTokens.concat(extra) : aTokens
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
  function _rankList(list, qTokens, limit, field) {
    var f = field || 'tokens'
    var scored = []
    for (var i = 0; i < list.length; i++) {
      var s = SQ.scoreTokens(qTokens, list[i][f] || list[i].tokens)
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

  // The library grid's search: which albums match, in relevance order. Three
  // widening passes, each only when the one before found nothing:
  //   1. artist + album name (what the grid shows),
  //   2. plus every song title on the album (`viaTracks`),
  //   3. the same two again on a vocabulary-corrected query (`corrected`).
  // Returns ids, not album objects, so the caller maps back to its live
  // library array and keeps everything else (year chips, format filters) as
  // plain set intersection.
  function filterAlbums(index, term, opts) {
    opts = opts || {}
    var empty = { ids: [], corrected: null, viaTracks: false, query: term }
    if (!index || !term || !String(term).trim()) return empty
    var qTokens = SQ.tokenize(term)
    if (!qTokens.length) return empty

    var hit = _albumPasses(index, qTokens)
    if (hit) return { ids: hit.ids, corrected: null, viaTracks: hit.viaTracks, query: term }

    if (opts.correct !== false) {
      var fix = SQ.correctQuery(term, index.vocabulary, 3)
      if (fix.corrected && fix.query && fix.query !== SQ.normalize(term)) {
        var cHit = _albumPasses(index, SQ.tokenize(fix.query))
        if (cHit) return { ids: cHit.ids, corrected: { from: term, to: fix.query }, viaTracks: cHit.viaTracks, query: fix.query }
      }
    }
    return empty
  }

  function _albumPasses(index, qTokens) {
    var narrow = _rankList(index.albums, qTokens, 0)
    if (narrow.length) return { ids: narrow.map(function (a) { return a.id }), viaTracks: false }
    var wide = _rankList(index.albums, qTokens, 0, 'allTokens')
    if (wide.length) return { ids: wide.map(function (a) { return a.id }), viaTracks: true }
    return null
  }

  // "Did you mean" that can be acted on. Used when a search found nothing and
  // no single unambiguous correction rescued it: for every query word, take
  // the nearest real words in the library, try the combinations, and keep
  // only the ones that actually FIND something. Each suggestion is a real,
  // runnable query (the tokenized form the scorer understands) plus the best
  // thing it finds as a human label ("Camel — Mirage"). Never the old
  // "Artist — Album" string that could not be searched for.
  var SUGGEST_PER_TOKEN = 3
  var SUGGEST_MAX_COMBOS = 32
  // A suggestion must land on a record that contains its words outright. The
  // scorer's own typo tolerance would otherwise let "calm mirage" claim an
  // album called "All My Rage" — a suggestion nobody meant.
  var SUGGEST_MIN_SCORE = 0.95

  function suggest(index, term, limit) {
    var max = limit > 0 ? limit : 3
    if (!index || !term || !String(term).trim()) return []
    var toks = SQ.tokenize(term)
    if (!toks.length) return []
    var original = toks.join(' ')

    var options = []
    var anyAlternative = false
    for (var i = 0; i < toks.length; i++) {
      var near = SQ.nearestTokens(toks[i], index.vocabulary, 3, SUGGEST_PER_TOKEN)
      var words = near.map(function (n) { return n.word })
      if (!words.length) words = [toks[i]]
      if (words.length > 1 || words[0] !== toks[i]) anyAlternative = true
      options.push(words)
    }
    if (!anyAlternative) return []

    // Enumerate combinations breadth-first-ish (nearest words first because
    // each option list is sorted by distance), capped so a long query with
    // many near words can't explode.
    var combos = [[]]
    for (var t = 0; t < options.length && combos.length <= SUGGEST_MAX_COMBOS; t++) {
      var next = []
      for (var c = 0; c < combos.length; c++) {
        for (var o = 0; o < options[t].length; o++) {
          next.push(combos[c].concat([options[t][o]]))
          if (next.length >= SUGGEST_MAX_COMBOS) break
        }
        if (next.length >= SUGGEST_MAX_COMBOS) break
      }
      combos = next
    }

    var seen = Object.create(null)
    var found = []
    for (var k = 0; k < combos.length; k++) {
      var qs = combos[k].join(' ')
      if (qs === original || seen[qs]) continue
      seen[qs] = true
      var r = _run(index, combos[k], { tracks: 1, albums: 1, artists: 1 })
      var best = null
      if (r.albums.length) best = { score: r.albums[0]._score, label: _joinLabel(r.albums[0].artist, r.albums[0].name) }
      if (r.tracks.length && (!best || r.tracks[0]._score > best.score)) best = { score: r.tracks[0]._score, label: _joinLabel(r.tracks[0].artist, r.tracks[0].title) }
      if (r.artists.length && (!best || r.artists[0]._score > best.score)) best = { score: r.artists[0]._score, label: r.artists[0].name }
      if (best && best.score >= SUGGEST_MIN_SCORE) found.push({ query: qs, label: best.label, score: best.score })
    }
    found.sort(function (a, b) { return b.score - a.score || (a.query < b.query ? -1 : 1) })
    // One suggestion per label: two spellings that land on the same album are
    // one idea, not two.
    var byLabel = Object.create(null)
    var out = []
    for (var f = 0; f < found.length && out.length < max; f++) {
      if (byLabel[found[f].label]) continue
      byLabel[found[f].label] = true
      out.push({ query: found[f].query, label: found[f].label })
    }
    return out
  }

  function _joinLabel(a, b) {
    if (a && b) return a + ' — ' + b
    return a || b || ''
  }

  return {
    build: build,
    query: query,
    filterAlbums: filterAlbums,
    suggest: suggest,
    _rankList: _rankList,
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaLibraryIndex
if (typeof window !== 'undefined') window.PapaLibraryIndex = _PapaLibraryIndex
