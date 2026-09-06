'use strict';
// "Your year so far" — the pure aggregation behind the home page's year-recap
// card (App §76). It takes already-loaded data and returns plain figures; it
// does no I/O, reads no store and touches no DOM, so it is trivially testable
// and can never block a render on the network.
//
// Every figure is optional. A field is present only when it can be derived
// honestly from what was passed in — a fresh install with no plays and no
// diary yields an object with `has:false` and nothing else, and the card is
// simply not drawn. Half a recap ("You played 400 tracks" with no film line)
// is better than a padded one, so the caller renders exactly the keys that
// arrived and omits the rest.
//
// UMD-wrapped like the stores so it loads both as a classic <script> in the
// renderer and via require() in tests, without leaking into renderer scope.
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PapaHomeRecap = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // The calendar year a timestamp or "YYYY-MM-DD" string belongs to. Music
  // plays carry epoch-ms timestamps; diary viewings carry calendar-day strings
  // (see taste-store.js on why a viewing is a day, not an instant). Both map to
  // the same year here so "this year" means one thing across the whole card.
  function _yearOfTs(ts) {
    const n = Number(ts)
    if (!Number.isFinite(n) || n <= 0) return null
    return new Date(n).getFullYear()
  }
  function _yearOfDate(date) {
    if (typeof date !== 'string') return null
    const m = /^(\d{4})-\d{2}-\d{2}/.exec(date)
    return m ? Number(m[1]) : null
  }

  // Total music plays this year and the artist played most, from the raw
  // play-history rows the renderer already holds (state.playHistory). Each row
  // is { filePath, ts, artist?, duration? }. `durationOf` resolves a play to
  // its track length in seconds when the row itself did not record one — the
  // renderer passes a lookup over the library so history written before
  // durations were stored still counts toward the hours figure.
  function musicRecap(playHistory, opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const year = Number.isFinite(o.year) ? o.year : new Date().getFullYear()
    const durationOf = typeof o.durationOf === 'function' ? o.durationOf : null
    const artistOf = typeof o.artistOf === 'function' ? o.artistOf : null
    const list = Array.isArray(playHistory) ? playHistory : []

    let plays = 0
    let seconds = 0
    const artistCounts = new Map()
    for (const p of list) {
      if (!p || typeof p !== 'object') continue
      if (_yearOfTs(p.ts) !== year) continue
      plays += 1
      // A play's own duration first; the library fallback second; zero last.
      let dur = Number(p.duration)
      if (!(dur > 0) && durationOf) dur = Number(durationOf(p.filePath))
      if (dur > 0) seconds += dur
      // The play row's artist first; a resolver over the library second.
      let artist = typeof p.artist === 'string' ? p.artist.trim() : ''
      if (!artist && artistOf) {
        const a = artistOf(p.filePath)
        artist = typeof a === 'string' ? a.trim() : ''
      }
      if (artist) artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1)
    }

    let topArtist = null
    let topArtistPlays = 0
    for (const [name, n] of artistCounts) {
      // Ties break on first-seen order, which is stable across a render.
      if (n > topArtistPlays) { topArtist = name; topArtistPlays = n }
    }

    return {
      plays,
      hours: seconds > 0 ? Math.round(seconds / 3600 * 10) / 10 : 0,
      topArtist,
      topArtistPlays,
    }
  }

  // Films/TV/anime watched this year and hours streamed, from the two video
  // data sources the renderer holds. `diary` is the taste-store diary array
  // ({ key, date } rows) — a viewing is a sitting, so three watches of one film
  // count as three; that matches "films watched this year", which is about time
  // spent, not distinct titles. `watchedItems` is the video store's own history
  // (items with position/duration in seconds) — the only place a real streamed
  // duration lives, so hours come from here, not from the diary.
  function videoRecap(diary, watchedItems, opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const year = Number.isFinite(o.year) ? o.year : new Date().getFullYear()

    let films = 0
    if (Array.isArray(diary)) {
      for (const e of diary) {
        if (!e || typeof e !== 'object') continue
        if (_yearOfDate(e.date) === year) films += 1
      }
    }

    // Hours streamed: sum each watched item's played position (how far you got),
    // capped at its own duration so a bad position can't inflate the figure.
    // Items carry `updatedAt` (epoch ms) — only this year's are counted, so the
    // number means "this year" like every other figure on the card.
    let seconds = 0
    let haveDurations = false
    if (Array.isArray(watchedItems)) {
      for (const it of watchedItems) {
        if (!it || typeof it !== 'object') continue
        if (it.updatedAt != null && _yearOfTs(it.updatedAt) !== year) continue
        const dur = Number(it.duration) || 0
        const pos = Number(it.position) || 0
        if (dur > 0) {
          haveDurations = true
          seconds += Math.min(pos > 0 ? pos : dur, dur)
        }
      }
    }

    return {
      films,
      // Null, not zero, when no item carried a duration: "0 hours" is a claim,
      // absence is honest. The caller omits the line rather than print a false
      // zero next to real figures.
      hours: haveDurations ? Math.round(seconds / 3600 * 10) / 10 : null,
    }
  }

  // The whole card in one call. Merges the music and video recaps into the flat
  // shape the renderer draws, and sets `has` iff at least one figure is worth
  // showing — the caller's single "should I draw this at all" test.
  function yearRecap(input) {
    const i = input && typeof input === 'object' ? input : {}
    const music = musicRecap(i.playHistory, {
      year: i.year,
      durationOf: i.durationOf,
      artistOf: i.artistOf,
    })
    const video = videoRecap(i.diary, i.watchedItems, { year: i.year })

    // Streamed hours are music + video when both are present; either alone
    // otherwise; null when neither could be derived.
    let hours = null
    if (music.hours > 0 || video.hours != null) {
      hours = Math.round(((music.hours || 0) + (video.hours || 0)) * 10) / 10
    }

    const out = {
      year: Number.isFinite(i.year) ? i.year : new Date().getFullYear(),
      plays: music.plays,
      topArtist: music.topArtist,
      topArtistPlays: music.topArtistPlays,
      films: video.films,
      hours,
      has: false,
    }
    // Worth drawing if any single figure carries real information. Plays and
    // films of zero say nothing; a top artist, any plays, any films, or any
    // hours each do.
    out.has = out.plays > 0 || out.films > 0 || !!out.topArtist || (out.hours != null && out.hours > 0)
    return out
  }

  // ── Year-end "Wrapped" (App #16) ───────────────────────────────────────────
  // The full year-in-review, computed entirely from the play-history rows the
  // Stats page already holds plus small resolver callbacks over the library
  // (duration, artist, album, genre, first-listen date by filePath). Pure: no
  // store, no DOM, no clock beyond the `year` the caller passes — so every
  // figure is a testable aggregation.
  //
  // Input:
  //   playHistory — [{ filePath, ts, artist?, duration? }] (epoch-ms `ts`)
  //   opts.year        — the calendar year to summarise
  //   opts.durationOf  — fn(filePath) → seconds (library fallback)
  //   opts.artistOf    — fn(filePath) → artist name
  //   opts.albumOf     — fn(filePath) → album name
  //   opts.genreOf     — fn(filePath) → genre string
  //   opts.titleOf     — fn(filePath) → track title (for the top-tracks list)
  //   opts.firstListenBefore — fn(filePath) → true if this path was played in a
  //                            year earlier than `year` (so it is NOT a
  //                            first-listen discovery this year). Optional; when
  //                            absent, discoveries are derived from the history
  //                            passed in (a path whose earliest play in the
  //                            whole history falls in `year`).
  //
  // Output (all figures optional; `has` gates the whole page):
  //   { year, has, plays, hours, longestSessionMins, topGenre,
  //     biggestDay: { date, plays }, discoveries,
  //     topArtists: [{ name, plays, seconds }],
  //     topAlbums:  [{ name, plays, seconds }],
  //     topTracks:  [{ filePath, title, artist, plays, seconds }] }
  function _dayKey(ts) {
    const d = new Date(Number(ts))
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0')
  }

  function wrappedRecap(playHistory, opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const year = Number.isFinite(o.year) ? o.year : new Date().getFullYear()
    const durationOf = typeof o.durationOf === 'function' ? o.durationOf : null
    const artistOf = typeof o.artistOf === 'function' ? o.artistOf : null
    const albumOf = typeof o.albumOf === 'function' ? o.albumOf : null
    const genreOf = typeof o.genreOf === 'function' ? o.genreOf : null
    const titleOf = typeof o.titleOf === 'function' ? o.titleOf : null
    const firstListenBefore = typeof o.firstListenBefore === 'function' ? o.firstListenBefore : null
    const list = Array.isArray(playHistory) ? playHistory : []

    // Earliest play per path across ALL history — used for the discovery figure
    // when the caller has no cross-year signal of its own.
    const earliestByPath = new Map()
    for (const p of list) {
      if (!p || typeof p !== 'object' || !p.filePath) continue
      const ts = Number(p.ts)
      if (!Number.isFinite(ts) || ts <= 0) continue
      const prev = earliestByPath.get(p.filePath)
      if (prev == null || ts < prev) earliestByPath.set(p.filePath, ts)
    }

    let plays = 0
    let seconds = 0
    const artistAgg = new Map() // name → { plays, seconds }
    const albumAgg = new Map()
    const trackAgg = new Map()  // filePath → { plays, seconds, title, artist }
    const genreCounts = new Map()
    const dayPlays = new Map()  // "YYYY-MM-DD" → count
    const discoveries = new Set()

    // Session detection: rows in `year`, ordered by ts, split on a >30-min gap.
    const SESSION_GAP = 30 * 60 * 1000
    const yearRows = []

    for (const p of list) {
      if (!p || typeof p !== 'object') continue
      const ts = Number(p.ts)
      if (_yearOfTs(ts) !== year) continue
      plays += 1

      let dur = Number(p.duration)
      if (!(dur > 0) && durationOf) dur = Number(durationOf(p.filePath))
      if (!(dur > 0)) dur = 0
      if (dur > 0) seconds += dur

      let artist = typeof p.artist === 'string' ? p.artist.trim() : ''
      if (!artist && artistOf) {
        const a = artistOf(p.filePath)
        artist = typeof a === 'string' ? a.trim() : ''
      }
      if (artist) {
        const cur = artistAgg.get(artist) || { plays: 0, seconds: 0 }
        cur.plays += 1; cur.seconds += dur
        artistAgg.set(artist, cur)
      }

      if (albumOf) {
        const alb = albumOf(p.filePath)
        const albName = typeof alb === 'string' ? alb.trim() : ''
        if (albName) {
          const cur = albumAgg.get(albName) || { plays: 0, seconds: 0 }
          cur.plays += 1; cur.seconds += dur
          albumAgg.set(albName, cur)
        }
      }

      if (p.filePath) {
        const cur = trackAgg.get(p.filePath) ||
          { filePath: p.filePath, plays: 0, seconds: 0, title: '', artist: '' }
        cur.plays += 1; cur.seconds += dur
        if (!cur.artist && artist) cur.artist = artist
        if (!cur.title && titleOf) {
          const tt = titleOf(p.filePath)
          if (typeof tt === 'string' && tt.trim()) cur.title = tt.trim()
        }
        trackAgg.set(p.filePath, cur)
      }

      if (genreOf) {
        const g = genreOf(p.filePath)
        const gs = typeof g === 'string' ? g.trim() : ''
        if (gs) genreCounts.set(gs, (genreCounts.get(gs) || 0) + 1)
      }

      if (Number.isFinite(ts) && ts > 0) {
        const dk = _dayKey(ts)
        dayPlays.set(dk, (dayPlays.get(dk) || 0) + 1)
        yearRows.push({ ts, seconds: dur })

        // First-listen discovery: the caller's cross-year check wins; otherwise
        // this path's earliest play in the whole history is in `year`.
        if (p.filePath) {
          let isNew
          if (firstListenBefore) {
            isNew = !firstListenBefore(p.filePath)
          } else {
            const first = earliestByPath.get(p.filePath)
            isNew = first != null && _yearOfTs(first) === year
          }
          if (isNew) discoveries.add(p.filePath)
        }
      }
    }

    // Longest single listening session, in minutes, from the summed durations of
    // its rows. Falls back to the wall-clock span of the session when no row
    // carried a duration, so a session is never reported as zero minutes.
    yearRows.sort((a, b) => a.ts - b.ts)
    let longestSessionSecs = 0
    let sesSecs = 0
    let sesStart = null
    let sesEnd = null
    let lastTs = null
    const flush = () => {
      if (sesStart == null) return
      const byDur = sesSecs
      const bySpan = (sesEnd - sesStart) / 1000
      const s = byDur > 0 ? byDur : bySpan
      if (s > longestSessionSecs) longestSessionSecs = s
    }
    for (const r of yearRows) {
      if (lastTs == null || (r.ts - lastTs) > SESSION_GAP) {
        flush()
        sesSecs = 0; sesStart = r.ts
      }
      sesSecs += r.seconds
      sesEnd = r.ts
      lastTs = r.ts
    }
    flush()

    let topGenre = null
    let topGenreCount = 0
    for (const [g, n] of genreCounts) {
      if (n > topGenreCount) { topGenre = g; topGenreCount = n }
    }

    let biggestDay = null
    for (const [dk, n] of dayPlays) {
      if (!biggestDay || n > biggestDay.plays) biggestDay = { date: dk, plays: n }
    }

    const rankBySeconds = (map, extra) => Array.from(map.entries())
      .map(([k, v]) => Object.assign({}, v, extra ? extra(k, v) : { name: k }))
      .sort((a, b) => (b.seconds - a.seconds) || (b.plays - a.plays))
      .slice(0, 5)

    const topArtists = rankBySeconds(artistAgg)
    const topAlbums = rankBySeconds(albumAgg)
    const topTracks = Array.from(trackAgg.values())
      .sort((a, b) => (b.plays - a.plays) || (b.seconds - a.seconds))
      .slice(0, 5)

    const out = {
      year,
      plays,
      hours: seconds > 0 ? Math.round(seconds / 3600 * 10) / 10 : 0,
      longestSessionMins: longestSessionSecs > 0 ? Math.round(longestSessionSecs / 60) : 0,
      topGenre,
      biggestDay,
      discoveries: discoveries.size,
      topArtists,
      topAlbums,
      topTracks,
      has: false,
    }
    // Worth showing the page if there is any real listening this year.
    out.has = out.plays > 0
    return out
  }

  return { yearRecap, musicRecap, videoRecap, wrappedRecap }
})
