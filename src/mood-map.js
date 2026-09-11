'use strict'
// Moods for a library that may have no genre tags at all (roadmap R6).
//
// Explore's "How are you feeling?" chips used to map a mood to ONE genre word
// ("energetic" → "rock"), look for an album whose genre tag equalled it, and
// otherwise dump the user onto a music search for the word. Two verified
// breaks: the library filter compares lower-cased genre KEYS while the chip
// wrote the raw casing (zero results), and on the reported install every one
// of 266 albums has an empty genre tag — so no genre map could ever work.
//
// This module grounds a mood in what the app actually knows:
//   1. the audio analysis (audio-features.js) — energy, brightness, dynamics,
//      density, punch per track, measured for thousands of tracks — scored
//      RELATIVE TO THIS LIBRARY (z-scores), so "Energetic" means "the loud,
//      punchy end of what you own", whatever you own;
//   2. genre tags when they exist, split into their parts ("Rock, Progressive"
//      is two genres, "Library" is not one) and matched by keyword.
//
// Pure and DOM-free. Named-global export like the other shared pure modules.

var _PapaMoodMap = (function () {

  var FEATURE_KEYS = ['energy', 'brightness', 'dynamics', 'density', 'punch']

  // Tag junk that is not a genre. Folded into "unknown" everywhere.
  var JUNK = { '': 1, library: 1, music: 1, unknown: 1, other: 1, misc: 1, null: 1, undefined: 1, none: 1, genre: 1 }

  // Each mood: what it looks for in tags, and how it weighs the analysis.
  // Weights are applied to library-relative z-scores and normalised by the
  // sum of their magnitudes, so every mood's score lives on the same scale.
  var MOODS = [
    { id: 'energetic',  name: 'Energetic',  emoji: '⚡',  color: '#e8484a',
      genres: ['rock', 'punk', 'metal', 'electronic', 'dance', 'edm', 'techno', 'house', 'drum', 'hardcore', 'trance', 'garage'],
      weights: { energy: 1.0, punch: 0.8, density: 0.5 } },
    { id: 'chill',      name: 'Chill',      emoji: '🌊',  color: '#3850a0',
      genres: ['ambient', 'chill', 'downtempo', 'lo-fi', 'lofi', 'acoustic', 'folk', 'trip', 'dream', 'bossa', 'new age'],
      weights: { energy: -1.0, punch: -0.8, density: -0.4 } },
    { id: 'focus',      name: 'Focus',      emoji: '🎯',  color: '#2d7a4a',
      genres: ['classical', 'instrumental', 'minimal', 'post-rock', 'piano', 'baroque', 'chamber', 'modern classical', 'soundtrack'],
      weights: { punch: -0.8, dynamics: -0.6, brightness: -0.3, energy: -0.3 } },
    { id: 'happy',      name: 'Happy',      emoji: '😊',  color: '#a07038',
      genres: ['pop', 'funk', 'disco', 'soul', 'reggae', 'ska', 'indie pop', 'motown', 'afrobeat'],
      weights: { brightness: 1.0, energy: 0.3, punch: 0.2 } },
    { id: 'melancholy', name: 'Melancholy', emoji: '🌧️', color: '#5038a0',
      genres: ['blues', 'singer-songwriter', 'shoegaze', 'slowcore', 'sadcore', 'emo', 'folk', 'chamber pop'],
      weights: { brightness: -1.0, energy: -0.6, dynamics: 0.4 } },
    { id: 'romantic',   name: 'Romantic',   emoji: '💝',  color: '#a0405a',
      genres: ['jazz', 'soul', 'r&b', 'rnb', 'bossa', 'lounge', 'vocal', 'crooner', 'ballad'],
      weights: { energy: -0.7, punch: -0.6, dynamics: 0.6, brightness: 0.2 } },
    { id: 'dark',       name: 'Dark',       emoji: '🌑',  color: '#1a1a2a',
      genres: ['metal', 'doom', 'industrial', 'gothic', 'darkwave', 'black', 'sludge', 'drone', 'noise', 'horror'],
      weights: { brightness: -1.0, density: 0.6, energy: 0.3 } },
    { id: 'epic',       name: 'Epic',       emoji: '🏔️', color: '#6b38a0',
      genres: ['soundtrack', 'symphonic', 'progressive', 'prog', 'orchestral', 'post-rock', 'film score', 'score', 'cinematic', 'power metal'],
      weights: { dynamics: 1.0, density: 0.6, energy: 0.6 } },
  ]

  // An album counts for a mood when its analysis score sits in the top
  // SHARE of analysed albums in that mood's direction (and above the library
  // mean), or a genre matches. A share, not a fixed z-score cut: with one
  // fixed cut "Energetic" claimed 155 of 266 albums on the reported install —
  // a mood is the distinctive quarter of what you own, not most of it.
  var SHARE = 0.25

  function moodById(id) {
    for (var i = 0; i < MOODS.length; i++) if (MOODS[i].id === id) return MOODS[i]
    return null
  }

  // "Rock, Progressive Rock / Art Rock" → ['rock', 'progressive rock', 'art rock'].
  // Junk and blanks are dropped; an album with nothing left is 'unknown'.
  function splitGenres(raw) {
    var s = String(raw == null ? '' : raw).toLowerCase()
    var parts = s.split(/[,;/|]+/)
    var out = []
    var seen = Object.create(null)
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/\s+/g, ' ').trim()
      if (!p || JUNK[p] || seen[p]) continue
      seen[p] = true
      out.push(p)
    }
    return out
  }

  // The keys an album files under for the chip bar (at least ['unknown']).
  function genreKeysOf(album) {
    var keys = splitGenres(album && album.genre)
    return keys.length ? keys : ['unknown']
  }

  function genreMatches(album, mood) {
    var keys = splitGenres(album && album.genre)
    if (!keys.length) return false
    for (var i = 0; i < keys.length; i++) {
      for (var j = 0; j < mood.genres.length; j++) {
        if (keys[i].indexOf(mood.genres[j]) !== -1) return true
      }
    }
    return false
  }

  // Mean feature vector over the album's analysed tracks, or null when none
  // is analysed. `features` is { filePath: { vector: {...} } } or
  // { filePath: {...vector} } — both shapes the store has used.
  function albumVector(album, features) {
    if (!album || !features) return null
    var tracks = Array.isArray(album.tracks) ? album.tracks : []
    var sum = {}, n = 0
    for (var k = 0; k < FEATURE_KEYS.length; k++) sum[FEATURE_KEYS[k]] = 0
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i]
      var entry = t && t.filePath ? features[t.filePath] : null
      var v = entry && entry.vector ? entry.vector : entry
      if (!v || typeof v.energy !== 'number') continue
      for (var m = 0; m < FEATURE_KEYS.length; m++) sum[FEATURE_KEYS[m]] += Number(v[FEATURE_KEYS[m]]) || 0
      n++
    }
    if (!n) return null
    var out = {}
    for (var q = 0; q < FEATURE_KEYS.length; q++) out[FEATURE_KEYS[q]] = sum[FEATURE_KEYS[q]] / n
    return out
  }

  // Library-relative normaliser over album vectors: mean and sd per dimension.
  function _normaliser(vectors) {
    var mean = {}, sd = {}
    for (var k = 0; k < FEATURE_KEYS.length; k++) {
      var key = FEATURE_KEYS[k]
      if (!vectors.length) { mean[key] = 0; sd[key] = 1; continue }
      var m = 0
      for (var i = 0; i < vectors.length; i++) m += vectors[i][key]
      m /= vectors.length
      var varc = 0
      for (var j = 0; j < vectors.length; j++) varc += (vectors[j][key] - m) * (vectors[j][key] - m)
      varc /= vectors.length
      var s = Math.sqrt(varc)
      mean[key] = m
      sd[key] = s < 1e-9 ? 1 : s
    }
    return { mean: mean, sd: sd }
  }

  function _score(vec, norm, mood) {
    var num = 0, den = 0
    for (var key in mood.weights) {
      var w = mood.weights[key]
      var z = (vec[key] - norm.mean[key]) / norm.sd[key]
      num += w * z
      den += Math.abs(w)
    }
    return den ? num / den : 0
  }

  // Everything a page needs for one library: per-album vectors, the
  // normaliser, and an `analysed` count for honesty in the empty state.
  function profile(library, features) {
    var albums = Array.isArray(library) ? library : []
    var vectors = []
    var byId = Object.create(null)
    for (var i = 0; i < albums.length; i++) {
      var a = albums[i]
      if (!a || a.id == null) continue
      var v = albumVector(a, features)
      byId[a.id] = v
      if (v) vectors.push(v)
    }
    return { byId: byId, norm: _normaliser(vectors), analysed: vectors.length, total: albums.length }
  }

  // Albums that feel like `moodId`, best first: analysis score (library-
  // relative) or a genre match. Each entry: { album, score, via }.
  function albumsForMood(library, features, moodId, prof) {
    var mood = moodById(moodId)
    if (!mood) return []
    var albums = Array.isArray(library) ? library : []
    var p = prof || profile(library, features)
    var scored = []
    var byGenreOnly = []
    for (var i = 0; i < albums.length; i++) {
      var a = albums[i]
      if (!a || a.id == null) continue
      var v = p.byId[a.id]
      var byGenre = genreMatches(a, mood)
      if (v) scored.push({ album: a, score: _score(v, p.norm, mood), byGenre: byGenre })
      else if (byGenre) byGenreOnly.push({ album: a, score: 0, via: 'genre' })
    }
    scored.sort(function (x, y) { return y.score - x.score })
    var cap = Math.ceil(scored.length * SHARE)
    var out = []
    for (var k = 0; k < scored.length; k++) {
      var s = scored[k]
      var picked = k < cap && s.score > 0
      if (picked) out.push({ album: s.album, score: s.score, via: s.byGenre ? 'both' : 'analysis' })
      else if (s.byGenre) out.push({ album: s.album, score: s.score, via: 'genre' })
    }
    // Analysed picks first (best first), then genre-only albums the analysis
    // has not measured.
    out.sort(function (x, y) { return y.score - x.score })
    return out.concat(byGenreOnly)
  }

  // { moodId: count } for the Explore chips, from one shared profile.
  function moodCounts(library, features) {
    var p = profile(library, features)
    var out = {}
    for (var i = 0; i < MOODS.length; i++) out[MOODS[i].id] = albumsForMood(library, features, MOODS[i].id, p).length
    return out
  }

  return {
    MOODS: MOODS,
    FEATURE_KEYS: FEATURE_KEYS,
    SHARE: SHARE,
    moodById: moodById,
    splitGenres: splitGenres,
    genreKeysOf: genreKeysOf,
    genreMatches: genreMatches,
    albumVector: albumVector,
    profile: profile,
    albumsForMood: albumsForMood,
    moodCounts: moodCounts,
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = _PapaMoodMap
if (typeof window !== 'undefined') window.PapaMoodMap = _PapaMoodMap
