'use strict'
// The identity of one thing you watch — an episode, or a film — stated once.
//
// This string is the app's watch identity everywhere: the position store keys
// on it, the diary keys on it, and the rewatch cache on disk keys on it. It
// deliberately says nothing about WHERE the bytes came from, which is what
// makes "don't cache the same episode twice from a different source" a
// one-line check: same episode, same key, already held.
//
// It lived only in the renderer (`_watchKey`), so the main process — which
// owns the cache — had no way to name an episode it had not been handed a key
// for. Caching the NEXT episode ahead needs exactly that, so the rule moved
// here and both sides now speak it.
//
// Canonical form:
//   movie:550
//   tv:1396:s1e5
//   anime:21:e3
//
// A missing season on a `tv` key is written `snull`, not `sundefined`: the
// renderer's own cacheMeta has always stored a missing season as null, so
// `snull` is the form real keys on disk already carry. `undefined` coerced to
// its own spelling was a second name for the same episode — two cache entries
// for one thing.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PapaWatchKey = factory()
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // null and undefined are the same absence and must spell the same.
  function _season(v) { return v == null ? 'null' : String(v) }

  function watchKey(type, id, season, episode) {
    if (type === 'movie') return 'movie:' + id
    if (type === 'tv') return 'tv:' + id + ':s' + _season(season) + 'e' + episode
    return 'anime:' + id + ':e' + episode
  }

  // The reverse, for the main process: it holds a key from the renderer and
  // needs the episode number to name the NEXT one. Returns null for anything
  // that is not one of the three shapes above.
  function parseWatchKey(key) {
    const s = String(key == null ? '' : key)
    let m = /^movie:(.+)$/.exec(s)
    if (m) return { type: 'movie', id: m[1], season: null, episode: null }
    m = /^tv:(.+):s(.*)e(\d+)$/.exec(s)
    if (m) {
      return {
        type: 'tv', id: m[1],
        season: m[2] === 'null' || m[2] === '' ? null : Number(m[2]),
        episode: Number(m[3]),
      }
    }
    m = /^anime:(.+):e(\d+)$/.exec(s)
    if (m) return { type: 'anime', id: m[1], season: null, episode: Number(m[2]) }
    return null
  }


  // Every episode a RealDebrid season pack is holding, as watch keys
  // (instant-play B). A pack is one torrent containing a whole season, so the
  // single resolution the page already performs knows about every episode in
  // it — this turns that file list into the keys the instant index and the
  // episode list both speak.
  //
  // `files` is what debrid.packFiles returns: entries carrying an `episode`
  // number parsed from the filename (null when it could not be read).
  //
  // Fewer than two numbered episodes is not a season. A single-file torrent
  // says nothing the title key did not already say, and badging it as a pack
  // would promise a season that is not there — so it yields nothing rather
  // than a misleading one-entry answer.
  function packEpisodeKeys(opts) {
    opts = opts || {}
    var type = opts.type
    var id = opts.id
    if (!type || id == null || id === '' || type === 'movie') return []
    var files = Array.isArray(opts.files) ? opts.files : []
    var seen = {}
    var out = []
    for (var i = 0; i < files.length; i++) {
      var f = files[i]
      if (!f || f.episode == null) continue
      var n = Number(f.episode)
      if (!isFinite(n) || n < 0) continue
      if (seen[n]) continue
      seen[n] = 1
      out.push({ episode: n, key: watchKey(type, id, opts.season, n) })
    }
    if (out.length < 2) return []
    out.sort(function (a, b) { return a.episode - b.episode })
    return out
  }


  // The watch key a KEPT file answers to — a file saved for offline, living in
  // videoKeepIndex (instant-play: "Download for offline" then Play).
  //
  // Play probes for a local copy by watch key, and that probe only ever
  // searched the rewatch cache. A file downloaded for offline is in the OTHER
  // store, so pressing Play on an episode already sitting on disk started a
  // cold peer download of bytes the user had already paid for — while the card
  // said SAVED.
  //
  // Two writers fill that store and they do not agree:
  //   * the download path records titleKey + season + episode + meta,
  //   * the keep-while-streaming path records only id/title/path/size/keptAt,
  //     and now the session's own `watchKey` — which, being the key itself, is
  //     preferred here over anything reconstructed.
  // An entry carrying neither is unmatchable and yields null rather than a
  // guess: a wrong match would play the wrong episode from disk, which is a
  // worse failure than falling through to the network.
  function keepEntryKey(entry) {
    if (!entry || typeof entry !== 'object') return null
    if (typeof entry.watchKey === 'string' && entry.watchKey) return entry.watchKey
    var tk = typeof entry.titleKey === 'string' ? entry.titleKey : ''
    var at = tk.indexOf(':')
    if (at < 1) return null
    var type = tk.slice(0, at)
    var id = tk.slice(at + 1)
    if (!id) return null
    // A film's title key IS its watch key; there is no episode to find.
    if (type === 'movie') return watchKey('movie', id)
    var ep = entry.episode
    if (ep == null && entry.meta && entry.meta.episode != null) ep = entry.meta.episode
    if (ep == null || !isFinite(Number(ep))) return null
    var season = entry.season
    if (season == null && entry.meta && entry.meta.season != null) season = entry.meta.season
    return watchKey(type, id, season, Number(ep))
  }


  // The kept entries that answer to this watch key, best first. Separated from
  // the disk check so the matching is testable on its own: the caller still
  // has to prove the file is really there before calling it a hit.
  // Newest first — if the same episode was saved twice, the later save is the
  // one the user means.
  function findKept(keeps, key) {
    if (!key) return []
    var list = Array.isArray(keeps) ? keeps : []
    var out = []
    for (var i = 0; i < list.length; i++) {
      var k = list[i]
      if (!k || !k.path) continue
      if (keepEntryKey(k) !== key) continue
      out.push(k)
    }
    out.sort(function (a, b) { return (Number(b.keptAt) || 0) - (Number(a.keptAt) || 0) })
    return out
  }

  return { watchKey, parseWatchKey, packEpisodeKeys, keepEntryKey, findKept }
})
