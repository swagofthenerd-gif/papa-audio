// Pure helpers for the music side's Wave-6 features: the sleep-timer fade
// curve, the stats-page aggregations (top albums, plays-per-month), and the
// duplicate-track finder.
//
// These live here, apart from renderer.js, for one reason: they are the parts
// worth testing on their own, and the renderer cannot be required() under
// node. The renderer picks this up as window.PapaMusicTools via <script>; the
// tests use the CommonJS export. One implementation either way, so the two
// never drift.

;(function () {

  // ── Sleep timer: the fade curve ───────────────────────────────────────────
  // When the timer fires we fade the volume down over a few seconds, then pause,
  // then put the volume back where it was — so a person drifting off is not
  // jolted awake by a hard cut, and wakes to the same volume they set.
  //
  // Pure so it can be tested without a clock or an audio engine: given the
  // starting volume, the fade length and how often we can step, it returns the
  // volume level for each tick. The last step is always 0 (silence before the
  // pause), and the first step is always below the start (the fade has begun).
  // No step is ever negative or above the start.
  function sleepFadeSteps(fromVolume, durationMs, stepMs) {
    var from = Number(fromVolume)
    if (!isFinite(from) || from <= 0) return [0]
    if (from > 1) from = 1
    var dur = Number(durationMs)
    var step = Number(stepMs)
    if (!isFinite(dur) || dur <= 0 || !isFinite(step) || step <= 0) return [0]
    var count = Math.max(1, Math.round(dur / step))
    var out = []
    for (var i = 1; i <= count; i++) {
      // Linear ramp from `from` down to 0 across `count` steps. i/count at the
      // last step is exactly 1, so the final value is exactly 0.
      var v = from * (1 - i / count)
      if (v < 0) v = 0
      out.push(Math.round(v * 1000) / 1000)
    }
    return out
  }

  // The preset menu, in one place so the UI and the tests agree on what exists.
  // `mins` of 0 is "end of track" (a mode, not a duration); a negative/absent
  // mins on the cancel entry.
  var SLEEP_PRESETS = [
    { mins: 15,  label: '15 minutes' },
    { mins: 30,  label: '30 minutes' },
    { mins: 45,  label: '45 minutes' },
    { mins: 60,  label: '1 hour' },
    { mins: 90,  label: '1.5 hours' },
    { mins: 120, label: '2 hours' },
    { mins: 0,   label: 'End of track', endOfTrack: true }
  ]

  // ── Queue: clear played ────────────────────────────────────────────────────
  // Drop every track before the current index. The playing track survives and
  // becomes the new head, so playback is untouched. Returns the trimmed queue
  // and its new index; out-of-range indices leave the queue as-is.
  // Queue: clear upcoming (roadmap 004). Drops everything AFTER the current
  // track and leaves the current one — and playback — exactly where they are.
  // This is what "clear the queue" means to a listener mid-song; stopping is a
  // separate, explicit action. With nothing playing there is nothing to keep.
  function clearUpcomingQueue(queue, queueIndex) {
    queue = queue || []
    var idx = Number(queueIndex)
    if (!isFinite(idx) || idx < 0 || idx >= queue.length) return { queue: [], queueIndex: -1 }
    return { queue: queue.slice(0, idx + 1), queueIndex: idx }
  }

  // Album rows: what a wheel event means over a horizontal row (roadmap 005).
  // Ordinary vertical wheeling used to be turned into horizontal movement, so
  // the page could not be scrolled past a row the pointer happened to rest on.
  // Now: a horizontal gesture (trackpad swipe, tilt wheel) and Shift+wheel
  // move the row; plain vertical wheel is left to the page. Returns the number
  // of pixels to scroll the row by, or 0 to leave the event alone.
  function rowWheelDelta(e) {
    if (!e) return 0
    var dy = Number(e.deltaY) || 0, dx = Number(e.deltaX) || 0
    if (e.shiftKey && dy && Math.abs(dy) >= Math.abs(dx)) return dy
    if (Math.abs(dx) > Math.abs(dy)) return dx
    return 0
  }

  function clearPlayedQueue(queue, queueIndex) {
    queue = queue || []
    var idx = Number(queueIndex)
    if (!isFinite(idx) || idx <= 0 || idx >= queue.length) {
      return { queue: queue.slice(), queueIndex: idx < 0 ? -1 : idx }
    }
    return { queue: queue.slice(idx), queueIndex: 0 }
  }

  // ── Stats: top albums by play count ────────────────────────────────────────
  // playCounts is keyed by track filePath. Roll those up to the album that owns
  // each track and rank the albums. Returns up to `limit` entries, each with the
  // album, its total plays, and how many of its tracks were played at all.
  function topAlbumsByPlays(library, playCounts, limit) {
    library = library || []
    playCounts = playCounts || {}
    limit = limit || 10
    var byId = {}
    for (var i = 0; i < library.length; i++) {
      var a = library[i]
      var tracks = a.tracks || []
      var total = 0
      var playedTracks = 0
      for (var j = 0; j < tracks.length; j++) {
        var c = playCounts[tracks[j].filePath] || 0
        if (c > 0) { total += c; playedTracks++ }
      }
      if (total > 0) {
        byId[a.id] = { album: a, plays: total, playedTracks: playedTracks }
      }
    }
    return Object.keys(byId)
      .map(function (id) { return byId[id] })
      .sort(function (x, y) { return y.plays - x.plays })
      .slice(0, limit)
  }

  // ── Stats: plays per month, last N months ──────────────────────────────────
  // Buckets playHistory by calendar month for the last `monthsBack` months,
  // oldest first, so a bar chart reads left-to-right in time. Each bucket knows
  // its key ("2026-04"), a short label ("Apr"), and its play count. `now` is
  // injectable so the test does not depend on the wall clock.
  function playsPerMonth(playHistory, monthsBack, now) {
    playHistory = playHistory || []
    monthsBack = monthsBack || 6
    var ref = now ? new Date(now) : new Date()
    var MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    // Build the ordered list of month buckets, oldest first.
    var buckets = []
    var index = {}
    for (var i = monthsBack - 1; i >= 0; i--) {
      var d = new Date(ref.getFullYear(), ref.getMonth() - i, 1)
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      var b = { key: key, label: MONTH[d.getMonth()], year: d.getFullYear(), plays: 0 }
      index[key] = b
      buckets.push(b)
    }
    for (var k = 0; k < playHistory.length; k++) {
      var ts = playHistory[k] && playHistory[k].ts
      if (!ts) continue
      var pd = new Date(ts)
      var pk = pd.getFullYear() + '-' + String(pd.getMonth() + 1).padStart(2, '0')
      if (index[pk]) index[pk].plays++
    }
    return buckets
  }

  // ── Duplicate finder ───────────────────────────────────────────────────────
  // Two tracks are "the same song" when their normalized artist+title match.
  // Normalization lowercases, strips bracketed junk (feat., remaster tags),
  // punctuation and collapses whitespace — so "Song (Remastered)" and "song"
  // by the same artist collapse together.
  function normalizeForDupe(artist, title) {
    var a = _normPart(artist)
    var t = _normPart(title)
    // A control-char separator (not a space) so "a b" + "c" and "a" + "b c"
    // can never collapse into the same key.
    return a + '\x1f' + t
  }

  function _normPart(v) {
    return String(v == null ? '' : v)
      .toLowerCase()
      // Drop bracketed asides: (feat. X), [remastered], {live}.
      .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
      // "feat"/"ft" runs to end once brackets are gone.
      .replace(/\b(feat|ft|featuring)\b.*$/, ' ')
      // Punctuation to spaces.
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function _extOf(filePath) {
    var p = String(filePath || '')
    var slash = p.lastIndexOf('/')
    var base = slash >= 0 ? p.slice(slash + 1) : p
    var dot = base.lastIndexOf('.')
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  }

  // Groups library tracks that are the same song. A group only counts as a
  // duplicate when it holds two or more DISTINCT files (same file listed twice —
  // e.g. one track that lives in two albums — is not a duplicate). Each entry
  // carries the fields the UI shows: format, a rough quality string, size.
  // Sorted so the biggest reclaimable groups surface first.
  function findDuplicateTracks(library) {
    library = library || []
    var groups = {}
    for (var i = 0; i < library.length; i++) {
      var a = library[i]
      var tracks = a.tracks || []
      for (var j = 0; j < tracks.length; j++) {
        var t = tracks[j]
        if (!t.filePath) continue
        var artist = t.albumArtist || t.artist || a.artist || ''
        var title = t.title || ''
        if (!title) continue
        var key = normalizeForDupe(artist, title)
        if (!groups[key]) {
          groups[key] = { key: key, artist: artist, title: title, entries: [] }
        }
        groups[key].entries.push({
          filePath: t.filePath,
          albumName: a.name || t.albumName || '',
          format: _extOf(t.filePath).toUpperCase() || 'UNKNOWN',
          sampleRate: t.sampleRate || 0,
          bitsPerSample: t.bitsPerSample || 0,
          channels: t.channels || 0,
          size: t.fileSize || t.size || 0,
          duration: t.duration || 0,
          quality: _qualityStr(t)
        })
      }
    }
    var out = []
    Object.keys(groups).forEach(function (key) {
      var g = groups[key]
      // Distinct files only: dedupe by path so a track shared across two album
      // records does not masquerade as a duplicate of itself.
      var seen = {}
      var distinct = []
      for (var m = 0; m < g.entries.length; m++) {
        var e = g.entries[m]
        if (seen[e.filePath]) continue
        seen[e.filePath] = true
        distinct.push(e)
      }
      if (distinct.length >= 2) {
        g.entries = distinct
        g.wastedBytes = _wastedBytes(distinct)
        out.push(g)
      }
    })
    // Most files first, then most reclaimable size — the worst offenders lead.
    return out.sort(function (x, y) {
      if (y.entries.length !== x.entries.length) return y.entries.length - x.entries.length
      return (y.wastedBytes || 0) - (x.wastedBytes || 0)
    })
  }

  function _qualityStr(t) {
    var bd = t.bitsPerSample || 0
    var sr = t.sampleRate || 0
    if (!bd && !sr) return ''
    var parts = []
    if (bd) parts.push(bd + '-bit')
    if (sr) parts.push((Math.round(sr / 100) / 10) + 'kHz')
    return parts.join('/')
  }

  // Everything but the single largest file in a group is "wasted" — a rough
  // figure for how much a purge could reclaim if the best copy were kept.
  function _wastedBytes(entries) {
    if (entries.length < 2) return 0
    var sizes = entries.map(function (e) { return e.size || 0 })
    var total = sizes.reduce(function (s, x) { return s + x }, 0)
    var max = Math.max.apply(null, sizes)
    return Math.max(0, total - max)
  }

  // ── Radio: mining the play history for artist adjacency ────────────────────
  // Two artists are "adjacent" when they get played close together in time —
  // the same listening session. We slice the play history into sessions (a gap
  // longer than `gapMs` starts a new one) and, within each session, count every
  // ordered-agnostic pair of *distinct* artists that co-occur. The result is a
  // map: for a given seed artist, which other artists sit next to it, and how
  // strongly (how many sessions they shared).
  //
  // Pure and history-only so it can be tested without the library or a clock.
  // `history` entries need a `ts` (ms) and an `artist`; anything missing either
  // is skipped. Newest-or-oldest order does not matter — we sort by ts first.
  function buildArtistAdjacency(history, gapMs) {
    history = history || []
    gapMs = Number(gapMs) > 0 ? Number(gapMs) : 30 * 60 * 1000 // 30 min default
    // Keep only usable rows, then order by time so gaps mean what we think.
    var rows = []
    for (var i = 0; i < history.length; i++) {
      var h = history[i]
      var ts = h && Number(h.ts)
      var artist = h && h.artist
      if (!isFinite(ts) || !ts || !artist) continue
      rows.push({ ts: ts, artist: String(artist) })
    }
    rows.sort(function (a, b) { return a.ts - b.ts })

    // Split into sessions on a time gap.
    var sessions = []
    var cur = null
    var lastTs = null
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j]
      if (cur === null || (r.ts - lastTs) > gapMs) {
        cur = []
        sessions.push(cur)
      }
      cur.push(r.artist)
      lastTs = r.ts
    }

    // For each session, count each unordered pair of distinct artists once.
    var adj = {}
    function bump(a, b) {
      if (!adj[a]) adj[a] = {}
      adj[a][b] = (adj[a][b] || 0) + 1
    }
    for (var s = 0; s < sessions.length; s++) {
      // Distinct artists in this session.
      var seen = {}
      var uniq = []
      for (var k = 0; k < sessions[s].length; k++) {
        var name = sessions[s][k]
        if (!seen[name]) { seen[name] = true; uniq.push(name) }
      }
      for (var p = 0; p < uniq.length; p++) {
        for (var q = p + 1; q < uniq.length; q++) {
          bump(uniq[p], uniq[q])
          bump(uniq[q], uniq[p])
        }
      }
    }
    return adj
  }

  // Given the adjacency map from buildArtistAdjacency, return the artists that
  // co-occur most often with `seedArtist`, strongest first, up to `limit`.
  // Returns [{ artist, weight }]. Empty when the seed has no neighbours.
  function neighborsOf(adjacency, seedArtist, limit) {
    adjacency = adjacency || {}
    limit = limit || 20
    var row = adjacency[seedArtist]
    if (!row) return []
    return Object.keys(row)
      .map(function (a) { return { artist: a, weight: row[a] } })
      .sort(function (x, y) { return y.weight - x.weight })
      .slice(0, limit)
  }

  // ── Radio: weighted pick without repeats ───────────────────────────────────
  // A track's weight is `1 + playCount` (so an unplayed track still has a
  // chance, and a favourite is proportionally more likely). Deterministic when
  // handed a `rng` returning [0,1); the app passes Math.random, the tests pass
  // a stub. Returns the chosen index, or -1 when the pool is empty.
  function weightedPickIndex(weights, rng) {
    weights = weights || []
    if (!weights.length) return -1
    var total = 0
    for (var i = 0; i < weights.length; i++) {
      var w = Number(weights[i])
      total += (isFinite(w) && w > 0) ? w : 0
    }
    if (total <= 0) {
      // All-zero weights: fall back to a uniform pick so we never stall.
      var r0 = (rng ? rng() : Math.random())
      return Math.min(weights.length - 1, Math.floor(r0 * weights.length))
    }
    var r = (rng ? rng() : Math.random()) * total
    for (var j = 0; j < weights.length; j++) {
      var wj = Number(weights[j])
      wj = (isFinite(wj) && wj > 0) ? wj : 0
      r -= wj
      if (r < 0) return j
    }
    return weights.length - 1
  }

  // ── Radio: composing the endless queue ─────────────────────────────────────
  // Fills up to `count` tracks for artist radio. `seedTracks` are the seed
  // artist's own tracks; `mixTracks` are tracks by co-occurring artists (the
  // caller assembles those from the adjacency neighbours). About `mixRatio` of
  // the picks come from the mix pool, the rest from the seed pool — but if one
  // pool is exhausted we draw entirely from the other rather than stall.
  //
  // `recentPaths` is the no-repeat window (the last N filePaths played): no
  // track whose filePath is in it, and no track already chosen in this batch,
  // is picked twice. Each track object must carry `filePath`; `playCount` is
  // optional and drives the weighting. `rng` is injectable for tests.
  //
  // Returns the array of chosen track objects (may be shorter than `count` if
  // the pools run dry). Pure: it neither reads nor writes any global.
  function composeRadioBatch(opts) {
    opts = opts || {}
    var seedTracks = opts.seedTracks || []
    var mixTracks = opts.mixTracks || []
    var count = opts.count || 20
    var mixRatio = (opts.mixRatio != null) ? opts.mixRatio : 0.30
    var recentPaths = opts.recentPaths || []
    var rng = opts.rng || Math.random

    // The exclusion set: recent window plus what we pick as we go.
    var taken = {}
    for (var i = 0; i < recentPaths.length; i++) taken[recentPaths[i]] = true

    // Build a fresh pickable pool (filtered against `taken`) on demand — cheaper
    // than rescanning the whole pool each pick for large libraries would be, but
    // correctness first: we rebuild the candidate list each iteration because
    // `taken` grows. Pools here are the artist's tracks + neighbours' tracks,
    // which are small relative to the whole library, so this stays cheap.
    function pickFrom(pool) {
      var cand = []
      for (var k = 0; k < pool.length; k++) {
        var t = pool[k]
        if (t && t.filePath && !taken[t.filePath]) cand.push(t)
      }
      if (!cand.length) return null
      var weights = cand.map(function (t) { return 1 + (Number(t.playCount) || 0) })
      var idx = weightedPickIndex(weights, rng)
      if (idx < 0) return null
      var chosen = cand[idx]
      taken[chosen.filePath] = true
      return chosen
    }

    var out = []
    var guard = 0
    while (out.length < count && guard < count * 8) {
      guard++
      var useMix = (rng() < mixRatio)
      var pick = null
      if (useMix) {
        pick = pickFrom(mixTracks) || pickFrom(seedTracks)
      } else {
        pick = pickFrom(seedTracks) || pickFrom(mixTracks)
      }
      if (!pick) break // both pools exhausted
      out.push(pick)
    }
    return out
  }

  // The rolling no-repeat window: append the newly played path and keep only the
  // last `size`. Pure so the renderer's radio state and the tests share it.
  function pushRecent(recentPaths, filePath, size) {
    recentPaths = (recentPaths || []).slice()
    size = size || 50
    if (filePath) recentPaths.push(filePath)
    if (recentPaths.length > size) recentPaths = recentPaths.slice(recentPaths.length - size)
    return recentPaths
  }

  // ── Storage dashboard: aggregating library size ────────────────────────────
  // Rolls the library up into a storage picture: total bytes by file format
  // (FLAC/MP3/…), the largest albums, and the Downloads-folder subset.
  //
  // HONEST LIMITATION: per-track byte size only exists in the library cache when
  // the scanner recorded it (`fileSize`/`size`). Where it is absent we count the
  // track toward its format's *track count* but contribute 0 bytes, and we set
  // `.partial` on the result so the UI can say "sizes are approximate — N tracks
  // have no recorded size" rather than quietly under-reporting. We aggregate
  // what IS there; we do not stat the disk (no fs access in the renderer, and
  // this must stay a pure helper).
  function storageByFormat(library) {
    library = library || []
    var byFmt = {}
    var tracksWithSize = 0
    var tracksMissingSize = 0
    var totalBytes = 0
    for (var i = 0; i < library.length; i++) {
      var tracks = library[i].tracks || []
      for (var j = 0; j < tracks.length; j++) {
        var t = tracks[j]
        var fmt = _extOf(t.filePath).toUpperCase() || 'UNKNOWN'
        var size = Number(t.fileSize || t.size || 0)
        if (!byFmt[fmt]) byFmt[fmt] = { format: fmt, bytes: 0, tracks: 0 }
        byFmt[fmt].tracks++
        if (isFinite(size) && size > 0) {
          byFmt[fmt].bytes += size
          totalBytes += size
          tracksWithSize++
        } else {
          tracksMissingSize++
        }
      }
    }
    var rows = Object.keys(byFmt).map(function (f) { return byFmt[f] })
      .sort(function (a, b) { return b.bytes - a.bytes || b.tracks - a.tracks })
    return {
      formats: rows,
      totalBytes: totalBytes,
      tracksWithSize: tracksWithSize,
      tracksMissingSize: tracksMissingSize,
      partial: tracksMissingSize > 0
    }
  }

  // Largest albums by summed track size, up to `limit`. Albums with no recorded
  // sizes fall to the bottom (0 bytes) rather than being dropped, so the list is
  // never mysteriously short; each row also reports how many of its tracks had a
  // known size, for the same honesty as storageByFormat.
  function largestAlbums(library, limit) {
    library = library || []
    limit = limit || 10
    var rows = []
    for (var i = 0; i < library.length; i++) {
      var a = library[i]
      var tracks = a.tracks || []
      var bytes = 0
      var sized = 0
      for (var j = 0; j < tracks.length; j++) {
        var s = Number(tracks[j].fileSize || tracks[j].size || 0)
        if (isFinite(s) && s > 0) { bytes += s; sized++ }
      }
      rows.push({ album: a, bytes: bytes, trackCount: tracks.length, sizedTracks: sized })
    }
    return rows
      .sort(function (x, y) { return y.bytes - x.bytes })
      .slice(0, limit)
  }

  // The Downloads-folder subset: tracks whose path sits under a "/Downloads/"
  // segment (case-insensitive). Reports its count and summed size, so the
  // dashboard can show how much of the library is un-filed downloads. Matching
  // on the path segment, not a prefix, so it works regardless of where the music
  // root is mounted.
  function downloadsSubset(library) {
    library = library || []
    var count = 0
    var bytes = 0
    var re = /(^|\/)downloads(\/|$)/i
    for (var i = 0; i < library.length; i++) {
      var tracks = library[i].tracks || []
      for (var j = 0; j < tracks.length; j++) {
        var t = tracks[j]
        if (!t.filePath || !re.test(t.filePath)) continue
        count++
        var s = Number(t.fileSize || t.size || 0)
        if (isFinite(s) && s > 0) bytes += s
      }
    }
    return { count: count, bytes: bytes }
  }

  // ── Alarm: time math ───────────────────────────────────────────────────────
  // Given "HH:MM" and a reference `now`, return the ms until the next time the
  // clock reads that — today if it is still ahead, else tomorrow. Pure and
  // now-injectable so the tests do not wait on a wall clock. Returns null for a
  // malformed time string.
  function msUntilAlarm(hhmm, now) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
    if (!m) return null
    var hh = Number(m[1]); var mm = Number(m[2])
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
    var ref = now != null ? new Date(now) : new Date()
    var target = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hh, mm, 0, 0)
    if (target.getTime() <= ref.getTime()) {
      // Already passed (or exactly now) — schedule for tomorrow.
      target = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1, hh, mm, 0, 0)
    }
    return target.getTime() - ref.getTime()
  }

  // The fade-UP curve for the alarm: rise from 0 to `targetVolume` over
  // `durationMs`, stepping every `stepMs`. Mirror image of sleepFadeSteps — the
  // first step is above 0 (the fade has begun) and the last is exactly the
  // target (fully faded in). Never exceeds the target, never negative.
  function alarmFadeSteps(targetVolume, durationMs, stepMs) {
    var target = Number(targetVolume)
    if (!isFinite(target) || target <= 0) return [0]
    if (target > 1) target = 1
    var dur = Number(durationMs)
    var step = Number(stepMs)
    if (!isFinite(dur) || dur <= 0 || !isFinite(step) || step <= 0) return [target]
    var count = Math.max(1, Math.round(dur / step))
    var out = []
    for (var i = 1; i <= count; i++) {
      var v = target * (i / count)
      if (v > target) v = target
      out.push(Math.round(v * 1000) / 1000)
    }
    return out
  }

  // ── Smart playlists: a rule-based virtual-playlist engine ──────────────────
  // A "smart list" is not a stored set of tracks; it is a rule evaluated live
  // against the library and the play data every time it is opened. Each smart
  // list is { id, name, rule } where `rule` is a small declarative object the
  // engine below knows how to run. Keeping the rules declarative (data, not
  // closures) means custom user-defined rules can be added later — and saved to
  // disk — without changing the engine.
  //
  // A rule is one of:
  //   { type: 'recentlyAdded', days: 30 }         — added within the last N days
  //   { type: 'neverPlayed' }                     — zero plays
  //   { type: 'mostPlayed', limit: 50 }           — top-N by play count
  //   { type: 'lossless' }                        — FLAC/WAV/ALAC/AIFF only
  //   { type: 'and', rules: [ ... ] }             — every child matches
  //   { type: 'or',  rules: [ ... ] }             — any child matches
  //
  // The four built-ins are exported as SMART_PLAYLISTS so the UI and the tests
  // agree on what ships.
  var LOSSLESS_EXTS = { flac: 1, wav: 1, alac: 1, aiff: 1, aif: 1, ape: 1, wv: 1 }

  var SMART_PLAYLISTS = [
    { id: 'smart-recent',   name: 'Recently added', icon: '✨',
      rule: { type: 'recentlyAdded', days: 30 } },
    { id: 'smart-unplayed', name: 'Never played',   icon: '○',
      rule: { type: 'neverPlayed' } },
    { id: 'smart-top',      name: 'Most played',    icon: '★',
      rule: { type: 'mostPlayed', limit: 50 } },
    { id: 'smart-lossless', name: 'Lossless only',  icon: '◆',
      rule: { type: 'lossless' } }
  ]

  // Flatten the library into a flat list of track rows, each carrying a back-
  // pointer to its owning album plus the derived per-track facts the rules need
  // (play count, added timestamp, format). The renderer's track objects and the
  // album records both vary in which fields they carry, so we read defensively.
  function _flattenTracks(library, playCounts) {
    library = library || []
    playCounts = playCounts || {}
    var rows = []
    for (var i = 0; i < library.length; i++) {
      var a = library[i]
      var tracks = a.tracks || []
      for (var j = 0; j < tracks.length; j++) {
        var t = tracks[j]
        if (!t || !t.filePath) continue
        rows.push({
          track: t,
          album: a,
          filePath: t.filePath,
          plays: Number(playCounts[t.filePath]) || 0,
          // "Added" can live on the track or be inherited from the album scan.
          addedAt: Number(t.addedAt || t.dateAdded || t.mtime ||
            a.addedAt || a.dateAdded || 0) || 0,
          format: _extOf(t.filePath)
        })
      }
    }
    return rows
  }

  // Does one flattened row satisfy a rule? `now` is injectable for the time-
  // based rules so tests do not depend on the wall clock. Unknown rule types
  // match nothing (fail closed) rather than everything.
  function _rowMatchesRule(row, rule, now) {
    if (!rule || !rule.type) return false
    switch (rule.type) {
      case 'lossless':
        return !!LOSSLESS_EXTS[row.format]
      case 'neverPlayed':
        return row.plays <= 0
      case 'recentlyAdded': {
        var days = Number(rule.days) > 0 ? Number(rule.days) : 30
        if (!row.addedAt) return false
        var ref = now != null ? Number(now) : Date.now()
        return (ref - row.addedAt) <= days * 24 * 60 * 60 * 1000 && row.addedAt <= ref
      }
      case 'mostPlayed':
        // Ranking is handled after filtering (see evaluateSmartPlaylist); at the
        // row level, only played tracks are eligible.
        return row.plays > 0
      case 'and': {
        var ar = rule.rules || []
        for (var i = 0; i < ar.length; i++) {
          if (!_rowMatchesRule(row, ar[i], now)) return false
        }
        return ar.length > 0
      }
      case 'or': {
        var or = rule.rules || []
        for (var k = 0; k < or.length; k++) {
          if (_rowMatchesRule(row, or[k], now)) return true
        }
        return false
      }
      default:
        return false
    }
  }

  // Run a smart-list rule against the library and play data, returning the
  // matching track objects (the renderer's own track shape, ready to drop into a
  // track-list view). `mostPlayed` is special: it ranks by play count and takes
  // the top `limit`. `recentlyAdded` sorts newest first. Everything else keeps
  // library order. Pure; `now` injectable.
  function evaluateSmartPlaylist(rule, library, playCounts, now) {
    var rows = _flattenTracks(library, playCounts)
    var matched = []
    for (var i = 0; i < rows.length; i++) {
      if (_rowMatchesRule(rows[i], rule, now)) matched.push(rows[i])
    }
    if (rule && rule.type === 'mostPlayed') {
      matched.sort(function (x, y) { return y.plays - x.plays })
      var lim = Number(rule.limit) > 0 ? Number(rule.limit) : 50
      matched = matched.slice(0, lim)
    } else if (rule && rule.type === 'recentlyAdded') {
      matched.sort(function (x, y) { return y.addedAt - x.addedAt })
    }
    return matched.map(function (r) { return r.track })
  }

  // ── Missing-track detector: gaps in album track numbering ──────────────────
  // Scans an album's tracks for holes in the disc's track sequence: an album
  // that has 1,2,3,5 is missing 4. We trust `trackNumber` metadata where it is
  // present. To avoid crying "gap" on an album we barely have (a stray single
  // dropped in a folder), we only call a gap when at least `minPresentRatio`
  // (default 60%) of the run from 1..max is actually present.
  //
  // Returns { missing: [4], present: [1,2,3,5], max: 5, coverage: 0.8 } for an
  // album that qualifies, or null when the album is too sparse to judge or has
  // no usable track numbers.
  function _trackNumberOf(t) {
    if (t == null) return 0
    var raw = t.trackNumber != null ? t.trackNumber
      : (t.track != null ? t.track : (t.no != null ? t.no : null))
    if (raw == null) return 0
    // Accept "5", 5, or "5/12" (number-of-total) forms.
    var m = /^\s*(\d+)/.exec(String(raw))
    return m ? Number(m[1]) : 0
  }

  function albumGaps(album, minPresentRatio) {
    if (!album || !album.tracks || !album.tracks.length) return null
    var ratio = (minPresentRatio != null) ? Number(minPresentRatio) : 0.6
    if (!isFinite(ratio) || ratio <= 0) ratio = 0.6
    var nums = {}
    var max = 0
    var counted = 0
    for (var i = 0; i < album.tracks.length; i++) {
      var n = _trackNumberOf(album.tracks[i])
      if (n > 0) {
        if (!nums[n]) counted++
        nums[n] = true
        if (n > max) max = n
      }
    }
    // Need real numbering to judge; a single-track "album" has no sequence.
    if (max < 2 || counted < 2) return null
    var present = []
    var missing = []
    for (var k = 1; k <= max; k++) {
      if (nums[k]) present.push(k)
      else missing.push(k)
    }
    var coverage = present.length / max
    if (!missing.length) return null // complete, nothing to report
    if (coverage < ratio) return null // too sparse to trust as "incomplete"
    return { missing: missing, present: present, max: max, coverage: coverage }
  }

  // Sweep the whole library and return the incomplete albums, each with its
  // album record and the gap detail, worst (most missing) first. `minPresentRatio`
  // threads through to albumGaps.
  function incompleteAlbums(library, minPresentRatio) {
    library = library || []
    var out = []
    for (var i = 0; i < library.length; i++) {
      var g = albumGaps(library[i], minPresentRatio)
      if (g) out.push({ album: library[i], missing: g.missing, present: g.present,
        max: g.max, coverage: g.coverage })
    }
    return out.sort(function (x, y) {
      if (y.missing.length !== x.missing.length) return y.missing.length - x.missing.length
      return y.max - x.max
    })
  }

  // ── Playlist import: parsing pasted "Artist - Title" lines ─────────────────
  // People paste track lists from all over — one per line, mostly
  // "Artist - Title", but plenty come in "Title - Artist" too. We parse
  // defensively: split each line on the first " - " (also tolerating an en/em
  // dash), and keep BOTH interpretations as candidates so the matcher can try
  // each against the library. Lines with no separator become a single free-text
  // candidate (matched against title alone). Blank lines and obvious headers are
  // skipped. Numeric "1." / "01)" leaders are stripped.
  //
  // Returns [{ raw, candidates: [{ artist, title }, ...] }]. Order preserved.
  function parseImportLines(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/)
    var out = []
    var SEP = /\s+[-–—]\s+/ // " - ", " – ", " — "
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i]
      var line = raw.replace(/^\s*\d+\s*[.)\]]\s*/, '').trim() // strip "1." / "01)"
      if (!line) continue
      var parts = line.split(SEP)
      var cands = []
      if (parts.length >= 2) {
        var left = parts[0].trim()
        // Everything after the first separator is the "other" half (handles
        // titles that themselves contain " - ").
        var right = parts.slice(1).join(' - ').trim()
        if (left && right) {
          cands.push({ artist: left, title: right })  // "Artist - Title"
          cands.push({ artist: right, title: left })  // "Title - Artist"
        }
      }
      if (!cands.length) {
        // No separator (or empty halves): treat the whole line as a title.
        cands.push({ artist: '', title: line })
      }
      out.push({ raw: raw.trim(), candidates: cands })
    }
    return out
  }

  // Build a fast lookup of the library keyed by normalized "artist + title",
  // reusing the dupe-finder normalization so import matching and dupe detection
  // agree on what "the same song" means. The value is the renderer's track
  // object (with its album back-reference attached under `_album`) so a matched
  // line yields a playable track.
  function buildLibraryIndex(library) {
    library = library || []
    var index = {}
    var titleOnly = {}
    for (var i = 0; i < library.length; i++) {
      var a = library[i]
      var tracks = a.tracks || []
      for (var j = 0; j < tracks.length; j++) {
        var t = tracks[j]
        if (!t || !t.title) continue
        var artist = t.albumArtist || t.artist || a.artist || ''
        var key = normalizeForDupe(artist, t.title)
        if (!index[key]) index[key] = t
        // Title-only fallback for lines that gave us no artist.
        var tk = _normPart(t.title)
        if (tk && !titleOnly[tk]) titleOnly[tk] = t
      }
    }
    return { byArtistTitle: index, byTitle: titleOnly }
  }

  // Match parsed import lines against a library index. For each line, try every
  // candidate interpretation (both "Artist - Title" and "Title - Artist"); the
  // first candidate that hits the library wins. An artist-less candidate falls
  // back to a title-only match. Returns { matched, misses }:
  //   matched — the library track objects, in input order, de-duplicated
  //   misses  — the { raw } lines that found nothing, so the UI can offer a
  //             one-click Soulseek search per miss.
  function matchImportedTracks(parsedLines, index) {
    parsedLines = parsedLines || []
    index = index || { byArtistTitle: {}, byTitle: {} }
    var byAT = index.byArtistTitle || {}
    var byT = index.byTitle || {}
    var matched = []
    var misses = []
    var seenPath = {}
    for (var i = 0; i < parsedLines.length; i++) {
      var line = parsedLines[i]
      var cands = line.candidates || []
      var hit = null
      for (var c = 0; c < cands.length; c++) {
        var cand = cands[c]
        if (cand.artist) {
          var key = normalizeForDupe(cand.artist, cand.title)
          if (byAT[key]) { hit = byAT[key]; break }
        } else {
          var tk = _normPart(cand.title)
          if (tk && byT[tk]) { hit = byT[tk]; break }
        }
      }
      if (hit) {
        var p = hit.filePath || (matched.length + ':' + (hit.title || ''))
        if (!seenPath[p]) { seenPath[p] = true; matched.push(hit) }
      } else {
        misses.push({ raw: line.raw })
      }
    }
    return { matched: matched, misses: misses }
  }

  // ── Cover-art sweep: which albums are missing art (App #61) ────────────────
  // An album "needs art" when it carries no local artPath. We sweep the library
  // for those and hand back up to `limit` of them (default 20) so a run stays
  // polite — the caller fetches sequentially with a delay between requests.
  //
  // Streamed/YouTube "albums" have an http artPath (or none we can cache to a
  // file), and an album with no id cannot be cached under one, so both are
  // skipped: a fetch for them could never land in the on-disk cache anyway.
  // Pure so the selection is testable without the library or the network.
  function albumsMissingArt(library, limit) {
    library = library || []
    limit = (limit != null && Number(limit) > 0) ? Number(limit) : 20
    var out = []
    for (var i = 0; i < library.length && out.length < limit; i++) {
      var a = library[i]
      if (!a || !a.id) continue
      var art = a.artPath
      // A missing/empty artPath is the target. A remote (http) artPath is not a
      // local cover and is treated as "has art" — we do not refetch it.
      if (art && String(art).length) continue
      out.push(a)
    }
    return out
  }

  // ── Synced lyrics: a pure LRC parser (App #57) ─────────────────────────────
  // "[mm:ss.xx]text" lines → [{ time, text }] sorted by time; null when the
  // text carries no timestamps at all (i.e. it is plain, not synced). Standard
  // LRC stacks repeated timestamps on one line to repeat a chorus:
  //   [00:10.00][01:20.00][02:30.00]the same words
  // so every leading timestamp is consumed and yields its own entry. This
  // mirrors the main-process parser in lyrics.js on purpose: the renderer can
  // parse a saved/pasted LRC itself with the same rules, and the tests pin the
  // behaviour in one place both sides agree on.
  var _LRC_STAMP = /^\s*\[(\d+):(\d+(?:[.:]\d+)?)\]/
  function parseLrc(lrc) {
    if (!lrc) return null
    var lines = []
    var raw = String(lrc).split('\n')
    for (var i = 0; i < raw.length; i++) {
      var rest = raw[i]
      var times = []
      for (;;) {
        var m = rest.match(_LRC_STAMP)
        if (!m) break
        // Some files write [mm:ss:cc] instead of [mm:ss.cc].
        var secs = parseFloat(String(m[2]).replace(':', '.'))
        var time = parseInt(m[1], 10) * 60 + secs
        if (!isNaN(time)) times.push(time)
        rest = rest.slice(m[0].length)
      }
      if (!times.length) continue // metadata ([ar:...]) and blank lines fall out
      // Strip inline word timings <00:12.34> then trim.
      var text = rest.replace(/<[^>]*>/g, '').trim()
      for (var t = 0; t < times.length; t++) lines.push({ time: times[t], text: text })
    }
    if (!lines.length) return null
    return lines.sort(function (a, b) { return a.time - b.time })
  }

  // Which synced line is active at playback position `t` (seconds): the last
  // line whose timestamp has been reached. Returns -1 before the first line.
  // Pure and side-effect-free; the panel uses the index to move the highlight.
  function activeLyricIndex(lines, t) {
    lines = lines || []
    var pos = Number(t)
    if (!isFinite(pos)) return -1
    var idx = -1
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] && lines[i].time <= pos) idx = i
      else break
    }
    return idx
  }

  // ── Crossfade per playlist: resolving the effective setting (App #51) ──────
  // A playlist may carry an optional `crossfade` override:
  //   undefined | null | 'inherit'  → use the global setting unchanged
  //   'off' | 0                      → gapless (no crossfade) for this playlist
  //   a positive number (seconds)    → crossfade at that length
  // Given the global player config { mode, crossfadeSecs } and a playlist's
  // override, this returns the player config that SHOULD be in force while that
  // playlist plays: { mode, crossfadeSecs }. Pure so the apply/revert logic in
  // the renderer can be reasoned about and tested without the audio engine.
  function resolvePlaylistCrossfade(globalCfg, override) {
    globalCfg = globalCfg || {}
    var gMode = globalCfg.mode === 'crossfade' ? 'crossfade' : 'gapless'
    var gSecs = Number(globalCfg.crossfadeSecs)
    if (!isFinite(gSecs) || gSecs <= 0) gSecs = 4
    // Inherit: hand the global config straight back.
    if (override == null || override === 'inherit') {
      return { mode: gMode, crossfadeSecs: gSecs }
    }
    // Explicit off.
    if (override === 'off' || override === 0 || override === '0') {
      return { mode: 'gapless', crossfadeSecs: gSecs }
    }
    var secs = Number(override)
    if (isFinite(secs) && secs > 0) {
      return { mode: 'crossfade', crossfadeSecs: secs }
    }
    // Anything unrecognised falls back to inherit rather than guessing.
    return { mode: gMode, crossfadeSecs: gSecs }
  }

  // ── Global crossfade vs same-album gapless: the per-transition decision (#24) ──
  // The global crossfade (store key crossfadeSeconds, 0 = off) applies to ALL track
  // transitions EXCEPT one: two adjacent tracks from the same album, which the
  // gapless path plays seamlessly and must keep. So the precedence, most specific
  // first, is:
  //   1. An explicit playlist crossfade override wins outright (the user chose it
  //      for this playlist — even inside an album).
  //   2. Otherwise, a same-album adjacency stays gapless (album integrity wins over
  //      the global crossfade).
  //   3. Otherwise, the global crossfade applies when > 0, else gapless.
  // Pure: the renderer feeds it the facts (the global seconds, the playlist's
  // override, whether this transition is same-album-adjacent) and gets back the
  // { mode, crossfadeSecs } to put in force for THIS transition. Returning the same
  // shape as resolvePlaylistCrossfade keeps the apply/diff path unchanged.
  function resolveTransitionCrossfade(opts) {
    opts = opts || {}
    var globalSecs = Number(opts.crossfadeSeconds)
    if (!isFinite(globalSecs) || globalSecs <= 0) globalSecs = 0
    var override = opts.playlistOverride
    var sameAlbum = !!opts.sameAlbumAdjacent

    // 0. Bit-perfect (roadmap #65) wins over everything — even an explicit playlist
    //    crossfade override. Crossfade mixes two streams, which can never be
    //    bit-perfect, so while the mode is on every transition is gapless. This is
    //    the highest-precedence rule; the audiophile path is not something a
    //    per-playlist setting gets to defeat.
    if (opts.bitPerfect === true) {
      return { mode: 'gapless', crossfadeSecs: globalSecs > 0 ? globalSecs : 4 }
    }

    // 1. An explicit playlist override ('off' or a positive number) is the user's
    //    choice for this playlist and wins, same-album or not. 'inherit'/null falls
    //    through to the album/global rules.
    var hasOverride = override != null && override !== 'inherit'
    if (hasOverride) {
      if (override === 'off' || override === 0 || override === '0') {
        return { mode: 'gapless', crossfadeSecs: globalSecs > 0 ? globalSecs : 4 }
      }
      var oSecs = Number(override)
      if (isFinite(oSecs) && oSecs > 0) {
        return { mode: 'crossfade', crossfadeSecs: oSecs }
      }
      // Unrecognised override: fall through to the album/global rules.
    }

    // 2. Same-album adjacency stays gapless — album playback keeps its seams even
    //    when a global crossfade is set.
    if (sameAlbum) {
      return { mode: 'gapless', crossfadeSecs: globalSecs > 0 ? globalSecs : 4 }
    }

    // 3. The global setting decides everything else.
    if (globalSecs > 0) return { mode: 'crossfade', crossfadeSecs: globalSecs }
    return { mode: 'gapless', crossfadeSecs: 4 }
  }

  // Does the resolved config actually differ from what is in force now? The
  // renderer only pushes a player-set-config (which rebuilds the engine, an
  // audible tear-down) when this says the effective setting really changed —
  // never on every play. Compares mode always, and the seconds only when the
  // resolved mode is crossfade (the length is irrelevant while gapless).
  function crossfadeConfigDiffers(current, resolved) {
    current = current || {}
    resolved = resolved || {}
    var curMode = current.mode === 'crossfade' ? 'crossfade' : 'gapless'
    if (curMode !== resolved.mode) return true
    if (resolved.mode === 'crossfade') {
      return Number(current.crossfadeSecs) !== Number(resolved.crossfadeSecs)
    }
    return false
  }

  // ── Tag fixer: comparing local metadata to MusicBrainz (App #60) ───────────
  // Propose-only this wave: we fetch a release's track list from MusicBrainz and
  // line it up against what the local files claim, so the user can SEE where a
  // download's tags are wrong (misspelled titles, off-by-one track numbers, a
  // "(Remastered)" the release does not have). Nothing is written to disk here —
  // these helpers only build the side-by-side diff the UI shows with a disabled
  // "Apply" button.
  //
  // Title comparison is deliberately fuzzy the same way the dupe finder is: a
  // difference in bracketed asides or punctuation is noted (so the user can tidy
  // it) but does not by itself count the pair as a mismatch — only a real
  // difference in the core words does. We reuse _normPart so "same song" means
  // the same thing across the whole music side.

  // Normalise a track number to a plain integer, tolerating "5", 5, "05" and
  // "5/12" forms. Returns 0 when there is no usable number.
  function _tagTrackNo(t) {
    if (t == null) return 0
    var raw = t.trackNumber != null ? t.trackNumber
      : (t.track != null ? t.track
        : (t.no != null ? t.no
          : (t.position != null ? t.position : null)))
    if (raw == null) return 0
    var m = /^\s*(\d+)/.exec(String(raw))
    return m ? Number(m[1]) : 0
  }

  // Compare one local track to one MusicBrainz track. Returns the fields the diff
  // row needs: the two titles, the two numbers, and flags for whether the core
  // title words differ and whether the numbers differ. `titleExact` is true only
  // when the raw titles match character-for-character; `titleDiffers` is the
  // meaningful signal (core words differ after normalization).
  function compareTrackTags(localTrack, mbTrack) {
    localTrack = localTrack || {}
    mbTrack = mbTrack || {}
    var localTitle = String(localTrack.title == null ? '' : localTrack.title)
    var mbTitle = String(mbTrack.title == null ? '' : mbTrack.title)
    var localNo = _tagTrackNo(localTrack)
    var mbNo = _tagTrackNo(mbTrack)
    var normLocal = _normPart(localTitle)
    var normMb = _normPart(mbTitle)
    var titleExact = localTitle === mbTitle
    var titleDiffers = normLocal !== normMb
    // A "cosmetic" difference: the core words agree but the raw text does not —
    // a bracketed tag or punctuation the user may want to match to the release.
    var titleCosmetic = !titleExact && !titleDiffers
    var numberDiffers = (localNo > 0 && mbNo > 0) ? (localNo !== mbNo) : false
    return {
      localTitle: localTitle,
      mbTitle: mbTitle,
      localNo: localNo,
      mbNo: mbNo,
      titleExact: titleExact,
      titleDiffers: titleDiffers,
      titleCosmetic: titleCosmetic,
      numberDiffers: numberDiffers,
      // A row is "clean" when nothing at all differs, not even cosmetically.
      clean: titleExact && !numberDiffers,
    }
  }

  // Line a local album's tracks up against a MusicBrainz release's track list and
  // build the diff. We pair by track number where both sides have one (the
  // reliable key for a download whose titles are the thing that is wrong); tracks
  // with no number fall back to positional pairing in the order given. Extra
  // local tracks (no MB counterpart) and extra MB tracks (present on the release,
  // missing locally) are both reported so the user sees a too-long or too-short
  // local album.
  //
  // Returns { rows, summary } where each row is { localTitle, mbTitle, ... } from
  // compareTrackTags plus a `kind` of 'match' | 'local-only' | 'mb-only', and the
  // summary counts differ/cosmetic/clean/localOnly/mbOnly for the header.
  function buildTagDiff(localTracks, mbTracks) {
    localTracks = localTracks || []
    mbTracks = mbTracks || []
    // Index MB tracks by number where present; keep the rest in order for the
    // positional fallback.
    var mbByNo = {}
    var mbNoNumber = []
    for (var i = 0; i < mbTracks.length; i++) {
      var no = _tagTrackNo(mbTracks[i])
      if (no > 0 && !mbByNo[no]) mbByNo[no] = mbTracks[i]
      else mbNoNumber.push(mbTracks[i])
    }
    var usedMb = {} // identity of MB tracks already paired (by index into mbTracks)
    function mbIndexOf(obj) { return mbTracks.indexOf(obj) }

    var rows = []
    var posFallback = 0
    for (var k = 0; k < localTracks.length; k++) {
      var lt = localTracks[k]
      var ln = _tagTrackNo(lt)
      var mt = null
      if (ln > 0 && mbByNo[ln] && !usedMb[mbIndexOf(mbByNo[ln])]) {
        mt = mbByNo[ln]
      } else {
        // Positional fallback: next not-yet-used MB-without-number, then any
        // not-yet-used MB track at all, in order.
        while (posFallback < mbNoNumber.length && usedMb[mbIndexOf(mbNoNumber[posFallback])]) posFallback++
        if (posFallback < mbNoNumber.length) { mt = mbNoNumber[posFallback]; posFallback++ }
      }
      if (mt) {
        usedMb[mbIndexOf(mt)] = true
        var cmp = compareTrackTags(lt, mt)
        cmp.kind = 'match'
        // Back-reference to the local track this row came from, so the Apply
        // step (App #9) can resolve the file to write without re-pairing.
        cmp.localIndex = k
        rows.push(cmp)
      } else {
        rows.push({
          kind: 'local-only',
          localIndex: k,
          localTitle: String(lt && lt.title || ''),
          mbTitle: '',
          localNo: ln,
          mbNo: 0,
          titleExact: false, titleDiffers: false, titleCosmetic: false,
          numberDiffers: false, clean: false,
        })
      }
    }
    // MB tracks nobody paired with: present on the release, missing locally.
    for (var m = 0; m < mbTracks.length; m++) {
      if (usedMb[m]) continue
      var extra = mbTracks[m]
      rows.push({
        kind: 'mb-only',
        localTitle: '',
        mbTitle: String(extra && extra.title || ''),
        localNo: 0,
        mbNo: _tagTrackNo(extra),
        titleExact: false, titleDiffers: false, titleCosmetic: false,
        numberDiffers: false, clean: false,
      })
    }
    var summary = { total: rows.length, differ: 0, cosmetic: 0, clean: 0, localOnly: 0, mbOnly: 0 }
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r]
      if (row.kind === 'local-only') summary.localOnly++
      else if (row.kind === 'mb-only') summary.mbOnly++
      else if (row.titleDiffers || row.numberDiffers) summary.differ++
      else if (row.titleCosmetic) summary.cosmetic++
      else summary.clean++
    }
    return { rows: rows, summary: summary }
  }

  // ── Tag fixer: turning accepted diff rows into tag writes (App #9) ──────────
  // The analysis pass (buildTagDiff) proposes MusicBrainz corrections; this
  // turns the rows the user ACCEPTED into the { filePath, tags } write list that
  // window.api.libraryWriteTags consumes. Only 'match' rows are applicable (a
  // local-only track has nothing on the release to copy from, an mb-only track
  // has no local file to write). For each accepted match we set the title to the
  // MB title when the titles differ (cosmetically or in the core words) and the
  // track number to the MB number when they differ. `localTracks` is the same
  // album.tracks array passed to buildTagDiff, so localIndex resolves the file.
  //
  // `accepted` is a set-like: either an array of row indices (into diff.rows) or
  // an object keyed by row index with truthy values. Pure and DOM-free so the
  // rules are testable without libraryWriteTags.
  function tagFixWrites(diffRows, localTracks, accepted) {
    diffRows = diffRows || []
    localTracks = localTracks || []
    var isAccepted
    if (Array.isArray(accepted)) {
      var set = {}
      for (var s = 0; s < accepted.length; s++) set[accepted[s]] = true
      isAccepted = function (i) { return !!set[i] }
    } else if (accepted && typeof accepted === 'object') {
      isAccepted = function (i) { return !!accepted[i] }
    } else {
      isAccepted = function () { return true } // no selection = apply all applicable
    }
    var byPath = {}
    var order = []
    for (var i = 0; i < diffRows.length; i++) {
      if (!isAccepted(i)) continue
      var row = diffRows[i]
      if (!row || row.kind !== 'match') continue
      if (!row.titleDiffers && !row.numberDiffers && !row.titleCosmetic) continue
      var lt = localTracks[row.localIndex]
      if (!lt || !lt.filePath) continue
      var tags = {}
      if ((row.titleDiffers || row.titleCosmetic) && row.mbTitle) tags.title = String(row.mbTitle)
      if (row.numberDiffers && row.mbNo > 0) tags.track = String(row.mbNo)
      if (!Object.keys(tags).length) continue
      if (!byPath[lt.filePath]) { byPath[lt.filePath] = { filePath: lt.filePath, tags: {} }; order.push(lt.filePath) }
      for (var key in tags) {
        if (Object.prototype.hasOwnProperty.call(tags, key)) byPath[lt.filePath].tags[key] = tags[key]
      }
    }
    return order.map(function (p) { return byPath[p] })
  }

  // Which diff rows can be applied at all (a 'match' with a real difference),
  // returned as row indices. The UI pre-checks exactly these.
  function tagFixApplicableRows(diffRows) {
    diffRows = diffRows || []
    var out = []
    for (var i = 0; i < diffRows.length; i++) {
      var r = diffRows[i]
      if (r && r.kind === 'match' && (r.titleDiffers || r.numberDiffers || r.titleCosmetic)) out.push(i)
    }
    return out
  }

  // ── Multi-disc grouping (App #10) ──────────────────────────────────────────
  // The disc a track belongs to: its tagged discNumber when present, else parsed
  // from a "Disc 2" / "CD2" / "/D2/" segment in its path, else disc 1. Pure so
  // the album view and its test share one rule for what counts as a disc.
  function discNumberOf(track) {
    if (!track) return 1
    var n = Number(track.discNumber)
    if (isFinite(n) && n > 0) return n
    var p = String(track.filePath || '')
    // "Disc 2", "Disk 2", "CD 2", "CD2", "D2" as a path segment or filename lead.
    var m = /(?:^|[\/\\\s\-_([])(?:dis[ck]|cd)\s*[-_ ]?(\d{1,2})\b/i.exec(p)
    if (m) { var d = Number(m[1]); if (d > 0) return d }
    return 1
  }

  // Does this album span more than one disc? True only when at least two
  // distinct disc numbers appear across its tracks. A single untagged track
  // (disc 1) is never multi-disc.
  function albumHasMultipleDiscs(tracks) {
    tracks = tracks || []
    var seen = {}
    var count = 0
    for (var i = 0; i < tracks.length; i++) {
      var d = discNumberOf(tracks[i])
      if (!seen[d]) { seen[d] = true; count++ }
      if (count > 1) return true
    }
    return false
  }

  // ── A–B loop: the cycle state machine (App #5) ─────────────────────────────
  // Musicians want to loop a passage: press once to drop point A, again to drop
  // point B and start looping, a third time to clear. This is the pure part —
  // given the current loop state and the playback position now, return the next
  // state. The renderer owns the audio engine; this owns only the rules, so the
  // cycle can be tested without mpv or a clock.
  //
  // A loop is { a, b } in seconds. A pending loop (A set, waiting for B) is
  // { a, b: null }. No loop is null. The transitions:
  //   null            + press → { a: pos, b: null }      (A dropped)
  //   { a, b: null }  + press → { a, b: pos }            (B dropped, loop on)
  //                              — but only if pos > a; a B at or before A is
  //                                nonsensical, so it re-drops A at pos instead.
  //   { a, b }        + press → null                     (cleared)
  // Returns { loop, action } where action is 'set-a' | 'set-b' | 'clear' |
  // 're-set-a', so the caller can pick the right toast without re-deriving it.
  function abLoopCycle(current, posSec) {
    var pos = Number(posSec)
    if (!isFinite(pos) || pos < 0) pos = 0
    // No loop yet, or a stored shape we do not recognise → drop A.
    if (!current || typeof current !== 'object' || !isFinite(Number(current.a))) {
      return { loop: { a: pos, b: null }, action: 'set-a' }
    }
    var a = Number(current.a)
    // A is set, B is not → this press sets B (if it is after A) and starts the
    // loop. A B that is not strictly after A cannot loop, so treat the press as
    // moving A to the new position instead of creating a zero/negative window.
    if (current.b == null || !isFinite(Number(current.b))) {
      if (pos > a) return { loop: { a: a, b: pos }, action: 'set-b' }
      return { loop: { a: pos, b: null }, action: 're-set-a' }
    }
    // Both set → clear.
    return { loop: null, action: 'clear' }
  }

  // Given an active loop and the position now, the position to jump back to when
  // playback has run past B — or null when no jump is due. Kept tiny and pure so
  // the timeupdate hook (and its test) share exactly one rule. A small epsilon
  // catches the case where a tick lands a hair past B without overshooting a
  // whole frame.
  function abLoopJumpTarget(loop, posSec, epsilon) {
    if (!loop || typeof loop !== 'object') return null
    var a = Number(loop.a)
    var b = Number(loop.b)
    if (!isFinite(a) || !isFinite(b) || b <= a) return null
    var pos = Number(posSec)
    if (!isFinite(pos)) return null
    var eps = isFinite(Number(epsilon)) ? Number(epsilon) : 0.25
    return pos >= (b - eps) ? a : null
  }

  // ── Genre normalisation: grouping case/whitespace variants (App #8) ─────────
  // The library accumulates "rock", "Rock", "Rock ", "ROCK" as if they were
  // different genres. This folds them: a canonical key (lowercased, whitespace
  // collapsed) groups the raw variants, and each group counts how many albums
  // carry each variant so the fixer can suggest the most-used spelling as the
  // merge target. Pure over the library so it is testable without the DOM.
  //
  // Returns { groups, ungenred } where:
  //   groups   — [{ key, variants: [{ value, albumCount }], albumCount,
  //               suggested }], sorted by total album count desc. `variants`
  //               is sorted by album count desc so the popular spelling leads.
  //               A group with a single variant is still returned (the UI can
  //               show it as already-clean); the caller filters if it wants.
  //   ungenred — the count of albums with no usable genre at all, so the tool
  //              can offer to assign them.
  function _normGenreKey(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim()
  }

  function _looksLikeNoGenre(v) {
    var s = _normGenreKey(v)
    return !s || s === 'null' || s === 'undefined' || s === 'unknown' ||
      s === 'other' || s === 'genre' || s === 'none'
  }

  function analyzeGenres(library) {
    library = library || []
    var groups = {}
    var ungenred = 0
    for (var i = 0; i < library.length; i++) {
      var a = library[i]
      var raw = a && a.genre
      if (_looksLikeNoGenre(raw)) { ungenred++; continue }
      var key = _normGenreKey(raw)
      var val = String(raw).replace(/\s+/g, ' ').trim() // trim padding, keep case
      if (!groups[key]) groups[key] = { key: key, variants: {}, albumCount: 0 }
      groups[key].variants[val] = (groups[key].variants[val] || 0) + 1
      groups[key].albumCount++
    }
    var out = Object.keys(groups).map(function (k) {
      var g = groups[k]
      var variants = Object.keys(g.variants).map(function (v) {
        return { value: v, albumCount: g.variants[v] }
      }).sort(function (x, y) {
        return y.albumCount - x.albumCount || (x.value < y.value ? -1 : 1)
      })
      return {
        key: g.key,
        variants: variants,
        albumCount: g.albumCount,
        suggested: variants[0] ? variants[0].value : g.key,
      }
    })
    out.sort(function (x, y) {
      return y.albumCount - x.albumCount || (x.key < y.key ? -1 : 1)
    })
    return { groups: out, ungenred: ungenred }
  }

  // Collect the track write-list for setting a genre on a set of albums to one
  // canonical string. Reuses the tag-editor's write shape ({ filePath, tags })
  // so it flows straight through window.api.libraryWriteTags. Only tracks whose
  // genre actually differs from the target are emitted — writing a file its tag
  // already has is pure churn (and a needless rescan). `albums` are library
  // album records (each with a `tracks` array). Pure and DOM-free.
  function genreWritesForAlbums(albums, targetGenre) {
    albums = albums || []
    var target = String(targetGenre == null ? '' : targetGenre)
    var out = []
    for (var i = 0; i < albums.length; i++) {
      var tracks = (albums[i] && albums[i].tracks) || []
      for (var j = 0; j < tracks.length; j++) {
        var t = tracks[j]
        if (!t || !t.filePath) continue
        var cur = t.genre == null ? '' : String(t.genre)
        if (cur === target) continue
        out.push({ filePath: t.filePath, tags: { genre: target } })
      }
    }
    return out
  }

  // ── Smart playlist: the field/op/value rule evaluator (App #11) ─────────────
  // The renderer's smart playlists are AND-combined lists of { field, op, value }
  // rules. This is the pure evaluator behind them (the renderer's
  // _evalSmartPlaylist delegates here), so the matching rules — including the new
  // format-class, liked and added-within-days conditions the rule editor gained —
  // are tested in one place without the DOM or a clock.
  //
  // A track row is the renderer's flattened track object. `ctx` supplies the
  // side data a rule may need without reaching into globals:
  //   ctx.playCounts — { filePath: count }
  //   ctx.isLiked    — fn(track) → bool
  //   ctx.now        — epoch ms (injectable for the added-within test)
  //
  // Supported fields:
  //   artist, album, genre, year            — text/number, ops below
  //   format                                — file extension (flac/mp3/…)
  //   formatClass                           — 'lossless' | 'hires' | 'lossy'
  //   playCount                             — number, ops below
  //   liked                                 — value 'true'/'false' (is)
  //   addedWithin                           — value = days; matches added ≤ N days
  // Ops: is, contains, gt, lt, gte, lte. An unknown field/op fails closed (the
  // whole rule matches nothing) so a malformed rule never silently matches all.
  function _extLower(filePath) {
    return _extOf(filePath) // reuse the dupe-finder's extension parse
  }

  function _formatClassOf(track) {
    var ext = _extLower(track.filePath)
    if (!LOSSLESS_EXTS[ext]) return 'lossy'
    // Hi-res = lossless AND (>16-bit OR >48kHz). We only know that for tracks the
    // scanner tagged with bitsPerSample/sampleRate; untagged lossless is treated
    // as plain lossless (fails the 'hires' test, passes 'lossless').
    var bd = Number(track.bitsPerSample) || 0
    var sr = Number(track.sampleRate) || 0
    if (bd > 16 || sr > 48000) return 'hires'
    return 'lossless'
  }

  function _numCompare(op, a, b) {
    var x = Number(a); var y = Number(b)
    if (!isFinite(x) || !isFinite(y)) return false
    switch (op) {
      case 'gt':  return x > y
      case 'lt':  return x < y
      case 'gte': return x >= y
      case 'lte': return x <= y
      case 'is':  return x === y
      default:    return false
    }
  }

  function _ruleFieldValue(track, field, ctx) {
    switch (field) {
      case 'album':     return track.albumName != null ? track.albumName : track.album
      case 'artist':    return track.albumArtist || track.artist
      // The whole record: what a saved free-text search means ("camel mirage"
      // is an artist AND an album, so no single field can hold it).
      case 'any':       return [track.albumArtist, track.artist, track.albumName != null ? track.albumName : track.album, track.title]
                          .filter(function (x) { return x != null && x !== '' }).join(' | ')
      case 'format':    return _extLower(track.filePath)
      case 'formatClass': return _formatClassOf(track)
      case 'playCount': return (ctx.playCounts && ctx.playCounts[track.filePath]) || 0
      default:          return track[field]
    }
  }

  function _matchOneRule(track, rule, ctx) {
    if (!rule || !rule.field) return false
    var field = rule.field
    var op = rule.op || 'is'
    var want = rule.value

    // Fields that ignore the op and read as a predicate.
    if (field === 'liked') {
      var isLiked = ctx.isLiked ? !!ctx.isLiked(track) : false
      var wantLiked = String(want).toLowerCase() !== 'false' // default: want liked
      return isLiked === wantLiked
    }
    if (field === 'addedWithin') {
      var days = Number(want)
      if (!isFinite(days) || days <= 0) return false
      var added = Number(track.addedAt || track.dateAdded || track.mtime || 0) || 0
      if (!added) return false
      var now = isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now()
      return (now - added) <= days * 24 * 60 * 60 * 1000 && added <= now
    }

    var val = _ruleFieldValue(track, field, ctx)
    if (val === undefined || val === null) return false

    // 'matches': every word of the value appears somewhere in the field,
    // order-blind, accent- and case-insensitive — the same all-words rule the
    // search brain applies, minus typo tolerance. Used by "Save search".
    if (op === 'matches') {
      var hay = _foldText(val)
      var words = _foldText(want).split(' ').filter(Boolean)
      if (!words.length) return false
      for (var wi = 0; wi < words.length; wi++) if (hay.indexOf(words[wi]) === -1) return false
      return true
    }

    // Numeric fields compare numerically for the ordering ops.
    if (field === 'playCount' || field === 'year') {
      if (op === 'is') return _numCompare('is', val, want)
      if (op === 'gt' || op === 'lt' || op === 'gte' || op === 'lte') {
        return _numCompare(op, val, want)
      }
      // contains on a number: substring of its string form.
      return String(val).indexOf(String(want)) !== -1
    }

    switch (op) {
      case 'is':       return String(val).toLowerCase() === String(want).toLowerCase()
      case 'contains': return String(val).toLowerCase().indexOf(String(want).toLowerCase()) !== -1
      case 'gt':       return _numCompare('gt', val, want)
      case 'lt':       return _numCompare('lt', val, want)
      case 'gte':      return _numCompare('gte', val, want)
      case 'lte':      return _numCompare('lte', val, want)
      default:         return false
    }
  }

  function _foldText(s) {
    var t = String(s == null ? '' : s).toLowerCase()
    if (typeof t.normalize === 'function') t = t.normalize('NFD').replace(/[̀-ͯ]/g, '')
    return t.replace(/[^a-z0-9]+/g, ' ').trim()
  }

  // Bring any rule shape the app has ever written into the shape the
  // evaluator speaks (R7). "Save search" used to copy the search box's
  // operators verbatim — `plays > 5`, `year range 1970-1975`, `is: liked` —
  // none of which the evaluator knew, so the saved playlist opened empty and
  // stayed empty forever. Unknown shapes are dropped rather than left to
  // fail closed and blank the whole playlist.
  var _OP_ALIASES = { '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte', '=': 'is', '==': 'is', 'equals': 'is', 'has': 'contains' }
  var _KNOWN_OPS = { is: 1, contains: 1, gt: 1, lt: 1, gte: 1, lte: 1, matches: 1 }
  function normalizeSmartRules(rules) {
    var out = []
    var list = Array.isArray(rules) ? rules : []
    for (var i = 0; i < list.length; i++) {
      var r = list[i]
      if (!r || !r.field) continue
      var field = String(r.field)
      var op = _OP_ALIASES[r.op] || (r.op ? String(r.op) : 'is')
      var value = r.value
      if (field === 'is') {
        var v = String(value == null ? '' : value).toLowerCase()
        if (v === 'liked') out.push({ field: 'liked', op: 'is', value: 'true' })
        else if (v === 'flac') out.push({ field: 'format', op: 'is', value: 'flac' })
        else if (v === 'lossy') out.push({ field: 'formatClass', op: 'is', value: 'lossy' })
        continue // 'downloaded' and anything else has no smart-rule meaning
      }
      if (field === 'plays') field = 'playCount'
      if (field === 'year' && op === 'range') {
        var m = String(value == null ? '' : value).match(/^\s*(\d{4})\s*-\s*(\d{4})\s*$/)
        if (m) { out.push({ field: 'year', op: 'gte', value: m[1] }); out.push({ field: 'year', op: 'lte', value: m[2] }) }
        continue
      }
      if (!_KNOWN_OPS[op]) continue
      if (field === 'liked') { out.push({ field: 'liked', op: 'is', value: value == null ? 'true' : value }); continue }
      out.push({ field: field, op: op, value: value })
    }
    return out
  }

  // A rule is "configured" when it names a field and either carries a value or is
  // one of the valueless predicates (liked). An all-blank rule set matches
  // nothing (an unconfigured smart playlist is empty, not everything).
  function _ruleConfigured(rule) {
    if (!rule || !rule.field) return false
    if (rule.field === 'liked') return true
    return String(rule.value == null ? '' : rule.value).trim() !== ''
  }

  // Run the AND-combined field rules against a flat track list. Returns the
  // matching tracks in input order. `tracks` are flattened track objects;
  // `ctx` as documented above.
  function evaluateFieldRules(tracks, rules, ctx) {
    tracks = tracks || []
    ctx = ctx || {}
    var active = normalizeSmartRules(rules).filter(_ruleConfigured)
    if (!active.length) return []
    return tracks.filter(function (t) {
      return active.every(function (r) { return _matchOneRule(t, r, ctx) })
    })
  }

  // ── Pluralisation: one rule, used everywhere a count is shown ────────────────
  // "1 albums" appeared in the folder tree and the artist hero while the
  // playlist folder count got it right; one helper ends the drift. Irregulars
  // are passed as the plural form: plural(2, 'copy', 'copies').
  function plural(n, word, pluralWord) {
    var k = Number(n) || 0
    return k + ' ' + (k === 1 ? word : (pluralWord || word + 's'))
  }

  // ── Home personalization: row order + hidden set (App #15) ──────────────────
  // Home is a fixed set of rows, each with a stable id. The user can reorder and
  // hide them; the preference persists as { order: [ids...], hidden: [ids...] }.
  // These pure helpers own the list algebra so the renderer only reorders/skips
  // render calls and the logic is testable without the DOM.
  //
  // `defaultOrder` is the app's built-in row order (the source of truth for
  // which rows EXIST). A saved order may be stale — missing rows that shipped
  // since it was saved, or naming rows that no longer exist. resolveHomeRows
  // reconciles the two: saved order first (in its saved sequence, minus unknown
  // ids), then any new default rows the save never saw, appended in default
  // order — so a new row always appears (at the bottom) rather than vanishing.
  function resolveHomeRows(defaultOrder, pref) {
    defaultOrder = (defaultOrder || []).filter(function (id) { return !!id })
    var known = {}
    defaultOrder.forEach(function (id) { known[id] = true })
    var p = pref && typeof pref === 'object' ? pref : {}
    var savedOrder = Array.isArray(p.order) ? p.order : []
    var hiddenArr = Array.isArray(p.hidden) ? p.hidden : []
    var hidden = {}
    hiddenArr.forEach(function (id) { if (known[id]) hidden[id] = true })

    var order = []
    var placed = {}
    savedOrder.forEach(function (id) {
      if (known[id] && !placed[id]) { order.push(id); placed[id] = true }
    })
    defaultOrder.forEach(function (id) {
      if (!placed[id]) { order.push(id); placed[id] = true }
    })
    return {
      order: order,
      hidden: hidden,
      // The rows to actually render, in order, hidden ones removed.
      visible: order.filter(function (id) { return !hidden[id] }),
    }
  }

  // Move the row at `index` one slot up (dir -1) or down (dir +1), returning a
  // NEW order array. Out-of-range moves (top row up, bottom row down) are no-ops
  // that return an equal-content array, so the caller can persist unconditionally.
  function moveHomeRow(order, index, dir) {
    var out = (Array.isArray(order) ? order : []).slice()
    var i = Number(index)
    var to = i + (dir < 0 ? -1 : 1)
    if (i < 0 || i >= out.length || to < 0 || to >= out.length) return out
    var tmp = out[i]; out[i] = out[to]; out[to] = tmp
    return out
  }

  // Toggle a row id in the hidden set, returning a NEW { order, hidden } pref
  // ready to persist. `order` is carried through unchanged so the two halves of
  // the preference always travel together.
  function toggleHomeRow(pref, id) {
    var p = pref && typeof pref === 'object' ? pref : {}
    var order = Array.isArray(p.order) ? p.order.slice() : []
    var hidden = Array.isArray(p.hidden) ? p.hidden.slice() : []
    var at = hidden.indexOf(id)
    if (at === -1) hidden.push(id)
    else hidden.splice(at, 1)
    return { order: order, hidden: hidden }
  }

  var api = {
    sleepFadeSteps: sleepFadeSteps,
    evaluateFieldRules: evaluateFieldRules,
    normalizeSmartRules: normalizeSmartRules,
    plural: plural,
    resolveHomeRows: resolveHomeRows,
    moveHomeRow: moveHomeRow,
    toggleHomeRow: toggleHomeRow,
    albumsMissingArt: albumsMissingArt,
    parseLrc: parseLrc,
    activeLyricIndex: activeLyricIndex,
    resolvePlaylistCrossfade: resolvePlaylistCrossfade,
    resolveTransitionCrossfade: resolveTransitionCrossfade,
    crossfadeConfigDiffers: crossfadeConfigDiffers,
    SLEEP_PRESETS: SLEEP_PRESETS,
    clearPlayedQueue: clearPlayedQueue,
    clearUpcomingQueue: clearUpcomingQueue,
    rowWheelDelta: rowWheelDelta,
    topAlbumsByPlays: topAlbumsByPlays,
    playsPerMonth: playsPerMonth,
    normalizeForDupe: normalizeForDupe,
    findDuplicateTracks: findDuplicateTracks,
    buildArtistAdjacency: buildArtistAdjacency,
    neighborsOf: neighborsOf,
    weightedPickIndex: weightedPickIndex,
    composeRadioBatch: composeRadioBatch,
    pushRecent: pushRecent,
    storageByFormat: storageByFormat,
    largestAlbums: largestAlbums,
    downloadsSubset: downloadsSubset,
    msUntilAlarm: msUntilAlarm,
    alarmFadeSteps: alarmFadeSteps,
    SMART_PLAYLISTS: SMART_PLAYLISTS,
    evaluateSmartPlaylist: evaluateSmartPlaylist,
    albumGaps: albumGaps,
    incompleteAlbums: incompleteAlbums,
    parseImportLines: parseImportLines,
    buildLibraryIndex: buildLibraryIndex,
    matchImportedTracks: matchImportedTracks,
    compareTrackTags: compareTrackTags,
    buildTagDiff: buildTagDiff,
    abLoopCycle: abLoopCycle,
    abLoopJumpTarget: abLoopJumpTarget,
    analyzeGenres: analyzeGenres,
    genreWritesForAlbums: genreWritesForAlbums,
    tagFixWrites: tagFixWrites,
    tagFixApplicableRows: tagFixApplicableRows,
    discNumberOf: discNumberOf,
    albumHasMultipleDiscs: albumHasMultipleDiscs
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (typeof window !== 'undefined') window.PapaMusicTools = api

})()
