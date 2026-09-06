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

  return { yearRecap, musicRecap, videoRecap }
})
